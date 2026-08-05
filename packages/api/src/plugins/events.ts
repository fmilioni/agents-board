import fp from 'fastify-plugin'
import postgres from 'postgres'

import { type AbEvent, EVENT_CHANNEL } from '@agents-board/core'

declare module 'fastify' {
  interface FastifyInstance {
    events: {
      subscribe(handler: (event: AbEvent) => void): () => void
    }
  }
}

export default fp(async (app) => {
  const url = process.env.DATABASE_URL
  if (!url) throw new Error('DATABASE_URL is required for events plugin')

  // Dedicated connection for LISTEN - postgres.js manages it internally.
  const sql = postgres(url, { max: 1, idle_timeout: 0 })

  const handlers = new Set<(event: AbEvent) => void>()

  await sql.listen(EVENT_CHANNEL, (payload) => {
    if (!payload) return
    try {
      const event = JSON.parse(payload) as AbEvent
      for (const handler of handlers) {
        try {
          handler(event)
        } catch (err) {
          app.log.warn({ err }, 'events handler threw')
        }
      }
    } catch (err) {
      app.log.warn({ err, payload }, 'failed to parse event payload')
    }
  })

  app.decorate('events', {
    subscribe(handler) {
      handlers.add(handler)
      return () => {
        handlers.delete(handler)
      }
    }
  })

  app.addHook('onClose', async () => {
    handlers.clear()
    await sql.end({ timeout: 5 })
  })
})
