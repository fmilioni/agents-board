import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import { z } from 'zod'

import {
  archiveCard,
  createCard,
  destroyCard,
  getCard,
  getCardByKey,
  getCardsByIds,
  getCommitBySha,
  listCardCommits,
  listCards,
  moveCardToBacklog,
  moveCardToSprint,
  reorderCards,
  restoreCard,
  searchCards,
  updateCard
} from '@agents-board/core'
import type { Database } from '@agents-board/db'

import { attachmentsForItem } from '../attachments'
import { asJson, pageEnvelope, pageInputs } from './index'

// search_cards returns enriched cards + matchedComment (heavier than list_cards),
// so it pages tighter than the shared pageInputs default (100/200).
const searchLimit = z
  .number()
  .int()
  .min(1)
  .max(100)
  .optional()
  .default(25)
  .describe('Max items to return (default 25, max 100).')

// get_card/get_card_by_key embed the card's commits as METADATA only (no diff):
// the agent has the local git and can `git show <sha>`, and a squashed PR commit
// is fetched on demand via get_commit_diff. Plus the card's image attachments
// (owner = card) so the agent can read them via attachment:// without parsing the
// markdown. Built in the MCP layer so the shared Card DTO (and the web payload)
// stay lean.
async function withCommitsAndAttachments(
  db: Database,
  card: Awaited<ReturnType<typeof getCard>>
) {
  if (!card) return card
  const commits = (await listCardCommits(db, card.id)).map(c => ({
    id: c.id,
    sha: c.sha,
    message: c.message,
    stat: c.stat,
    committedAt: c.committedAt,
    authorName: c.authorName,
    createdAt: c.createdAt
  }))
  const attachments = await attachmentsForItem(db, 'card', card.id)
  return { ...card, commits, attachments }
}

type CardAckRow = {
  id: string
  key: string
  status: string
  sprintId: string | null
}
function cardAck(
  card: CardAckRow | null | undefined,
  ...extra: Array<'sprintId'>
) {
  if (!card) return null
  const ack: Record<string, unknown> = {
    id: card.id,
    key: card.key,
    status: card.status
  }
  for (const f of extra) ack[f] = card[f]
  return ack
}

// list/search rows are for SCANNING — drop the fields the agent doesn't need to
// scan (projectId is redundant with the query; position/createdAt/updatedAt are
// rarely used). KEEP `summary`: the short description is what lets the agent
// decide whether a card is worth a full get_card. get_card has the dropped fields.
const SCAN_DROP = new Set(['projectId', 'position', 'createdAt', 'updatedAt'])
function slimCardRow(row: Record<string, unknown>) {
  return Object.fromEntries(
    Object.entries(row).filter(([k]) => !SCAN_DROP.has(k))
  )
}

const cardStatus = z.enum([
  'backlog',
  'todo',
  'in_progress',
  'review',
  'done',
  'blocked'
])

