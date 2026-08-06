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
        'Capture an unplanned demand as a pending Inbox item. Use for future or separate work, not unfinished work created by the current change. Check search_cards and list_inbox first to avoid duplicates; after planning, link the resulting cards with mark_inbox_planned.',
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
        'List a project\'s Inbox demands and referenced attachments. Defaults to pending; filter by status when needed. Paginated response: { items, hasMore, offset }.',
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
        'Replace an Inbox demand\'s markdown body to clarify the same demand. Create a separate item for different work. Archived items can be edited, but attachments reclaimed during archive cannot be restored by reusing their links.',
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
        'Mark an Inbox demand planned and record the complete card-key set it produced. Repeating the call replaces that set. Restore an archived demand first so its archive state and attachment links are reconciled.',
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
        'Archive an Inbox demand reversibly, removing it from the pending queue.',
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
        'Restore an archived Inbox demand. Status is derived: planned while any linked card remains active, otherwise pending. Existing plannedCardKeys are retained.',
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
        'Permanently delete an Inbox demand. Irreversible; use archive_inbox when recovery may be needed.',
      inputSchema: {
        id: z.string()
      }
    },
    async ({ id }) => asJson(intakeAck(await destroyIntakeItem(db, id)))
  )
}
