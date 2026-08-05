import assert from 'node:assert/strict'
import { describe, it } from 'node:test'

import Fastify from 'fastify'

import type { Auth } from '@agents-board/auth'
import { type Database, schema } from '@agents-board/db'

import { registerAuthEnforcement } from '../src/plugins/auth-enforcement'
import errorHandler from '../src/plugins/error-handler'
import { registerProjectRoutes } from '../src/routes/projects'

type Role = 'admin' | 'user'

interface ProjectRow {
  id: string
  slug: string
  name: string
  description: string | null
  keyPrefix: string
  nextKeySeq: number
  repoProvider: null
  repoWebUrl: null
  createdAt: Date
  updatedAt: Date
  archivedAt: null
}

interface FixtureOptions {
  authEnabled: boolean
  role?: Role
  hasGrant?: boolean
  project?: ProjectRow | null
  occupiedSlug?: string
}

function projectRow(): ProjectRow {
  const now = new Date('2026-08-05T12:00:00.000Z')
  return {
    id: 'prj_1',
    slug: 'old-project',
    name: 'Old Project',
    description: null,
    keyPrefix: 'AB',
    nextKeySeq: 10,
    repoProvider: null,
    repoWebUrl: null,
    createdAt: now,
    updatedAt: now,
    archivedAt: null
  }
}

function conditionParam(condition: unknown): string | undefined {
  const chunks = (
    condition as { queryChunks?: Array<{ value?: unknown }> }
  ).queryChunks ?? []
  return chunks.find(chunk => typeof chunk.value === 'string')?.value as
    | string
    | undefined
}

function createFixture(options: FixtureOptions) {
  let project = options.project === undefined ? projectRow() : options.project
  let grantReads = 0
  const events: unknown[] = []

  const db = {
    select() {
      return {
        from(table: unknown) {
          return {
            where() {
              return {
                async limit() {
                  if (table === schema.systemSettings) {
                    return [{ authEnabled: options.authEnabled }]
                  }
                  if (table === schema.userAuthz) {
                    return options.role
                      ? [{
                          role: options.role,
                          status: 'approved',
                          allProjects: false
                        }]
                      : []
                  }
                  if (table === schema.userProjectAccess) {
                    grantReads += 1
                    return options.hasGrant ? [{ projectId: 'prj_1' }] : []
                  }
                  return []
                }
              }
            }
          }
        }
      }
    },
    update() {
      return {
        set(values: { name?: string, slug?: string }) {
          return {
            where(condition: unknown) {
              return {
                async returning() {
                  if (!project || conditionParam(condition) !== project.id) {
                    return []
                  }
                  if (
                    options.occupiedSlug !== undefined
                    && values.slug === options.occupiedSlug
                  ) {
                    const error = new Error('duplicate key') as Error & {
                      code: string
                    }
                    error.code = '23505'
                    throw error
                  }
                  project = {
                    ...project,
                    ...(values.name !== undefined ? { name: values.name } : {}),
                    ...(values.slug !== undefined ? { slug: values.slug } : {}),
                    updatedAt: new Date('2026-08-05T13:00:00.000Z')
                  }
                  return [project]
                }
              }
            }
          }
        }
      }
    },
    async execute(query: unknown) {
      const chunks = (
        query as { queryChunks?: unknown[] }
      ).queryChunks ?? []
      const payload = chunks.find((chunk) => {
        if (typeof chunk !== 'string') return false
        try {
          return JSON.parse(chunk).type === 'project.changed'
        } catch {
          return false
        }
      })
      if (typeof payload === 'string') events.push(JSON.parse(payload))
      return []
    }
  } as unknown as Database

  const auth = {
    api: {
      async getSession({ headers }: { headers: Headers }) {
        return headers.get('authorization')
          ? { user: { id: 'usr_1' } }
          : null
      }
    }
  } as unknown as Auth

  const app = Fastify()
  const ready = async () => {
    await app.register(errorHandler)
    registerAuthEnforcement(app, auth, db)
    registerProjectRoutes(app, db)
    app.get('/ws/projects', async () => ({ ok: true }))
    await app.ready()
  }

  return {
    app,
    ready,
    events,
    get project() {
      return project
    },
    get grantReads() {
      return grantReads
    }
  }
}

