import { type Clock, NetworkCapacityError } from '../../interfaces'
import {
  TAP_NAME_REGEX,
  formatIpv4,
  isValidPort,
  parseIpv4,
  parseIpv4Cidr,
} from './validate'

/** Largest tap index whose name still fits the 15 byte Linux interface limit. */
const MAX_TAP_INDEX = 9_999_999_999

export interface SubnetPool {
  /** IPv4 network address as an unsigned int (aligned to the prefix). */
  base: number
  prefixLength: number
  /** Number of /30 per-VM networks available in the pool. */
  capacity: number
  cidr: string
}

export const parseSubnetPool = (cidr: string): SubnetPool => {
  const parsed = parseIpv4Cidr(cidr)
  if (parsed === undefined) {
    throw new Error(
      `network.subnetPool is not an aligned IPv4 CIDR: ${JSON.stringify(cidr)}`
    )
  }
  if (parsed.prefixLength < 8 || parsed.prefixLength > 30) {
    throw new Error('network.subnetPool must be between /8 and /30')
  }
  if (!parsed.aligned) {
    throw new Error(
      `network.subnetPool is not an aligned IPv4 CIDR: ${JSON.stringify(cidr)}`
    )
  }
  return {
    base: parsed.base,
    prefixLength: parsed.prefixLength,
    capacity: Math.floor(parsed.size / 4),
    cidr,
  }
}

/** `fctap<index>`, always <= 15 bytes. */
export const tapNameForIndex = (index: number): string => {
  if (!Number.isInteger(index) || index < 0 || index > MAX_TAP_INDEX) {
    throw new Error(`invalid tap allocation index: ${index}`)
  }
  const name = `fctap${index}`
  if (!TAP_NAME_REGEX.test(name) || name.length > 15) {
    throw new Error(`tap name would be invalid: ${name}`)
  }
  return name
}

export interface AllocatorOptions {
  /**
   * How long a released entry stays out of circulation. Reusing a /30 or a
   * public port immediately would let conntrack state from the previous
   * tenant leak into the next one (see `conntrack.ts`), so the default in
   * production is `network.reuseQuarantineSeconds` (120 s).
   */
  quarantineMs?: number
  /** Injectable clock (ms since epoch) so quarantine tests are deterministic. */
  now?: Clock
}

interface FreedIndex {
  index: number
  /**
   * Absolute epoch-ms deadline. Absolute (not `at + quarantineMs`) so a
   * persisted quarantine keeps the same deadline if the configured quarantine
   * length changes across a restart.
   */
  expiresAt: number
}

export interface QuarantineEntry {
  id: number
  expiresAtMs: number
}

/**
 * Deterministic /30 allocator: index `i` -> network `base + 4*i`, host `.1`,
 * guest `.2`. The index is the tap suffix, so one number identifies the whole
 * per-VM network. Allocation is externally serialised (see
 * `createNetworkManager`); this class is not safe to call concurrently.
 *
 * Freed indexes are quarantined for `quarantineMs`: they are handed out again
 * (oldest release first) only once the quarantine has elapsed; before that,
 * never-used indexes are preferred. An index whose tap name already exists on
 * the host can be `block`ed so allocation does not keep retrying it.
 */
export class Ipv4Pool {
  private readonly used = new Set<number>()
  private readonly blocked = new Set<number>()
  private next = 0
  private readonly freed: FreedIndex[] = []
  private readonly quarantineMs: number
  private readonly now: Clock

  constructor(
    readonly pool: SubnetPool,
    options: AllocatorOptions = {}
  ) {
    this.quarantineMs = options.quarantineMs ?? 0
    this.now = options.now ?? Date.now
  }

  get capacity(): number {
    return this.pool.capacity
  }

  get allocated(): number {
    return this.used.size - this.blocked.size
  }

  get quarantined(): number {
    return this.freed.length
  }

  private rememberFreed(index: number, expiresAt: number): void {
    const existing = this.freed.find(entry => entry.index === index)
    if (existing !== undefined) {
      existing.expiresAt = Math.max(existing.expiresAt, expiresAt)
      return
    }
    this.freed.push({ index, expiresAt })
    this.freed.sort((a, b) => a.expiresAt - b.expiresAt || a.index - b.index)
  }

  reserve(): number {
    if (this.used.size >= this.pool.capacity) {
      throw new NetworkCapacityError(
        `subnetPool ${this.pool.cidr} exhausted (${this.pool.capacity} /30 networks)`
      )
    }
    const now = this.now()
    // Oldest release first, but only once its quarantine has elapsed.
    const head = this.freed[0]
    if (head !== undefined && now >= head.expiresAt) {
      this.freed.shift()
      if (!this.used.has(head.index) && !this.blocked.has(head.index)) {
        this.used.add(head.index)
        return head.index
      }
    }
    while (
      this.next < this.pool.capacity &&
      (this.used.has(this.next) || this.isQuarantined(this.next))
    ) {
      this.next += 1
    }
    if (this.next >= this.pool.capacity) {
      throw new NetworkCapacityError(
        `subnetPool ${this.pool.cidr} exhausted (${this.used.size}/${this.pool.capacity} in use, ${this.freed.length} in reuse quarantine)`
      )
    }
    const index = this.next
    this.next += 1
    this.used.add(index)
    return index
  }

