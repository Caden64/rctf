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
   * message: `/mmds` carries the guest metadata (flags).
   */
  async put(apiPath: string, body: unknown): Promise<void> {
    let response: Response
    try {
      response = await this.#fetch(`http://localhost${apiPath}`, {
        unix: this.#socket,
        method: 'PUT',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(body),
        signal: AbortSignal.timeout(this.#timeoutMs),
      })
    } catch (err) {
      const reason = err instanceof Error ? err.message : String(err)
      throw new VmApiError('PUT', apiPath, `request failed (${reason})`)
    }
    if (!response.ok) {
      let detail = ''
      try {
        detail = (await response.text()).slice(0, 512)
      } catch {
        // ignore unreadable error bodies
      }
      throw new VmApiError(
        'PUT',
        apiPath,
        `HTTP ${response.status}${detail ? `: ${detail}` : ''}`
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
