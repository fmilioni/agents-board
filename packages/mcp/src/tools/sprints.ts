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
        'List a project\'s sprints. Archived sprints are hidden unless requested. Paginated response: { sprints, hasMore, offset }.',
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
        'Get all active sprints for a project. Returns an array because several sprints may be active at once; empty means none are active.',
      inputSchema: { projectId: z.string() }
    },
    async ({ projectId }) => asJson(await getActiveSprints(db, projectId))
  )

  server.registerTool(
    'create_sprint',
    {
      description: 'Create a sprint in planned status. Use start_sprint separately when it should become active.',
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
        'Update a sprint name or goal in any status. Pass goal=null to clear the goal; omitted fields remain unchanged.',
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
        'Activate a planned sprint. Other active sprints are unaffected because a project may have several active at once.',
      inputSchema: { id: z.string() }
    },
    async ({ id }) => asJson(sprintAck(await startSprint(db, id)))
  )

  server.registerTool(
    'complete_sprint',
    {
      description: 'Mark a sprint completed and record its completion time.',
      inputSchema: { id: z.string() }
    },
    async ({ id }) => asJson(sprintAck(await completeSprint(db, id)))
  )

  server.registerTool(
    'deactivate_sprint',
    {
      description:
        'Move an active sprint back to planned without completing it. Cards remain assigned; non-active sprints leave the active board. No-op when the sprint is not active.',
      inputSchema: { id: z.string() }
    },
    async ({ id }) => asJson(sprintAck(await deactivateSprint(db, id)))
  )

  server.registerTool(
    'reopen_sprint',
    {
      description:
        'Return a completed or archived sprint to planned, clearing its completion time and archive state. It is not activated; call start_sprint separately.',
      inputSchema: { id: z.string() }
    },
    async ({ id }) => asJson(sprintAck(await reopenSprint(db, id)))
  )

  server.registerTool(
    'archive_sprint',
    {
      description:
        'Archive a sprint reversibly. It disappears from normal listings, and its cards follow the sprint without being archived individually.',
      inputSchema: { id: z.string() }
    },
    async ({ id }) => asJson(sprintAck(await archiveSprint(db, id)))
  )

  server.registerTool(
    'restore_sprint',
    {
      description: 'Restore an archived sprint without changing its workflow status.',
      inputSchema: { id: z.string() }
    },
    async ({ id }) => asJson(sprintAck(await restoreSprint(db, id)))
  )

  server.registerTool(
    'destroy_sprint',
    {
      description:
        'Permanently delete a sprint and all of its cards, including their comments, tag links, and blockers. Irreversible; use archive_sprint for recoverable removal.',
      inputSchema: { id: z.string() }
    },
    async ({ id }) => asJson(await destroySprint(db, id))
  )
}
