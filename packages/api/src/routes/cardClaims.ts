import type { FastifyInstance } from 'fastify'

import { claimCard, releaseCard, takeOverCard } from '@agents-board/core'
import type { Database } from '@agents-board/db'

export function registerCardClaimRoutes(app: FastifyInstance, db: Database) {
  app.post<{ Params: { id: string } }>('/cards/:id/claim', async req =>
    claimCard(db, { ...(req.body as object), cardId: req.params.id } as never)
  )

  app.post<{ Params: { id: string } }>('/cards/:id/release', async req =>
    releaseCard(db, { ...(req.body as object), cardId: req.params.id } as never)
  )

  app.post<{ Params: { id: string } }>('/cards/:id/take-over', async req =>
    takeOverCard(db, { ...(req.body as object), cardId: req.params.id } as never)
  )
}
