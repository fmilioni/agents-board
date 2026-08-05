import { fromNodeHeaders } from 'better-auth/node'
import type { FastifyInstance, FastifyRequest } from 'fastify'

import type { Auth } from '@agents-board/auth'
import {
  getProjectBySlug,
  getSystemSettings,
  getUserAuthz,
  hasProjectGrant,
  resolveCardsProjectIds,
  resolveCommentsProjectIds,
  resolveCommitTokenSecret,
  resolveEntityProjectId,
  verifyAttachmentToken,
  verifyCommitToken,
  verifyUploadToken
} from '@agents-board/core'
import type { Database } from '@agents-board/db'
import type { UserRole, UserStatus } from '@agents-board/shared'

export interface AuthUser {
  userId: string
  role: UserRole
  status: UserStatus
  allProjects: boolean
}

declare module 'fastify' {
  interface FastifyRequest {
    // null while sem-auth is on (no session concept) — handlers that scope by
    // user must treat null as "unrestricted", mirroring pre-auth behavior.
    authUser: AuthUser | null
  }
}

const PUBLIC_EXACT = new Set([
  '/health',
  '/auth/capabilities',
  '/auth/me',
  // Self-guards on hasAnyUser (first boot only); see routes/auth.ts.
  '/setup/disable-auth',
  '/setup/settings',
  // OAuth discovery (RFC 8414) — must be reachable without a session so MCP
  // clients can bootstrap the auth flow.
  '/.well-known/oauth-authorization-server'
])

// Diff-write routes a card-scoped commit token may authorize without a session
// (the worktree script reuses POST /commits with a sentinel sha; DELETE clears
// the pending diff). Everything else stays session-only.
const COMMIT_TOKEN_ROUTES = new Set([
  'POST /cards/:key/commits',
  'POST /cards/:key/commit-images',
  'DELETE /cards/:key/commits/working'
])

// A valid `X-AB-Commit-Token` matching the route's card key stands in for a
// session, but ONLY on the routes above and ONLY for that card — it grants no
// broader identity (authUser stays null).
function acceptsCommitToken(req: FastifyRequest): boolean {
  const url = req.routeOptions?.url
  if (!url || !COMMIT_TOKEN_ROUTES.has(`${req.method} ${url}`)) return false
  const token = req.headers['x-ab-commit-token']
  const key = (req.params as Record<string, string>).key
  if (typeof token !== 'string' || !key) return false
  const secret = resolveCommitTokenSecret()
  return secret ? verifyCommitToken(token, key, secret) : false
}

// The agent's attach-image script has no browser session either. A valid
// `X-AB-Upload-Token` stands in for one on the upload route alone, and only for
// the project it was minted for (authUser stays null, as above).
function acceptsUploadToken(req: FastifyRequest): boolean {
  if (req.routeOptions?.url !== '/attachments' || req.method !== 'POST') {
    return false
  }
  const token = req.headers['x-ab-upload-token']
  const projectId = (req.query as Record<string, string | undefined>).projectId
  if (typeof token !== 'string' || !projectId) return false
  const secret = resolveCommitTokenSecret()
  return secret ? verifyUploadToken(token, projectId, secret) : false
}

// `<img>` can't send a session cookie cross-site, so the serve route accepts a
// short-lived signed value in the `?sig=` query, pinned to the attachment id.
// Mirrors the commit token, but scoped to GET /attachments/:id only.
function acceptsAttachmentToken(req: FastifyRequest): boolean {
  if (req.routeOptions?.url !== '/attachments/:id' || req.method !== 'GET') {
    return false
  }
  const sig = (req.query as Record<string, string | undefined>).sig
  const id = (req.params as Record<string, string>).id
  if (typeof sig !== 'string' || !id) return false
  const secret = resolveCommitTokenSecret()
  return secret ? verifyAttachmentToken(sig, id, secret) : false
}

function isPublic(url: string | undefined): boolean {
  if (!url) return false
  return url.startsWith('/api/auth') || PUBLIC_EXACT.has(url)
}

// Admin-only = system surface: project lifecycle, whole-system/per-project
// backup, user approval, and (added by CO-169) system settings.
const ADMIN_ONLY: Array<{ method: string, url: string }> = [
  { method: 'POST', url: '/projects' },
  { method: 'PATCH', url: '/projects/:id' },
  { method: 'DELETE', url: '/projects/:id' },
  { method: 'POST', url: '/projects/:id/archive' },
  { method: 'POST', url: '/projects/:id/restore' },
  { method: 'GET', url: '/export' },
  { method: 'POST', url: '/import' },
  { method: 'GET', url: '/projects/:projectId/export' },
  { method: 'GET', url: '/admin/users' },
  { method: 'POST', url: '/admin/users/:id/approve' },
  { method: 'DELETE', url: '/admin/users/:id' },
  // Reachable in sem-auth mode (the gate bypasses before this list), so an open
  // board can re-enable auth; admin-only once auth is on with users.
  { method: 'POST', url: '/admin/settings' },
  { method: 'GET', url: '/admin/embedding' },
  { method: 'POST', url: '/admin/embedding' }
]

export function isAdminOnly(method: string, url: string | undefined): boolean {
  return ADMIN_ONLY.some(r => r.method === method && r.url === url)
}

