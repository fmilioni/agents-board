import type { FastifyInstance } from 'fastify'
import { z } from 'zod'

import {
  addComment,
  deleteComment,
  listComments,
  listUnhandledCommentsForProject,
  markCommentsHandled,
  updateComment
} from '@agents-board/core'
import type { Database } from '@agents-board/db'
import { COMMENT_AUTHORS } from '@agents-board/shared'

import { projectIdQuery, queryBool } from '../lib/query'

const listCommentsQuery = z.object({ advanceToRead: queryBool })
const addCommentBody = z.object({
  bodyMd: z.string().min(1),
  author: z.enum(COMMENT_AUTHORS).optional()
})
const unhandledQuery = z.object({ projectId: projectIdQuery })
const markHandledBody = z.object({ commentIds: z.array(z.string()) })
const updateCommentBody = z.object({ bodyMd: z.string().min(1) })

export function registerCommentRoutes(app: FastifyInstance, db: Database) {
  app.get<{ Params: { cardId: string } }>(
    '/cards/:cardId/comments',
    async (req) => {
      const { advanceToRead } = listCommentsQuery.parse(req.query)
      return listComments(db, req.params.cardId, { advanceToRead })
    }
  )

  app.post<{ Params: { cardId: string } }>(
    '/cards/:cardId/comments',
    async (req) => {
      const body = addCommentBody.parse(req.body)
      const author = body.author ?? 'user'
      return addComment(db, {
        cardId: req.params.cardId,
        author,
        userId: author === 'user' ? (req.authUser?.userId ?? null) : null,
        bodyMd: body.bodyMd
      })
    }
  )

  app.get('/comments/unhandled', async (req) => {
    const { projectId } = unhandledQuery.parse(req.query)
    return listUnhandledCommentsForProject(db, projectId)
  })

  app.post('/comments/handled', async (req) => {
    const { commentIds } = markHandledBody.parse(req.body)
    const updated = await markCommentsHandled(db, commentIds)
    return { updated }
  })

  app.patch<{ Params: { id: string } }>(
    '/comments/:id',
    async (req, reply) => {
      const { bodyMd } = updateCommentBody.parse(req.body)
      const updated = await updateComment(db, { id: req.params.id, bodyMd })
      if (!updated) {
        reply.code(404)
        return { error: 'Comment not found' }
      }
      return updated
    }
  )

  app.delete<{ Params: { id: string } }>(
    '/comments/:id',
    async (req, reply) => {
      const deleted = await deleteComment(db, req.params.id)
      if (!deleted) {
        reply.code(404)
        return { error: 'Comment not found' }
      }
      return { ok: true }
    }
  )
}
