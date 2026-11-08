/**
 * Durable agent state: one JSON record per instance, `stateDir/<id>.json`.
 *
 * Records contain NO secrets. `flags` are delivered to the guest through MMDS
 * only; only the flag provider names are kept so the spec hash can be stable
 * and idempotent creations can be recognised after a restart.
 *
 * Writes are atomic: tmp file (0600) -> fsync -> rename -> fsync directory.
 * A corrupt/unreadable record is quarantined instead of crashing the agent.
 */
import { createHash } from 'node:crypto'
import { promises as fs, type Dirent } from 'node:fs'
import path from 'node:path'
import * as z from 'zod/mini'
import {
  agentExposeSchema,
  agentInstanceStateSchema,
  exposeKindSchema,
  instanceIdSchema,
  readinessSchema,
  type AgentInstanceSpec,
} from '@rctf/firecracker-protocol'
import type { Clock, NetExposeRequest, NetLease } from '../interfaces'
import type { Logger } from '../log'

const RECORD_VERSION = 1

/** `AgentInstanceSpec` minus the two fields that must not be persisted verbatim. */
export const storedSpecSchema = z.object({
  id: instanceIdSchema,
  teamKey: z.string(),
  image: z.string(),
  vcpus: z.int(),
  memMiB: z.int(),
  diskMiB: z.int(),
  kernelArgs: z.optional(z.string()),
  egress: z.boolean(),
  bootTimeoutSeconds: z.int(),
  readiness: readinessSchema,
  env: z.record(z.string(), z.string()),
  expose: z.array(agentExposeSchema).check(z.minLength(1)),
})
export type StoredSpec = z.output<typeof storedSpecSchema>

const netLeaseExposeSchema = z.object({
  kind: exposeKindSchema,
  hostPrefix: z.string(),
  port: z.int(),
})

const netLeaseSchema = z.object({
  instanceId: z.string(),
  tapName: z.string(),
  hostIp: z.string(),
  guestIp: z.string(),
  prefixLength: z.int(),
  guestMac: z.string(),
  publicPorts: z.record(z.string(), z.int()),
  publicHostnames: z.record(z.string(), z.string()),
  egress: z.boolean(),
  /**
   * The frozen NetLease gained this required field in a later contract
   * revision. Optional here so records written before that revision still load.
   */
  expose: z.optional(z.array(netLeaseExposeSchema)),
})

const vmHandleSchema = z.object({
  instanceId: z.string(),
  pid: z.int(),
  pidStartTicks: z.number(),
  apiSocket: z.string(),
  dir: z.string(),
})

export const storedInstanceSchema = z.object({
  // Optional for forward/backward compatibility with records written by older
  // agents; normalised on load.
  version: z.optional(z.literal(RECORD_VERSION)),
  id: instanceIdSchema,
  specHash: z.string(),
  spec: storedSpecSchema,
  /** Provider names only — never the flag values. */
  flagProviders: z.optional(z.array(z.string())),
  state: agentInstanceStateSchema,
  message: z.optional(z.string()),
  createdAtMs: z.number(),
  expiresAtMs: z.number(),
  updatedAtMs: z.optional(z.number()),
  lease: z.optional(netLeaseSchema),
  vm: z.optional(vmHandleSchema),
  /**
   * The VM process may exist but no handle was persisted (a crash between
   * `launch` and the handle write). Kept until `vm.destroy(id)` is confirmed.
   */
  vmPendingDestroy: z.optional(z.boolean()),
  /**
   * The network may hold resources for this id even though no lease could be
   * persisted yet (the allocation timed out or the agent crashed mid-call).
   * Persisted BEFORE `net.allocate`, so teardown always calls `net.release(id)`.
   */
  netMayHold: z.optional(z.boolean()),
  /**
   * A VM may exist for this id even though no handle could be persisted yet
   * (the launch timed out or the agent crashed mid-call). Persisted BEFORE
   * `vm.launch`, so teardown always calls `vm.destroy(id)`.
   */
  vmMayHold: z.optional(z.boolean()),
})
export type StoredInstance = Omit<
  z.output<typeof storedInstanceSchema>,
  'version' | 'flagProviders' | 'updatedAtMs'
