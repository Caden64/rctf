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
      overrides: { firecrackerBin, jailerBin },
    })
    await makeImage(config.imagesDir, 'web-demo')
    const driver = createVmDriver(config, { logger: makeLogger().logger })

    const result = await driver.preflight()
    expect(Object.keys(result.checks).sort()).toEqual([
      'chrootBase',
      'firecrackerBin',
      'imagesDir',
      'jailerBin',
      'kvm',
      'reflink',
      'runDir',
    ])
    expect(result.checks.firecrackerBin).toBe(true)
    expect(result.checks.jailerBin).toBe(true)
    expect(result.checks.imagesDir).toBe(true)
    expect(result.checks.runDir).toBe(true)
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
})
