import { createHmac, timingSafeEqual } from 'node:crypto'

// Short-lived, scope-pinned token that lets a client without a browser session
// authenticate a narrow set of routes when auth is on. Stateless: the signature
// + `exp` carry everything, so no table is consulted (replay is bounded by the
// short TTL and pinned to one scope+value — e.g. a card key, an attachment id).
// The `scope` tag keeps a token minted for one purpose from being accepted for
// another (a commit token can't serve as an attachment token).

const DEFAULT_TTL_SECONDS = 600

interface ScopedTokenPayload {
  scope: string
  value: string
  exp: number
}

// Dedicated secret when set, else the always-present (and per-instance) better-auth
// secret — so no new required env, while a deployment can still separate the keys.
export function resolveCommitTokenSecret(
  env: NodeJS.ProcessEnv = process.env
): string | null {
  return env.AB_COMMIT_TOKEN_SECRET || env.BETTER_AUTH_SECRET || null
}

function sign(payload: string, secret: string): string {
  return createHmac('sha256', secret).update(payload).digest('base64url')
}

export function signScopedToken(
  scope: string,
  value: string,
  secret: string,
  ttlSeconds: number = DEFAULT_TTL_SECONDS,
  now: number = Date.now()
): { token: string, expiresAt: string } {
  const exp = Math.floor(now / 1000) + ttlSeconds
  const payload = Buffer.from(JSON.stringify({ scope, value, exp })).toString(
    'base64url'
  )
  return {
    token: `v1.${payload}.${sign(payload, secret)}`,
    expiresAt: new Date(exp * 1000).toISOString()
  }
}

export function verifyScopedToken(
  scope: string,
  token: string,
  expectedValue: string,
  secret: string,
  now: number = Date.now()
): boolean {
  const parts = token.split('.')
  const [version, payload, sig] = parts
  if (parts.length !== 3 || version !== 'v1' || !payload || !sig) return false

  const expected = sign(payload, secret)
  const a = Buffer.from(sig)
  const b = Buffer.from(expected)
  if (a.length !== b.length || !timingSafeEqual(a, b)) return false

  let decoded: ScopedTokenPayload
  try {
    decoded = JSON.parse(Buffer.from(payload, 'base64url').toString('utf8'))
  } catch {
    return false
  }
  if (decoded.scope !== scope || decoded.value !== expectedValue) return false
  if (typeof decoded.exp !== 'number' || decoded.exp * 1000 < now) return false
  return true
}
