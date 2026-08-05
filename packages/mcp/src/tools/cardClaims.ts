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
    'Opaque session token this run uses to hold its claims. Generate ONE per run and reuse it for every claim/release/take-over call (the implement skill does this).'
  )

export function registerCardClaimTools(server: McpServer, db: Database) {
  server.registerTool(
    'claim_task',
    {
      description:
        'Reserve a task/story for your session (advisory — signals it is in your work buffer so other sessions/machines do not start the same work; nothing is locked). Reserving a STORY also reserves its not-yet-started children. If the card is already held by ANOTHER session, returns `{ ok:false, conflict:true, claim }` WITHOUT changing it — ask the user before take_over_task. Claim state also shows on get_card/list_cards (`claim`).',
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
        'Release your session\'s claim on a task/story (owner only — your sessionToken must match). A story also releases the children claims held by the same token. Releasing an unclaimed card is a no-op. Completing a task (status done) already releases it automatically.',
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
        'Take over a task/story claimed by another session, swapping the claim to your sessionToken. Use ONLY after the user explicitly confirms the take-over (the previous session may have crashed/been interrupted). A story also transfers its not-yet-started and already-claimed children.',
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
