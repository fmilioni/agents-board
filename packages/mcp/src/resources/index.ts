import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import { ResourceTemplate } from '@modelcontextprotocol/sdk/server/mcp.js'

import {
  getActiveSprints,
  getAttachment,
  getAttachmentMeta,
  getCardByKey,
  getProjectBySlug,
  listAttachments,
  listCards,
  listProjects
} from '@claude-organizer/core'
import type { Database } from '@claude-organizer/db'

import { attachmentUri } from '../attachments'
import {
  canAccessProjectId,
  filterProjectsByScope,
  type McpScope
} from '../scope'

// Read-only MCP resources: let the AI pull board/backlog/card context as a
// cacheable snapshot without invoking a tool. Everything is markdown.
const STATUS_ORDER = [
  'todo',
  'in_progress',
  'review',
  'done',
  'blocked'
] as const

const STATUS_LABEL: Record<string, string> = {
  todo: 'To do',
  in_progress: 'In progress',
  review: 'Review',
  done: 'Done',
  blocked: 'Blocked'
}

type Project = NonNullable<Awaited<ReturnType<typeof getProjectBySlug>>>
type Sprint = Awaited<ReturnType<typeof getActiveSprints>>[number]
type CardSummary = Awaited<ReturnType<typeof listCards>>[number]
type CardDetail = NonNullable<Awaited<ReturnType<typeof getCardByKey>>>

function md(uri: URL, text: string) {
  return { contents: [{ uri: uri.href, mimeType: 'text/markdown', text }] }
}

function cardLine(c: CardSummary) {
  const sub = c.subtaskCount ? ` (${c.subtaskDone}/${c.subtaskCount})` : ''
  const tags = c.tags?.length
    ? ` _[${c.tags.map(t => t.name).join(', ')}]_`
    : ''
  const blocked = c.blockedByPending ? ' ⛔ blocked' : ''
  return `- \`${c.key}\` ${c.title}${sub}${tags}${blocked}`
}

function formatProjects(projects: Project[]) {
  if (!projects.length) return '# Projects\n\n_No projects yet._'
  const lines = projects.map(
    p => `- **${p.name}** — slug \`${p.slug}\`, keys \`${p.keyPrefix}-*\``
  )
  return `# Projects\n\n${lines.join('\n')}`
}

function formatBoard(project: Project, sprint: Sprint, cards: CardSummary[]) {
  const groups = STATUS_ORDER.map((status) => {
    const list = cards.filter(c => c.status === status)
    const body = list.length ? list.map(cardLine).join('\n') : '_(empty)_'
    return `## ${STATUS_LABEL[status]} (${list.length})\n\n${body}`
  })
  const goal = sprint.goal ? `${sprint.goal}\n\n` : ''
  return `# ${project.name} — ${sprint.name}\n\n${goal}${groups.join('\n\n')}`
}

function formatBacklog(project: Project, cards: CardSummary[]) {
  const body = cards.length ? cards.map(cardLine).join('\n') : '_(empty)_'
  return `# ${project.name} — Backlog (${cards.length})\n\n${body}`
}

function formatCard(card: CardDetail) {
  const out = [
    `# ${card.key} — ${card.title}`,
    '',
    `**Status:** ${STATUS_LABEL[card.status] ?? card.status} · **Priority:** P${card.priority}`
  ]
  if (card.summary) out.push('', `> ${card.summary}`)
  if (card.descriptionMd) {
    out.push('', '## Description', '', card.descriptionMd)
  }
  return out.join('\n')
}

