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
        'List a card\'s comments and referenced attachments. This read advances returned user comments from unread to read, never to handled. Paginated response: { comments, hasMore, offset }.',
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
        'List project-wide user comments still awaiting action, including unread and read. Returned unread comments advance to read; handled comments are excluded. Paginated response: { comments, hasMore, offset }.',
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
      description:
        'Add an agent-authored markdown comment to a card. Use comments for durable decisions, scope changes, findings, and review verification. A review test plan uses task-list steps: check only steps already verified, and leave pending user checks unchecked. Write in the user\'s language.',
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
        'Replace an existing comment\'s markdown body while preserving its author, timestamp, and order.',
      inputSchema: { id: z.string(), bodyMd: z.string().min(1) }
    },
    async ({ id, bodyMd }) =>
      asJson(commentAck(await updateComment(db, { id, bodyMd })))
  )

  server.registerTool(
    'mark_comments_handled',
    {
      description:
        'Mark comments handled after their requests were acted on. Reading alone is not handling. Returns the number updated.',
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
      description: 'Permanently delete one comment by id.',
      inputSchema: { id: z.string() }
    },
    async ({ id }) => asJson(commentAck(await deleteComment(db, id)))
  )
}
