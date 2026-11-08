/**
 * HTTP client for one host agent (see `agent-protocol.ts`).
 *
 * Every response body is validated with the shared zod schemas. Transport
 * failures, timeouts and 5xx responses become `AgentUnreachableError` (the
 * host may be down; a request may or may not have been applied). A well-formed
 * `agentError` body becomes `AgentRejectedError` with its stable code.
 *
 * Request bodies can contain flags: they are never logged here.
 */
import * as z from 'zod/mini'
import {
  agentErrorSchema,
  agentInfoSchema,
  agentInstanceSchema,
  agentInstanceSpecSchema,
  type AgentInfo,
  type AgentInstance,
  type AgentInstanceSpec,
  type ErrorCode,
} from '@rctf/firecracker-protocol'
import {
  AgentRejectedError,
  AgentUnreachableError,
  type AgentClient,
} from '../interfaces'
import type { HostConfig } from './config'

const DEFAULT_TIMEOUT_MS = 10_000
const CREATE_TIMEOUT_MS = 30_000

type AgentFetch = (
  input: string,
  init?: RequestInit & { tls?: { ca?: string } }
) => Promise<Response>

type CallResult =
  | { kind: 'ok'; status: number; text: string }
  | { kind: 'notFound' }

interface IssueLike {
  path: readonly PropertyKey[]
  message: string
}

const issueMessage = (error: { issues: readonly IssueLike[] }): string =>
  error.issues
    .map(issue =>
      issue.path.length > 0
        ? `${issue.path.join('.')}: ${issue.message}`
        : issue.message
    )
    .join('; ')

export class HttpAgentClient implements AgentClient {
  readonly hostId: string
  private readonly baseUrl: string
  private readonly fetchImpl: AgentFetch
  private readonly timeoutMs: number
  private readonly timeoutOverride: number | undefined

  constructor(
    readonly config: HostConfig,
    opts?: { timeoutMs?: number; fetch?: typeof fetch }
  ) {
    this.hostId = config.id
    this.baseUrl = config.url.replace(/\/+$/, '')
    this.fetchImpl = (opts?.fetch ?? fetch) as unknown as AgentFetch
    this.timeoutOverride = opts?.timeoutMs
    this.timeoutMs = opts?.timeoutMs ?? DEFAULT_TIMEOUT_MS
  }

  private async call(
    method: string,
    path: string,
    body: unknown,
    timeoutMs: number
  ): Promise<CallResult> {
    const url = `${this.baseUrl}${path}`
    const headers: Record<string, string> = { Accept: 'application/json' }
    if (this.config.token !== undefined && this.config.token !== '') {
      headers.Authorization = `Bearer ${this.config.token}`
    }
    const init: RequestInit & { tls?: { ca?: string } } = {
      method,
      headers,
      signal: AbortSignal.timeout(timeoutMs),
    }
    if (body !== undefined) {
      headers['Content-Type'] = 'application/json'
      init.body = JSON.stringify(body)
    }
    if (this.config.caCertificate !== undefined) {
      init.tls = { ca: this.config.caCertificate }
    }

    let response: Response
    try {
      response = await this.fetchImpl(url, init)
    } catch (error) {
      if (
        error instanceof Error &&
        (error.name === 'TimeoutError' || error.name === 'AbortError')
      ) {
        throw new AgentUnreachableError(
          this.hostId,
          `agent request timed out after ${timeoutMs}ms`
        )
      }
      throw new AgentUnreachableError(
        this.hostId,
        `agent request failed: ${
          error instanceof Error ? error.message : String(error)
        }`
      )
    }

    if (response.status === 404) {
      // Drain the body so the connection can be reused.
      await response.text().catch(() => '')
      return { kind: 'notFound' }
    }

    let text: string
    try {
      text = await response.text()
    } catch (error) {
      throw new AgentUnreachableError(
        this.hostId,
        `failed reading agent response: ${
          error instanceof Error ? error.message : String(error)
        }`
      )
    }

    if (!response.ok) {
      const parsed = this.parseError(text)
      if (parsed !== null) {
        throw new AgentRejectedError(this.hostId, parsed.code, parsed.message)
      }
      if (response.status >= 500) {
        throw new AgentUnreachableError(
          this.hostId,
          `agent returned HTTP ${response.status}`
        )
      }
      throw new AgentRejectedError(
        this.hostId,
        'internal',
        `agent returned HTTP ${response.status}`
      )
    }

    return { kind: 'ok', status: response.status, text }
  }

