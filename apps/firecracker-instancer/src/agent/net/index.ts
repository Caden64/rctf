import { constants as fsConstants } from 'node:fs'
import { access, readFile, stat } from 'node:fs/promises'
import {
  DNS_LABEL_REGEX,
  type ExposeKindValue,
} from '@rctf/firecracker-protocol'
import {
  type CommandRunner,
  type NetExposeRequest,
  type NetLease,
  type NetworkManager,
  type PublicEndpoint,
} from '../../interfaces'
import type { Logger } from '../../log'
import { bunCommandRunner } from '../../util/exec'
import {
  TraefikFileManager,
  publicHostname,
  type TraefikRoute,
} from '../routing/traefik'
import type { NetworkConfig } from './config'
import {
  Ipv4Pool,
  PortAllocator,
  parseSubnetPool,
  tapNameForIndex,
  type SubnetPool,
} from './ipam'
import { applyRuleset, renderRuleset, type GuestPorts } from './nftables'
import { RouteStore } from './routes'
import { TapController } from './tap'
import {
  ENTRYPOINT_REGEX,
  USER_GROUP_REGEX,
  assertHostname,
  assertIfaceName,
  assertInstanceId,
  assertIpv4,
  assertPort,
  assertTapName,
  isValidDomain,
  isValidMacAddress,
  isValidPort,
  randomGuestMac,
} from './validate'

const EXPOSE_KINDS: ReadonlySet<string> = new Set<ExposeKindValue>([
  'tcp',
  'tcp-ssl',
  'http',
  'https',
  'raw',
])

const cloneLease = (lease: NetLease): NetLease => ({
  ...lease,
  publicPorts: { ...lease.publicPorts },
  publicHostnames: { ...lease.publicHostnames },
})

interface LeaseState {
  lease: NetLease
  /** Index into the pool (also the tap suffix). */
  index: number
  expose: NetExposeRequest[]
  /** Whether this lease currently contributes rules/DNAT (false after unpublish). */
  routed: boolean
}

/** Tiny promise mutex: host operations and allocator mutations are serialised. */
class Mutex {
  private tail: Promise<unknown> = Promise.resolve()

  run<T>(fn: () => Promise<T>): Promise<T> {
    const result = this.tail.then(fn, fn)
    this.tail = result.then(
      () => undefined,
      () => undefined
    )
    return result
  }
}

const validateExpose = (
  input: readonly NetExposeRequest[]
): NetExposeRequest[] => {
  if (!Array.isArray(input)) {
    throw new Error('expose must be an array')
  }
  return input.map((entry, index) => {
    if (typeof entry !== 'object' || entry === null) {
      throw new Error(`expose[${index}] is not an object`)
    }
    if (!EXPOSE_KINDS.has(entry.kind)) {
      throw new Error(`expose[${index}] has an invalid kind: ${entry.kind}`)
    }
    if (!DNS_LABEL_REGEX.test(entry.hostPrefix)) {
      throw new Error(
        `expose[${index}] has an invalid hostPrefix: ${JSON.stringify(entry.hostPrefix)}`
      )
    }
    assertPort(entry.port)
    return { kind: entry.kind, hostPrefix: entry.hostPrefix, port: entry.port }
  })
}

const isTcpKind = (kind: ExposeKindValue): boolean =>
  kind === 'tcp' || kind === 'raw'

const isHostnameKind = (kind: ExposeKindValue): boolean =>
  kind === 'http' || kind === 'https' || kind === 'tcp-ssl'

const isDirWritable = async (path: string): Promise<boolean> => {
  try {
    const info = await stat(path)
    if (!info.isDirectory()) {
      return false
    }
    await access(path, fsConstants.W_OK)
    return true
  } catch {
    return false
  }
}

class NetworkManagerImpl implements NetworkManager {
  private readonly pool: SubnetPool
  private ipam: Ipv4Pool
  private ports: PortAllocator | undefined
  private readonly portRangeValid: boolean
  private readonly states = new Map<string, LeaseState>()
  private readonly usedMacs = new Set<string>()
  private readonly mutex = new Mutex()
  private readonly taps: TapController
  private readonly routeStore: RouteStore
  private readonly traefik: TraefikFileManager

