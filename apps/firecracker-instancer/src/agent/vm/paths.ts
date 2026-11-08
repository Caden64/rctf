import { lstat, realpath, rm, stat, unlink } from 'node:fs/promises'
import path from 'node:path'
import { IMAGE_NAME_REGEX, INSTANCE_ID_REGEX } from '@rctf/firecracker-protocol'

/** A caller supplied value (id, image, path) failed validation. Never contains secrets. */
export class VmValidationError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'VmValidationError'
  }
}

export const assertInstanceId = (instanceId: string): void => {
  if (!INSTANCE_ID_REGEX.test(instanceId)) {
    throw new VmValidationError(
      `invalid instance id: ${JSON.stringify(instanceId)}`
    )
  }
}

export const assertImageName = (image: string): void => {
  if (!IMAGE_NAME_REGEX.test(image)) {
    throw new VmValidationError(`invalid image name: ${JSON.stringify(image)}`)
  }
}

/**
 * Lexical containment. Both arguments must already be absolute/resolved. Used
 * for paths we build ourselves (`<runDir>/<validated id>`), where the id
 * cannot contain separators; `removeInstanceTree` never follows a top-level
 * symlink, so lexical containment is sufficient there.
 */
export const isPathInside = (base: string, candidate: string): boolean => {
  const rel = path.relative(base, candidate)
  return rel.length > 0 && !rel.startsWith('..') && !path.isAbsolute(rel)
}

/** `realpath`, translating ENOENT into a validation error with context. */
export const realpathExisting = async (
  target: string,
  what: string
): Promise<string> => {
  try {
    return await realpath(target)
  } catch (err) {
    throw new VmValidationError(
      `${what} does not exist or cannot be resolved: ${target} (${
        err instanceof Error ? err.message : String(err)
      })`
    )
  }
}

/** Resolve a possibly-symlinked path and require it to stay below `baseReal`. */
export const resolveInside = async (
  baseReal: string,
  target: string,
  what: string
): Promise<string> => {
  const resolved = await realpathExisting(target, what)
  if (!isPathInside(baseReal, resolved)) {
    throw new VmValidationError(`${what} escapes its base directory: ${target}`)
  }
  return resolved
}

/** Resolve a real directory; rejects files, symlinks-to-files and missing paths. */
export const realDirectory = async (
  target: string,
  what: string
): Promise<string> => {
  const resolved = await realpathExisting(target, what)
  const st = await stat(resolved)
  if (!st.isDirectory()) {
    throw new VmValidationError(`${what} is not a directory: ${target}`)
  }
  return resolved
}

/** Resolve a real regular file and require it to stay below `baseReal`. */
export const realFileInside = async (
  baseReal: string,
  target: string,
  what: string
): Promise<{ path: string; size: number; mode: number }> => {
  const resolved = await resolveInside(baseReal, target, what)
  const st = await stat(resolved)
  if (!st.isFile()) {
    throw new VmValidationError(`${what} is not a regular file: ${target}`)
  }
  return { path: resolved, size: st.size, mode: st.mode }
}

export const fileExists = async (target: string): Promise<boolean> => {
  try {
    await stat(target)
    return true
  } catch {
    return false
  }
}

/**
 * Remove `<base>/<instanceId>` (or another child we built) without ever
 * following a symlink at the top level. Callers must pass an id validated by
 * `INSTANCE_ID_REGEX`; this function additionally refuses anything that is not
 * lexically inside `base`.
 */
export const removeInstanceTree = async (
  base: string,
  instanceId: string
): Promise<boolean> => {
  assertInstanceId(instanceId)
  const baseAbs = path.resolve(base)
  const target = path.join(baseAbs, instanceId)
  if (!isPathInside(baseAbs, target)) {
    throw new VmValidationError(
      `refusing to remove path outside ${baseAbs}: ${target}`
    )
  }
  let st
  try {
    st = await lstat(target)
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return false
    throw err
  }
  if (st.isSymbolicLink()) {
    // Only the link itself is inside our tree; unlink it, never its target.
    await unlink(target)
    return true
  }
  await rm(target, { recursive: true, force: true })
  return true
}
