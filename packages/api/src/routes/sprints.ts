import type { FastifyInstance } from 'fastify'
import { z } from 'zod'

import {
  archiveSprint,
  completeSprint,
  createSprint,
  deactivateSprint,
  destroySprint,
  getActiveSprints,
  getSprint,
  listSprints,
  reopenSprint,
  restoreSprint,
  startSprint,
  updateSprint
} from '@claude-organizer/core'
import type { Database } from '@claude-organizer/db'

import { projectIdQuery, queryBool } from '../lib/query'

const listSprintsQuery = z.object({
  projectId: projectIdQuery,
  includeArchived: queryBool,
  archivedOnly: queryBool
})

const projectScopedQuery = z.object({ projectId: projectIdQuery })

export function registerSprintRoutes(app: FastifyInstance, db: Database) {
  app.get('/sprints', async (req) => {
    const q = listSprintsQuery.parse(req.query)
    return listSprints(db, q.projectId, {
      includeArchived: q.includeArchived,
      archivedOnly: q.archivedOnly
    })
  })

  app.get('/sprints/active', async (req) => {
    const { projectId } = projectScopedQuery.parse(req.query)
    return getActiveSprints(db, projectId)
  })

  app.get<{ Params: { id: string } }>('/sprints/:id', async (req, reply) => {
    const sprint = await getSprint(db, req.params.id)
    if (!sprint) return reply.code(404).send({ error: 'not_found' })
    return sprint
  })

  app.post('/sprints', async req => createSprint(db, req.body as never))

  app.patch<{ Params: { id: string } }>('/sprints/:id', async req =>
    updateSprint(db, { ...(req.body as object), id: req.params.id } as never)
  )

  app.post<{ Params: { id: string } }>(
    '/sprints/:id/start',
    async req => startSprint(db, req.params.id)
  )

  app.post<{ Params: { id: string } }>(
    '/sprints/:id/complete',
    async req => completeSprint(db, req.params.id)
  )

  app.post<{ Params: { id: string } }>(
    '/sprints/:id/deactivate',
    async req => deactivateSprint(db, req.params.id)
  )

  app.post<{ Params: { id: string } }>(
    '/sprints/:id/reopen',
    async req => reopenSprint(db, req.params.id)
  )

  app.post<{ Params: { id: string } }>(
    '/sprints/:id/archive',
    async req => archiveSprint(db, req.params.id)
  )

  app.post<{ Params: { id: string } }>(
    '/sprints/:id/restore',
    async req => restoreSprint(db, req.params.id)
  )

  app.delete<{ Params: { id: string } }>('/sprints/:id', async (req, reply) => {
    const destroyed = await destroySprint(db, req.params.id)
    if (!destroyed) return reply.code(404).send({ error: 'not_found' })
    return { deleted: true }
  })
}
