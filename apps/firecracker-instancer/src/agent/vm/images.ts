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

interface StatLike {
  uid: number
  mode: number
}

const MIB = 1024 * 1024

const currentUid = (): number =>
  typeof process.getuid === 'function' ? process.getuid() : 0

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
 * Root-trusted ownership plus no group/other write. A sticky world-writable
 * ancestor (e.g. `/tmp`) cannot be used to replace a child owned by someone
 * else, so it is acceptable *above* imagesDir. imagesDir and the image dir
 * itself must not be writable by group/other at all.
 */
const trustDir = (
  target: string,
  what: string,
  allowSticky: boolean,
  st: StatLike
): string | undefined => {
  const uid = currentUid()
  if (st.uid !== 0 && st.uid !== uid) {
    return `${what} is owned by uid ${st.uid}, expected root or ${uid}: ${target}`
  }
  if ((st.mode & 0o022) !== 0) {
    if (!(allowSticky && (st.mode & 0o1000) !== 0)) {
      return `${what} is group/world-writable: ${target}`
    }
  }
  return undefined
}

/**
 * An image file (kernel/rootfs/initrd) must be owned by root or the agent uid
 * and must not be writable by group/other. Mode alone is not enough: a file
 * owned by another local user could be replaced between validation and use.
 */
const trustFile = (
  target: string,
  what: string,
  st: StatLike
): string | undefined => {
  const uid = currentUid()
  if (st.uid !== 0 && st.uid !== uid) {
    return `${what} is owned by uid ${st.uid}, expected root or ${uid}: ${target}`
  }
  return (st.mode & 0o022) !== 0
    ? `${what} is group/other-writable: ${target}`
    : undefined
}

/**
 * Containment (`realpath` below imagesDir) is not enough: a symlink may point
 * at a file whose resolved intermediate directories are writable by another
 * user. Check every ancestor of the RESOLVED target from imagesDir down
 * (imagesDir itself is covered by `checkRootTrust`); no sticky allowance here.
 */
const checkResolvedAncestors = async (
  root: string,
  target: string
): Promise<string | undefined> => {
  const chain: string[] = []
  let current = path.dirname(target)
  for (;;) {
    if (current === root) break
    if (!isPathInside(root, current)) {
      return `resolved path escapes imagesDir: ${target}`
    }
    chain.unshift(current)
    const parent = path.dirname(current)
    if (parent === current) return `resolved path escapes imagesDir: ${target}`
    current = parent
  }
  for (const dir of chain) {
    let st
    try {
      st = await stat(dir)
    } catch (err) {
      return `cannot stat ${dir}: ${
        err instanceof Error ? err.message : String(err)
      }`
    }
    if (!st.isDirectory()) return `not a directory: ${dir}`
    const failure = trustDir(dir, 'image path directory', false, st)
    if (failure !== undefined) return failure
  }
  return undefined
}

/** Every path component from `/` down to `target`, in order. */
const parentChain = (target: string): string[] => {
  const chain: string[] = []
  let current = target
  for (;;) {
    chain.unshift(current)
    const parent = path.dirname(current)
    if (parent === current) break
    current = parent
  }
  return chain
}

const checkRootTrust = async (
  config: VmConfig,
  root: string
): Promise<string | undefined> => {
  if (config.allowUntrustedImages) return undefined
  for (const dir of parentChain(root)) {
    let st
    try {
      st = await stat(dir)
    } catch (err) {
      return `cannot stat ${dir}: ${
        err instanceof Error ? err.message : String(err)
      }`
    }
    if (!st.isDirectory()) return `not a directory: ${dir}`
    const failure = trustDir(
      dir,
      dir === root ? 'imagesDir' : 'imagesDir parent',
      dir !== root,
      st
    )
    if (failure !== undefined) return failure
  }
  return undefined
}

/** Preflight check: imagesDir ancestry and every offered image is trusted. */
export const checkImagesTrusted = async (
  config: VmConfig
): Promise<boolean> => {
  try {
    const root = await imagesRoot(config)
    if ((await checkRootTrust(config, root)) !== undefined) return false
    if (config.allowUntrustedImages) return true
    let names: string[]
    try {
      names = await listImageNames(config)
    } catch {
      return false
    }
    for (const name of names) {
      const dir = await realpathExisting(path.join(root, name), `image ${name}`)
      if (!isPathInside(root, dir)) return false
      const dirStat = await stat(dir)
      if (!dirStat.isDirectory()) return false
      if (trustDir(dir, `image ${name}`, false, dirStat) !== undefined) {
        return false
      }
      for (const file of ['vmlinux', 'rootfs.ext4', 'initrd']) {
        const candidate = path.join(dir, file)
        if (file === 'initrd' && !(await fileExists(candidate))) continue
        try {
          const resolved = await realFileInside(
            root,
            candidate,
            `image ${name} ${file}`
          )
          const st = await stat(resolved.path)
          if (!st.isFile()) return false
          if (
            trustFile(resolved.path, `image ${name} ${file}`, st) !== undefined
          ) {
            return false
          }
          if (
            (await checkResolvedAncestors(root, resolved.path)) !== undefined
          ) {
            return false
          }
        } catch {
          return false
        }
      }
    }
    return true
  } catch {
    return false
  }
}

const assertImageTrusted = async (
  config: VmConfig,
  root: string,
  dir: string,
  vmlinux: string,
  rootfs: string,
  initrd?: string
): Promise<void> => {
  if (config.allowUntrustedImages) return
  const rootFailure = await checkRootTrust(config, root)
  if (rootFailure !== undefined) {
    throw new VmValidationError(
      `imagesDir is not trusted, refusing to launch: ${rootFailure}`
    )
  }
  const dirStat = await stat(dir)
  const dirFailure = trustDir(dir, 'image directory', false, dirStat)
  if (dirFailure !== undefined) {
    throw new VmValidationError(
      `image is not trusted, refusing to launch: ${dirFailure}`
    )
  }
  const files: [string, string][] = [
    [vmlinux, 'vmlinux'],
    [rootfs, 'rootfs.ext4'],
  ]
  if (initrd !== undefined) files.push([initrd, 'initrd'])
  for (const [target, what] of files) {
    const st = await stat(target)
    if (!st.isFile()) {
      throw new VmValidationError(
        `image ${what} is not a regular file: ${target}`
      )
    }
    const failure = trustFile(target, `image ${what}`, st)
    if (failure !== undefined) {
      throw new VmValidationError(
        `image is not trusted, refusing to launch: ${failure}`
      )
    }
    const ancestorFailure = await checkResolvedAncestors(root, target)
    if (ancestorFailure !== undefined) {
      throw new VmValidationError(
        `image is not trusted, refusing to launch: ${ancestorFailure}`
      )
    }
  }
}

/**
 * Resolve and validate one image. The base image is only ever read: every
 * returned path is a realpath below imagesDir, and a symlink escaping that
 * directory (file or directory) is rejected. Unless `allowUntrustedImages` is
 * set, the directory ancestry and files must pass the trust checks.
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

  const initrdCandidate = path.join(dir, 'initrd')
  const initrd = (await fileExists(initrdCandidate))
    ? (await realFileInside(root, initrdCandidate, `image ${image} initrd`))
        .path
    : undefined

  await assertImageTrusted(config, root, dir, vmlinux.path, rootfs.path, initrd)

  const maxBytes = diskMiB * MIB
  if (rootfs.size > maxBytes) {
    throw new VmValidationError(
      `image ${image} rootfs.ext4 is ${rootfs.size} bytes, larger than the ` +
        `reserved ${diskMiB} MiB (${maxBytes} bytes)`
    )
  }

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
