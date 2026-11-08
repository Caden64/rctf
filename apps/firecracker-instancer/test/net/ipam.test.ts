import { describe, expect, test } from 'bun:test'
import { NetworkCapacityError } from '../../src/interfaces'
import {
  Ipv4Pool,
  PortAllocator,
  parseSubnetPool,
  tapNameForIndex,
} from '../../src/agent/net/ipam'

describe('subnet pool', () => {
  test('parses and rejects invalid pools', () => {
    const pool = parseSubnetPool('10.200.0.0/16')
    expect(pool.base).toBe(0x0ac80000)
    expect(pool.capacity).toBe(16384)

    expect(() => parseSubnetPool('10.200.0.5/16')).toThrow('aligned')
    expect(() => parseSubnetPool('10.200.0.0/31')).toThrow('/8 and /30')
    expect(() => parseSubnetPool('not-a-cidr')).toThrow()
    expect(() => parseSubnetPool('10.200.0.0/7')).toThrow('/8 and /30')
  })

  test('index -> /30 mapping is deterministic (host .1, guest .2)', () => {
    const pool = new Ipv4Pool(parseSubnetPool('10.200.0.0/16'))
    expect(pool.addresses(0)).toEqual({
      hostIp: '10.200.0.1',
      guestIp: '10.200.0.2',
    })
    expect(pool.addresses(1)).toEqual({
      hostIp: '10.200.0.5',
      guestIp: '10.200.0.6',
    })
    expect(pool.addresses(16383)).toEqual({
      hostIp: '10.200.255.253',
      guestIp: '10.200.255.254',
    })
    expect(tapNameForIndex(0)).toBe('fctap0')
    expect(tapNameForIndex(16383)).toBe('fctap16383')
    expect(tapNameForIndex(9999999999).length).toBeLessThanOrEqual(15)
    expect(() => tapNameForIndex(10_000_000_000)).toThrow()
  })

  test('indexOf inverts addresses and rejects mismatches', () => {
    const pool = new Ipv4Pool(parseSubnetPool('10.200.0.0/16'))
    expect(pool.indexOf('10.200.0.5', '10.200.0.6')).toBe(1)
    expect(() => pool.indexOf('10.200.0.1', '10.200.0.6')).toThrow('.1/.2')
    expect(() => pool.indexOf('10.201.0.1', '10.201.0.2')).toThrow('outside')
  })

  test('release reuses the lowest freed index', () => {
    const pool = new Ipv4Pool(parseSubnetPool('10.200.0.0/16'))
    const first = pool.reserve()
    const second = pool.reserve()
    const third = pool.reserve()
    expect([first, second, third]).toEqual([0, 1, 2])
    pool.release(0)
    expect(pool.reserve()).toBe(0)
    pool.release(2)
    expect(pool.reserve()).toBe(2)
    pool.release(1)
    expect(pool.reserve()).toBe(1)
  })

  test('adopt regenerates the allocator from existing leases', () => {
    const pool = new Ipv4Pool(parseSubnetPool('10.200.0.0/16'))
    pool.adopt(3)
    expect(() => pool.adopt(3)).toThrow('twice')
    expect(pool.reserve()).toBe(0)
    expect(pool.allocated).toBe(2)
  })

  test('exhaustion throws NetworkCapacityError and leaks nothing', () => {
    const pool = new Ipv4Pool(parseSubnetPool('10.9.0.0/30'))
    expect(pool.reserve()).toBe(0)
    let caught: unknown
    try {
      pool.reserve()
    } catch (error) {
      caught = error
    }
    expect(caught).toBeInstanceOf(NetworkCapacityError)
    expect(pool.allocated).toBe(1)
    pool.release(0)
    expect(pool.reserve()).toBe(0)
  })
})

describe('reuse quarantine', () => {
  const clock = (start = 1_000_000) => {
    let now = start
    return {
      now: () => now,
      advance: (ms: number) => {
        now += ms
      },
    }
  }

  test('/30 indexes stay out of circulation until the quarantine elapses', () => {
    const time = clock()
    const pool = new Ipv4Pool(parseSubnetPool('10.200.0.0/16'), {
      quarantineMs: 120_000,
      now: time.now,
    })
    expect(pool.reserve()).toBe(0)
    expect(pool.reserve()).toBe(1)
    pool.release(0)
    // never-used index preferred while the release is quarantined
    expect(pool.reserve()).toBe(2)
    time.advance(119_000)
    // a never-used index still wins over a still-quarantined release
    expect(pool.reserve()).toBe(3)
    time.advance(2_000)
    // the oldest release is reused once the quarantine elapsed
    expect(pool.reserve()).toBe(0)
  })

  test('blocked indexes are skipped and never handed out', () => {
    const pool = new Ipv4Pool(parseSubnetPool('10.200.0.0/16'))
    pool.block(0)
    expect(pool.reserve()).toBe(1)
    pool.block(2)
    expect(pool.reserve()).toBe(3)
  })

  test('quarantine() starts the clock for a stray restore-time resource', () => {
    const time = clock()
    const pool = new Ipv4Pool(parseSubnetPool('10.200.0.0/16'), {
      quarantineMs: 120_000,
      now: time.now,
    })
    pool.quarantine(0)
    expect(pool.reserve()).toBe(1)
    time.advance(121_000)
    expect(pool.reserve()).toBe(0)
  })

  test('public ports stay out of circulation until the quarantine elapses', () => {
    const time = clock()
    const ports = new PortAllocator(20000, 20002, {
      quarantineMs: 120_000,
      now: time.now,
    })
    expect(ports.reserve(1)).toEqual([20000])
    ports.release([20000])
    expect(ports.reserve(1)).toEqual([20001])
    time.advance(121_000)
    expect(ports.reserve(1)).toEqual([20000])
  })
})

describe('port allocator', () => {
  test('reserves lowest free ports and reuses released ones', () => {
    const ports = new PortAllocator(20000, 20002)
    expect(ports.reserve(2)).toEqual([20000, 20001])
    ports.release([20000])
    expect(ports.reserve(1)).toEqual([20000])
    expect(ports.reserve(1)).toEqual([20002])
  })

  test('a failed multi-port reservation is atomic', () => {
    const ports = new PortAllocator(20000, 20001)
    expect(() => ports.reserve(3)).toThrow(NetworkCapacityError)
    expect(ports.allocated).toBe(0)
    expect(ports.reserve(2)).toEqual([20000, 20001])
  })

  test('rejects invalid ranges and outside-of-range adoption', () => {
    expect(() => new PortAllocator(0, 10)).toThrow()
    expect(() => new PortAllocator(20, 10)).toThrow()
    const ports = new PortAllocator(20000, 20010)
    expect(() => ports.adopt(19999)).toThrow('outside')
    ports.adopt(20000)
    expect(() => ports.adopt(20000)).toThrow('twice')
  })
})
