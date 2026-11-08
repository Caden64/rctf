import { afterEach, describe, expect, test } from 'bun:test'
import { chmod, mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { createVmDriver } from '../../src/agent/vm'
import { makeDirs, makeImage, makeLogger, makeVmConfig } from './helpers'

const roots: string[] = []

afterEach(async () => {
  for (const root of roots.splice(0)) {
    await rm(root, { recursive: true, force: true })
  }
})

const bin = async (
  root: string,
  name: string,
  mode = 0o755
): Promise<string> => {
  const target = path.join(root, 'bin', name)
  await mkdir(path.dirname(target), { recursive: true, mode: 0o700 })
  await writeFile(target, '#!/bin/sh\nexit 0\n', { mode })
  await chmod(target, mode)
  return target
}

describe('preflight', () => {
  test('reports every check and the usable images', async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), 'rctf-vm-pre-'))
    roots.push(root)
    const dirs = await makeDirs(root)
    const firecrackerBin = await bin(root, 'firecracker')
    const jailerBin = await bin(root, 'jailer')
    const config = await makeVmConfig({
      dirs,
      overrides: { firecrackerBin, jailerBin, mode: 'jailer' },
    })
    await makeImage(config.imagesDir, 'web-demo')
    const driver = createVmDriver(config, { logger: makeLogger().logger })

    const result = await driver.preflight()
    expect(Object.keys(result.checks).sort()).toEqual([
      'apiSocketPath',
      'cgroupRoot',
      'chrootBase',
      'firecrackerBin',
      'imagesDir',
      'imagesTrusted',
      'jailerBin',
      'kvm',
      'reflink',
      'runDir',
    ])
    expect(result.checks.firecrackerBin).toBe(true)
    expect(result.checks.jailerBin).toBe(true)
    expect(result.checks.imagesDir).toBe(true)
    expect(result.checks.imagesTrusted).toBe(true)
    expect(result.checks.runDir).toBe(true)
    expect(result.checks.apiSocketPath).toBe(true)
    // The temp cgroup dir is not a cgroup2 mount.
    expect(result.checks.cgroupRoot).toBe(false)
    expect(typeof result.checks.kvm).toBe('boolean')
    expect(typeof result.checks.reflink).toBe('boolean')
    expect(result.images).toEqual(['web-demo'])
  })

  test('reports missing/non-executable binaries and missing image dirs', async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), 'rctf-vm-pre-'))
    roots.push(root)
    const dirs = await makeDirs(root)
    const notExecutable = await bin(root, 'firecracker', 0o644)
    const config = await makeVmConfig({
      dirs,
      overrides: {
        mode: 'jailer',
        firecrackerBin: notExecutable,
        jailerBin: path.join(root, 'missing-jailer'),
      },
    })
    const driver = createVmDriver(config, { logger: makeLogger().logger })

    const result = await driver.preflight()
    expect(result.checks.firecrackerBin).toBe(false)
    expect(result.checks.jailerBin).toBe(false)
    expect(result.images).toEqual([])

    const missingImages = await makeVmConfig({
      dirs,
      overrides: {
        firecrackerBin: notExecutable,
        imagesDir: path.join(root, 'does-not-exist'),
      },
    })
    const missingDriver = createVmDriver(missingImages, {
      logger: makeLogger().logger,
    })
    expect((await missingDriver.preflight()).checks.imagesDir).toBe(false)
  })

  test('reports untrusted image directories', async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), 'rctf-vm-pre-'))
    roots.push(root)
    const dirs = await makeDirs(root)
    const firecrackerBin = await bin(root, 'firecracker')
    const config = await makeVmConfig({
      dirs,
      overrides: { firecrackerBin },
    })
    await makeImage(config.imagesDir, 'web-demo')
    await chmod(config.imagesDir, 0o770)
    const driver = createVmDriver(config, { logger: makeLogger().logger })
    expect((await driver.preflight()).checks.imagesTrusted).toBe(false)

    await chmod(config.imagesDir, 0o700)
    await chmod(path.join(config.imagesDir, 'web-demo', 'rootfs.ext4'), 0o660)
    expect((await driver.preflight()).checks.imagesTrusted).toBe(false)
  })
})

