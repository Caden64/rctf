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
  instanceIdSchema,
  readinessSchema,
  type AgentInstanceSpec,
} from '@rctf/firecracker-protocol'
import type { NetLease } from '../interfaces'
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
export const leaseToJson = (lease: NetLease): NetLease => ({
  instanceId: lease.instanceId,
  tapName: lease.tapName,
  hostIp: lease.hostIp,
  guestIp: lease.guestIp,
  prefixLength: lease.prefixLength,
  guestMac: lease.guestMac,
  publicPorts: { ...lease.publicPorts },
  publicHostnames: { ...lease.publicHostnames },
  egress: lease.egress,
})

const fsyncDirectory = async (dir: string): Promise<void> => {
  let handle: fs.FileHandle | undefined
  try {
    handle = await fs.open(dir, 'r')
    await handle.sync()
  } catch {
    // Some filesystems do not allow fsync on a directory; the rename itself is
    // still atomic. Durability across power loss is best-effort there.
  } finally {
    await handle?.close().catch(() => {})
  }
}

const ensureDir = async (dir: string): Promise<void> => {
  await fs.mkdir(dir, { recursive: true, mode: 0o700 })
  // `mkdir`'s mode is filtered by the umask; enforce it explicitly.
  await fs.chmod(dir, 0o700).catch(() => {})
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
  body: string
): Promise<void> => {
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
    await fsyncDirectory(dir)
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
    private readonly logger: Logger
  ) {}

  get directory(): string {
    return this.dir
  }

  async init(): Promise<void> {
    if (this.initialised) return
    await ensureDir(this.dir)
    this.initialised = true
  }

  /** All valid records. Corrupt files are quarantined and skipped. */
  async load(): Promise<StoredInstance[]> {
    await this.init()
    let entries: Dirent[]
    try {
      entries = await fs.readdir(this.dir, { withFileTypes: true })
    } catch (err) {
      this.logger.error(
        { error: err instanceof Error ? err.message : String(err) },
        'failed to read state directory'
      )
      return []
    }

    const records: StoredInstance[] = []
    for (const entry of entries) {
      if (!entry.isFile() || !entry.name.endsWith('.json')) continue
      const file = path.join(this.dir, entry.name)
      const id = entry.name.slice(0, -'.json'.length)
      let raw: unknown
      try {
        raw = JSON.parse(await fs.readFile(file, 'utf8'))
      } catch {
        await quarantineFile(this.logger, file, 'unreadable')
        continue
      }
      const parsed = storedInstanceSchema.safeParse(raw)
      if (!parsed.success) {
        await quarantineFile(this.logger, file, 'invalid record')
        continue
      }
      if (parsed.data.id !== id) {
        await quarantineFile(this.logger, file, 'id/filename mismatch')
        continue
      }
      records.push({
        ...parsed.data,
        version: RECORD_VERSION,
        flagProviders: parsed.data.flagProviders ?? [],
        updatedAtMs: parsed.data.updatedAtMs ?? parsed.data.createdAtMs,
      })
    }
    return records
  }

  async save(record: StoredInstance): Promise<void> {
    await this.init()
    await writeAtomic(
      this.dir,
      `${record.id}.json`,
      `${JSON.stringify(record)}\n`
    )
  }

  async remove(id: string): Promise<void> {
    await this.init()
    await fs.unlink(path.join(this.dir, `${id}.json`)).catch(() => {})
    await fsyncDirectory(this.dir)
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
  private readonly records = new Map<string, StoredTombstone>()
  private readonly dir: string
  private loaded = false
  private initialised = false

  constructor(
    stateDir: string,
    private readonly logger: Logger
  ) {
    this.dir = path.join(stateDir, 'tombstones')
  }

  get directory(): string {
    return this.dir
  }

  async init(): Promise<void> {
    if (this.initialised) return
    await ensureDir(this.dir)
    this.initialised = true
  }

  async load(): Promise<StoredTombstone[]> {
    await this.init()
    this.records.clear()
    let entries: Dirent[]
    try {
      entries = await fs.readdir(this.dir, { withFileTypes: true })
    } catch (err) {
      this.logger.error(
        { error: err instanceof Error ? err.message : String(err) },
        'failed to read tombstone directory'
      )
      this.loaded = true
      return []
    }
    for (const entry of entries) {
      if (!entry.isFile() || !entry.name.endsWith('.json')) continue
      const file = path.join(this.dir, entry.name)
      const id = entry.name.slice(0, -'.json'.length)
      let raw: unknown
      try {
        raw = JSON.parse(await fs.readFile(file, 'utf8'))
      } catch {
        await quarantineFile(this.logger, file, 'unreadable tombstone')
        continue
      }
      const parsed = tombstoneSchema.safeParse(raw)
      if (!parsed.success || parsed.data.id !== id) {
        await quarantineFile(this.logger, file, 'invalid tombstone')
        continue
      }
      this.records.set(parsed.data.id, parsed.data)
    }
    this.loaded = true
    return [...this.records.values()]
  }

  async ensureLoaded(): Promise<void> {
    if (!this.loaded) await this.load()
  }

  has(id: string): boolean {
    return this.records.has(id)
  }

  get(id: string): StoredTombstone | undefined {
    return this.records.get(id)
  }

  list(): StoredTombstone[] {
    return [...this.records.values()]
  }

  async save(id: string, atMs: number): Promise<void> {
    if (!instanceIdSchema.safeParse(id).success) {
      throw new Error('invalid tombstone id')
    }
    await this.ensureLoaded()
    await this.init()
    const record: StoredTombstone = { id, atMs }
    // Fence in memory first: even if the disk write fails, a concurrent PUT on
    // this running agent must not be allowed to resurrect the id.
    this.records.set(id, record)
    await writeAtomic(this.dir, `${id}.json`, `${JSON.stringify(record)}\n`)
  }

  async remove(id: string): Promise<void> {
    await this.ensureLoaded()
    await this.init()
    await fs.unlink(path.join(this.dir, `${id}.json`)).catch(() => {})
    this.records.delete(id)
    await fsyncDirectory(this.dir)
  }

  /** Drop tombstones at or past their TTL. Returns the pruned ids. */
  async prune(nowMs: number, ttlMs: number): Promise<string[]> {
    await this.ensureLoaded()
    const removed: string[] = []
    for (const record of Array.from(this.records.values())) {
      if (nowMs - record.atMs < ttlMs) continue
      await this.remove(record.id)
      removed.push(record.id)
    }
    return removed
  }
}
