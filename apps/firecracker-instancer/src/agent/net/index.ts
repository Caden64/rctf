import { constants as fsConstants } from 'node:fs'
import { access, readFile, stat } from 'node:fs/promises'
import {
  type Clock,
  type CommandRunner,
  type NetExposeRequest,
  type NetLease,
  type NetworkManager,
  NetworkCapacityError,
  type PublicEndpoint,
} from '../../interfaces'
import type { Logger } from '../../log'
import { bunCommandRunner } from '../../util/exec'
import {
  TraefikFileManager,
  publicHostname,
  type TraefikRoute,
} from '../routing/traefik'
import { conntrackAvailable, flushConntrack } from './conntrack'
import type { NetworkConfig } from './config'
import {
  Ipv4Pool,
  PortAllocator,
  parseSubnetPool,
  tapNameForIndex,
  type SubnetPool,
} from './ipam'
import {
  assertLeaseShape,
  cloneLease,
  deriveLeaseRoutes,
  isHostnameKind,
  isTcpKind,
  validateExpose,
} from './lease'
import { applyRuleset, renderRuleset } from './nftables'
import {
  TapController,
  TapNameConflictError,
  newTapOwnership,
  type TapInspection,
  type TapOwnership,
} from './tap'
import {
  TAP_NAME_REGEX,
  USER_GROUP_REGEX,
  assertHostname,
  assertIfaceName,
  assertInstanceId,
  assertPort,
  ENTRYPOINT_REGEX,
  isValidDomain,
  isValidPort,
  randomGuestMac,
} from './validate'

interface LeaseState {
  lease: NetLease
  /** Index into the pool (also the tap suffix). */
  index: number
  /** Whether this lease currently installs public ingress (DNAT/Traefik). */
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

const tapIndexFromName = (tapName: string): number | undefined => {
  if (!TAP_NAME_REGEX.test(tapName)) {
    return undefined
  }
  const suffix = tapName.slice('fctap'.length)
  const index = Number(suffix)
  return Number.isSafeInteger(index) ? index : undefined
}

const sameExpose = (
  left: readonly NetExposeRequest[],
  right: readonly NetExposeRequest[]
): boolean =>
  left.length === right.length &&
  left.every(
    (entry, index) =>
      entry.kind === right[index]?.kind &&
      entry.hostPrefix === right[index]?.hostPrefix &&
      entry.port === right[index]?.port
  )

class NetworkManagerImpl implements NetworkManager {
  private readonly pool: SubnetPool
  private ipam: Ipv4Pool
  private ports: PortAllocator | undefined
  private readonly portRangeValid: boolean
  private readonly states = new Map<string, LeaseState>()
  private readonly usedMacs = new Set<string>()
  private readonly mutex = new Mutex()
  private readonly taps: TapController
  private readonly traefik: TraefikFileManager
  private readonly quarantineMs: number
  private readonly clock: Clock
  /** Lease ids whose rules must already be gone (release in progress). */
  private readonly releasing = new Set<string>()
  private conntrackUsable = false

  constructor(
    private readonly config: NetworkConfig,
    private readonly runner: CommandRunner,
    private readonly logger?: Logger,
    clock?: Clock
  ) {
    this.clock = clock ?? Date.now
    this.quarantineMs = config.reuseQuarantineSeconds * 1_000
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
        config.tcpPortRange.to,
        this.allocatorOptions()
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
    this.ipam = new Ipv4Pool(this.pool, this.allocatorOptions())
    this.taps = new TapController(
      runner,
      { user: config.tapUser, group: config.tapGroup },
      logger
    )
    this.traefik = new TraefikFileManager(config, logger)
  }

  private allocatorOptions(): { quarantineMs: number; now: Clock } {
    return { quarantineMs: this.quarantineMs, now: this.clock }
  }

  // ---------------------------------------------------------------------
  // Ruleset plumbing
  // ---------------------------------------------------------------------

  /**
   * Re-render both nftables tables from EVERY live lease. Public ingress
   * (DNAT + its forward accept) is gated on `routed`; isolation, anti-spoof,
   * IPv6 drop, egress policy and ARP are rendered for every allocated lease so
   * `unpublish` never weakens a live tap.
   */
  private async renderAndApply(): Promise<void> {
    const active = [...this.states.values()].filter(
      state => !this.releasing.has(state.lease.instanceId)
    )
    const published = new Set(
      active.filter(state => state.routed).map(state => state.lease.instanceId)
    )
    const ruleset = renderRuleset(
      active.map(state => state.lease),
      this.config,
      { published }
    )
    await applyRuleset(this.runner, ruleset)
  }

