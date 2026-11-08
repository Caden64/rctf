import { createHash, timingSafeEqual } from 'node:crypto'

/**
 * Constant-time bearer token helpers for the Firecracker controller.
 *
 * Both sides are hashed with SHA-256 first so `timingSafeEqual` always compares
 * fixed-length buffers (it throws on different lengths), so the comparison
 * itself does not depend on where the tokens differ. Hashing time still scales
 * with the length of the presented token, which does not reveal the secret.
 */

export const hashToken = (token: string): Buffer =>
  createHash('sha256').update(token, 'utf8').digest()

export const constantTimeTokenEqual = (
  presented: string,
  expected: string
): boolean => {
  const presentedHash = hashToken(presented)
  const expectedHash = hashToken(expected)
  return timingSafeEqual(presentedHash, expectedHash)
}

/** Extract the token from an `Authorization: Bearer <token>` header. */
export const extractBearerToken = (header: string | null): string | null => {
  if (header === null) {
    return null
  }

  const match = /^Bearer[ \t]+(.+)$/i.exec(header.trim())
  const token = match?.[1]?.trim()
  if (!token) {
    return null
  }

  return token
}

/** A configured token must be non-empty; an empty token is a startup error. */
export const assertTokenConfigured = (name: string, token: string): void => {
  if (typeof token !== 'string' || token.trim().length === 0) {
    throw new Error(
      `Firecracker controller: ${name} must be configured with a non-empty token`
    )
  }
}

/** True when the request carries the expected bearer token. */
export const isAuthorized = (req: Request, expectedToken: string): boolean => {
  const presented = extractBearerToken(req.headers.get('authorization'))
  if (presented === null) {
    return false
  }
  return constantTimeTokenEqual(presented, expectedToken)
}
