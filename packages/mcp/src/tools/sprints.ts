import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import { z } from 'zod'

import {
  archiveSprint,
  completeSprint,
  createSprint,
  deactivateSprint,
  destroySprint,
  getActiveSprints,
  listSprints,
  reopenSprint,
  restoreSprint,
  startSprint,
  updateSprint
} from '@agents-board/core'
import type { Database } from '@agents-board/db'

import { asJson, pageEnvelope, pageInputs } from './index'

type SprintAckRow = { id: string, name: string, status: string }
function sprintAck(s: SprintAckRow | null | undefined) {
  if (!s) return null
  return { id: s.id, name: s.name, status: s.status }
}

export function registerSprintTools(server: McpServer, db: Database) {
  server.registerTool(
    'list_sprints',
    {
      description:
        'List sprints of a project. Pages with limit/offset; response is { sprints, hasMore, offset }. Archived sprints are hidden by default.',
      inputSchema: {
        projectId: z.string(),
        includeArchived: z
          .boolean()
          .optional()
          .describe('Include archived sprints alongside active ones.'),
        archivedOnly: z
          .boolean()
          .optional()
          .describe('Return ONLY archived sprints.'),
        ...pageInputs
      }
    },
    async ({ projectId, includeArchived, archivedOnly, limit, offset }) => {
      const rows = await listSprints(
        db,
        projectId,
        { includeArchived, archivedOnly },
        limit + 1,
        offset
      )
      return asJson(pageEnvelope('sprints', rows, limit, offset))
    }
  )

  server.registerTool(
    'get_active_sprint',
    {
      description:
        'Get the active sprints of a project. A project may have several active at once, so this returns an ARRAY (empty when none are active).',
      inputSchema: { projectId: z.string() }
    },
    async ({ projectId }) => asJson(await getActiveSprints(db, projectId))
  )

  server.registerTool(
    'create_sprint',
    {
      description: 'Create a planned sprint (status=planned).',
      inputSchema: {
        projectId: z.string(),
        roadmapId: z.string().optional(),
        name: z.string().min(1).max(120),
        goal: z.string().max(500).optional(),
        startsAt: z.iso.datetime().optional(),
        endsAt: z.iso.datetime().optional()
      }
    },
    async input =>
      asJson(
        sprintAck(
          await createSprint(db, {
            ...input,
            startsAt: input.startsAt ? new Date(input.startsAt) : undefined,
            endsAt: input.endsAt ? new Date(input.endsAt) : undefined
          })
        )
      )
  )

  server.registerTool(
    'update_sprint',
    {
      description:
        'Rename a sprint or change its goal/objective. Pass the sprint id (spr_xxx) plus the fields to change. `goal` accepts null to clear it. Works for sprints in any status.',
      inputSchema: {
        id: z.string(),
        name: z.string().min(1).max(120).optional(),
        goal: z.string().max(500).nullable().optional()
      }
    },
    async input => asJson(sprintAck(await updateSprint(db, input)))
  )

  server.registerTool(
    'start_sprint',
    {
      description:
        'Activate a sprint. Other sprints in the same project stay as they are — a project can have several active at once.',
      inputSchema: { id: z.string() }
    },
    async ({ id }) => asJson(sprintAck(await startSprint(db, id)))
  )

  server.registerTool(
    'complete_sprint',
    {
      description: 'Mark a sprint as completed.',
      inputSchema: { id: z.string() }
    },
    async ({ id }) => asJson(sprintAck(await completeSprint(db, id)))
  )

  server.registerTool(
    'deactivate_sprint',
    {
      description:
        'Move an ACTIVE sprint back to `planned` (the inverse of start) WITHOUT completing it. Its cards stay assigned but drop off the board (which shows only active sprints); endsAt is not set. No-op if the sprint is not active. Use start_sprint to make it active again.',
      inputSchema: { id: z.string() }
    },
    async ({ id }) => asJson(sprintAck(await deactivateSprint(db, id)))
  )

  server.registerTool(
    'reopen_sprint',
    {
      description:
        'Reopen a completed (or archived) sprint back to `planned` so work can resume or missing cards can be added. Clears endsAt and unarchives it. Never activates — use start_sprint afterwards to make it active.',
      inputSchema: { id: z.string() }
    },
    async ({ id }) => asJson(sprintAck(await reopenSprint(db, id)))
  )

  server.registerTool(
    'archive_sprint',
    {
      description:
        'Archive a sprint (soft-delete): it disappears from normal listings but is kept and can be restored. Its cards travel with it (they are not individually marked). Shows up in list_sprints with archivedOnly=true.',
      inputSchema: { id: z.string() }
    },
    async ({ id }) => asJson(sprintAck(await archiveSprint(db, id)))
  )

  server.registerTool(
    'restore_sprint',
    {
      description: 'Restore (unarchive) a previously archived sprint.',
      inputSchema: { id: z.string() }
    },
    async ({ id }) => asJson(sprintAck(await restoreSprint(db, id)))
  )

  server.registerTool(
    'destroy_sprint',
    {
      description:
        'Permanently delete a sprint and ALL its cards (hard-delete, IRREVERSIBLE), including those cards\' comments, tags and blocker links. To merely hide a sprint, use archive_sprint instead.',
      inputSchema: { id: z.string() }
    },
    async ({ id }) => asJson(await destroySprint(db, id))
  )
}