  /** True when the index is handed out or permanently blocked. */
  isAllocated(index: number): boolean {
    return this.used.has(index)
  }

  /** Register an index that already exists on the host (restart re-adoption). */
  adopt(index: number): void {
    if (!Number.isInteger(index) || index < 0 || index >= this.pool.capacity) {
      throw new Error(`tap index ${index} is outside ${this.pool.cidr}`)
    }
    if (this.used.has(index)) {
      throw new Error(`tap index ${index} is allocated twice`)
    }
    this.forgetFreed(index)
    this.used.add(index)
  }

  /** Release a live index; it enters the reuse quarantine. */
  release(index: number, expiresAt = this.now() + this.quarantineMs): void {
    if (this.blocked.has(index)) {
      return
    }
    if (!this.used.delete(index)) {
      return
    }
    this.rememberFreed(index, expiresAt)
  }

  /**
   * Free an index that never carried guest traffic (allocation rollback):
   * immediate reuse is safe because the VM was never launched. It is placed in
   * the freed list with an already-expired timestamp so the next allocation
   * deterministically gets the same /30 back.
   */
  discard(index: number): void {
    if (this.blocked.has(index)) {
      return
    }
    this.used.delete(index)
    this.rememberFreed(index, this.now())
  }

  /**
   * Permanently exclude an index whose host artifact is not ours (e.g. a
   * pre-existing `fctapN` interface). It is never handed out by this process;
   * the next restore rebuilds the allocator and can reconsider it.
   */
  block(index: number): void {
    this.forgetFreed(index)
    this.used.add(index)
    this.blocked.add(index)
  }

  /**
   * Start the quarantine of a stray host resource that no live lease owns
   * (restore-time orphan): it is not allocated now, but reusable once the
   * quarantine elapses.
   */
  quarantine(index: number): void {
    if (!Number.isInteger(index) || index < 0 || index >= this.pool.capacity) {
      return
    }
    if (this.used.has(index) || this.blocked.has(index)) {
      return
    }
    this.rememberFreed(index, this.now() + this.quarantineMs)
  }

  /** Conservative fail-closed gate used when the quarantine file is corrupt. */
  quarantineAll(): void {
    if (this.quarantineMs <= 0) {
      return
    }
    const expiresAt = this.now() + this.quarantineMs
    for (let index = 0; index < this.pool.capacity; index++) {
      if (!this.used.has(index) && !this.blocked.has(index)) {
        this.rememberFreed(index, expiresAt)
      }
    }
  }

  /** Current (possibly expired) quarantine entries, for durable persistence. */
  quarantineEntries(): QuarantineEntry[] {
    return this.freed.map(entry => ({
      id: entry.index,
      expiresAtMs: entry.expiresAt,
    }))
  }

  /** Re-apply persisted deadlines without resetting them to `now`. */
  applyQuarantine(entries: readonly QuarantineEntry[]): void {
    for (const entry of entries) {
      if (
        !Number.isInteger(entry.id) ||
        entry.id < 0 ||
        entry.id >= this.pool.capacity ||
        !Number.isFinite(entry.expiresAtMs)
      ) {
        continue
      }
      if (this.used.has(entry.id) || this.blocked.has(entry.id)) {
        continue
      }
      this.rememberFreed(entry.id, entry.expiresAtMs)
    }
  }

  private forgetFreed(index: number): void {
    const position = this.freed.findIndex(entry => entry.index === index)
    if (position >= 0) {
      this.freed.splice(position, 1)
    }
  }

  private isQuarantined(index: number): boolean {
    return this.freed.some(entry => entry.index === index)
  }

  /** Host/guest addresses of the /30 at `index`. */
  addresses(index: number): { hostIp: string; guestIp: string } {
    if (!Number.isInteger(index) || index < 0 || index >= this.pool.capacity) {
      throw new Error(`tap index ${index} is outside ${this.pool.cidr}`)
    }
    const network = this.pool.base + index * 4
    return {
      hostIp: formatIpv4(network + 1),
      guestIp: formatIpv4(network + 2),
    }
  }

  /** Inverse of `addresses`, with full consistency checking. */
  indexOf(hostIp: string, guestIp: string): number {
    const host = parseIpv4(hostIp)
    const guest = parseIpv4(guestIp)
    if (host === undefined || guest === undefined) {
      throw new Error(`invalid lease addresses ${hostIp}/${guestIp}`)
    }
    if (guest !== host + 1) {
      throw new Error(`lease addresses ${hostIp}/${guestIp} are not .1/.2`)
    }
    const offset = host - this.pool.base
    if (offset < 0 || offset % 4 !== 1) {
      throw new Error(`host address ${hostIp} is not in ${this.pool.cidr}`)
    }
    const index = (offset - 1) / 4
    if (index < 0 || index >= this.pool.capacity) {
      throw new Error(`host address ${hostIp} is outside ${this.pool.cidr}`)
    }
    return index
  }
}

