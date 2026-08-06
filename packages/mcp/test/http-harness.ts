import { randomUUID } from 'node:crypto'
import { once } from 'node:events'
import { type Server } from 'node:http'
import { type AddressInfo } from 'node:net'

import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js'
import {
  PostgreSqlContainer,
  type StartedPostgreSqlContainer
} from '@testcontainers/postgresql'
import { sql } from 'drizzle-orm'

import {
  createAuth,
  oAuthDiscoveryMetadata,
  oAuthProtectedResourceMetadata
} from '@agents-board/auth'
import { setAuthEnabled } from '@agents-board/core'
import {
  createDb,
  type Database,
  runMigrations,
  schema
} from '@agents-board/db'

import {
  type HttpAuthRuntime,
  startHttpServer
} from '../src/http'

interface BearerOptions {
  allProjects?: boolean
  expired?: boolean
  projectIds?: string[]
  role?: 'admin' | 'user'
  status?: 'approved' | 'pending'
}

interface HarnessOptions {
  authEnabled?: boolean
}

export class McpHttpTestEnvironment {
  private container?: StartedPostgreSqlContainer
  private databaseUrl?: string
  private readonly harnesses = new Set<McpHttpHarness>()
  private readonly templateDatabase = `mcp_template_${suffix()}`

  async start() {
    this.container = await new PostgreSqlContainer('pgvector/pgvector:pg16').start()
    this.databaseUrl = this.container.getConnectionUri()

    const admin = createDb({ url: this.databaseUrl, max: 1 })
    try {
      await admin.db.execute(sql.raw(`CREATE DATABASE ${this.templateDatabase}`))
      const template = createDb({
        url: databaseUrl(this.databaseUrl, this.templateDatabase),
        max: 1
      })
      try {
        await runMigrations(template.db)
      } finally {
        await template.close()
      }
      await admin.db.execute(
        sql.raw(
          `ALTER DATABASE ${this.templateDatabase} WITH IS_TEMPLATE true ALLOW_CONNECTIONS false`
        )
      )
    } finally {
      await admin.close()
    }
  }

  async createHarness(options: HarnessOptions = {}) {
    if (!this.databaseUrl) throw new Error('MCP HTTP test environment is not started.')
    const name = `mcp_test_${suffix()}`
    const admin = createDb({ url: this.databaseUrl, max: 1 })
    try {
      await admin.db.execute(
        sql.raw(`CREATE DATABASE ${name} TEMPLATE ${this.templateDatabase}`)
      )
    } finally {
      await admin.close()
    }

    const connection = createDb({ url: databaseUrl(this.databaseUrl, name) })
    let server: Server | undefined
    try {
      await setAuthEnabled(connection.db, options.authEnabled ?? false)
      const authRuntime: { current?: HttpAuthRuntime } = {}
      server = startHttpServer({
        authRuntime: () => {
          if (!authRuntime.current) {
            throw new Error('MCP HTTP auth runtime is not ready.')
          }
          return authRuntime.current
        },
        db: connection.db,
        host: '127.0.0.1',
        port: 0
      })
      await once(server, 'listening')
      const port = (server.address() as AddressInfo).port
      const baseUrl = new URL(`http://127.0.0.1:${port}`)
      const authorizationServerUrl = new URL('https://auth.mcp.test')
      const auth = withEnvironment({
        AUTH_TRUSTED_ORIGINS: 'http://127.0.0.1:4401',
        BETTER_AUTH_SECRET: 'mcp-http-contract-test-secret-000000000000',
        BETTER_AUTH_URL: authorizationServerUrl.origin,
        MCP_PUBLIC_URL: baseUrl.origin
      }, () => createAuth(connection.db))
      authRuntime.current = {
        getMcpSession: headers => auth.api.getMcpSession({ headers }),
        protectedResourceMetadata: oAuthProtectedResourceMetadata(auth),
        resourceUrl: baseUrl.origin
      }
      const harness = new McpHttpHarness({
        authorizationServerMetadata: oAuthDiscoveryMetadata(auth),
        authorizationServerUrl,
        baseUrl,
        closeDb: connection.close,
        db: connection.db,
        dropDatabase: () => this.dropDatabase(name),
        onClosed: () => this.harnesses.delete(harness),
        server
      })
      this.harnesses.add(harness)
      return harness
    } catch (error) {
      server?.closeAllConnections()
      await Promise.allSettled([
        ...(server ? [closeServer(server)] : []),
        connection.close()
      ])
      await this.dropDatabase(name)
      throw error
    }
  }

  async close() {
    const harnessResults = await Promise.allSettled(
      [...this.harnesses].map(harness => harness.close())
    )
    const harnessErrors = harnessResults
      .filter(result => result.status === 'rejected')
      .map(result => result.reason)
    try {
      await this.container?.stop()
    } finally {
      this.container = undefined
      this.databaseUrl = undefined
      this.harnesses.clear()
    }
    if (harnessErrors.length) {
      throw new AggregateError(harnessErrors, 'Failed to close MCP HTTP harnesses.')
    }
  }

  private async dropDatabase(name: string) {
    if (!this.databaseUrl) return
    const admin = createDb({ url: this.databaseUrl, max: 1 })
    try {
      await admin.db.execute(sql.raw(`DROP DATABASE IF EXISTS ${name} WITH (FORCE)`))
    } finally {
      await admin.close()
    }
  }
}

export class McpHttpHarness {
  readonly diagnostics: string[] = []
  readonly endpoint: URL
  private client?: Client
  private transport?: StreamableHTTPClientTransport
  private closed = false
  private closing?: Promise<void>

