import { describe, expect, it } from 'vitest'

import {
  resolveCommitTokenSecret,
  signCommitToken,
  verifyCommitToken
} from '../src/commitToken'

const SECRET = 'test-secret'

describe('commitToken', () => {
  it('verifies a fresh token for its own card', () => {
    const { token } = signCommitToken('AB-42', SECRET)
    expect(verifyCommitToken(token, 'AB-42', SECRET)).toBe(true)
  })

  it('rejects a token presented for a different card', () => {
    const { token } = signCommitToken('AB-42', SECRET)
    expect(verifyCommitToken(token, 'AB-43', SECRET)).toBe(false)
  })

  it('rejects an expired token', () => {
    const now = 1_000_000_000_000
    const { token } = signCommitToken('AB-42', SECRET, 600, now)
    expect(verifyCommitToken(token, 'AB-42', SECRET, now + 601_000)).toBe(false)
    expect(verifyCommitToken(token, 'AB-42', SECRET, now + 599_000)).toBe(true)
  })

  it('rejects a token signed with a different secret', () => {
    const { token } = signCommitToken('AB-42', SECRET)
    expect(verifyCommitToken(token, 'AB-42', 'other-secret')).toBe(false)
  })

  it('rejects a tampered payload', () => {
    const { token } = signCommitToken('AB-42', SECRET)
    const [version, payload, sig] = token.split('.')
    const mutated = payload!.slice(0, -1) + (payload!.endsWith('A') ? 'B' : 'A')
    expect(verifyCommitToken(`${version}.${mutated}.${sig}`, 'AB-42', SECRET)).toBe(
      false
    )
  })

  it('rejects malformed tokens', () => {
    for (const bad of ['', 'garbage', 'v1.only-two', 'v2.a.b']) {
      expect(verifyCommitToken(bad, 'AB-42', SECRET)).toBe(false)
    }
  })

  it('exposes an ISO expiry consistent with the TTL', () => {
    const now = 1_000_000_000_000
    const { expiresAt } = signCommitToken('AB-42', SECRET, 600, now)
    expect(new Date(expiresAt).getTime()).toBe(now + 600_000)
  })

  it('prefers the dedicated secret, falls back to better-auth, else null', () => {
    expect(
      resolveCommitTokenSecret({
        AB_COMMIT_TOKEN_SECRET: 'dedicated',
        BETTER_AUTH_SECRET: 'fallback'
      })
    ).toBe('dedicated')
    expect(
      resolveCommitTokenSecret({ BETTER_AUTH_SECRET: 'fallback' })
    ).toBe('fallback')
    expect(resolveCommitTokenSecret({})).toBeNull()
  })
})
