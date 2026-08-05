import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import { z } from 'zod'

import {
  archiveIntakeItem,
  createIntakeItem,
  destroyIntakeItem,
  intakeStatus,
  listIntakeItems,
  markIntakePlanned,
  restoreIntakeItem,
  updateIntakeItem
} from '@agents-board/core'
import type { Database } from '@agents-board/db'

import { attachmentsByItem } from '../attachments'
import { asJson, pageEnvelope, pageInputs } from './index'

type IntakeAckRow = { id: string, status: string, plannedCardKeys: string | null }
function intakeAck(item: IntakeAckRow | null | undefined) {
  if (!item) return null
  return { id: item.id, status: item.status, plannedCardKeys: item.plannedCardKeys }
}

export function registerIntakeTools(server: McpServer, db: Database) {
  server.registerTool(
    'create_inbox',
    {
      description:
        'Capture a raw demand into the Inbox (a pending intake item) without planning it into cards yet. Use to save a follow-up or idea for the `plan` skill to triage later. `bodyMd` is the demand text (markdown).',
      inputSchema: {
        projectId: z.string(),
        bodyMd: z.string().min(1)
      }
    },
    async ({ projectId, bodyMd }) =>
      asJson(intakeAck(await createIntakeItem(db, { projectId, bodyMd })))
  )

  server.registerTool(
    'list_inbox',
    {
      description:
        'List the raw intake demands of a project (the Inbox). Defaults to pending demands; pass status to filter. Each item has id, bodyMd, status, plannedCardKeys and timestamps. Pages with limit/offset; response is { items, hasMore, offset }.',
      inputSchema: {
        projectId: z.string(),
        status: intakeStatus.optional(),
        ...pageInputs
      }
    },
    async ({ projectId, status, limit, offset }) => {
      const rows = await listIntakeItems(db, projectId, {
        status: status ?? 'pending',
        limit: limit + 1,
        offset
      })
      // Batch over the page only (not the limit+1 probe row), grouped per item.
      const byItem = await attachmentsByItem(
        db,
        'inbox',
        rows.slice(0, limit).map(r => r.id)
      )
      const enriched = rows.map(r => ({
        ...r,
        attachments: byItem.get(r.id) ?? []
      }))
      return asJson(pageEnvelope('items', enriched, limit, offset))
    }
  )

  server.registerTool(
    'update_inbox',
    {
      description:
        'Rewrite the text of an inbox demand. Use to sharpen a demand captured in a hurry or to fold in context that arrived later — not to turn it into a different demand (capture that one with create_inbox). Works on an archived demand too, but its images were already reclaimed by the archive, so re-referencing them there gets you a broken image. Returns null when no demand has that id.',
      inputSchema: {
        id: z.string(),
        bodyMd: z.string().min(1)
      }
    },
    async ({ id, bodyMd }) =>
      asJson(intakeAck(await updateIntakeItem(db, { id, bodyMd })))
  )

  server.registerTool(
    'mark_inbox_planned',
    {
      description:
        'Record the keys of the cards an inbox demand became (e.g. AB-12, AB-13), marking it planned. Call after a demand has been planned into cards. Calling it again on a PLANNED demand REPLACES the whole set — that is how a planning that pointed at the wrong card or missed one is corrected. On an ARCHIVED demand call restore_inbox first: this tool would leave it planned yet still stamped as archived, with its images unlinked.',
      inputSchema: {
        id: z.string(),
        cardKeys: z.array(z.string()).min(1)
      }
    },
    async ({ id, cardKeys }) =>
      asJson(intakeAck(await markIntakePlanned(db, id, cardKeys)))
  )

  server.registerTool(
    'archive_inbox',
    {
      description:
        'Archive an inbox demand (status archived) — recoverable via restore_inbox. Use when a demand is discarded during planning but the user may want it back.',
      inputSchema: {
        id: z.string()
      }
    },
    async ({ id }) => asJson(intakeAck(await archiveIntakeItem(db, id)))
  )

  server.registerTool(
    'restore_inbox',
    {
      description:
        'Bring an archived inbox demand back. The status it lands in is derived, not chosen: `planned` only while at least one card it points at is still active, `pending` otherwise (the keys are kept either way, so a demand whose cards were all archived comes back waiting to be planned again). Returns null when no demand has that id.',
      inputSchema: {
        id: z.string()
      }
    },
    async ({ id }) => asJson(intakeAck(await restoreIntakeItem(db, id)))
  )

  server.registerTool(
    'destroy_inbox',
    {
      description:
        'Permanently delete an inbox demand. Use when a discarded demand should be gone for good; prefer archive_inbox when recovery might be wanted.',
      inputSchema: {
        id: z.string()
      }
    },
    async ({ id }) => asJson(intakeAck(await destroyIntakeItem(db, id)))
  )
}
