/**
 * DB <-> agent reconciliation. The controller SQLite database owns ownership
 * and reservations; the agent owns what physically exists. Each tick compares
 * the two for every reachable host and repairs both directions with CAS
 * updates, so it is safe to run concurrently with player requests.
 *
 * Safety rules:
 * - Rows are read BEFORE the agent listing. A listing is only a hint: every
 *   "missing on the agent" conclusion is re-confirmed with a fresh per-id
 *   `get`, and transitions are CAS'd against the row snapshot taken before the
 *   listing (state + updated_at), never against a row read afterwards.
 * - `creating` rows are never abandoned because one listing was stale. An
 *   absent instance is fenced only after `createFenceSeconds`: the row moves to
 *   `deleting` and the agent gets a DELETE (which writes a tombstone, so a
 *   delayed original PUT can never create the VM). The row is removed only
 *   after the agent confirms 200/404.
 * - Unsynced deadlines are retried for every live non-deleting row, and are
 *   marked synced only when the agent reports a deadline >= the translated
 *   controller deadline.
 * - `lost` tombstones (host written off / removed) are cleaned up when the
 *   agent returns; superseded `errored` rows are garbage-collected the same
 *   way so their agent-side records do not live forever.
 * - Agent ids unknown to the DB are deleted after a short grace (in-flight
 *   creates).
 */
import type { AgentInstance } from '@rctf/firecracker-protocol'
import {
  AgentRejectedError,
  AgentUnreachableError,
  type AgentClient,
  type Clock,
} from '../interfaces'
import type { Logger } from '../log'
import type { ControllerConfig } from './config'
import { controllerEndpoints, Store, type InstanceRecord } from './store'

export interface ReconcilerDeps {
  config: ControllerConfig
  store: Store
  clients: Record<string, AgentClient>
  now: Clock
  logger: Logger
  /** Ids with a create request currently in flight; never treat them as gone. */
  isCreateInFlight: (id: string) => boolean
}

const LOST_MESSAGE = 'instance lost on host'

interface ClockEstimate {
  skewMs: number
  /** Sample uncertainty (RTT/2) added conservatively to translated deadlines. */
  slackMs: number
}

/**
 * PATCH-only interpretation: `not_found`/`expired` from an extend means the
 * instance is gone. The client only produces these for an instance-scoped
 * absence response; a route/proxy 404 arrives as `AgentUnreachableError` and
 * must leave the row untouched. This is deliberately NOT used to confirm a
 * DELETE: only a resolving `AgentClient.delete` (2xx or verified instance
 * absence) proves the agent wrote its tombstone.
 */
const isMissingOnExtend = (error: unknown): boolean =>
  error instanceof AgentRejectedError &&
  (error.code === 'not_found' || error.code === 'expired')

export class Reconciler {
  private ticking = false

  constructor(private readonly deps: ReconcilerDeps) {}

  async tick(): Promise<void> {
    if (this.ticking) return
    this.ticking = true
    try {
      await this.runOnce()
    } finally {
      this.ticking = false
    }
  }

  private async runOnce(): Promise<void> {
    const { config, store, clients } = this.deps
    for (const host of config.hosts) {
      const record = store.getHost(host.id)
      if (record === null || record.health === 'unhealthy') continue
      const client = clients[host.id]
      if (client === undefined) continue
      try {
        // Snapshot the rows FIRST. The listing below can be stale relative to
        // creates that complete while it is in flight; decisions must be based
        // on this snapshot and re-confirmed per id.
        const rows = store.listInstancesForHost(host.id)
        const agentInstances = await client.list()
        await this.reconcileHost(host.id, client, rows, agentInstances, {
          skewMs: record.clockSkewMs,
          slackMs: Math.ceil((record.clockRttMs ?? 0) / 2),
        })
      } catch (error) {
        if (error instanceof AgentUnreachableError) {
          this.deps.logger.warn(
            { hostId: host.id },
            'reconciler: host unreachable, skipping'
          )
        } else {
          this.deps.logger.warn(
            {
              hostId: host.id,
              err: error instanceof Error ? error.message : String(error),
            },
            'reconciler: host failed, skipping'
          )
        }
      }
    }

    await this.sweepErrored()
  }

