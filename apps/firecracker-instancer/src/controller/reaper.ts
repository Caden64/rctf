/**
 * Expiry reaper: claims LIVE rows (`creating` or `running`) whose deadline
 * passed with a CAS to `deleting`, then tells the agent to tear them down.
 * Including `creating` fences a create that outlived its deadline: the DELETE
 * writes the agent tombstone, so a late PUT completion can never leak a VM.
 * Extend and the reaper race on the same row inside `BEGIN IMMEDIATE`
 * transactions, so exactly one of them wins.
 *
 * A row keeps its reservation while it is `deleting`: only an agent response
 * that proves teardown/fencing (2xx or an instance-specific absence) removes
 * the row and frees the resources. An ambiguous 404/transport failure keeps
 * the row fenced for the next tick.
 */
import {
  AgentUnreachableError,
  type AgentClient,
  type Clock,
} from '../interfaces'
import type { Logger } from '../log'
import { Store } from './store'

export interface ReaperDeps {
  store: Store
  clients: Record<string, AgentClient>
  now: Clock
  logger: Logger
}

export interface ReaperTickResult {
  claimed: string[]
  removed: string[]
}

export class Reaper {
  private ticking = false

  constructor(private readonly deps: ReaperDeps) {}

  async tick(): Promise<ReaperTickResult> {
    if (this.ticking) return { claimed: [], removed: [] }
    this.ticking = true
    try {
      return await this.runOnce()
    } finally {
      this.ticking = false
    }
  }

  private async runOnce(): Promise<ReaperTickResult> {
    const { store, clients, now, logger } = this.deps
    const claimed: string[] = []

    store.transaction(() => {
      const at = now()
      for (const row of store.listExpiredClaimable(at)) {
        if (store.claimExpired(row.id, at)) {
          claimed.push(row.id)
        }
      }
    })

    const removed: string[] = []
    for (const id of claimed) {
      const row = store.getInstance(id)
      if (!row) continue
      const client = clients[row.hostId]
      if (client === undefined) {
        logger.warn(
          { instanceId: id, hostId: row.hostId },
          'reaper: no client for host, row stays deleting'
        )
        continue
      }
      try {
        // Only a resolving delete (2xx or verified instance absence) confirms
        // the agent wrote its tombstone; an ambiguous 404 throws.
        await client.delete(id)
        if (store.deleteInstanceIfState(id, 'deleting')) removed.push(id)
      } catch (error) {
        if (error instanceof AgentUnreachableError) {
          logger.warn(
            { instanceId: id, hostId: row.hostId },
            'reaper: host unreachable, teardown will be retried'
          )
        } else {
          logger.warn(
            {
              instanceId: id,
              hostId: row.hostId,
              err: error instanceof Error ? error.message : String(error),
            },
            'reaper: agent rejected teardown, will retry'
          )
        }
      }
    }

    return { claimed, removed }
  }
}
