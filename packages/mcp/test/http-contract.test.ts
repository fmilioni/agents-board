import assert from 'node:assert/strict'
import { after, afterEach, before, describe, it } from 'node:test'

import {
  createAttachment,
  createCard,
  createProject,
  setAuthEnabled
} from '@agents-board/core'

import {
  McpHttpHarness,
  McpHttpTestEnvironment
} from './http-harness'

interface ToolResult {
  content: Array<{ text?: string, type: string }>
  isError?: boolean
  structuredContent?: Record<string, unknown>
}

const environment = new McpHttpTestEnvironment()
const harnesses = new Set<McpHttpHarness>()

before(async () => environment.start())

afterEach(async () => {
  await Promise.all([...harnesses].map(harness => harness.close()))
  harnesses.clear()
})

after(async () => environment.close())

async function createHarness(options: { authEnabled?: boolean } = {}) {
  const harness = await environment.createHarness(options)
  harnesses.add(harness)
  return harness
}

describe('MCP HTTP contract', () => {
  it('exposes self-describing tools, mirrored output, pagination, errors, and resources without auth', async () => {
    const harness = await createHarness()
    const client = await harness.connect()
    const tools = await client.listTools()
    const listProjects = tools.tools.find(tool => tool.name === 'list_projects')
    const createTag = tools.tools.find(tool => tool.name === 'create_tag')
    const deleteTag = tools.tools.find(tool => tool.name === 'delete_tag')

    assert.equal(listProjects?.title, 'List projects')
    assert.deepEqual(listProjects?.annotations, {
      destructiveHint: false,
      openWorldHint: false,
      readOnlyHint: true
    })
    assert.equal(createTag?.annotations?.destructiveHint, false)
    assert.equal(deleteTag?.annotations?.destructiveHint, true)
    assert.equal(listProjects?.outputSchema?.type, 'object')
    assert.equal(listProjects?.outputSchema?.additionalProperties, false)
    assert.deepEqual(listProjects?.outputSchema?.required, ['value'])

    const project = mirroredValue<{ id: string }>(await client.callTool({
      name: 'create_project',
      arguments: {
        name: 'Contract Project',
        slug: 'contract-project',
        keyPrefix: 'CTR'
      }
    }))
    const cards: Array<{ id: string, key: string }> = []
    for (const title of ['One', 'Two', 'Three']) {
      cards.push(mirroredValue(await client.callTool({
        name: 'create_card',
        arguments: {
          projectId: project.id,
          title,
          summary: `${title} is a contract fixture`,
          descriptionMd: `## ${title}\n\nHTTP contract fixture.`
        }
      })))
    }

    const firstPage = mirroredValue<{
      cards: Array<{ key: string }>
      hasMore: boolean
      offset: number
    }>(await client.callTool({
      name: 'list_cards',
      arguments: { projectId: project.id, limit: 2, offset: 0 }
    }))
    const secondPage = mirroredValue<{
      cards: Array<{ key: string }>
      hasMore: boolean
      offset: number
    }>(await client.callTool({
      name: 'list_cards',
      arguments: { projectId: project.id, limit: 2, offset: 2 }
    }))
    assert.equal(firstPage.cards.length, 2)
    assert.equal(firstPage.hasMore, true)
    assert.equal(firstPage.offset, 0)
    assert.equal(secondPage.cards.length, 1)
    assert.equal(secondPage.hasMore, false)
    assert.equal(secondPage.offset, 2)

    const archived = mirroredValue<{ status: string }>(await client.callTool({
      name: 'archive_card',
      arguments: { id: cards[0]!.id }
    }))
    const restored = mirroredValue<{ status: string }>(await client.callTool({
      name: 'restore_card',
      arguments: { id: cards[0]!.id }
    }))
    assert.equal(archived.status, 'backlog')
    assert.equal(restored.status, 'backlog')

    const tag = mirroredValue<{ id: string }>(await client.callTool({
      name: 'create_tag',
      arguments: { projectId: project.id, name: 'temporary', color: '#123456' }
    }))
    mirroredValue(await client.callTool({
      name: 'update_tag',
      arguments: { id: tag.id, name: 'renamed' }
    }))
    mirroredValue(await client.callTool({
      name: 'delete_tag',
      arguments: { id: tag.id }
    }))
    const missingTag = await client.callTool({
      name: 'delete_tag',
      arguments: { id: tag.id }
    })
    assert.deepEqual(mirroredValue(missingTag), { error: 'not_found' })

    const invalidInput = await client.callTool({
      name: 'list_projects',
      arguments: { limit: 100, offset: 0, unknown: true }
    })
    assert.equal(invalidInput.isError, true)
    assert.match(textOf(invalidInput), /Unrecognized key/)

    const attachment = await createAttachment(harness.db, {
      projectId: project.id,
      mime: 'image/png',
      data: new Uint8Array([137, 80, 78, 71]),
      width: 1,
      height: 1,
      description: 'MCP contract pixel'
    })
    const resourceTemplates = await client.listResourceTemplates()
    assert.ok(resourceTemplates.resourceTemplates.some(
      template => template.uriTemplate === 'attachment://{id}'
    ))
    const resource = await client.readResource({
      uri: `attachment://${attachment.id}`
    })
    const blob = resource.contents.find(content => 'blob' in content)?.blob
    assert.equal(blob, Buffer.from([137, 80, 78, 71]).toString('base64'))

    await harness.terminateSession()
    assert.equal(harness.sessionId, undefined)
  })

  it('advertises OAuth, validates bearer expiry, and enforces project scope', async () => {
    const harness = await createHarness({ authEnabled: true })
    const allowedProject = await createProject(harness.db, {
      name: 'Allowed Project',
      slug: 'allowed-project',
      keyPrefix: 'ALW'
    })
    const deniedProject = await createProject(harness.db, {
      name: 'Denied Project',
      slug: 'denied-project',
      keyPrefix: 'DEN'
    })
    const allowedCard = await createCard(harness.db, {
      projectId: allowedProject.id,
      title: 'Allowed Card',
      summary: 'Visible through the scoped MCP session',
      descriptionMd: 'Allowed project content.'
    })
    const deniedCard = await createCard(harness.db, {
      projectId: deniedProject.id,
      title: 'Denied Card',
      summary: 'Must remain hidden from the scoped session',
      descriptionMd: 'Denied project content.'
    })
    const allowedAttachment = await createAttachment(harness.db, {
      projectId: allowedProject.id,
      mime: 'image/png',
      data: new Uint8Array([1, 2, 3]),
      width: 1,
      height: 1
    })
    const deniedAttachment = await createAttachment(harness.db, {
      projectId: deniedProject.id,
      mime: 'image/png',
      data: new Uint8Array([4, 5, 6]),
      width: 1,
      height: 1
    })

    const unauthorized = await initializeRequest(harness)
    assert.equal(unauthorized.status, 401)
    assert.equal(
      unauthorized.headers.get('www-authenticate'),
      `Bearer resource_metadata="${harness.baseUrl.origin}/.well-known/oauth-protected-resource"`
    )
    assert.equal(
      unauthorized.headers.get('access-control-expose-headers'),
      'WWW-Authenticate'
    )

    const invalid = await initializeRequest(harness, 'invalid-bearer')
    assert.equal(invalid.status, 401)
    const expiredBearer = await harness.issueBearer({
      expired: true,
      projectIds: [allowedProject.id]
    })
    const expired = await initializeRequest(harness, expiredBearer.token)
    assert.equal(expired.status, 401)
    const userlessBearer = await harness.issueBearer({ userless: true })
    const userless = await initializeRequest(harness, userlessBearer.token)
    assert.equal(userless.status, 401)

    const protectedResource = await harness.fetch(
      '/.well-known/oauth-protected-resource'
    )
    assert.equal(protectedResource.status, 200)
    assert.deepEqual(await protectedResource.json(), {
      authorization_servers: [harness.authorizationServerUrl.origin],
      bearer_methods_supported: ['header'],
      jwks_uri: `${harness.authorizationServerUrl.origin}/api/auth/mcp/jwks`,
      resource: harness.baseUrl.origin,
      resource_signing_alg_values_supported: ['RS256'],
      scopes_supported: ['openid', 'profile', 'email', 'offline_access']
    })

    const discovery = await harness.authorizationServerMetadata()
    assert.equal(discovery.issuer, harness.authorizationServerUrl.origin)
    assert.equal(
      discovery.authorization_endpoint,
      `${harness.authorizationServerUrl.origin}/api/auth/mcp/authorize`
    )
    assert.equal(
      discovery.token_endpoint,
      `${harness.authorizationServerUrl.origin}/api/auth/mcp/token`
    )
    assert.equal(
      discovery.registration_endpoint,
      `${harness.authorizationServerUrl.origin}/api/auth/mcp/register`
    )
    assert.deepEqual(discovery.code_challenge_methods_supported, ['S256'])

    const bearer = await harness.issueBearer({
      projectIds: [allowedProject.id]
    })
    const client = await harness.connect(bearer.token)
    const projects = mirroredValue<{
      projects: Array<{ id: string }>
    }>(await client.callTool({
      name: 'list_projects',
      arguments: { limit: 100, offset: 0 }
    }))
    assert.deepEqual(projects.projects.map(project => project.id), [allowedProject.id])

    const allowedCards = mirroredValue<{
      cards: Array<{ id: string }>
    }>(await client.callTool({
      name: 'list_cards',
      arguments: { projectId: allowedProject.id, limit: 100, offset: 0 }
    }))
    assert.deepEqual(allowedCards.cards.map(card => card.id), [allowedCard.id])

    const cardBatch = mirroredValue<Array<{ id: string }>>(await client.callTool({
      name: 'get_cards',
      arguments: { ids: [allowedCard.id, allowedCard.key] }
    }))
    assert.deepEqual(cardBatch.map(card => card.id), [allowedCard.id])

    const mixedCardBatch = await client.callTool({
      name: 'get_cards',
      arguments: { ids: [allowedCard.id, deniedCard.key] }
    })
    assert.equal(mixedCardBatch.isError, true)
    assert.match(textOf(mixedCardBatch), new RegExp(deniedProject.id))

    const deniedCards = await client.callTool({
      name: 'list_cards',
      arguments: { projectId: deniedProject.id, limit: 100, offset: 0 }
    })
    assert.equal(deniedCards.isError, true)
    assert.match(textOf(deniedCards), new RegExp(deniedProject.id))

    const scopedTag = mirroredValue<{ id: string }>(await client.callTool({
      name: 'create_tag',
      arguments: {
        projectId: allowedProject.id,
        name: 'scoped',
        color: '#654321'
      }
    }))
    mirroredValue(await client.callTool({
      name: 'delete_tag',
      arguments: { id: scopedTag.id }
    }))

    const sprint = mirroredValue<{ id: string }>(await client.callTool({
      name: 'create_sprint',
      arguments: { projectId: allowedProject.id, name: 'Scoped Sprint' }
    }))
    for (const name of [
      'start_sprint',
      'deactivate_sprint',
      'start_sprint',
      'complete_sprint',
      'reopen_sprint'
    ]) {
      const transitioned = await client.callTool({
        name,
        arguments: { id: sprint.id }
      })
      assert.equal(transitioned.isError, undefined, `${name}: ${textOf(transitioned)}`)
      mirroredValue(transitioned)
    }

    const projectsResource = await client.readResource({
      uri: 'agents-board://projects'
    })
    const projectsMarkdown = projectsResource.contents.find(
      content => 'text' in content
    )?.text ?? ''
    assert.match(projectsMarkdown, /Allowed Project/)
    assert.doesNotMatch(projectsMarkdown, /Denied Project/)

    const deniedCardResource = await client.readResource({
      uri: `agents-board://card/${deniedCard.key}`
    })
    assert.match(
      deniedCardResource.contents.find(content => 'text' in content)?.text ?? '',
      /not found/
    )
    const allowedBlob = await client.readResource({
      uri: `attachment://${allowedAttachment.id}`
    })
    assert.equal(
      allowedBlob.contents.find(content => 'blob' in content)?.blob,
      Buffer.from([1, 2, 3]).toString('base64')
    )
    const deniedBlob = await client.readResource({
      uri: `attachment://${deniedAttachment.id}`
    })
    assert.match(
      deniedBlob.contents.find(content => 'text' in content)?.text ?? '',
      /not found/
    )

    const sessionId = harness.sessionId!
    const otherBearer = await harness.issueBearer({
      projectIds: [deniedProject.id]
    })
    const stolenSession = await sessionRequest(
      harness,
      sessionId,
      otherBearer.token
    )
    assert.equal(stolenSession.status, 404)
    await client.ping()

    await setAuthEnabled(harness.db, false)
    try {
      const changedAuthMode = await sessionRequest(harness, sessionId)
      assert.equal(changedAuthMode.status, 404)
    } finally {
      await setAuthEnabled(harness.db, true)
    }
    await client.ping()
  })
})

