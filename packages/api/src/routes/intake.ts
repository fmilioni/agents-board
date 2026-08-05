import type { FastifyInstance } from 'fastify'
import { z } from 'zod'

import {
  archiveIntakeItem,
  createIntakeItem,
  destroyIntakeItem,
  InputError,
  listIntakeItems,
  markIntakePlanned,
  restoreIntakeItem,
  updateIntakeItem
} from '@agents-board/core'
import type { Database } from '@agents-board/db'
import { INTAKE_STATUSES } from '@agents-board/shared'

const listIntakeQuery = z.object({
  status: z.enum(INTAKE_STATUSES).optional()
})
const createIntakeBody = z.object({ bodyMd: z.string().min(1) })
const patchIntakeBody = z.object({
  bodyMd: z.string().min(1).optional(),
  status: z.enum(INTAKE_STATUSES).optional(),
  plannedCardKeys: z.array(z.string()).optional()
})

export function registerIntakeRoutes(app: FastifyInstance, db: Database) {
  app.get<{ Params: { projectId: string } }>(
    '/projects/:projectId/intake',
    async (req) => {
      const { status } = listIntakeQuery.parse(req.query)
      return listIntakeItems(db, req.params.projectId, { status })
    }
  )

  app.post<{ Params: { projectId: string } }>(
    '/projects/:projectId/intake',
    async (req) => {
      const body = createIntakeBody.parse(req.body)
      return createIntakeItem(db, {
        projectId: req.params.projectId,
        bodyMd: body.bodyMd
      })
    }
  )

  app.patch<{ Params: { id: string } }>(
    '/intake/:id',
    async (req, reply) => {
      const body = patchIntakeBody.parse(req.body)
      const { id } = req.params

      if (body.bodyMd !== undefined && body.status !== undefined) {
        throw new InputError('Send either bodyMd or status, not both')
      }
      if (body.plannedCardKeys !== undefined && body.status !== 'planned') {
        throw new InputError('plannedCardKeys is only valid with status "planned"')
      }

      let row
      if (body.status === 'planned') {
        row = await markIntakePlanned(db, id, body.plannedCardKeys ?? [])
      } else if (body.status === 'archived') {
        row = await archiveIntakeItem(db, id)
      } else if (body.status === 'pending') {
        row = await restoreIntakeItem(db, id)
      } else if (body.bodyMd !== undefined) {
        row = await updateIntakeItem(db, { id, bodyMd: body.bodyMd })
      } else {
        throw new InputError('Nothing to update')
      }

      if (!row) return reply.code(404).send({ error: 'not_found' })
      return row
    }
  )

  app.delete<{ Params: { id: string } }>(
    '/intake/:id',
    async (req, reply) => {
      const deleted = await destroyIntakeItem(db, req.params.id)
      if (!deleted) return reply.code(404).send({ error: 'not_found' })
      return { ok: true }
    }
  )
}
