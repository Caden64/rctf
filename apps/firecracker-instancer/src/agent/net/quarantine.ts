/**
 * Durable reuse-quarantine state.
 *
 * The in-memory allocators (see `ipam.ts`) forget their freed /30 indexes and
 * public ports when the agent restarts. That would undo the safety window that
 * keeps a released resource away from a new tenant (conntrack/NAT state from
 * the previous tenant can outlive the lease). This store persists ONLY resource
 * ids and their absolute expiry (epoch ms): no addresses, hostnames, flags or
 * other secrets.
 *
 * Writes are atomic (unique temp file + fsync + rename, mode 0600). A missing
 * file is an empty quarantine; a corrupt/unreadable one is reported to the
 * caller so it can fail closed for one quarantine period.
 */
import { chmod, mkdir, open, readFile, rename, rm } from 'node:fs/promises'
import { dirname } from 'node:path'
import type { Clock } from '../../interfaces'
import type { Logger } from '../../log'
import type { QuarantineEntry } from './ipam'

export interface QuarantineData {
  indexes: QuarantineEntry[]
  ports: QuarantineEntry[]
}

export interface QuarantineLoadResult {
  data: QuarantineData
  /** Missing file: the normal first-boot case. */
  missing: boolean
  /** Malformed or unreadable: callers must fail closed. */
  corrupt: boolean
}

const FORMAT_VERSION = 1

/**
 * Directory fsync is the only step some filesystems do not implement. Those
 * errors are safe to ignore (the rename itself is still atomic); a real I/O
 * error means the quarantine may not be durable and must reach the caller.
 */
const UNSUPPORTED_DIR_FSYNC = new Set([
  'EINVAL',
  'ENOTSUP',
  'EOPNOTSUPP',
  'ENOSYS',
])

const errorCode = (error: unknown): string | undefined =>
  typeof error === 'object' && error !== null && 'code' in error
    ? String((error as { code?: unknown }).code)
    : undefined

const isUnsupportedDirFsync = (error: unknown): boolean => {
  const code = errorCode(error)
  return code !== undefined && UNSUPPORTED_DIR_FSYNC.has(code)
}

const empty = (): QuarantineData => ({ indexes: [], ports: [] })

const parseEntries = (value: unknown): QuarantineEntry[] | undefined => {
  if (!Array.isArray(value)) {
    return undefined
  }
  const entries: QuarantineEntry[] = []
  for (const item of value) {
    if (typeof item !== 'object' || item === null) {
      return undefined
    }
    const { id, expiresAtMs } = item as { id?: unknown; expiresAtMs?: unknown }
    if (
      !Number.isInteger(id) ||
      (id as number) < 0 ||
      typeof expiresAtMs !== 'number' ||
      !Number.isFinite(expiresAtMs)
    ) {
      return undefined
    }
    entries.push({ id: id as number, expiresAtMs })
  }
  return entries
}

/** Pure: validate/normalise a parsed JSON value and drop expired entries. */
export const parseQuarantineDocument = (
  value: unknown,
  now: number
): QuarantineData | undefined => {
  if (typeof value !== 'object' || value === null) {
    return undefined
  }
  const doc = value as Record<string, unknown>
  if (doc['version'] !== FORMAT_VERSION) {
    return undefined
  }
  const indexes = parseEntries(doc['indexes'])
  const ports = parseEntries(doc['ports'])
  if (indexes === undefined || ports === undefined) {
    return undefined
  }
  const keep = (entries: QuarantineEntry[]): QuarantineEntry[] =>
    entries.filter(entry => entry.expiresAtMs > now)
  return { indexes: keep(indexes), ports: keep(ports) }
}

export class QuarantineStore {
  private reportedCorrupt = false

  constructor(
    private readonly path: string,
    private readonly clock: Clock,
    private readonly logger?: Logger
  ) {}

  async load(): Promise<QuarantineLoadResult> {
    let text: string
    try {
      text = await readFile(this.path, 'utf8')
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
        return { data: empty(), missing: true, corrupt: false }
      }
      this.reportCorrupt(error)
      return { data: empty(), missing: false, corrupt: true }
    }
    let parsed: unknown
    try {
      parsed = JSON.parse(text)
    } catch (error) {
      this.reportCorrupt(error)
      return { data: empty(), missing: false, corrupt: true }
    }
    const data = parseQuarantineDocument(parsed, this.clock())
    if (data === undefined) {
      this.reportCorrupt(new Error('unexpected quarantine file shape'))
      return { data: empty(), missing: false, corrupt: true }
    }
    return { data, missing: false, corrupt: false }
  }

  async save(data: QuarantineData): Promise<void> {
    const now = this.clock()
    const body = `${JSON.stringify({
      version: FORMAT_VERSION,
      indexes: data.indexes
        .filter(entry => entry.expiresAtMs > now)
        .sort((a, b) => a.id - b.id),
      ports: data.ports
        .filter(entry => entry.expiresAtMs > now)
        .sort((a, b) => a.id - b.id),
    })}\n`
    await mkdir(dirname(this.path), { recursive: true, mode: 0o700 })
    const tmp = `${this.path}.${process.pid}.${crypto.randomUUID()}.tmp`
    try {
      const file = await open(tmp, 'w', 0o600)
      try {
        await file.writeFile(body, 'utf8')
        await file.sync()
      } finally {
        await file.close()
      }
      await chmod(tmp, 0o600)
      await rename(tmp, this.path)
    } catch (error) {
      await rm(tmp, { force: true }).catch(() => undefined)
      throw error
    }
    // Make the rename itself durable. Some filesystems reject fsync on a
    // directory; the file contents are already fsynced, so only those specific
    // "unsupported" errors are ignored. A real I/O error means the quarantine
    // is not confirmed durable and must reach the caller (release retries).
    try {
      const dir = await open(dirname(this.path), 'r')
      try {
        await dir.sync()
      } finally {
        await dir.close()
      }
    } catch (error) {
      if (!isUnsupportedDirFsync(error)) {
        throw error
      }
    }
  }

  /**
   * Preflight: prove the quarantine file's directory can actually be written
   * (and a probe file removed) before the host takes any instances. Without
   * this, a misconfigured path only shows up on the first teardown, where a
   * failed quarantine now keeps the lease reserved on every retry.
   */
  async checkWritable(): Promise<boolean> {
    try {
      const dir = dirname(this.path)
      await mkdir(dir, { recursive: true, mode: 0o700 })
      const probe = `${this.path}.${process.pid}.${crypto.randomUUID()}.probe`
      try {
        const file = await open(probe, 'w', 0o600)
        try {
          await file.writeFile('probe\n', 'utf8')
          await file.sync()
        } finally {
          await file.close()
        }
      } finally {
        await rm(probe, { force: true })
      }
      return true
    } catch {
      return false
    }
  }

  private reportCorrupt(error: unknown): void {
    if (this.reportedCorrupt) {
      return
    }
    this.reportedCorrupt = true
    this.logger?.error(
      { err: error, path: this.path },
      'network quarantine file is unreadable/corrupt; failing closed for one quarantine period'
    )
  }
}
