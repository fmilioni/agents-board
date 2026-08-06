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
        'Add a hard dependency: cardId is blocked by blockerId. Self-blocking is rejected. Returns the blocked card\'s current blockers.',
      inputSchema: { cardId: z.string(), blockerId: z.string() }
    },
    async ({ cardId, blockerId }) =>
      asJson(await addBlocker(db, cardId, blockerId))
  )

  server.registerTool(
    'remove_blocker',
    {
      description:
        'Remove the dependency in which blockerId blocks cardId. Returns the card\'s remaining blockers.',
      inputSchema: { cardId: z.string(), blockerId: z.string() }
    },
    async ({ cardId, blockerId }) =>
      asJson(await removeBlocker(db, cardId, blockerId))
  )
}
