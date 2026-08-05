import type { FastifyInstance } from 'fastify'
import { z } from 'zod'

import {
  attachCardCommit,
  clearWorkingTreeCommit,
  InputError,
  listCardCommits,
  resolveEntityProjectId
} from '@agents-board/core'
import type { Database } from '@agents-board/db'

import { storeImageUpload } from '../lib/imageUpload'

// `committedAt` arrives as an ISO string on the wire; the core coerces it.
const attachCommitBody = z.object({
  sha: z.string().min(1),
  message: z.string().min(1),
  stat: z.string().nullish(),
  diff: z.string().nullish(),
  committedAt: z.string().nullish(),
  authorName: z.string().nullish()
})

export function registerCardCommitRoutes(app: FastifyInstance, db: Database) {
  // POST by key: the capture script parses the key from the commit message and
  // never learns the internal card id.
  app.post<{ Params: { key: string } }>(
    '/cards/:key/commits',
    async (req) => {
      const body = attachCommitBody.parse(req.body)
      return attachCardCommit(db, { cardKey: req.params.key, ...body })
    }
  )

  // GET by id: the web already holds the card id.
  app.get<{ Params: { cardId: string } }>(
    '/cards/:cardId/commits',
    async req => listCardCommits(db, req.params.cardId)
  )

  // Store one image blob of a card's diff (multipart). The capture script posts
  // each changed image's before/after bytes here, gets back an `att_` id, and
  // writes it into the stored diff as the image sentinel; the diff write then
  // links these images to the card. Same card-scoped commit-token auth as the
  // diff POST — no browser session.
  app.post<{ Params: { key: string } }>(
    '/cards/:key/commit-images',
    async (req) => {
      const projectId = await resolveEntityProjectId(db, 'cardKey', req.params.key)
      if (!projectId) throw new InputError(`Card ${req.params.key} not found`)
      const row = await storeImageUpload(db, req, projectId)
      return { id: row.id }
    }
  )

  // Clear the pending working-tree diff (sentinel) when the tree is clean.
  app.delete<{ Params: { key: string } }>(
    '/cards/:key/commits/working',
    async (req) => {
      const cleared = await clearWorkingTreeCommit(db, req.params.key)
      return { cleared: cleared !== null }
    }
  )
}
