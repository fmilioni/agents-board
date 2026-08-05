import assert from 'node:assert/strict'
import { describe, it } from 'node:test'

import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import type { z } from 'zod'

import type { Database } from '@agents-board/db'

import { outputSchemaFor, toolOutputSchemas } from '../src/output-schemas'
import { withToolContract } from '../src/tool-contracts'
import { asJson } from '../src/tools/index'
import { registerTools } from '../src/tools/index'

const now = '2026-08-05T12:00:00.000Z'
const tag = { id: 'tag_1', projectId: 'prj_1', name: 'mcp', color: '#a855f7' }
const attachment = {
  id: 'att_1',
  uri: 'attachment://att_1',
  mime: 'image/png',
  width: 120,
  height: 80,
  description: null
}
const claim = { ownerLabel: 'Felipe Milioni', claimedAt: now }
const cardReference = {
  id: 'crd_1',
  key: 'AB-1',
  title: 'Contract',
  status: 'review'
}
const cardDetail = {
  id: 'crd_1',
  projectId: 'prj_1',
  sprintId: null,
  parentId: null,
  key: 'AB-1',
  title: 'Contract',
  summary: 'Describe the contract',
  descriptionMd: 'Body',
  status: 'review',
  priority: 10,
  dueDate: null,
  position: 0,
  createdAt: now,
  updatedAt: now,
  doneAt: null,
  tags: [tag],
  subtasks: [],
  parent: null,
  blockedBy: [cardReference],
  blocking: [],
  claim,
  commits: [{
    id: 'cmt_1',
    sha: 'abc123',
    message: 'feat: contract',
    stat: '1 file changed',
    committedAt: now,
    authorName: 'Felipe Milioni',
    createdAt: now
  }],
  attachments: [attachment]
}
const project = {
  id: 'prj_1',
  slug: 'agents-board',
  name: 'Agents Board',
  description: null,
  keyPrefix: 'AB',
  nextKeySeq: 432,
  repoProvider: 'github',
  repoWebUrl: 'https://github.com/example/agents-board',
  createdAt: now,
  updatedAt: now,
  archivedAt: null
}
const sprint = {
  id: 'spr_1',
  projectId: 'prj_1',
  roadmapId: null,
  name: 'Contract sprint',
  goal: null,
  status: 'active',
  startsAt: now,
  endsAt: null,
  createdAt: now,
  updatedAt: now,
  archivedAt: null
}

describe('MCP output schemas', () => {
  it('covers every registered tool with an object-root output schema', () => {
    const registrations: Array<{ name: string, outputSchema: z.ZodType }> = []
    const server = {
      registerTool(name: string, config: Record<string, unknown>) {
        const contracted = withToolContract(name, config)
        registrations.push({
          name,
          outputSchema: contracted.outputSchema
        })
      }
    } as unknown as McpServer

    registerTools(server, {} as Database, null)

    assert.equal(registrations.length, 68)
    assert.deepEqual(
      registrations.map(({ name }) => name).sort(),
      Object.keys(toolOutputSchemas).sort()
    )
    for (const { outputSchema } of registrations) {
      assert.equal(outputSchema.safeParse({}).success, false)
    }
  })

  it('validates representative values for every response family', () => {
    const cases: Array<[keyof typeof toolOutputSchemas, unknown]> = [
      ['list_projects', { projects: [project], hasMore: false, offset: 0 }],
      ['get_active_sprint', [sprint]],
      ['get_card', cardDetail],
      ['claim_task', {
        ok: false,
        conflict: true,
        claim,
        cascaded: []
      }],
      ['list_comments', {
        comments: [{
          id: 'cmt_1',
          cardId: 'crd_1',
          author: 'user',
          userId: 'usr_1',
          bodyMd: 'Please verify',
          aiStatus: 'read',
          createdAt: now,
          authorName: 'User',
          authorImage: null,
          attachments: [attachment]
        }],
        hasMore: false,
        offset: 0
      }],
      ['get_commit_diff', {
        id: 'ccm_1',
        cardId: 'crd_1',
        sha: 'abc123',
        message: 'feat: contract',
        stat: null,
        diff: null,
        committedAt: now,
        authorName: null,
        createdAt: now
      }],
      ['list_tags', { tags: [tag], hasMore: false, offset: 0 }],
      ['add_blocker', [cardReference]],
      ['read_doc', {
        id: 'doc_1',
        projectId: 'prj_1',
        parentId: null,
        title: 'MCP contract',
        summary: 'Output contract',
        kind: 'adr',
        position: 0,
        createdAt: now,
        updatedAt: now,
        bodyMd: 'Decision',
        attachments: []
      }],
      ['list_inbox', {
        items: [{
          id: 'inb_1',
          projectId: 'prj_1',
          bodyMd: 'Demand',
          status: 'pending',
          plannedCardKeys: null,
          createdAt: now,
          updatedAt: now,
          archivedAt: null,
          completed: false,
          attachments: []
        }],
        hasMore: false,
        offset: 0
      }],
      ['issue_upload_token', {
        projectId: 'prj_1',
        token: 'signed',
        expiresAt: now
      }]
    ]

    for (const [tool, value] of cases) {
      const result = asJson(value)
      const parsed = outputSchemaFor(tool).safeParse(result.structuredContent)

      assert.equal(parsed.success, true, tool)
      assert.deepEqual(JSON.parse(result.content[0]?.text ?? ''), value)
      assert.deepEqual(result.structuredContent.value, value)
    }
  })

  it('represents null, collection, acknowledgement, conflict, and data errors', () => {
    const cases: Array<[keyof typeof toolOutputSchemas, unknown]> = [
      ['get_project', null],
      ['update_project', project],
      ['get_active_sprint', []],
      ['set_card_status', { id: 'crd_1', key: 'AB-1', status: 'review' }],
      ['claim_task', {
        ok: false,
        conflict: true,
        claim,
        cascaded: []
      }],
      ['release_task', { error: 'not_found', cardKey: 'AB-999' }],
      ['delete_tag', { error: 'not_found' }]
    ]

    for (const [tool, value] of cases) {
      assert.equal(
        outputSchemaFor(tool).safeParse(asJson(value).structuredContent).success,
        true,
        tool
      )
    }
  })

  it('rejects values from a different response family', () => {
    assert.equal(
      outputSchemaFor('list_projects').safeParse({ value: [sprint] }).success,
      false
    )
    assert.equal(
      outputSchemaFor('get_card').safeParse({ value: project }).success,
      false
    )
  })
})
