import { NetworkCapacityError } from '../../interfaces'
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

const heapPush = (heap: number[], value: number): void => {
  heap.push(value)
  let node = heap.length - 1
  while (node > 0) {
    const parent = (node - 1) >> 1
    if ((heap[parent] ?? 0) <= value) {
      break
    }
    heap[node] = heap[parent] ?? 0
    node = parent
  }
  heap[node] = value
}

const heapPop = (heap: number[]): number | undefined => {
  const first = heap[0]
  const last = heap.pop()
  if (first === undefined || last === undefined || heap.length === 0) {
    return first
  }
  let node = 0
  for (;;) {
    const left = node * 2 + 1
    const right = left + 1
    if (left >= heap.length) {
      break
    }
    const child =
      right < heap.length && (heap[right] ?? 0) < (heap[left] ?? 0)
        ? right
        : left
    if ((heap[child] ?? 0) >= last) {
      break
    }
    heap[node] = heap[child] ?? 0
    node = child
  }
  heap[node] = last
  return first
}

/**
 * Deterministic /30 allocator: index `i` -> network `base + 4*i`, host `.1`,
 * guest `.2`. The index is the tap suffix, so one number identifies the whole
 * per-VM network. Allocation is externally serialised (see `createNetworkManager`);
 * this class is not safe to call concurrently.
 */
export class Ipv4Pool {
  private readonly used = new Set<number>()
  private next = 0
  private readonly freed: number[] = []

  constructor(readonly pool: SubnetPool) {}

  get capacity(): number {
    return this.pool.capacity
  }

  get allocated(): number {
    return this.used.size
  }

  reserve(): number {
    if (this.used.size >= this.pool.capacity) {
      throw new NetworkCapacityError(
        `subnetPool ${this.pool.cidr} exhausted (${this.pool.capacity} /30 networks)`
      )
    }
    let index: number | undefined
    while (this.freed.length > 0) {
      const candidate = heapPop(this.freed)
      if (candidate !== undefined && !this.used.has(candidate)) {
        index = candidate
        break
      }
    }
    if (index === undefined) {
      while (this.next < this.pool.capacity && this.used.has(this.next)) {
        this.next += 1
      }
      if (this.next >= this.pool.capacity) {
        // Defensive: used.size < capacity implies a free index exists.
        throw new NetworkCapacityError(
          `subnetPool ${this.pool.cidr} exhausted (${this.pool.capacity} /30 networks)`
        )
      }
      index = this.next
      this.next += 1
    }
    this.used.add(index)
    return index
  }

  /** Register an index that already exists on the host (restart re-adoption). */
  adopt(index: number): void {
    if (!Number.isInteger(index) || index < 0 || index >= this.pool.capacity) {
      throw new Error(`tap index ${index} is outside ${this.pool.cidr}`)
    }
    if (this.used.has(index)) {
      throw new Error(`tap index ${index} is allocated twice`)
    }
    this.used.add(index)
  }

  release(index: number): void {
    if (!this.used.delete(index)) {
      return
    }
    heapPush(this.freed, index)
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
 * Public TCP port allocator. One port per tcp/raw expose entry; lowest free
 * port wins, released ports are reusable immediately.
 */
export class PortAllocator {
  constructor(
    readonly from: number,
    readonly to: number
  ) {
    if (!isValidPort(from) || !isValidPort(to) || from > to) {
      throw new Error(`invalid TCP port range ${from}-${to}`)
    }
  }

  get size(): number {
    return this.to - this.from + 1
  }

  reserve(count: number): number[] {
    if (!Number.isInteger(count) || count < 0) {
      throw new Error(`invalid port reservation count: ${count}`)
    }
    if (count === 0) {
      return []
    }
    const result: number[] = []
    for (
      let port = this.from;
      port <= this.to && result.length < count;
      port++
    ) {
      if (!this.used.has(port)) {
        result.push(port)
      }
    }
    if (result.length !== count) {
      throw new NetworkCapacityError(
        `tcpPortRange ${this.from}-${this.to} exhausted (${this.used.size}/${this.size} in use)`
      )
    }
    for (const port of result) {
      this.used.add(port)
    }
    return result
  }

  private readonly used = new Set<number>()

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
    this.used.add(port)
  }

  release(ports: Iterable<number>): void {
    for (const port of ports) {
      this.used.delete(port)
    }
  }

  get allocated(): number {
    return this.used.size
  }
}
