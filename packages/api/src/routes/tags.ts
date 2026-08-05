import type { FastifyInstance } from 'fastify'
import { z } from 'zod'

import {
  addTagToCard,
  createTag,
  deleteTag,
  listTags,
  removeTagFromCard,
  updateTag
} from '@agents-board/core'
import type { Database } from '@agents-board/db'

import { projectIdQuery } from '../lib/query'

const listTagsQuery = z.object({ projectId: projectIdQuery })

export function registerTagRoutes(app: FastifyInstance, db: Database) {
  app.get('/tags', async (req) => {
    const { projectId } = listTagsQuery.parse(req.query)
    return listTags(db, projectId)
  })

  app.post('/tags', async req => createTag(db, req.body as never))

  app.patch<{ Params: { tagId: string } }>('/tags/:tagId', async req =>
    updateTag(db, { ...(req.body as object), id: req.params.tagId } as never)
  )

  app.delete<{ Params: { tagId: string } }>(
    '/tags/:tagId',
    async req => deleteTag(db, req.params.tagId)
  )

  app.post<{ Params: { cardId: string, tagId: string } }>(
    '/cards/:cardId/tags/:tagId',
    async req => addTagToCard(db, req.params.cardId, req.params.tagId)
  )

  app.delete<{ Params: { cardId: string, tagId: string } }>(
    '/cards/:cardId/tags/:tagId',
    async req => removeTagFromCard(db, req.params.cardId, req.params.tagId)
  )
}
