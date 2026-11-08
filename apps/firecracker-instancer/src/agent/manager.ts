import {
  GUEST_METADATA_VERSION,
  INSTANCE_ID_REGEX,
  ProtocolError,
  type AgentInfo,
  type AgentInstance,
  type AgentInstanceSpec,
  type AgentInstanceState,
} from '@rctf/firecracker-protocol'
import type {
  Clock,
  InstanceManager,
  NetExposeRequest,
  NetLease,
  NetworkManager,
  VmDriver,
  VmHandle,
} from '../interfaces'
import { NetworkCapacityError } from '../interfaces'
import { createLogger, type Logger } from '../log'
import type { AgentConfig } from './config'
import {
  StateReadError,
  StateStore,
  TombstoneStore,
  buildStoredInstance,
  computeSpecHash,
  leaseToJson,
  type StateLoadResult,
  type StoredInstance,
} from './state'

/** Serialises critical sections; callers never nest the same mutex. */
class Mutex {
  private tail: Promise<void> = Promise.resolve()

  async run<T>(fn: () => Promise<T>): Promise<T> {
    let release!: () => void
    const next = new Promise<void>(resolve => {
      release = resolve
    })
    const previous = this.tail
    this.tail = previous.then(() => next)
    await previous
    try {
      return await fn()
    } finally {
      release()
    }
  }
}

/** Bounded worker slots for independent per-instance sweeps. */
class Semaphore {
  private active = 0
  private readonly waiters: (() => void)[] = []

  constructor(private readonly limit: number) {}

  private acquire(): Promise<void> {
    if (this.active < this.limit) {
      this.active += 1
      return Promise.resolve()
    }
    return new Promise<void>(resolve => {
      this.waiters.push(resolve)
    })
  }

  private release(): void {
    const next = this.waiters.shift()
    if (next) next()
    else this.active -= 1
  }

  async run<T>(fn: () => Promise<T>): Promise<T> {
    await this.acquire()
    try {
      return await fn()
    } finally {
      this.release()
    }
  }
}

interface BootTask {
  controller: AbortController
  promise: Promise<void>
}

/**
 * One resource-acquiring call (allocate/launch/publish) whose outcome is not
 * known yet because it outlived the operation deadline. `settled` is created
 * exactly once so repeated retries never attach another reaction to the
 * still-pending operation (that leaked memory with never-settling calls).
 */
interface PendingOperation {
  /** The underlying driver/network call (possibly a thenable in tests). */
  promise: PromiseLike<unknown>
  /** Resolves when `promise` settles, successfully or not. */
  settled: Promise<void>
  settledFlag: boolean
  startedAtMs: number
  label: string
  abandonLogged: boolean
}

interface Entry {
  id: string
  mutex: Mutex
  refs: number
  record?: StoredInstance
  boot?: BootTask
  /**
   * Resource-acquiring calls (allocate/launch/publish) whose outcome is not
   * known yet because they outlived the operation deadline. Teardown must not
   * release anything until these settle: a late call could create a lease/VM
   * after the release and leave an unowned guest behind.
   */
  pendingOps: Set<PendingOperation>
  /** Shared settlement promise for the current pending set (never re-wrapped). */
  settlement?: Promise<void>
}

const TERMINAL_STATES: ReadonlySet<AgentInstanceState> = new Set([
  'errored',
  'stopped',
])

const isLiveState = (state: AgentInstanceState): boolean =>
  !TERMINAL_STATES.has(state)

const exposeRequests = (spec: StoredInstance['spec']): NetExposeRequest[] =>
  spec.expose.map(item => ({
    kind: item.kind,
    hostPrefix: item.hostPrefix,
    port: item.port,
  }))

/**
 * The frozen NetLease gained a required `expose` list in a later contract
 * revision. Backfill it from the stored spec when loading a record written by
 * an older agent so `net.restore` can still rebuild every route.
 */
const leaseWithExpose = (
  lease: StoredInstance['lease'],
  spec: StoredInstance['spec']
): NetLease => {
  const current = lease as NetLease & { expose?: NetExposeRequest[] }
  return {
    ...current,
    expose: current.expose ?? exposeRequests(spec),
  } as NetLease
}

/** Fixed, secret-free persisted failure messages. Never driver text. */
/** Preflight checks that are reported but never block placement. */
const INFORMATIONAL_CHECKS: ReadonlySet<string> = new Set(['reflink'])

const FAILURE_MESSAGES = {
  allocate: 'network allocation failed',
  launch: 'launch failed',
  publish: 'network publish failed',
  persist: 'failed to persist instance state',
  readiness: 'readiness timed out',
  restart: 'agent restarted during provisioning',
  invalidLease: 'invalid network lease',
} as const

type FailureKind = keyof typeof FAILURE_MESSAGES

/** A write-ahead persistence failure (must not be retried as a driver error). */
class PersistFailure extends Error {
  constructor() {
    super('failed to persist instance state')
    this.name = 'PersistFailure'
  }
}

class OperationTimeoutError extends Error {
  constructor(operation: string) {
    super(`operation timed out: ${operation}`)
    this.name = 'OperationTimeoutError'
  }
}

type TeardownOutcome = 'done' | 'incomplete' | 'fence_failed'

/**
 * The host agent's instance manager.
 *
 * Everything that allocates host resources happens under a per-instance mutex;
 * admission (capacity) is serialised under one global mutex. Durability is
 * write-ahead: the record is persisted before any side effect, and each newly
 * acquired resource (lease, VM handle) is persisted before the next step.
 */