  private traefikRoutes(state: LeaseState): TraefikRoute[] {
    const routes = deriveLeaseRoutes(state.lease)
    return routes.hostnames.map(route => ({
      index: route.index,
      kind: route.kind,
      hostname: route.hostname,
      guestIp: state.lease.guestIp,
      guestPort: route.guestPort,
    }))
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

  /**
   * conntrack-tools is required for safe reuse of guest IPs/public ports.
   * Allocation refuses early with a clear error when it is missing (unless
   * `network.requireConntrack: false`, a dev-only escape hatch).
   */
  private async ensureConntrack(): Promise<void> {
    if (this.conntrackUsable) {
      return
    }
    const available = await conntrackAvailable(this.runner)
    if (available) {
      this.conntrackUsable = true
      return
    }
    if (this.config.requireConntrack) {
      throw new Error(
        'conntrack-tools (`conntrack`) is required to isolate reused guest addresses/ports but is not available; install conntrack-tools or set network.requireConntrack=false (dev only)'
      )
    }
    this.conntrackUsable = false
  }

  private async flushConntrackFor(
    guestIp: string,
    publicPorts: Iterable<number>
  ): Promise<void> {
    if (!this.config.requireConntrack) {
      const available = await conntrackAvailable(this.runner)
      if (!available) {
        this.logger?.warn(
          { guestIp },
          'conntrack-tools missing; skipping conntrack flush (requireConntrack=false)'
        )
        return
      }
    }
    await flushConntrack(this.runner, { guestIp, publicPorts })
  }

  private async flushLeaseConntrack(lease: NetLease): Promise<void> {
    await this.flushConntrackFor(
      lease.guestIp,
      Object.values(lease.publicPorts)
    )
  }

  private async cleanupAllocation(args: {
    state: LeaseState | undefined
    owned: TapOwnership
    index: number
    ports: number[]
    blockIndex: boolean
  }): Promise<void> {
    const { state, owned, index, ports, blockIndex } = args
    if (state !== undefined) {
      this.states.delete(state.lease.instanceId)
      this.usedMacs.delete(state.lease.guestMac)
      await this.safe('re-render ruleset', () => this.renderAndApply())
    }
    let tapRemovalFailed = false
    if (owned.tapCreated) {
      const tapName = state?.lease.tapName ?? tapNameForIndex(index)
      try {
        await this.taps.remove(tapName)
      } catch (error) {
        tapRemovalFailed = true
        this.logger?.warn(
          { err: error, tap: tapName },
          'could not roll back tap; quarantining its /30 index'
        )
      }
    }
    // Ports/IPs of an allocation that never published cannot have conntrack
    // state (the VM was never launched), so they are freed immediately.
    this.ports?.discard(ports)
    if (tapRemovalFailed || blockIndex) {
      this.ipam.block(index)
    } else {
      this.ipam.discard(index)
    }
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
      await this.ensureConntrack()

      // Hostnames are a pure function of the instance id, so they can be
      // computed before any resource is reserved and a collision can fail the
      // allocation before anything needs rolling back.
      const publicHostnames: Record<number, string> = {}
      expose.forEach((entry, index) => {
        if (isHostnameKind(entry.kind)) {
          publicHostnames[index] = publicHostname(
            this.config,
            req.instanceId,
            entry.hostPrefix
          )
        }
      })
      await this.assertHostnamesFree(req.instanceId, publicHostnames)

      const tcpCount = expose.filter(entry => isTcpKind(entry.kind)).length
      let lastConflict: TapNameConflictError | undefined
      for (;;) {
        let index: number
        try {
          index = this.ipam.reserve()
        } catch (error) {
          if (lastConflict !== undefined) {
            throw new NetworkCapacityError(
              `could not find a free /30 for ${req.instanceId}: ${lastConflict.message}`
            )
          }
          throw error
        }
        let ports: number[] = []
        let state: LeaseState | undefined
        const owned = newTapOwnership()
        try {
          ports = this.ports.reserve(tcpCount)
          const { hostIp, guestIp } = this.ipam.addresses(index)
          const publicPorts: Record<number, number> = {}
          let cursor = 0
          expose.forEach((entry, position) => {
            if (!isTcpKind(entry.kind)) {
              return
            }
            const port = ports[cursor]
            cursor += 1
            if (port === undefined) {
              throw new Error('internal port reservation mismatch')
            }
            publicPorts[position] = port
          })
          const lease: NetLease = {
            instanceId: req.instanceId,
            tapName: tapNameForIndex(index),
            hostIp,
            guestIp,
            prefixLength: 30,
            guestMac: this.freshMac(),
            expose: expose.map(entry => ({ ...entry })),
            publicPorts,
            publicHostnames: { ...publicHostnames },
            egress: req.egress,
          }
          await this.taps.create(lease, owned)
          state = { lease, index, routed: false }
          this.states.set(req.instanceId, state)
          this.usedMacs.add(lease.guestMac)
          await this.renderAndApply()
          return cloneLease(lease)
        } catch (error) {
          await this.cleanupAllocation({
            state,
            owned,
            index,
            ports,
            blockIndex: error instanceof TapNameConflictError,
          })
          if (error instanceof TapNameConflictError) {
            // The name belongs to somebody else: never delete it, never
            // hand out that index again in this process, and try the next one.
            lastConflict = error
            continue
          }
          throw error
        }
      }
    })
  }

