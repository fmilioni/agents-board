import type { FastifyInstance } from 'fastify'
import { z } from 'zod'

import {
  archiveDoc,
  createDoc,
  destroyDoc,
  getDoc,
  listDocs,
  restoreDoc,
  searchDocs,
  updateDoc
} from '@agents-board/core'
import type { Database } from '@agents-board/db'
import { DOC_KINDS } from '@agents-board/shared'

import { projectIdQuery, queryBool } from '../lib/query'

const listDocsQuery = z.object({
  projectId: projectIdQuery,
  kind: z.enum(DOC_KINDS).optional(),
  q: z.string().optional(),
  includeArchived: queryBool,
  archivedOnly: queryBool
})

export function registerDocRoutes(app: FastifyInstance, db: Database) {
  app.get('/docs', async (req) => {
    const query = listDocsQuery.parse(req.query)
    if (query.q) {
      return searchDocs(db, query.projectId, query.q, {
        includeArchived: query.includeArchived
      })
    }
    return listDocs(db, query.projectId, query.kind, {
      includeArchived: query.includeArchived,
      archivedOnly: query.archivedOnly
    })
  })

  app.get<{ Params: { id: string } }>('/docs/:id', async (req, reply) => {
    const doc = await getDoc(db, req.params.id)
    if (!doc) return reply.code(404).send({ error: 'not_found' })
    return doc
  })

  app.post('/docs', async req => createDoc(db, req.body as never))

  app.patch<{ Params: { id: string } }>('/docs/:id', async req =>
    updateDoc(db, { ...(req.body as object), id: req.params.id } as never)
  )

  app.post<{ Params: { id: string } }>(
    '/docs/:id/archive',
    async req => archiveDoc(db, req.params.id)
  )

  app.post<{ Params: { id: string } }>(
    '/docs/:id/restore',
    async req => restoreDoc(db, req.params.id)
  )

  app.delete<{ Params: { id: string } }>('/docs/:id', async (req, reply) => {
    const destroyed = await destroyDoc(db, req.params.id)
    if (!destroyed) return reply.code(404).send({ error: 'not_found' })
    return { deleted: true }
  })
}
