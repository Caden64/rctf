/**
 * Controller business logic behind the HTTP API (`ControllerService`).
 *
 * Ownership rules that matter here:
 * - `(teamId, challengeIntegrationId)` maps to at most one live instance. The
 *   `create` placement + row insert happen in one SQLite `BEGIN IMMEDIATE`
 *   transaction, backed by a UNIQUE partial index on live states.
 * - The instance's host is pinned at creation. A definitive agent rejection
 *   releases the reservation and fails over; an ambiguous transport failure
 *   keeps the row + reservation for the reconciler to resolve.
 * - Flags never touch SQLite, logs, or the instance rows; they live only in
 *   the in-memory agent spec for the duration of the create call.
 */
import { createHmac } from 'node:crypto'
import {
  FIRECRACKER_MACHINE_NAME,
  ProtocolError,
  firecrackerChallengeConfigSchema,
  type AgentInstance,
  type AgentInstanceSpec,
  type ControllerEndpoint,
  type ControllerInstanceDetails,
  type CreateInstanceRequest,
  type ErrorCode,
  type ExtendInstanceRequest,
  type FirecrackerChallengeConfig,
  type HostSummary,
  type InstanceKey,
  type InstanceStatusValue,
} from '@rctf/firecracker-protocol'
import {
  AgentRejectedError,
  AgentUnreachableError,
  type AgentClient,
  type Clock,
  type ControllerService,
} from '../interfaces'
import { createLogger, type Logger } from '../log'
import { HttpAgentClient } from './agent-client'
import type { ControllerConfig, HostConfig } from './config'
import {
  defaultTimers,
  HostMonitor,
  PeriodicLoop,
  type ControllerTimers,
} from './hosts'
import { Reaper } from './reaper'
import { Reconciler } from './reconciler'
import {
  controllerEndpoints,
  EMPTY_RESERVED,
  Store,
  type Capacity,
  type InstanceRecord,
  type InstanceState,
  type Reserved,
  type StoredExpose,
} from './store'
import {
  describeNoCapacity,
  effectiveCapacity,
  selectHost,
  type Overcommit,
  type RequestedResources,
} from './scheduler'

export interface ControllerServiceDeps {
  /** hostId -> client. Defaults to HttpAgentClient per configured host. */
  clients?: Record<string, AgentClient>
  now?: Clock
  logger?: Logger
  /** Instance id generator (random lowercase base36, 24 chars by default). */
  newId?: () => string
  /** Injectable interval timers (tests). */
  timers?: ControllerTimers
  /** Monotonic RTT source for clock samples (tests); defaults to performance.now. */
  rttNow?: () => number
}

type ExtendOutcome =
  | { kind: 'ok'; row: InstanceRecord }
  | { kind: 'error'; code: ErrorCode; message: string }

type ReserveOutcome =
  | { kind: 'existing'; row: InstanceRecord }
  | { kind: 'reserved'; row: InstanceRecord }
  | { kind: 'no_capacity'; message: string }

type NormalizedChallenge = FirecrackerChallengeConfig & {
  vcpus: number
  memMiB: number
  diskMiB: number
  egress: boolean
  bootTimeoutSeconds: number
  env: Record<string, string>
}

const RANDOM_ID_LENGTH = 24

const randomId = (): string => {
  const bytes = crypto.getRandomValues(new Uint8Array(RANDOM_ID_LENGTH))
  let id = ''
  for (const byte of bytes) id += (byte % 36).toString(36)
  return id
}

const issueMessage = (error: {
  issues: readonly { path: readonly PropertyKey[]; message: string }[]
}): string =>
  error.issues
    .map(issue =>
      issue.path.length > 0
        ? `${issue.path.join('.')}: ${issue.message}`
        : issue.message
    )
    .join('; ')

const stoppedDetails = (): ControllerInstanceDetails => ({
  kind: 'instancerInstanceDetails',
  status: 'stopped',
  timeLeftMilliseconds: 0,
  endpoints: null,
})

const details = (
  status: InstanceStatusValue,
  timeLeftMilliseconds: number,
  endpoints: ControllerEndpoint[] | null
): ControllerInstanceDetails => ({
  kind: 'instancerInstanceDetails',
  status,
  timeLeftMilliseconds,
  endpoints,
})