  /** Reject a hostname already owned by another live lease or Traefik file. */
  private async assertHostnamesFree(
    instanceId: string,
    hostnames: Record<number, string>
  ): Promise<void> {
    const values = Object.values(hostnames)
    for (const state of this.states.values()) {
      if (state.lease.instanceId === instanceId) {
        continue
      }
      const assigned = new Set(Object.values(state.lease.publicHostnames))
      for (const hostname of values) {
        if (assigned.has(hostname)) {
          throw new Error(
            `public hostname ${hostname} is already assigned to lease ${state.lease.instanceId}`
          )
        }
      }
    }
    for (const hostname of values) {
      if (await this.traefik.containsHostname(hostname, instanceId)) {
        throw new Error(
          `public hostname ${hostname} is already used by another Traefik route`
        )
      }
    }
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
      if (!sameExpose(state.lease.expose, exposeReq)) {
        throw new Error(
          `publish for ${lease.instanceId} disagrees with the lease expose list`
        )
      }
      state.routed = true
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
      if (state === undefined) {
        // Idempotent: remove a possibly stale public route even when the
        // in-memory lease is gone (nothing to flush without a guest IP).
        await this.traefik.remove(instanceId)
        return
      }
      const wasRouted = state.routed
      state.routed = false
      try {
        await this.renderAndApply()
      } catch (error) {
        state.routed = wasRouted
        throw error
      }
      await this.traefik.remove(instanceId)
      // The live tap keeps every security rule; only public ingress is gone.
      // Flush the published flows so a later publish/tenant cannot inherit
      // them (guests with no egress cannot re-open flows meanwhile).
      await this.flushLeaseConntrack(state.lease)
    })
  }

  async release(instanceId: string): Promise<void> {
    return this.mutex.run(async () => {
      assertInstanceId(instanceId)
      const state = this.states.get(instanceId)
      if (state === undefined) {
        return
      }
      const lease = state.lease
      this.releasing.add(instanceId)
      state.routed = false
      try {
        // Flush first: a failure keeps the lease reserved and retryable.
        await this.flushLeaseConntrack(lease)
        await this.traefik.remove(instanceId)
        // `remove` propagates real failures; only confirmed absence is
        // tolerated, so a failed deletion keeps the lease reserved.
        await this.taps.remove(lease.tapName)
        await this.renderAndApply()
      } catch (error) {
        this.releasing.delete(instanceId)
        throw error
      }
      this.releasing.delete(instanceId)
      this.states.delete(instanceId)
      this.usedMacs.delete(lease.guestMac)
      // Freed resources enter the reuse quarantine (conntrack just flushed).
      this.ipam.release(state.index)
      this.ports?.release(Object.values(lease.publicPorts))
    })
  }

  // ---------------------------------------------------------------------
  // Restore / preflight / endpoints
  // ---------------------------------------------------------------------

  private adoptLease(lease: NetLease): LeaseState {
    assertLeaseShape(lease)
    if (this.ports === undefined || !this.portRangeValid) {
      throw new Error('invalid tcpPortRange in network config')
    }
    const index = this.ipam.indexOf(lease.hostIp, lease.guestIp)
    if (lease.tapName !== tapNameForIndex(index)) {
      throw new Error(
        `lease ${lease.instanceId} tap ${lease.tapName} does not match its address index ${index}`
      )
    }
    // Validate every conflict BEFORE mutating the allocators.
    if (this.ipam.isAllocated(index)) {
      throw new Error(
        `/30 index ${index} of lease ${lease.instanceId} is already allocated`
      )
    }
    for (const port of Object.values(lease.publicPorts)) {
      assertPort(port)
      if (this.ports.isAllocated(port)) {
        throw new Error(`public port ${port} is allocated twice`)
      }
    }
    for (const hostname of Object.values(lease.publicHostnames)) {
      assertHostname(hostname)
    }
    if (this.usedMacs.has(lease.guestMac)) {
      throw new Error(`duplicate guest MAC in lease ${lease.instanceId}`)
    }
    for (const other of this.states.values()) {
      const assigned = new Set(Object.values(other.lease.publicHostnames))
      for (const hostname of Object.values(lease.publicHostnames)) {
        if (assigned.has(hostname)) {
          throw new Error(
            `public hostname ${hostname} is assigned to both ${other.lease.instanceId} and ${lease.instanceId}`
          )
        }
      }
    }
    this.ipam.adopt(index)
    for (const port of Object.values(lease.publicPorts)) {
      this.ports.adopt(port)
    }
    this.usedMacs.add(lease.guestMac)
    const state: LeaseState = {
      lease: cloneLease(lease),
      index,
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

  async restore(leases: NetLease[]): Promise<{
    removedOrphans: string[]
    keptOrphans: string[]
    skippedLeases: string[]
  }> {
    return this.mutex.run(async () => {
      const skippedLeases: string[] = []
      const keptOrphans: string[] = []
      const errors: unknown[] = []
      const range = this.config.tcpPortRange

      // Phase 1: validate shapes and range constraints without mutating the
      // allocators, so one bad lease cannot corrupt a restore.
      const staged: { lease: NetLease; index: number }[] = []
      for (const candidate of leases) {
        try {
          assertLeaseShape(candidate)
          const index = this.poolIndexFor(candidate)
          if (candidate.tapName !== tapNameForIndex(index)) {
            throw new Error(
              `lease ${candidate.instanceId} tap does not match its address index`
            )
          }
          for (const port of Object.values(candidate.publicPorts)) {
            if (!isValidPort(port) || port < range.from || port > range.to) {
              throw new Error(
                `lease ${candidate.instanceId} has public port ${port} outside tcpPortRange`
              )
            }
          }
          staged.push({ lease: cloneLease(candidate), index })
        } catch (error) {
          skippedLeases.push(candidate?.instanceId ?? 'unknown')
          this.logger?.warn(
            { err: error, instanceId: candidate?.instanceId },
            'skipping invalid/incomplete lease on restore'
          )
        }
      }

      // Structural duplicates stay hard errors: they mean two live VMs claim
      // the same host resources.
      const ids = new Set<string>()
      const taps = new Set<string>()
      const guests = new Set<string>()
      const macs = new Set<string>()
      const ports = new Set<number>()
      const hostnames = new Map<string, string>()
      for (const { lease } of staged) {
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
        for (const port of Object.values(lease.publicPorts)) {
          if (ports.has(port)) {
            throw new Error(`public port ${port} is allocated twice`)
          }
          ports.add(port)
        }
        for (const hostname of Object.values(lease.publicHostnames)) {
          const owner = hostnames.get(hostname)
          if (owner !== undefined && owner !== lease.instanceId) {
            throw new Error(
              `public hostname ${hostname} is assigned to both ${owner} and ${lease.instanceId}`
            )
          }
          hostnames.set(hostname, lease.instanceId)
        }
        for (const hostname of Object.values(lease.publicHostnames)) {
          if (await this.traefik.containsHostname(hostname, lease.instanceId)) {
            throw new Error(
              `public hostname ${hostname} of ${lease.instanceId} is also used by another Traefik file`
            )
          }
        }
      }

      // Phase 2: authoritative replacement of the in-memory allocators.
      this.states.clear()
      this.usedMacs.clear()
      this.releasing.clear()
      this.ipam = new Ipv4Pool(this.pool, this.allocatorOptions())
      let nextPorts: PortAllocator | undefined
      try {
        nextPorts = new PortAllocator(
          range.from,
          range.to,
          this.allocatorOptions()
        )
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
      for (const { lease, index } of staged) {
        this.ipam.adopt(index)
        for (const port of Object.values(lease.publicPorts)) {
          this.ports?.adopt(port)
        }
        this.usedMacs.add(lease.guestMac)
        this.states.set(lease.instanceId, {
          lease,
          index,
          routed: true,
        })
      }

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

      // Every route (kind, entrypoint, guest port) is rebuilt from the lease;
      // existing Traefik files are always rewritten, never trusted blindly.
      for (const state of this.states.values()) {
        await this.traefik.write(
          state.lease.instanceId,
          this.traefikRoutes(state)
        )
      }

      const removed: string[] = []
      removed.push(...(await this.traefik.removeOrphans(ids)))

      await this.removeStrayTaps({
        removed,
        keptOrphans,
        errors,
      })

      if (skippedLeases.length > 0) {
        this.logger?.warn(
          { skippedLeases },
          'restored without invalid/incomplete leases'
        )
      }
      if (errors.length > 0) {
        throw errors[0]
      }
      return {
        removedOrphans: removed.sort(),
        keptOrphans,
        skippedLeases: skippedLeases.sort(),
      }
    })
  }

  /**
   * Orphan tap cleanup with ownership evidence.
   *
   * A stray `fctapN` is only OURS when either
   *   - it is down and has no IPv4 address (an interrupted create), or
   *   - every IPv4 address on it is exactly the host side of the /30 that
   *     belongs to its own index inside `subnetPool`.
   * Anything else (a foreign address, or up without an address) is reported as
   * kept and left untouched: the name prefix alone is not proof of ownership.
   * (`ip -d link show` does not expose the tun owner uid reliably, so the
   * address/state pair is the evidence used here.)
   */
  private async removeStrayTaps(result: {
    removed: string[]
    keptOrphans: string[]
    errors: unknown[]
  }): Promise<void> {
    const links = await this.taps.listAgentLinks()
    const knownTaps = new Set(
      [...this.states.values()].map(state => state.lease.tapName)
    )
    for (const link of links) {
      if (knownTaps.has(link)) {
        continue
      }
      let info: TapInspection
      try {
        info = await this.taps.inspect(link)
      } catch (error) {
        result.errors.push(error)
        result.keptOrphans.push(`tap:${link}`)
        continue
      }
      if (!info.exists) {
        continue
      }
      const index = tapIndexFromName(link)
      if (index === undefined || !this.isOwnedStrayTap(index, info)) {
        this.logger?.warn(
          { tap: link, addresses: info.addresses, up: info.up },
          'leaving a non-agent fctap interface alone (ownership evidence mismatch)'
        )
        result.keptOrphans.push(`tap:${link}`)
        continue
      }
      try {
        const { guestIp } = this.ipam.addresses(index)
        await this.flushConntrackFor(guestIp, [])
        await this.taps.remove(link)
        result.removed.push(`tap:${link}`)
        // An unknown-lease resource begins its reuse quarantine now.
        this.ipam.quarantine(index)
      } catch (error) {
        result.errors.push(error)
      }
    }
  }

  private isOwnedStrayTap(index: number, info: TapInspection): boolean {
    let expected: string
    try {
      const { hostIp } = this.ipam.addresses(index)
      expected = `${hostIp}/30`
    } catch {
      return false
    }
    if (info.addresses.length === 0) {
      return !info.up
    }
    return info.addresses.every(address => address === expected)
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
    await check('conntrackBin', () => conntrackAvailable(this.runner))
    await check('ipForward', async () => {
      const text = await readFile('/proc/sys/net/ipv4/ip_forward', 'utf8')
      return text.trim() === '1'
    })
    await check('traefikDirWritable', () =>
      isDirWritable(this.config.traefikDynamicDir)
    )
    checks.tcpPortRange = this.portRangeValid
    checks.subnetPool = this.pool.capacity > 0
    return checks
  }

  // Pure: no host commands, deterministic in `expose` order.
  endpoints(lease: NetLease, expose: NetExposeRequest[]): PublicEndpoint[] {
    const exposeReq = validateExpose(expose)
    const derived = deriveLeaseRoutes(lease)
    const tcp = new Map(derived.tcp.map(route => [route.index, route]))
    return exposeReq.map((entry, index) => {
      const route = tcp.get(index)
      if (isTcpKind(entry.kind)) {
        if (route === undefined) {
          throw new Error(
            `lease ${lease.instanceId} has no public port for expose[${index}]`
          )
        }
        return {
          kind: entry.kind,
          host: this.config.publicHost,
          port: route.publicPort,
        }
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
  deps?: { runner?: CommandRunner; logger?: Logger; clock?: Clock }
): NetworkManager =>
  new NetworkManagerImpl(
    config,
    deps?.runner ?? bunCommandRunner,
    deps?.logger,
    deps?.clock
  )