export function registerResources(
  server: McpServer,
  db: Database,
  scope: McpScope | null
) {
  // Same scoping as the tools: a scoped session only sees its own projects.
  const scopedProjects = async () =>
    filterProjectsByScope(await listProjects(db), scope)

  server.registerResource(
    'projects',
    'organizer://projects',
    {
      title: 'Projects',
      description: 'All projects tracked by claude-organizer.',
      mimeType: 'text/markdown'
    },
    async uri => md(uri, formatProjects(await scopedProjects()))
  )

  server.registerResource(
    'board',
    new ResourceTemplate('organizer://project/{slug}/board', {
      list: async () => ({
        resources: (await scopedProjects()).map(p => ({
          uri: `organizer://project/${p.slug}/board`,
          name: `${p.name} — active sprint board`,
          mimeType: 'text/markdown'
        }))
      })
    }),
    {
      title: 'Active sprint board',
      description:
        'Cards of the project\'s active sprint, grouped by status (read-only snapshot).',
      mimeType: 'text/markdown'
    },
    async (uri, { slug }) => {
      const project = await getProjectBySlug(db, String(slug))
      // Out-of-scope reads answer "not found" — same as a missing project, so a
      // scoped session can't probe which projects exist.
      if (!project || !canAccessProjectId(scope, project.id)) {
        return md(uri, `Project \`${String(slug)}\` not found.`)
      }
      const sprints = await getActiveSprints(db, project.id)
      if (!sprints.length) {
        return md(uri, `# ${project.name}\n\n_No active sprint._`)
      }
      const sections = await Promise.all(
        sprints.map(async (sprint) => {
          const cards = await listCards(db, {
            projectId: project.id,
            sprintId: sprint.id
          })
          return formatBoard(project, sprint, cards)
        })
      )
      return md(uri, sections.join('\n\n---\n\n'))
    }
  )

  server.registerResource(
    'backlog',
    new ResourceTemplate('organizer://project/{slug}/backlog', {
      list: async () => ({
        resources: (await scopedProjects()).map(p => ({
          uri: `organizer://project/${p.slug}/backlog`,
          name: `${p.name} — backlog`,
          mimeType: 'text/markdown'
        }))
      })
    }),
    {
      title: 'Backlog',
      description: 'Project cards with no sprint assigned (read-only snapshot).',
      mimeType: 'text/markdown'
    },
    async (uri, { slug }) => {
      const project = await getProjectBySlug(db, String(slug))
      if (!project || !canAccessProjectId(scope, project.id)) {
        return md(uri, `Project \`${String(slug)}\` not found.`)
      }
      const cards = await listCards(db, {
        projectId: project.id,
        backlogOnly: true
      })
      return md(uri, formatBacklog(project, cards))
    }
  )

  server.registerResource(
    'card',
    new ResourceTemplate('organizer://card/{key}', { list: undefined }),
    {
      title: 'Card detail',
      description: 'Full markdown detail of a single card by its key (e.g. CO-12).',
      mimeType: 'text/markdown'
    },
    async (uri, { key }) => {
      const card = await getCardByKey(db, String(key))
      if (!card || !canAccessProjectId(scope, card.projectId)) {
        return md(uri, `Card \`${String(key)}\` not found.`)
      }
      return md(uri, formatCard(card))
    }
  )

  server.registerResource(
    'attachment',
    new ResourceTemplate('attachment://{id}', {
      list: async () => {
        const projects = await scopedProjects()
        const lists = await Promise.all(
          projects.map(p => listAttachments(db, { projectId: p.id }))
        )
        return {
          resources: lists.flat().map(a => ({
            uri: attachmentUri(a.id),
            name: a.filename ?? a.description ?? a.id,
            mimeType: a.mime
          }))
        }
      }
    }),
    {
      title: 'Image attachment',
      description:
        'An image attached to a card, comment, doc or inbox item, by its id (att_xxx) — the model reads it as a blob. Discover ids via the `attachments` array on get_card/list_comments/read_doc/list_inbox.'
    },
    async (uri, { id }) => {
      // Check existence + scope on the metadata (no bytes) first, so an
      // out-of-scope or missing id never pulls the blob into memory. Only then
      // fetch the bytes. Out-of-scope / missing / bytes-cleaned (archived) all
      // answer the same "not found", so a scoped session can't probe what exists.
      const meta = await getAttachmentMeta(db, String(id))
      if (!meta || !canAccessProjectId(scope, meta.projectId)) {
        return md(uri, `Attachment \`${String(id)}\` not found.`)
      }
      const att = await getAttachment(db, String(id))
      if (!att?.data) return md(uri, `Attachment \`${String(id)}\` not found.`)
      return {
        contents: [
          {
            uri: uri.href,
            mimeType: att.mime,
            blob: Buffer.from(att.data).toString('base64')
          }
        ]
      }
    }
  )
}