class ControllerServiceImpl implements ControllerService {
  private readonly store: Store
  private readonly clients: Record<string, AgentClient>
  private readonly now: Clock
  private readonly logger: Logger
  private readonly newId: () => string
  private readonly timers: ControllerTimers
  private readonly teamKeySecret: string
  private readonly overcommit: Overcommit
  private readonly inflightCreates = new Set<string>()
  private readonly monitor: HostMonitor
  private readonly reconciler: Reconciler
  private readonly reaper: Reaper
  private loops: PeriodicLoop[] = []
  private started = false

  constructor(
    private readonly config: ControllerConfig,
    deps: ControllerServiceDeps
  ) {
    if (
      config.teamKeySecret === undefined ||
      config.teamKeySecret.length === 0
    ) {
      throw new Error(
        'controller config: teamKeySecret is required (FIRECRACKER_TEAM_KEY_SECRET)'
      )
    }
    this.teamKeySecret = config.teamKeySecret
    this.now = deps.now ?? (() => Date.now())
    this.logger = deps.logger ?? createLogger('firecracker-controller')
    this.newId = deps.newId ?? randomId
    this.timers = deps.timers ?? defaultTimers
    this.overcommit = config.overcommit ?? { vcpu: 1, mem: 1 }
    this.store = new Store(
      config.databasePath ?? '/var/lib/rctf-firecracker/controller.sqlite',
      this.now
    )
    this.clients =
      deps.clients ??
      Object.fromEntries(
        config.hosts.map(host => [host.id, new HttpAgentClient(host)])
      )
    this.monitor = new HostMonitor({
      config,
      store: this.store,
      clients: this.clients,
      now: this.now,
      ...(deps.rttNow === undefined ? {} : { rttNow: deps.rttNow }),
      logger: this.logger,
    })
    this.reconciler = new Reconciler({
      config,
      store: this.store,
      clients: this.clients,
      now: this.now,
      logger: this.logger,
      isCreateInFlight: id => this.inflightCreates.has(id),
    })
    this.reaper = new Reaper({
      store: this.store,
      clients: this.clients,
      now: this.now,
      logger: this.logger,
    })
    this.monitor.seed()
  }

  // ---- create -----------------------------------------------------------

