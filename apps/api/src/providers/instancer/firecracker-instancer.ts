import {
  FIRECRACKER_MACHINE_NAME,
  controllerErrorSchema,
  controllerInstanceDetailsSchema,
  createInstanceRequestSchema,
  extendInstanceRequestSchema,
  exposeEntrySchema,
  firecrackerChallengeConfigSchema,
  instanceKeySchema,
  type ControllerInstanceDetails,
} from '@rctf/firecracker-protocol'
import * as z from 'zod/mini'
import {
  instanceDetailsSchema,
  instancerErrorSchema,
  InstancerProvider,
  type CreateInstanceOptions,
  type ExtendInstanceOptions,
  type instanceDetailsOrError,
  type InstanceQueryOptions,
  type ProviderConfig,
} from './base'

interface FirecrackerInstancerProviderOptions {
  authToken?: string
  apiUrl?: string
  /** Request timeout; overridable for tests. Defaults to 45 seconds. */
  timeoutMilliseconds?: number
}

// Must exceed the controller's agent create timeout (30s) so a slow-but-healthy
// launch (e.g. rootfs copy without reflink) is not reported as a failure.
const DEFAULT_TIMEOUT_MILLISECONDS = 45_000

const REQUEST_FAILED_MESSAGE =
  'Something went wrong while talking to the Firecracker controller'
const TIMEOUT_MESSAGE = 'The Firecracker controller did not respond in time'
const INVALID_RESPONSE_MESSAGE =
  'The Firecracker controller returned an invalid response'

const exposeArraySchema = z.array(exposeEntrySchema)

/**
 * Admin UI schema for the challenge config (same `z.toJSONSchema` call the
 * admin route makes). Exposed so tests can verify it serialises without
 * importing zod through the API app.
 */
export const firecrackerConfigInputJsonSchema = () =>
  z.toJSONSchema(firecrackerChallengeConfigSchema, { io: 'input' })

/**
 * rCTF -> Firecracker controller adapter.
 *
 * Every remote failure (transport, timeout, non-JSON, 4xx/5xx) is surfaced as
 * `{ kind: 'instancerError', message }`; this provider never throws for remote
 * errors. Flags are only ever put in the create request body and are never
 * logged.
 */
export default class FirecrackerInstancerProvider extends InstancerProvider {
  private readonly authToken: string
  private readonly apiUrl: string
  private readonly timeoutMilliseconds: number

  readonly configSchema = firecrackerChallengeConfigSchema
  readonly capabilities = { canStop: true, canExtend: true }

  constructor(_options: unknown) {
    super()
    const options = (_options ?? {}) as FirecrackerInstancerProviderOptions

    const authToken =
      process.env.FIRECRACKER_INSTANCER_AUTH_TOKEN ?? options.authToken
    const apiUrl = process.env.FIRECRACKER_INSTANCER_API_URL ?? options.apiUrl

    if (!authToken || !apiUrl) {
      throw new Error(
        'Missing one of the authToken or apiUrl for the FirecrackerInstancerProvider. ' +
          'Set FIRECRACKER_INSTANCER_AUTH_TOKEN and FIRECRACKER_INSTANCER_API_URL (or the provider options).'
      )
    }

    let parsedUrl: URL
    try {
      parsedUrl = new URL(apiUrl)
    } catch {
      throw new Error('FirecrackerInstancerProvider: apiUrl is not a valid URL')
    }
    if (
      (parsedUrl.protocol !== 'http:' && parsedUrl.protocol !== 'https:') ||
      parsedUrl.username !== '' ||
      parsedUrl.password !== '' ||
      parsedUrl.search !== '' ||
      parsedUrl.hash !== ''
    ) {
      throw new Error(
        'FirecrackerInstancerProvider: apiUrl must be an http(s) URL without credentials, query or fragment'
      )
    }

    this.authToken = authToken
    this.apiUrl = apiUrl.replace(/\/+$/, '')
    this.timeoutMilliseconds =
      options.timeoutMilliseconds !== undefined &&
      Number.isFinite(options.timeoutMilliseconds) &&
      options.timeoutMilliseconds > 0
        ? options.timeoutMilliseconds
        : DEFAULT_TIMEOUT_MILLISECONDS
  }

  /**
   * `image` is required by the challenge config schema, so the admin UI needs a
   * concrete example to start from. `example` is the conventional image name
   * (a directory under the host's imagesDir).
   */
  getDefaults = (): ProviderConfig =>
    this.configSchema.parse({ image: 'example' })

  private error(message: string): instanceDetailsOrError {
    return instancerErrorSchema.parse({ kind: 'instancerError', message })
  }

  private validateExpose(
    expose: CreateInstanceOptions['expose']
  ):
    | { ok: true; expose: z.output<typeof exposeArraySchema> }
    | { ok: false; message: string } {
    if (!Array.isArray(expose) || expose.length === 0) {
      return {
        ok: false,
        message:
          'The challenge must expose at least one port from the Firecracker instance',
      }
    }

    const parsed = exposeArraySchema.safeParse(expose)
    if (!parsed.success) {
      return {
        ok: false,
        message:
          'Invalid expose configuration: expected a supported kind, a DNS label host prefix and a valid port',
      }
    }

    for (const entry of parsed.data) {
      if (entry.containerName !== FIRECRACKER_MACHINE_NAME) {
        return {
          ok: false,
          message: `Invalid expose configuration: containerName must be "${FIRECRACKER_MACHINE_NAME}" for the Firecracker instancer`,
        }
      }
    }

    return { ok: true, expose: parsed.data }
  }