> & {
  version: typeof RECORD_VERSION
  flagProviders: string[]
  updatedAtMs: number
}

const canonicalise = (value: unknown): string => {
  if (value === null || typeof value !== 'object') return JSON.stringify(value)
  if (Array.isArray(value)) return `[${value.map(canonicalise).join(',')}]`
  const obj = value as Record<string, unknown>
  const parts = Object.keys(obj)
    .filter(key => obj[key] !== undefined)
    .sort()
    .map(key => `${JSON.stringify(key)}:${canonicalise(obj[key])}`)
  return `{${parts.join(',')}}`
}

/**
 * Stable hash of everything that identifies a creation request, excluding the
 * mutable expiry and the flag *values* (provider names stay part of the hash).
 */
export const computeSpecHash = (spec: AgentInstanceSpec): string => {
  const hashInput = {
    id: spec.id,
    teamKey: spec.teamKey,
    image: spec.image,
    vcpus: spec.vcpus,
    memMiB: spec.memMiB,
    diskMiB: spec.diskMiB,
    kernelArgs: spec.kernelArgs ?? null,
    egress: spec.egress,
    bootTimeoutSeconds: spec.bootTimeoutSeconds,
    readiness: spec.readiness,
    env: spec.env,
    expose: spec.expose,
    flagProviders: spec.flags.map(flag => flag.provider).sort(),
  }
  return createHash('sha256').update(canonicalise(hashInput)).digest('hex')
}

/** Strip the secret flags and the mutable expiry from a request spec. */
export const toStoredSpec = (spec: AgentInstanceSpec): StoredSpec => {
  const { id, teamKey, image, vcpus, memMiB, diskMiB, kernelArgs, egress } =
    spec
  return {
    id,
    teamKey,
    image,
    vcpus,
    memMiB,
    diskMiB,
    kernelArgs,
    egress,
    bootTimeoutSeconds: spec.bootTimeoutSeconds,
    readiness: spec.readiness,
    env: spec.env,
    expose: spec.expose,
  }
}

export const buildStoredInstance = (
  spec: AgentInstanceSpec,
  nowMs: number,
  state: StoredInstance['state'] = 'creating'
): StoredInstance => ({
  version: RECORD_VERSION,
  id: spec.id,
  specHash: computeSpecHash(spec),
  spec: toStoredSpec(spec),
  flagProviders: spec.flags.map(flag => flag.provider),
  state,
  createdAtMs: nowMs,
  expiresAtMs: spec.expiresAtMs,
  updatedAtMs: nowMs,
})

/** JSON-safe copy of a lease. Numeric record keys become strings on disk. */
export const leaseToJson = (lease: NetLease): NetLease => {
  // The frozen interface is being extended with the full expose list; keep it
  // when the running contract provides it without requiring it from old fakes.
  const expose = (lease as NetLease & { expose?: NetExposeRequest[] }).expose
  return {
    instanceId: lease.instanceId,
    tapName: lease.tapName,
    hostIp: lease.hostIp,
    guestIp: lease.guestIp,
    prefixLength: lease.prefixLength,
    guestMac: lease.guestMac,
    publicPorts: { ...lease.publicPorts },
    publicHostnames: { ...lease.publicHostnames },
    egress: lease.egress,
    ...(expose === undefined ? {} : { expose }),
  } as NetLease
}

/**
 * Test seam for filesystem faults. Production never passes faults; tests use
 * them to prove durability/error-handling paths (failed fsync, failed
 * enumeration, failed fence writes) without privileged host operations.
 */
export interface StoreFaults {
  /** Return an error to fail the atomic write before it starts. */
  writeFile?: (fileName: string, dir: string) => Error | undefined
  /** Return an error to make a directory fsync fail. */
  fsyncDir?: (dir: string) => Error | undefined
  /** Return an error to make `readdir` fail. */
  readdir?: (dir: string) => Error | undefined
  /** Return an error to make reading one persisted file fail (EACCES/EIO...). */
  readFile?: (fileName: string, dir: string) => Error | undefined
  /** Return an error to make `unlink` fail. */
  unlink?: (fileName: string, dir: string) => Error | undefined
  /** Awaited before unlinking a record (used to interleave prune with DELETE). */
  beforeRemove?: (fileName: string, dir: string) => Promise<void> | void
}

