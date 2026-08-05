import type { FastifyInstance } from 'fastify'

import { listAccessibleProjectIds } from '@agents-board/core'
import type { Database } from '@agents-board/db'

export function registerEventsWs(app: FastifyInstance, db: Database) {
  app.get(
    '/ws/projects',
    { websocket: true },
    (socket, req) => {
      let closed = false
      let allowed: 'all' | Set<string> | undefined
      const unsubscribe = app.events.subscribe((event) => {
        if (!allowed) return
        if (
          event.type !== 'project.changed'
          && event.type !== 'project.deleted'
        ) return
        if (allowed !== 'all' && !allowed.has(event.projectId)) return
        try {
          socket.send(JSON.stringify(event))
        } catch {
          return
        }
      })
      const close = () => {
        closed = true
        unsubscribe()
      }
      socket.on('close', close)
      socket.on('error', close)

      const accessible = !req.authUser
        || req.authUser.role === 'admin'
        || req.authUser.allProjects
        ? Promise.resolve<'all'>('all')
        : listAccessibleProjectIds(db, req.authUser.userId)

      void accessible.then((ids) => {
        if (closed) return
        allowed = ids === 'all' ? 'all' : new Set(ids)
        socket.send(JSON.stringify({ type: 'projects.ready' }))
      }).catch(() => socket.close())
    }
  )

  app.get<{ Params: { projectId: string } }>(
    '/ws/projects/:projectId',
    { websocket: true },
    (socket, req) => {
      const { projectId } = req.params

      const unsubscribe = app.events.subscribe((event) => {
        if ((event as { projectId?: string }).projectId !== projectId) return
        try {
          socket.send(JSON.stringify(event))
        } catch {
          return
        }
      })

      socket.on('close', () => unsubscribe())
      socket.on('error', () => unsubscribe())

      try {
        socket.send(JSON.stringify({ type: 'hello', projectId }))
      } catch {
        socket.close()
      }
    }
  )
}
