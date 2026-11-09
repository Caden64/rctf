/** Thin client for the Firecracker control API over its unix socket (Bun `fetch`). */

export class VmApiError extends Error {
  constructor(
    readonly method: string,
    readonly apiPath: string,
    message: string
  ) {
    super(`${method} ${apiPath}: ${message}`)
    this.name = 'VmApiError'
  }
}

export interface FirecrackerApiOptions {
  timeoutMs: number
  fetch?: typeof fetch
}

/** Requests whose body carries secrets (guest metadata / flags). */
const SENSITIVE_PATHS: ReadonlySet<string> = new Set(['/mmds'])
const MAX_DETAIL = 512

/** Remove anything that looks like a flag before it reaches an error or log. */
export const scrubSecrets = (text: string): string =>
  text.replace(/(?:flag|rctf)\{[^}]*\}/gi, match => {
    const brace = match.indexOf('{')
    return `${match.slice(0, brace + 1)}<redacted>}`
  })

const detail = (text: string): string => {
  const scrubbed = scrubSecrets(text).trim()
  return scrubbed.length > MAX_DETAIL
    ? `${scrubbed.slice(0, MAX_DETAIL)}…`
    : scrubbed
}

export class FirecrackerApi {
  readonly #socket: string
  readonly #timeoutMs: number
  readonly #fetch: typeof fetch

  constructor(socket: string, options: FirecrackerApiOptions) {
    this.#socket = socket
    this.#timeoutMs = options.timeoutMs
    this.#fetch = options.fetch ?? fetch
  }

  /**
   * PUT a JSON document. The request body is never logged or put in an error
   * message: `/mmds` carries the guest metadata (flags). For that request the
   * error is a fixed string (no fetch exception, no response body). Other
   * requests contribute at most a truncated, secret-scrubbed response body.
   */
  async put(apiPath: string, body: unknown): Promise<void> {
    const sensitive = SENSITIVE_PATHS.has(apiPath)
    let response: Response
    try {
      response = await this.#fetch(`http://localhost${apiPath}`, {
        unix: this.#socket,
        method: 'PUT',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(body),
        signal: AbortSignal.timeout(this.#timeoutMs),
      })
    } catch {
      throw new VmApiError('PUT', apiPath, 'request failed')
    }
    if (!response.ok) {
      let text = ''
      try {
        text = await response.text()
      } catch {
        // ignore unreadable error bodies
      }
      if (sensitive) {
        throw new VmApiError('PUT', apiPath, `HTTP ${response.status}`)
      }
      const explanation = detail(text)
      throw new VmApiError(
        'PUT',
        apiPath,
        `HTTP ${response.status}${explanation ? `: ${explanation}` : ''}`
      )
    }
    // Drain the body so the connection can be reused.
    try {
      await response.text()
    } catch {
      // no body / already consumed
    }
  }
}