/**
 * A persisted file exists but could not be read. This is NOT the same as a
 * malformed file: quarantining and skipping it could silently forget a
 * resource or an acknowledged fence, so recovery must fail closed and retry.
 */
export class StateReadError extends Error {
  constructor(readonly fileName: string) {
    super('failed to read persisted state file')
    this.name = 'StateReadError'
  }
}

export interface StateLoadResult {
  records: StoredInstance[]
  /** Ids whose files were malformed; each needs a conservative tombstone. */
  fences: string[]
  /** Files that could not be read; recovery must fail closed and retry. */
  readErrors: number
}

const UNSUPPORTED_FSYNC_CODES = new Set([
  'EINVAL',
  'ENOTSUP',
  'EOPNOTSUPP',
  'ENOSYS',
  'EBADF',
])

const errorCode = (err: unknown): string | undefined =>
  typeof err === 'object' && err !== null && 'code' in err
    ? String((err as { code?: unknown }).code)
    : undefined

const isUnsupportedFsync = (err: unknown): boolean => {
  const code = errorCode(err)
  return code !== undefined && UNSUPPORTED_FSYNC_CODES.has(code)
}

/**
 * Read one persisted file. ENOENT (removed between readdir and read) is a
 * legitimate "absent"; every other failure is a read error that must fail
 * recovery closed.
 */
const readPersistedFile = async (
  file: string,
  fileName: string,
  dir: string,
  faults?: StoreFaults
): Promise<string | undefined> => {
  const injected = faults?.readFile?.(fileName, dir)
  if (injected) throw injected
  try {
    return await fs.readFile(file, 'utf8')
  } catch (err) {
    if (errorCode(err) === 'ENOENT') return undefined
    throw err
  }
}

const fsyncDirectory = async (
  dir: string,
  faults?: StoreFaults
): Promise<void> => {
  const injected = faults?.fsyncDir?.(dir)
  if (injected) {
    if (isUnsupportedFsync(injected)) return
    throw injected
  }
  let handle: fs.FileHandle | undefined
  try {
    handle = await fs.open(dir, 'r')
    await handle.sync()
  } catch (err) {
    // Some filesystems do not allow fsync on a directory; the rename itself is
    // still atomic there. Real I/O failures must reach the caller: a DELETE is
    // never acknowledged on top of an unpersisted fence.
    if (isUnsupportedFsync(err)) return
    throw err
  } finally {
    await handle?.close().catch(() => {})
  }
}

/** Remove leftover `.<name>.tmp-<pid>-<n>` files from an interrupted write. */
const cleanupTempFiles = async (dir: string): Promise<void> => {
  const entries = await fs.readdir(dir, { withFileTypes: true })
  await Promise.all(
    entries
      .filter(
        entry =>
          entry.isFile() &&
          entry.name.startsWith('.') &&
          entry.name.includes('.tmp-')
      )
      .map(entry =>
        fs.unlink(path.join(dir, entry.name)).catch(() => {
          // Best effort: another process may still be writing; init runs once.
        })
      )
  )
}

const ensureDir = async (dir: string, faults?: StoreFaults): Promise<void> => {
  await fs.mkdir(dir, { recursive: true, mode: 0o700 })
  // `mkdir`'s mode is filtered by the umask; enforce it explicitly.
  await fs.chmod(dir, 0o700).catch(() => {})
  // Make the directory entry itself durable in its parent.
  await fsyncDirectory(path.dirname(dir), faults)
}

const quarantineFile = async (
  logger: Logger,
  file: string,
  reason: string
): Promise<void> => {
  const quarantine = `${file}.${Date.now()}.corrupt`
  try {
    await fs.rename(file, quarantine)
    logger.warn(
      { file: path.basename(file), quarantine: path.basename(quarantine) },
      `quarantined instance state file (${reason})`
    )
  } catch (err) {
    logger.error(
      {
        file: path.basename(file),
        error: err instanceof Error ? err.message : String(err),
      },
      'failed to quarantine instance state file'
    )
  }
}

