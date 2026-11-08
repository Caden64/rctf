/**
 * Expiry reaper: claims `running` rows whose deadline passed with a CAS to
 * `deleting`, then tells the agent to tear them down. Extend and the reaper
 * race on the same row inside `BEGIN IMMEDIATE` transactions, so exactly one
 * of them wins.
 *
 * A row keeps its reservation while it is `deleting`: only a confirmed agent
 * delete (or 404) removes the row and frees the resources.
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
      for (const row of store.listExpiredRunning(at)) {
        if (store.claimExpiredRunning(row.id, at)) {
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