function mirroredValue<T>(result: ToolResult) {
  const text = textOf(result)
  const parsed = JSON.parse(text) as unknown
  assert.deepEqual(result.structuredContent, { value: parsed })
  return parsed as T
}

function textOf(result: ToolResult) {
  return result.content.find(content => content.type === 'text')?.text ?? ''
}

function initializeRequest(harness: McpHttpHarness, bearerToken?: string) {
  return harness.fetch('/mcp', {
    method: 'POST',
    headers: {
      'Accept': 'application/json, text/event-stream',
      ...(bearerToken ? { Authorization: `Bearer ${bearerToken}` } : {}),
      'Content-Type': 'application/json'
    },
    body: JSON.stringify({
      jsonrpc: '2.0',
      id: 1,
      method: 'initialize',
      params: {
        capabilities: {},
        clientInfo: { name: 'raw-contract-test', version: '1.0.0' },
        protocolVersion: '2025-11-25'
      }
    })
  })
}

function sessionRequest(
  harness: McpHttpHarness,
  sessionId: string,
  bearerToken?: string
) {
  return harness.fetch('/mcp', {
    method: 'POST',
    headers: {
      'Accept': 'application/json, text/event-stream',
      ...(bearerToken ? { Authorization: `Bearer ${bearerToken}` } : {}),
      'Content-Type': 'application/json',
      'Mcp-Session-Id': sessionId
    },
    body: JSON.stringify({ jsonrpc: '2.0', id: 2, method: 'ping' })
  })
}
