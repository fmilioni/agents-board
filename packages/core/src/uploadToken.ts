import { signScopedToken, verifyScopedToken } from './signedToken'

// Project-scoped image-upload token (attach-image): the same scope binding over
// the generic signed token that the commit token uses, so a token minted for one
// purpose is never accepted by the other. The MCP signs it from an authorized
// OAuth session; the API verifies it on the upload route alone.
export function signUploadToken(
  projectId: string,
  secret: string,
  ttlSeconds?: number,
  now?: number
): { token: string, expiresAt: string } {
  return signScopedToken('upload', projectId, secret, ttlSeconds, now)
}

export function verifyUploadToken(
  token: string,
  expectedProjectId: string,
  secret: string,
  now?: number
): boolean {
  return verifyScopedToken('upload', token, expectedProjectId, secret, now)
}