let tmpCounter = 0

/** tmp (0600) -> write -> fsync -> rename -> fsync(dir). */
const writeAtomic = async (
  dir: string,
  fileName: string,
  body: string,
  faults?: StoreFaults
): Promise<void> => {
  const injected = faults?.writeFile?.(fileName, dir)
  if (injected) throw injected
  const target = path.join(dir, fileName)
  const tmp = path.join(dir, `.${fileName}.tmp-${process.pid}-${++tmpCounter}`)
  let handle: fs.FileHandle | undefined
  try {
    handle = await fs.open(tmp, 'w', 0o600)
    await handle.writeFile(body, 'utf8')
    await handle.sync()
    await handle.close()
    handle = undefined
    await fs.rename(tmp, target)
    // Ensure the rename is durable too.
    await fsyncDirectory(dir, faults)
  } catch (err) {
    await handle?.close().catch(() => {})
    await fs.unlink(tmp).catch(() => {})
    throw err
  }
}

export class StateStore {
  private initialised = false

  constructor(
    private readonly dir: string,
    private readonly logger: Logger,
    private readonly faults?: StoreFaults
  ) {}

  get directory(): string {
    return this.dir
  }

  async init(): Promise<void> {
    if (this.initialised) return
    await ensureDir(this.dir, this.faults)
    await cleanupTempFiles(this.dir).catch(err => {
      this.logger.warn(
        { errorType: err instanceof Error ? err.name : typeof err },
        'failed to clean stale state temp files'
      )
    })
    this.initialised = true
  }

  /**
   * Read every record. Three outcomes are kept distinct:
   *  - a valid record is returned;
   *  - a malformed record (or one whose filename/id disagree) is quarantined
   *    AND its id is reported in `fences`, so the caller can persist a
   *    conservative tombstone instead of silently allowing the id to be reused;
   *  - a file that cannot be READ (EACCES/EIO...) is counted in `readErrors`;
   *    recovery must fail closed rather than treat the id as absent.
   */
  async load(): Promise<StateLoadResult> {
    await this.init()
    let entries: Dirent[]
    try {
      const injected = this.faults?.readdir?.(this.dir)
      if (injected) throw injected
      entries = await fs.readdir(this.dir, { withFileTypes: true })
    } catch (err) {
      if (errorCode(err) === 'ENOENT') {
        return { records: [], fences: [], readErrors: 0 }
      }
      this.logger.error(
        { errorType: err instanceof Error ? err.name : typeof err },
        'failed to read state directory'
      )
      throw err
    }

    const records: StoredInstance[] = []
    const fences = new Set<string>()
    let readErrors = 0
    for (const entry of entries) {
      if (!entry.isFile() || !entry.name.endsWith('.json')) continue
      const file = path.join(this.dir, entry.name)
      const id = entry.name.slice(0, -'.json'.length)
      let text: string | undefined
      try {
        text = await readPersistedFile(file, entry.name, this.dir, this.faults)
      } catch (err) {
        readErrors += 1
        this.logger.error(
          {
            file: entry.name,
            errorType: err instanceof Error ? err.name : typeof err,
          },
          'failed to read instance state file'
        )
        continue
      }
      if (text === undefined) continue
      const fence = async (reason: string): Promise<void> => {
        await quarantineFile(this.logger, file, reason)
        if (instanceIdSchema.safeParse(id).success) fences.add(id)
      }
      let raw: unknown
      try {
        raw = JSON.parse(text)
      } catch {
        await fence('unreadable')
        continue
      }
      const parsed = storedInstanceSchema.safeParse(raw)
      if (!parsed.success) {
        await fence('invalid record')
        continue
      }
      if (parsed.data.id !== id) {
        await fence('id/filename mismatch')
        continue
      }
      records.push({
        ...parsed.data,
        version: RECORD_VERSION,
        flagProviders: parsed.data.flagProviders ?? [],
        updatedAtMs: parsed.data.updatedAtMs ?? parsed.data.createdAtMs,
      })
    }
    return { records, fences: [...fences], readErrors }
  }

