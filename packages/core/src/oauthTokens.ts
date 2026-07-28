import { and, eq, gt, lt, sql } from 'drizzle-orm'

import { type Database, schema } from '@claude-organizer/db'

export const MCP_TOKEN_PATH = '/api/auth/mcp/token'

export interface TokenRequestLike {
  method: string
  url: string
  body: unknown
}

// better-auth's token endpoint accepts both urlencoded and JSON, and builds its
// body with a last-one-wins loop over the fields — read a renewal any other way
// and a duplicated field points this at a token the grant never used.
function readFields(body: unknown): Record<string, string> {
  if (typeof body === 'string') {
    return Object.fromEntries(new URLSearchParams(body))
  }
  if (body === null || typeof body !== 'object') return {}
  return Object.fromEntries(
    Object.entries(body).filter(
      (entry): entry is [string, string] => typeof entry[1] === 'string'
    )
  )
}

/**
 * The refresh token a request is renewing with, or null when the request isn't
 * a refresh grant on the MCP token endpoint.
 */
export function refreshTokenBeingRotated(
  request: TokenRequestLike
): string | null {
  if (request.method !== 'POST') return null
  if (request.url.split('?')[0] !== MCP_TOKEN_PATH) return null
  const fields = readFields(request.body)
  if (fields.grant_type !== 'refresh_token') return null
  return fields.refresh_token || null
}

/**
 * Retire the refresh token a renewal was made with. better-auth's refresh grant
 * issues a new row and leaves the presented one usable for its full lifetime,
 * so every renewal would otherwise leave another working credential behind.
 * The row's access token keeps its own expiry: a request already in flight with
 * it must not fail, and it can no longer be renewed.
 */
export async function revokeRefreshToken(
  db: Database,
  refreshToken: string
): Promise<boolean> {
  const rows = await db
    .update(schema.oauthAccessTokens)
    // A second in the past: the grant compares this stamp in Node, whose clock
    // can run behind Postgres's.
    .set({
      refreshTokenExpiresAt: sql`now() - interval '1 second'`,
      updatedAt: sql`now()`
    })
    .where(
      and(
        eq(schema.oauthAccessTokens.refreshToken, refreshToken),
        gt(schema.oauthAccessTokens.refreshTokenExpiresAt, sql`now()`)
      )
    )
    .returning({ id: schema.oauthAccessTokens.id })
  return rows.length > 0
}

/**
 * A row whose access token is spent but whose refresh token still lives is what
 * spares a client a new login, and a row retired by the rotation above still
 * carries a usable access token for a while — hence both halves, never one.
 */
export async function purgeExpiredOauthTokens(db: Database): Promise<number> {
  const rows = await db
    .delete(schema.oauthAccessTokens)
    .where(
      and(
        lt(schema.oauthAccessTokens.accessTokenExpiresAt, sql`now()`),
        lt(schema.oauthAccessTokens.refreshTokenExpiresAt, sql`now()`)
      )
    )
    .returning({ id: schema.oauthAccessTokens.id })
  return rows.length
}
