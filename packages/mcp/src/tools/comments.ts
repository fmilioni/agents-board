import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
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

import { attachmentsByItem } from '../attachments'
import { asJson, pageEnvelope, pageInputs } from './index'

type CommentAckRow = { id: string, cardId: string, createdAt: Date | string }
function commentAck(comment: CommentAckRow | null | undefined) {
  if (!comment) return null
  return { id: comment.id, cardId: comment.cardId, createdAt: comment.createdAt }
}

export function registerCommentTools(server: McpServer, db: Database) {
  server.registerTool(
    'list_comments',
    {
      description:
        'List comments of a card. Reading the thread advances the user\'s unread comments to `read` (but not to `handled` — that\'s mark_comments_handled, which you call once you\'ve actually acted on a comment). Pages with limit/offset; response is { comments, hasMore, offset }.',
      inputSchema: {
        cardId: z.string(),
        ...pageInputs
      }
    },
    async ({ cardId, limit, offset }) => {
      const rows = await listComments(db, cardId, {
        advanceToRead: true,
        limit: limit + 1,
        offset
      })
      // Images referenced in each comment's body, via the link index; one batch
      // query for the page (not the limit+1 probe row), grouped per comment.
      const byComment = await attachmentsByItem(
        db,
        'comment',
        rows.slice(0, limit).map(r => r.id)
      )
      const enriched = rows.map(r => ({
        ...r,
        attachments: byComment.get(r.id) ?? []
      }))
      return asJson(pageEnvelope('comments', enriched, limit, offset))
    }
  )

  server.registerTool(
    'list_unhandled_comments',
    {
      description:
        'List all user comments not yet handled by the AI for a project (both `unread` and `read` — everything you haven\'t closed out with mark_comments_handled). The scan advances the returned `unread` comments to `read` (but not to `handled` — that\'s mark_comments_handled, which you call once you\'ve actually acted on a comment); already-`read` and `handled` comments are untouched, and the queue still returns `unread` + `read`. Pages with limit/offset; response is { comments, hasMore, offset }.',
      inputSchema: { projectId: z.string(), ...pageInputs }
    },
    async ({ projectId, limit, offset }) => {
      const rows = await listUnhandledCommentsForProject(db, projectId, {
        advanceToRead: true,
        limit: limit + 1,
        offset
      })
      return asJson(pageEnvelope('comments', rows, limit, offset))
    }
  )

  server.registerTool(
    'add_comment',
    {
      description: 'Add a comment authored by the AI to a card.',
      inputSchema: {
        cardId: z.string(),
        bodyMd: z.string().min(1)
      }
    },
    async ({ cardId, bodyMd }) =>
      asJson(commentAck(await addComment(db, { cardId, bodyMd, author: 'ai' })))
  )

  server.registerTool(
    'update_comment',
    {
      description:
        'Edit the body (markdown) of an existing comment. Preserves author, timestamp and order. To remove a comment instead, use delete_comment.',
      inputSchema: { id: z.string(), bodyMd: z.string().min(1) }
    },
    async ({ id, bodyMd }) =>
      asJson(commentAck(await updateComment(db, { id, bodyMd })))
  )

  server.registerTool(
    'mark_comments_handled',
    {
      description:
        'Mark a list of comments as handled — use once you have actually acted on the comment (addressed the request, applied the fix, answered the question), not merely read it.',
      inputSchema: { commentIds: z.array(z.string()).min(1) }
    },
    async ({ commentIds }) => {
      const updated = await markCommentsHandled(db, commentIds)
      return asJson({ updated })
    }
  )

  server.registerTool(
    'delete_comment',
    {
      description: 'Delete a comment from a card by its id. Permanent.',
      inputSchema: { id: z.string() }
    },
    async ({ id }) => asJson(commentAck(await deleteComment(db, id)))
  )
}