describe('preflight: cgroup and images accuracy', () => {
  test('direct mode does not require a usable cgroupRoot', async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), 'rctf-vm-pre-'))
    roots.push(root)
    const dirs = await makeDirs(root)
    const firecrackerBin = await bin(root, 'firecracker')
    const config = await makeVmConfig({
      dirs,
      overrides: {
        firecrackerBin,
        mode: 'direct',
        cgroupRoot: path.join(dirs.cgroupRoot, 'does-not-exist'),
      },
    })
    const driver = createVmDriver(config, {
      logger: makeLogger().logger,
      readMounts: async () => [],
    })
    expect((await driver.preflight()).checks.cgroupRoot).toBe(true)
  })

  test('cgroupRoot must exist, sit on cgroup2 and be writable', async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), 'rctf-vm-pre-'))
    roots.push(root)
    const dirs = await makeDirs(root)
    const firecrackerBin = await bin(root, 'firecracker')
    const config = await makeVmConfig({
      dirs,
      overrides: { firecrackerBin, mode: 'jailer' },
    })
    const readMounts = async (): Promise<
      { mountpoint: string; fstype: string }[]
    > => [{ mountpoint: dirs.cgroupRoot, fstype: 'cgroup2' }]
    const driver = createVmDriver(config, {
      logger: makeLogger().logger,
      readMounts,
    })
    // Exists, on a cgroup2 mount, writable.
    expect((await driver.preflight()).checks.cgroupRoot).toBe(true)

    await chmod(dirs.cgroupRoot, 0o500)
    expect((await driver.preflight()).checks.cgroupRoot).toBe(false)
    await chmod(dirs.cgroupRoot, 0o700)

    // A nonexistent descendant of a cgroup2 mount is not usable either.
    const missing = await makeVmConfig({
      dirs,
      overrides: {
        firecrackerBin,
        mode: 'jailer',
        cgroupRoot: path.join(dirs.cgroupRoot, 'does-not-exist'),
      },
    })
    const missingDriver = createVmDriver(missing, {
      logger: makeLogger().logger,
      readMounts,
    })
    expect((await missingDriver.preflight()).checks.cgroupRoot).toBe(false)
  })

  test('a nonexistent descendant of the real cgroup2 mount is rejected', async () => {
    const { readFile } = await import('node:fs/promises')
    let mounts = ''
    try {
      mounts = await readFile('/proc/mounts', 'utf8')
    } catch {
      return
    }
    const mount = mounts
      .split('\n')
      .map(line => line.trim().split(/\s+/))
      .find(fields => fields[2] === 'cgroup2')?.[1]
    if (mount === undefined) return
    const root = await mkdtemp(path.join(os.tmpdir(), 'rctf-vm-pre-'))
    roots.push(root)
    const dirs = await makeDirs(root)
    const firecrackerBin = await bin(root, 'firecracker')
    const config = await makeVmConfig({
      dirs,
      overrides: {
        firecrackerBin,
        mode: 'jailer',
        cgroupRoot: path.join(
          mount.replaceAll('\\040', ' '),
          `rctf-missing-${process.pid}`
        ),
      },
    })
    const driver = createVmDriver(config, { logger: makeLogger().logger })
    expect((await driver.preflight()).checks.cgroupRoot).toBe(false)
  })

  test('imagesDir only needs read access (jailer drops to a non-root uid)', async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), 'rctf-vm-pre-'))
    roots.push(root)
    const dirs = await makeDirs(root)
    const firecrackerBin = await bin(root, 'firecracker')
    const jailerBin = await bin(root, 'jailer')
    const config = await makeVmConfig({
      dirs,
      overrides: { mode: 'jailer', firecrackerBin, jailerBin },
    })
    await makeImage(config.imagesDir, 'web-demo')
    await chmod(config.imagesDir, 0o500)
    try {
      const driver = createVmDriver(config, { logger: makeLogger().logger })
      const result = await driver.preflight()
      expect(result.checks.imagesDir).toBe(true)
      expect(result.checks.runDir).toBe(true)
      expect(result.images).toEqual(['web-demo'])
    } finally {
      await chmod(config.imagesDir, 0o700)
    }
  })
})

describe('preflight: API socket path length', () => {
  test('flags a runDir so deep that <runDir>/<id>/api.sock exceeds SUN_LEN', async () => {
    // Found by a real run: Firecracker exits with "path must be shorter than
    // SUN_LEN" and the only symptom was a cryptic launch failure.
    const root = await mkdtemp(path.join(os.tmpdir(), 'rctf-vm-sun-'))
    roots.push(root)
    const dirs = await makeDirs(root)
    const deep = path.join(dirs.runDir, 'd'.repeat(90))
    await mkdir(deep, { recursive: true, mode: 0o700 })
    const firecrackerBin = await bin(root, 'firecracker')
    const jailerBin = await bin(root, 'jailer')
    const config = await makeVmConfig({
      dirs: { ...dirs, runDir: deep },
      overrides: { firecrackerBin, jailerBin, mode: 'direct' },
    })
    const driver = createVmDriver(config, { logger: makeLogger().logger })
    expect((await driver.preflight()).checks.apiSocketPath).toBe(false)
  })
})
