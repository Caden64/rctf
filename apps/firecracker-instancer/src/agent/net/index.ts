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
  type QuarantineEntry,
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
import {
  applyRuleset,
  detectInstalledEgress,
  readInstalledRuleset,
  renderRuleset,
} from './nftables'
import { QuarantineStore, type QuarantineData } from './quarantine'
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

/*
 * `NetLease.egress` is immutable for the life of a lease: it is chosen at
 * allocation and never changed by publish/unpublish/restore. If a restored
 * lease's flag disagrees with the installed rules, restore fences and flushes
 * before re-rendering (see `restore`) rather than silently crossing the
 * policy change while old established flows still exist.
 */

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
  /** Lease ids whose ruleset is fenced (release in progress). */
  private readonly releasing = new Set<string>()
  /** Transient fence for restore transitions (e.g. an egress-policy change). */
  private readonly transitionFenced = new Set<string>()
  /** Egress transitions whose conntrack flush still has to succeed. */
  private readonly egressFlushPending = new Set<string>()
  private readonly quarantineStore: QuarantineStore
  private readonly quarantineReady: Promise<void>
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
      logger,
      config.ownerMarker
    )
    this.traefik = new TraefikFileManager(config, logger)
    this.quarantineStore = new QuarantineStore(
      config.quarantineFile,
      this.clock,
      logger
    )
    this.quarantineReady = this.loadQuarantine()
  }

  /**
   * Load persisted quarantine deadlines into the fresh allocators. A missing
   * file is normal. A corrupt/unreadable file is a hard fail-closed: every
   * currently unowned index/port is quarantined for one full period, so a
   * restart can never hand a just-released resource straight back out.
   */
  private async loadQuarantine(): Promise<void> {
    try {
      const result = await this.quarantineStore.load()
      if (result.corrupt) {
        this.ipam.quarantineAll()
        this.ports?.quarantineAll()
        return
      }
      this.ipam.applyQuarantine(result.data.indexes)
      this.ports?.applyQuarantine(result.data.ports)
    } catch (error) {
      this.ipam.quarantineAll()
      this.ports?.quarantineAll()
      this.logger?.error(
        { err: error, path: this.config.quarantineFile },
        'could not load network quarantine; failing closed for one quarantine period'
      )
    }
  }

  /**
   * Persist the current quarantine plus (optionally) resources about to be
   * freed, pruning expired entries. Callers decide whether a write failure is
   * fatal (release logs it and keeps the in-memory quarantine).
   */
  private async persistQuarantine(
    extra: Partial<QuarantineData> = {}
  ): Promise<void> {
    const merge = (
      first: readonly QuarantineEntry[],
      second: readonly QuarantineEntry[]
    ): QuarantineEntry[] => {
      const merged = new Map<number, number>()
      for (const entry of [...first, ...second]) {
        const existing = merged.get(entry.id)
        merged.set(
          entry.id,
          existing === undefined
            ? entry.expiresAtMs
            : Math.max(existing, entry.expiresAtMs)
        )
      }
      return [...merged.entries()].map(([id, expiresAtMs]) => ({
        id,
        expiresAtMs,
      }))
    }
    await this.quarantineStore.save({
      indexes: merge(this.ipam.quarantineEntries(), extra.indexes ?? []),
      ports: merge(this.ports?.quarantineEntries() ?? [], extra.ports ?? []),
    })
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
    const active = [...this.states.values()]
    const fenced = new Set([...this.releasing, ...this.transitionFenced])
    const published = new Set(
      active
        .filter(state => state.routed && !fenced.has(state.lease.instanceId))
        .map(state => state.lease.instanceId)
    )
    const ruleset = renderRuleset(
      active.map(state => state.lease),
      this.config,
      { published, fenced }
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

  private async flushConntrackFor(guestIp: string): Promise<void> {
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
    await flushConntrack(this.runner, { guestIp })
  }

  private async flushLeaseConntrack(lease: NetLease): Promise<void> {
    await this.flushConntrackFor(lease.guestIp)
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
        await this.taps.remove(tapName, { createdByUs: true })
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
      await this.quarantineReady
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
      await this.quarantineReady
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
      await this.quarantineReady
      assertInstanceId(instanceId)
      const state = this.states.get(instanceId)
      if (state === undefined) {
        // Idempotent: remove a possibly stale public route even when the
        // in-memory lease is gone (nothing to flush without a guest IP).
        await this.traefik.remove(instanceId)
        return
      }
      const lease = state.lease
      state.routed = false
      // Same fencing step as release: remove every accept/DNAT first, so no
      // flow created after the conntrack flush can survive a later publish.
      // Any failure keeps the lease fenced and retryable (no accepts restored).
      this.releasing.add(instanceId)
      await this.renderAndApply()
      await this.traefik.remove(instanceId)
      await this.flushLeaseConntrack(lease)
      this.releasing.delete(instanceId)
      // The tap stays alive and keeps every security rule, but no public
      // ingress. A failure here leaves the applied ruleset fenced (safe).
      await this.renderAndApply()
    })
  }

  async release(instanceId: string): Promise<void> {
    return this.mutex.run(async () => {
      await this.quarantineReady
      assertInstanceId(instanceId)
      const state = this.states.get(instanceId)
      if (state === undefined) {
        return
      }
      const lease = state.lease
      const expiresAt = this.clock() + this.quarantineMs
      // Keep the lease reserved AND fenced from here on. Every step below is
      // retried by calling release() again; nothing is freed until all pass.
      // On any failure `releasing` is deliberately kept: the lease stays
      // reserved and fenced (when the fence step itself failed, the old rules
      // are still the pre-release ones; a retry installs the fence first).
      this.releasing.add(instanceId)
      state.routed = false
      // (a) Fence first: only blocking rules remain (no DNAT/accepts).
      await this.renderAndApply()
      // (b) Remove public routes.
      await this.traefik.remove(instanceId)
      // (c) Delete the tap so the guest cannot inject packets any more.
      await this.taps.remove(lease.tapName)
      // (d) Flush conntrack in all four directions.
      await this.flushLeaseConntrack(lease)
      // (e) Persist the reuse quarantine BEFORE freeing in-memory state so a
      //     restart cannot forget it. Persistence failure is loud but not a
      //     reason to keep a torn-down lease reserved forever (the in-memory
      //     quarantine still applies); the production path is writable.
      try {
        await this.persistQuarantine({
          indexes: [{ id: state.index, expiresAtMs: expiresAt }],
          ports: Object.values(lease.publicPorts).map(port => ({
            id: port,
            expiresAtMs: expiresAt,
          })),
        })
      } catch (error) {
        this.logger?.error(
          { err: error, path: this.config.quarantineFile, instanceId },
          'could not persist network quarantine; reuse safety is not durable across restarts'
        )
      }
      this.releasing.delete(instanceId)
      this.egressFlushPending.delete(instanceId)
      this.states.delete(instanceId)
      this.usedMacs.delete(lease.guestMac)
      // Freed resources enter the reuse quarantine (conntrack just flushed).
      this.ipam.release(state.index, expiresAt)
      this.ports?.release(Object.values(lease.publicPorts), expiresAt)
      // The fence only matters while the lease is being torn down. Now that the
      // tap is gone and conntrack is flushed, re-render WITHOUT the retired
      // lease so its blocking rules do not accumulate in the ruleset forever
      // (found by the real smoke run). Best effort: the lease is already fully
      // released, and the next render of any lease rebuilds the whole table.
      try {
        await this.renderAndApply()
      } catch (error) {
        this.logger?.warn(
          { err: error, instanceId },
          'could not drop the retired lease from the ruleset; the next render will'
        )
      }
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
      await this.quarantineReady
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

      // Phase 2: authoritative replacement of the in-memory allocators. The
      // reuse quarantine is NOT reset: persisted deadlines from the previous
      // process (and any added since) are carried into the new allocators.
      const installed = await readInstalledRuleset(this.runner)
      const previousEgress = new Map<string, boolean>()
      for (const state of this.states.values()) {
        previousEgress.set(state.lease.instanceId, state.lease.egress)
      }
      const previousIndexes = this.ipam.quarantineEntries()
      const previousPorts = this.ports?.quarantineEntries() ?? []

      const restoredIds = new Set(staged.map(entry => entry.lease.instanceId))
      for (const id of Array.from(this.releasing)) {
        if (!restoredIds.has(id)) {
          this.releasing.delete(id)
        }
      }
      for (const id of Array.from(this.egressFlushPending)) {
        if (!restoredIds.has(id)) {
          this.egressFlushPending.delete(id)
        }
      }
      this.transitionFenced.clear()

      this.states.clear()
      this.usedMacs.clear()
      this.ipam = new Ipv4Pool(this.pool, this.allocatorOptions())
      this.ipam.applyQuarantine(previousIndexes)
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
      this.ports?.applyQuarantine(previousPorts)
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
          // A half-released lease stays reserved and fenced; it must not get
          // its public ingress (or a re-created tap) back on restore.
          routed: !this.releasing.has(lease.instanceId),
        })
      }

      // Egress is immutable per lease. If the installed rules show a different
      // policy than the restored lease (e.g. a corrupted/edited record, or a
      // transition that was interrupted), fence + flush before re-rendering so
      // established flows cannot cross the policy change.
      const egressTransitions: NetLease[] = []
      for (const { lease } of staged) {
        if (this.releasing.has(lease.instanceId)) {
          continue
        }
        const detected =
          detectInstalledEgress(installed, lease, this.config) ??
          previousEgress.get(lease.instanceId)
        if (
          this.egressFlushPending.has(lease.instanceId) ||
          (detected !== undefined && detected !== lease.egress)
        ) {
          egressTransitions.push(lease)
          this.egressFlushPending.add(lease.instanceId)
        }
      }
      if (egressTransitions.length > 0) {
        for (const lease of egressTransitions) {
          this.transitionFenced.add(lease.instanceId)
        }
        await this.renderAndApply()
        for (const lease of egressTransitions) {
          await this.flushLeaseConntrack(lease)
          this.egressFlushPending.delete(lease.instanceId)
          this.transitionFenced.delete(lease.instanceId)
        }
      }

      for (const state of this.states.values()) {
        if (this.releasing.has(state.lease.instanceId)) {
          // Mid-release: never re-create/modify the tap or re-add its routes.
          try {
            await this.traefik.remove(state.lease.instanceId)
          } catch (error) {
            this.logger?.warn(
              { err: error, instanceId: state.lease.instanceId },
              'could not remove routes of a half-released lease'
            )
            errors.push(error)
          }
          continue
        }
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
        if (this.releasing.has(state.lease.instanceId)) {
          continue
        }
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

      if (removed.some(entry => entry.startsWith('tap:'))) {
        try {
          await this.persistQuarantine()
        } catch (error) {
          this.logger?.warn(
            { err: error, path: this.config.quarantineFile },
            'could not persist orphan tap quarantine'
          )
        }
      }

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
   * Orphan tap cleanup with durable ownership evidence.
   *
   * A stray `fctapN` is only OURS when `ip -d -o link show` reports a tun/tap
   * link AND its interface alias is this host's `rctf-fc:<ownerMarker>`. The
   * name/address/state heuristics used previously adopted (and deleted) any
   * down+unaddressed `fctapN`; a foreign dummy interface named `fctap9` is now
   * always reported and left untouched.
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
      if (index === undefined || !this.taps.isOwned(info)) {
        this.logger?.warn(
          {
            tap: link,
            tapDevice: info.tapDevice,
            alias: info.alias,
            expectedAlias: this.taps.expectedAlias,
          },
          'leaving a non-agent fctap interface alone (no ownership evidence)'
        )
        result.keptOrphans.push(`tap:${link}`)
        continue
      }
      try {
        const { guestIp } = this.ipam.addresses(index)
        await this.flushConntrackFor(guestIp)
        await this.taps.remove(link)
        result.removed.push(`tap:${link}`)
        // An unknown-lease resource begins its reuse quarantine now.
        this.ipam.quarantine(index)
      } catch (error) {
        result.errors.push(error)
      }
    }
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
    await check(
      'conntrackBin',
      async () =>
        !this.config.requireConntrack || (await conntrackAvailable(this.runner))
    )
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
