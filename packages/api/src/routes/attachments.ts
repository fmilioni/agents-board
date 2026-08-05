import type { FastifyInstance, FastifyReply } from 'fastify'
import { z } from 'zod'

import {
  getAttachment,
  getAttachmentMeta,
  getSystemSettings,
  resolveCommitTokenSecret,
  signAttachmentToken
} from '@agents-board/core'
import type { Database } from '@agents-board/db'

import { storeImageUpload } from '../lib/imageUpload'

export { MAX_UPLOAD_BYTES } from '../lib/imageUpload'

const uploadQuery = z.object({ projectId: z.string().min(1) })

function serveAttachment(reply: FastifyReply, mime: string, data: Buffer) {
  reply.header('Content-Type', mime)
  // Bytes for an id never change (the entity is immutable); a private cache is
  // safe even under auth since the id is unguessable.
  reply.header('Cache-Control', 'private, max-age=300')
  return reply.send(data)
}

export function registerAttachmentRoutes(app: FastifyInstance, db: Database) {
  app.post<{ Querystring: { projectId?: string } }>(
    '/attachments',
    async (req) => {
      const { projectId } = uploadQuery.parse(req.query)
      const row = await storeImageUpload(db, req, projectId)
      return {
        id: row.id,
        url: `/attachments/${row.id}`,
        width: row.width,
        height: row.height,
        mime: row.mime
      }
    }
  )

  // Serve bytes. The auth gate (auth-enforcement) already let this through via a
  // session or a valid `?sig` attachment token, so the handler just streams.
  app.get<{ Params: { id: string } }>('/attachments/:id', async (req, reply) => {
    const row = await getAttachment(db, req.params.id)
    if (!row) return reply.code(404).send({ error: 'not_found' })
    // Row alive but bytes reclaimed (zeroed on archive cleanup): 410 Gone lets
    // the render show a "removed in cleanup" placeholder, distinct from a 404.
    if (!row.data) return reply.code(410).send({ error: 'gone' })
    return serveAttachment(reply, row.mime, row.data)
  })

  // Mint a short-lived signed URL the web can drop into `<img src>`; the stored
  // markdown only ever holds the tokenless `/attachments/:id` path.
  app.get<{ Params: { id: string } }>('/attachments/:id/url', async (req, reply) => {
    const id = req.params.id
    const meta = await getAttachmentMeta(db, id)
    if (!meta) {
      return reply.code(404).send({ error: 'not_found' })
    }
    const size = { byteSize: meta.byteSize, width: meta.width, height: meta.height }
    const { authEnabled } = await getSystemSettings(db)
    const secret = authEnabled ? resolveCommitTokenSecret() : null
    if (!secret) return { url: `/attachments/${id}`, expiresAt: null, ...size }
    const signed = signAttachmentToken(id, secret)
    return {
      url: `/attachments/${id}?sig=${signed.token}`,
      expiresAt: signed.expiresAt,
      ...size
    }
  })
}
