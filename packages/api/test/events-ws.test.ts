import assert from 'node:assert/strict'
import { describe, it } from 'node:test'

import type { FastifyInstance } from 'fastify'

import { type Database, schema } from '@agents-board/db'
import type { AbEvent } from '@agents-board/shared'

import { registerEventsWs } from '../src/routes/events-ws'

type RouteHandler = (
  socket: FakeSocket,
  req: {
    authUser: {
      userId: string
      role: 'user'
      status: 'approved'
      allProjects: false
    }
  }
) => void

class FakeSocket {
  sent: string[] = []
  closed = false
  listeners = new Map<string, () => void>()

  on(event: string, handler: () => void) {
    this.listeners.set(event, handler)
  }

  send(value: string) {
    this.sent.push(value)
  }

  close() {
    this.closed = true
  }
}

function queryRows(table: unknown) {
  if (table === schema.userAuthz) {
    return [{ role: 'user', status: 'approved', allProjects: false }]
  }
  if (table === schema.userProjectAccess) {
    return [{ projectId: 'prj_allowed' }]
  }
  return []
}

function fakeDb() {
  return {
    select() {
      return {
        from(table: unknown) {
          const rows = queryRows(table)
          const chain = {
            where() {
              return chain
            },
            async limit() {
              return rows
            },
            then<TResult1 = unknown, TResult2 = never>(
              onfulfilled?: ((value: unknown[]) => TResult1 | PromiseLike<TResult1>) | null,
              onrejected?: ((reason: unknown) => TResult2 | PromiseLike<TResult2>) | null
            ) {
              return Promise.resolve(rows).then(onfulfilled, onrejected)
            }
          }
          return chain
        }
      }
    }
  } as unknown as Database
}

describe('project identity event stream', () => {
  it('sends only identity events for projects accessible to the session', async () => {
    const routes = new Map<string, RouteHandler>()
    let subscriber: ((event: AbEvent) => void) | undefined
    let unsubscribed = false
    const app = {
      events: {
        subscribe(handler: (event: AbEvent) => void) {
          subscriber = handler
          return () => {
            unsubscribed = true
          }
        }
      },
      get(path: string, _options: unknown, handler: RouteHandler) {
        routes.set(path, handler)
      }
    } as unknown as FastifyInstance

    registerEventsWs(app, fakeDb())
    const socket = new FakeSocket()
    routes.get('/ws/projects')!(socket, {
      authUser: {
        userId: 'usr_1',
        role: 'user',
        status: 'approved',
        allProjects: false
      }
    })
    subscriber!({ type: 'project.changed', projectId: 'prj_allowed' })
    await new Promise(resolve => setImmediate(resolve))

    subscriber!({ type: 'project.changed', projectId: 'prj_allowed' })
    subscriber!({ type: 'project.deleted', projectId: 'prj_hidden' })
    subscriber!({ type: 'card.changed', projectId: 'prj_allowed', cardId: 'crd_1' })

    assert.deepEqual(socket.sent.map(value => JSON.parse(value)), [
      { type: 'projects.ready' },
      { type: 'project.changed', projectId: 'prj_allowed' }
    ])

    socket.listeners.get('close')!()
    assert.equal(unsubscribed, true)
  })
})
