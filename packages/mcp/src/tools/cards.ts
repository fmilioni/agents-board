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
        'List cards of a project, focused. Returns key/title/summary/status/etc but NOT descriptionMd (call get_card for full description). Filter by sprint, status (single OR a list), activeOnly (everything but done/backlog), tag, or backlog-only, and page with limit/offset. Defaults to limit 100 so a broad listing never blows the context. Response is { cards, hasMore, offset } — raise offset (or narrow the filter) to see the rest. Archived cards are hidden by default.',
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
        'Hybrid semantic search over cards AND their comments: lexical full-text fused with embedding similarity by RRF, so it ranks by MEANING — a conceptual / natural-language query matches the right card even when the wording differs, and synonyms/typos still hit (falls back to lexical-only when embeddings are unavailable). Searches key/title/summary/description AND comment bodies — a card matches if the term hits the card OR any of its comments. Web-style queries (quoted phrases, OR, -exclude) and substring/trigram matching still work. Returns card summaries WITHOUT descriptionMd PLUS the matched comment snippet when the hit came from a comment — use get_card for the full detail. Accepts the focused-read filters (status/activeOnly, sprintId, tag) to search within a slice. Pages with limit/offset (default 25, max 100); response is { cards, hasMore, offset }. Read-only: never marks comments as read.',
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
        'Get a single card by its internal id (crd_xxx) with full descriptionMd.',
      inputSchema: { id: z.string() }
    },
    async ({ id }) => asJson(await withCommitsAndAttachments(db, await getCard(db, id)))
  )

  server.registerTool(
    'get_card_by_key',
    {
      description:
        'Get a single card by its human-readable key (e.g. \'AB-12\') with full descriptionMd.',
      inputSchema: { key: z.string() }
    },
    async ({ key }) => asJson(await withCommitsAndAttachments(db, await getCardByKey(db, key)))
  )

  server.registerTool(
    'get_cards',
    {
      description:
        'Batch-read full cards (WITH descriptionMd) by id (crd_xxx) and/or key (AB-12) in one call — the post-search companion to get_card when you need the detail of several hits at once. Mix ids and keys freely. Capped at 50 per call to keep the response bounded; pass offset to page when you have more than 50 refs.',
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
        'Get the stored diff of a commit attached to a card, by its sha (optionally narrowed by cardId). Use it when the commit is gone from local git (e.g. squashed on merge). Returns the commit metadata plus `diff`; `diff` is null when it was cleared on archive.',
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
        'Create a card in the backlog (default) or a specific sprint. `summary` (one short sentence, what the card is about — shown on the board and in list_cards) and `descriptionMd` (the full markdown body — objective, expected behavior, acceptance criteria) are BOTH REQUIRED; a blank/whitespace-only value is rejected. Pass `tagIds` to attach existing tags to the card at creation.',
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
      description: 'Update fields of a card.',
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
      description: 'Shortcut to change a card status.',
      inputSchema: { id: z.string(), status: cardStatus }
    },
    async ({ id, status }) => asJson(cardAck(await updateCard(db, { id, status })))
  )

  server.registerTool(
    'reorder_cards',
    {
      description:
        'Persist the board order of cards in batch: writes position = index (0,1,2,…) for each id in `orderedIds`, in the given order. The board sorts by position ASC, so pass the cards in the order they should appear top-to-bottom. Mirrors the board drag-reorder; use it to order a set of cards programmatically (e.g. by execution order after planning).',
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
      description: 'Remove a card from its current sprint (back to backlog).',
      inputSchema: { id: z.string() }
    },
    async ({ id }) => asJson(cardAck(await moveCardToBacklog(db, id), 'sprintId'))
  )

  server.registerTool(
    'move_card_to_sprint',
    {
      description: 'Move a card to a specific sprint.',
      inputSchema: { id: z.string(), sprintId: z.string() }
    },
    async ({ id, sprintId }) =>
      asJson(cardAck(await moveCardToSprint(db, id, sprintId), 'sprintId'))
  )

  server.registerTool(
    'archive_card',
    {
      description:
        'Archive a card (soft-delete): it disappears from normal listings but is kept and can be restored. Shows up in list_cards with archivedOnly=true.',
      inputSchema: { id: z.string() }
    },
    async ({ id }) => asJson(cardAck(await archiveCard(db, id)))
  )

  server.registerTool(
    'restore_card',
    {
      description: 'Restore (unarchive) a previously archived card.',
      inputSchema: { id: z.string() }
    },
    async ({ id }) => asJson(cardAck(await restoreCard(db, id)))
  )

  server.registerTool(
    'destroy_card',
    {
      description:
        'Permanently delete a card (hard-delete, IRREVERSIBLE), along with its sub-tasks, comments, tags and blocker links. To merely hide a card, use archive_card instead.',
      inputSchema: { id: z.string() }
    },
    async ({ id }) => asJson(await destroyCard(db, id))
  )
}
