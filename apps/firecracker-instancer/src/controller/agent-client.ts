/**
 * HTTP client for one host agent (see `agent-protocol.ts`).
 *
 * Every response body is validated with the shared zod schemas. Transport
 * failures and timeouts become `AgentUnreachableError`.
 *
 * Error classification is deliberately conservative:
 * - `create` treats only the documented pre-create rejections (`no_capacity`,
 *   `draining`, `invalid_request`, `unauthorized` with matching statuses) as
 *   `AgentRejectedError`. A 5xx, `internal`, `host_unavailable`,
 *   `spec_mismatch`, `conflict`, a malformed 2xx, or any other error is
 *   AMBIGUOUS: the PUT may still create the VM, so `AgentUnreachableError` is
 *   thrown and the controller keeps the row in `creating` for the reconciler.
 * - Other calls map 4xx `agentError` bodies to `AgentRejectedError` and 5xx or
 *   unrecognised failures to `AgentUnreachableError` (a failed GET must never
 *   make the controller delete a row).
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
  | {
      kind: 'error'
      status: number
      /** Stable code from a well-formed agentError body, if any. */
      code: ErrorCode | null
      message: string
    }

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

/** The only agent responses that prove a create did NOT happen. */
export const isDefinitiveCreateRejection = (
  status: number,
  code: ErrorCode | null
): boolean =>
  (status === 507 && code === 'no_capacity') ||
  (status === 503 && code === 'draining') ||
  (status === 400 && code === 'invalid_request') ||
  (status === 401 && code === 'unauthorized')

/** Errors that confirm an id is gone (DELETE/GET 404 or an expired row). */
export const isConfirmedGone = (error: unknown): boolean =>
  error instanceof AgentRejectedError &&
  (error.code === 'not_found' || error.code === 'expired')

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
      return {
        kind: 'error',
        status: response.status,
        code: parsed?.code ?? null,
        message:
          parsed?.message ??
          `agent returned HTTP ${response.status}${
            text.trim() === '' ? '' : `: ${text.slice(0, 200)}`
          }`,
      }
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

  private rejectNonCreate(
    error: Extract<CallResult, { kind: 'error' }>
  ): never {
    if (error.status >= 500 || error.code === null) {
      throw new AgentUnreachableError(this.hostId, error.message)
    }
    throw new AgentRejectedError(this.hostId, error.code, error.message)
  }

  private rejectCreate(error: Extract<CallResult, { kind: 'error' }>): never {
    if (isDefinitiveCreateRejection(error.status, error.code)) {
      throw new AgentRejectedError(
        this.hostId,
        error.code as ErrorCode,
        error.message
      )
    }
    // Ambiguous: the agent may have (or may still) create the instance. Keep
    // the controller row and let the reconciler resolve it with GET/DELETE.
    throw new AgentUnreachableError(this.hostId, error.message)
  }

  private parseSuccess<T>(
    text: string,
    schema: z.ZodMiniType<T> | z.ZodMiniType<T[]>,
    opts: { ambiguous?: boolean } = {}
  ): T {
    const invalid = (message: string): never => {
      if (opts.ambiguous === true) {
        throw new AgentUnreachableError(this.hostId, message)
      }
      throw new AgentRejectedError(this.hostId, 'internal', message)
    }
    let json: unknown
    try {
      json = JSON.parse(text)
    } catch {
      return invalid('agent returned malformed JSON')
    }
    const parsed = (schema as z.ZodMiniType<T>).safeParse(json)
    if (!parsed.success) {
      return invalid(
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
    if (result.kind === 'error') this.rejectNonCreate(result)
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
    if (result.kind === 'error') this.rejectNonCreate(result)
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
      // Ambiguous: an unexpected 404 does not prove the create failed (a proxy
      // or a mid-deploy agent can produce it).
      throw new AgentUnreachableError(
        this.hostId,
        'agent create endpoint not found'
      )
    }
    if (result.kind === 'error') this.rejectCreate(result)
    return this.parseSuccess(result.text, agentInstanceSchema, {
      ambiguous: true,
    })
  }

  async get(id: string): Promise<AgentInstance | undefined> {
    const result = await this.call(
      'GET',
      `/v1/instances/${encodeURIComponent(id)}`,
      undefined,
      this.timeoutMs
    )
    if (result.kind === 'notFound') return undefined
    if (result.kind === 'error') this.rejectNonCreate(result)
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
    if (result.kind === 'error') this.rejectNonCreate(result)
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
    if (result.kind === 'error') this.rejectNonCreate(result)
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
