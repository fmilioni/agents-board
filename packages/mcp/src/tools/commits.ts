import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import { z } from 'zod'

import { resolveCommitTokenSecret, signCommitToken } from '@agents-board/core'

import { asJson } from './index'

export function registerCommitTools(server: McpServer) {
  server.registerTool(
    'issue_commit_token',
    {
      description:
        'Mint a short-lived token for attach-commit or attach-worktree-diff when authentication is enabled. It authorizes diff operations for one card only. Pass it to the script as AB_COMMIT_TOKEN; no token is needed when authentication is disabled.',
      inputSchema: { cardKey: z.string() }
    },
    async ({ cardKey }) => {
      const secret = resolveCommitTokenSecret()
      if (!secret) {
        throw new Error(
          'Commit-token signing is not configured: set AB_COMMIT_TOKEN_SECRET or BETTER_AUTH_SECRET.'
        )
      }
      return asJson({ cardKey, ...signCommitToken(cardKey, secret) })
    }
  )
}
