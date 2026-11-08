/**
 * Host health: heartbeat loop (`GET /v1/info`) plus the two thresholds from the
 * config. A host that misses `hostTimeoutSeconds` becomes `unhealthy` (no new
 * placements, existing rows read as errored/stopping); after `hostLostSeconds`
 * its live rows are written off (unique key freed, reservation released) and
 * tombstoned so the reconciler can remove the agent side when it returns.
 *
 * Also contains the injectable timer seam used by every controller loop.
 */
import {
  AgentUnreachableError,
  type AgentClient,
  type Clock,
} from '../interfaces'
import type { Logger } from '../log'
import type { ControllerConfig, HostConfig } from './config'
import { Store, StoreClosedError } from './store'

export interface ControllerTimers {
  setInterval(handler: () => unknown, ms: number): unknown
  clearInterval(handle: unknown): void
}

export const defaultTimers: ControllerTimers = {
  setInterval: (handler, ms) => setInterval(handler, ms),
  clearInterval: handle =>
    clearInterval(handle as ReturnType<typeof setInterval>),
}

/** Runs an async tick on an interval without overlapping itself. */
export class PeriodicLoop {
  private handle: unknown = undefined
  private running = false
  private started = false
  private stopping = false
  private active: Promise<void> | null = null

  constructor(
    private readonly name: string,
    private readonly intervalMs: number,
    private readonly fn: () => Promise<void>,
    private readonly timers: ControllerTimers,
    private readonly logger: Logger
  ) {}

  start(): void {
    if (this.started) return
    this.started = true
    this.stopping = false
    this.handle = this.timers.setInterval(() => this.run(), this.intervalMs)
  }

  run(): Promise<void> {
    // A tick triggered after stop() began (an already-queued interval
    // callback) must be a no-op, not a write against a closing database.
    if (this.stopping) return Promise.resolve()
    if (this.running) return this.active ?? Promise.resolve()
    this.running = true
    this.active = (async () => {
      try {
        await this.fn()
      } catch (error) {
        // A late tick racing controller shutdown is expected: the store is
        // closed and its typed error is not a loop failure.
        if (error instanceof StoreClosedError) return
        this.logger.warn(
          {
            loop: this.name,
            err: error instanceof Error ? error.message : String(error),
          },
          'controller loop tick failed'
        )
      } finally {
        this.running = false
        this.active = null
      }
    })()
    return this.active
  }

  /**
   * Synchronously stop scheduling further ticks. Called for every loop before
   * any is awaited, so a held tick in one loop never leaves the others
   * scheduled.
   */
  halt(): void {
    this.stopping = true
    if (this.started) {
      this.started = false
      if (this.handle !== undefined) {
        this.timers.clearInterval(this.handle)
        this.handle = undefined
      }
    }
  }

  /** Resolve when the in-flight tick (if any) settles; never rejects. */
  settle(): Promise<void> {
    const active = this.active
    return active === null ? Promise.resolve() : active.catch(() => undefined)
  }

  /**
   * Stop scheduling and wait for the in-flight tick (if any) to finish.
   * With `timeoutMs`, the wait is bounded (used by the controller-wide
   * shutdown deadline); a late tick is made harmless by the store close.
   */
  async stop(timeoutMs?: number): Promise<void> {
    this.halt()
    if (this.active === null) return
    const settled = this.settle()
    if (timeoutMs === undefined) {
      await settled
      return
    }
    let handle: ReturnType<typeof setTimeout> | undefined
    let timedOut = false
    const deadline = new Promise<void>(resolve => {
      handle = setTimeout(
        () => {
          timedOut = true
          resolve()
        },
        Math.max(0, timeoutMs)
      )
    })
    try {
      await Promise.race([settled, deadline])
    } finally {
      if (handle !== undefined) clearTimeout(handle)
    }
    if (timedOut) {
      this.logger.warn(
        { loop: this.name, timeoutMs },
        'controller loop did not finish before the shutdown deadline'
      )
    }
  }
}

export interface HostMonitorDeps {
  config: ControllerConfig
  store: Store
  clients: Record<string, AgentClient>
  now: Clock
  /**
   * Monotonic elapsed-time source used for RTT. Defaults to
   * `performance.now`, which (unlike the injectable wall clock) advances even
   * when tests use a fixed `now`.
   */
  rttNow?: () => number
  logger: Logger
}

export interface HostMonitorTickResult {
  unhealthy: string[]
  lost: string[]
}

export class HostMonitor {
  constructor(private readonly deps: HostMonitorDeps) {}

  /** Make sure every configured host has a persisted row (drain flag survives restarts). */
  seed(): void {
    const now = this.deps.now()
    for (const host of this.deps.config.hosts) {
      this.deps.store.ensureHost(host.id, host.url, now)
    }
  }

  private hostConfigs(): HostConfig[] {
    return this.deps.config.hosts
  }