  /**
   * Number of endpoints the controller is expected to return, when known.
   * `InstanceQueryOptions` does not carry `expose`, but callers/tests may pass
   * it at runtime; we honour it then.
   */
  private expectedEndpointCount(options: unknown): number | undefined {
    const expose = (options as { expose?: unknown } | null)?.expose
    if (!Array.isArray(expose)) {
      return undefined
    }
    return expose.length
  }

  private assertEndpointCount(
    details: ControllerInstanceDetails,
    expected: number | undefined
  ): instanceDetailsOrError | undefined {
    if (expected === undefined) {
      return undefined
    }

    // Transitional states (starting/stopping/...) legitimately have no
    // endpoints yet; only a running instance must be complete.
    if (details.status !== 'running') {
      return undefined
    }

    const endpoints = details.endpoints
    if (endpoints === null || endpoints.length !== expected) {
      return this.error(
        `The Firecracker controller returned ${endpoints?.length ?? 0} endpoint(s) for ${expected} exposed port(s)`
      )
    }

    return undefined
  }

  private async apiRequest(
    method: 'POST' | 'PUT' | 'DELETE' | 'PATCH',
    body: unknown,
    expectedEndpointCount: number | undefined
  ): Promise<instanceDetailsOrError> {
    let response: Response
    try {
      response = await fetch(`${this.apiUrl}/v1/instances`, {
        method,
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${this.authToken}`,
        },
        body: JSON.stringify(body),
        // A redirect would replay the flag-bearing body to another origin.
        redirect: 'error',
        signal: AbortSignal.timeout(this.timeoutMilliseconds),
      })
    } catch (err) {
      // NOTE: never log the request body; it contains flags.
      if (
        err instanceof Error &&
        (err.name === 'TimeoutError' || err.name === 'AbortError')
      ) {
        return this.error(TIMEOUT_MESSAGE)
      }
      return this.error(REQUEST_FAILED_MESSAGE)
    }

    let text: string
    try {
      text = await response.text()
    } catch {
      return this.error(REQUEST_FAILED_MESSAGE)
    }

    let payload: unknown
    try {
      payload = JSON.parse(text)
    } catch {
      return this.error(INVALID_RESPONSE_MESSAGE)
    }

    if (!response.ok) {
      const parsedError = controllerErrorSchema.safeParse(payload)
      if (parsedError.success) {
        // Business outcomes (no_capacity, expired, ...) carry a player-facing
        // message from the controller; surface it verbatim.
        return this.error(parsedError.data.message)
      }
      return this.error(REQUEST_FAILED_MESSAGE)
    }

    const parsed = controllerInstanceDetailsSchema.safeParse(payload)
    if (!parsed.success) {
      return this.error(INVALID_RESPONSE_MESSAGE)
    }

    const mismatch = this.assertEndpointCount(
      parsed.data,
      expectedEndpointCount
    )
    if (mismatch) {
      return mismatch
    }

    return instanceDetailsSchema.parse(parsed.data)
  }

  createInstance = async (
    options: CreateInstanceOptions
  ): Promise<instanceDetailsOrError> => {
    const expose = this.validateExpose(options.expose)
    if (!expose.ok) {
      return this.error(expose.message)
    }

    const body = {
      teamId: options.user.id,
      challengeIntegrationId: options.challengeIntegrationId,
      config: options.config,
      expose: expose.expose,
      flags: (options.flags ?? []).map(flag => ({
        provider: flag.provider,
        flag: flag.flag,
      })),
      timeoutMilliseconds: options.timeoutMilliseconds,
    }

    const validated = createInstanceRequestSchema.safeParse(body)
    if (!validated.success) {
      return this.error(
        'Invalid instance request: check the challenge instancer configuration'
      )
    }

    return this.apiRequest('PUT', validated.data, expose.expose.length)
  }

  getInstance = async (
    options: InstanceQueryOptions
  ): Promise<instanceDetailsOrError> => {
    const key = instanceKeySchema.safeParse({
      teamId: options.teamId,
      challengeIntegrationId: options.challengeIntegrationId,
    })
    if (!key.success) {
      return this.error('Invalid instance key')
    }

    return this.apiRequest(
      'POST',
      key.data,
      this.expectedEndpointCount(options)
    )
  }

  deleteInstance = async (
    options: InstanceQueryOptions
  ): Promise<instanceDetailsOrError> => {
    const key = instanceKeySchema.safeParse({
      teamId: options.teamId,
      challengeIntegrationId: options.challengeIntegrationId,
    })
    if (!key.success) {
      return this.error('Invalid instance key')
    }

    return this.apiRequest('DELETE', key.data, undefined)
  }

  extendInstance = async (
    options: ExtendInstanceOptions
  ): Promise<instanceDetailsOrError> => {
    const body = extendInstanceRequestSchema.safeParse({
      teamId: options.teamId,
      challengeIntegrationId: options.challengeIntegrationId,
      timeoutMilliseconds: options.timeoutMilliseconds,
    })
    if (!body.success) {
      return this.error('Invalid extend request')
    }

    return this.apiRequest(
      'PATCH',
      body.data,
      this.expectedEndpointCount(options)
    )
  }
}