  async create(req: CreateInstanceRequest): Promise<ControllerInstanceDetails> {
    const challenge = this.validateCreate(req)
    const request: RequestedResources = {
      vcpus: challenge.vcpus,
      memMiB: challenge.memMiB,
      diskMiB: challenge.diskMiB,
    }
    const key: InstanceKey = {
      teamId: req.teamId,
      challengeIntegrationId: req.challengeIntegrationId,
    }
    const attempted = new Set<string>()
    let lastFailure: string | undefined

    // A terminal `errored` row does not hold the key, but its agent-side
    // tombstone would otherwise live forever. Best-effort GC before the new
    // placement; the reconciler sweeps anything this misses.
    await this.gcErroredForKey(key)

    for (let attempt = 0; attempt < this.config.hosts.length; attempt++) {
      const outcome = this.reserve(req, challenge, key, request, attempted)
      if (outcome.kind === 'existing') return this.detailsForRow(outcome.row)
      if (outcome.kind === 'no_capacity') {
        throw new ProtocolError('no_capacity', outcome.message)
      }

      const row = outcome.row
      attempted.add(row.hostId)
      const client = this.clients[row.hostId]
      if (client === undefined) {
        this.store.deleteInstanceIfState(row.id, 'creating')
        lastFailure = `host ${row.hostId} has no agent client`
        continue
      }

      const spec = this.buildSpec(row, challenge, req)
      this.inflightCreates.add(row.id)
      try {
        const agent = await client.create(spec)
        const applied = this.applyAgentCreate(row, agent)
        if (!applied) {
          const current = this.store.getInstance(row.id)
          // A concurrent GET (or a reconciler adoption) may already have
          // promoted this row to running, or it may still be creating. In
          // both cases the VM is healthy and owned: accept it. Tear down only
          // when the row is gone or no longer live.
          if (
            current !== null &&
            (current.state === 'creating' || current.state === 'running')
          ) {
            return this.detailsForRow(current)
          }
          // The player deleted (or the host was written off) while the create
          // was in flight. Make sure no VM is leaked behind their back.
          try {
            await client.delete(row.id)
          } catch {
            // Reconciler will retry; the row (if any) is not live.
          }
          return this.detailsForKey(key)
        }
        return this.detailsForRow(this.store.getInstance(row.id) ?? row)
      } catch (error) {
        if (
          error instanceof AgentRejectedError &&
          (error.code === 'no_capacity' ||
            error.code === 'draining' ||
            error.code === 'invalid_request' ||
            error.code === 'unauthorized')
        ) {
          // Definitive: nothing was created. Release and try the next host.
          this.store.deleteInstanceIfState(row.id, 'creating')
          lastFailure = `${error.code}: ${error.message}`
          this.logger.warn(
            {
              instanceId: row.id,
              hostId: row.hostId,
              code: error.code,
            },
            'agent rejected instance create; failing over'
          )
          continue
        }
        if (error instanceof AgentUnreachableError) {
          // AMBIGUOUS: the request may have created the VM. Do not release the
          // reservation or try another host; the reconciler resolves it by
          // adopting the agent record or fencing it.
          this.logger.warn(
            { instanceId: row.id, hostId: row.hostId },
            'agent create outcome unknown; reconciler will resolve'
          )
          return this.detailsForRow(this.store.getInstance(row.id) ?? row)
        }
        if (error instanceof AgentRejectedError) {
          // Defense in depth: a non-definitive rejection code (for example a
          // misclassified 500/internal) is not proof the VM was not created.
          this.logger.warn(
            {
              instanceId: row.id,
              hostId: row.hostId,
              code: error.code,
            },
            'non-definitive agent create rejection; treating as ambiguous'
          )
          return this.detailsForRow(this.store.getInstance(row.id) ?? row)
        }
        this.store.deleteInstanceIfState(row.id, 'creating')
        throw error instanceof ProtocolError
          ? error
          : new ProtocolError(
              'internal',
              `unexpected error during create: ${
                error instanceof Error ? error.message : String(error)
              }`
            )
      } finally {
        this.inflightCreates.delete(row.id)
      }
    }

    throw new ProtocolError(
      'no_capacity',
      lastFailure ?? 'no capacity: no hosts available'
    )
  }

  private validateCreate(req: CreateInstanceRequest): NormalizedChallenge {
    const parsed = firecrackerChallengeConfigSchema.safeParse(req.config)
    if (!parsed.success) {
      throw new ProtocolError(
        'invalid_request',
        `invalid challenge config: ${issueMessage(parsed.error)}`
      )
    }
    if (req.expose.length < 1) {
      throw new ProtocolError(
        'invalid_request',
        'at least one expose entry is required'
      )
    }
    if (req.expose.length > 16) {
      throw new ProtocolError(
        'invalid_request',
        'at most 16 expose entries are supported'
      )
    }
    const ports = new Set<number>()
    for (const entry of req.expose) {
      if (entry.containerName !== FIRECRACKER_MACHINE_NAME) {
        throw new ProtocolError(
          'invalid_request',
          `expose.containerName must be "${FIRECRACKER_MACHINE_NAME}"`
        )
      }
      if (ports.has(entry.containerPort)) {
        throw new ProtocolError(
          'invalid_request',
          `duplicate exposed guest port ${entry.containerPort}`
        )
      }
      ports.add(entry.containerPort)
    }
    const config = parsed.data
    return {
      image: config.image,
      vcpus: config.vcpus ?? 1,
      memMiB: config.memMiB ?? 256,
      diskMiB: config.diskMiB ?? 1024,
      ...(config.kernelArgs === undefined
        ? {}
        : { kernelArgs: config.kernelArgs }),
      egress: config.egress ?? false,
      bootTimeoutSeconds: config.bootTimeoutSeconds ?? 60,
      ...(config.readiness === undefined
        ? {}
        : { readiness: config.readiness }),
      env: config.env ?? {},
    }
  }

  private teamKeyFor(teamId: string): string {
    return createHmac('sha256', this.teamKeySecret)
      .update(teamId)
      .digest('hex')
      .slice(0, 32)
  }

  private generateId(): string {
    for (let attempt = 0; attempt < 16; attempt++) {
      const id = this.newId()
      if (/^[a-z0-9]{16,32}$/.test(id) && this.store.getInstance(id) === null) {
        return id
      }
    }
    throw new Error('could not generate a unique instance id')
  }

