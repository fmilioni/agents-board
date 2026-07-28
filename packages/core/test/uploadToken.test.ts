import { describe, expect, it } from 'vitest'

import { signCommitToken } from '../src/commitToken'
import { signUploadToken, verifyUploadToken } from '../src/uploadToken'

const SECRET = 'test-secret'
const PROJECT = 'prj_abc123'

describe('uploadToken', () => {
  it('verifies a fresh token for its own project', () => {
    const { token } = signUploadToken(PROJECT, SECRET)
    expect(verifyUploadToken(token, PROJECT, SECRET)).toBe(true)
  })

  it('rejects a token presented for a different project', () => {
    const { token } = signUploadToken(PROJECT, SECRET)
    expect(verifyUploadToken(token, 'prj_other', SECRET)).toBe(false)
  })

  it('rejects an expired token', () => {
    const now = 1_000_000_000_000
    const { token } = signUploadToken(PROJECT, SECRET, 600, now)
    expect(verifyUploadToken(token, PROJECT, SECRET, now + 601_000)).toBe(false)
    expect(verifyUploadToken(token, PROJECT, SECRET, now + 599_000)).toBe(true)
  })

  it('rejects a token signed with a different secret', () => {
    const { token } = signUploadToken(PROJECT, SECRET)
    expect(verifyUploadToken(token, PROJECT, 'other-secret')).toBe(false)
  })

  it('rejects a tampered payload', () => {
    const { token } = signUploadToken(PROJECT, SECRET)
    const [version, payload, sig] = token.split('.')
    const mutated = payload!.slice(0, -1) + (payload!.endsWith('A') ? 'B' : 'A')
    expect(verifyUploadToken(`${version}.${mutated}.${sig}`, PROJECT, SECRET)).toBe(
      false
    )
  })

  it('rejects a commit token carrying the same value', () => {
    const { token } = signCommitToken(PROJECT, SECRET)
    expect(verifyUploadToken(token, PROJECT, SECRET)).toBe(false)
  })
})
