import { randomUUID } from 'node:crypto'
import {
  createServer,
  type IncomingMessage,
  type Server,
  type ServerResponse
} from 'node:http'

import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js'
import { isInitializeRequest } from '@modelcontextprotocol/sdk/types.js'
import { fromNodeHeaders } from 'better-auth/node'

import {
  createAuth,
  getMcpResourceUrl,
  oAuthProtectedResourceMetadata
} from '@agents-board/auth'
import { getSystemSettings } from '@agents-board/core'
import type { Database } from '@agents-board/db'

import { createMcpServer } from './create-server'
import { type McpScope, resolveMcpScope } from './scope'

interface HttpServerOptions {
  authRuntime?: () => HttpAuthRuntime
  db: Database
  host?: string
  port: number
}

export interface HttpAuthRuntime {
  getMcpSession: (headers: Headers) => Promise<{
    accessTokenExpiresAt: Date
    userId: string | null
  } | null>
  protectedResourceMetadata: (request: Request) => Promise<Response>
  resourceUrl: string
}

const MCP_PATH = '/mcp'
const PROTECTED_RESOURCE_PATH = '/.well-known/oauth-protected-resource'

function jsonRpcError(code: number, message: string) {
  return JSON.stringify({ jsonrpc: '2.0', error: { code, message }, id: null })
}

function sendError(res: ServerResponse, status: number, code: number, message: string) {
  res.writeHead(status, { 'content-type': 'application/json' })
  res.end(jsonRpcError(code, message))
}

function readJsonBody(req: IncomingMessage): Promise<unknown> {
  return new Promise((resolve, reject) => {
    let raw = ''
    req.on('data', chunk => (raw += chunk))
    req.on('end', () => {
      if (!raw) {
        resolve(undefined)
        return
      }
      try {
        resolve(JSON.parse(raw))
      } catch (err) {
        reject(err instanceof Error ? err : new Error(String(err)))
      }
    })
    req.on('error', reject)
  })
}

