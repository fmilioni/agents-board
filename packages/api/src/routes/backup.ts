import type { FastifyInstance, FastifyReply } from 'fastify'

import {
  exportAll,
  exportProject,
  importBackup,
  serializeBackup
} from '@agents-board/core'
import type { Database } from '@agents-board/db'

// A full export gzips small, but `card_commits.diff` can push it past Fastify's
// 1MB default; size the upload ceiling for real backups.
const BACKUP_BODY_LIMIT = 1024 * 1024 * 1024

function sendBackup(reply: FastifyReply, filename: string, payload: Buffer) {
  reply.header('Content-Type', 'application/gzip')
  reply.header('Content-Disposition', `attachment; filename="${filename}"`)
  return reply.send(payload)
}

export function registerBackupRoutes(app: FastifyInstance, db: Database) {
  app.get<{ Params: { projectId: string } }>(
    '/projects/:projectId/export',
    async (req, reply) => {
      const env = await exportProject(db, req.params.projectId)
      if (!env.projectIds.length) {
        return reply.code(404).send({ error: 'not_found' })
      }
      return sendBackup(
        reply,
        `backup-${req.params.projectId}-v${env.version}.json.gz`,
        serializeBackup(env)
      )
    }
  )

  app.get('/export', async (_req, reply) => {
    const env = await exportAll(db)
    return sendBackup(reply, `backup-all-v${env.version}.json.gz`, serializeBackup(env))
  })

  app.addContentTypeParser(
    'application/gzip',
    { parseAs: 'buffer', bodyLimit: BACKUP_BODY_LIMIT },
    (_req, body, done) => done(null, body)
  )

  app.post(
    '/import',
    { bodyLimit: BACKUP_BODY_LIMIT },
    async (req, reply) => {
      const body = req.body
      if (!Buffer.isBuffer(body) || !body.length) {
        return reply.code(400).send({ error: 'expected a gzipped backup body' })
      }
      return importBackup(db, body, { mode: 'new' })
    }
  )
}