  constructor(
    private readonly config: NetworkConfig,
    private readonly runner: CommandRunner,
    private readonly logger?: Logger
  ) {
    this.pool = parseSubnetPool(config.subnetPool)
    assertIfaceName(config.externalInterface)
    if (!isValidDomain(config.httpDomain)) {
      throw new Error(
        `invalid httpDomain: ${JSON.stringify(config.httpDomain)}`
      )
    }
    for (const [name, value] of [
      ['httpEntrypoint', config.httpEntrypoint],
      ['httpsEntrypoint', config.httpsEntrypoint],
      ['tcpSslEntrypoint', config.tcpSslEntrypoint],
    ] as const) {
      if (!ENTRYPOINT_REGEX.test(value)) {
        throw new Error(`invalid ${name}: ${JSON.stringify(value)}`)
      }
    }
    for (const [name, value] of [
      ['tapUser', config.tapUser],
      ['tapGroup', config.tapGroup],
    ] as const) {
      if (value !== undefined && !USER_GROUP_REGEX.test(value)) {
        throw new Error(`invalid ${name}: ${JSON.stringify(value)}`)
      }
    }
    for (const value of [
      config.httpPort,
      config.httpsPort,
      config.tcpSslPort,
    ]) {
      assertPort(value)
    }
    let ports: PortAllocator | undefined
    try {
      ports = new PortAllocator(
        config.tcpPortRange.from,
        config.tcpPortRange.to
      )
    } catch {
      ports = undefined
    }
    this.ports = ports
    const reservedPublicPorts = [
      config.httpPort,
      config.httpsPort,
      config.tcpSslPort,
    ]
    this.portRangeValid =
      ports !== undefined &&
      !reservedPublicPorts.some(
        port =>
          port >= config.tcpPortRange.from && port <= config.tcpPortRange.to
      )
    this.ipam = new Ipv4Pool(this.pool)
    this.taps = new TapController(
      runner,
      { user: config.tapUser, group: config.tapGroup },
      logger
    )
    this.routeStore = new RouteStore(config.routesDir, logger)
    this.traefik = new TraefikFileManager(config, logger)
  }

  // ---------------------------------------------------------------------
  // Ruleset plumbing
  // ---------------------------------------------------------------------

  private guestPortsOf(state: LeaseState): Record<number, number> {
    const result: Record<number, number> = {}
    state.expose.forEach((entry, index) => {
      if (
        isTcpKind(entry.kind) &&
        state.lease.publicPorts[index] !== undefined
      ) {
        result[index] = entry.port
      }
    })
    return result
  }

  private async renderAndApply(): Promise<void> {
    const active = [...this.states.values()].filter(state => state.routed)
    const guestPorts: Record<string, Record<number, number>> = {}
    for (const state of active) {
      guestPorts[state.lease.instanceId] = this.guestPortsOf(state)
    }
    const ruleset = renderRuleset(
      active.map(state => state.lease),
      this.config,
      guestPorts as GuestPorts
    )
    await applyRuleset(this.runner, ruleset)
  }

  private traefikRoutes(state: LeaseState): TraefikRoute[] {
    const routes: TraefikRoute[] = []
    state.expose.forEach((entry, index) => {
      if (!isHostnameKind(entry.kind)) {
        return
      }
      const hostname =
        state.lease.publicHostnames[index] ??
        publicHostname(this.config, state.lease.instanceId, entry.hostPrefix)
      assertHostname(hostname)
      routes.push({
        index,
        kind: entry.kind,
        hostname,
        guestIp: state.lease.guestIp,
        guestPort: entry.port,
      })
    })
    return routes
  }

  private freshMac(): string {
    for (let attempt = 0; attempt < 1024; attempt++) {
      const mac = randomGuestMac()
      if (!this.usedMacs.has(mac)) {
        return mac
      }
    }
    throw new Error('could not generate a unique guest MAC address')
  }

  private async safe(label: string, fn: () => Promise<unknown>): Promise<void> {
    try {
      await fn()
    } catch (error) {
      this.logger?.warn(
        { err: error, step: label },
        'network rollback step failed'
      )
    }
  }

  private async cleanupAllocation(
    state: LeaseState | undefined,
    index: number,
    ports: number[]
  ): Promise<void> {
    this.ports?.release(ports)
    this.ipam.release(index)
    if (state === undefined) {
      return
    }
    this.states.delete(state.lease.instanceId)
    this.usedMacs.delete(state.lease.guestMac)
    await this.safe('remove route sidecar', () =>
      this.routeStore.remove(state.lease.instanceId)
    )
    await this.safe('remove traefik file', () =>
      this.traefik.remove(state.lease.instanceId)
    )
    await this.safe('re-render ruleset', () => this.renderAndApply())
    await this.safe('delete tap', () => this.taps.remove(state.lease.tapName))
  }

  // ---------------------------------------------------------------------
  // Allocation
  // ---------------------------------------------------------------------

