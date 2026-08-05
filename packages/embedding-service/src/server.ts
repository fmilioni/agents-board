import {
  clearRuntimeEmbeddingConfig,
  recordRuntimeEmbeddingConfig,
  resolveEffectiveEmbeddingConfig
} from '@agents-board/core'
import { createDb } from '@agents-board/db'
import { EMBEDDING_RUNTIME_SERVICE } from '@agents-board/shared'

import { createEmbedder, warmUp } from './embedder'
import { createEmbeddingHttpServer } from './http'

const databaseUrl = process.env.DATABASE_URL
if (!databaseUrl) {
  console.error('[embedding-service] DATABASE_URL env var is required (see .env.example)')
  process.exit(1)
}

const port = Number(process.env.EMBEDDING_SERVICE_PORT ?? 4403)
if (!Number.isInteger(port) || port <= 0 || port > 65535) {
  console.error(`[embedding-service] invalid EMBEDDING_SERVICE_PORT: ${process.env.EMBEDDING_SERVICE_PORT}`)
  process.exit(1)
}

const { db, close } = createDb({ url: databaseUrl, max: 2 })

const embedder = createEmbedder({
  resolveConfig: () => resolveEffectiveEmbeddingConfig(db),
  // Record what the service actually loaded so the admin status reflects it
  // (the single durable marker now — there's no per-process MCP tracking).
  onLoaded: cfg =>
    recordRuntimeEmbeddingConfig(db, EMBEDDING_RUNTIME_SERVICE, cfg).catch((err: unknown) => {
      console.warn('[embedding-service] runtime record failed; status may lag', err)
    })
})

const server = createEmbeddingHttpServer({ embedder, port })

// Fire-and-forget after the server is listening: /health reports `loading` until
// the model is ready (the container healthcheck waits on it), so the boot load
// never blocks the listener. warmUp retries through a transient DB outage so the
// model converges on its own without a container restart.
void warmUp(embedder)

const shutdown = async () => {
  server.close()
  // Drop the marker so a graceful decommission doesn't leave a stale row.
  await clearRuntimeEmbeddingConfig(db, EMBEDDING_RUNTIME_SERVICE).catch(() => {})
  await close()
  process.exit(0)
}
process.on('SIGINT', shutdown)
process.on('SIGTERM', shutdown)