  constructor(private readonly options: {
    authorizationServerMetadata: (request: Request) => Promise<Response>
    authorizationServerUrl: URL
    baseUrl: URL
    closeDb: () => Promise<void>
    db: Database
    dropDatabase: () => Promise<void>
    onClosed: () => void
    server: Server
  }) {
    this.endpoint = new URL('/mcp', options.baseUrl)
  }

  get baseUrl() {
    return this.options.baseUrl
  }

  get authorizationServerUrl() {
    return this.options.authorizationServerUrl
  }

  get db() {
    return this.options.db
  }

  get sessionId() {
    return this.transport?.sessionId
  }

  async connect(bearerToken?: string) {
    if (this.client) throw new Error('The MCP HTTP harness already has a client.')
    const client = new Client({ name: 'agents-board-contract-test', version: '1.0.0' })
    const headers = bearerToken
      ? { Authorization: `Bearer ${bearerToken}` }
      : undefined
    const transport = new StreamableHTTPClientTransport(this.endpoint, {
      fetch: this.recordedFetch,
      requestInit: { headers }
    })
    try {
      await client.connect(transport)
    } catch (error) {
      throw new Error(
        `MCP initialize failed. ${this.diagnostics.join(' | ') || 'No HTTP response was received.'}`,
        { cause: error }
      )
    }
    this.client = client
    this.transport = transport
    return client
  }

  async issueBearer(options: BearerOptions = {}) {
    const id = suffix()
    const userId = `usr_${id}`
    const clientId = `client_${id}`
    const token = `access_${randomUUID()}`
    const now = Date.now()

    await this.db.insert(schema.users).values({
      id: userId,
      name: 'MCP Contract User',
      email: `${id}@mcp.test`
    })
    await this.db.insert(schema.userAuthz).values({
      userId,
      role: options.role ?? 'user',
      status: options.status ?? 'approved',
      allProjects: options.allProjects ?? false
    })
    if (options.projectIds?.length) {
      await this.db.insert(schema.userProjectAccess).values(
        options.projectIds.map(projectId => ({ userId, projectId }))
      )
    }
    await this.db.insert(schema.oauthApplications).values({
      id: `oap_${id}`,
      name: 'MCP contract client',
      clientId,
      redirectUrls: JSON.stringify(['http://127.0.0.1/callback']),
      type: 'public',
      userId
    })
    await this.db.insert(schema.oauthAccessTokens).values({
      id: `oat_${id}`,
      accessToken: token,
      refreshToken: `refresh_${randomUUID()}`,
      accessTokenExpiresAt: new Date(now + (options.expired ? -60_000 : 60_000)),
      refreshTokenExpiresAt: new Date(now + 120_000),
      clientId,
      userId,
      scopes: 'openid profile email offline_access'
    })

    return { token, userId }
  }

  async authorizationServerMetadata() {
    const response = await this.options.authorizationServerMetadata(
      new Request(
        new URL('/.well-known/oauth-authorization-server', this.authorizationServerUrl)
      )
    )
    return response.json() as Promise<Record<string, unknown>>
  }

  fetch(path: string, init?: RequestInit) {
    return fetch(new URL(path, this.baseUrl), init)
  }

  async terminateSession() {
    const sessionId = this.sessionId
    if (!sessionId || !this.transport) {
      throw new Error('The MCP HTTP harness has no open session.')
    }
    await this.transport.terminateSession()
    return sessionId
  }

  async close() {
    if (this.closed) return
    if (!this.closing) this.closing = this.closeResources()
    return this.closing
  }

  private readonly recordedFetch: typeof fetch = async (input, init) => {
    const request = new Request(input, init)
    try {
      const response = await fetch(request)
      this.diagnostics.push(
        `${request.method} ${new URL(request.url).pathname} -> ${response.status}`
      )
      return response
    } catch (error) {
      this.diagnostics.push(
        `${request.method} ${new URL(request.url).pathname} -> network error`
      )
      throw error
    }
  }

  private async closeResources() {
    const errors: unknown[] = []
    try {
      if (this.transport?.sessionId) {
        await this.transport.terminateSession().catch(error => errors.push(error))
      }
      await this.client?.close().catch(error => errors.push(error))
      this.options.server.closeAllConnections()
      await closeServer(this.options.server).catch(error => errors.push(error))
      await this.options.closeDb().catch(error => errors.push(error))
      await this.options.dropDatabase().catch(error => errors.push(error))
    } finally {
      this.closing = undefined
      this.closed = errors.length === 0
      if (this.closed) this.options.onClosed()
    }
    if (errors.length) {
      throw new AggregateError(errors, 'Failed to close the MCP HTTP harness.')
    }
  }
}

function suffix() {
  return randomUUID().replaceAll('-', '').slice(0, 20)
}

function databaseUrl(base: string, name: string) {
  const url = new URL(base)
  url.pathname = `/${name}`
  return url.href
}

function closeServer(server: Server) {
  return new Promise<void>((resolve, reject) => {
    server.close((error) => {
      if (
        !error
        || ('code' in error && error.code === 'ERR_SERVER_NOT_RUNNING')
      ) {
        resolve()
      } else reject(error)
    })
  })
}

function withEnvironment<T>(
  values: Record<string, string>,
  action: () => T
) {
  const snapshot = Object.fromEntries(
    Object.keys(values).map(name => [name, process.env[name]])
  )
  try {
    Object.assign(process.env, values)
    return action()
  } finally {
    restoreEnvironment(snapshot)
  }
}

function restoreEnvironment(snapshot: Record<string, string | undefined>) {
  for (const [name, value] of Object.entries(snapshot)) {
    if (value === undefined) delete process.env[name]
    else process.env[name] = value
  }
}
