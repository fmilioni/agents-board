import { fromNodeHeaders } from 'better-auth/node'
import type {
  FastifyInstance,
  FastifyReply,
  FastifyRequest
} from 'fastify'
import { z } from 'zod'

import type { Auth } from '@claude-organizer/auth'
import {
  hasAnyUser,
  isEmailPasswordEnabled,
  isGithubConfigured,
  oAuthDiscoveryMetadata
} from '@claude-organizer/auth'
import {
  getSystemSettings,
  getUserAuthz,
  refreshTokenBeingRotated,
  revokeRefreshToken,
  setAuthEnabled,
  setEmbeddingDtype,
  setEmbeddingModel,
  setIncludeAttachmentsInBackup,
  setKeepAttachmentsOnArchive,
  setKeepDiffsOnArchive
} from '@claude-organizer/core'
import type { Database } from '@claude-organizer/db'
import type { AuthCapabilities, SessionUser } from '@claude-organizer/shared'
import { resolveEmbeddingConfig } from '@claude-organizer/shared'

// Bridge Fastify ↔ web Request/Response (instead of toNodeHandler + hijack) so
// the @fastify/cors hook still applies to better-auth's responses — a hijacked
// reply bypasses it, which would break cross-origin login from the web.
// Assumes JSON request bodies, which is better-auth's whole surface here (its
// other entry points are GET); a future non-JSON endpoint would need handling.
function toWebRequest(request: FastifyRequest): Request {
  const url = new URL(
    request.url,
    `${request.protocol}://${request.headers.host}`
  )
  const headers = fromNodeHeaders(request.headers)
  headers.delete('content-length') // body is re-serialized below
  const hasBody = request.method !== 'GET' && request.method !== 'HEAD'
  let body: string | undefined
  if (hasBody) {
    // The OAuth token/register endpoints post application/x-www-form-urlencoded;
    // the raw-string parser (registered below) keeps the body intact so better-
    // auth parses it natively. Everything else on this surface is JSON.
    const contentType = request.headers['content-type'] ?? ''
    body = contentType.includes('application/x-www-form-urlencoded')
      ? (request.body as string)
      : JSON.stringify(request.body ?? {})
  }
  return new Request(url, { method: request.method, headers, body })
}

function sendWebResponse(reply: FastifyReply, res: Response, body: string) {
  reply.status(res.status)
  res.headers.forEach((value, key) => {
    // Set-Cookie is handled below; forEach would comma-join multiple cookies.
    if (key.toLowerCase() !== 'set-cookie') reply.header(key, value)
  })
  for (const cookie of res.headers.getSetCookie()) {
    reply.header('set-cookie', cookie)
  }
  reply.send(body.length > 0 ? body : null)
}