  /**
   * Placement + reservation + row insert in one write transaction. The unique
   * partial index makes the idempotency guarantee hold even if two requests
   * race for the same key.
   */
  private reserve(
    req: CreateInstanceRequest,
    challenge: NormalizedChallenge,
    key: InstanceKey,
    request: RequestedResources,
    attempted: ReadonlySet<string>
  ): ReserveOutcome {
    return this.store.transaction((): ReserveOutcome => {
      const existing = this.store.getLiveInstance(key)
      if (existing !== null) return { kind: 'existing', row: existing }

      const at = this.now()
      const reserved = this.store.reservedByHost()
      const maxClockSkewMs = (this.config.maxClockSkewSeconds ?? 10) * 1000
      const clockSampleMaxAgeMs =
        (this.config.clockSampleMaxAgeSeconds ?? 60) * 1000
      const candidates = this.config.hosts
        .filter(host => !attempted.has(host.id))
        .map(host => {
          const record = this.store.ensureHost(host.id, host.url, at)
          return {
            config: host,
            host: record,
            reserved: reserved.get(host.id) ?? EMPTY_RESERVED,
            maxClockSkewMs,
            nowMs: at,
            clockSampleMaxAgeMs,
          }
        })

      const selected = selectHost(candidates, request, this.overcommit)
      if (selected === undefined) {
        return {
          kind: 'no_capacity',
          message: describeNoCapacity(candidates, request, this.overcommit),
        }
      }

      const expiresAtMs =
        this.config.maxLifetimeSeconds === undefined
          ? at + req.timeoutMilliseconds
          : Math.min(
              at + req.timeoutMilliseconds,
              at + this.config.maxLifetimeSeconds * 1000
            )

      const expose: StoredExpose[] = req.expose.map(entry => ({
        kind: entry.kind,
        hostPrefix: entry.hostPrefix,
        port: entry.containerPort,
        ...(entry.title === undefined ? {} : { title: entry.title }),
      }))

      const row: InstanceRecord = {
        id: this.generateId(),
        teamId: req.teamId,
        challengeIntegrationId: req.challengeIntegrationId,
        teamKey: this.teamKeyFor(req.teamId),
        hostId: selected.config.id,
        state: 'creating',
        image: challenge.image,
        vcpus: challenge.vcpus,
        memMiB: challenge.memMiB,
        diskMiB: challenge.diskMiB,
        expiresAtMs,
        createdAtMs: at,
        updatedAtMs: at,
        revision: 0,
        message: null,
        agentExpirySynced: true,
        expose,
        endpoints: null,
      }
      this.store.insertInstance(row)
      return { kind: 'reserved', row }
    })
  }

  /**
   * Clock estimate used to translate a controller deadline onto the agent
   * clock. `slackMs` is the sample's uncertainty (RTT/2): adding it means the
   * translated deadline is never earlier than the controller deadline by more
   * than measurement noise, even if the skew estimate is off by that much.
   */
  private clockEstimate(hostId: string): { skewMs: number; slackMs: number } {
    const host = this.store.getHost(hostId)
    if (host === null) return { skewMs: 0, slackMs: 0 }
    return {
      skewMs: host.clockSkewMs,
      slackMs: Math.ceil((host.clockRttMs ?? 0) / 2),
    }
  }

  private toAgentDeadline(
    hostId: string,
    controllerDeadlineMs: number
  ): number {
    const { skewMs, slackMs } = this.clockEstimate(hostId)
    return controllerDeadlineMs + skewMs + slackMs
  }

  /** Conservative check that an agent deadline covers the controller one. */
  private agentCoversDeadline(
    hostId: string,
    agentDeadlineMs: number,
    controllerDeadlineMs: number
  ): boolean {
    const { skewMs, slackMs } = this.clockEstimate(hostId)
    return agentDeadlineMs - skewMs - slackMs >= controllerDeadlineMs
  }

