import assert from 'node:assert/strict'
import { describe, it } from 'node:test'

import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import type { z } from 'zod'

import type { Database } from '@agents-board/db'

import { toolContracts, withToolContract } from '../src/tool-contracts'
import { registerTools } from '../src/tools/index'

describe('MCP tool security metadata', () => {
  it('covers every registered tool with a complete stable contract', () => {
    const registrations: Array<{ name: string, config: Record<string, unknown> }> = []
    const server = {
      registerTool(name: string, config: Record<string, unknown>) {
        registrations.push({ name, config: withToolContract(name, config) })
      }
    } as unknown as McpServer

    registerTools(server, {} as Database, null)

    assert.equal(registrations.length, 68)
    assert.equal(new Set(registrations.map(({ name }) => name)).size, 68)
    assert.deepEqual(
      registrations.map(({ name }) => name).sort(),
      Object.keys(toolContracts).sort()
    )

    for (const { config } of registrations) {
      assert.equal(typeof config.title, 'string')
      assert.ok((config.title as string).length > 0)
      assert.deepEqual(Object.keys(config.annotations as object).sort(), [
        'destructiveHint',
        'openWorldHint',
        'readOnlyHint'
      ])
      assert.equal(
        Object.values(config.annotations as object).every(
          value => typeof value === 'boolean'
        ),
        true
      )
    }
  })

  it('fails closed when a newly registered tool has no contract', () => {
    assert.throws(
      () => withToolContract('missing_tool', {}),
      /Missing MCP tool contract: missing_tool/
    )
  })

  it('keeps every tool description concise and self-contained', () => {
    const registrations: Array<{ name: string, config: Record<string, unknown> }> = []
    const server = {
      registerTool(name: string, config: Record<string, unknown>) {
        registrations.push({ name, config })
      }
    } as unknown as McpServer

    registerTools(server, {} as Database, null)

    for (const { name, config } of registrations) {
      assert.equal(typeof config.description, 'string')
      const description = config.description as string
      assert.equal(description, description.trim())
      assert.equal(description.includes('\n'), false)
      assert.ok(description.length >= 30, `${name} description is too terse`)
      assert.ok(description.length <= 400, `${name} description contains workflow-level detail`)
    }
  })

  it('requires update_project to identify a target and change its identity', () => {
    let inputSchema: z.ZodType | undefined
    const server = {
      registerTool(name: string, config: Record<string, unknown>) {
        if (name === 'update_project') {
          inputSchema = config.inputSchema as z.ZodType
        }
      }
    } as unknown as McpServer

    registerTools(server, {} as Database, null)

    assert.equal(inputSchema?.safeParse({ id: 'prj_1' }).success, false)
    assert.equal(
      inputSchema?.safeParse({ id: 'prj_1', name: 'Renamed' }).success,
      true
    )
    assert.equal(
      inputSchema?.safeParse({ id: 'prj_1', slug: 'Not Valid' }).success,
      false
    )
    assert.equal(
      inputSchema?.safeParse({
        id: 'prj_1',
        slug: 'renamed',
        projectId: 'prj_other'
      }).success,
      false
    )
  })

  it('classifies the full tool matrix by actual effect', () => {
    const readOnly = Object.entries(toolContracts)
      .filter(([, contract]) => contract.annotations.readOnlyHint)
      .map(([name]) => name)
      .sort()
    const additive = Object.entries(toolContracts)
      .filter(([, contract]) =>
        !contract.annotations.readOnlyHint
        && !contract.annotations.destructiveHint
      )
      .map(([name]) => name)
      .sort()

    assert.deepEqual(readOnly, [
      'get_active_sprint',
      'get_card',
      'get_card_by_key',
      'get_cards',
      'get_commit_diff',
      'get_project',
      'list_cards',
      'list_docs',
      'list_inbox',
      'list_projects',
      'list_sprints',
      'list_tags',
      'read_doc',
      'search_cards',
      'search_docs'
    ])
    assert.deepEqual(additive, [
      'add_blocker',
      'add_comment',
      'add_tag_to_card',
      'create_card',
      'create_inbox',
      'create_project',
      'create_sprint',
      'create_tag',
      'issue_commit_token',
      'issue_upload_token'
    ])
    assert.equal(readOnly.length + additive.length + 43, 68)
  })
})
