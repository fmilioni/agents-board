import type { FastifyInstance } from 'fastify'
import { z } from 'zod'

import {
  archiveCard,
  createCard,
  destroyCard,
  getCard,
  getCardByKey,
  listCards,
  reorderCards,
  restoreCard,
  searchCards,
  updateCard
} from '@claude-organizer/core'
import type { Database } from '@claude-organizer/db'
import { CARD_STATUSES } from '@claude-organizer/shared'

import { projectIdQuery, queryBool } from '../lib/query'

const listCardsQuery = z.object({
  projectId: projectIdQuery,
  q: z.string().optional(),
  sprintId: z.string().optional(),
  // Comma-separated sprint ids — the board passes every active sprint at once
  // (CO-399). Takes precedence over `sprintId` in the core filter.
  sprintIds: z.string().optional(),
  status: z.enum(CARD_STATUSES).optional(),
  backlogOnly: queryBool,
  includeArchived: queryBool,
  archivedOnly: queryBool
})

export function registerCardRoutes(app: FastifyInstance, db: Database) {
  app.get('/cards', async (req) => {
    const q = listCardsQuery.parse(req.query)
    const sprintId = q.sprintId === 'null' ? null : q.sprintId
    const sprintIds = q.sprintIds
      ? q.sprintIds.split(',').filter(Boolean)
      : undefined
    if (q.q) {
      return searchCards(db, q.projectId, q.q, {
        status: q.status,
        sprintId,
        sprintIds,
        includeArchived: q.includeArchived,
        archivedOnly: q.archivedOnly
      })
    }
    return listCards(db, {
      projectId: q.projectId,
      sprintId,
      sprintIds,
      status: q.status,
      backlogOnly: q.backlogOnly,
      includeArchived: q.includeArchived,
      archivedOnly: q.archivedOnly
    })
  })

  app.get<{ Params: { key: string } }>(
    '/cards/by-key/:key',
    async (req, reply) => {
      const card = await getCardByKey(db, req.params.key)
      if (!card) return reply.code(404).send({ error: 'not_found' })
      return card
    }
  )

  app.get<{ Params: { id: string } }>('/cards/:id', async (req, reply) => {
    const card = await getCard(db, req.params.id)
    if (!card) return reply.code(404).send({ error: 'not_found' })
    return card
  })

  app.post('/cards', async req => createCard(db, req.body as never))

  app.post('/cards/reorder', async req => reorderCards(db, req.body as never))

  app.patch<{ Params: { id: string } }>('/cards/:id', async req =>
    updateCard(db, { ...(req.body as object), id: req.params.id } as never)
  )

  app.post<{ Params: { id: string } }>(
    '/cards/:id/archive',
    async req => archiveCard(db, req.params.id)
  )

  app.post<{ Params: { id: string } }>(
    '/cards/:id/restore',
    async req => restoreCard(db, req.params.id)
  )

  app.delete<{ Params: { id: string } }>('/cards/:id', async (req, reply) => {
    const destroyed = await destroyCard(db, req.params.id)
    if (!destroyed) return reply.code(404).send({ error: 'not_found' })
    return { deleted: true }
  })
}
