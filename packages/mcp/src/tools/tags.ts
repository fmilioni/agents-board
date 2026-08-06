import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
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

import { asJson, pageEnvelope, pageInputs } from './index'

export function registerTagTools(server: McpServer, db: Database) {
  server.registerTool(
    'list_tags',
    {
      description:
        'List a project\'s tags with id, name, and color. Paginated response: { tags, hasMore, offset }.',
      inputSchema: { projectId: z.string(), ...pageInputs }
    },
    async ({ projectId, limit, offset }) => {
      const rows = await listTags(db, projectId, limit + 1, offset)
      return asJson(pageEnvelope('tags', rows, limit, offset))
    }
  )

  server.registerTool(
    'create_tag',
    {
      description:
        'Create a project tag. Names are unique within the project; color is a six-digit hex value and defaults to neutral gray.',
      inputSchema: {
        projectId: z.string(),
        name: z.string().min(1).max(50),
        color: z
          .string()
          .regex(/^#[0-9a-fA-F]{6}$/)
          .optional()
      }
    },
    async input => asJson(await createTag(db, input))
  )

  server.registerTool(
    'update_tag',
    {
      description:
        'Update a tag name or color. The change is visible on every card carrying that tag; omitted fields remain unchanged.',
      inputSchema: {
        id: z.string(),
        name: z.string().min(1).max(50).optional(),
        color: z
          .string()
          .regex(/^#[0-9a-fA-F]{6}$/)
          .optional()
      }
    },
    async input => asJson(await updateTag(db, input))
  )

  server.registerTool(
    'delete_tag',
    {
      description:
        'Permanently delete a tag and remove it from every card. Returns the deleted tag or { error: "not_found" }.',
      inputSchema: { id: z.string() }
    },
    async ({ id }) => {
      const deleted = await deleteTag(db, id)
      return asJson(deleted ?? { error: 'not_found' })
    }
  )

  server.registerTool(
    'add_tag_to_card',
    {
      description:
        'Attach an existing same-project tag to a card. Returns the card\'s complete tag list.',
      inputSchema: { cardId: z.string(), tagId: z.string() }
    },
    async ({ cardId, tagId }) => asJson(await addTagToCard(db, cardId, tagId))
  )

  server.registerTool(
    'remove_tag_from_card',
    {
      description:
        'Detach a tag from a card without deleting the tag. Returns the card\'s complete tag list.',
      inputSchema: { cardId: z.string(), tagId: z.string() }
    },
    async ({ cardId, tagId }) =>
      asJson(await removeTagFromCard(db, cardId, tagId))
  )
}
