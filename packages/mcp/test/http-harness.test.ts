import assert from 'node:assert/strict'
import { after, afterEach, before, describe, it } from 'node:test'

import packageJson from '../package.json'
import {
  McpHttpHarness,
  McpHttpTestEnvironment
} from './http-harness'

const environment = new McpHttpTestEnvironment()
const harnesses = new Set<McpHttpHarness>()

before(async () => environment.start())

afterEach(async () => {
  await Promise.all([...harnesses].map(harness => harness.close()))
  harnesses.clear()
})

after(async () => environment.close())

async function createHarness() {
  const harness = await environment.createHarness()
  harnesses.add(harness)
  return harness
}

describe('ephemeral MCP HTTP harness', () => {
  it('uses the official client for initialize, tools, resources, and teardown', async () => {
    const harness = await createHarness()
    const client = await harness.connect()

    assert.deepEqual(client.getServerVersion(), {
      name: 'agents-board',
      version: packageJson.version
    })
    assert.match(client.getInstructions() ?? '', /focused, paginated reads/)

    const tools = await client.listTools()
    assert.ok(tools.tools.some(tool => tool.name === 'create_project'))
    assert.ok(tools.tools.some(tool => tool.name === 'list_projects'))

    const created = valueOf<{ id: string }>(await client.callTool({
      name: 'create_project',
      arguments: {
        name: 'Harness Project',
        slug: 'harness-project',
        keyPrefix: 'HAR'
      }
    }))
    const listed = valueOf<{ projects: Array<{ id: string }> }>(
      await client.callTool({
        name: 'list_projects',
        arguments: { limit: 100, offset: 0 }
      })
    )
    assert.deepEqual(listed.projects.map(project => project.id), [created.id])

    const resources = await client.listResources()
    assert.ok(resources.resources.some(resource => resource.uri === 'agents-board://projects'))
    const projects = await client.readResource({ uri: 'agents-board://projects' })
    const markdown = projects.contents.find(content => 'text' in content)?.text ?? ''
    assert.match(markdown, /Harness Project/)

    const sessionId = await harness.terminateSession()
    const stale = await harness.fetch('/mcp', {
      method: 'POST',
      headers: {
        'Accept': 'application/json, text/event-stream',
        'Content-Type': 'application/json',
        'Mcp-Session-Id': sessionId
      },
      body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'ping' })
    })
    assert.equal(stale.status, 404)
  })

  it('allocates a fresh port and database for every run', async () => {
    const first = await createHarness()
    const second = await createHarness()
    const firstClient = await first.connect()
    await firstClient.callTool({
      name: 'create_project',
      arguments: { name: 'First Run', slug: 'first-run', keyPrefix: 'ONE' }
    })
    const secondClient = await second.connect()
    const listed = valueOf<{ projects: unknown[] }>(await secondClient.callTool({
      name: 'list_projects',
      arguments: { limit: 100, offset: 0 }
    }))

    assert.notEqual(second.endpoint.port, first.endpoint.port)
    assert.deepEqual(listed.projects, [])
  })
})

function valueOf<T>(result: { structuredContent?: Record<string, unknown> }) {
  assert.ok(result.structuredContent)
  return result.structuredContent.value as T
}
