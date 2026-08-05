import type { FastifyInstance } from 'fastify'

import { addBlocker, removeBlocker } from '@agents-board/core'
import type { Database } from '@agents-board/db'

export function registerBlockerRoutes(app: FastifyInstance, db: Database) {
  // `cardId` is the blocked card; `blockerId` is the card that blocks it.
  app.post<{ Params: { cardId: string, blockerId: string } }>(
    '/cards/:cardId/blockers/:blockerId',
    async req => addBlocker(db, req.params.cardId, req.params.blockerId)
  )

  app.delete<{ Params: { cardId: string, blockerId: string } }>(
    '/cards/:cardId/blockers/:blockerId',
    async req => removeBlocker(db, req.params.cardId, req.params.blockerId)
  )
}
