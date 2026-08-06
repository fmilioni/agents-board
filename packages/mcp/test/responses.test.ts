import assert from 'node:assert/strict'
import { describe, it } from 'node:test'

import { serverInstructions } from '../src/create-server'
import { asJson, pageEnvelope } from '../src/tools/index'

describe('MCP server guidance', () => {
  it('makes scope, focused reads, and mutation safety self-contained early', () => {
    const opening = serverInstructions.slice(0, 512).toLowerCase()

    assert.ok(serverInstructions.length <= 700)
    assert.match(opening, /project scope/)
    assert.match(opening, /focused, paginated reads/)
    assert.match(opening, /mutations change shared project state/)
  })
})

describe('MCP JSON results', () => {
  it('preserves a simple legacy object and mirrors it under value', () => {
    assertJsonResult({ id: 'crd_1', status: 'review' })
  })

  it('preserves the paginated envelope', () => {
    assertJsonResult(pageEnvelope('cards', [{ id: 1 }, { id: 2 }], 1, 20))
  })

  it('preserves null', () => {
    assertJsonResult(null)
  })

  it('preserves an error represented as data', () => {
    assertJsonResult({ error: 'not_found', cardKey: 'AB-999' })
  })

  it('uses the JSON representation for non-JSON runtime values', () => {
    const result = asJson({ createdAt: new Date('2026-08-05T12:00:00.000Z') })

    assert.deepEqual(result.structuredContent, {
      value: { createdAt: '2026-08-05T12:00:00.000Z' }
    })
  })
})

function assertJsonResult(value: unknown) {
  const result = asJson(value)

  assert.equal(result.content[0]?.text, JSON.stringify(value))
  assert.deepEqual(result.structuredContent, { value })
  assert.deepEqual(JSON.parse(result.content[0]?.text ?? ''), value)
}
