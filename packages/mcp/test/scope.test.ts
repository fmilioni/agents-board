import assert from 'node:assert/strict'
import { describe, it } from 'node:test'

import type { Database } from '@agents-board/db'

import {
  assertToolAccess,
  hasToolScopeMapping,
  type McpScope
} from '../src/scope'
import { toolContracts } from '../src/tool-contracts'

const projectGrant = new Set(['prj_1'])

describe('MCP project identity authorization', () => {
  it('has a project resolver for every non-admin scoped tool', () => {
    const resolverExempt = new Set([
      'list_projects',
      'create_project',
      'update_project',
      'update_project_key_prefix',
      'archive_project',
      'restore_project',
      'destroy_project',
      'set_project_repo'
    ])

    for (const tool of Object.keys(toolContracts)) {
      assert.equal(
        hasToolScopeMapping(tool),
        !resolverExempt.has(tool),
        tool
      )
    }
  })

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
    await assert.rejects(
      assertToolAccess(
        {} as Database,
        scope,
        'update_project_key_prefix',
        { projectId: 'prj_1', newPrefix: 'NEW' }
      ),
      /requires the admin role/
    )
    await assert.rejects(
      assertToolAccess(
        {} as Database,
        scope,
        'set_project_repo',
        { projectId: 'prj_1', provider: 'github' }
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

  it('fails closed when an authenticated tool has no project mapping', async () => {
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
        'unmapped_contract_probe',
        { projectId: 'prj_1' }
      ),
      /no accessible project resolves/
    )
    await assert.rejects(
      assertToolAccess(
        {} as Database,
        { ...scope, projects: 'all' },
        'unmapped_contract_probe',
        { projectId: 'prj_1' }
      ),
      /no accessible project resolves/
    )
  })
})
