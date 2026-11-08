/**
 * Tiny TCP fault-injection proxy used by the ambiguous-create scenario.
 *
 * It sits between the controller and the real agent and is transparent unless a
 * fault is armed for the next `PUT /v1/instances/:id`:
 *
 *   drop-response  forward the create to the agent, wait for the complete
 *                  response, then close the controller connection without
 *                  relaying it. The VM *does* exist: the controller's create is
 *                  ambiguous and the reconciler must adopt it.
 *   hold-request   capture the create request (never forward it), then close the
 *                  controller connection. Nothing was created, so the
 *                  controller must fence the id after `createFenceSeconds`; the
 *                  captured request can be replayed later to prove the agent
 *                  tombstone rejects it.
 *
 * Every request is forwarded with `Connection: close`, so the proxy never has
 * to frame more than one request per connection. That is the only visible
 * difference from a direct connection; the controller's HTTP client simply
 * opens a new connection per call.
 */
import net from 'node:net'

export type CreateFault = 'drop-response' | 'hold-request'

export interface CapturedRequest {
  id: string
  method: string
  target: string
  headers: Record<string, string>
  body: Buffer
}

interface RequestFrame {
  head: string
  body: Buffer
  method: string
  target: string
  headers: Record<string, string>
}

const parseRequest = (buffer: Buffer): RequestFrame | undefined => {
  const headEnd = buffer.indexOf('\r\n\r\n')
  if (headEnd === -1) return undefined
  const head = buffer.subarray(0, headEnd).toString('latin1')
  const lines = head.split('\r\n')
  const requestLine = lines.shift() ?? ''
  const [method, target] = requestLine.split(' ')
  if (method === undefined || target === undefined) return undefined
  const headers: Record<string, string> = {}
  for (const line of lines) {
    const colon = line.indexOf(':')
    if (colon <= 0) continue
    headers[line.slice(0, colon).trim().toLowerCase()] = line
      .slice(colon + 1)
      .trim()
  }
  const contentLength = Number(headers['content-length'] ?? 0)
  if (!Number.isFinite(contentLength) || contentLength < 0) return undefined
  const total = headEnd + 4 + contentLength
  if (buffer.length < total) return undefined
  return {
    head,
    body: buffer.subarray(headEnd + 4, total),
    method,
    target,
    headers,
  }
}

const headerMap = (head: string): Record<string, string> => {
  const headers: Record<string, string> = {}
  for (const line of head.split('\r\n').slice(1)) {
    const colon = line.indexOf(':')
    if (colon <= 0) continue
    headers[line.slice(0, colon).trim().toLowerCase()] = line
      .slice(colon + 1)
      .trim()
  }
  return headers
}

/** Rewrite the request head to ask the upstream to close after responding. */
const withConnectionClose = (head: string): string => {
  const lines = head.split('\r\n')
  const kept = lines.filter(
    (line, index) => index === 0 || !/^connection\s*:/i.test(line)
  )
  kept.push('Connection: close')
  return `${kept.join('\r\n')}\r\n\r\n`
}

const idFromTarget = (target: string): string | undefined => {
  const match = /^\/v1\/instances\/([^/?]+)/.exec(target)
  return match?.[1]
}

export class FaultProxy {
  private server: net.Server | undefined
  private fault: CreateFault | null = null
  private readonly sockets = new Set<net.Socket>()
  readonly captured: CapturedRequest[] = []
  readonly forwardedCreateIds: string[] = []

  constructor(
    private readonly listenPort: number,
    private readonly upstreamHost: string,
    private readonly upstreamPort: number
  ) {}

  /** Arm a one-shot fault for the next create request. */
  arm(fault: CreateFault): void {
    this.fault = fault
  }

  disarm(): void {
    this.fault = null
  }

  async start(): Promise<void> {
    const server = net.createServer(socket => this.onConnection(socket))
    server.on('error', error => {
      console.error(`proxy server error: ${error.message}`)
    })
    await new Promise<void>((resolve, reject) => {
      server.once('error', reject)
      server.listen(this.listenPort, '127.0.0.1', () => resolve())
    })
    this.server = server
  }

  async stop(): Promise<void> {
    for (const socket of this.sockets) socket.destroy()
    this.sockets.clear()
    const server = this.server
    this.server = undefined
    if (server === undefined) return
    await new Promise<void>(resolve => server.close(() => resolve()))
  }

  private onConnection(client: net.Socket): void {
    this.sockets.add(client)
    client.setNoDelay(true)
    let buffer = Buffer.alloc(0)
    let handled = false
    const deadline = setTimeout(() => client.destroy(), 90_000)
    if (typeof deadline.unref === 'function') deadline.unref()

    const onClose = (): void => {
      clearTimeout(deadline)
      this.sockets.delete(client)
    }
    client.on('close', onClose)
    client.on('error', () => client.destroy())

    const onData = (chunk: Buffer): void => {
      if (handled) return
      buffer = Buffer.concat([buffer, chunk])
      const frame = parseRequest(buffer)
      if (frame === undefined) return
      handled = true
      client.removeListener('data', onData)
      const fault = this.fault
      if (
        fault !== null &&
        frame.method === 'PUT' &&
        idFromTarget(frame.target) !== undefined
      ) {
        this.fault = null
        const id = idFromTarget(frame.target) as string
        if (fault === 'hold-request') {
          this.captured.push({
            id,
            method: frame.method,
            target: frame.target,
            headers: headerMap(frame.head),
            body: Buffer.from(frame.body),
          })
          // Nothing reaches the agent; the controller sees a transport error.
          client.destroy()
          return
        }
        this.forwardedCreateIds.push(id)
        void this.forward(frame, client, { discardResponse: true })
        return
      }
      void this.forward(frame, client, { discardResponse: false })
    }

    client.on('data', onData)
  }

  private forward(
    frame: RequestFrame,
    client: net.Socket,
    options: { discardResponse: boolean }
  ): Promise<void> {
    return new Promise(resolve => {
      const upstream = net.connect(this.upstreamPort, this.upstreamHost)
      this.sockets.add(upstream)
      let settled = false
      const finish = (): void => {
        if (settled) return
        settled = true
        this.sockets.delete(upstream)
        upstream.destroy()
        resolve()
      }
      upstream.setNoDelay(true)
      upstream.on('error', () => {
        finish()
        client.destroy()
      })
      upstream.on('close', () => {
        finish()
        // The upstream was asked to close: the response is complete.
        if (options.discardResponse) client.destroy()
        else client.end()
      })
      upstream.on('data', chunk => {
        if (!options.discardResponse) client.write(chunk)
      })
      client.on('close', () => {
        finish()
      })
      upstream.on('connect', () => {
        const head = withConnectionClose(frame.head)
        upstream.write(Buffer.concat([Buffer.from(head, 'latin1'), frame.body]))
      })
    })
  }
}