  private buildSpec(
    row: InstanceRecord,
    challenge: NormalizedChallenge,
    req: CreateInstanceRequest
  ): AgentInstanceSpec {
    const readiness = challenge.readiness ?? {
      kind: 'tcp' as const,
      port: row.expose[0]!.port,
    }
    return {
      id: row.id,
      teamKey: row.teamKey,
      image: row.image,
      vcpus: row.vcpus,
      memMiB: row.memMiB,
      diskMiB: row.diskMiB,
      ...(challenge.kernelArgs === undefined
        ? {}
        : { kernelArgs: challenge.kernelArgs }),
      egress: challenge.egress,
      bootTimeoutSeconds: challenge.bootTimeoutSeconds,
      readiness,
      env: challenge.env,
      expose: row.expose.map(entry =>
        entry.title === undefined
          ? {
              kind: entry.kind,
              hostPrefix: entry.hostPrefix,
              port: entry.port,
            }
          : {
              kind: entry.kind,
              hostPrefix: entry.hostPrefix,
              port: entry.port,
              title: entry.title,
            }
      ),
      // Deadlines are on the AGENT clock.
      expiresAtMs: this.toAgentDeadline(row.hostId, row.expiresAtMs),
      flags: req.flags,
    }
  }

  private applyAgentCreate(row: InstanceRecord, agent: AgentInstance): boolean {
    const at = this.now()
    const endpoints = controllerEndpoints(row.expose, agent.endpoints)
    if (agent.state === 'errored') {
      return this.store.casState(row.id, ['creating'], 'errored', at, {
        message: agent.message ?? 'instance failed to start',
        endpoints: null,
      })
    }
    if (agent.state === 'stopping' || agent.state === 'stopped') {
      return this.store.casState(row.id, ['creating'], 'deleting', at, {
        endpoints,
      })
    }
    const target: InstanceState =
      agent.state === 'running' ? 'running' : 'creating'
    return this.store.casState(row.id, ['creating'], target, at, {
      endpoints,
      message: agent.message ?? null,
      agentExpirySynced: this.agentCoversDeadline(
        row.hostId,
        agent.expiresAtMs,
        row.expiresAtMs
      ),
    })
  }

  // ---- read -------------------------------------------------------------

  async get(key: InstanceKey): Promise<ControllerInstanceDetails> {
    const row = this.store.getInstanceForKey(key)
    if (row === null) return stoppedDetails()
    return this.describeRow(row)
  }

  private detailsForKey(key: InstanceKey): ControllerInstanceDetails {
    const row = this.store.getInstanceForKey(key)
    return row === null ? stoppedDetails() : this.detailsForRow(row)
  }

  private detailsForRow(row: InstanceRecord): ControllerInstanceDetails {
    switch (row.state) {
      case 'lost':
        return stoppedDetails()
      case 'deleting':
        return details('stopping', 0, row.endpoints)
      case 'errored':
        return details('errored', 0, row.endpoints)
      case 'running':
        return details(
          'running',
          Math.max(0, row.expiresAtMs - this.now()),
          row.endpoints
        )
      case 'creating':
        return details(
          'starting',
          Math.max(0, row.expiresAtMs - this.now()),
          row.endpoints
        )
    }
  }

  private async describeRow(
    row: InstanceRecord
  ): Promise<ControllerInstanceDetails> {
    if (row.state === 'lost') return stoppedDetails()
    if (row.state === 'deleting') return details('stopping', 0, row.endpoints)
    if (row.state === 'errored') return details('errored', 0, row.endpoints)

    const client = this.clients[row.hostId]
    if (client === undefined) {
      this.logger.warn(
        { instanceId: row.id, hostId: row.hostId },
        'no agent client for instance host'
      )
      return details('errored', 0, row.endpoints)
    }

    try {
      const agent = await client.get(row.id)
      if (agent === undefined) {
        if (row.state === 'running') {
          this.store.casState(row.id, ['running'], 'errored', this.now(), {
            message: 'instance lost on host',
            endpoints: null,
          })
          return details('errored', 0, null)
        }
        return this.detailsForRow(row)
      }
      return this.applyAgentObservation(row, agent)
    } catch (error) {
      if (error instanceof AgentUnreachableError) {
        this.logger.warn(
          { instanceId: row.id, hostId: row.hostId },
          'host unreachable while reading instance; reporting errored'
        )
        return details('errored', 0, row.endpoints)
      }
      this.logger.warn(
        {
          instanceId: row.id,
          hostId: row.hostId,
          err: error instanceof Error ? error.message : String(error),
        },
        'agent rejected instance read; reporting errored'
      )
      return details('errored', 0, row.endpoints)
    }
  }

