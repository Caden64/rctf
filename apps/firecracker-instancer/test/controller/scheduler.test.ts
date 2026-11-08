import { describe, expect, test } from 'bun:test'
import type { HostConfig } from '../../src/controller/config'
import {
  checkFit,
  describeNoCapacity,
  effectiveCapacity,
  selectHost,
  type PlacementCandidate,
} from '../../src/controller/scheduler'
import type { HostRecord, Reserved } from '../../src/controller/store'

const host = (id: string, overrides: Partial<HostRecord> = {}): HostRecord => ({
  id,
  url: `http://${id}`,
  draining: false,
  health: 'healthy',
  accepting: true,
  lastSeenMs: 1000,
  createdAtMs: 0,
  reportedCapacity: null,
  ...overrides,
})

const config = (
  id: string,
  capacity = { vcpus: 8, memMiB: 4096, diskMiB: 4096, maxInstances: 10 }
): HostConfig => ({
  id,
  url: `http://${id}`,
  capacity,
})

const candidate = (
  id: string,
  reserved: Partial<Reserved> = {},
  overrides: {
    record?: Partial<HostRecord>
    capacity?: Partial<HostConfig['capacity']>
  } = {}
): PlacementCandidate => ({
  config: config(id, {
    vcpus: 8,
    memMiB: 4096,
    diskMiB: 4096,
    maxInstances: 10,
    ...overrides.capacity,
  }),
  host: host(id, overrides.record),
  reserved: {
    vcpus: 0,
    memMiB: 0,
    diskMiB: 0,
    instances: 0,
    ...reserved,
  },
})

const request = { vcpus: 1, memMiB: 256, diskMiB: 128 }
const overcommit = { vcpu: 1, mem: 1 }

describe('scheduler', () => {
  test('picks the healthy non-draining host with the most free memory', () => {
    const candidates = [
      candidate('a', { memMiB: 3072 }),
      candidate('b', { memMiB: 1024 }),
      candidate('c', { memMiB: 0 }),
    ]
    expect(selectHost(candidates, request, overcommit)?.host.id).toBe('c')
  })

  test('skips unhealthy, draining and non-accepting hosts', () => {
    const candidates = [
      candidate('a', {}, { record: { health: 'unhealthy' } }),
      candidate('b', {}, { record: { draining: true } }),
      candidate('c', {}, { record: { accepting: false } }),
      candidate('d', { memMiB: 3500 }),
    ]
    expect(selectHost(candidates, request, overcommit)?.host.id).toBe('d')
  })

  test('uses min(configured, agent-reported) capacity', () => {
    const effective = effectiveCapacity(
      { vcpus: 8, memMiB: 4096, diskMiB: 100, maxInstances: 10 },
      { vcpus: 4, memMiB: 8192, diskMiB: 50, maxInstances: 3 }
    )
    expect(effective).toEqual({
      vcpus: 4,
      memMiB: 4096,
      diskMiB: 50,
      maxInstances: 3,
    })
  })

  test('applies memory overcommit to fitting', () => {
    const tight = candidate(
      'a',
      { memMiB: 4000 },
      {
        capacity: { memMiB: 4096 },
      }
    )
    expect(checkFit(tight, request, overcommit).fits).toBe(false)
    expect(checkFit(tight, request, { vcpu: 1, mem: 2 }).fits).toBe(true)
  })

  test('explains the short resource without leaking host internals', () => {
    const candidates = [
      candidate('a', { instances: 10 }),
      candidate('b', { instances: 10 }),
    ]
    const message = describeNoCapacity(candidates, request, overcommit)
    expect(message).toContain('no capacity')
    expect(message).toContain('instance slots')
    expect(message).not.toContain('http://')
  })

  test('explains draining and unhealthy hosts', () => {
    expect(
      describeNoCapacity(
        [candidate('a', {}, { record: { draining: true } })],
        request,
        overcommit
      )
    ).toContain('draining')
    expect(
      describeNoCapacity(
        [candidate('a', {}, { record: { health: 'unhealthy' } })],
        request,
        overcommit
      )
    ).toContain('unhealthy')
  })
})