  async save(record: StoredInstance): Promise<void> {
    await this.init()
    await writeAtomic(
      this.dir,
      `${record.id}.json`,
      `${JSON.stringify(record)}\n`,
      this.faults
    )
  }

  async remove(id: string): Promise<void> {
    await this.init()
    const fileName = `${id}.json`
    await this.faults?.beforeRemove?.(fileName, this.dir)
    const injected = this.faults?.unlink?.(fileName, this.dir)
    if (injected) throw injected
    try {
      await fs.unlink(path.join(this.dir, fileName))
    } catch (err) {
      if (errorCode(err) !== 'ENOENT') throw err
    }
    await fsyncDirectory(this.dir, this.faults)
  }
}

/**
 * Deleted/finished ids are fenced for `tombstoneTtlSeconds` so that a delayed
 * duplicate PUT cannot resurrect a VM after the controller has confirmed a
 * DELETE. A tombstone only ever contains `{ id, atMs }` — never a spec or flag.
 */
export const tombstoneSchema = z.object({
  id: instanceIdSchema,
  atMs: z.number(),
})
export type StoredTombstone = z.output<typeof tombstoneSchema>

export class TombstoneStore {
  /** Tombstones confirmed durable on disk. */
  private readonly records = new Map<string, StoredTombstone>()
  /**
   * Fences that were attempted but whose disk write failed. They still fence
   * this process (so a concurrent PUT cannot win) but they are NOT durable and
   * can never be acknowledged to the controller: every DELETE retries the
   * write until it succeeds.
   */
  private readonly pending = new Map<string, StoredTombstone>()
  private readonly idLocks = new Map<string, Promise<void>>()
  private readonly dir: string
  private loaded = false
  private initialised = false

  constructor(
    stateDir: string,
    private readonly logger: Logger,
    private readonly faults?: StoreFaults,
    private readonly now: Clock = Date.now
  ) {
    this.dir = path.join(stateDir, 'tombstones')
  }

  get directory(): string {
    return this.dir
  }

  async init(): Promise<void> {
    if (this.initialised) return
    await ensureDir(this.dir, this.faults)
    await cleanupTempFiles(this.dir).catch(err => {
      this.logger.warn(
        { errorType: err instanceof Error ? err.name : typeof err },
        'failed to clean stale tombstone temp files'
      )
    })
    this.initialised = true
  }

  async load(): Promise<StoredTombstone[]> {
    await this.init()
    this.records.clear()
    this.pending.clear()
    let entries: Dirent[]
    try {
      const injected = this.faults?.readdir?.(this.dir)
      if (injected) throw injected
      entries = await fs.readdir(this.dir, { withFileTypes: true })
    } catch (err) {
      if (errorCode(err) === 'ENOENT') {
        this.loaded = true
        return []
      }
      this.logger.error(
        { errorType: err instanceof Error ? err.name : typeof err },
        'failed to read tombstone directory'
      )
      throw err
    }
    for (const entry of entries) {
      if (!entry.isFile() || !entry.name.endsWith('.json')) continue
      const file = path.join(this.dir, entry.name)
      const id = entry.name.slice(0, -'.json'.length)
      let text: string | undefined
      try {
        text = await readPersistedFile(file, entry.name, this.dir, this.faults)
      } catch (err) {
        // A fence that exists but cannot be read must never be treated as
        // absent: fail recovery closed and retry.
        this.logger.error(
          {
            file: entry.name,
            errorType: err instanceof Error ? err.name : typeof err,
          },
          'failed to read tombstone file'
        )
        throw new StateReadError(entry.name)
      }
      if (text === undefined) continue
      let raw: unknown
      let malformed = false
      try {
        raw = JSON.parse(text)
      } catch {
        malformed = true
      }
      const parsed = malformed ? undefined : tombstoneSchema.safeParse(raw)
      if (!parsed || !parsed.success || parsed.data.id !== id) {
        await quarantineFile(this.logger, file, 'invalid tombstone')
        // Never silently allow reuse of an id we cannot read a fence for.
        if (instanceIdSchema.safeParse(id).success) {
          await this.withId(id, () => this.writeFence(id, this.now()))
        }
        continue
      }
      this.records.set(id, parsed.data)
    }
    this.loaded = true
    return [...this.records.values()]
  }

