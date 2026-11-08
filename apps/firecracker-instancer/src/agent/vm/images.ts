import { readdir, stat } from 'node:fs/promises'
import path from 'node:path'
import { IMAGE_NAME_REGEX } from '@rctf/firecracker-protocol'
import type { VmConfig } from './config'
import {
  VmValidationError,
  assertImageName,
  fileExists,
  isPathInside,
  realDirectory,
  realFileInside,
  realpathExisting,
} from './paths'

export interface ResolvedImage {
  name: string
  /** realpath of `<imagesDir>/<name>`; always below realpath(imagesDir). */
  dir: string
  vmlinux: string
  rootfs: string
  rootfsSize: number
  initrd?: string
}

const MIB = 1024 * 1024

const assertNotWorldWritable = (
  config: VmConfig,
  target: string,
  what: string,
  mode: number
): void => {
  if (config.forbidWorldWritableImages && (mode & 0o002) !== 0) {
    throw new VmValidationError(
      `${what} is world-writable, refusing to use it: ${target}`
    )
  }
}

/** realpath of imagesDir, requiring it to be a real directory (not a symlink to a file). */
export const imagesRoot = async (config: VmConfig): Promise<string> =>
  realDirectory(config.imagesDir, 'imagesDir')

/**
 * Resolve and validate one image. The base image is only ever read: every
 * returned path is a realpath below imagesDir, and a symlink escaping that
 * directory (file or directory) is rejected.
 */
export const resolveImage = async (
  config: VmConfig,
  image: string,
  diskMiB: number
): Promise<ResolvedImage> => {
  assertImageName(image)
  const root = await imagesRoot(config)
  const rootStat = await stat(root)
  assertNotWorldWritable(config, root, 'imagesDir', rootStat.mode)

  const dirCandidate = path.join(root, image)
  const dir = await realpathExisting(dirCandidate, `image ${image}`)
  if (!isPathInside(root, dir)) {
    throw new VmValidationError(
      `image ${image} resolves outside imagesDir: ${dirCandidate} -> ${dir}`
    )
  }
  const dirStat = await stat(dir)
  if (!dirStat.isDirectory()) {
    throw new VmValidationError(`image ${image} is not a directory`)
  }
  assertNotWorldWritable(config, dir, `image ${image}`, dirStat.mode)

  const vmlinux = await realFileInside(
    root,
    path.join(dir, 'vmlinux'),
    `image ${image} vmlinux`
  )
  const rootfs = await realFileInside(
    root,
    path.join(dir, 'rootfs.ext4'),
    `image ${image} rootfs.ext4`
  )

  const maxBytes = diskMiB * MIB
  if (rootfs.size > maxBytes) {
    throw new VmValidationError(
      `image ${image} rootfs.ext4 is ${rootfs.size} bytes, larger than the ` +
        `reserved ${diskMiB} MiB (${maxBytes} bytes)`
    )
  }

  const initrdCandidate = path.join(dir, 'initrd')
  const initrd = (await fileExists(initrdCandidate))
    ? (await realFileInside(root, initrdCandidate, `image ${image} initrd`))
        .path
    : undefined

  return {
    name: image,
    dir,
    vmlinux: vmlinux.path,
    rootfs: rootfs.path,
    rootfsSize: rootfs.size,
    ...(initrd === undefined ? {} : { initrd }),
  }
}

/** Names of directories under imagesDir that contain regular vmlinux + rootfs.ext4. */
export const listImageNames = async (config: VmConfig): Promise<string[]> => {
  const root = await imagesRoot(config)
  const entries = await readdir(root, { withFileTypes: true })
  const names: string[] = []
  for (const entry of entries) {
    if (!IMAGE_NAME_REGEX.test(entry.name)) continue
    const dir = path.join(root, entry.name)
    try {
      const dirStat = await stat(dir)
      if (!dirStat.isDirectory()) continue
      const vmlinux = await stat(path.join(dir, 'vmlinux'))
      const rootfs = await stat(path.join(dir, 'rootfs.ext4'))
      if (vmlinux.isFile() && rootfs.isFile()) names.push(entry.name)
    } catch {
      // Missing/unreadable entries are simply not offered.
    }
  }
  return names.sort()
}
