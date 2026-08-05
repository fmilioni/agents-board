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
        'List all tags of a project (id, name, color). Pages with limit/offset; response is { tags, hasMore, offset }.',
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
        'Create a colored tag in a project. `color` is a hex string like #ef4444; defaults to a neutral gray if omitted. Tag names are unique per project.',
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
        'Rename a tag or change its color. Pass the tag id (tag_xxx) plus the fields to change (`name` and/or `color` hex). Affects every card that has the tag.',
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
        'Delete a tag from the project (tag id, tag_xxx). Removes it from every card that has it. Returns the deleted tag, or { error: "not_found" } if no tag has that id.',
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
        'Attach an existing tag to a card. Returns the card\'s tags after the change.',
      inputSchema: { cardId: z.string(), tagId: z.string() }
    },
    async ({ cardId, tagId }) => asJson(await addTagToCard(db, cardId, tagId))
  )

  server.registerTool(
    'remove_tag_from_card',
    {
      description:
        'Remove a tag from a card. Returns the card\'s tags after the change.',
      inputSchema: { cardId: z.string(), tagId: z.string() }
    },
    async ({ cardId, tagId }) =>
      asJson(await removeTagFromCard(db, cardId, tagId))
  )
}
