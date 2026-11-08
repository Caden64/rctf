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
  StateStore,
  TombstoneStore,
  buildStoredInstance,
  computeSpecHash,
  leaseToJson,
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

interface BootTask {
  controller: AbortController
  promise: Promise<void>
}

interface Entry {
  id: string
  mutex: Mutex
  refs: number
  record?: StoredInstance
  boot?: BootTask
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

const redactText = (text: string, spec: AgentInstanceSpec): string => {
  let out = text
  for (const { flag } of spec.flags) {
    if (flag.length > 0) out = out.split(flag).join('<redacted>')
  }
  return out
}

const errorMessage = (err: unknown): string =>
  err instanceof Error ? err.message : String(err)

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
  version?: string
}): InstanceManager => {
  const { config, vm, net } = deps
  const now: Clock = deps.now ?? Date.now
  const logger = deps.logger ?? createLogger('firecracker-agent', 'silent')
  const store = new StateStore(
    config.stateDir ?? '/var/lib/rctf-firecracker/state',
    logger
  )
  const tombstones = new TombstoneStore(store.directory, logger)
  const expiryGraceMs = (config.expiryGraceSeconds ?? 120) * 1000
  const erroredTtlMs =
    deps.erroredTtlMs ?? (config.erroredTtlSeconds ?? 600) * 1000
  const tombstoneTtlMs =
    deps.tombstoneTtlMs ?? (config.tombstoneTtlSeconds ?? 86400) * 1000
  const sweepIntervalMs = deps.sweepIntervalMs ?? 1000
  const orphanGraceMs = deps.orphanGraceMs ?? 0
  const version = deps.version ?? '0.0.0'

  const entries = new Map<string, Entry>()
  const entriesLock = new Mutex()
  const admissionLock = new Mutex()

  let timer: ReturnType<typeof setInterval> | undefined
  let sweepRunning = false
  let shuttingDown = false

  const logError = (
    instanceId: string,
    stage: string,
    err: unknown,
    spec?: AgentInstanceSpec
  ): void => {
    const message = errorMessage(err)
    logger.warn(
      {
        instanceId,
        stage,
        error: spec ? redactText(message, spec) : message,
      },
      'firecracker instance operation failed'
    )
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

  const usage = (): AgentInfo['usage'] => {
    let vcpus = 0
    let memMiB = 0
    let diskMiB = 0
    let instances = 0
    for (const entry of entries.values()) {
      const record = entry.record
      if (!record || !isLiveState(record.state)) continue
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
        entry = { id, mutex: new Mutex(), refs: 0 }
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
   * Reverse-order resource release. Returns false if any step failed; the
   * record keeps the handles so a later sweep retries everything (all calls
   * are idempotent).
   */
  const releaseResources = async (entry: Entry): Promise<boolean> => {
    const record = entry.record
    if (!record) return true
    const id = record.id
    let ok = true

    if (record.lease) {
      try {
        await net.unpublish(id)
      } catch (err) {
        ok = false
        logError(id, 'unpublish', err)
      }
    }
    if (record.vm) {
      try {
        await vm.stop(record.vm, { graceMs: 2000 })
      } catch (err) {
        ok = false
        logError(id, 'vm.stop', err)
      }
      try {
        await vm.destroy(id)
      } catch (err) {
        ok = false
        logError(id, 'vm.destroy', err)
      }
    }
    if (record.lease) {
      try {
        await net.release(id)
      } catch (err) {
        ok = false
        logError(id, 'net.release', err)
      }
    }

    entry.record = ok ? { ...record, lease: undefined, vm: undefined } : record
    return ok
  }

  /**
   * Cancel a boot, persist `stopping`, tear every resource down and remove the
   * record. Returns false when cleanup was incomplete (record stays stopping).
   */
  const teardownLocked = async (entry: Entry): Promise<boolean> => {
    const record = entry.record
    if (!record) return true
    entry.boot?.controller.abort()
    const stopping: StoredInstance = {
      ...record,
      state: 'stopping',
      message: undefined,
      updatedAtMs: now(),
    }
    entry.record = stopping
    await store.save(stopping)

    const ok = await releaseResources(entry)
    if (!ok) {
      const current = entry.record ?? stopping
      entry.record = { ...current, state: 'stopping', updatedAtMs: now() }
      await store.save(entry.record)
      return false
    }
    await store.remove(record.id)
    // Fence the id before releasing the per-id lock so a queued duplicate PUT
    // can never race in between cleanup and the tombstone becoming visible.
    await tombstones.save(record.id, now())
    entry.record = undefined
    await dropIdleEntry(entry)
    return true
  }

  const markVmDeadLocked = async (
    entry: Entry,
    message = 'vm died'
  ): Promise<void> => {
    const record = entry.record
    if (!record) return
    entry.boot?.controller.abort()
    await releaseResources(entry)
    const current = entry.record ?? record
    entry.record = {
      ...current,
      state: 'errored',
      message,
      updatedAtMs: now(),
    }
    await store.save(entry.record)
  }

  const startBoot = (entry: Entry): void => {
    const record = entry.record
    if (!record?.vm || !record.lease) return
    entry.boot?.controller.abort()
    const controller = new AbortController()

    const task: BootTask = {
      controller,
      promise: Promise.resolve(),
    }
    entry.boot = task

    task.promise = (async () => {
      try {
        await vm.waitReady(
          record.vm as VmHandle,
          {
            readiness: record.spec.readiness,
            guestIp: record.lease?.guestIp ?? record.lease?.hostIp ?? '',
            timeoutMs: record.spec.bootTimeoutSeconds * 1000,
          },
          controller.signal
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
          await store.save(entry.record)
        })
      } catch (err) {
        if (shuttingDown || controller.signal.aborted) return
        try {
          await entry.mutex.run(async () => {
            if (entries.get(entry.id) !== entry) return
            const current = entry.record
            if (!current || current.state !== 'starting') return
            logError(current.id, 'waitReady', err)
            await markVmDeadLocked(entry, 'boot failed')
          })
        } catch (cleanupErr) {
          logError(entry.id, 'boot cleanup', cleanupErr)
        }
      }
    })()

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
    await tombstones.ensureLoaded()
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

    let record: StoredInstance | undefined
    await admissionLock.run(async () => {
      const current = usage()
      if (
        current.instances + 1 > config.capacity.maxInstances ||
        current.vcpus + spec.vcpus > config.capacity.vcpus ||
        current.memMiB + spec.memMiB > config.capacity.memMiB ||
        current.diskMiB + spec.diskMiB > config.capacity.diskMiB
      ) {
        throw new ProtocolError('no_capacity', 'host capacity exhausted')
      }
      record = buildStoredInstance(spec, now(), 'creating')
      entry.record = record
    })
    record = entry.record as StoredInstance

    // Write-ahead: the creating record exists before anything is allocated.
    try {
      await store.save(record)
    } catch {
      entry.record = undefined
      throw new ProtocolError('internal', 'failed to persist instance state')
    }

    let stage = 'allocate'
    try {
      const lease = await net.allocate({
        instanceId: spec.id,
        egress: spec.egress,
        expose: exposeRequests(record.spec),
      })
      record = { ...record, lease: leaseToJson(lease), updatedAtMs: now() }
      entry.record = record
      await store.save(record)

      stage = 'launch'
      const firstPublicHostname =
        spec.expose
          .map((_, index) => lease.publicHostnames[index])
          .find(hostname => hostname !== undefined) ?? spec.id
      const handle = await vm.launch({
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
      record = { ...record, vm: handle, updatedAtMs: now() }
      entry.record = record
      await store.save(record)

      stage = 'publish'
      await net.publish(lease, exposeRequests(record.spec))

      record = {
        ...record,
        state: 'starting',
        message: undefined,
        updatedAtMs: now(),
      }
      entry.record = record
      await store.save(record)
    } catch (err) {
      logError(spec.id, stage, err, spec)
      const ok = await releaseResources(entry)
      const current = entry.record ?? record
      entry.record = {
        ...current,
        state: 'errored',
        message: `provisioning failed (${stage})`,
        ...(ok ? { lease: undefined, vm: undefined } : {}),
        updatedAtMs: now(),
      }
      await store.save(entry.record)
      if (err instanceof NetworkCapacityError) {
        throw new ProtocolError(
          'no_capacity',
          'host network capacity exhausted'
        )
      }
      return toAgentInstance(entry.record)
    }

    startBoot(entry)
    return toAgentInstance(entry.record)
  }

  const create = async (spec: AgentInstanceSpec): Promise<AgentInstance> => {
    if (config.draining || shuttingDown) {
      throw new ProtocolError('draining', 'agent is not accepting instances')
    }
    const entry = await obtainEntry(spec.id)
    try {
      return await entry.mutex.run(async () => createLocked(entry, spec))
    } finally {
      await releaseEntry(entry)
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
    const entry = await obtainEntry(id)
    try {
      return await entry.mutex.run(async () => {
        const record = entry.record
        if (!record) throw new ProtocolError('not_found', 'instance not found')
        if (record.state === 'stopping' || record.state === 'errored') {
          throw new ProtocolError('expired', 'instance is no longer live')
        }
        if (now() >= record.expiresAtMs) {
          throw new ProtocolError('expired', 'instance has expired')
        }
        const next = Math.max(record.expiresAtMs, expiresAtMs)
        if (next === record.expiresAtMs) return toAgentInstance(record)
        const updated: StoredInstance = {
          ...record,
          expiresAtMs: next,
          updatedAtMs: now(),
        }
        entry.record = updated
        await store.save(updated)
        return toAgentInstance(updated)
      })
    } finally {
      await releaseEntry(entry)
    }
  }

  const deleteInstance = async (id: string): Promise<AgentInstance> => {
    if (!INSTANCE_ID_REGEX.test(id)) {
      throw new ProtocolError('invalid_request', 'invalid instance id')
    }
    const entry = await obtainEntry(id)
    try {
      return await entry.mutex.run(async () => {
        await tombstones.ensureLoaded()
        const record = entry.record
        if (!record) {
          // Fence the id even though it is unknown/already finished. This is
          // what makes a delayed duplicate PUT unable to resurrect a VM.
          if (!tombstones.has(id)) await tombstones.save(id, now())
          throw new ProtocolError('not_found', 'instance not found')
        }
        const ok = await teardownLocked(entry)
        if (!ok) {
          throw new ProtocolError(
            'in_progress',
            'instance teardown is incomplete'
          )
        }
        // Full cleanup confirmed: teardownLocked has already fenced the id.
        return toAgentInstance({
          ...record,
          state: 'stopped',
          lease: undefined,
          vm: undefined,
        })
      })
    } finally {
      await releaseEntry(entry)
    }
  }

  const recoverEntry = async (
    entry: Entry,
    liveLeases: NetLease[]
  ): Promise<void> => {
    let record = entry.record
    if (!record) return

    // Teardown states are finished regardless of what the host still runs.
    if (record.state === 'stopping') {
      await teardownLocked(entry)
      return
    }
    if (record.state === 'errored') {
      // Keep the tombstone but make sure no host resources survived the crash.
      try {
        await vm.destroy(record.id)
      } catch (err) {
        logError(record.id, 'destroy errored leftovers', err)
      }
      if (record.lease) {
        await net.unpublish(record.id).catch(() => {})
        await net.release(record.id).catch(() => {})
      }
      if (record.lease || record.vm) {
        entry.record = { ...record, lease: undefined, vm: undefined }
        await store.save(entry.record as StoredInstance)
      }
      return
    }

    let handle: VmHandle | undefined
    try {
      handle = await vm.adopt(record.id)
    } catch (err) {
      logError(record.id, 'adopt', err)
    }
    if (!handle) handle = record.vm

    let alive = false
    if (handle) {
      try {
        alive = await vm.isAlive(handle)
      } catch (err) {
        logError(record.id, 'isAlive', err)
      }
    }

    if (handle && alive) {
      record = { ...record, vm: handle, updatedAtMs: now() }
      entry.record = record
      await store.save(record)
      if (record.lease)
        liveLeases.push(leaseWithExpose(record.lease, record.spec))
      if (record.state === 'starting' && record.lease) startBoot(entry)
      logger.info(
        { instanceId: record.id, state: record.state },
        'adopted running firecracker instance'
      )
      return
    }

    switch (record.state) {
      case 'creating': {
        // The request spec (and flags) is gone; the VM never came up fully, so
        // there is nothing to resume. Release leftovers and forget the id.
        if (record.vm) await vm.destroy(record.id).catch(() => {})
        if (record.lease) await net.release(record.id).catch(() => {})
        await store.remove(record.id)
        entry.record = undefined
        await dropIdleEntry(entry)
        logger.info(
          { instanceId: record.id },
          'dropped unfinished instance record without a live VM'
        )
        return
      }
      case 'starting':
      case 'running':
      default: {
        entry.record = {
          ...record,
          state: 'errored',
          message: 'vm died',
          updatedAtMs: now(),
        }
        await releaseResources(entry)
        await store.save(entry.record as StoredInstance)
        logger.info(
          { instanceId: record.id },
          'marked instance errored: no live VM after restart'
        )
      }
    }
  }

  const start = async (): Promise<void> => {
    if (timer) clearInterval(timer)
    timer = undefined
    shuttingDown = false

    for (const entry of entries.values()) entry.boot?.controller.abort()
    entries.clear()

    await store.init()
    await tombstones.load()
    await tombstones.prune(now(), tombstoneTtlMs).catch(err => {
      logError('*', 'tombstone.prune', err)
    })
    const records = await store.load()
    for (const record of records) {
      entries.set(record.id, {
        id: record.id,
        mutex: new Mutex(),
        refs: 0,
        record,
      })
    }

    const liveLeases: NetLease[] = []
    for (const record of records) {
      const entry = entries.get(record.id)
      if (!entry) continue
      try {
        await recoverEntry(entry, liveLeases)
      } catch (err) {
        logError(record.id, 'recover', err)
      }
    }

    try {
      const restored = await net.restore(liveLeases)
      if (restored.removedOrphans.length > 0) {
        logger.info(
          { orphans: restored.removedOrphans },
          'removed orphaned network artifacts'
        )
      }
    } catch (err) {
      logError('*', 'net.restore', err)
    }

    // Destroy VMs the driver found that no state record owns. Ids come from
    // disk/process discovery, so validate before handing them to the driver.
    let found: string[] = []
    try {
      found = await vm.listInstanceIds()
    } catch (err) {
      logError('*', 'vm.listInstanceIds', err)
    }
    if (orphanGraceMs > 0) await Bun.sleep(orphanGraceMs)
    const owned = new Set(
      [...entries.values()]
        .filter(entry => entry.record !== undefined)
        .map(entry => entry.id)
    )
    for (const id of found) {
      if (owned.has(id)) continue
      if (!/^[a-z0-9]{16,32}$/.test(id)) {
        logger.warn({ instanceId: id }, 'refusing to destroy invalid orphan id')
        continue
      }
      try {
        await vm.destroy(id)
        logger.info({ instanceId: id }, 'destroyed orphaned VM')
      } catch (err) {
        logError(id, 'destroy orphan', err)
      }
    }

    timer = setInterval(() => {
      void sweep().catch(err => logError('*', 'sweep', err))
    }, sweepIntervalMs)
    if (typeof timer.unref === 'function') timer.unref()
  }

  const sweepErroredLocked = async (entry: Entry): Promise<void> => {
    let record = entry.record
    if (!record) return
    if (record.lease || record.vm) {
      const ok = await releaseResources(entry)
      record = entry.record
      if (ok && record) await store.save(record)
    }
    record = entry.record
    if (!record) return
    if (!record.lease && !record.vm) {
      if (now() - record.updatedAtMs >= erroredTtlMs) {
        await store.remove(record.id)
        entry.record = undefined
        await dropIdleEntry(entry)
        logger.info(
          { instanceId: record.id },
          'forgot errored instance tombstone'
        )
      }
    }
  }

  const sweepEntry = async (entry: Entry): Promise<void> => {
    await entry.mutex.run(async () => {
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
          alive = await vm.isAlive(record.vm)
        } catch (err) {
          logError(record.id, 'isAlive', err)
          return
        }
        if (!alive) {
          logger.info(
            { instanceId: record.id },
            'instance VM is no longer alive'
          )
          await markVmDeadLocked(entry)
        }
      }
    })
  }

  const sweep = async (): Promise<void> => {
    if (sweepRunning || shuttingDown) return
    sweepRunning = true
    try {
      try {
        const pruned = await tombstones.prune(now(), tombstoneTtlMs)
        if (pruned.length > 0) {
          logger.info({ instanceIds: pruned }, 'pruned expired tombstones')
        }
      } catch (err) {
        logError('*', 'tombstone.prune', err)
      }
      for (const entry of Array.from(entries.values())) {
        if (shuttingDown) return
        try {
          await sweepEntry(entry)
        } catch (err) {
          logError(entry.id, 'sweep', err)
        }
      }
    } finally {
      sweepRunning = false
    }
  }

  const info = async (): Promise<AgentInfo> => {
    let images: string[] = []
    const checks: Record<string, boolean> = {}
    try {
      const preflight = await vm.preflight()
      Object.assign(checks, preflight.checks)
      images = preflight.images
    } catch (err) {
      logError('*', 'vm.preflight', err)
      checks.vm_preflight = false
    }
    try {
      Object.assign(checks, await net.preflight())
    } catch (err) {
      logError('*', 'net.preflight', err)
      checks.net_preflight = false
    }
    const accepting =
      !config.draining && !shuttingDown && Object.values(checks).every(Boolean)
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

  const stop = async (): Promise<void> => {
    shuttingDown = true
    if (timer) clearInterval(timer)
    timer = undefined
    const boots: Promise<void>[] = []
    for (const entry of entries.values()) {
      const boot = entry.boot
      if (!boot) continue
      boot.controller.abort()
      boots.push(boot.promise)
    }
    await Promise.allSettled(boots)
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
