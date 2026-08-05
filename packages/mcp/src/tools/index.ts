import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import { z } from 'zod'

import type { Database } from '@agents-board/db'

import type { McpScope } from '../scope'
import { registerBlockerTools } from './blockers'
import { registerCardClaimTools } from './cardClaims'
import { registerCardTools } from './cards'
import { registerCommentTools } from './comments'
import { registerCommitTools } from './commits'
import { registerDocTools } from './docs'
import { registerIntakeTools } from './intake'
import { registerProjectTools } from './projects'
import { registerSprintTools } from './sprints'
import { registerTagTools } from './tags'
import { registerUploadTools } from './uploads'

// Per-tool authorization is enforced centrally in createMcpServer (registerTool
// wrapper). `scope` only reaches registerProjectTools, which needs it to filter
// list_projects' OUTPUT (the others just deny, handled by the wrapper).
export function registerTools(
  server: McpServer,
  db: Database,
  scope: McpScope | null
) {
  registerProjectTools(server, db, scope)
  registerSprintTools(server, db)
  registerCardTools(server, db)
  registerCardClaimTools(server, db)
  registerCommentTools(server, db)
  registerCommitTools(server)
  registerTagTools(server, db)
  registerBlockerTools(server, db)
  registerDocTools(server, db)
  registerIntakeTools(server, db)
  registerUploadTools(server)
}

export function asJson(value: unknown) {
  // Compact (no indent): the agent parses JSON regardless of whitespace, and
  // pretty-printing inflated every response's tokens for nothing.
  return {
    content: [
      {
        type: 'text' as const,
        text: JSON.stringify(value)
      }
    ]
  }
}

// The MCP border caps every listing; the core stays uncapped (the web reuses
// the same functions and renders whole lists). See ADR doc_p6w3rck1ssu3.
export const pageInputs = {
  limit: z
    .number()
    .int()
    .min(1)
    .max(200)
    .optional()
    .default(100)
    .describe('Max items to return (default 100, max 200).'),
  offset: z
    .number()
    .int()
    .min(0)
    .optional()
    .describe('Skip N items — page through results with limit + offset.')
}

/**
 * Build the `{ <key>, hasMore, offset }` envelope from a `limit + 1` probe:
 * `rows` was fetched with one extra row, so `length > limit` means there's a
 * next page without a COUNT. Caller names the array per entity (`docs`, etc.).
 */
export function pageEnvelope<T>(
  key: string,
  rows: T[],
  limit: number,
  offset?: number
) {
  const hasMore = rows.length > limit
  return {
    [key]: hasMore ? rows.slice(0, limit) : rows,
    hasMore,
    offset: offset ?? 0
  }
}