describe('PATCH /projects/:id', () => {
  it('allows admins, rejects users before grants, and stays open in sem-auth', async () => {
    const admin = createFixture({ authEnabled: true, role: 'admin' })
    await admin.ready()
    const adminResponse = await admin.app.inject({
      method: 'PATCH',
      url: '/projects/prj_1',
      headers: { authorization: 'session' },
      payload: { name: 'Admin Rename' }
    })
    assert.equal(adminResponse.statusCode, 200)
    assert.equal(adminResponse.json().name, 'Admin Rename')
    assert.deepEqual(admin.events, [
      { type: 'project.changed', projectId: 'prj_1' }
    ])
    await admin.app.close()

    for (const hasGrant of [false, true]) {
      const user = createFixture({
        authEnabled: true,
        role: 'user',
        hasGrant
      })
      await user.ready()
      const response = await user.app.inject({
        method: 'PATCH',
        url: '/projects/prj_1',
        headers: { authorization: 'session' },
        payload: { name: 'Forbidden Rename' }
      })
      assert.equal(response.statusCode, 403)
      assert.deepEqual(response.json(), {
        error: 'forbidden',
        reason: 'admin_only'
      })
      assert.equal(user.grantReads, 0)
      assert.equal(user.project?.name, 'Old Project')

      const stream = await user.app.inject({
        method: 'GET',
        url: '/ws/projects',
        headers: { authorization: 'session' }
      })
      assert.equal(stream.statusCode, 200)
      await user.app.close()
    }

    const open = createFixture({ authEnabled: false })
    await open.ready()
    const openResponse = await open.app.inject({
      method: 'PATCH',
      url: '/projects/prj_1',
      payload: { slug: 'open-rename' }
    })
    assert.equal(openResponse.statusCode, 200)
    assert.equal(openResponse.json().slug, 'open-rename')
    await open.app.close()
  })

  it('maps validation, conflict, and not-found without partial writes', async () => {
    const fixture = createFixture({
      authEnabled: false,
      occupiedSlug: 'occupied'
    })
    await fixture.ready()

    const empty = await fixture.app.inject({
      method: 'PATCH',
      url: '/projects/prj_1',
      payload: {}
    })
    assert.equal(empty.statusCode, 400)
    assert.equal(empty.json().code, 'validation_error')

    const invalid = await fixture.app.inject({
      method: 'PATCH',
      url: '/projects/prj_1',
      payload: { slug: 'Not Valid' }
    })
    assert.equal(invalid.statusCode, 400)
    assert.equal(invalid.json().code, 'validation_error')

    const conflict = await fixture.app.inject({
      method: 'PATCH',
      url: '/projects/prj_1',
      payload: { name: 'Must Not Persist', slug: 'occupied' }
    })
    assert.equal(conflict.statusCode, 409)
    assert.deepEqual(conflict.json(), {
      error: 'Project slug is already in use',
      code: 'conflict'
    })
    assert.deepEqual(
      { name: fixture.project?.name, slug: fixture.project?.slug },
      { name: 'Old Project', slug: 'old-project' }
    )
    assert.deepEqual(fixture.events, [])
    await fixture.app.close()

    const missing = createFixture({ authEnabled: false, project: null })
    await missing.ready()
    const notFound = await missing.app.inject({
      method: 'PATCH',
      url: '/projects/prj_missing',
      payload: { name: 'Missing' }
    })
    assert.equal(notFound.statusCode, 404)
    assert.deepEqual(notFound.json(), { error: 'not_found' })
    await missing.app.close()
  })
})
