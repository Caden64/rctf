import { describe, expect, test } from 'bun:test'
import { FirecrackerApi, scrubSecrets } from '../../src/agent/vm/api'

const CANARY = 'flag{api-error-canary-do-not-leak}'

const jsonResponse = (status: number, body: string): Response =>
  new Response(body, {
    status,
    headers: { 'content-type': 'application/json' },
  })

describe('FirecrackerApi error hygiene', () => {
  test('never includes the echoed body for PUT /mmds', async () => {
    const fakeFetch = (async () =>
      jsonResponse(400, `bad metadata: ${CANARY}`)) as unknown as typeof fetch
    const api = new FirecrackerApi('/tmp/unused.sock', {
      timeoutMs: 100,
      fetch: fakeFetch,
    })
    let message = ''
    try {
      await api.put('/mmds', {
        rctf: { flags: [{ provider: 'x', flag: CANARY }] },
      })
    } catch (err) {
      message = err instanceof Error ? err.message : String(err)
    }
    expect(message).toContain('HTTP 400')
    expect(message).not.toContain(CANARY)
    expect(message).not.toContain('flags')
  })

  test('never includes a fetch exception message for PUT /mmds', async () => {
    const fakeFetch = (async () => {
      throw new Error(`connect ECONNREFUSED while sending ${CANARY}`)
    }) as unknown as typeof fetch
    const api = new FirecrackerApi('/tmp/unused.sock', {
      timeoutMs: 100,
      fetch: fakeFetch,
    })
    let message = ''
    try {
      await api.put('/mmds', { flag: CANARY })
    } catch (err) {
      message = err instanceof Error ? err.message : String(err)
    }
    expect(message).toContain('request failed')
    expect(message).not.toContain(CANARY)
  })

  test('scrubs and truncates non-sensitive response bodies', async () => {
    const fakeFetch = (async () =>
      jsonResponse(
        500,
        `${CANARY} ${'x'.repeat(2000)}`
      )) as unknown as typeof fetch
    const api = new FirecrackerApi('/tmp/unused.sock', {
      timeoutMs: 100,
      fetch: fakeFetch,
    })
    let message = ''
    try {
      await api.put('/boot-source', { kernel_image_path: '/vmlinux' })
    } catch (err) {
      message = err instanceof Error ? err.message : String(err)
    }
    expect(message).toContain('HTTP 500')
    expect(message).not.toContain(CANARY)
    expect(message).toContain('<redacted>')
    expect(message.length).toBeLessThan(700)
  })

  test('scrubSecrets leaves ordinary text alone', () => {
    expect(scrubSecrets('plain failure')).toBe('plain failure')
    expect(scrubSecrets(`x ${CANARY} y`)).toBe('x flag{<redacted>} y')
  })
})