  async tick(): Promise<HostMonitorTickResult> {
    const { store, clients, config, now } = this.deps
    const rttNow = this.deps.rttNow ?? (() => performance.now())
    this.seed()

    // Probe every host concurrently and record each success at its own
    // completion time. Serial probes would let one slow/timing-out host age an
    // earlier success past hostTimeoutSeconds and falsely mark it stale.
    const probeTimeoutMs = Math.max(
      1,
      (config.hostProbeTimeoutSeconds ?? 10) * 1000
    )
    const maxRttMs = Math.max(0, (config.clockMaxRttSeconds ?? 2) * 1000)
    const timeoutMs = (config.hostTimeoutSeconds ?? 20) * 1000
    const lostMs = (config.hostLostSeconds ?? 300) * 1000
    const unhealthy: string[] = []
    const lost: string[] = []

    // Evaluate a host at its OWN completion time using its OWN last success.
    // Waiting for every probe before judging would let a slow peer age an
    // early success past hostTimeoutSeconds.
    const evaluate = (hostId: string): void => {
      const host = store.getHost(hostId)
      if (host === null) return
      const at = now()
      const lastSeen = host.lastSeenMs ?? host.createdAtMs
      const age = at - lastSeen
      if (age > timeoutMs && host.health !== 'unhealthy') {
        store.markHostHealth(host.id, 'unhealthy')
        unhealthy.push(host.id)
        this.deps.logger.warn(
          { hostId: host.id, lastSeenMs: host.lastSeenMs },
          'host is unhealthy'
        )
      }
      if (age > lostMs) {
        const ids = store.writeOffHost(host.id, at)
        if (ids.length > 0) {
          lost.push(host.id)
          this.deps.logger.error(
            { hostId: host.id, instanceIds: ids },
            'host lost; instances written off'
          )
        }
      }
    }

    await Promise.allSettled(
      this.hostConfigs().map(async host => {
        const client = clients[host.id]
        if (client === undefined) {
          this.deps.logger.warn(
            { hostId: host.id },
            'configured host has no agent client'
          )
          evaluate(host.id)
          return
        }
        const startedAt = now()
        const startedMono = rttNow()
        try {
          const info = await probeWithDeadline(
            client.info(),
            probeTimeoutMs,
            this.deps.logger,
            host.id
          )
          const finishedAt = now()
          const finishedMono = rttNow()
          const rttMs = finishedMono - startedMono
          // Wall-clock elapsed also catches a forward clock step that the
          // monotonic RTT source cannot see. A zero wall RTT is expected with
          // an injected fixed test clock; the monotonic RTT is authoritative.
          const wallRttMs = finishedAt - startedAt
          const rejectReason =
            wallRttMs < 0
              ? 'controller clock stepped backwards'
              : wallRttMs > maxRttMs
                ? 'wall-clock round trip too long'
                : rttMs <= 0
                  ? 'non-positive round trip'
                  : rttMs > maxRttMs
                    ? 'round trip too long'
                    : null
          if (rejectReason !== null) {
            this.deps.logger.warn(
              {
                hostId: host.id,
                reason: rejectReason,
                rttMs,
                wallRttMs,
                maxRttMs,
              },
              'host clock sample rejected; keeping the previous estimate'
            )
            store.recordHeartbeat(host.id, {
              url: host.url,
              now: finishedAt,
              accepting: info.accepting,
              capacity: info.capacity,
              clock: null,
            })
            return
          }
          // RTT-compensated estimate of (agent clock - controller clock).
          const midpoint = (startedAt + finishedAt) / 2
          store.recordHeartbeat(host.id, {
            url: host.url,
            now: finishedAt,
            accepting: info.accepting,
            capacity: info.capacity,
            clock: {
              skewMs: info.timeMs - midpoint,
              rttMs,
              sampledAtMs: finishedAt,
            },
          })
        } catch (error) {
          // A tick racing controller shutdown must fail quietly, not be
          // reported as a heartbeat failure.
          if (error instanceof StoreClosedError) throw error
          if (!(error instanceof AgentUnreachableError)) {
            this.deps.logger.warn(
              {
                hostId: host.id,
                err: error instanceof Error ? error.message : String(error),
              },
              'host heartbeat failed'
            )
          }
          // Staleness is handled below; a single missed heartbeat is harmless.
        } finally {
          evaluate(host.id)
        }
      })
    )

    return { unhealthy, lost }
  }
}

/** Race a heartbeat probe against a hard per-probe deadline. */
const probeWithDeadline = async <T>(
  probe: Promise<T>,
  timeoutMs: number,
  logger: Logger,
  hostId: string
): Promise<T> => {
  let handle: ReturnType<typeof setTimeout> | undefined
  const deadline = new Promise<never>((_, reject) => {
    handle = setTimeout(() => {
      logger.warn(
        { hostId, timeoutMs },
        'host heartbeat probe deadline exceeded'
      )
      reject(
        new AgentUnreachableError(
          hostId,
          `heartbeat probe timed out after ${timeoutMs}ms`
        )
      )
    }, timeoutMs)
  })
  try {
    return await Promise.race([probe, deadline])
  } finally {
    if (handle !== undefined) clearTimeout(handle)
  }
}
