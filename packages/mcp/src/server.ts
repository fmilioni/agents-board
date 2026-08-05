#!/usr/bin/env node
import { createDb } from '@agents-board/db'

import { startHttpServer } from './http'

const databaseUrl = process.env.DATABASE_URL
if (!databaseUrl) {
  console.error(
    '[agents-board-mcp] DATABASE_URL env var is required (see .env.example)'
  )
  process.exit(1)
}

// MCP is Streamable HTTP only (stdio was dropped in H5/CO-176). MCP_HTTP_PORT is
// an optional override; the conventional default is 4402.
const port = Number(process.env.MCP_HTTP_PORT ?? 4402)
if (!Number.isInteger(port) || port <= 0 || port > 65535) {
  console.error(
    `[agents-board-mcp] invalid MCP_HTTP_PORT: ${process.env.MCP_HTTP_PORT}`
  )
  process.exit(1)
}

const { db, close } = createDb({ url: databaseUrl, max: 4 })

const httpServer = startHttpServer({ db, port })

const shutdown = async () => {
  httpServer.close()
  await close()
  process.exit(0)
}
process.on('SIGINT', shutdown)
process.on('SIGTERM', shutdown)
