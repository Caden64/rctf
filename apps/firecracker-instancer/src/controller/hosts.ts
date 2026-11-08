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
import { Store } from './store'

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
    this.handle = this.timers.setInterval(() => this.run(), this.intervalMs)
  }

  async run(): Promise<void> {
    if (this.running) return
    this.running = true
    try {
      await this.fn()
    } catch (error) {
      this.logger.warn(
        {
          loop: this.name,
          err: error instanceof Error ? error.message : String(error),
        },
        'controller loop tick failed'
      )
    } finally {
      this.running = false
    }
  }

  stop(): void {
    if (!this.started) return
    this.started = false
    if (this.handle !== undefined) {
      this.timers.clearInterval(this.handle)
      this.handle = undefined
    }
  }
}

export interface HostMonitorDeps {
  config: ControllerConfig
  store: Store
  clients: Record<string, AgentClient>
  now: Clock
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
    this.seed()

    for (const host of this.hostConfigs()) {
      const client = clients[host.id]
      if (client === undefined) {
        this.deps.logger.warn(
          { hostId: host.id },
          'configured host has no agent client'
        )
        continue
      }
      try {
        const info = await client.info()
        store.recordHeartbeat(host.id, {
          url: host.url,
          now: now(),
          accepting: info.accepting,
          capacity: info.capacity,
        })
      } catch (error) {
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
      }
    }

    const timeoutMs = (config.hostTimeoutSeconds ?? 20) * 1000
    const lostMs = (config.hostLostSeconds ?? 300) * 1000
    const appliedAt = now()
    const unhealthy: string[] = []
    const lost: string[] = []

    for (const host of store.listHosts()) {
      const lastSeen = host.lastSeenMs ?? host.createdAtMs
      const age = appliedAt - lastSeen
      if (age > timeoutMs && host.health !== 'unhealthy') {
        store.markHostHealth(host.id, 'unhealthy')
        unhealthy.push(host.id)
        this.deps.logger.warn(
          { hostId: host.id, lastSeenMs: host.lastSeenMs },
          'host is unhealthy'
        )
      }
      if (age > lostMs) {
        const ids = store.writeOffHost(host.id, appliedAt)
        if (ids.length > 0) {
          lost.push(host.id)
          this.deps.logger.error(
            { hostId: host.id, instanceIds: ids },
            'host lost; instances written off'
          )
        }
      }
    }

    return { unhealthy, lost }
  }
}