// Resolves the project(s) a request touches, so access can be checked before the
// handler runs. Returns null when no project can be resolved (treated as deny).
// Multiple ids only for /comments/handled, whose payload may span projects.
async function resolveProjectIds(
  db: Database,
  req: FastifyRequest
): Promise<string[] | null> {
  const url = req.routeOptions?.url
  const params = req.params as Record<string, string>
  const query = req.query as Record<string, string | undefined>
  const body = (req.body ?? {}) as Record<string, unknown>
  const one = (id: string | null) => (id ? [id] : null)
  const entity = (kind: Parameters<typeof resolveEntityProjectId>[1], id: string) =>
    resolveEntityProjectId(db, kind, id).then(one)

  switch (url) {
    case '/cards':
    case '/sprints':
    case '/sprints/active':
    case '/docs':
    case '/tags':
      return req.method === 'POST'
        ? one((body.projectId as string) ?? null)
        : one(query.projectId ?? null)
    case '/comments/unhandled':
      return one(query.projectId ?? null)
    case '/attachments':
      // Upload carries the file in the multipart body (unparsed at this hook),
      // so the project scope rides in the query.
      return one(query.projectId ?? null)
    case '/attachments/:id':
    case '/attachments/:id/url':
      return entity('attachment', params.id!)
    case '/projects/:projectId/intake':
    case '/ws/projects/:projectId':
      return one(params.projectId ?? null)
    case '/projects/:slug': {
      const project = await getProjectBySlug(db, params.slug!)
      return one(project?.id ?? null)
    }
    case '/cards/:id':
    case '/cards/:id/archive':
    case '/cards/:id/restore':
    case '/cards/:id/claim':
    case '/cards/:id/release':
    case '/cards/:id/take-over':
      return entity('card', params.id!)
    case '/cards/by-key/:key':
    case '/cards/:key/commits':
    case '/cards/:key/commit-images':
    case '/cards/:key/commits/working':
      return entity('cardKey', params.key!)
    case '/cards/:cardId/comments':
    case '/cards/:cardId/commits':
    case '/cards/:cardId/tags/:tagId':
    case '/cards/:cardId/blockers/:blockerId':
      return entity('card', params.cardId!)
    case '/cards/reorder': {
      // Reorder mutates every id in the payload, so access must cover them all.
      const ordered = (body.orderedIds as string[] | undefined) ?? []
      const moved = body.moved as { id?: string } | undefined
      const ids = moved?.id ? [...ordered, moved.id] : ordered
      return ids.length > 0 ? resolveCardsProjectIds(db, ids) : null
    }
    case '/sprints/:id':
    case '/sprints/:id/archive':
    case '/sprints/:id/restore':
    case '/sprints/:id/start':
    case '/sprints/:id/complete':
    case '/sprints/:id/deactivate':
    case '/sprints/:id/reopen':
      return entity('sprint', params.id!)
    case '/docs/:id':
    case '/docs/:id/archive':
    case '/docs/:id/restore':
      return entity('doc', params.id!)
    case '/tags/:tagId':
      return entity('tag', params.tagId!)
    case '/intake/:id':
      return entity('intakeItem', params.id!)
    case '/comments/:id':
      return entity('comment', params.id!)
    case '/comments/handled':
      return resolveCommentsProjectIds(db, (body.commentIds as string[]) ?? [])
    default:
      return null
  }
}

// Single global gate. Order: public allowlist → sem-auth bypass → session →
// approval → admin-only → unrestricted (admin/allProjects) → per-project access.
// The GET /projects list is allowed through and filtered in its handler.
export function registerAuthEnforcement(
  app: FastifyInstance,
  auth: Auth,
  db: Database
) {
  app.addHook('preHandler', async (req, reply) => {
    req.authUser = null
    if (req.method === 'OPTIONS') return

    const url = req.routeOptions?.url
    if (isPublic(url)) return

    const { authEnabled } = await getSystemSettings(db)
    if (!authEnabled) return

    const session = await auth.api.getSession({
      headers: fromNodeHeaders(req.raw.headers)
    })
    if (!session) {
      // Programmatic diff clients (attach-commit / attach-worktree-diff) have no
      // browser session; a valid card-scoped token authorizes just their routes.
      if (acceptsCommitToken(req)) return
      // A signed `<img>` serve URL stands in for a session on the serve route.
      if (acceptsAttachmentToken(req)) return
      if (acceptsUploadToken(req)) return
      return reply.code(401).send({ error: 'unauthorized' })
    }

    const authz = await getUserAuthz(db, session.user.id)
    if (!authz || authz.status !== 'approved') {
      return reply.code(403).send({ error: 'forbidden', reason: 'not_approved' })
    }
    req.authUser = {
      userId: session.user.id,
      role: authz.role,
      status: authz.status,
      allProjects: authz.allProjects
    }

    if (isAdminOnly(req.method, url)) {
      if (authz.role !== 'admin') {
        return reply.code(403).send({ error: 'forbidden', reason: 'admin_only' })
      }
      return
    }

    if (authz.role === 'admin' || authz.allProjects) return
    if (url === '/projects' && req.method === 'GET') return

    // Reaching here means approved + role 'user' + not allProjects, so the only
    // remaining check is the explicit grant — no need to re-read user_authz.
    const projectIds = await resolveProjectIds(db, req)
    if (projectIds === null) {
      return reply.code(403).send({ error: 'forbidden', reason: 'no_project' })
    }
    for (const projectId of projectIds) {
      if (!(await hasProjectGrant(db, session.user.id, projectId))) {
        return reply
          .code(403)
          .send({ error: 'forbidden', reason: 'project_access' })
      }
    }
  })
}
