import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import { z } from 'zod'

import { resolveCommitTokenSecret, signUploadToken } from '@agents-board/core'

import { asJson } from './index'

export function registerUploadTools(server: McpServer) {
  server.registerTool(
    'issue_upload_token',
    {
      description:
        'Mint a short-lived, project-scoped token that authenticates the attach-image script against the API when auth is on. It only authorizes uploading an image to THIS project and expires quickly; it cannot be reused for another project or for the diff-capture routes. Export it as AB_UPLOAD_TOKEN so the script sends it in the X-AB-Upload-Token header. In sem-auth mode the script works without a token — minting is only needed when auth is enabled.',
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