  async allocate(req: {
    instanceId: string
    egress: boolean
    expose: NetExposeRequest[]
  }): Promise<NetLease> {
    return this.mutex.run(async () => {
      assertInstanceId(req.instanceId)
      if (typeof req.egress !== 'boolean') {
        throw new Error('egress must be a boolean')
      }
      const expose = validateExpose(req.expose)
      const existing = this.states.get(req.instanceId)
      if (existing !== undefined) {
        return cloneLease(existing.lease)
      }
      if (this.ports === undefined || !this.portRangeValid) {
        throw new Error(
          `invalid tcpPortRange ${this.config.tcpPortRange.from}-${this.config.tcpPortRange.to} (must be a valid range that excludes httpPort/httpsPort/tcpSslPort)`
        )
      }
      const index = this.ipam.reserve()
      let ports: number[] = []
      let state: LeaseState | undefined
      try {
        ports = this.ports.reserve(
          expose.filter(entry => isTcpKind(entry.kind)).length
        )
        const { hostIp, guestIp } = this.ipam.addresses(index)
        const publicPorts: Record<number, number> = {}
        let cursor = 0
        const publicHostnames: Record<number, string> = {}
        expose.forEach((entry, position) => {
          if (isTcpKind(entry.kind)) {
            const port = ports[cursor]
            cursor += 1
            if (port === undefined) {
              throw new Error('internal port reservation mismatch')
            }
            publicPorts[position] = port
          } else {
            publicHostnames[position] = publicHostname(
              this.config,
              req.instanceId,
              entry.hostPrefix
            )
          }
        })
        const lease: NetLease = {
          instanceId: req.instanceId,
          tapName: tapNameForIndex(index),
          hostIp,
          guestIp,
          prefixLength: 30,
          guestMac: this.freshMac(),
          publicPorts,
          publicHostnames,
          egress: req.egress,
        }
        state = { lease, index, expose, routed: true }
        await this.routeStore.write({ instanceId: req.instanceId, expose })
        await this.taps.create(lease)
        this.states.set(req.instanceId, state)
        this.usedMacs.add(lease.guestMac)
        await this.renderAndApply()
        return cloneLease(lease)
      } catch (error) {
        await this.cleanupAllocation(state, index, ports)
        throw error
      }
    })
  }

  // ---------------------------------------------------------------------
  // Publish / unpublish / release
  // ---------------------------------------------------------------------

  async publish(lease: NetLease, expose: NetExposeRequest[]): Promise<void> {
    return this.mutex.run(async () => {
      const exposeReq = validateExpose(expose)
      let state = this.states.get(lease.instanceId)
      if (state === undefined) {
        state = this.adoptLease(lease)
      } else {
        this.assertSameLease(state.lease, lease)
      }
      state.expose = exposeReq
      state.routed = true
      await this.routeStore.write({
        instanceId: state.lease.instanceId,
        expose: exposeReq,
      })
      await this.renderAndApply()
      await this.traefik.write(
        state.lease.instanceId,
        this.traefikRoutes(state)
      )
    })
  }

  async unpublish(instanceId: string): Promise<void> {
    return this.mutex.run(async () => {
      assertInstanceId(instanceId)
      const state = this.states.get(instanceId)
      if (state !== undefined) {
        const wasRouted = state.routed
        state.routed = false
        try {
          await this.renderAndApply()
        } catch (error) {
          state.routed = wasRouted
          throw error
        }
      }
      await this.traefik.remove(instanceId)
    })
  }

  async release(instanceId: string): Promise<void> {
    return this.mutex.run(async () => {
      assertInstanceId(instanceId)
      const state = this.states.get(instanceId)
      if (state === undefined) {
        return
      }
      await this.traefik.remove(instanceId)
      await this.routeStore.remove(instanceId)
      await this.taps.remove(state.lease.tapName)
      state.routed = false
      // Only free the allocator entries after the last fallible host step, so a
      // failed release can simply be retried (the individual steps are
      // idempotent and tolerate already-missing artifacts).
      await this.renderAndApply()
      this.ipam.release(state.index)
      this.ports?.release(Object.values(state.lease.publicPorts))
      this.usedMacs.delete(state.lease.guestMac)
      this.states.delete(instanceId)
    })
  }

  // ---------------------------------------------------------------------
  // Restore / preflight / endpoints
  // ---------------------------------------------------------------------

