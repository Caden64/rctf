import type { AgentClient } from '../interfaces'
import type { HostConfig } from './config'

/** Owner: track 5. STUB — replace the body, keep the signature. */
export class HttpAgentClient implements AgentClient {
  constructor(
    readonly config: HostConfig,
    _opts?: { timeoutMs?: number; fetch?: typeof fetch }
  ) {
    this.hostId = config.id
    throw new Error('HttpAgentClient: not implemented')
  }
  readonly hostId: string
  info(): never {
    throw new Error('not implemented')
  }
  list(): never {
    throw new Error('not implemented')
  }
  create(): never {
    throw new Error('not implemented')
  }
  get(): never {
    throw new Error('not implemented')
  }
  extend(): never {
    throw new Error('not implemented')
  }
  delete(): never {
    throw new Error('not implemented')
  }
}
