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
 * - Absence (GET/PATCH/DELETE 404) is only trusted when it is attributable to
 *   the instance: a `not_found` body carrying the requested `instanceId`.
 *   Plain, route-level, mismatched-id and malformed 404s are AMBIGUOUS
 *   (`AgentUnreachableError`). The advertised `instance-absence-v1` capability
 *   only decides whether a marker-less 404 is still acceptable from a legacy
 *   agent; the client probes `/v1/info` before accepting one and treats a
 *   failed probe as ambiguous.
 * - `delete` confirms ownership release ONLY for HTTP 2xx or a verified
 *   instance absence, which is the only outcome that guarantees the agent
 *   wrote its durable tombstone. Every other response (410/`expired`, another
 *   4xx, 5xx, timeout, malformed body) throws, so the caller keeps the row
 *   fenced and retries.
 *
 * Request bodies can contain flags: they are never logged here.
 */
import * as z from 'zod/mini'
import {
  AGENT_CAPABILITY_INSTANCE_ABSENCE,
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
import type { LoadedTlsMaterial } from '../util/tls'
import { resolveHostTls, type HostConfig } from './config'

const DEFAULT_TIMEOUT_MS = 10_000
const CREATE_TIMEOUT_MS = 30_000

type FetchTlsOptions = LoadedTlsMaterial & { rejectUnauthorized?: boolean }

type AgentFetch = (
  input: string,
  init?: RequestInit & { tls?: FetchTlsOptions }
) => Promise<Response>

type CallResult =
  | { kind: 'ok'; status: number; text: string }
  | {
      kind: 'notFound'
      /** Well-formed code/body fields, if the 404 carried one. */
      code: ErrorCode | null
      /** Id echoed by an instance-scoped route (absence discriminator). */
      instanceId: string | null
      message: string
    }
  | {
      kind: 'error'
      status: number
      /** Stable code from a well-formed agentError body, if any. */
      code: ErrorCode | null
      message: string
    }

interface ParsedAgentError {
  code: ErrorCode
  message: string
  instanceId: string | null
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

export class HttpAgentClient implements AgentClient {
  readonly hostId: string
  private readonly baseUrl: string
  private readonly fetchImpl: AgentFetch
  private readonly tls: FetchTlsOptions | undefined
  private readonly timeoutMs: number
  private readonly timeoutOverride: number | undefined
  /** null until an /v1/info response tells us what the agent supports. */
  private capabilities: Set<string> | null = null
  private capabilityProbe: Promise<Set<string>> | null = null

  constructor(
    readonly config: HostConfig,
    opts?: { timeoutMs?: number; fetch?: typeof fetch }
  ) {
    this.hostId = config.id
    this.baseUrl = config.url.replace(/\/+$/, '')
    this.fetchImpl = (opts?.fetch ?? fetch) as unknown as AgentFetch
    // loadControllerConfig already resolved and validated this; resolving a
    // directly-constructed config keeps the same fail-closed behaviour.
    const material = config.tls ?? resolveHostTls(config)
    this.tls =
      material === undefined
        ? this.baseUrl.startsWith('https://')
          ? // No custom trust material, but verification is still forced:
            // every https agent must reject an untrusted server even when
            // the process environment sets NODE_TLS_REJECT_UNAUTHORIZED=0,
            // or the bearer token could be sent to an impostor.
            { rejectUnauthorized: true }
          : undefined
        : // Verify the server certificate even if the process environment sets
          // NODE_TLS_REJECT_UNAUTHORIZED=0.
          { ...material, rejectUnauthorized: true }
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
    const init: RequestInit & { tls?: FetchTlsOptions } = {
      method,
      headers,
      // A create body carries flags: never replay it (or the bearer token's
      // authority) to wherever a redirect points.
      redirect: 'error',
      signal: AbortSignal.timeout(timeoutMs),
    }
    if (body !== undefined) {
      headers['Content-Type'] = 'application/json'
      init.body = JSON.stringify(body)
    }
    if (this.tls !== undefined) {
      init.tls = this.tls
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
      // The body is evidence: only an instance-scoped agentError carries the
      // requested instanceId (see classifyAbsence). Drain it either way.
      const text = await response.text().catch(() => '')
      const parsed = this.parseError(text)
      return {
        kind: 'notFound',
        code: parsed?.code ?? null,
        instanceId: parsed?.instanceId ?? null,
        message:
          parsed?.message ??
          `agent returned HTTP 404${
            text.trim() === '' ? '' : `: ${text.slice(0, 200)}`
          }`,
      }
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

  private parseError(text: string): ParsedAgentError | null {
    let json: unknown
    try {
      json = JSON.parse(text)
    } catch {
      return null
    }
    const parsed = agentErrorSchema.safeParse(json)
    return parsed.success
      ? {
          code: parsed.data.code,
          message: parsed.data.message,
          instanceId: parsed.data.instanceId ?? null,
        }
      : null
  }

  /**
   * Decide whether a 404 is evidence that *this instance* is absent. Only a
   * `not_found` body that echoes the requested id is self-authenticating.
   * Without it, ask the agent whether it advertises the discriminator: a
   * modern agent's marker-less 404 is routing noise (ambiguous), while an
   * agent that predates the capability keeps the old 404-means-absent
   * semantics. A failed probe is always ambiguous (fail closed).
   */
  private async classifyAbsence(
    id: string,
    result: Extract<CallResult, { kind: 'notFound' }>
  ): Promise<void> {
    if (result.instanceId !== null) {
      if (result.instanceId === id && result.code === 'not_found') return
      // Explicitly names another instance (or an unrelated code): never
      // evidence for this one.
      throw new AgentUnreachableError(
        this.hostId,
        `ambiguous 404 for instance ${id}: ${result.message}`
      )
    }

    let capabilities: Set<string>
    try {
      capabilities = await this.advertisedCapabilities()
    } catch (error) {
      throw new AgentUnreachableError(
        this.hostId,
        `cannot verify 404 for instance ${id}: ${
          error instanceof Error ? error.message : String(error)
        }`
      )
    }
    if (capabilities.has(AGENT_CAPABILITY_INSTANCE_ABSENCE)) {
      throw new AgentUnreachableError(
        this.hostId,
        `agent 404 for instance ${id} did not identify the instance`
      )
    }
  }

  /** Cached capabilities, probing /v1/info once when no heartbeat has yet. */
  private async advertisedCapabilities(): Promise<Set<string>> {
    if (this.capabilities !== null) return this.capabilities
    const existing = this.capabilityProbe
    if (existing !== null) return existing
    const probe = this.info().then(info => {
      const capabilities = new Set(info.capabilities ?? [])
      this.capabilities = capabilities
      return capabilities
    })
    this.capabilityProbe = probe
    void probe
      .finally(() => {
        if (this.capabilityProbe === probe) this.capabilityProbe = null
      })
      .catch(() => undefined)
    return probe
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
    const info = this.parseSuccess(result.text, agentInfoSchema)
    this.capabilities = new Set(info.capabilities ?? [])
    return info
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
    if (result.kind === 'notFound') {
      await this.classifyAbsence(id, result)
      return undefined
    }
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
      await this.classifyAbsence(id, result)
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
    if (result.kind === 'notFound') {
      await this.classifyAbsence(id, result)
      return
    }
    if (result.kind === 'error') this.rejectNonCreate(result)
    // Only HTTP 2xx or a verified instance absence confirm a teardown (the
    // agent wrote its tombstone).
    // Older/newer agents may return an empty body or the instance record; a
    // malformed body is NOT confirmation, so the caller keeps the row fenced
    // and retries the DELETE.
    if (result.text.trim() === '') return
    let json: unknown
    try {
      json = JSON.parse(result.text)
    } catch {
      throw new AgentUnreachableError(
        this.hostId,
        'agent returned malformed JSON for DELETE'
      )
    }
    if (!agentInstanceSchema.safeParse(json).success) {
      throw new AgentUnreachableError(
        this.hostId,
        'agent returned an invalid DELETE response'
      )
    }
  }
}