  private adoptLease(lease: NetLease): LeaseState {
    assertInstanceId(lease.instanceId)
    assertTapName(lease.tapName)
    assertIpv4(lease.hostIp)
    assertIpv4(lease.guestIp)
    if (lease.prefixLength !== 30) {
      throw new Error(`lease ${lease.instanceId} must use a /30`)
    }
    if (!isValidMacAddress(lease.guestMac)) {
      throw new Error(`invalid guest MAC in lease ${lease.instanceId}`)
    }
    if (typeof lease.egress !== 'boolean') {
      throw new Error(`invalid egress flag in lease ${lease.instanceId}`)
    }
    if (this.ports === undefined || !this.portRangeValid) {
      throw new Error('invalid tcpPortRange in network config')
    }
    const index = this.ipam.indexOf(lease.hostIp, lease.guestIp)
    if (lease.tapName !== tapNameForIndex(index)) {
      throw new Error(
        `lease ${lease.instanceId} tap ${lease.tapName} does not match its address index ${index}`
      )
    }
    this.ipam.adopt(index)
    for (const port of Object.values(lease.publicPorts)) {
      assertPort(port)
      this.ports.adopt(port)
    }
    for (const hostname of Object.values(lease.publicHostnames)) {
      assertHostname(hostname)
    }
    if (this.usedMacs.has(lease.guestMac)) {
      throw new Error(`duplicate guest MAC in lease ${lease.instanceId}`)
    }
    this.usedMacs.add(lease.guestMac)
    const state: LeaseState = {
      lease: cloneLease(lease),
      index,
      expose: [],
      routed: false,
    }
    this.states.set(lease.instanceId, state)
    return state
  }

  private assertSameLease(existing: NetLease, incoming: NetLease): void {
    for (const key of [
      'tapName',
      'hostIp',
      'guestIp',
      'prefixLength',
      'guestMac',
    ] as const) {
      if (existing[key] !== incoming[key]) {
        throw new Error(
          `publish for ${incoming.instanceId} disagrees on ${key}: ${String(existing[key])} != ${String(incoming[key])}`
        )
      }
    }
  }

  async restore(leases: NetLease[]): Promise<{ removedOrphans: string[] }> {
    return this.mutex.run(async () => {
      const ids = new Set<string>()
      const taps = new Set<string>()
      const guests = new Set<string>()
      const publicPorts = new Set<number>()
      const macs = new Set<string>()
      const staged: { lease: NetLease; index: number }[] = []
      const range = this.config.tcpPortRange
      for (const lease of leases) {
        assertInstanceId(lease.instanceId)
        assertTapName(lease.tapName)
        assertIpv4(lease.hostIp)
        assertIpv4(lease.guestIp)
        if (lease.prefixLength !== 30) {
          throw new Error(`lease ${lease.instanceId} must use a /30`)
        }
        if (!isValidMacAddress(lease.guestMac)) {
          throw new Error(`invalid guest MAC in lease ${lease.instanceId}`)
        }
        if (typeof lease.egress !== 'boolean') {
          throw new Error(`invalid egress flag in lease ${lease.instanceId}`)
        }
        if (ids.has(lease.instanceId)) {
          throw new Error(`duplicate lease instanceId: ${lease.instanceId}`)
        }
        ids.add(lease.instanceId)
        if (taps.has(lease.tapName)) {
          throw new Error(`duplicate lease tap: ${lease.tapName}`)
        }
        taps.add(lease.tapName)
        if (guests.has(lease.guestIp)) {
          throw new Error(`duplicate lease guest address: ${lease.guestIp}`)
        }
        guests.add(lease.guestIp)
        if (macs.has(lease.guestMac)) {
          throw new Error(`duplicate lease guest MAC: ${lease.guestMac}`)
        }
        macs.add(lease.guestMac)
        const index = this.poolIndexFor(lease)
        if (lease.tapName !== tapNameForIndex(index)) {
          throw new Error(
            `lease ${lease.instanceId} tap does not match its address index`
          )
        }
        for (const port of Object.values(lease.publicPorts)) {
          if (!isValidPort(port) || port < range.from || port > range.to) {
            throw new Error(
              `lease ${lease.instanceId} has public port ${port} outside tcpPortRange`
            )
          }
          if (publicPorts.has(port)) {
            throw new Error(`public port ${port} is allocated twice`)
          }
          publicPorts.add(port)
        }
        for (const hostname of Object.values(lease.publicHostnames)) {
          assertHostname(hostname)
        }
        staged.push({ lease: cloneLease(lease), index })
      }

      // Authoritative replacement: the caller owns the live set.
      this.states.clear()
      this.usedMacs.clear()
      this.ipam = new Ipv4Pool(this.pool)
      let nextPorts: PortAllocator | undefined
      try {
        nextPorts = new PortAllocator(range.from, range.to)
      } catch {
        nextPorts = undefined
      }
      this.ports = nextPorts
      if (
        (!this.portRangeValid || this.ports === undefined) &&
        staged.some(entry => Object.keys(entry.lease.publicPorts).length > 0)
      ) {
        throw new Error(
          `invalid tcpPortRange ${range.from}-${range.to} blocks restoring DNAT leases`
        )
      }
      const records = new Map<string, Awaited<ReturnType<RouteStore['read']>>>()
      for (const { lease, index } of staged) {
        this.ipam.adopt(index)
        for (const port of Object.values(lease.publicPorts)) {
          this.ports?.adopt(port)
        }
        this.usedMacs.add(lease.guestMac)
        const record = await this.routeStore.read(lease.instanceId)
        records.set(lease.instanceId, record)
        this.states.set(lease.instanceId, {
          lease,
          index,
          expose: record?.expose ?? [],
          routed: true,
        })
      }

      const errors: unknown[] = []
      for (const state of this.states.values()) {
        try {
          await this.taps.ensure(state.lease)
        } catch (error) {
          this.logger?.warn(
            { err: error, instanceId: state.lease.instanceId },
            'could not re-assert tap'
          )
          errors.push(error)
        }
      }

      await this.renderAndApply()

      for (const state of this.states.values()) {
        const record = records.get(state.lease.instanceId)
        if (record === undefined) {
          // No guest-port sidecar (crash before it was written): leave the
          // existing Traefik file alone rather than deleting a working route.
          continue
        }
        await this.traefik.write(
          state.lease.instanceId,
          this.traefikRoutes(state)
        )
      }

      const removed: string[] = []
      removed.push(...(await this.traefik.removeOrphans(ids)))
      removed.push(...(await this.routeStore.removeOrphans(ids)))

      try {
        const links = await this.taps.listAgentLinks()
        const knownTaps = new Set(
          [...this.states.values()].map(state => state.lease.tapName)
        )
        for (const link of links) {
          if (!knownTaps.has(link)) {
            await this.taps.remove(link)
            removed.push(`tap:${link}`)
          }
        }
      } catch (error) {
        this.logger?.warn(
          { err: error },
          'could not list taps for orphan cleanup'
        )
      }

      if (errors.length > 0) {
        throw errors[0]
      }
      return { removedOrphans: removed.sort() }
    })
  }