  private applyAgentObservation(
    row: InstanceRecord,
    agent: AgentInstance
  ): ControllerInstanceDetails {
    const at = this.now()
    const endpoints = controllerEndpoints(row.expose, agent.endpoints)
    const timeLeft = Math.max(0, row.expiresAtMs - at)

    switch (agent.state) {
      case 'running':
        this.store.casState(row.id, ['creating', 'running'], 'running', at, {
          endpoints,
          message: null,
        })
        return details('running', timeLeft, endpoints)
      case 'creating':
      case 'starting':
        if (row.state === 'running') {
          this.store.casState(row.id, ['running'], 'running', at, { endpoints })
        }
        return details('starting', timeLeft, endpoints)
      case 'stopping':
      case 'stopped':
        this.store.casState(row.id, ['creating', 'running'], 'deleting', at, {
          endpoints,
        })
        return details('stopping', 0, endpoints)
      case 'errored':
        this.store.casState(row.id, ['creating', 'running'], 'errored', at, {
          message: agent.message ?? 'instance failed on host',
          endpoints: null,
        })
        return details('errored', 0, null)
    }
  }

  // ---- extend -----------------------------------------------------------

  async extend(req: ExtendInstanceRequest): Promise<ControllerInstanceDetails> {
    const key: InstanceKey = {
      teamId: req.teamId,
      challengeIntegrationId: req.challengeIntegrationId,
    }
    const at = this.now()

    const outcome = this.store.transaction((): ExtendOutcome => {
      const row = this.store.getInstanceForKey(key)
      if (row === null) {
        return {
          kind: 'error',
          code: 'not_found',
          message: 'no instance for this team and challenge',
        }
      }
      if (
        row.state === 'deleting' ||
        row.state === 'errored' ||
        row.state === 'lost'
      ) {
        return {
          kind: 'error',
          code: 'not_found',
          message: 'instance is no longer extendable',
        }
      }
      if (row.expiresAtMs <= at) {
        return {
          kind: 'error',
          code: 'expired',
          message: 'instance has expired',
        }
      }

      let requestedDeadline = at + req.timeoutMilliseconds
      if (this.config.maxLifetimeSeconds !== undefined) {
        requestedDeadline = Math.min(
          requestedDeadline,
          row.createdAtMs + this.config.maxLifetimeSeconds * 1000
        )
      }
      // GRANDFATHERED: a cap lowered across a restart never shortens an
      // existing instance. Keep the current deadline when it is already later
      // than what the new cap would allow (the row simply stops extending).
      const expiresAtMs = Math.max(row.expiresAtMs, requestedDeadline)
      if (expiresAtMs <= at) {
        return {
          kind: 'error',
          code: 'expired',
          message: 'instance has reached its maximum lifetime',
        }
      }

      const changed = this.store.updateExpiry(
        row.id,
        ['creating', 'running'],
        expiresAtMs,
        at
      )
      if (!changed) {
        return {
          kind: 'error',
          code: 'conflict',
          message: 'instance changed state while extending',
        }
      }
      // updateExpiry is monotonic: a competing/out-of-order extend can never
      // shorten the deadline.
      return {
        kind: 'ok',
        row: {
          ...row,
          expiresAtMs: Math.max(row.expiresAtMs, expiresAtMs),
          agentExpirySynced: false,
        },
      }
    })

    if (outcome.kind === 'error') {
      throw new ProtocolError(outcome.code, outcome.message)
    }

    // The committed row is authoritative: the deadline above is never rolled
    // back, and the reconciler retries an unsynced deadline. But the player
    // must NOT see success when the agent did not take it: report
    // `host_unavailable` while keeping the committed desired deadline.
    const row = outcome.row
    const client = this.clients[row.hostId]
    if (client === undefined) {
      throw new ProtocolError(
        'host_unavailable',
        'no agent client for instance host; the controller will retry the extension'
      )
    }
    let confirmed: AgentInstance
    try {
      const target = this.toAgentDeadline(row.hostId, row.expiresAtMs)
      confirmed = await client.extend(row.id, target)
      if (
        !this.agentCoversDeadline(
          row.hostId,
          confirmed.expiresAtMs,
          row.expiresAtMs
        )
      ) {
        throw new ProtocolError(
          'host_unavailable',
          'agent did not confirm the requested extension deadline'
        )
      }
    } catch (error) {
      this.logger.warn(
        {
          instanceId: row.id,
          hostId: row.hostId,
          err: error instanceof Error ? error.message : String(error),
        },
        'failed to confirm expiry with agent; committed deadline kept, reconciler will retry'
      )
      if (error instanceof ProtocolError) throw error
      throw new ProtocolError(
        'host_unavailable',
        'failed to push expiry to agent; the controller will retry'
      )
    }

    // Re-read: a concurrent delete/extend may have changed the row while the
    // PATCH was in flight. Never return the original snapshot as success.
    const current = this.store.getInstance(row.id)
    if (current === null) return stoppedDetails()
    if (
      (current.state === 'creating' || current.state === 'running') &&
      this.agentCoversDeadline(
        current.hostId,
        confirmed.expiresAtMs,
        current.expiresAtMs
      )
    ) {
      // Conditional: only marks the deadline that is still current, so a
      // competing extend that committed a later one stays unsynced.
      this.store.setExpirySyncedFor(current.id, current.expiresAtMs, true)
    }
    return this.detailsForRow(current)
  }

