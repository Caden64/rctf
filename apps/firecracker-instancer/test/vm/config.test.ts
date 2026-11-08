import { describe, expect, test } from 'bun:test'
import { vmConfigSchema } from '../../src/agent/vm/config'
import { buildBootArgs } from '../../src/agent/vm'
import { makeLease } from './helpers'

const parse = (input: Record<string, unknown> = {}) =>
  vmConfigSchema.parse(input)

describe('vm config', () => {
  test('defaults the guest init and the strict image trust check', () => {
    const config = parse()
    expect(config.defaultInit).toBe('/rctf/init')
    expect(config.allowUntrustedImages).toBe(false)
    for (const bad of ['/rctf init', 'relative/init', '/rctf/../init']) {
      expect(() => parse({ defaultInit: bad })).toThrow()
    }
  })

  test('accepts nested relative parent cgroups and rejects escapes', () => {
    expect(parse({ parentCgroup: 'all_uvms/external_uvms' }).parentCgroup).toBe(
      'all_uvms/external_uvms'
    )
    expect(parse({ parentCgroup: 'rctf' }).parentCgroup).toBe('rctf')
    for (const bad of [
      '/absolute',
      '..',
      '../escape',
      'a/../b',
      'a//b',
      'a/',
      '',
      'a b',
    ]) {
      expect(() => parse({ parentCgroup: bad })).toThrow()
    }
  })

  test('accepts comma-separated cgroup values but rejects whitespace/shell metacharacters', () => {
    expect(
      parse({ cgroupLimits: ['cpuset.cpus=0,1,2', 'pids.max=512'] })
        .cgroupLimits
    ).toEqual(['cpuset.cpus=0,1,2', 'pids.max=512'])
    for (const bad of [
      'pids.max=1 2',
      'pids.max=512;rm -rf /',
      'memory.max=$(id)',
      'x=y`id`',
      'x=y|z',
      'x=y&z',
      'x=y/z',
      'missingvalue',
    ]) {
      expect(() => parse({ cgroupLimits: [bad] })).toThrow()
    }
  })

  test('boot args put init= before the user kernelArgs (last init wins)', () => {
    const lease = makeLease('vm0123456789abcdef')
    expect(buildBootArgs(lease, 'console=ttyS1')).toContain(
      'init=/rctf/init console=ttyS1'
    )
    expect(buildBootArgs(lease, 'init=/custom', '/other/init')).toBe(
      'console=ttyS0 reboot=k panic=1 pci=off ' +
        'ip=10.200.0.2::10.200.0.1:255.255.255.252::eth0:off ' +
        'init=/other/init init=/custom'
    )
  })
})