  private async reconcileHost(
    hostId: string,
    client: AgentClient,
    rows: readonly InstanceRecord[],
    agentInstances: readonly AgentInstance[],
    clock: ClockEstimate
  ): Promise<void> {
    const { store, now, logger } = this.deps
    const agentById = new Map(
      agentInstances.map(instance => [instance.id, instance])
    )

    for (const row of rows) {
      switch (row.state) {
        case 'creating':
          await this.reconcileCreating(
            row,
            agentById.get(row.id),
            client,
            clock
          )
          break
        case 'running':
          await this.reconcileRunning(row, agentById.get(row.id), client, clock)
          break
        case 'deleting':
          await this.confirmDelete(row, client)
          break
        case 'lost':
          await this.reconcileLost(row, client)
          break
        case 'errored':
          // Terminal-until-delete; visible to the player until they delete it.
          // Superseded errored rows are swept after the host loop.
          break
      }
    }

    // Agent records nobody owns. Skip a short grace so a create that is still
    // on the wire is not torn down. `createdAtMs` is on the agent clock, so
    // translate it before comparing with controller time.
    const graceMs = (this.deps.config.orphanGraceSeconds ?? 30) * 1000
    const at = now()
    for (const agent of agentInstances) {
      const known = store.getInstance(agent.id)
      if (known !== null) {
        // A row exists (possibly on another host / mid-request); never treat it
        // as an orphan.
        continue
      }
      if (at - (agent.createdAtMs - clock.skewMs) < graceMs) continue
      try {
        await client.delete(agent.id)
        logger.warn(
          { hostId, instanceId: agent.id },
          'reconciler: deleted orphan instance on agent'
        )
      } catch (error) {
        logger.warn(
          {
            hostId,
            instanceId: agent.id,
            err: error instanceof Error ? error.message : String(error),
          },
          'reconciler: failed to delete orphan'
        )
      }
    }
  }

  private async reconcileCreating(
    row: InstanceRecord,
    listed: AgentInstance | undefined,
    client: AgentClient,
    clock: ClockEstimate
  ): Promise<void> {
    const { store, now, logger } = this.deps
    if (this.deps.isCreateInFlight(row.id)) return

    const fresh =
      listed !== undefined
        ? ({ kind: 'present', agent: listed } as const)
        : await this.freshGet(row, client)
    if (fresh.kind === 'unknown') return
    if (fresh.kind === 'present') {
      await this.applyCreatingObservation(row, fresh.agent, client, clock)
      return
    }

    // Still absent after a fresh per-id GET. Only fence once the create is old
    // enough that a delayed PUT can no longer be considered in flight.
    const fenceMs = (this.deps.config.createFenceSeconds ?? 45) * 1000
    if (now() - row.createdAtMs < fenceMs) return

    if (
      !store.casStateSnapshot(row, 'deleting', now(), {
        message: 'create never reached the agent',
      })
    ) {
      return
    }
    logger.warn(
      { instanceId: row.id, hostId: row.hostId },
      'reconciler: fencing ambiguous create; agent DELETE makes a late PUT conflict'
    )
    await this.confirmDelete(row, client)
  }

  private async applyCreatingObservation(
    row: InstanceRecord,
    agent: AgentInstance,
    client: AgentClient,
    clock: ClockEstimate
  ): Promise<void> {
    const { store, now } = this.deps
    const endpoints = controllerEndpoints(row.expose, agent.endpoints)
    switch (agent.state) {
      case 'running':
        store.casStateSnapshot(row, 'running', now(), {
          endpoints,
          message: null,
          agentExpirySynced: this.agentDeadlineSynced(row, agent, clock),
        })
        break
      case 'errored':
        store.casStateSnapshot(row, 'errored', now(), {
          message: agent.message ?? 'instance failed to start',
          endpoints: null,
        })
        break
      case 'stopping':
      case 'stopped':
        if (store.casStateSnapshot(row, 'deleting', now())) {
          await this.confirmDelete(row, client)
        }
        break
      default:
        // creating/starting: note progress (endpoints may be empty) but keep
        // the row in `creating` until the agent reports running.
        store.casStateSnapshot(row, 'creating', now(), { endpoints })
        break
    }
    const current = store.getInstance(row.id)
    if (
      current !== null &&
      (current.state === 'creating' || current.state === 'running') &&
      (current.agentExpirySynced === false ||
        this.agentDeadlineSynced(current, agent, clock) === false)
    ) {
      await this.syncExpiry(current, client, clock)
    }
  }

