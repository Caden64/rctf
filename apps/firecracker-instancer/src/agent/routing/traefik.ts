import {
  chmod,
  readFile,
  readdir,
  rename,
  rm,
  writeFile,
} from 'node:fs/promises'
import { join } from 'node:path'
import { stringify } from 'yaml'
import {
  DNS_LABEL_REGEX,
  type ExposeKindValue,
} from '@rctf/firecracker-protocol'
import type { Logger } from '../../log'
import type { NetworkConfig } from '../net/config'
import { MAX_HOST_PREFIX_LENGTH } from '../net/lease'
import {
  assertHostname,
  assertInstanceId,
  assertIpv4,
  assertPort,
} from '../net/validate'

/** One public route of one instance, ready to be rendered. */
export interface TraefikRoute {
  /** Index into the expose array; also the router/service name suffix. */
  index: number
  kind: ExposeKindValue
  hostname: string
  guestIp: string
  guestPort: number
}

const FILE_REGEX = /^rctf-fc-([a-z0-9]{16,32})\.yml$/
const TMP_REGEX = /^\.rctf-fc-([a-z0-9]{16,32})\.yml\.tmp$/

export const traefikFileName = (instanceId: string): string =>
  `rctf-fc-${assertInstanceId(instanceId)}.yml`

/**
 * `<hostPrefix>-<first 20 chars of instanceId>.<httpDomain>`.
 *
 * 20 chars of the instance id (instead of 10) keeps hostnames distinct for
 * realistic ids; a hostPrefix is limited to 32 characters so the label stays
 * within 63 bytes (32 + 1 + 20). Allocation additionally rejects a hostname
 * that a different lease (or a stale Traefik file) already owns.
 */
export const HOSTNAME_ID_CHARS = 20

export const publicHostname = (
  config: Pick<NetworkConfig, 'httpDomain'>,
  instanceId: string,
  hostPrefix: string
): string => {
  assertInstanceId(instanceId)
  if (!DNS_LABEL_REGEX.test(hostPrefix)) {
    throw new Error(`invalid hostPrefix: ${JSON.stringify(hostPrefix)}`)
  }
  if (hostPrefix.length > MAX_HOST_PREFIX_LENGTH) {
    throw new Error(
      `hostPrefix is longer than ${MAX_HOST_PREFIX_LENGTH} characters: ${JSON.stringify(hostPrefix)}`
    )
  }
  const hostname = `${hostPrefix}-${instanceId.slice(0, HOSTNAME_ID_CHARS)}.${config.httpDomain}`
  assertHostname(config.httpDomain)
  return assertHostname(hostname)
}

const isHttpKind = (kind: ExposeKindValue): boolean =>
  kind === 'http' || kind === 'https'

const tlsSettings = (
  config: NetworkConfig
): Record<string, string> | Record<string, never> =>
  config.certResolver === undefined ? {} : { certResolver: config.certResolver }

/**
 * Render one per-instance Traefik file-provider document. PURE: same input ->
 * same text (expose order). Every interpolated value is an int, an IPv4
 * address or a validated DNS name, so a backtick/space/quote cannot reach a
 * `Host()`/`HostSNI()` rule.
 */
