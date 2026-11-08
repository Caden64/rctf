import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import {
  chmod,
  mkdir,
  mkdtemp,
  realpath,
  rm,
  symlink,
  writeFile,
} from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { listImageNames, resolveImage } from '../../src/agent/vm/images'
import type { VmConfig } from '../../src/agent/vm/config'
import { makeDirs, makeImage, makeVmConfig } from './helpers'

describe('image resolution', () => {
  let root: string
  let config: VmConfig

  beforeEach(async () => {
    root = await mkdtemp(path.join(os.tmpdir(), 'rctf-vm-img-'))
    const dirs = await makeDirs(root)
    config = await makeVmConfig({ dirs })
  })

  afterEach(async () => {
    await rm(root, { recursive: true, force: true })
  })

  test('resolves the kernel, rootfs and optional initrd inside imagesDir', async () => {
    const imageDir = await makeImage(config.imagesDir, 'web-demo', {
      initrd: true,
    })
    const image = await resolveImage(config, 'web-demo', 64)
    expect(image.dir.startsWith(await realpath(config.imagesDir))).toBe(true)
    expect(image.vmlinux).toBe(path.join(imageDir, 'vmlinux'))
    expect(image.rootfs).toBe(path.join(imageDir, 'rootfs.ext4'))
    expect(image.initrd).toBe(path.join(imageDir, 'initrd'))
    expect(image.rootfsSize).toBe(8192)
  })

  test('rejects names that are not IMAGE_NAME_REGEX', async () => {
    for (const name of ['../escape', 'a/b', '.hidden', 'UPPER', '', 'a b']) {
      await expect(resolveImage(config, name, 64)).rejects.toThrow()
    }
  })

  test('rejects an image directory that is a symlink escaping imagesDir', async () => {
    const outside = path.join(root, 'outside-image')
    await mkdir(outside, { recursive: true })
    await writeFile(path.join(outside, 'vmlinux'), 'kernel')
    await writeFile(path.join(outside, 'rootfs.ext4'), 'rootfs')
    await symlink(outside, path.join(config.imagesDir, 'sneaky'))
    await expect(resolveImage(config, 'sneaky', 64)).rejects.toThrow(
      /outside imagesDir/
    )
  })

  test('rejects a kernel file that is a symlink escaping imagesDir', async () => {
    await makeImage(config.imagesDir, 'web-demo')
    const outsideFile = path.join(root, 'outside-vmlinux')
    await writeFile(outsideFile, 'kernel')
    await rm(path.join(config.imagesDir, 'web-demo', 'vmlinux'))
    await symlink(
      outsideFile,
      path.join(config.imagesDir, 'web-demo', 'vmlinux')
    )
    await expect(resolveImage(config, 'web-demo', 64)).rejects.toThrow(
      /escapes its base directory/
    )
  })

  test('rejects non-regular files', async () => {
    const dir = path.join(config.imagesDir, 'web-demo')
    await mkdir(dir, { recursive: true })
    await mkdir(path.join(dir, 'vmlinux'))
    await writeFile(path.join(dir, 'rootfs.ext4'), 'rootfs')
    await expect(resolveImage(config, 'web-demo', 64)).rejects.toThrow(
      /not a regular file/
    )
  })

  test('rejects a rootfs larger than the reserved disk', async () => {
    await makeImage(config.imagesDir, 'big', { rootfsBytes: 2 * 1024 * 1024 })
    await expect(resolveImage(config, 'big', 1)).rejects.toThrow(/larger than/)
  })

  test('rejects world-writable image directories unless explicitly allowed', async () => {
    await makeImage(config.imagesDir, 'web-demo')
    await chmod(path.join(config.imagesDir, 'web-demo'), 0o777)
    await expect(resolveImage(config, 'web-demo', 64)).rejects.toThrow(
      /world-writable/
    )
    const relaxed = await makeVmConfig({
      dirs: {
        root,
        imagesDir: config.imagesDir,
        runDir: config.runDir,
        chrootBase: config.chrootBase,
        cgroupRoot: config.cgroupRoot,
        logsDir: path.join(root, 'logs'),
      },
      overrides: { forbidWorldWritableImages: false },
    })
    await expect(resolveImage(relaxed, 'web-demo', 64)).resolves.toBeDefined()
  })

  test('lists only well-formed images with both files', async () => {
    await makeImage(config.imagesDir, 'good')
    // Missing rootfs.
    await mkdir(path.join(config.imagesDir, 'no-rootfs'))
    await writeFile(path.join(config.imagesDir, 'no-rootfs', 'vmlinux'), 'k')
    // Invalid directory name.
    await makeImage(config.imagesDir, 'Not_Valid')
    expect(await listImageNames(config)).toEqual(['good'])
  })
})