export function registerCardTools(server: McpServer, db: Database) {
  server.registerTool(
    'list_cards',
    {
      description:
        'List card summaries for scanning; descriptionMd is omitted, so use get_card for full detail. Supports sprint, status, active, tag, backlog, and archive filters. Paginated response: { cards, hasMore, offset }.',
      inputSchema: {
        projectId: z.string(),
        sprintId: z.string().nullable().optional(),
        status: z
          .union([cardStatus, z.array(cardStatus)])
          .optional()
          .describe('Restrict to one status or a list of statuses.'),
        activeOnly: z
          .boolean()
          .optional()
          .describe('Shortcut for everything but done/backlog.'),
        tag: z.string().optional().describe('Tag id or name.'),
        backlogOnly: z.boolean().optional(),
        ...pageInputs,
        includeArchived: z
          .boolean()
          .optional()
          .describe('Include archived cards alongside active ones.'),
        archivedOnly: z
          .boolean()
          .optional()
          .describe('Return ONLY archived cards (e.g. archived column of a sprint or the backlog).')
      }
    },
    async ({ limit, offset, ...filters }) => {
      // Probe one past the page so `hasMore` is exact without a COUNT query.
      const rows = await listCards(db, { ...filters, limit: limit + 1, offset })
      return asJson(pageEnvelope('cards', rows.map(slimCardRow), limit, offset))
    }
  )

  server.registerTool(
    'search_cards',
    {
      description:
        'Search cards and comment bodies with hybrid lexical and semantic ranking; falls back to lexical search when embeddings are unavailable. Supports natural language, quoted phrases, OR, -exclude, and card filters. Returns summaries plus a matched-comment snippet, not descriptionMd. Paginated and read-only; it never changes comment read state.',
      inputSchema: {
        projectId: z.string(),
        query: z.string().min(1),
        status: z
          .union([cardStatus, z.array(cardStatus)])
          .optional()
          .describe('Restrict to one status or a list of statuses.'),
        activeOnly: z
          .boolean()
          .optional()
          .describe('Shortcut for everything but done/backlog.'),
        sprintId: z.string().optional(),
        tag: z.string().optional().describe('Tag id or name.'),
        includeArchived: z.boolean().optional(),
        archivedOnly: z.boolean().optional(),
        limit: searchLimit,
        offset: pageInputs.offset
      }
    },
    async ({ projectId, query, limit, offset, ...filters }) => {
      // Probe one past the page so `hasMore` is exact without a COUNT query.
      const rows = await searchCards(db, projectId, query, {
        ...filters,
        limit: limit + 1,
        offset
      })
      return asJson(pageEnvelope('cards', rows.map(slimCardRow), limit, offset))
    }
  )

  server.registerTool(
    'get_card',
    {
      description:
        'Get a full card by internal id, including descriptionMd, parent and subtasks, blockers, claim, commit metadata, and attachments. Commit diffs stay on demand; images open through attachment://<att_id>.',
      inputSchema: { id: z.string() }
    },
    async ({ id }) => asJson(await withCommitsAndAttachments(db, await getCard(db, id)))
  )

  server.registerTool(
    'get_card_by_key',
    {
      description:
        'Get a full card by human-readable key, such as AB-12. Returns the same detail as get_card, including relationships, claim, commit metadata, and attachments.',
      inputSchema: { key: z.string() }
    },
    async ({ key }) => asJson(await withCommitsAndAttachments(db, await getCardByKey(db, key)))
  )

  server.registerTool(
    'get_cards',
    {
      description:
        'Batch-read full cards by mixed internal ids and human-readable keys. Includes descriptionMd and is capped at 50 references per call; use offset for a larger input set.',
      inputSchema: {
        ids: z
          .array(z.string())
          .min(1)
          .max(50)
          .describe('Card ids (crd_xxx) and/or keys (AB-12), mixed — max 50 per call.'),
        offset: z
          .number()
          .int()
          .min(0)
          .optional()
          .describe('Skip N matched cards — page through a larger ref set with offset.')
      }
    },
    async ({ ids, offset }) => asJson(await getCardsByIds(db, ids, offset))
  )

  server.registerTool(
    'get_commit_diff',
    {
      description:
        'Get an attached commit\'s stored diff and metadata by SHA, optionally narrowed to one card. Useful when local git no longer has the commit; diff is null if archive cleanup removed it.',
      inputSchema: {
        sha: z.string(),
        cardId: z
          .string()
          .optional()
          .describe('Narrow to one card when the same sha is attached to several.')
      }
    },
    async ({ sha, cardId }) => asJson(await getCommitBySha(db, sha, cardId))
  )

  server.registerTool(
    'create_card',
    {
      description:
        'Create a card in the backlog or a sprint. summary and descriptionMd are required; the body should make the deliverable understandable without chat context and link existing docs instead of copying them. Acceptance criteria use plain bullets; task-list checkboxes are for executable QA or runbook steps. parentId creates a story child, and tagIds attach existing tags atomically.',
      inputSchema: {
        projectId: z.string(),
        sprintId: z.string().optional(),
        title: z.string().min(1).max(200),
        summary: z
          .string()
          .trim()
          .min(1)
          .max(200)
          .describe(
            'One-sentence natural language summary (~80-120 chars). REQUIRED — shows on the board preview and in list_cards so cards can be scanned; a blank/whitespace-only value is rejected.'
          ),
        descriptionMd: z
          .string()
          .trim()
          .min(1)
          .describe(
            'Full markdown body — objective, expected behavior, acceptance criteria. REQUIRED on creation; blank/whitespace is rejected.'
          ),
        status: cardStatus.optional(),
        priority: z.number().int().min(0).max(10).optional(),
        dueDate: z.iso.datetime().optional(),
        parentId: z
          .string()
          .optional()
          .describe('Parent story card id (crd_xxx) to make this a sub-task.'),
        tagIds: z
          .array(z.string())
          .optional()
          .describe(
            'Existing tag ids (tag_xxx) of THIS project to attach at creation. Any unknown or cross-project id rejects the whole creation (atomic — no card is created); duplicates collapse to one. Omit for an untagged card.'
          )
      }
    },
    async input =>
      asJson(
        cardAck(
          await createCard(db, {
            ...input,
            dueDate: input.dueDate ? new Date(input.dueDate) : undefined
          }),
          'sprintId'
        )
      )
  )

  server.registerTool(
    'update_card',
    {
      description:
        'Update only the supplied card fields. descriptionMd replaces the complete body, so send the full markdown; use comments for chronological discussion rather than partial body updates.',
      inputSchema: {
        id: z.string(),
        title: z.string().min(1).max(200).optional(),
        summary: z.string().max(200).nullable().optional(),
        descriptionMd: z.string().optional(),
        status: cardStatus.optional(),
        priority: z.number().int().min(0).max(10).optional(),
        dueDate: z.iso.datetime().nullable().optional(),
        parentId: z
          .string()
          .nullable()
          .optional()
          .describe('Parent story card id (crd_xxx), or null to detach.')
      }
    },
    async input =>
      asJson(
        cardAck(
          await updateCard(db, {
            ...input,
            dueDate:
              input.dueDate === null
                ? null
                : input.dueDate
                  ? new Date(input.dueDate)
                  : undefined
          })
        )
      )
  )

  server.registerTool(
    'set_card_status',
    {
      description:
        'Change a card\'s board status. Work normally moves through in_progress and rests in review with verification guidance; use done only after user approval, and blocked for an external wait. The core does not derive a parent story\'s status, so re-check the parent after moving a child.',
      inputSchema: { id: z.string(), status: cardStatus }
    },
    async ({ id, status }) => asJson(cardAck(await updateCard(db, { id, status })))
  )

  server.registerTool(
    'reorder_cards',
    {
      description:
        'Persist one board list or column order by assigning position from each id\'s array index. Send the complete top-to-bottom order: a partial list also starts at zero and can collide with omitted cards.',
      inputSchema: {
        orderedIds: z
          .array(z.string())
          .min(1)
          .describe(
            'Card ids (crd_xxx) in the desired order; each card gets position = its index in this list.'
          )
      }
    },
    async ({ orderedIds }) => asJson(await reorderCards(db, { orderedIds }))
  )

  server.registerTool(
    'move_card_to_backlog',
    {
      description: 'Detach a card from its sprint and return it to the project backlog.',
      inputSchema: { id: z.string() }
    },
    async ({ id }) => asJson(cardAck(await moveCardToBacklog(db, id), 'sprintId'))
  )

  server.registerTool(
    'move_card_to_sprint',
    {
      description: 'Assign a card to a specific sprint without changing its status.',
      inputSchema: { id: z.string(), sprintId: z.string() }
    },
    async ({ id, sprintId }) =>
      asJson(cardAck(await moveCardToSprint(db, id, sprintId), 'sprintId'))
  )

  server.registerTool(
    'archive_card',
    {
      description:
        'Archive a card reversibly. It disappears from normal listings and remains discoverable with archivedOnly for later restoration.',
      inputSchema: { id: z.string() }
    },
    async ({ id }) => asJson(cardAck(await archiveCard(db, id)))
  )

  server.registerTool(
    'restore_card',
    {
      description: 'Restore an archived card to normal listings.',
      inputSchema: { id: z.string() }
    },
    async ({ id }) => asJson(cardAck(await restoreCard(db, id)))
  )

  server.registerTool(
    'destroy_card',
    {
      description:
        'Permanently delete a card, its subtasks, comments, tag links, and blocker links. Irreversible; use archive_card for recoverable removal.',
      inputSchema: { id: z.string() }
    },
    async ({ id }) => asJson(await destroyCard(db, id))
  )
}