  private parseError(
    text: string
  ): { code: ErrorCode; message: string } | null {
    let json: unknown
    try {
      json = JSON.parse(text)
    } catch {
      return null
    }
    const parsed = agentErrorSchema.safeParse(json)
    return parsed.success
      ? { code: parsed.data.code, message: parsed.data.message }
      : null
  }

  private parseSuccess<T>(
    text: string,
    schema: z.ZodMiniType<T> | z.ZodMiniType<T[]>
  ): T {
    let json: unknown
    try {
      json = JSON.parse(text)
    } catch {
      throw new AgentRejectedError(
        this.hostId,
        'internal',
        'agent returned malformed JSON'
      )
    }
    const parsed = (schema as z.ZodMiniType<T>).safeParse(json)
    if (!parsed.success) {
      throw new AgentRejectedError(
        this.hostId,
        'internal',
        `agent returned an invalid response: ${issueMessage(parsed.error)}`
      )
    }
    return parsed.data
  }

  async info(): Promise<AgentInfo> {
    const result = await this.call('GET', '/v1/info', undefined, this.timeoutMs)
    if (result.kind === 'notFound') {
      throw new AgentUnreachableError(this.hostId, 'agent /v1/info not found')
    }
    return this.parseSuccess(result.text, agentInfoSchema)
  }

  async list(): Promise<AgentInstance[]> {
    const result = await this.call(
      'GET',
      '/v1/instances',
      undefined,
      this.timeoutMs
    )
    if (result.kind === 'notFound') {
      throw new AgentUnreachableError(
        this.hostId,
        'agent /v1/instances not found'
      )
    }
    return this.parseSuccess<AgentInstance[]>(
      result.text,
      z.array(agentInstanceSchema)
    )
  }

  async create(spec: AgentInstanceSpec): Promise<AgentInstance> {
    // Validate locally before sending so a bad caller is caught here, not as
    // an opaque 400. Flags stay in memory only.
    const parsedSpec = agentInstanceSpecSchema.safeParse(spec)
    if (!parsedSpec.success) {
      throw new AgentRejectedError(
        this.hostId,
        'invalid_request',
        `invalid instance spec: ${issueMessage(parsedSpec.error)}`
      )
    }
    const result = await this.call(
      'PUT',
      `/v1/instances/${encodeURIComponent(spec.id)}`,
      parsedSpec.data,
      this.timeoutOverride ?? CREATE_TIMEOUT_MS
    )
    if (result.kind === 'notFound') {
      throw new AgentRejectedError(
        this.hostId,
        'not_found',
        'agent create endpoint not found'
      )
    }
    return this.parseSuccess(result.text, agentInstanceSchema)
  }

  async get(id: string): Promise<AgentInstance | undefined> {
    const result = await this.call(
      'GET',
      `/v1/instances/${encodeURIComponent(id)}`,
      undefined,
      this.timeoutMs
    )
    if (result.kind === 'notFound') return undefined
    return this.parseSuccess(result.text, agentInstanceSchema)
  }

  async extend(id: string, expiresAtMs: number): Promise<AgentInstance> {
    const result = await this.call(
      'PATCH',
      `/v1/instances/${encodeURIComponent(id)}`,
      { expiresAtMs },
      this.timeoutMs
    )
    if (result.kind === 'notFound') {
      throw new AgentRejectedError(
        this.hostId,
        'not_found',
        'instance not found on agent'
      )
    }
    return this.parseSuccess(result.text, agentInstanceSchema)
  }

  async delete(id: string): Promise<void> {
    const result = await this.call(
      'DELETE',
      `/v1/instances/${encodeURIComponent(id)}`,
      undefined,
      this.timeoutMs
    )
    if (result.kind === 'notFound') return
    // Teardown is confirmed by the status. Older/newer agents may return an
    // empty body or the instance record; an unparseable body must not undo a
    // successful teardown.
    if (result.text.trim() === '') return
    try {
      agentInstanceSchema.safeParse(JSON.parse(result.text))
    } catch {
      // ignore: DELETE succeeded, the body is informational only
    }
  }
}
