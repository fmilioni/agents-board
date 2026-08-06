import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import { z } from 'zod'

import {
  claimCard,
  getCardByKey,
  releaseCard,
  takeOverCard
} from '@agents-board/core'
import type { Database } from '@agents-board/db'

import { asJson } from './index'

const sessionToken = z
  .string()
  .min(1)
  .describe(
    'Opaque owner token. Generate one per working session and reuse it for claim, release, and take-over calls.'
  )

export function registerCardClaimTools(server: McpServer, db: Database) {
  server.registerTool(
    'claim_task',
    {
      description:
        'Advisory-reserve a card for this session; no data is locked. Claiming a story also claims its not-yet-started children. A claim held by another session returns { ok:false, conflict:true, claim } without changing ownership; do not take it over without user approval.',
      inputSchema: {
        cardKey: z.string().describe('Card key, e.g. \'AB-12\'.'),
        sessionToken,
        label: z
          .string()
          .max(200)
          .optional()
          .describe('Human-readable owner label (user name with auth on; a generic/session label otherwise).')
      }
    },
    async ({ cardKey, sessionToken, label }) => {
      const card = await getCardByKey(db, cardKey)
      if (!card) return asJson({ error: 'not_found', cardKey })
      return asJson(
        await claimCard(db, {
          cardId: card.id,
          ownerToken: sessionToken,
          ownerLabel: label
        })
      )
    }
  )

  server.registerTool(
    'release_task',
    {
      description:
        'Release a claim owned by the matching sessionToken. Releasing a story also releases child claims held by that token; unclaimed cards are a no-op, and moving a card to done already releases it.',
      inputSchema: {
        cardKey: z.string().describe('Card key, e.g. \'AB-12\'.'),
        sessionToken
      }
    },
    async ({ cardKey, sessionToken }) => {
      const card = await getCardByKey(db, cardKey)
      if (!card) return asJson({ error: 'not_found', cardKey })
      return asJson(
        await releaseCard(db, { cardId: card.id, ownerToken: sessionToken })
      )
    }
  )

  server.registerTool(
    'take_over_task',
    {
      description:
        'Replace another session\'s claim with this sessionToken. Requires explicit user approval because the other session may still be working. Story take-over also transfers eligible child claims.',
      inputSchema: {
        cardKey: z.string().describe('Card key, e.g. \'AB-12\'.'),
        sessionToken,
        label: z
          .string()
          .max(200)
          .optional()
          .describe('Human-readable owner label for the new owner.')
      }
    },
    async ({ cardKey, sessionToken, label }) => {
      const card = await getCardByKey(db, cardKey)
      if (!card) return asJson({ error: 'not_found', cardKey })
      return asJson(
        await takeOverCard(db, {
          cardId: card.id,
          ownerToken: sessionToken,
          ownerLabel: label
        })
      )
    }
  )
}
