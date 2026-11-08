import { afterAll, beforeAll, describe, expect, test } from 'bun:test'
import { mkdtemp, rm } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { FirecrackerApi } from '../../src/agent/vm/api'
import {
  compiledFakeFirecracker,
  newInstanceId,
  startLiveFake,
  type LiveFake,
} from './helpers'

let root: string
let live: LiveFake

beforeAll(async () => {
  root = await mkdtemp(path.join(os.tmpdir(), 'rctf-fake-contract-'))
  live = await startLiveFake(root, newInstanceId())
  // startLiveFake returns as soon as the process exists; wait for the fake to
  // bind its unix socket before the first API call.
  await Bun.sleep(150)
})

afterAll(async () => {
  live.kill()
  await rm(root, { recursive: true, force: true })
})

const put = async (apiPath: string, body: unknown): Promise<string> => {
  const api = new FirecrackerApi(live.handle.apiSocket, { timeoutMs: 2000 })
  try {
    await api.put(apiPath, body)
    return 'accepted'
  } catch (err) {
    return err instanceof Error ? err.message : String(err)
  }
}

describe('fake Firecracker argument parser', () => {
  test('rejects a duplicate option like the real binary', async () => {
    const binary = await compiledFakeFirecracker()
    const proc = Bun.spawn(
      [
        binary,
        '--id',
        'vm0123456789abcdef',
        '--id',
        'vm0123456789abcdef',
        '--api-sock',
        path.join(root, 'dup.sock'),
      ],
      { stdin: 'ignore', stdout: 'pipe', stderr: 'pipe' }
    )
    const [stderr, code] = await Promise.all([
      new Response(proc.stderr).text(),
      proc.exited,
    ])
    expect(code).not.toBe(0)
    expect(stderr).toContain('duplicate option --id')
  })
})

describe('fake Firecracker API validation', () => {
  test('rejects a boot source without kernel_image_path', async () => {
    expect(await put('/boot-source', { boot_args: 'console=ttyS0' })).toMatch(
      /HTTP 400.*kernel_image_path/
    )
  })

  test('rejects a drive without path_on_host/is_root_device/is_read_only', async () => {
    expect(await put('/drives/rootfs', { drive_id: 'rootfs' })).toMatch(
      /HTTP 400.*path_on_host/
    )
  })

  test('rejects a network interface without host_dev_name', async () => {
    expect(await put('/network-interfaces/eth0', { iface_id: 'eth0' })).toMatch(
      /HTTP 400.*host_dev_name/
    )
  })

  test('rejects machine config without vcpu_count or mem_size_mib', async () => {
    expect(await put('/machine-config', { vcpu_count: 2 })).toMatch(
      /HTTP 400.*mem_size_mib/
    )
  })

  test('rejects mmds config without network_interfaces', async () => {
    expect(await put('/mmds/config', { version: 'V2' })).toMatch(
      /HTTP 400.*network_interfaces/
    )
  })

  test('accepts the complete payloads the driver sends', async () => {
    expect(
      await put('/boot-source', {
        kernel_image_path: '/vmlinux',
        boot_args: 'console=ttyS0',
      })
    ).toBe('accepted')
    expect(
      await put('/drives/rootfs', {
        drive_id: 'rootfs',
        path_on_host: '/rootfs.ext4',
        is_root_device: true,
        is_read_only: false,
      })
    ).toBe('accepted')
    expect(
      await put('/network-interfaces/eth0', {
        iface_id: 'eth0',
        host_dev_name: 'fctap0',
        guest_mac: '02:00:00:00:00:01',
      })
    ).toBe('accepted')
    expect(
      await put('/machine-config', {
        vcpu_count: 2,
        mem_size_mib: 256,
        smt: false,
      })
    ).toBe('accepted')
    expect(
      await put('/mmds/config', {
        version: 'V2',
        network_interfaces: ['eth0'],
      })
    ).toBe('accepted')
  })
})
