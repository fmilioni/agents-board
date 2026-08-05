import { randomUUID } from 'node:crypto'

import { eq } from 'drizzle-orm'
import { beforeEach, describe, expect, it } from 'vitest'

import { schema } from '@agents-board/db'

import {
  MCP_TOKEN_PATH,
  purgeExpiredOauthTokens,
  refreshTokenBeingRotated,
  revokeRefreshToken
} from '../src/index'
import { useTestDb } from './helpers'

const ctx = useTestDb()

const CLIENT_ID = 'test-client'

function hoursFromNow(hours: number): Date {
  return new Date(Date.now() + hours * 60 * 60 * 1000)
}

async function seedToken(opts: {
  accessTokenExpiresAt: Date
  refreshTokenExpiresAt: Date
}): Promise<string> {
  const refreshToken = randomUUID()
  await ctx.db.insert(schema.oauthAccessTokens).values({
    id: `oat_${randomUUID().replace(/-/g, '').slice(0, 12)}`,
    accessToken: randomUUID(),
    refreshToken,
    accessTokenExpiresAt: opts.accessTokenExpiresAt,
    refreshTokenExpiresAt: opts.refreshTokenExpiresAt,
    clientId: CLIENT_ID,
    userId: null,
    scopes: 'openid offline_access'
  })
  return refreshToken
}

async function readToken(refreshToken: string) {
  const [row] = await ctx.db
    .select()
    .from(schema.oauthAccessTokens)
    .where(eq(schema.oauthAccessTokens.refreshToken, refreshToken))
  return row
}

beforeEach(async () => {
  await ctx.db.delete(schema.oauthAccessTokens)
  await ctx.db.delete(schema.oauthApplications)
  await ctx.db.insert(schema.oauthApplications).values({
    id: `oap_${randomUUID().replace(/-/g, '').slice(0, 12)}`,
    clientId: CLIENT_ID,
    name: 'Test client',
    redirectUrls: 'http://127.0.0.1/callback',
    type: 'public',
    disabled: false
  })
})

describe('refreshTokenBeingRotated', () => {
  const post = (body: unknown, url = MCP_TOKEN_PATH) => ({
    method: 'POST',
    url,
    body
  })

  it('reads the token out of a urlencoded renewal', () => {
    const body = 'grant_type=refresh_token&refresh_token=abc123'
    expect(refreshTokenBeingRotated(post(body))).toBe('abc123')
  })

  it('reads the token out of a JSON renewal', () => {
    const body = { grant_type: 'refresh_token', refresh_token: 'abc123' }
    expect(refreshTokenBeingRotated(post(body))).toBe('abc123')
  })

  it('takes the last value when a field is sent twice', () => {
    const body = 'grant_type=refresh_token&refresh_token=first&refresh_token=last'
    expect(refreshTokenBeingRotated(post(body))).toBe('last')
  })

  it('ignores an authorization_code exchange', () => {
    const body = 'grant_type=authorization_code&code=xyz&refresh_token=abc123'
    expect(refreshTokenBeingRotated(post(body))).toBeNull()
  })

  it('ignores another endpoint under the same auth mount', () => {
    const body = 'grant_type=refresh_token&refresh_token=abc123'
    expect(refreshTokenBeingRotated(post(body, '/api/auth/mcp/register'))).toBeNull()
  })

  it('ignores a GET', () => {
    const body = 'grant_type=refresh_token&refresh_token=abc123'
    expect(refreshTokenBeingRotated({ ...post(body), method: 'GET' })).toBeNull()
  })

  it('still matches when the path carries a query string', () => {
    const body = 'grant_type=refresh_token&refresh_token=abc123'
    expect(refreshTokenBeingRotated(post(body, `${MCP_TOKEN_PATH}?x=1`))).toBe('abc123')
  })

  it('returns null for a renewal with no token in it', () => {
    expect(refreshTokenBeingRotated(post('grant_type=refresh_token'))).toBeNull()
    expect(refreshTokenBeingRotated(post(undefined))).toBeNull()
    expect(refreshTokenBeingRotated(post({ grant_type: 'refresh_token', refresh_token: 7 }))).toBeNull()
  })
})

describe('revokeRefreshToken', () => {
  it('expires the presented refresh token', async () => {
    const refreshToken = await seedToken({
      accessTokenExpiresAt: hoursFromNow(1),
      refreshTokenExpiresAt: hoursFromNow(24)
    })

    expect(await revokeRefreshToken(ctx.db, refreshToken)).toBe(true)

    const row = await readToken(refreshToken)
    expect(row.refreshTokenExpiresAt.getTime()).toBeLessThanOrEqual(Date.now())
  })

  it('leaves the access token of the retired row alone', async () => {
    const accessTokenExpiresAt = hoursFromNow(2)
    const refreshToken = await seedToken({
      accessTokenExpiresAt,
      refreshTokenExpiresAt: hoursFromNow(24)
    })

    await revokeRefreshToken(ctx.db, refreshToken)

    const row = await readToken(refreshToken)
    expect(row.accessTokenExpiresAt.getTime()).toBe(accessTokenExpiresAt.getTime())
  })

  it('touches no other token', async () => {
    const target = await seedToken({
      accessTokenExpiresAt: hoursFromNow(1),
      refreshTokenExpiresAt: hoursFromNow(24)
    })
    const bystander = await seedToken({
      accessTokenExpiresAt: hoursFromNow(1),
      refreshTokenExpiresAt: hoursFromNow(24)
    })

    await revokeRefreshToken(ctx.db, target)

    const row = await readToken(bystander)
    expect(row.refreshTokenExpiresAt.getTime()).toBeGreaterThan(Date.now())
  })

  it('reports nothing revoked for an unknown token', async () => {
    expect(await revokeRefreshToken(ctx.db, randomUUID())).toBe(false)
  })

  it('reports nothing revoked when the token had already expired', async () => {
    const refreshToken = await seedToken({
      accessTokenExpiresAt: hoursFromNow(-2),
      refreshTokenExpiresAt: hoursFromNow(-1)
    })

    expect(await revokeRefreshToken(ctx.db, refreshToken)).toBe(false)
  })
})

describe('purgeExpiredOauthTokens', () => {
  it('deletes the rows whose halves are both expired', async () => {
    const spent = await seedToken({
      accessTokenExpiresAt: hoursFromNow(-2),
      refreshTokenExpiresAt: hoursFromNow(-1)
    })

    expect(await purgeExpiredOauthTokens(ctx.db)).toBe(1)
    expect(await readToken(spent)).toBeUndefined()
  })

  it('keeps a spent access token whose refresh token still lives', async () => {
    const renewable = await seedToken({
      accessTokenExpiresAt: hoursFromNow(-1),
      refreshTokenExpiresAt: hoursFromNow(24)
    })

    expect(await purgeExpiredOauthTokens(ctx.db)).toBe(0)
    expect(await readToken(renewable)).toBeDefined()
  })

  it('keeps a retired row while its access token is still usable', async () => {
    const retired = await seedToken({
      accessTokenExpiresAt: hoursFromNow(1),
      refreshTokenExpiresAt: hoursFromNow(24)
    })
    await revokeRefreshToken(ctx.db, retired)

    expect(await purgeExpiredOauthTokens(ctx.db)).toBe(0)
    expect(await readToken(retired)).toBeDefined()
  })
})
