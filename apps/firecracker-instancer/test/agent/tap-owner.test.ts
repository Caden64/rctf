import { describe, expect, it } from 'bun:test'
import { agentConfigSchema, alignTapOwner } from '../../src/agent/config'

const base = (overrides: Record<string, unknown> = {}) =>
  agentConfigSchema.parse({
    hostId: 'fc1',
    capacity: { vcpus: 4, memMiB: 4096, diskMiB: 4096, maxInstances: 4 },
    network: {
      publicHost: 'fc1.example.com',
      httpDomain: 'fc1.example.com',
      ...((overrides.network as object | undefined) ?? {}),
    },
    vm: { mode: 'jailer', ...((overrides.vm as object | undefined) ?? {}) },
  })

describe('tap owner vs jailer identity', () => {
  it('defaults an unset tap owner to the jailer uid/gid', () => {
    // An unset owner leaves a root-owned tap the dropped uid cannot open.
    const aligned = alignTapOwner(
      base({ vm: { jailUid: 12345, jailGid: 23456 } })
    )
    expect(aligned.network.tapUser).toBe('12345')
    expect(aligned.network.tapGroup).toBe('23456')
  })

  it('rejects an explicit numeric owner that differs from the jailer identity', () => {
    expect(() =>
      alignTapOwner(base({ network: { tapUser: '1000', tapGroup: '10000' } }))
    ).toThrow(/does not match the jailer identity/)
  })

  it('accepts matching owners and leaves direct mode untouched', () => {
    const ok = alignTapOwner(
      base({ network: { tapUser: '10000', tapGroup: '10000' } })
    )
    expect(ok.network.tapUser).toBe('10000')
    const direct = alignTapOwner(base({ vm: { mode: 'direct' } }))
    expect(direct.network.tapUser).toBeUndefined()
  })
})