  // ---- delete -----------------------------------------------------------

  async delete(key: InstanceKey): Promise<ControllerInstanceDetails> {
    const at = this.now()
    let row = this.store.getInstanceForKey(key)
    if (row === null) return stoppedDetails()

    if (row.state === 'lost') {
      const client = this.clients[row.hostId]
      if (client !== undefined) {
        try {
          await client.delete(row.id)
          this.store.deleteInstanceIfState(row.id, 'lost')
        } catch {
          // Unconfirmed: keep the tombstone; the host's return cleans it up.
          // Only a resolving `AgentClient.delete` proves the agent fenced the
          // instance: HTTP 2xx, or the instance-scoped absence 404
          // (agentError carrying this instance's id from an agent
          // advertising instance-absence-v1).
        }
      }
      return stoppedDetails()
    }

    if (row.state !== 'deleting') {
      const changed = this.store.casState(
        row.id,
        ['creating', 'running', 'errored'],
        'deleting',
        at
      )
      row = this.store.getInstance(row.id) ?? row
      if (!changed && row.state !== 'deleting') {
        return this.detailsForRow(row)
      }
    }

    const client = this.clients[row.hostId]
    if (client !== undefined) {
      try {
        await client.delete(row.id)
        this.store.deleteInstanceIfState(row.id, 'deleting')
        return stoppedDetails()
      } catch (error) {
        this.logger.warn(
          {
            instanceId: row.id,
            hostId: row.hostId,
            err: error instanceof Error ? error.message : String(error),
          },
          'agent teardown not confirmed; row stays deleting'
        )
      }
    }

    return details('stopping', 0, row.endpoints)
  }

  /**
   * Best-effort GC of terminal `errored` rows for one key. The agent delete is
   * confirmed (200/404) before the DB row is removed; failures are left for
   * the reconciler sweep.
   */
  private async gcErroredForKey(key: InstanceKey): Promise<void> {
    for (const row of this.store.listErroredForKey(key)) {
      const client = this.clients[row.hostId]
      if (client === undefined) continue
      try {
        await client.delete(row.id)
        this.store.deleteInstanceIfState(row.id, 'errored')
      } catch {
        // Not confirmed; the reconciler sweep retries.
      }
    }
  }

  // ---- ops: hosts -------------------------------------------------------

  async listHosts(): Promise<HostSummary[]> {
    const reserved = this.store.reservedByHost()
    return this.config.hosts.map(host => this.hostSummary(host, reserved))
  }

  private hostSummary(
    host: HostConfig,
    reserved: Map<string, Reserved>
  ): HostSummary {
    const record = this.store.getHost(host.id)
    const capacity: Capacity = effectiveCapacity(
      host.capacity,
      record?.reportedCapacity ?? null
    )
    const health: HostSummary['health'] =
      record?.draining === true
        ? 'draining'
        : record?.health === 'unhealthy'
          ? 'unhealthy'
          : 'healthy'
    return {
      id: host.id,
      url: host.url,
      health,
      lastSeenMs: record?.lastSeenMs ?? null,
      capacity,
      reserved: reserved.get(host.id) ?? EMPTY_RESERVED,
    }
  }

