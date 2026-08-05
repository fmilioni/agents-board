import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import { z } from 'zod'

import { addBlocker, removeBlocker } from '@agents-board/core'
import type { Database } from '@agents-board/db'

import { asJson } from './index'

export function registerBlockerTools(server: McpServer, db: Database) {
  server.registerTool(
    'add_blocker',
    {
      description:
        'Mark a card as blocked by another. `cardId` is the blocked card; `blockerId` is the card that must be resolved first. A card cannot block itself. Returns the blocked card\'s blockers.',
      inputSchema: { cardId: z.string(), blockerId: z.string() }
    },
    async ({ cardId, blockerId }) =>
      asJson(await addBlocker(db, cardId, blockerId))
  )

  server.registerTool(
    'remove_blocker',
    {
      description:
        'Remove a blocking dependency so `blockerId` no longer blocks `cardId`.',
      inputSchema: { cardId: z.string(), blockerId: z.string() }
    },
    async ({ cardId, blockerId }) =>
      asJson(await removeBlocker(db, cardId, blockerId))
  )
}