export function registerAuthRoutes(
  app: FastifyInstance,
  auth: Auth,
  db: Database
) {
  // OAuth token/register endpoints are form-urlencoded; keep the raw body so the
  // better-auth bridge can forward it verbatim (Fastify has no form parser).
  app.addContentTypeParser(
    'application/x-www-form-urlencoded',
    { parseAs: 'string' },
    (_req, body, done) => done(null, body)
  )

  app.route({
    method: ['GET', 'POST'],
    url: '/api/auth/*',
    handler: async (request, reply) => {
      const rotated = refreshTokenBeingRotated(request)
      const res = await auth.handler(toWebRequest(request))
      const body = await res.text()
      if (rotated && res.status === 200) {
        try {
          const revoked = await revokeRefreshToken(db, rotated)
          if (!revoked) {
            request.log.warn('renewed with a refresh token that was not live')
          }
        } catch (err) {
          // The client already holds its new token; failing the renewal over
          // the retirement would send it back through a full login.
          request.log.error({ err }, 'refresh token rotation failed')
        }
      }
      sendWebResponse(reply, res, body)
    }
  })

  // RFC 8414 / MCP discovery: the issuer is the API root, so this metadata must
  // be served at the root path (better-auth also exposes it under /api/auth, but
  // clients resolve it from `{issuer}/.well-known/...`).
  const discovery = oAuthDiscoveryMetadata(auth)
  app.get('/.well-known/oauth-authorization-server', async (request, reply) => {
    const res = await discovery(toWebRequest(request))
    sendWebResponse(reply, res, await res.text())
  })

  app.get('/auth/capabilities', async (): Promise<AuthCapabilities> => {
    const settings = await getSystemSettings(db)
    const embedding = resolveEmbeddingConfig(
      undefined,
      settings.embeddingModel,
      settings.embeddingDtype
    )
    return {
      emailPassword: isEmailPasswordEnabled(),
      github: isGithubConfigured(),
      hasUsers: await hasAnyUser(db),
      authEnabled: settings.authEnabled,
      keepDiffsOnArchive: settings.keepDiffsOnArchive,
      keepAttachmentsOnArchive: settings.keepAttachmentsOnArchive,
      includeAttachmentsInBackup: settings.includeAttachmentsInBackup,
      hideLooseDoneEnabled: settings.hideLooseDoneEnabled,
      hideLooseDoneAfterDays: settings.hideLooseDoneAfterDays,
      embedding: {
        model: embedding.model,
        dim: embedding.dim,
        enabled: embedding.model !== null,
        dtype: embedding.dtype
      }
    }
  })

  // First-boot only: with no user yet there is no admin to authorize this, so it
  // self-guards on hasAnyUser. Disabling auth here is the "run without login"
  // setup choice; once a user exists, toggling lives behind the admin settings.
  app.post('/setup/disable-auth', async (_request, reply) => {
    if (await hasAnyUser(db)) {
      return reply.code(409).send({ error: 'already_setup' })
    }
    return setAuthEnabled(db, false)
  })

  // First-boot only (same self-guard): persist setup-screen system settings
  // before any admin exists. Once a user exists, this lives behind /admin/settings.
  app.post('/setup/settings', async (request, reply) => {
    if (await hasAnyUser(db)) {
      return reply.code(409).send({ error: 'already_setup' })
    }
    const body = z
      .object({
        keepDiffsOnArchive: z.boolean().optional(),
        keepAttachmentsOnArchive: z.boolean().optional(),
        includeAttachmentsInBackup: z.boolean().optional(),
        embeddingModel: z.string().nullable().optional(),
        embeddingDtype: z.string().nullable().optional()
      })
      .parse(request.body)
    if (body.keepDiffsOnArchive !== undefined) {
      await setKeepDiffsOnArchive(db, body.keepDiffsOnArchive)
    }
    if (body.keepAttachmentsOnArchive !== undefined) {
      await setKeepAttachmentsOnArchive(db, body.keepAttachmentsOnArchive)
    }
    if (body.includeAttachmentsInBackup !== undefined) {
      await setIncludeAttachmentsInBackup(db, body.includeAttachmentsInBackup)
    }
    // First-boot persists the choice; the service loads it on boot, so no
    // reconcile/backfill here (there's no content yet to re-embed).
    if (body.embeddingModel !== undefined) {
      await setEmbeddingModel(db, body.embeddingModel)
    }
    if (body.embeddingDtype !== undefined) {
      await setEmbeddingDtype(db, body.embeddingDtype)
    }
    return getSystemSettings(db)
  })

  app.get('/auth/me', async (request): Promise<SessionUser | null> => {
    const session = await auth.api.getSession({
      headers: fromNodeHeaders(request.headers)
    })
    if (!session) return null
    const { user } = session
    const authz = await getUserAuthz(db, user.id)
    return {
      id: user.id,
      name: user.name,
      email: user.email,
      image: user.image ?? null,
      role: authz?.role ?? 'user',
      status: authz?.status ?? 'pending'
    }
  })
}