export const renderTraefikFile = (
  instanceId: string,
  routes: readonly TraefikRoute[],
  config: NetworkConfig
): string => {
  assertInstanceId(instanceId)
  const httpRouters: Record<string, unknown> = {}
  const httpServices: Record<string, unknown> = {}
  const tcpRouters: Record<string, unknown> = {}
  const tcpServices: Record<string, unknown> = {}
  const seen = new Set<number>()

  for (const route of routes) {
    if (!Number.isInteger(route.index) || route.index < 0) {
      throw new Error(`invalid Traefik route index: ${route.index}`)
    }
    if (seen.has(route.index)) {
      throw new Error(`duplicate Traefik route index: ${route.index}`)
    }
    seen.add(route.index)
    assertHostname(route.hostname)
    assertIpv4(route.guestIp)
    assertPort(route.guestPort)
    const name = `rctf-fc-${instanceId}-${route.index}`
    if (isHttpKind(route.kind)) {
      const https = route.kind === 'https'
      httpRouters[name] = {
        rule: `Host(\`${route.hostname}\`)`,
        entryPoints: [https ? config.httpsEntrypoint : config.httpEntrypoint],
        service: name,
        ...(https ? { tls: tlsSettings(config) } : {}),
      }
      httpServices[name] = {
        loadBalancer: {
          servers: [{ url: `http://${route.guestIp}:${route.guestPort}` }],
        },
      }
    } else if (route.kind === 'tcp-ssl') {
      tcpRouters[name] = {
        rule: `HostSNI(\`${route.hostname}\`)`,
        entryPoints: [config.tcpSslEntrypoint],
        service: name,
        tls: tlsSettings(config),
      }
      tcpServices[name] = {
        loadBalancer: {
          servers: [{ address: `${route.guestIp}:${route.guestPort}` }],
        },
      }
    } else {
      // tcp/raw are served by nftables DNAT, never by Traefik.
      throw new Error(`route kind ${route.kind} is not a Traefik route`)
    }
  }

  const document: Record<string, unknown> = {}
  if (Object.keys(httpRouters).length > 0) {
    document.http = { routers: httpRouters, services: httpServices }
  }
  if (Object.keys(tcpRouters).length > 0) {
    document.tcp = { routers: tcpRouters, services: tcpServices }
  }
  if (Object.keys(document).length === 0) {
    throw new Error('refusing to render an empty Traefik file')
  }
  return stringify(document)
}

/**
 * Writes/removes the per-instance file-provider files. Atomic (temp file in the
 * same directory + rename), mode 0644 so Traefik can read them after dropping
 * privileges.
 */
export class TraefikFileManager {
  constructor(
    private readonly config: NetworkConfig,
    private readonly logger?: Logger
  ) {}

  private pathFor(instanceId: string): string {
    return join(this.config.traefikDynamicDir, traefikFileName(instanceId))
  }

  async write(
    instanceId: string,
    routes: readonly TraefikRoute[]
  ): Promise<void> {
    if (routes.length === 0) {
      await this.remove(instanceId)
      return
    }
    const path = this.pathFor(instanceId)
    const tmp = join(
      this.config.traefikDynamicDir,
      `.rctf-fc-${assertInstanceId(instanceId)}.yml.tmp`
    )
    const content = renderTraefikFile(instanceId, routes, this.config)
    await writeFile(tmp, content, { mode: 0o644 })
    await chmod(tmp, 0o644)
    await rename(tmp, path)
  }

  /** Idempotent, tolerant of a missing file. */
  async remove(instanceId: string): Promise<void> {
    await rm(this.pathFor(instanceId), { force: true })
  }

  async list(): Promise<string[]> {
    let entries: string[]
    try {
      entries = await readdir(this.config.traefikDynamicDir)
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
        this.logger?.warn(
          { dir: this.config.traefikDynamicDir },
          'traefik dynamic dir is missing'
        )
        return []
      }
      throw error
    }
    return entries
      .map(name => FILE_REGEX.exec(name)?.[1])
      .filter((id): id is string => id !== undefined)
  }

  /**
   * True when another instance's Traefik file already routes `hostname`.
   * Used by allocation to fail (and roll back) instead of silently creating
   * two routers for the same Host/HostSNI rule.
   */
  async containsHostname(
    hostname: string,
    exceptInstanceId?: string
  ): Promise<boolean> {
    const needle = `\`${assertHostname(hostname)}\``
    for (const id of await this.list()) {
      if (id === exceptInstanceId) {
        continue
      }
      try {
        const text = await readFile(this.pathFor(id), 'utf8')
        if (text.includes(needle)) {
          return true
        }
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'ENOENT') {
          throw error
        }
      }
    }
    return false
  }

  /** Remove files (and stale temp files) for ids that are not in `known`. */
  async removeOrphans(known: ReadonlySet<string>): Promise<string[]> {
    let entries: string[]
    try {
      entries = await readdir(this.config.traefikDynamicDir)
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
        return []
      }
      throw error
    }
    const removed: string[] = []
    for (const name of entries) {
      const id = FILE_REGEX.exec(name)?.[1]
      if (id !== undefined) {
        if (!known.has(id)) {
          await rm(join(this.config.traefikDynamicDir, name), { force: true })
          removed.push(`traefik:${id}`)
        }
        continue
      }
      if (TMP_REGEX.test(name)) {
        await rm(join(this.config.traefikDynamicDir, name), { force: true })
      }
    }
    return removed.sort()
  }
}
