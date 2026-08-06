import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import { z } from 'zod'

import { resolveCommitTokenSecret, signUploadToken } from '@agents-board/core'

import { asJson } from './index'

export function registerUploadTools(server: McpServer) {
  server.registerTool(
    'issue_upload_token',
    {
      description:
        'Mint a short-lived token for attach-image when authentication is enabled. It authorizes uploads to one project only and cannot access diff routes. Pass it to the script as AB_UPLOAD_TOKEN; no token is needed when authentication is disabled.',
      inputSchema: { projectId: z.string() }
    },
    async ({ projectId }) => {
      const secret = resolveCommitTokenSecret()
      if (!secret) {
        throw new Error(
          'Upload-token signing is not configured: set AB_COMMIT_TOKEN_SECRET or BETTER_AUTH_SECRET.'
        )
      }
      return asJson({ projectId, ...signUploadToken(projectId, secret) })
    }
  )
}
