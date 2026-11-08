import {
  chmod,
  mkdir,
  readFile,
  readdir,
  rename,
  rm,
  writeFile,
} from 'node:fs/promises'
import { join } from 'node:path'
import {
  DNS_LABEL_REGEX,
  type ExposeKindValue,
} from '@rctf/firecracker-protocol'
import type { NetExposeRequest } from '../../interfaces'
import type { Logger } from '../../log'
import { assertInstanceId, isValidPort } from './validate'

const EXPOSE_KINDS: ReadonlySet<string> = new Set<ExposeKindValue>([
  'tcp',
  'tcp-ssl',
  'http',
  'https',
  'raw',
])

const FILE_REGEX = /^([a-z0-9]{16,32})\.json$/
const TMP_REGEX = /^\.([a-z0-9]{16,32})\.json\.tmp$/

/** `instanceId -> expose` sidecar, written by us so `restore()` can rebuild routing. */
export interface RouteRecord {
  instanceId: string
  expose: NetExposeRequest[]
}

const isRouteRecord = (
  value: unknown,
  expectedId: string
): value is RouteRecord => {
  if (typeof value !== 'object' || value === null) {
    return false
  }
  const record = value as Record<string, unknown>
  if (record.instanceId !== expectedId || !Array.isArray(record.expose)) {
    return false
  }
  return record.expose.every(entry => {
    if (typeof entry !== 'object' || entry === null) {
      return false
    }
    const expose = entry as Record<string, unknown>
    return (
      typeof expose.kind === 'string' &&
      EXPOSE_KINDS.has(expose.kind) &&
      typeof expose.hostPrefix === 'string' &&
      DNS_LABEL_REGEX.test(expose.hostPrefix) &&
      typeof expose.port === 'number' &&
      isValidPort(expose.port)
    )
  })
}

/**
 * Per-instance route sidecars (`<routesDir>/<instanceId>.json`, atomic,
 * 0600, no secrets). The frozen `NetLease` only maps expose indexes to public
 * ports/hostnames, not to guest ports, so DNAT and Traefik services cannot be
 * reconstructed from a lease alone after a restart.
 */
export class RouteStore {
  constructor(
    private readonly dir: string,
    private readonly logger?: Logger
  ) {}

  private pathFor(instanceId: string): string {
    return join(this.dir, `${assertInstanceId(instanceId)}.json`)
  }

  async write(record: RouteRecord): Promise<void> {
    assertInstanceId(record.instanceId)
    const path = this.pathFor(record.instanceId)
    await mkdir(this.dir, { recursive: true, mode: 0o700 })
    const tmp = join(this.dir, `.${record.instanceId}.json.tmp`)
    await writeFile(tmp, `${JSON.stringify(record)}\n`, { mode: 0o600 })
    await chmod(tmp, 0o600)
    await rename(tmp, path)
  }

  async read(instanceId: string): Promise<RouteRecord | undefined> {
    const path = this.pathFor(instanceId)
    let text: string
    try {
      text = await readFile(path, 'utf8')
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
        return undefined
      }
      throw error
    }
    try {
      const parsed: unknown = JSON.parse(text)
      if (isRouteRecord(parsed, instanceId)) {
        return { instanceId, expose: parsed.expose }
      }
      this.logger?.warn({ instanceId }, 'ignoring malformed route sidecar')
    } catch {
      this.logger?.warn({ instanceId }, 'ignoring unparsable route sidecar')
    }
    return undefined
  }

  async remove(instanceId: string): Promise<void> {
    await rm(this.pathFor(instanceId), { force: true })
  }

  async list(): Promise<string[]> {
    let entries: string[]
    try {
      entries = await readdir(this.dir)
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
        return []
      }
      throw error
    }
    return entries
      .map(name => FILE_REGEX.exec(name)?.[1])
      .filter((id): id is string => id !== undefined)
  }

  /**
   * Remove sidecars (and stale temp files) for ids that are not in `known`.
   * Returns `route:<id>` markers for the report.
   */
  async removeOrphans(known: ReadonlySet<string>): Promise<string[]> {
    let entries: string[]
    try {
      entries = await readdir(this.dir)
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
        return []
      }
      throw error
    }
    const removed: string[] = []
    for (const name of entries) {
      const id = FILE_REGEX.exec(name)?.[1]
      if (id !== undefined && !known.has(id)) {
        await rm(join(this.dir, name), { force: true })
        removed.push(`route:${id}`)
        continue
      }
      if (TMP_REGEX.test(name)) {
        await rm(join(this.dir, name), { force: true })
      }
    }
    return removed.sort()
  }
}