/**
 * Public TCP port allocator. One port per tcp/raw expose entry. Freed ports
 * are quarantined like /30 indexes (conntrack NAT mappings outlive the lease);
 * after the quarantine the oldest release is preferred, otherwise the lowest
 * never-used port wins.
 */
export class PortAllocator {
  private readonly used = new Set<number>()
  /** port -> absolute epoch-ms quarantine deadline. */
  private readonly expiresAt = new Map<number, number>()
  private readonly quarantineMs: number
  private readonly now: Clock

  constructor(
    readonly from: number,
    readonly to: number,
    options: AllocatorOptions = {}
  ) {
    if (!isValidPort(from) || !isValidPort(to) || from > to) {
      throw new Error(`invalid TCP port range ${from}-${to}`)
    }
    this.quarantineMs = options.quarantineMs ?? 0
    this.now = options.now ?? Date.now
  }

  get size(): number {
    return this.to - this.from + 1
  }

  get allocated(): number {
    return this.used.size
  }

  get quarantined(): number {
    return this.expiresAt.size
  }

  reserve(count: number): number[] {
    if (!Number.isInteger(count) || count < 0) {
      throw new Error(`invalid port reservation count: ${count}`)
    }
    if (count === 0) {
      return []
    }
    const now = this.now()
    const result: number[] = []
    const released = [...this.expiresAt.entries()]
      .filter(([, expiresAt]) => now >= expiresAt)
      .sort((a, b) => a[1] - b[1] || a[0] - b[0])
    for (const [port] of released) {
      if (result.length >= count) {
        break
      }
      if (!this.used.has(port)) {
        result.push(port)
      }
    }
    for (
      let port = this.from;
      port <= this.to && result.length < count;
      port++
    ) {
      if (!this.used.has(port) && !this.expiresAt.has(port)) {
        result.push(port)
      }
    }
    if (result.length !== count) {
      throw new NetworkCapacityError(
        `tcpPortRange ${this.from}-${this.to} exhausted (${this.used.size}/${this.size} in use, ${this.expiresAt.size} in reuse quarantine)`
      )
    }
    for (const port of result) {
      this.used.add(port)
      this.expiresAt.delete(port)
    }
    return result
  }

  /** True when the port is currently handed out. */
  isAllocated(port: number): boolean {
    return this.used.has(port)
  }

  adopt(port: number): void {
    if (!isValidPort(port)) {
      throw new Error(`invalid public port: ${port}`)
    }
    if (port < this.from || port > this.to) {
      throw new Error(`public port ${port} is outside ${this.from}-${this.to}`)
    }
    if (this.used.has(port)) {
      throw new Error(`public port ${port} is allocated twice`)
    }
    this.expiresAt.delete(port)
    this.used.add(port)
  }

  /** Release ports; they enter the reuse quarantine. */
  release(
    ports: Iterable<number>,
    expiresAt = this.now() + this.quarantineMs
  ): void {
    for (const port of ports) {
      if (this.used.delete(port)) {
        this.expiresAt.set(port, expiresAt)
      }
    }
  }

  /** Free ports of an allocation rollback (never carried traffic). */
  discard(ports: Iterable<number>): void {
    for (const port of ports) {
      this.used.delete(port)
      this.expiresAt.delete(port)
    }
  }

  /** Conservative fail-closed gate used when the quarantine file is corrupt. */
  quarantineAll(): void {
    if (this.quarantineMs <= 0) {
      return
    }
    const expiresAt = this.now() + this.quarantineMs
    for (let port = this.from; port <= this.to; port++) {
      if (!this.used.has(port)) {
        this.expiresAt.set(port, expiresAt)
      }
    }
  }

  /** Current (possibly expired) quarantine entries, for durable persistence. */
  quarantineEntries(): QuarantineEntry[] {
    return [...this.expiresAt.entries()].map(([port, expiresAtMs]) => ({
      id: port,
      expiresAtMs,
    }))
  }

  /** Re-apply persisted deadlines without resetting them to `now`. */
  applyQuarantine(entries: readonly QuarantineEntry[]): void {
    for (const entry of entries) {
      if (
        !isValidPort(entry.id) ||
        entry.id < this.from ||
        entry.id > this.to ||
        !Number.isFinite(entry.expiresAtMs)
      ) {
        continue
      }
      if (this.used.has(entry.id)) {
        continue
      }
      const existing = this.expiresAt.get(entry.id)
      this.expiresAt.set(
        entry.id,
        existing === undefined
          ? entry.expiresAtMs
          : Math.max(existing, entry.expiresAtMs)
      )
    }
  }
}
