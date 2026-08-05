import assert from 'node:assert/strict'
import { describe, it } from 'node:test'

import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import { ResourceTemplate } from '@modelcontextprotocol/sdk/server/mcp.js'

import { type Database, schema } from '@agents-board/db'

import { registerResources } from '../src/resources/index'
import { registerProjectTools } from '../src/tools/projects'

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

interface ToolResult {
  content: Array<{ type: string, text: string }>
}

type ToolHandler = (input: Record<string, unknown>) => Promise<ToolResult>
type ResourceRead = (
  uri: URL,
  variables: Record<string, string>
) => Promise<{ contents: Array<{ text?: string }> }>

function conditionParam(condition: unknown): string | undefined {
  const chunks = (
    condition as { queryChunks?: Array<{ value?: unknown }> }
  ).queryChunks ?? []
  return chunks.find(chunk => typeof chunk.value === 'string')?.value as
    | string
    | undefined
}

function parseResult(result: ToolResult) {
  return JSON.parse(result.content[0]?.text ?? 'null') as unknown
}

function createFixture() {
  const now = new Date('2026-08-05T12:00:00.000Z')
  let project: ProjectRow = {
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
  const events: unknown[] = []

  const db = {
    select() {
      return {
        from(table: unknown) {
          assert.equal(table, schema.projects)
          return {
            async orderBy() {
              return [project]
            },
            where(condition: unknown) {
              return {
                async orderBy() {
                  return [project]
                },
                async limit() {
                  return conditionParam(condition) === project.slug
                    ? [project]
                    : []
                }
              }
            }
          }
        }
      }
    },
    update(table: unknown) {
      assert.equal(table, schema.projects)
      return {
        set(values: { name?: string, slug?: string }) {
          return {
            where(condition: unknown) {
              return {
                async returning() {
                  if (conditionParam(condition) !== project.id) return []
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

  const tools = new Map<string, ToolHandler>()
  const resourceReads = new Map<string, ResourceRead>()
  const templates = new Map<string, ResourceTemplate>()
  const server = {
    registerTool(
      name: string,
      _config: unknown,
      handler: ToolHandler
    ) {
      tools.set(name, handler)
    },
    registerResource(
      name: string,
      uri: string | ResourceTemplate,
      _metadata: unknown,
      handler: ResourceRead
    ) {
      resourceReads.set(name, handler)
      if (uri instanceof ResourceTemplate) templates.set(name, uri)
    }
  } as unknown as McpServer

  registerProjectTools(server, db, null)
  registerResources(server, db, null)

  return { tools, resourceReads, templates, events }
}

describe('MCP project rename integration', () => {
  it('updates tools, lookups, resource URIs, and emits one project.changed', async () => {
    const fixture = createFixture()
    const update = fixture.tools.get('update_project')!
    const list = fixture.tools.get('list_projects')!
    const get = fixture.tools.get('get_project')!

    const updated = parseResult(await update({
      id: 'prj_1',
      name: 'Renamed Project',
      slug: 'renamed-project'
    })) as ProjectRow
    assert.equal(updated.id, 'prj_1')
    assert.equal(updated.name, 'Renamed Project')
    assert.equal(updated.slug, 'renamed-project')

    const listed = parseResult(await list({ limit: 100, offset: 0 })) as {
      projects: ProjectRow[]
    }
    assert.deepEqual(
      listed.projects.map(({ id, name, slug }) => ({ id, name, slug })),
      [{ id: 'prj_1', name: 'Renamed Project', slug: 'renamed-project' }]
    )
    assert.equal(parseResult(await get({ slug: 'old-project' })), null)
    assert.equal(
      (parseResult(await get({ slug: 'renamed-project' })) as ProjectRow).id,
      'prj_1'
    )

    const projectsResource = await fixture.resourceReads.get('projects')!(
      new URL('agents-board://projects'),
      {}
    )
    const projectsText = projectsResource.contents[0]?.text ?? ''
    assert.match(projectsText, /Renamed Project/)
    assert.match(projectsText, /renamed-project/)
    assert.doesNotMatch(projectsText, /old-project/)

    for (const name of ['board', 'backlog']) {
      const listedResources = await fixture.templates.get(name)!.listCallback!(
        {} as never
      )
      assert.deepEqual(
        listedResources.resources.map(resource => resource.uri),
        [`agents-board://project/renamed-project/${name}`]
      )
      const oldResource = await fixture.resourceReads.get(name)!(
        new URL(`agents-board://project/old-project/${name}`),
        { slug: 'old-project' }
      )
      assert.match(
        oldResource.contents[0]?.text ?? '',
        /Project `old-project` not found\./
      )
    }

    assert.deepEqual(fixture.events, [
      { type: 'project.changed', projectId: 'prj_1' }
    ])
  })
})