  private configuredHost(hostId: string): HostConfig {
    const host = this.config.hosts.find(candidate => candidate.id === hostId)
    if (host === undefined) {
      throw new ProtocolError('not_found', `unknown host ${hostId}`)
    }
    return host
  }

  async drainHost(hostId: string): Promise<HostSummary> {
    const host = this.configuredHost(hostId)
    this.store.ensureHost(host.id, host.url, this.now())
    this.store.setDraining(host.id, true)
    return this.hostSummary(host, this.store.reservedByHost())
  }

  async undrainHost(hostId: string): Promise<HostSummary> {
    const host = this.configuredHost(hostId)
    this.store.ensureHost(host.id, host.url, this.now())
    this.store.setDraining(host.id, false)
    return this.hostSummary(host, this.store.reservedByHost())
  }

  async removeHost(hostId: string): Promise<void> {
    const host = this.configuredHost(hostId)
    const record = this.store.getHost(host.id)
    if (record === null || record.health !== 'unhealthy') {
      throw new ProtocolError(
        'conflict',
        'host must be unhealthy before it can be removed'
      )
    }
    // Write the live rows off as `lost` tombstones (cleanup still happens when
    // the agent returns) and leave the host draining; config seeding and later
    // heartbeats must not resurrect it.
    this.store.removeHost(host.id, this.now())
  }

  // ---- lifecycle --------------------------------------------------------

  async start(): Promise<void> {
    if (this.started) return
    this.started = true
    this.monitor.seed()
    await this.monitor.tick()
    await this.reconciler.tick()
    await this.reaper.tick()

    const heartbeat = Math.max(
      1,
      (this.config.heartbeatIntervalSeconds ?? 5) * 1000
    )
    const reaper = Math.max(1, (this.config.reaperIntervalSeconds ?? 5) * 1000)
    const reconcile = Math.max(
      1,
      (this.config.reconcileIntervalSeconds ?? 30) * 1000
    )

    this.loops = [
      new PeriodicLoop(
        'heartbeat',
        heartbeat,
        async () => {
          await this.monitor.tick()
        },
        this.timers,
        this.logger
      ),
      new PeriodicLoop(
        'reaper',
        reaper,
        async () => {
          await this.reaper.tick()
        },
        this.timers,
        this.logger
      ),
      new PeriodicLoop(
        'reconciler',
        reconcile,
        async () => {
          await this.reconciler.tick()
        },
        this.timers,
        this.logger
      ),
    ]
    for (const loop of this.loops) loop.start()
    this.logger.info(
      { hosts: this.config.hosts.map(host => host.id) },
      'controller started'
    )
  }

  async stop(): Promise<void> {
    const loops = this.loops
    this.loops = []
    this.started = false

    // First, synchronously stop scheduling in EVERY loop. Awaiting one held
    // tick must never leave the remaining loops armed.
    for (const loop of loops) loop.halt()

    if (loops.length > 0) {
      const timeoutMs = Math.max(
        0,
        (this.config.shutdownTimeoutSeconds ?? 10) * 1000
      )
      let handle: ReturnType<typeof setTimeout> | undefined
      let timedOut = false
      const deadline = new Promise<void>(resolve => {
        handle = setTimeout(() => {
          timedOut = true
          resolve()
        }, timeoutMs)
      })
      try {
        // One shared deadline for all loops, awaited concurrently.
        await Promise.race([
          Promise.all(loops.map(loop => loop.settle())),
          deadline,
        ])
      } finally {
        if (handle !== undefined) clearTimeout(handle)
      }
      if (timedOut) {
        this.logger.warn(
          { timeoutMs, loops: loops.length },
          'controller shutdown deadline exceeded; closing SQLite with ticks still in flight'
        )
      }
    }
    // Late ticks now fail with StoreClosedError, which PeriodicLoop swallows.
    this.store.close()
  }
}

export const createControllerService = (
  config: ControllerConfig,
  deps?: ControllerServiceDeps
): ControllerService => new ControllerServiceImpl(config, deps ?? {})
