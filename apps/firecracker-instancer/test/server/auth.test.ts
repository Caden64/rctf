import { describe, expect, test } from 'bun:test'
import {
  assertTokenConfigured,
  constantTimeTokenEqual,
  extractBearerToken,
  hashToken,
  isAuthorized,
} from '../../src/controller/auth'

describe('constantTimeTokenEqual', () => {
  test('accepts identical tokens', () => {
    expect(constantTimeTokenEqual('rctf-token', 'rctf-token')).toBe(true)
  })

  test('rejects different tokens of the same length', () => {
    expect(constantTimeTokenEqual('rctf-token', 'rctf-tokeN')).toBe(false)
  })

  test('rejects tokens of different lengths without throwing', () => {
    expect(() =>
      constantTimeTokenEqual('short', 'a-much-longer-token')
    ).not.toThrow()
    expect(constantTimeTokenEqual('short', 'a-much-longer-token')).toBe(false)
    expect(constantTimeTokenEqual('', 'non-empty')).toBe(false)
  })

  test('hashes to a fixed-size digest', () => {
    expect(hashToken('a').length).toBe(32)
    expect(hashToken('a'.repeat(10_000)).length).toBe(32)
  })
})

describe('extractBearerToken', () => {
  test('parses bearer headers case-insensitively', () => {
    expect(extractBearerToken('Bearer abc')).toBe('abc')
    expect(extractBearerToken('bearer abc')).toBe('abc')
    expect(extractBearerToken('Bearer   abc   ')).toBe('abc')
  })

  test('rejects missing and malformed headers', () => {
    expect(extractBearerToken(null)).toBeNull()
    expect(extractBearerToken('Basic abc')).toBeNull()
    expect(extractBearerToken('Bearer')).toBeNull()
    expect(extractBearerToken('Bearer    ')).toBeNull()
    expect(extractBearerToken('')).toBeNull()
  })
})

describe('isAuthorized', () => {
  const request = (authorization?: string): Request =>
    new Request('http://localhost/healthz', {
      headers: authorization === undefined ? {} : { authorization },
    })

  test('accepts the configured token', () => {
    expect(isAuthorized(request('Bearer secret'), 'secret')).toBe(true)
  })

  test('rejects absent or wrong tokens', () => {
    expect(isAuthorized(request(), 'secret')).toBe(false)
    expect(isAuthorized(request('Bearer nope'), 'secret')).toBe(false)
  })
})

describe('assertTokenConfigured', () => {
  test('rejects missing and whitespace-only tokens', () => {
    expect(() => assertTokenConfigured('authToken', '')).toThrow(/non-empty/)
    expect(() => assertTokenConfigured('authToken', '   ')).toThrow(/non-empty/)
  })

  test('accepts a normal token', () => {
    expect(() => assertTokenConfigured('authToken', 'secret')).not.toThrow()
  })
})