export const createInstanceManager = (deps: {
  config: AgentConfig
  vm: VmDriver
  net: NetworkManager
  now?: Clock
  logger?: Logger
  /** Expiry/liveness sweep period. Default 1s. */
  sweepIntervalMs?: number
  /** How long an errored tombstone is kept. Default 10 min. */
  erroredTtlMs?: number
  /** How long deleted ids are fenced. Default 24 h. */
  tombstoneTtlMs?: number
  /** Grace before destroying unknown VMs at startup. Default 0. */
  orphanGraceMs?: number
  /** Per driver/network operation deadline. Default 30s. */
  operationTimeoutMs?: number
  /** Parallel per-instance sweeps. Default 8. */
  sweepConcurrency?: number
  /** Sweeps between full orphan re-discovery. Default 30 (≈30s at 1s). */
  orphanScanSweeps?: number
  /** Injectable stores (tests use faults); defaults to the real ones. */
  store?: StateStore
  tombstones?: TombstoneStore
  version?: string
}): InstanceManager => {
  const { config, vm, net } = deps
  const now: Clock = deps.now ?? Date.now
  const logger = deps.logger ?? createLogger('firecracker-agent', 'silent')
  const store =
    deps.store ??
    new StateStore(config.stateDir ?? '/var/lib/rctf-firecracker/state', logger)
  const tombstones =
    deps.tombstones ??
    new TombstoneStore(store.directory, logger, undefined, now)
  const expiryGraceMs = (config.expiryGraceSeconds ?? 120) * 1000
  const erroredTtlMs =
    deps.erroredTtlMs ?? (config.erroredTtlSeconds ?? 600) * 1000
  const tombstoneTtlMs =
    deps.tombstoneTtlMs ?? (config.tombstoneTtlSeconds ?? 86400) * 1000
  const sweepIntervalMs = deps.sweepIntervalMs ?? 1000
  const orphanGraceMs = deps.orphanGraceMs ?? 0
  const operationTimeoutMs = deps.operationTimeoutMs ?? 30_000
  const sweepConcurrency = deps.sweepConcurrency ?? 8
  const orphanScanSweeps = Math.max(1, deps.orphanScanSweeps ?? 30)
  const shutdownTimeoutMs = (config.shutdownTimeoutSeconds ?? 15) * 1000
  const version = deps.version ?? '0.0.0'
  /**
   * Teardown (DELETE) waits at most this long for an unsettled provisioning
   * call to settle before keeping the record `stopping` and retrying on the
   * sweep. Sweeps never wait at all: they skip the entry for this pass.
   */
  const pendingOperationGraceMs = Math.max(operationTimeoutMs * 4, 1)
  /**
   * After this long an unsettled operation is reported loudly and takes the
   * host out of rotation. It is NEVER forgotten: the late call may still create
   * a lease/VM, so ownership and capacity stay accounted until it settles.
   */
  const pendingOperationAbandonMs = Math.max(
    (config.pendingOperationAbandonSeconds ?? 900) * 1000,
    1
  )

  const entries = new Map<string, Entry>()
  const entriesLock = new Mutex()
  const admissionLock = new Mutex()
  const sweepSlots = new Semaphore(sweepConcurrency)
  const sweepInFlight = new Set<string>()

  let timer: ReturnType<typeof setInterval> | undefined
  let shuttingDown = false
  /** False until restore + orphan cleanup have both succeeded. */
  let recovered = false
  /** False until the state/tombstone files were read successfully. */
  let stateLoaded = false
  let recoveryInFlight: Promise<void> | undefined
  let activeOps = 0
  /** Orphan VM ids whose destruction has not been confirmed yet. */
  const orphanBacklog = new Set<string>()
  let orphanScanInFlight = false
  let sweepsSinceOrphanScan = 0

  const beginOp = (): void => {
    activeOps += 1
  }
  const endOp = (): void => {
    if (activeOps > 0) activeOps -= 1
  }

  /**
   * Never surface arbitrary driver/network exception text: it can contain the
   * request spec (including flags) in ways string redaction cannot reliably
   * undo. Only our own ProtocolError messages are safe to log.
   */
  const logOperationError = (
    instanceId: string,
    operation: string,
    err: unknown
  ): void => {
    const fields: Record<string, unknown> = {
      instanceId,
      operation,
      errorType: err instanceof Error ? err.name : typeof err,
    }
    if (err instanceof ProtocolError) fields.error = err.message
    logger.warn(fields, 'firecracker instance operation failed')
  }

  const runOperation = async <T>(
    instanceId: string,
    operation: string,
    fn: () => Promise<T>,
    timeoutMs = operationTimeoutMs
  ): Promise<T> => {
    let timerHandle: ReturnType<typeof setTimeout> | undefined
    try {
      return await Promise.race([
        fn(),
        new Promise<T>((_resolve, reject) => {
          timerHandle = setTimeout(
            () => reject(new OperationTimeoutError(operation)),
            Math.max(1, timeoutMs)
          )
          if (typeof timerHandle.unref === 'function') timerHandle.unref()
        }),
      ])
    } finally {
      if (timerHandle) clearTimeout(timerHandle)
    }
  }

  /**
   * Like `runOperation`, but keeps the underlying promise on the entry until it
   * actually settles. A timed-out call keeps running (it may still create a VM
   * or a lease), so teardown must wait for it before releasing anything.
   */
  const trackProvisioning = <T>(
    entry: Entry,
    label: string,
    fn: () => Promise<T>
  ): Promise<T> => {
    // Keep the caller's promise itself (never re-wrap it), so the settlement
    // notification below is the only reaction ever attached to it.
    const operation = fn()
    const pending: PendingOperation = {
      promise: operation,
      settled: Promise.resolve(),
      settledFlag: false,
      startedAtMs: now(),
      label,
      abandonLogged: false,
    }
    pending.settled = Promise.resolve(operation).then(
      () => {
        pending.settledFlag = true
      },
      () => {
        pending.settledFlag = true
      }
    )
    entry.pendingOps.add(pending)
    void pending.settled.then(() => {
      entry.pendingOps.delete(pending)
      if (entry.pendingOps.size === 0) entry.settlement = undefined
    })
    return operation
  }

  /**
   * The single shared promise that resolves when every currently tracked
   * operation has settled. Created once per pending set; retries await it
   * instead of building another `Promise.allSettled` over the same promises.
   */
  const pendingSettlement = (entry: Entry): Promise<void> => {
    if (entry.settlement !== undefined) return entry.settlement
    const current = (async () => {
      while (entry.pendingOps.size > 0) {
        await Promise.all([...entry.pendingOps].map(pending => pending.settled))
      }
    })()
    entry.settlement = current
    void current.finally(() => {
      if (entry.settlement === current && entry.pendingOps.size === 0) {
        entry.settlement = undefined
      }
    })
    return current
  }

  /**
   * DELETE waits (bounded) for every tracked provisioning call to settle.
   * NEVER call this from the sweep: a worker slot must not block on an
   * operation that may never settle (see `hasPendingOperations`).
   */
  const waitForPendingOperations = async (entry: Entry): Promise<boolean> => {
    if (entry.pendingOps.size === 0) return true
    let handle: ReturnType<typeof setTimeout> | undefined
    const timedOut = new Promise<boolean>(resolve => {
      handle = setTimeout(
        () => resolve(false),
        Math.max(1, pendingOperationGraceMs)
      )
      if (typeof handle.unref === 'function') handle.unref()
    })
    try {
      return await Promise.race([
        pendingSettlement(entry).then(() => true),
        timedOut,
      ])
    } finally {
      if (handle) clearTimeout(handle)
    }
  }

  const hasPendingOperations = (entry: Entry): boolean =>
    entry.pendingOps.size > 0

  /** True while any operation is older than the configured abandon window. */
  const hasStalledOperations = (): boolean => {
    const threshold = now() - pendingOperationAbandonMs
    for (const entry of entries.values()) {
      for (const pending of entry.pendingOps) {
        if (pending.startedAtMs <= threshold) return true
      }
    }
    return false
  }

  /** Loud, once-per-operation report; ownership is deliberately retained. */
  const reportStalledOperations = (): void => {
    const threshold = now() - pendingOperationAbandonMs
    for (const entry of entries.values()) {
      for (const pending of entry.pendingOps) {
        if (pending.abandonLogged || pending.startedAtMs > threshold) continue
        pending.abandonLogged = true
        logger.error(
          {
            instanceId: entry.id,
            operation: pending.label,
            pendingMs: now() - pending.startedAtMs,
            pendingOperationAbandonSeconds:
              config.pendingOperationAbandonSeconds ?? 900,
          },
          'provisioning operation has not settled; keeping its ownership and capacity and refusing new placements until it settles or the agent restarts'
        )
      }
    }
  }

  const persistBestEffort = async (
    entry: Entry,
    operation: string
  ): Promise<void> => {
    const record = entry.record
    if (!record) return
    try {
      await store.save(record)
    } catch (err) {
      logOperationError(entry.id, operation, err)
    }
  }

  const toAgentInstance = (record: StoredInstance): AgentInstance => ({
    id: record.id,
    state: record.state,
    ...(record.message === undefined ? {} : { message: record.message }),
    createdAtMs: record.createdAtMs,
    expiresAtMs: record.expiresAtMs,
    endpoints: record.lease
      ? net.endpoints(
          leaseWithExpose(record.lease, record.spec),
          exposeRequests(record.spec)
        )
      : [],
    specHash: record.specHash,
  })

  /**
   * Capacity is held by every record that still owns a lease or a VM (or may
   * own one: its allocation/launch outcome is not known yet), or is in a
   * non-terminal state. An errored record whose cleanup is still pending keeps
   * its reservation until release is confirmed.
   */
  const holdsResources = (record: StoredInstance): boolean =>
    record.lease !== undefined ||
    record.vm !== undefined ||
    record.vmPendingDestroy === true ||
    record.netMayHold === true ||
    record.vmMayHold === true ||
    isLiveState(record.state)

  const usage = (): AgentInfo['usage'] => {
    let vcpus = 0
    let memMiB = 0
    let diskMiB = 0
    let instances = 0
    for (const entry of entries.values()) {
      const record = entry.record
      if (!record || !holdsResources(record)) continue
      vcpus += record.spec.vcpus
      memMiB += record.spec.memMiB
      diskMiB += record.spec.diskMiB
      instances += 1
    }
    return { vcpus, memMiB, diskMiB, instances }
  }

  const obtainEntry = async (id: string): Promise<Entry> =>
    entriesLock.run(async () => {
      let entry = entries.get(id)
      if (!entry) {
        entry = { id, mutex: new Mutex(), refs: 0, pendingOps: new Set() }
        entries.set(id, entry)
      }
      entry.refs += 1
      return entry
    })

  const releaseEntry = async (entry: Entry): Promise<void> => {
    await entriesLock.run(async () => {
      entry.refs -= 1
      if (entry.refs === 0 && !entry.record) entries.delete(entry.id)
    })
  }

  const dropIdleEntry = async (entry: Entry): Promise<void> => {
    await entriesLock.run(async () => {
      if (entry.refs === 0 && !entry.record) entries.delete(entry.id)
    })
  }

  /**
   * Reverse-order resource release. Ownership of each resource is cleared only
   * after that resource's release is confirmed; a failed step keeps the handle
   * so the sweep retries (all calls are idempotent).
   *
   * A still-running provisioning call is awaited first: releasing before it
   * settles could leave a lease/VM created after the release. When it does not
   * settle within the grace cap nothing is released and the caller keeps the
   * record so the sweep retries.
   */
  const releaseResources = async (
    entry: Entry,
    opts: { waitForPending?: boolean } = {}
  ): Promise<boolean> => {
    const record = entry.record
    if (!record) return true

    if (hasPendingOperations(entry)) {
      // The sweep must never block a worker slot on a call that may never
      // settle: skip this entry for this pass (it is retried next sweep) so
      // unrelated instances' expiry/liveness checks keep running. DELETE (the
      // only caller that waits) reports `in_progress` instead.
      if (!opts.waitForPending) return false
      if (!(await waitForPendingOperations(entry))) {
        logOperationError(
          record.id,
          'provisioning settle',
          new OperationTimeoutError('provisioning')
        )
        return false
      }
    }

    const current = entry.record ?? record
    const id = current.id
    // `netMayHold`/`vmMayHold` mean "a resource may exist even without a
    // persisted handle"; release/destroy are idempotent by id, so they are
    // always attempted unconditionally, not only when a handle was saved.
    const mayHoldNet =
      current.lease !== undefined || current.netMayHold === true
    const mayHoldVm =
      current.vm !== undefined ||
      current.vmPendingDestroy === true ||
      current.vmMayHold === true
    let vmReleased = !mayHoldVm
    let leaseReleased = !mayHoldNet

    if (current.lease) {
      try {
        await runOperation(id, 'net.unpublish', () => net.unpublish(id))
      } catch (err) {
        logOperationError(id, 'net.unpublish', err)
      }
    }
    if (mayHoldVm) {
      if (current.vm) {
        try {
          await runOperation(id, 'vm.stop', () =>
            vm.stop(current.vm as VmHandle, { graceMs: 2000 })
          )
        } catch (err) {
          logOperationError(id, 'vm.stop', err)
        }
      }
      try {
        await runOperation(id, 'vm.destroy', () => vm.destroy(id))
        vmReleased = true
      } catch (err) {
        logOperationError(id, 'vm.destroy', err)
        vmReleased = false
      }
    }
    if (mayHoldNet) {
      try {
        await runOperation(id, 'net.release', () => net.release(id))
        leaseReleased = true
      } catch (err) {
        logOperationError(id, 'net.release', err)
      }
    }

    const next: StoredInstance = { ...current }
    if (vmReleased) {
      next.vm = undefined
      next.vmPendingDestroy = undefined
      next.vmMayHold = undefined
    }
    if (leaseReleased) {
      next.lease = undefined
      next.netMayHold = undefined
    }
    entry.record = next
    return vmReleased && leaseReleased
  }

  /**
   * Mark an instance errored and release its resources. The errored record (and
   * any resource that could not be confirmed released) stays on disk so a
   * sweep retries and capacity stays reserved until the cleanup is complete.
   */
  const failToErroredLocked = async (
    entry: Entry,
    message: string
  ): Promise<void> => {
    const record = entry.record
    if (!record) return
    entry.boot?.controller.abort()
    // Release first, then publish the terminal state: callers waiting for
    // `errored` must observe it only after cleanup was attempted. Ownership of
    // anything not confirmed released stays in the record for the sweep.
    await releaseResources(entry)
    const current = entry.record ?? record
    entry.record = { ...current, state: 'errored', message, updatedAtMs: now() }
    await persistBestEffort(entry, 'persist errored')
  }

  /**
   * Cancel a boot, persist `stopping`, tear every resource down, durably fence
   * the id and only then remove the record. Returns `incomplete` when cleanup
   * failed and `fence_failed` when the tombstone could not be persisted; both
   * leave a stopping record so the next DELETE/sweep retries.
   */
  const teardownLocked = async (
    entry: Entry,
    opts: { waitForPending?: boolean } = {}
  ): Promise<TeardownOutcome> => {
    const record = entry.record
    if (!record) return 'done'
    entry.boot?.controller.abort()
    const stopping: StoredInstance = {
      ...record,
      state: 'stopping',
      message: undefined,
      updatedAtMs: now(),
    }
    entry.record = stopping
    try {
      await store.save(stopping)
    } catch (err) {
      logOperationError(record.id, 'persist stopping', err)
      return 'incomplete'
    }

    const ok = await releaseResources(entry, opts)
    const current = entry.record ?? stopping
    entry.record = { ...current, state: 'stopping', updatedAtMs: now() }
    if (!ok) {
      await persistBestEffort(entry, 'persist stopping cleanup')
      return 'incomplete'
    }

    try {
      // Fence BEFORE acknowledging anything: a delayed PUT must never win.
      await tombstones.save(record.id, now())
    } catch (err) {
      logOperationError(record.id, 'tombstone.persist', err)
      await persistBestEffort(entry, 'persist stopping fence')
      return 'fence_failed'
    }

    try {
      await store.remove(record.id)
    } catch (err) {
      logOperationError(record.id, 'state.remove', err)
      await persistBestEffort(entry, 'persist stopping remove')
      return 'incomplete'
    }
    entry.record = undefined
    await dropIdleEntry(entry)
    return 'done'
  }

  const markVmDeadLocked = async (
    entry: Entry,
    message = 'vm died'
  ): Promise<void> => {
    await failToErroredLocked(entry, message)
  }

  const startBoot = (entry: Entry): void => {
    const record = entry.record
    if (!record?.vm || !record.lease) return
    // Only a record that is actively waiting for readiness may boot.
    if (record.state !== 'starting') return
    entry.boot?.controller.abort()
    const controller = new AbortController()

    const task: BootTask = {
      controller,
      promise: Promise.resolve(),
    }
    entry.boot = task
    beginOp()

    task.promise = (async () => {
      try {
        if (!record.lease?.guestIp) {
          // Never fall back to hostIp: readiness must probe the guest.
          await entry.mutex.run(async () => {
            const current = entry.record
            if (!current || current.state !== 'starting') return
            await markVmDeadLocked(entry, FAILURE_MESSAGES.invalidLease)
          })
          return
        }
        const bootTimeoutMs = record.spec.bootTimeoutSeconds * 1000
        const lease = record.lease
        const vmHandle = record.vm as VmHandle
        await runOperation(
          record.id,
          'waitReady',
          () =>
            vm.waitReady(
              vmHandle,
              {
                readiness: record.spec.readiness,
                guestIp: lease.guestIp,
                timeoutMs: bootTimeoutMs,
              },
              controller.signal
            ),
          Math.max(operationTimeoutMs, bootTimeoutMs + 5000)
        )
        await entry.mutex.run(async () => {
          if (shuttingDown) return
          if (entries.get(entry.id) !== entry) return
          const current = entry.record
          if (!current || current.state !== 'starting') return
          entry.record = {
            ...current,
            state: 'running',
            message: undefined,
            updatedAtMs: now(),
          }
          await persistBestEffort(entry, 'persist running')
        })
      } catch (err) {
        if (shuttingDown || controller.signal.aborted) return
        try {
          await entry.mutex.run(async () => {
            if (shuttingDown) return
            if (entries.get(entry.id) !== entry) return
            const current = entry.record
            if (!current || current.state !== 'starting') return
            logOperationError(current.id, 'waitReady', err)
            await markVmDeadLocked(entry, FAILURE_MESSAGES.readiness)
          })
        } catch (cleanupErr) {
          logOperationError(entry.id, 'boot cleanup', cleanupErr)
        }
      }
    })().finally(() => {
      endOp()
    })

    void task.promise.then(
      () => {
        if (entry.boot === task) entry.boot = undefined
      },
      () => {
        if (entry.boot === task) entry.boot = undefined
      }
    )
  }

  const createLocked = async (
    entry: Entry,
    spec: AgentInstanceSpec
  ): Promise<AgentInstance> => {
    try {
      await tombstones.ensureLoaded()
    } catch (err) {
      // Without the fences we cannot prove an id was not deleted: fail closed
      // (the sweep retries loading and the controller retries the create).
      logOperationError(spec.id, 'tombstones.load', err)
      throw new ProtocolError(
        'host_unavailable',
        'agent tombstones are unavailable'
      )
    }
    if (tombstones.has(spec.id)) {
      throw new ProtocolError('conflict', 'instance id was deleted')
    }
    const specHash = computeSpecHash(spec)
    const existing = entry.record
    if (existing) {
      if (existing.specHash !== specHash) {
        throw new ProtocolError(
          'spec_mismatch',
          'instance id already exists with a different spec'
        )
      }
      return toAgentInstance(existing)
    }

    await admissionLock.run(async () => {
      // Recovery and creates are serialised: until restore + orphan cleanup
      // have completed, a create could be undone by a later `net.restore()`
      // (which rebuilds from the snapshot taken before the new lease existed).
      if (!recovered) {
        throw new ProtocolError(
          'host_unavailable',
          'agent recovery is incomplete'
        )
      }
      if (orphanBacklog.size > 0) {
        throw new ProtocolError(
          'host_unavailable',
          'orphaned VMs still need cleanup'
        )
      }
      const current = usage()
      if (
        current.instances + 1 > config.capacity.maxInstances ||
        current.vcpus + spec.vcpus > config.capacity.vcpus ||
        current.memMiB + spec.memMiB > config.capacity.memMiB ||
        current.diskMiB + spec.diskMiB > config.capacity.diskMiB
      ) {
        throw new ProtocolError('no_capacity', 'host capacity exhausted')
      }
      entry.record = buildStoredInstance(spec, now(), 'creating')
    })
    let record = entry.record as StoredInstance

    // Write-ahead: the creating record exists before anything is allocated.
    try {
      await store.save(record)
    } catch (err) {
      logOperationError(spec.id, 'persist creating', err)
      entry.record = undefined
      throw new ProtocolError('internal', FAILURE_MESSAGES.persist)
    }

    const saveRecord = async (next: StoredInstance): Promise<void> => {
      entry.record = next
      try {
        await store.save(next)
      } catch (err) {
        logOperationError(spec.id, 'persist create progress', err)
        throw new PersistFailure()
      }
      record = next
    }

    let stage: FailureKind = 'allocate'
    try {
      // Write-ahead the ambiguity: from here on the id may own network
      // resources even if `net.allocate` never returns, so teardown always
      // calls `net.release(id)`.
      await saveRecord({
        ...record,
        netMayHold: true,
        updatedAtMs: now(),
      })
      const lease = await runOperation(spec.id, 'net.allocate', () =>
        trackProvisioning(entry, 'net.allocate', () =>
          net.allocate({
            instanceId: spec.id,
            egress: spec.egress,
            expose: exposeRequests(record.spec),
          })
        )
      )
      await saveRecord({
        ...record,
        lease: leaseToJson(lease),
        updatedAtMs: now(),
      })

      stage = 'launch'
      const firstPublicHostname =
        spec.expose
          .map((_, index) => lease.publicHostnames[index])
          .find(hostname => hostname !== undefined) ?? spec.id
      // Same ambiguity for the VM process: `vm.destroy(id)` must be attempted
      // even if the handle never reaches the record.
      await saveRecord({
        ...record,
        vmMayHold: true,
        updatedAtMs: now(),
      })
      const handle = await runOperation(spec.id, 'vm.launch', () =>
        trackProvisioning(entry, 'vm.launch', () =>
          vm.launch({
            instanceId: spec.id,
            image: spec.image,
            vcpus: spec.vcpus,
            memMiB: spec.memMiB,
            diskMiB: spec.diskMiB,
            ...(spec.kernelArgs === undefined
              ? {}
              : { kernelArgs: spec.kernelArgs }),
            lease,
            metadata: {
              rctf: {
                version: GUEST_METADATA_VERSION,
                instanceId: spec.id,
                hostname: firstPublicHostname,
                env: spec.env,
                // SECRET: memory only, handed straight to MMDS by the driver.
                flags: spec.flags,
              },
            },
          })
        )
      )
      await saveRecord({ ...record, vm: handle, updatedAtMs: now() })

      stage = 'publish'
      // A timed-out publish can still install routes after teardown released
      // the lease; track it so release happens only once it settled.
      await runOperation(spec.id, 'net.publish', () =>
        trackProvisioning(entry, 'net.publish', () =>
          net.publish(lease, exposeRequests(record.spec))
        )
      )

      await saveRecord({
        ...record,
        state: 'starting',
        message: undefined,
        updatedAtMs: now(),
      })
    } catch (err) {
      const kind: FailureKind =
        err instanceof PersistFailure ? 'persist' : stage
      logOperationError(spec.id, kind, err)
      await failToErroredLocked(entry, FAILURE_MESSAGES[kind])
      if (err instanceof NetworkCapacityError) {
        throw new ProtocolError(
          'no_capacity',
          'host network capacity exhausted'
        )
      }
      const current = entry.record
      if (!current) {
        throw new ProtocolError('internal', FAILURE_MESSAGES.persist)
      }
      return toAgentInstance(current)
    }

    startBoot(entry)
    return toAgentInstance(entry.record as StoredInstance)
  }

  const create = async (spec: AgentInstanceSpec): Promise<AgentInstance> => {
    if (config.draining || shuttingDown) {
      throw new ProtocolError('draining', 'agent is not accepting instances')
    }
    beginOp()
    try {
      const entry = await obtainEntry(spec.id)
      try {
        return await entry.mutex.run(async () => createLocked(entry, spec))
      } finally {
        await releaseEntry(entry)
      }
    } finally {
      endOp()
    }
  }

  const get = async (id: string): Promise<AgentInstance | undefined> => {
    const record = entries.get(id)?.record
    return record ? toAgentInstance(record) : undefined
  }

  const list = async (): Promise<AgentInstance[]> =>
    [...entries.values()]
      .map(entry => entry.record)
      .filter((record): record is StoredInstance => record !== undefined)
      .sort((a, b) => a.createdAtMs - b.createdAtMs)
      .map(toAgentInstance)

  const extend = async (
    id: string,
    expiresAtMs: number
  ): Promise<AgentInstance> => {
    if (!Number.isFinite(expiresAtMs)) {
      throw new ProtocolError('invalid_request', 'invalid expiry')
    }
    beginOp()
    try {
      const entry = await obtainEntry(id)
      try {
        return await entry.mutex.run(async () => {
          const record = entry.record
          if (!record) {
            throw new ProtocolError('not_found', 'instance not found')
          }
          // Accepted while the instance is live, including the grace window
          // after the nominal deadline: the controller may have committed an
          // extension before the old deadline whose PATCH arrived just after
          // it. This mutex is the same one the dead-man teardown runs under,
          // so exactly one of the two claims the instance: once teardown set
          // `stopping` (or finished), the deadline can no longer move.
          if (
            record.state === 'stopping' ||
            record.state === 'stopped' ||
            record.state === 'errored'
          ) {
            throw new ProtocolError('expired', 'instance is no longer live')
          }
          const next = Math.max(record.expiresAtMs, expiresAtMs)
          if (next === record.expiresAtMs) return toAgentInstance(record)
          const updated: StoredInstance = {
            ...record,
            expiresAtMs: next,
            updatedAtMs: now(),
          }
          // Persist first: a failed write must not leave a deadline that a
          // retry would then consider already durable and skip.
          await store.save(updated)
          entry.record = updated
          return toAgentInstance(updated)
        })
      } finally {
        await releaseEntry(entry)
      }
    } finally {
      endOp()
    }
  }

  const fenceTombstone = async (id: string): Promise<void> => {
    try {
      // Always rewrite: repeated DELETEs refresh the TTL, and a previous
      // failed write is retried until it is durable.
      await tombstones.save(id, now())
    } catch (err) {
      logOperationError(id, 'tombstone.persist', err)
      throw new ProtocolError('internal', 'failed to persist tombstone')
    }
  }

  const deleteInstance = async (id: string): Promise<AgentInstance> => {
    if (!INSTANCE_ID_REGEX.test(id)) {
      throw new ProtocolError('invalid_request', 'invalid instance id')
    }
    beginOp()
    try {
      const entry = await obtainEntry(id)
      try {
        return await entry.mutex.run(async () => {
          try {
            await tombstones.ensureLoaded()
          } catch (err) {
            logOperationError(id, 'tombstones.load', err)
            throw new ProtocolError(
              'host_unavailable',
              'agent tombstones are unavailable'
            )
          }
          const record = entry.record
          if (!record) {
            // Fence the id even though it is unknown/already finished. This is
            // what makes a delayed duplicate PUT unable to resurrect a VM. The
            // 404 is only sent once the tombstone is durable.
            await fenceTombstone(id)
            throw new ProtocolError('not_found', 'instance not found')
          }
          // DELETE is user/controller-driven: wait (bounded) for an unsettled
          // provisioning call, then answer `in_progress` if it is still open.
          const outcome = await teardownLocked(entry, { waitForPending: true })
          if (outcome === 'fence_failed') {
            throw new ProtocolError('internal', 'failed to persist tombstone')
          }
          if (outcome === 'incomplete') {
            throw new ProtocolError(
              'in_progress',
              'instance teardown is incomplete'
            )
          }
          return toAgentInstance({
            ...record,
            state: 'stopped',
            lease: undefined,
            vm: undefined,
            vmPendingDestroy: undefined,
          })
        })
      } finally {
        await releaseEntry(entry)
      }
    } finally {
      endOp()
    }
  }

  /** The leases a recovered agent still owns (stable after recovery decisions). */
  const liveLeases = (): NetLease[] => {
    const leases: NetLease[] = []
    for (const entry of entries.values()) {
      const record = entry.record
      if (!record?.lease || !record.vm) continue
      if (record.state !== 'starting' && record.state !== 'running') continue
      leases.push(leaseWithExpose(record.lease, record.spec))
    }
    return leases
  }

  /**
   * Leases whose teardown was interrupted (or that were never adopted) but
   * whose persisted record still owns host resources: `stopping`, errored
   * records that still hold a lease, and abandoned `creating` records. They
   * must be handed to `net.restore` as retiring BEFORE their records are
   * processed, otherwise a fresh (empty) network manager would treat a later
   * `release(id)` as an unknown-id no-op and the agent would drop ownership
   * without ever flushing conntrack or persisting the reuse quarantine.
   */
  const retiringLeases = (): NetLease[] => {
    const leases: NetLease[] = []
    for (const entry of entries.values()) {
      const record = entry.record
      if (!record?.lease) continue
      const live =
        record.vm !== undefined &&
        (record.state === 'starting' || record.state === 'running')
      if (live) continue
      leases.push(leaseWithExpose(record.lease, record.spec))
    }
    return leases
  }

  const ownedInstanceIds = (): Set<string> => {
    const owned = new Set<string>()
    for (const entry of entries.values()) {
      const record = entry.record
      if (!record) continue
      if (holdsResources(record)) owned.add(record.id)
    }
    return owned
  }

  const recoverEntry = async (entry: Entry): Promise<void> => {
    const record = entry.record
    if (!record) return

    // Teardown states are finished regardless of what the host still runs.
    if (record.state === 'stopping') {
      await teardownLocked(entry)
      return
    }
    if (record.state === 'errored') {
      // Retain each handle until its release is confirmed; the sweep retries.
      await releaseResources(entry)
      await persistBestEffort(entry, 'persist errored recovery')
      return
    }
    if (record.state === 'creating') {
      // Flags and the launch/publish outcome are unknowable after a crash, so
      // NEVER adopt a half-provisioned VM. Tear it down and keep an errored
      // record (no spec, no secrets) that the sweep can finish retrying.
      entry.record = { ...record, vmPendingDestroy: true }
      await releaseResources(entry)
      const current = entry.record ?? record
      entry.record = {
        ...current,
        state: 'errored',
        message: FAILURE_MESSAGES.restart,
        updatedAtMs: now(),
      }
      await persistBestEffort(entry, 'persist restarted cleanup')
      logger.info(
        { instanceId: record.id },
        'abandoned unfinished instance record without a live VM'
      )
      return
    }

    if (record.state !== 'starting' && record.state !== 'running') {
      // Unknown pre-terminal state: flags/outcome are not trustworthy. Clean up
      // rather than adopting.
      await markVmDeadLocked(entry, 'vm died')
      return
    }

    let handle: VmHandle | undefined
    try {
      handle = await runOperation(record.id, 'vm.adopt', () =>
        vm.adopt(record.id)
      )
    } catch (err) {
      logOperationError(record.id, 'vm.adopt', err)
    }
    if (!handle) handle = record.vm

    let alive = false
    if (handle) {
      try {
        alive = await runOperation(record.id, 'vm.isAlive', () =>
          vm.isAlive(handle as VmHandle)
        )
      } catch (err) {
        logOperationError(record.id, 'vm.isAlive', err)
      }
    }

    if (handle && alive) {
      entry.record = { ...record, vm: handle, updatedAtMs: now() }
      await persistBestEffort(entry, 'persist adopted')
      logger.info(
        { instanceId: record.id, state: record.state },
        'adopted running firecracker instance'
      )
      return
    }

    // starting/running without a live VM: it is gone. Keep an errored record
    // and let the retryable cleanup path release the remaining resources.
    await markVmDeadLocked(entry, 'vm died')
    logger.info(
      { instanceId: record.id },
      'marked instance errored: no live VM after restart'
    )
  }

  /**
   * Persist conservative fences for ids whose record file was malformed. The
   * fence is made durable BEFORE the malformed file is renamed to `.corrupt`;
   * if the fence write fails the original stays in place so the next load
   * re-detects it and recovery stays closed.
   */
  const persistConservativeFences = async (ids: string[]): Promise<boolean> => {
    for (const id of ids) {
      try {
        await tombstones.save(id, now())
        logger.warn(
          { instanceId: id },
          'fenced id whose state file was malformed'
        )
      } catch (err) {
        logOperationError(id, 'tombstone.persist', err)
        return false
      }
      // Only after the durable fence: quarantine the unreadable original.
      await store.quarantineCorrupt(id)
    }
    return true
  }

  /**
   * Load state from disk. A per-file READ failure fails recovery closed and is
   * retried by the sweep; a MALFORMED file is conservatively fenced (durably,
   * before it is quarantined) so it can never be silently reused.
   *
   * The network is restored HERE, before any record is processed: every lease
   * the agent still owns - live ones AND those whose teardown was interrupted -
   * becomes known to a fresh network manager, so a following `release(id)` runs
   * the real flush/quarantine sequence instead of a no-op on an unknown id.
   */
  const loadState = async (): Promise<boolean> => {
    try {
      await store.init()
      await tombstones.load()
      await tombstones.prune(now(), tombstoneTtlMs).catch(err => {
        logOperationError('*', 'tombstone.prune', err)
      })
    } catch (err) {
      if (err instanceof StateReadError) {
        logOperationError('*', 'state.read', err)
        return false
      }
      throw err
    }

    let loaded: StateLoadResult
    try {
      loaded = await store.load()
    } catch (err) {
      if (err instanceof StateReadError) {
        logOperationError('*', 'state.read', err)
        return false
      }
      throw err
    }

    if (!(await persistConservativeFences(loaded.fences))) return false
    if (loaded.readErrors > 0) {
      logger.error(
        { failures: loaded.readErrors },
        'could not read every instance state file; failing recovery closed'
      )
      return false
    }

    for (const entry of entries.values()) entry.boot?.controller.abort()
    entries.clear()
    for (const record of loaded.records) {
      entries.set(record.id, {
        id: record.id,
        mutex: new Mutex(),
        refs: 0,
        record,
        pendingOps: new Set(),
      })
    }

    // Learn every lease (live + retiring) before touching any record. If this
    // fails, recovery stays closed and the sweep retries it; a create cannot
    // slip in and be undone by a later restore.
    try {
      const restored = await runOperation('*', 'net.restore', () =>
        net.restore(liveLeases(), { retiring: retiringLeases() })
      )
      if (restored.removedOrphans.length > 0) {
        logger.info(
          { orphans: restored.removedOrphans },
          'removed orphaned network artifacts'
        )
      }
    } catch (err) {
      logOperationError('*', 'net.restore', err)
      return false
    }

    // Serialise recovery mutations per id before any request can arrive.
    for (const record of loaded.records) {
      const entry = entries.get(record.id)
      if (!entry) continue
      try {
        await entry.mutex.run(() => recoverEntry(entry))
      } catch (err) {
        logOperationError(record.id, 'recover', err)
      }
    }
    stateLoaded = true
    return true
  }

  /** Retry every orphan id until its destruction is confirmed. */
  const retryOrphanBacklog = async (): Promise<void> => {
    for (const id of orphanBacklog) {
      try {
        await runOperation(id, 'vm.destroy', () => vm.destroy(id))
        orphanBacklog.delete(id)
        logger.info({ instanceId: id }, 'destroyed orphaned VM')
      } catch (err) {
        logOperationError(id, 'destroy orphan', err)
      }
    }
  }

  /**
   * Full discovery: every VM the driver knows about but no record owns is an
   * orphan. Destruction failures stay in the backlog (retried every sweep and
   * re-discovered periodically) instead of being forgotten.
   */
  const scanForOrphans = async (): Promise<boolean> => {
    let found: string[]
    try {
      found = await runOperation('*', 'vm.listInstanceIds', () =>
        vm.listInstanceIds()
      )
    } catch (err) {
      logOperationError('*', 'vm.listInstanceIds', err)
      return false
    }
    const owned = ownedInstanceIds()
    for (const id of found) {
      if (owned.has(id)) {
        orphanBacklog.delete(id)
        continue
      }
      if (!INSTANCE_ID_REGEX.test(id)) {
        logger.warn({ instanceId: id }, 'refusing to destroy invalid orphan id')
        continue
      }
      orphanBacklog.add(id)
    }
    for (const id of orphanBacklog) {
      if (owned.has(id)) orphanBacklog.delete(id)
    }
    await retryOrphanBacklog()
    return true
  }

  const runOrphanMaintenance = async (discover: boolean): Promise<void> => {
    if (orphanScanInFlight) return
    orphanScanInFlight = true
    try {
      if (discover) await scanForOrphans()
      else await retryOrphanBacklog()
    } finally {
      orphanScanInFlight = false
    }
  }

  /**
   * Finish recovery (state + network + orphan VMs). Until this succeeds the
   * agent is not accepting and readiness tasks are deferred; the sweep retries
   * it. The network restore itself happens inside `loadState` BEFORE any record
   * is processed. Failed orphan destructions do not block recovery but keep
   * `accepting` false until they are confirmed.
   */
  const finishRecovery = (): Promise<void> => {
    if (recovered || shuttingDown) return Promise.resolve()
    if (recoveryInFlight) return recoveryInFlight
    recoveryInFlight = (async () => {
      if (!stateLoaded && !(await loadState())) return

      if (orphanGraceMs > 0) await Bun.sleep(orphanGraceMs)
      if (!(await scanForOrphans())) return

      if (shuttingDown) return
      // Serialise the transition with creates: a create admitted before this
      // point could be undone by a later restore from a stale lease snapshot.
      await admissionLock.run(async () => {
        if (!shuttingDown) recovered = true
      })
      // Readiness may only start after the network has been restored.
      for (const entry of entries.values()) {
        const record = entry.record
        if (record?.state === 'starting' && record.vm && record.lease) {
          startBoot(entry)
        }
      }
      logger.info('agent recovery complete')
    })().finally(() => {
      recoveryInFlight = undefined
    })
    return recoveryInFlight
  }

  const start = async (): Promise<void> => {
    if (timer) clearInterval(timer)
    timer = undefined
    shuttingDown = false
    recovered = false
    stateLoaded = false
    recoveryInFlight = undefined
    orphanBacklog.clear()
    sweepsSinceOrphanScan = 0

    for (const entry of entries.values()) entry.boot?.controller.abort()
    entries.clear()

    // Fail startup closed: an unreadable state or tombstone directory is never
    // treated as empty (that would forget live resources and fences).
    await finishRecovery()

    if (!shuttingDown) {
      timer = setInterval(() => {
        void sweep().catch(err => logOperationError('*', 'sweep', err))
      }, sweepIntervalMs)
      if (typeof timer.unref === 'function') timer.unref()
    }
  }

  const sweepErroredLocked = async (entry: Entry): Promise<void> => {
    let record = entry.record
    if (!record) return
    const holdsAnything =
      record.lease !== undefined ||
      record.vm !== undefined ||
      record.vmPendingDestroy === true ||
      record.netMayHold === true ||
      record.vmMayHold === true
    if (holdsAnything) {
      const ok = await releaseResources(entry)
      if (ok) await persistBestEffort(entry, 'persist errored cleanup')
    }
    record = entry.record
    if (!record) return
    const fullyReleased =
      record.lease === undefined &&
      record.vm === undefined &&
      record.vmPendingDestroy !== true &&
      record.netMayHold !== true &&
      record.vmMayHold !== true
    if (fullyReleased) {
      if (now() - record.updatedAtMs >= erroredTtlMs) {
        try {
          await store.remove(record.id)
          entry.record = undefined
          await dropIdleEntry(entry)
          logger.info(
            { instanceId: record.id },
            'forgot errored instance tombstone'
          )
        } catch (err) {
          logOperationError(record.id, 'forget errored', err)
        }
      }
    }
  }

  const sweepEntryLocked = async (entry: Entry): Promise<void> => {
    const record = entry.record
    if (!record) return

    if (record.state === 'errored') {
      await sweepErroredLocked(entry)
      return
    }
    if (record.state === 'stopping') {
      await teardownLocked(entry)
      return
    }
    if (now() >= record.expiresAtMs + expiryGraceMs) {
      logger.info(
        { instanceId: record.id, expiresAtMs: record.expiresAtMs },
        'instance past its dead-man deadline; tearing down'
      )
      await teardownLocked(entry)
      return
    }
    if (
      record.vm &&
      (record.state === 'starting' || record.state === 'running')
    ) {
      let alive = false
      try {
        alive = await runOperation(record.id, 'vm.isAlive', () =>
          vm.isAlive(record.vm as VmHandle)
        )
      } catch (err) {
        logOperationError(record.id, 'vm.isAlive', err)
        return
      }
      if (!alive) {
        logger.info({ instanceId: record.id }, 'instance VM is no longer alive')
        await markVmDeadLocked(entry)
      }
    }
  }

  /** One id at a time, independent of (and never blocking) every other id. */
  const sweepEntry = async (entry: Entry): Promise<void> => {
    if (sweepInFlight.has(entry.id)) return
    sweepInFlight.add(entry.id)
    beginOp()
    try {
      await sweepSlots.run(async () => {
        await entry.mutex.run(() => sweepEntryLocked(entry))
      })
    } catch (err) {
      logOperationError(entry.id, 'sweep', err)
    } finally {
      sweepInFlight.delete(entry.id)
      endOp()
    }
  }

  const sweep = async (): Promise<void> => {
    if (shuttingDown) return
    reportStalledOperations()
    if (!recovered) {
      void finishRecovery().catch(err => logOperationError('*', 'recover', err))
    }
    const prune = tombstones
      .prune(now(), tombstoneTtlMs)
      .then(pruned => {
        if (pruned.length > 0) {
          logger.info({ instanceIds: pruned }, 'pruned expired tombstones')
        }
      })
      .catch(err => logOperationError('*', 'tombstone.prune', err))
    const tasks: Promise<unknown>[] = [
      prune,
      ...Array.from(entries.values()).map(entry => sweepEntry(entry)),
    ]
    if (recovered) {
      sweepsSinceOrphanScan += 1
      const discover = sweepsSinceOrphanScan >= orphanScanSweeps
      if (discover) sweepsSinceOrphanScan = 0
      // Retry a non-empty backlog every sweep; re-discover periodically so an
      // orphan that appears later is not missed.
      if (discover || orphanBacklog.size > 0) {
        tasks.push(runOrphanMaintenance(discover))
      }
    }
    await Promise.all(tasks)
  }

  const info = async (): Promise<AgentInfo> => {
    let images: string[] = []
    reportStalledOperations()
    const checks: Record<string, boolean> = {
      recovered,
      orphanBacklog: orphanBacklog.size === 0,
      // A never-settling provisioning call is a critical check: it takes the
      // host out of rotation (ownership/capacity stay accounted).
      stalledOperations: !hasStalledOperations(),
    }
    try {
      const preflight = await runOperation('*', 'vm.preflight', () =>
        vm.preflight()
      )
      Object.assign(checks, preflight.checks)
      images = preflight.images
    } catch (err) {
      logOperationError('*', 'vm.preflight', err)
      checks.vm_preflight = false
    }
    try {
      Object.assign(
        checks,
        await runOperation('*', 'net.preflight', () => net.preflight())
      )
    } catch (err) {
      logOperationError('*', 'net.preflight', err)
      checks.net_preflight = false
    }
    // Informational checks (e.g. reflink support only affects boot speed) must
    // never take a host out of rotation.
    const accepting =
      !config.draining &&
      !shuttingDown &&
      recovered &&
      Object.entries(checks).every(
        ([name, ok]) => ok || INFORMATIONAL_CHECKS.has(name)
      )
    return {
      version,
      hostId: config.hostId,
      timeMs: now(),
      capacity: {
        vcpus: config.capacity.vcpus,
        memMiB: config.capacity.memMiB,
        diskMiB: config.capacity.diskMiB,
        maxInstances: config.capacity.maxInstances,
      },
      usage: usage(),
      accepting,
      checks,
      images,
    }
  }

  const waitForDrain = async (timeoutMs: number): Promise<void> => {
    const deadline = Date.now() + Math.max(0, timeoutMs)
    while (activeOps > 0) {
      const remaining = deadline - Date.now()
      if (remaining <= 0) return
      await new Promise(resolve => setTimeout(resolve, Math.min(10, remaining)))
    }
  }

  const stop = async (): Promise<void> => {
    shuttingDown = true
    if (timer) clearInterval(timer)
    timer = undefined
    for (const entry of entries.values()) entry.boot?.controller.abort()
    // Running VMs are intentionally left alone; only in-flight bookkeeping is
    // drained (and only up to the configured shutdown deadline).
    await waitForDrain(shutdownTimeoutMs)
  }

  return {
    create,
    get,
    list,
    extend,
    delete: deleteInstance,
    info,
    start,
    stop,
  }
}
