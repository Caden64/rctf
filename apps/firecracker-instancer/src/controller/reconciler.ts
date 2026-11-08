/**
 * DB <-> agent reconciliation. The controller SQLite database owns ownership
 * and reservations; the agent owns what physically exists. Each tick compares
 * the two for every reachable host and repairs both directions with CAS
 * updates, so it is safe to run concurrently with player requests.
 *
 * - creating rows: adopt the agent record (promote to running/errored) or, if
 *   the agent never saw the instance, clean the row so the team can retry.
 * - running rows missing on the agent: `errored` ("instance lost on host").
 * - unsynced deadlines: re-push to the agent (agent keeps the max).
 * - deleting rows: retry the teardown.
 * - lost tombstones: delete the agent side when the host returns.
 * - agent ids unknown to the DB: delete after a short grace (in-flight creates).
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
        const agentInstances = await client.list()
        await this.reconcileHost(host.id, client, agentInstances)
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
  }

  private async reconcileHost(
    hostId: string,
    client: AgentClient,
    agentInstances: readonly AgentInstance[]
  ): Promise<void> {
    const { store, now, logger } = this.deps
    const rows = store.listInstancesForHost(hostId)
    const agentById = new Map(
      agentInstances.map(instance => [instance.id, instance])
    )

    for (const row of rows) {
      switch (row.state) {
        case 'reserving':
          // Placement inserts as `creating`; a reserving row is never orphaned.
          break
        case 'creating':
          await this.reconcileCreating(row, agentById.get(row.id), client)
          break
        case 'running':
          await this.reconcileRunning(row, agentById.get(row.id), client)
          break
        case 'deleting':
          await this.reconcileDeleting(row, client)
          break
        case 'lost':
          await this.reconcileLost(row, client)
          break
        case 'errored':
          // Terminal-until-delete; visible to the player until they delete it.
          break
      }
    }

    // Agent records nobody owns. Skip a short grace so a create that is still
    // on the wire is not torn down, and never rows still in `reserving`.
    const graceMs = (this.deps.config.orphanGraceSeconds ?? 30) * 1000
    const at = now()
    for (const agent of agentInstances) {
      const known = store.getInstance(agent.id)
      if (known !== null) {
        // A row exists (possibly on another host / mid-request); never treat it
        // as an orphan.
        continue
      }
      if (at - agent.createdAtMs < graceMs) continue
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
    agent: AgentInstance | undefined,
    client: AgentClient
  ): Promise<void> {
    const { store, now, logger } = this.deps
    if (this.deps.isCreateInFlight(row.id)) return

    if (agent === undefined) {
      if (store.deleteInstanceIfState(row.id, 'creating')) {
        logger.warn(
          { instanceId: row.id, hostId: row.hostId },
          'reconciler: create never reached agent, reservation released'
        )
      }
      return
    }

    const endpoints = controllerEndpoints(row.expose, agent.endpoints)
    switch (agent.state) {
      case 'running':
        store.casState(row.id, ['creating'], 'running', now(), {
          endpoints,
          message: null,
          agentExpirySynced: true,
        })
        break
      case 'errored': {
        store.casState(row.id, ['creating'], 'errored', now(), {
          message: agent.message ?? 'instance failed to start',
          endpoints: null,
        })
        break
      }
      case 'stopping':
      case 'stopped': {
        if (store.casState(row.id, ['creating'], 'deleting', now())) {
          await this.confirmDelete(row, client)
        }
        break
      }
      default:
        // creating/starting: note progress (endpoints may be empty) but keep
        // the row in `creating` until the agent reports running.
        store.casState(row.id, ['creating'], 'creating', now(), { endpoints })
        break
    }
  }

  private async reconcileRunning(
    row: InstanceRecord,
    agent: AgentInstance | undefined,
    client: AgentClient
  ): Promise<void> {
    const { store, now } = this.deps
    if (agent === undefined) {
      store.casState(row.id, ['running'], 'errored', now(), {
        message: LOST_MESSAGE,
        endpoints: null,
      })
      return
    }

    const endpoints = controllerEndpoints(row.expose, agent.endpoints)
    switch (agent.state) {
      case 'errored':
        store.casState(row.id, ['running'], 'errored', now(), {
          message: agent.message ?? 'instance failed on host',
          endpoints: null,
        })
        return
      case 'stopping':
      case 'stopped':
        if (
          store.casState(row.id, ['running'], 'deleting', now(), { endpoints })
        ) {
          await this.confirmDelete(row, client)
        }
        return
      default:
        break
    }

    store.casState(row.id, ['running'], 'running', now(), { endpoints })

    if (!row.agentExpirySynced || agent.expiresAtMs < row.expiresAtMs) {
      await this.syncExpiry(row, client)
    }
  }

  private async syncExpiry(
    row: InstanceRecord,
    client: AgentClient
  ): Promise<void> {
    const { store, logger } = this.deps
    try {
      await client.extend(row.id, row.expiresAtMs)
      store.setExpirySyncedFor(row.id, row.expiresAtMs, true)
    } catch (error) {
      if (
        error instanceof AgentRejectedError &&
        (error.code === 'not_found' || error.code === 'expired')
      ) {
        store.casState(row.id, ['running'], 'errored', this.deps.now(), {
          message: LOST_MESSAGE,
          endpoints: null,
        })
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

  private async reconcileDeleting(
    row: InstanceRecord,
    client: AgentClient
  ): Promise<void> {
    await this.confirmDelete(row, client)
  }

  private async confirmDelete(
    row: InstanceRecord,
    client: AgentClient
  ): Promise<void> {
    const { store } = this.deps
    try {
      await client.delete(row.id)
      store.deleteInstanceIfState(row.id, 'deleting')
    } catch (error) {
      if (
        error instanceof AgentRejectedError &&
        (error.code === 'not_found' || error.code === 'expired')
      ) {
        store.deleteInstanceIfState(row.id, 'deleting')
      }
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
    } catch (error) {
      if (
        error instanceof AgentRejectedError &&
        (error.code === 'not_found' || error.code === 'expired')
      ) {
        store.deleteInstanceIfState(row.id, 'lost')
      }
    }
  }
}