  private poolIndexFor(lease: NetLease): number {
    return this.ipam.indexOf(lease.hostIp, lease.guestIp)
  }

  async preflight(): Promise<Record<string, boolean>> {
    const checks: Record<string, boolean> = {}
    const check = async (
      key: string,
      fn: () => Promise<boolean>
    ): Promise<void> => {
      try {
        checks[key] = await fn()
      } catch {
        checks[key] = false
      }
    }
    await check('nft', async () => {
      const result = await this.runner.run(['nft', '--version'], {
        timeoutMs: 5_000,
      })
      return result.code === 0
    })
    await check('ip', async () => {
      const result = await this.runner.run(['ip', '-V'], { timeoutMs: 5_000 })
      return result.code === 0
    })
    await check('ipForward', async () => {
      const text = await readFile('/proc/sys/net/ipv4/ip_forward', 'utf8')
      return text.trim() === '1'
    })
    await check('traefikDirWritable', () =>
      isDirWritable(this.config.traefikDynamicDir)
    )
    await check('routesDirWritable', () => isDirWritable(this.config.routesDir))
    checks.tcpPortRange = this.portRangeValid
    checks.subnetPool = this.pool.capacity > 0
    return checks
  }

  // Pure: no host commands, deterministic in `expose` order.
  endpoints(lease: NetLease, expose: NetExposeRequest[]): PublicEndpoint[] {
    const exposeReq = validateExpose(expose)
    return exposeReq.map((entry, index) => {
      if (isTcpKind(entry.kind)) {
        const port = lease.publicPorts[index]
        if (port === undefined) {
          throw new Error(
            `lease ${lease.instanceId} has no public port for expose[${index}]`
          )
        }
        return { kind: entry.kind, host: this.config.publicHost, port }
      }
      const host = lease.publicHostnames[index]
      if (host === undefined) {
        throw new Error(
          `lease ${lease.instanceId} has no hostname for expose[${index}]`
        )
      }
      assertHostname(host)
      const port =
        entry.kind === 'http'
          ? this.config.httpPort
          : entry.kind === 'https'
            ? this.config.httpsPort
            : this.config.tcpSslPort
      return { kind: entry.kind, host, port }
    })
  }
}

export const createNetworkManager = (
  config: NetworkConfig,
  deps?: { runner?: CommandRunner; logger?: Logger }
): NetworkManager =>
  new NetworkManagerImpl(config, deps?.runner ?? bunCommandRunner, deps?.logger)
