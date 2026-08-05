import assert from 'node:assert/strict'
import { describe, it } from 'node:test'

import type { Database } from '@agents-board/db'

import { assertToolAccess, type McpScope } from '../src/scope'

const projectGrant = new Set(['prj_1'])

describe('MCP project identity authorization', () => {
  it('rejects a non-admin even with an explicit project grant', async () => {
    const scope: McpScope = {
      userId: 'usr_1',
      role: 'user',
      status: 'approved',
      projects: projectGrant
    }

    await assert.rejects(
      assertToolAccess(
        {} as Database,
        scope,
        'update_project',
        { id: 'prj_1', name: 'Renamed' }
      ),
      /requires the admin role/
    )
  })

  it('allows admins and sem-auth sessions', async () => {
    const admin: McpScope = {
      userId: 'usr_admin',
      role: 'admin',
      status: 'approved',
      projects: 'all'
    }

    await assert.doesNotReject(
      assertToolAccess(
        {} as Database,
        admin,
        'update_project',
        { id: 'prj_1', slug: 'renamed' }
      )
    )
    await assert.doesNotReject(
      assertToolAccess(
        {} as Database,
        null,
        'update_project',
        { id: 'prj_1', slug: 'renamed' }
      )
    )
  })
})