  async ensureLoaded(): Promise<void> {
    if (!this.loaded) await this.load()
  }

  /** Serialise mutations for one id (fencing vs pruning must not interleave). */
  private async withId<T>(id: string, fn: () => Promise<T>): Promise<T> {
    const previous = this.idLocks.get(id) ?? Promise.resolve()
    let release!: () => void
    const current = new Promise<void>(resolve => {
      release = resolve
    })
    const tail = previous.then(() => current)
    this.idLocks.set(id, tail)
    await previous
    try {
      return await fn()
    } finally {
      release()
      if (this.idLocks.get(id) === tail) this.idLocks.delete(id)
    }
  }

  /** True while the id is fenced, whether or not the write is durable yet. */
  has(id: string): boolean {
    return this.records.has(id) || this.pending.has(id)
  }

  /** True only when the fence is confirmed on disk. */
  isDurable(id: string): boolean {
    return this.records.has(id)
  }

  get(id: string): StoredTombstone | undefined {
    return this.records.get(id) ?? this.pending.get(id)
  }

  list(): StoredTombstone[] {
    return [...this.records.values()]
  }

  /** Durably write and install one fence. Callers must hold the per-id lock. */
  private async writeFence(id: string, atMs: number): Promise<void> {
    const record: StoredTombstone = { id, atMs }
    this.pending.set(id, record)
    await writeAtomic(
      this.dir,
      `${id}.json`,
      `${JSON.stringify(record)}\n`,
      this.faults
    )
    this.records.set(id, record)
    this.pending.delete(id)
  }

  /**
   * Durably fence `id`. The in-memory pending entry is installed before the
   * write (so this process never admits a concurrent PUT) but only a completed
   * write promotes it to a durable tombstone. On failure the error propagates
   * and the next DELETE retries the same id.
   */
  async save(id: string, atMs: number): Promise<void> {
    if (!instanceIdSchema.safeParse(id).success) {
      throw new Error('invalid tombstone id')
    }
    await this.ensureLoaded()
    await this.init()
    await this.withId(id, () => this.writeFence(id, atMs))
  }

  async remove(id: string): Promise<void> {
    await this.ensureLoaded()
    await this.init()
    await this.withId(id, async () => {
      const fileName = `${id}.json`
      await this.faults?.beforeRemove?.(fileName, this.dir)
      const injected = this.faults?.unlink?.(fileName, this.dir)
      if (injected) throw injected
      try {
        await fs.unlink(path.join(this.dir, fileName))
      } catch (err) {
        if (errorCode(err) !== 'ENOENT') throw err
      }
      this.records.delete(id)
      this.pending.delete(id)
      await fsyncDirectory(this.dir, this.faults)
    })
  }

  /**
   * Drop durable tombstones at or past their TTL. Runs under the same per-id
   * guard as `save`, and re-checks the timestamp inside the guard, so a DELETE
   * that refreshes a tombstone can never lose the race to a concurrent prune.
   * Pending (unpersisted) fences are never pruned.
   */
  async prune(nowMs: number, ttlMs: number): Promise<string[]> {
    await this.ensureLoaded()
    const removed: string[] = []
    for (const id of Array.from(this.records.keys())) {
      await this.withId(id, async () => {
        const record = this.records.get(id)
        if (!record || nowMs - record.atMs < ttlMs) return
        const fileName = `${id}.json`
        await this.faults?.beforeRemove?.(fileName, this.dir)
        const injected = this.faults?.unlink?.(fileName, this.dir)
        if (injected) throw injected
        try {
          await fs.unlink(path.join(this.dir, fileName))
        } catch (err) {
          if (errorCode(err) !== 'ENOENT') throw err
        }
        this.records.delete(id)
        await fsyncDirectory(this.dir, this.faults)
        removed.push(id)
      })
    }
    return removed
  }
}
