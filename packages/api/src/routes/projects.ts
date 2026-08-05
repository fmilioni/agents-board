import type { FastifyInstance } from 'fastify'

import {
  archiveProject,
  createProject,
  destroyProject,
  getProjectBySlug,
  listAccessibleProjectIds,
  listProjects,
  restoreProject
} from '@agents-board/core'
import type { Database } from '@agents-board/db'

export function registerProjectRoutes(app: FastifyInstance, db: Database) {
  app.get<{ Querystring: { includeArchived?: string, archivedOnly?: string } }>(
    '/projects',
    async (req) => {
      const all = await listProjects(db, {
        includeArchived: req.query.includeArchived === 'true',
        archivedOnly: req.query.archivedOnly === 'true'
      })
      // authUser null = sem-auth (unrestricted). Admin/allProjects already
      // short-circuit in the guard, but re-deriving here keeps the filter
      // correct regardless of how this route is reached.
      if (!req.authUser) return all
      const accessible = await listAccessibleProjectIds(db, req.authUser.userId)
      if (accessible === 'all') return all
      const allow = new Set(accessible)
      return all.filter(p => allow.has(p.id))
    }
  )

  app.get<{ Params: { slug: string } }>(
    '/projects/:slug',
    async (req, reply) => {
      const project = await getProjectBySlug(db, req.params.slug)
      if (!project) return reply.code(404).send({ error: 'not_found' })
      return project
    }
  )

  app.post('/projects', async req => createProject(db, req.body as never))

  app.post<{ Params: { id: string } }>(
    '/projects/:id/archive',
    async (req, reply) => {
      const project = await archiveProject(db, req.params.id)
      if (!project) return reply.code(404).send({ error: 'not_found' })
      return project
    }
  )

  app.post<{ Params: { id: string } }>(
    '/projects/:id/restore',
    async (req, reply) => {
      const project = await restoreProject(db, req.params.id)
      if (!project) return reply.code(404).send({ error: 'not_found' })
      return project
    }
  )

  app.delete<{ Params: { id: string }, Body: { confirmSlug?: string } }>(
    '/projects/:id',
    async (req, reply) => {
      const result = await destroyProject(
        db,
        req.params.id,
        req.body?.confirmSlug ?? ''
      )
      if (!result) return reply.code(404).send({ error: 'not_found' })
      return result
    }
  )
}
