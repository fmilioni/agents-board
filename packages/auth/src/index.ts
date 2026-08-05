import { betterAuth } from 'better-auth'
import { drizzleAdapter } from 'better-auth/adapters/drizzle'
import {
  mcp,
  oAuthDiscoveryMetadata,
  oAuthProtectedResourceMetadata,
  withMcpAuth
} from 'better-auth/plugins'

import { claimOrCreateUserAuthz } from '@agents-board/core'
import { createId, type Database, idPrefixes } from '@agents-board/db'
import {
  accounts,
  oauthAccessTokens,
  oauthApplications,
  oauthConsents,
  sessions,
  users,
  verifications
} from '@agents-board/db/schema'

export { oAuthDiscoveryMetadata, oAuthProtectedResourceMetadata, withMcpAuth }

export function isGithubConfigured(): boolean {
  return Boolean(
    process.env.GITHUB_CLIENT_ID && process.env.GITHUB_CLIENT_SECRET
  )
}

// E-mail+password is the zero-config base method (see ADR). Kept as a function
// so the capabilities endpoint and the auth instance read the same source once
// the sem-auth toggle (T2.5) makes it conditional.
export function isEmailPasswordEnabled(): boolean {
  return true
}

// The web runs on a different origin (:4401) than the API (:4400) where
// better-auth lives, so its origin must be trusted or better-auth's CSRF check
// rejects sign-in/sign-up. The API reuses this list for its CORS allow-list.
export function getTrustedOrigins(): string[] {
  const raw = process.env.AUTH_TRUSTED_ORIGINS
  if (raw) return raw.split(',').map(o => o.trim()).filter(Boolean)
  return ['http://127.0.0.1:4401']
}

export function getWebOrigin(): string {
  return getTrustedOrigins()[0] ?? 'http://127.0.0.1:4401'
}

// The MCP resource server's public URL — the OAuth token audience and the
// `resource` in the protected-resource metadata. Behind the reverse proxy (H5)
// it's the mcp. subdomain; locally it's the MCP's own origin.
export function getMcpResourceUrl(): string {
  return (process.env.MCP_PUBLIC_URL ?? 'http://127.0.0.1:4402').replace(
    /\/$/,
    ''
  )
}

// Where the OAuth authorize endpoint sends an unauthenticated user to sign in.
export function getMcpLoginPage(): string {
  if (process.env.MCP_OAUTH_LOGIN_PAGE) return process.env.MCP_OAUTH_LOGIN_PAGE
  return `${getWebOrigin().replace(/\/$/, '')}/login`
}

export async function hasAnyUser(db: Database): Promise<boolean> {
  const [row] = await db.select({ id: users.id }).from(users).limit(1)
  return Boolean(row)
}

const DEFAULT_MCP_ACCESS_TOKEN_TTL = 604800
const DEFAULT_MCP_REFRESH_TOKEN_TTL = 2592000
const MAX_MCP_TOKEN_TTL = 31536000

function readTtlSeconds(name: string, fallback: number): number {
  const raw = process.env[name]?.trim()
  if (!raw) return fallback
  const seconds = Number(raw)
  if (
    !Number.isInteger(seconds)
    || seconds < 1
    || seconds > MAX_MCP_TOKEN_TTL
  ) {
    console.warn(
      `Ignoring ${name}="${raw}": expected a positive integer of seconds up to ${MAX_MCP_TOKEN_TTL}. Using ${fallback}.`
    )
    return fallback
  }
  return seconds
}

export function createAuth(db: Database) {
  const loginPage = getMcpLoginPage()
  const cookieDomain = process.env.AUTH_COOKIE_DOMAIN?.trim()
  return betterAuth({
    appName: 'Agents Board',
    database: drizzleAdapter(db, {
      provider: 'pg',
      usePlural: true,
      schema: {
        users,
        sessions,
        accounts,
        verifications,
        oauthApplications,
        oauthAccessTokens,
        oauthConsents
      }
    }),
    secret: process.env.BETTER_AUTH_SECRET,
    baseURL: process.env.BETTER_AUTH_URL,
    basePath: '/api/auth',
    trustedOrigins: getTrustedOrigins(),
    plugins: [
      mcp({
        loginPage,
        resource: getMcpResourceUrl(),
        // loginPage repeated because oidcConfig is typed OIDCOptions (requires
        // it); the mcp plugin overrides it with the top-level value anyway.
        oidcConfig: {
          loginPage,
          requirePKCE: true,
          allowDynamicClientRegistration: true,
          accessTokenExpiresIn: readTtlSeconds(
            'MCP_ACCESS_TOKEN_TTL',
            DEFAULT_MCP_ACCESS_TOKEN_TTL
          ),
          refreshTokenExpiresIn: readTtlSeconds(
            'MCP_REFRESH_TOKEN_TTL',
            DEFAULT_MCP_REFRESH_TOKEN_TTL
          )
        }
      })
    ],
    emailAndPassword: { enabled: isEmailPasswordEnabled() },
    // Empty object = no social provider registered, so GitHub is truly absent
    // (not just hidden) when the host didn't configure it.
    socialProviders: isGithubConfigured()
      ? {
          github: {
            clientId: process.env.GITHUB_CLIENT_ID!,
            clientSecret: process.env.GITHUB_CLIENT_SECRET!
          }
        }
      : {},
    databaseHooks: {
      user: {
        create: {
          // Fires after the user row commits (better-auth drains create.after
          // post-transaction with adapter transactions off), so the user_authz
          // FK to users.id inside claimOrCreateUserAuthz is satisfied.
          after: async (user) => {
            await claimOrCreateUserAuthz(db, user.id)
          }
        }
      }
    },
    advanced: {
      // Cross-subdomain session: behind the reverse proxy (H5) the web (app.)
      // and API (api.) are different hosts of the same site, so the session
      // cookie must be scoped to the parent domain to travel between them.
      // Opt-in via AUTH_COOKIE_DOMAIN — unset locally, where web/API share a host.
      ...(cookieDomain
        ? { crossSubDomainCookies: { enabled: true, domain: cookieDomain } }
        : {}),
      database: {
        // better-auth model names (user/session/account/verification) match the
        // keys in db's idPrefixes, so the prefix map isn't duplicated here.
        generateId: ({ model }) => {
          const prefix = idPrefixes[model as keyof typeof idPrefixes]
          return prefix ? createId(prefix) : false
        }
      }
    }
  })
}

export type Auth = ReturnType<typeof createAuth>