  private async reconcileRunning(
    row: InstanceRecord,
    listed: AgentInstance | undefined,
    client: AgentClient,
    clock: ClockEstimate
  ): Promise<void> {
    const { store, now } = this.deps
    const fresh =
      listed !== undefined
        ? ({ kind: 'present', agent: listed } as const)
        : await this.freshGet(row, client)
    if (fresh.kind === 'unknown') return

    if (fresh.kind === 'absent') {
      // Confirmed by a fresh per-id GET: the VM really is gone.
      store.casStateSnapshot(row, 'errored', now(), {
        message: LOST_MESSAGE,
        endpoints: null,
      })
      return
    }

    const agent = fresh.agent
    const endpoints = controllerEndpoints(row.expose, agent.endpoints)
    switch (agent.state) {
      case 'errored':
        store.casStateSnapshot(row, 'errored', now(), {
          message: agent.message ?? 'instance failed on host',
          endpoints: null,
        })
        return
      case 'stopping':
      case 'stopped':
        if (
          store.casStateSnapshot(row, 'deleting', now(), {
            endpoints,
          })
        ) {
          await this.confirmDelete(row, client)
        }
        return
      default:
        break
    }

    store.casStateSnapshot(row, 'running', now(), {
      endpoints,
      agentExpirySynced: this.agentDeadlineSynced(row, agent, clock),
    })

    const current = store.getInstance(row.id)
    if (
      current !== null &&
      current.state === 'running' &&
      (current.agentExpirySynced === false ||
        this.agentDeadlineSynced(current, agent, clock) === false)
    ) {
      await this.syncExpiry(current, client, clock)
    }
  }

  /** Fresh per-id confirmation; a failed GET is "unknown", never "absent". */
  private async freshGet(
    row: InstanceRecord,
    client: AgentClient
  ): Promise<
    | { kind: 'present'; agent: AgentInstance }
    | { kind: 'absent' }
    | { kind: 'unknown' }
  > {
    try {
      const agent = await client.get(row.id)
      return agent === undefined
        ? { kind: 'absent' }
        : { kind: 'present', agent }
    } catch (error) {
      this.deps.logger.warn(
        {
          instanceId: row.id,
          hostId: row.hostId,
          err: error instanceof Error ? error.message : String(error),
        },
        'reconciler: per-id get failed, keeping row unchanged'
      )
      return { kind: 'unknown' }
    }
  }

  /** True when the agent reports a deadline covering the controller deadline. */
  private agentDeadlineSynced(
    row: InstanceRecord,
    agent: AgentInstance,
    clock: ClockEstimate
  ): boolean {
    return agent.expiresAtMs - clock.skewMs - clock.slackMs >= row.expiresAtMs
  }

  private async syncExpiry(
    row: InstanceRecord,
    client: AgentClient,
    clock: ClockEstimate
  ): Promise<void> {
    const { store, logger } = this.deps
    const target = row.expiresAtMs + clock.skewMs + clock.slackMs
    try {
      const confirmed = await client.extend(row.id, target)
      // Only trust a confirmation that covers the row's translated deadline.
      if (confirmed.expiresAtMs >= target) {
        store.setExpirySyncedFor(row.id, row.expiresAtMs, true)
      } else {
        logger.warn(
          {
            instanceId: row.id,
            hostId: row.hostId,
            wanted: target,
            got: confirmed.expiresAtMs,
          },
          'reconciler: agent did not confirm the requested deadline'
        )
      }
    } catch (error) {
      if (isMissingOnExtend(error)) {
        if (row.state === 'running') {
          store.casStateSnapshot(row, 'errored', this.deps.now(), {
            message: LOST_MESSAGE,
            endpoints: null,
          })
        }
        return
      }
      logger.warn(
        {
          instanceId: row.id,
          hostId: row.hostId,
          err: error instanceof Error ? error.message : String(error),
        },
        'reconciler: failed to push expiry, will retry'
      )
    }
  }

  private async confirmDelete(
    row: InstanceRecord,
    client: AgentClient
  ): Promise<void> {
    const { store } = this.deps
    try {
      // Only a resolving delete (2xx or verified instance absence) proves the
      // agent wrote its tombstone; an unrecognised 404 throws.
      await client.delete(row.id)
      store.deleteInstanceIfState(row.id, 'deleting')
    } catch {
      // Otherwise keep the row `deleting`; the next tick retries.
    }
  }

  private async reconcileLost(
    row: InstanceRecord,
    client: AgentClient
  ): Promise<void> {
    const { store } = this.deps
    try {
      await client.delete(row.id)
      store.deleteInstanceIfState(row.id, 'lost')
    } catch {
      // Keep the tombstone; the next tick retries.
    }
  }

  /**
   * Garbage-collect `errored` rows superseded by a newer row for the same key.
   * The agent delete is confirmed (200/404) before the DB row is removed; an
   * unreachable host leaves it for the next sweep.
   */
  private async sweepErrored(): Promise<void> {
    const { store, clients, logger } = this.deps
    for (const row of store.listSupersededErrored()) {
      const client = clients[row.hostId]
      if (client === undefined) continue
      try {
        await client.delete(row.id)
        store.deleteInstanceIfState(row.id, 'errored')
        logger.info(
          { instanceId: row.id, hostId: row.hostId },
          'reconciler: garbage-collected superseded errored instance'
        )
      } catch {
        // Unconfirmed: keep the tombstone for the next sweep.
      }
    }
  }
}
