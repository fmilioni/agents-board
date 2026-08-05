import type { FastifyInstance } from 'fastify'
import { z } from 'zod'

import {
  applyEmbeddingConfig,
  approveUser,
  ConflictError,
  deleteUser,
  getEmbeddingStatus,
  getSystemSettings,
  listAllUsers,
  setAuthEnabled,
  setHideLooseDone,
  setIncludeAttachmentsInBackup,
  setKeepAttachmentsOnArchive,
  setKeepDiffsOnArchive
} from '@agents-board/core'
import type { Database } from '@agents-board/db'
import { USER_ROLES } from '@agents-board/shared'

// These routes are admin-only — enforced centrally in the auth-enforcement
// preHandler (ADMIN_ONLY), so the handlers don't re-check the role.
const approveBody = z.object({
  role: z.enum(USER_ROLES),
  allProjects: z.boolean(),
  projectIds: z.array(z.string()).optional()
})
const settingsBody = z
  .object({
    authEnabled: z.boolean().optional(),
    keepDiffsOnArchive: z.boolean().optional(),
    keepAttachmentsOnArchive: z.boolean().optional(),
    includeAttachmentsInBackup: z.boolean().optional(),
    hideLooseDoneEnabled: z.boolean().optional(),
    hideLooseDoneAfterDays: z.number().int().min(0).optional()
  })
  .refine(b => Object.values(b).some(v => v !== undefined), {
    message: 'No setting to update'
  })

// `model` is the registry id, 'none' (off), or null (unset → env/default); `dtype`
// is a fixed-list quantization or null (unset). Both optional — omitting one leaves
// it untouched. The core setters validate the values; a dtype-only change is lazy.
const embeddingBody = z.object({
  model: z.string().nullable().optional(),
  dtype: z.string().nullable().optional()
})

export function registerAdminRoutes(app: FastifyInstance, db: Database) {
  app.get('/admin/users', async () => listAllUsers(db))

  app.post<{ Params: { id: string } }>(
    '/admin/users/:id/approve',
    async (req) => {
      const body = approveBody.parse(req.body)
      return approveUser(db, req.params.id, body)
    }
  )

  app.delete<{ Params: { id: string } }>(
    '/admin/users/:id',
    async (req, reply) => {
      // Defense-in-depth for the UI's own-row block: never let an admin delete
      // their own account (auto-lockout). authUser is null in sem-auth — no
      // session, no self concept, so deletion is unrestricted there.
      if (req.authUser?.userId === req.params.id) {
        throw new ConflictError('Cannot remove your own account')
      }
      const removed = await deleteUser(db, req.params.id)
      if (!removed) return reply.code(404).send({ error: 'not_found' })
      return { deleted: true }
    }
  )

  app.post('/admin/settings', async (req) => {
    const body = settingsBody.parse(req.body)
    if (body.authEnabled !== undefined) await setAuthEnabled(db, body.authEnabled)
    if (body.keepDiffsOnArchive !== undefined) {
      await setKeepDiffsOnArchive(db, body.keepDiffsOnArchive)
    }
    if (body.keepAttachmentsOnArchive !== undefined) {
      await setKeepAttachmentsOnArchive(db, body.keepAttachmentsOnArchive)
    }
    if (body.includeAttachmentsInBackup !== undefined) {
      await setIncludeAttachmentsInBackup(db, body.includeAttachmentsInBackup)
    }
    if (
      body.hideLooseDoneEnabled !== undefined
      || body.hideLooseDoneAfterDays !== undefined
    ) {
      await setHideLooseDone(db, {
        enabled: body.hideLooseDoneEnabled,
        days: body.hideLooseDoneAfterDays
      })
    }
    return getSystemSettings(db)
  })

  app.get('/admin/embedding', async () => getEmbeddingStatus(db))

  app.post('/admin/embedding', async (req) => {
    const change = embeddingBody.parse(req.body)
    return applyEmbeddingConfig(db, change)
  })
}