// Streamable HTTP transport (stateful): one session per `Mcp-Session-Id`,
// created on the initialize request and torn down on close.
//
// Auth: this server is the OAuth *resource server*. When auth is enabled, every
// `/mcp` request must carry a valid `Authorization: Bearer` (validated against
// the shared better-auth store via getMcpSession); when disabled it stays open
// without login (sem-auth, T3.4). The static MCP_AUTH_TOKEN was dropped in
// favour of OAuth.
export function startHttpServer(options: HttpServerOptions): Server {
  const { db, host, port } = options
  const transports = new Map<string, StreamableHTTPServerTransport>()
  let resolvedAuthRuntime: HttpAuthRuntime | undefined

  function authRuntime() {
    if (!resolvedAuthRuntime) {
      if (options.authRuntime) resolvedAuthRuntime = options.authRuntime()
      else {
        const auth = createAuth(db)
        resolvedAuthRuntime = {
          getMcpSession: headers => auth.api.getMcpSession({ headers }),
          protectedResourceMetadata: oAuthProtectedResourceMetadata(auth),
          resourceUrl: getMcpResourceUrl()
        }
      }
    }
    return resolvedAuthRuntime
  }

  // Resolves the request's identity. `ok` gates access; `userId` (null in sem-auth
  // mode) drives the project scope built when a session's server is created.
  async function authenticate(
    req: IncomingMessage
  ): Promise<{ ok: boolean, userId: string | null }> {
    const { authEnabled } = await getSystemSettings(db)
    if (!authEnabled) return { ok: true, userId: null }
    const session = await authRuntime().getMcpSession(fromNodeHeaders(req.headers))
    // getMcpSession looks the token up but doesn't enforce expiry — guard here.
    if (!session || session.accessTokenExpiresAt.getTime() <= Date.now()) {
      return { ok: false, userId: null }
    }
    return { ok: true, userId: session.userId }
  }

  async function handle(req: IncomingMessage, res: ServerResponse) {
    const url = new URL(req.url ?? '/', `http://${req.headers.host ?? 'localhost'}`)

    // Public discovery: the resource metadata the 401's WWW-Authenticate points
    // to (never gated — it's how an unauthenticated client bootstraps).
    if (url.pathname === PROTECTED_RESOURCE_PATH) {
      if (req.method !== 'GET') {
        res.writeHead(405).end()
        return
      }
      const webRes = await authRuntime().protectedResourceMetadata(
        new Request(url, { method: 'GET', headers: fromNodeHeaders(req.headers) })
      )
      // Plain JSON metadata, no Set-Cookie — so Object.fromEntries (which would
      // collapse multi-value headers) is safe here.
      res.writeHead(webRes.status, Object.fromEntries(webRes.headers))
      res.end(await webRes.text())
      return
    }

    if (url.pathname !== MCP_PATH) {
      res.writeHead(404).end()
      return
    }

    const authn = await authenticate(req)
    if (!authn.ok) {
      const wwwAuthenticate = `Bearer resource_metadata="${authRuntime().resourceUrl}${PROTECTED_RESOURCE_PATH}"`
      res.writeHead(401, {
        'content-type': 'application/json',
        'WWW-Authenticate': wwwAuthenticate,
        'Access-Control-Expose-Headers': 'WWW-Authenticate'
      })
      res.end(jsonRpcError(-32001, 'Unauthorized'))
      return
    }

    const sessionId = req.headers['mcp-session-id'] as string | undefined

    if (req.method === 'POST') {
      let body: unknown
      try {
        body = await readJsonBody(req)
      } catch {
        sendError(res, 400, -32700, 'Parse error')
        return
      }

      let transport = sessionId ? transports.get(sessionId) : undefined
      if (!transport) {
        // Stale/unknown session (e.g. this process restarted and lost the map):
        // answer 404 so the client knows the session is gone and reinitializes a
        // new one, per the MCP spec. A 400 here is an unrecoverable error that
        // leaves the client's open session broken until it's fully restarted.
        if (sessionId) {
          sendError(res, 404, -32001, 'Session not found')
          return
        }
        if (!isInitializeRequest(body)) {
          sendError(res, 400, -32000, 'Bad Request: no valid session ID')
          return
        }
        transport = new StreamableHTTPServerTransport({
          sessionIdGenerator: () => randomUUID(),
          onsessioninitialized: (id) => {
            transports.set(id, transport!)
          }
        })
        transport.onclose = () => {
          if (transport!.sessionId) transports.delete(transport!.sessionId)
        }
        // Scope is fixed for the session at initialize, from the bearer's user
        // (null in sem-auth → unrestricted). Subsequent requests on the session
        // are still bearer-checked above; the scope doesn't change mid-session.
        const scope: McpScope | null = authn.userId
          ? await resolveMcpScope(db, authn.userId)
          : null
        await createMcpServer(db, scope).connect(transport)
      }

      await transport.handleRequest(req, res, body)
      return
    }

    // GET (SSE stream) and DELETE (session termination) need an open session.
    if (req.method === 'GET' || req.method === 'DELETE') {
      const transport = sessionId ? transports.get(sessionId) : undefined
      if (!transport) {
        // Same contract as POST: a known-but-gone session is 404 (reinitialize),
        // a missing header is 400.
        if (sessionId) sendError(res, 404, -32001, 'Session not found')
        else sendError(res, 400, -32000, 'Bad Request: no valid session ID')
        return
      }
      await transport.handleRequest(req, res)
      return
    }

    res.writeHead(405).end()
  }

  const httpServer = createServer((req, res) => {
    handle(req, res).catch((err) => {
      console.error('[agents-board-mcp] request error', err)
      if (!res.headersSent) sendError(res, 500, -32603, 'Internal server error')
    })
  })

  httpServer.listen(port, host, () => {
    const address = httpServer.address()
    const boundPort = typeof address === 'object' && address ? address.port : port
    console.error(
      `[agents-board-mcp] Streamable HTTP transport on http://${host ?? '127.0.0.1'}:${boundPort}${MCP_PATH} (OAuth when auth is enabled)`
    )
  })

  return httpServer
}
