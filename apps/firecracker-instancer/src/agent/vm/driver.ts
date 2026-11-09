import { randomUUID } from 'node:crypto'
import { realpathSync } from 'node:fs'
import {
  access,
  chmod,
  chown,
  constants as fsConstants,
  copyFile,
  link,
  lstat,
  mkdir,
  open,
  readdir,
  readFile,
  rename,
  rm,
  rmdir,
  stat,
  type FileHandle,
  writeFile,
} from 'node:fs/promises'
import { isIPv4, createConnection } from 'node:net'
import path from 'node:path'
import {
  INSTANCE_ID_REGEX,
  KERNEL_ARGS_REGEX,
} from '@rctf/firecracker-protocol'
import type {
  Clock,
  CommandRunner,
  PreflightResult,
  VmDriver,
  VmHandle,
  VmLaunchRequest,
} from '../../interfaces'
import type { Logger } from '../../log'
import { createLogger } from '../../log'
import { bunCommandRunner } from '../../util/exec'
import { FirecrackerApi } from './api'
import type { VmConfig } from './config'
import type { ResolvedImage } from './images'
import { checkImagesTrusted, listImageNames, resolveImage } from './images'
import {
  VmValidationError,
  assertInstanceId,
  isPathInside,
  removeInstanceTree,
} from './paths'
import {
  type ExeIdentity,
  type ProcessExpectation,
  findInstanceProcesses,
  hasInstanceIdArg,
  inspectProcess,
  inspectProcessLegacy,
  instanceIdFromArgv,
  listPids,
  processMatchesIdentity,
  readProcSnapshot,
  readStartTicks,
  statExeIdentity,
} from './proc'

const MIB = 1024 * 1024
const MAC_REGEX = /^[0-9a-f]{2}(:[0-9a-f]{2}){5}$/i
const TAP_NAME_REGEX = /^[A-Za-z0-9_.-]{1,15}$/

/** Identity fields persisted in VmHandle (opaque JSON owned by the manager). */
export interface VmHandleIdentity {
  /** Device of the authenticated executable (`stat('/proc/<pid>/exe')`). */
  exeDev?: number
  /** Inode of the authenticated executable. */
  exeIno?: number
  /** Diagnostic path of the trusted executable in the launching agent. */
  exePath?: string
  /** Uid the process must run as (jailUid in jailer mode, agent uid direct). */
  uid?: number
  /** Jailer mode only: host path of this instance's chroot root. */
  jailRoot?: string
}
export type IdentifiedVmHandle = VmHandle & VmHandleIdentity

interface InstanceTrust {
  instanceId: string
  exe: ExeIdentity
  exePath: string
  uid: number
  jailRoot?: string
}

interface PersistedIdentity {
  version: 1
  instanceId: string
  exe: ExeIdentity
  exePath: string
  uid: number
  jailRoot?: string
  apiSocket: string
  dir: string
}

const currentUid = (): number =>
  typeof process.getuid === 'function' ? process.getuid() : 0

const errorFields = (err: unknown): { error: string; code?: string } => {
  const name =
    err instanceof Error && err.name.length > 0 ? err.name : 'NonError'
  const code = (err as NodeJS.ErrnoException).code
  return typeof code === 'string' && code.length > 0
    ? { error: name, code }
    : { error: name }
}

/** /proc/mounts escapes spaces, tabs and backslashes as `\040`-style octals. */
const decodeMountPath = (value: string): string =>
  value.replace(/\\([0-7]{3})/g, (_, octal: string) =>
    String.fromCharCode(Number.parseInt(octal, 8))
  )

/** Injectable process spawn (the only privileged edge tests replace). */
export interface SpawnedVm {
  pid: number
  kill(signal?: NodeJS.Signals | number): void
  exited: Promise<number>
}

export type VmSpawn = (
  argv: readonly string[],
  opts: { cwd: string }
) => SpawnedVm

export interface VmDeps {
  runner?: CommandRunner
  logger?: Logger
  spawn?: VmSpawn
  now?: Clock
  sleep?: (ms: number) => Promise<void>
  /** Injectable `/proc/mounts` reader (tests assert cgroup2 accuracy). */
  readMounts?: () => Promise<{ mountpoint: string; fstype: string }[]>
  /** Injectable signal sender (tests can prove what is never signalled). */
  killProcess?: (pid: number, signal: NodeJS.Signals) => void
}

const defaultSpawn: VmSpawn = (argv, opts) => {
  const proc = Bun.spawn([...argv], {
    cwd: opts.cwd,
    // Own session: the VM must survive an agent restart. No config is passed
    // through argv or the environment; everything goes over the API socket.
    detached: true,
    stdin: 'ignore',
    stdout: 'ignore',
    stderr: 'ignore',
    env: { PATH: process.env.PATH ?? '/usr/sbin:/usr/bin:/sbin:/bin' },
  })
  return {
    pid: proc.pid,
    kill: signal => proc.kill(signal),
    exited: proc.exited,
  }
}

const delay = (ms: number): Promise<void> =>
  new Promise(resolve => setTimeout(resolve, ms))

const abortError = (reason?: unknown): Error => {
  if (reason instanceof Error) return reason
  const err = new Error('operation aborted')
  err.name = 'AbortError'
  return err
}

const sleepAbortable = (ms: number, signal?: AbortSignal): Promise<void> =>
  new Promise((resolve, reject) => {
    if (signal?.aborted) {
      reject(abortError(signal.reason))
      return
    }
    const onAbort = (): void => {
      clearTimeout(timer)
      reject(abortError(signal?.reason))
    }
    const timer = setTimeout(() => {
      signal?.removeEventListener('abort', onAbort)
      resolve()
    }, ms)
    signal?.addEventListener('abort', onAbort, { once: true })
  })

/** Resolve the configured binary once. Missing paths fall back lexically so preflight can report false. */
const resolveConfiguredBinary = (target: string): string => {
  try {
    return realpathSync(target)
  } catch {
    return path.resolve(target)
  }
}

/** Combine the caller's cancellation with a per-attempt timeout. */
const combineAbortSignals = (a: AbortSignal, b: AbortSignal): AbortSignal => {
  const anySignal = (
    AbortSignal as unknown as {
      any?: (signals: AbortSignal[]) => AbortSignal
    }
  ).any
  if (typeof anySignal === 'function') return anySignal([a, b])
  const controller = new AbortController()
  const abort = (): void => controller.abort()
  if (a.aborted || b.aborted) controller.abort()
  a.addEventListener('abort', abort, { once: true })
  b.addEventListener('abort', abort, { once: true })
  return controller.signal
}

interface RateLimiter {
  ops: { size: number; one_time_burst: number; refill_time: number }
  bandwidth: { size: number; one_time_burst: number; refill_time: number }
}

const rateLimiter = (opsPerSec: number, bytesPerSec: number): RateLimiter => ({
  ops: {
    size: Math.max(1, Math.trunc(opsPerSec)),
    one_time_burst: 0,
    refill_time: 1000,
  },
  bandwidth: {
    size: Math.max(1, Math.trunc(bytesPerSec)),
    one_time_burst: 0,
    refill_time: 1000,
  },
})

const validateLaunchRequest = (request: VmLaunchRequest): void => {
  assertInstanceId(request.instanceId)
  if (
    !Number.isSafeInteger(request.vcpus) ||
    request.vcpus < 1 ||
    request.vcpus > 8
  ) {
    throw new VmValidationError(`invalid vcpus: ${request.vcpus}`)
  }
  if (
    !Number.isSafeInteger(request.memMiB) ||
    request.memMiB < 128 ||
    request.memMiB > 16384
  ) {
    throw new VmValidationError(`invalid memMiB: ${request.memMiB}`)
  }
  if (
    !Number.isSafeInteger(request.diskMiB) ||
    request.diskMiB < 64 ||
    request.diskMiB > 65536
  ) {
    throw new VmValidationError(`invalid diskMiB: ${request.diskMiB}`)
  }
  if (
    request.kernelArgs !== undefined &&
    !KERNEL_ARGS_REGEX.test(request.kernelArgs)
  ) {
    throw new VmValidationError('invalid extra kernel arguments')
  }
  const lease = request.lease
  if (lease.instanceId !== request.instanceId) {
    throw new VmValidationError('lease instance id mismatch')
  }
  if (!TAP_NAME_REGEX.test(lease.tapName)) {
    throw new VmValidationError(`invalid tap name: ${lease.tapName}`)
  }
  if (!isIPv4(lease.hostIp) || !isIPv4(lease.guestIp)) {
    throw new VmValidationError('lease addresses must be IPv4')
  }
  if (lease.hostIp === lease.guestIp) {
    throw new VmValidationError('lease host/guest addresses are identical')
  }
  if (!MAC_REGEX.test(lease.guestMac)) {
    throw new VmValidationError(`invalid guest MAC: ${lease.guestMac}`)
  }
  if (lease.prefixLength !== 30) {
    throw new VmValidationError(
      `lease prefixLength must be 30, got ${lease.prefixLength}`
    )
  }
}

/**
 * Boot contract v1: kernel IP autoconfig on the single virtio NIC. `init=` is
 * emitted before the challenge's extra args, so a later `init=` in
 * `kernelArgs` still wins.
 */
export const buildBootArgs = (
  lease: VmLaunchRequest['lease'],
  extra?: string,
  defaultInit = '/rctf/init'
): string => {
  const base = [
    'console=ttyS0',
    'reboot=k',
    'panic=1',
    'pci=off',
    `ip=${lease.guestIp}::${lease.hostIp}:255.255.255.252::eth0:off`,
    `init=${defaultInit}`,
  ].join(' ')
  return extra === undefined || extra.length === 0 ? base : `${base} ${extra}`
}

interface StorageLayout {
  instanceDir: string
  apiSocketHostPath: string
  kernelApiPath: string
  rootfsApiPath: string
  initrdApiPath?: string
}

/** sockaddr_un.sun_path is 108 bytes including the trailing NUL. */
const MAX_UNIX_SOCKET_PATH = 107

export const createVmDriver = (
  config: VmConfig,
  deps: VmDeps = {}
): VmDriver => {
  const runner = deps.runner ?? bunCommandRunner
  const logger = deps.logger ?? createLogger('firecracker-vm')
  const spawn = deps.spawn ?? defaultSpawn
  const now = deps.now ?? Date.now
  const sleep = deps.sleep ?? delay
  const killProcess = deps.killProcess ?? process.kill

  const runDirAbs = path.resolve(config.runDir)
  const chrootBaseAbs = path.resolve(config.chrootBase)
  const cgroupRootAbs = path.resolve(config.cgroupRoot)

  // Resolved ONCE. The jailer canonicalizes `--exec-file` and names the jail
  // after the *resolved* basename, so every path and process check uses this.
  const firecrackerBinAbs = resolveConfiguredBinary(config.firecrackerBin)
  const firecrackerBase = path.basename(firecrackerBinAbs)
  const jailerBinAbs = resolveConfiguredBinary(config.jailerBin)
  const firecrackerExeNames: ReadonlySet<string> = new Set([firecrackerBase])

  const jailParent = (): string => path.join(chrootBaseAbs, firecrackerBase)
  const jailBase = (instanceId: string): string =>
    path.join(jailParent(), instanceId)
  const jailRoot = (instanceId: string): string =>
    path.join(jailBase(instanceId), 'root')
  const instanceDir = (instanceId: string): string =>
    path.join(runDirAbs, instanceId)

  /** The socket path the driver itself would use (never trust handle.apiSocket blindly). */
  const expectedApiSocket = (instanceId: string): string =>
    config.mode === 'jailer'
      ? path.join(jailRoot(instanceId), 'api.sock')
      : path.join(instanceDir(instanceId), 'api.sock')

  const dirForHandle = (instanceId: string): string =>
    config.mode === 'jailer' ? jailBase(instanceId) : instanceDir(instanceId)

  const identityMarkerPath = (instanceId: string): string =>
    path.join(instanceDir(instanceId), 'vm-identity.json')

  /** Log an ignored sidecar once per instance (repeated isAlive calls stay quiet). */
  const ignoredIdentity = new Set<string>()

  /** Sidecar owner must be the agent or root; group/other write makes it untrusted. */
  const trustedOwner = (uid: number, mode: number): boolean =>
    (uid === currentUid() || uid === 0) && (mode & 0o022) === 0

  /**
   * The uid a verified process must run as. In production the agent is root
   * and jailer drops to `jailUid`; direct mode never changes uid. An
   * unprivileged dev/test agent cannot setuid (jailer would fail), so its
   * children run as the agent uid.
   */
  const expectedUidFor = (jailRootPath?: string): number =>
    config.mode === 'jailer' && jailRootPath !== undefined
      ? currentUid() === 0
        ? config.jailUid
        : currentUid()
      : currentUid()

  const trustExpectation = (trust: InstanceTrust): ProcessExpectation => ({
    instanceId: trust.instanceId,
    exe: trust.exe,
    uid: trust.uid,
    ...(trust.jailRoot === undefined
      ? {}
      : {
          jailRoot: trust.jailRoot,
          // A non-root agent cannot chroot; the exe inode is still the exact
          // jail copy and the uid is still checked.
          allowUnchrootedJailer: currentUid() !== 0,
        }),
  })

  const identityAt = async (
    target: string
  ): Promise<ExeIdentity | undefined> => {
    try {
      return await statExeIdentity(target)
    } catch {
      return undefined
    }
  }

  /** Every immediate child directory of chrootBase, regardless of exec basename. */
  const listJailParentDirs = async (): Promise<string[]> => {
    let entries
    try {
      entries = await readdir(chrootBaseAbs, { withFileTypes: true })
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === 'ENOENT') return []
      throw err
    }
    const dirs: string[] = []
    for (const entry of entries) {
      if (!entry.isDirectory() || entry.isSymbolicLink()) {
        logger.debug(
          {
            op: 'vm.jailScan',
            path: path.join(chrootBaseAbs, entry.name),
            symlink: entry.isSymbolicLink(),
          },
          'skipping non-directory jail parent'
        )
        continue
      }
      dirs.push(path.join(chrootBaseAbs, entry.name))
    }
    return dirs.sort()
  }

  /** Every `<chrootBase>/<any exec basename>/<id>/root` jail that exists. */
  const listJailRoots = async (instanceId: string): Promise<string[]> => {
    const roots: string[] = []
    for (const parent of await listJailParentDirs()) {
      // Never follow an intermediate symlink: lstat every path component the
      // driver did not create itself. A symlinked `<id>` must not turn an
      // unrelated directory into a trust anchor (or into something destroy
      // would remove).
      const base = path.join(parent, instanceId)
      let baseStat
      try {
        baseStat = await lstat(base)
      } catch {
        continue
      }
      if (baseStat.isSymbolicLink() || !baseStat.isDirectory()) {
        logger.debug(
          {
            op: 'vm.jailScan',
            path: base,
            symlink: baseStat.isSymbolicLink(),
          },
          'skipping non-directory jail path (symlink or file)'
        )
        continue
      }
      const candidate = path.join(base, 'root')
      let st
      try {
        st = await lstat(candidate)
      } catch {
        // not present
        continue
      }
      if (st.isSymbolicLink() || !st.isDirectory()) {
        logger.debug(
          {
            op: 'vm.jailScan',
            path: candidate,
            symlink: st.isSymbolicLink(),
          },
          'skipping non-directory jail root (symlink or file)'
        )
        continue
      }
      roots.push(candidate)
    }
    return roots
  }

  /**
   * Executables inside an instance's jails. Jailer copies the configured binary
   * into `<root>/<basename>`; these files are the trust anchors that survive a
   * configured-binary change and agent restart.
   */
  const listJailExecutables = async (
    instanceId: string
  ): Promise<{ path: string; exe: ExeIdentity; jailRoot: string }[]> => {
    const found: { path: string; exe: ExeIdentity; jailRoot: string }[] = []
    for (const root of await listJailRoots(instanceId)) {
      let entries
      try {
        entries = await readdir(root, { withFileTypes: true })
      } catch {
        continue
      }
      for (const entry of entries) {
        if (!entry.isFile()) continue
        const target = path.join(root, entry.name)
        try {
          const st = await stat(target)
          if ((st.mode & 0o111) === 0) continue
          found.push({
            path: target,
            exe: { dev: st.dev, ino: st.ino },
            jailRoot: root,
          })
        } catch {
          // vanished
        }
      }
    }
    return found
  }

  const persistedIdentity = async (
    instanceId: string
  ): Promise<PersistedIdentity | undefined> => {
    const marker = identityMarkerPath(instanceId)
    const parent = instanceDir(instanceId)
    const ignore = (reason: string, err?: unknown): undefined => {
      if (!ignoredIdentity.has(marker)) {
        ignoredIdentity.add(marker)
        logger.warn(
          {
            instanceId,
            op: 'vm.identity',
            path: marker,
            reason,
            ...(err === undefined ? {} : errorFields(err)),
          },
          'ignoring untrusted vm identity sidecar'
        )
      }
      return undefined
    }

    let handle: FileHandle | undefined
    try {
      // O_NOFOLLOW: a symlink is not an identity anchor. A regular file is
      // then checked for owner and mode below.
      handle = await open(marker, fsConstants.O_RDONLY | fsConstants.O_NOFOLLOW)
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== 'ENOENT') {
        return ignore('open', err)
      }
      return undefined
    }

    let raw: string
    try {
      const st = await handle.stat()
      if (!st.isFile() || !trustedOwner(st.uid, st.mode)) {
        return ignore('file metadata')
      }
      let parentStat
      try {
        parentStat = await lstat(parent)
      } catch (err) {
        return ignore('parent', err)
      }
      if (
        parentStat.isSymbolicLink() ||
        !parentStat.isDirectory() ||
        !trustedOwner(parentStat.uid, parentStat.mode)
      ) {
        return ignore('parent metadata')
      }
      raw = await handle.readFile('utf8')
    } finally {
      await handle.close().catch(() => undefined)
    }

    try {
      const parsed = JSON.parse(raw) as Partial<PersistedIdentity>
      if (
        parsed.version !== 1 ||
        parsed.instanceId !== instanceId ||
        typeof parsed.exe?.dev !== 'number' ||
        typeof parsed.exe?.ino !== 'number' ||
        !Number.isSafeInteger(parsed.exe.dev) ||
        !Number.isSafeInteger(parsed.exe.ino) ||
        typeof parsed.uid !== 'number' ||
        !Number.isSafeInteger(parsed.uid) ||
        typeof parsed.exePath !== 'string' ||
        typeof parsed.apiSocket !== 'string' ||
        typeof parsed.dir !== 'string' ||
        (parsed.jailRoot !== undefined && typeof parsed.jailRoot !== 'string')
      ) {
        return undefined
      }
      return {
        version: 1,
        instanceId,
        exe: { dev: parsed.exe.dev, ino: parsed.exe.ino },
        exePath: parsed.exePath,
        uid: parsed.uid,
        ...(parsed.jailRoot === undefined ? {} : { jailRoot: parsed.jailRoot }),
        apiSocket: parsed.apiSocket,
        dir: parsed.dir,
      }
    } catch {
      return undefined
    }
  }

  const persistIdentity = async (handle: IdentifiedVmHandle): Promise<void> => {
    if (
      handle.exeDev === undefined ||
      handle.exeIno === undefined ||
      handle.uid === undefined ||
      handle.exePath === undefined
    ) {
      return
    }
    const identity: PersistedIdentity = {
      version: 1,
      instanceId: handle.instanceId,
      exe: { dev: handle.exeDev, ino: handle.exeIno },
      exePath: handle.exePath,
      uid: handle.uid,
      ...(handle.jailRoot === undefined ? {} : { jailRoot: handle.jailRoot }),
      apiSocket: handle.apiSocket,
      dir: handle.dir,
    }
    const target = identityMarkerPath(handle.instanceId)
    const dir = path.dirname(target)
    // Atomic replace: tmp + fsync + rename, mode 0600. rename() replaces a
    // symlink at the destination instead of writing through it, so even a
    // stale/hostile marker cannot redirect the identity write.
    const tmp = `${target}.${process.pid}.${randomUUID()}.tmp`
    let file: FileHandle | undefined
    try {
      file = await open(tmp, 'w', 0o600)
      await file.writeFile(JSON.stringify(identity))
      await file.chmod(0o600)
      await file.sync()
      await file.close()
      file = undefined
      await rename(tmp, target)
    } catch (err) {
      await file?.close().catch(() => undefined)
      await rm(tmp, { force: true }).catch(() => undefined)
      throw err
    }
    // Best-effort directory fsync so the rename survives a crash.
    try {
      const dirHandle = await open(dir, 'r')
      try {
        await dirHandle.sync()
      } finally {
        await dirHandle.close()
      }
    } catch {
      // Some filesystems reject directory fsync; the file itself is synced.
    }
  }

  /** The configured binary in direct mode, or this instance's jail copy. */
  const currentTrust = async (
    instanceId: string
  ): Promise<InstanceTrust | undefined> => {
    if (config.mode === 'direct') {
      const exe = await identityAt(firecrackerBinAbs)
      if (exe === undefined) return undefined
      return {
        instanceId,
        exe,
        exePath: firecrackerBinAbs,
        uid: currentUid(),
      }
    }
    const root = jailRoot(instanceId)
    const exePath = path.join(root, firecrackerBase)
    const exe = await identityAt(exePath)
    if (exe === undefined) return undefined
    return {
      instanceId,
      exe,
      exePath,
      uid: expectedUidFor(root),
      jailRoot: root,
    }
  }

  /** All trust anchors for an id: persisted marker, jail copies, current binary. */
  const trustsForInstance = async (
    instanceId: string
  ): Promise<InstanceTrust[]> => {
    const trusts: InstanceTrust[] = []
    const seen = new Set<string>()
    const add = (trust: InstanceTrust | undefined): void => {
      if (trust === undefined) return
      const key = `${trust.exe.dev}:${trust.exe.ino}:${trust.jailRoot ?? ''}`
      if (seen.has(key)) return
      seen.add(key)
      trusts.push(trust)
    }
    const persisted = await persistedIdentity(instanceId)
    if (persisted !== undefined) {
      add({
        instanceId,
        exe: persisted.exe,
        exePath: persisted.exePath,
        uid: persisted.uid,
        ...(persisted.jailRoot === undefined
          ? {}
          : { jailRoot: persisted.jailRoot }),
      })
    }
    add(await currentTrust(instanceId))
    for (const candidate of await listJailExecutables(instanceId)) {
      add({
        instanceId,
        exe: candidate.exe,
        exePath: candidate.path,
        uid: expectedUidFor(candidate.jailRoot),
        jailRoot: candidate.jailRoot,
      })
    }
    return trusts
  }

  const trustFromHandle = (handle: VmHandle): InstanceTrust | undefined => {
    const identified = handle as IdentifiedVmHandle
    if (
      identified.exeDev === undefined ||
      identified.exeIno === undefined ||
      identified.uid === undefined
    ) {
      return undefined
    }
    return {
      instanceId: handle.instanceId,
      exe: { dev: identified.exeDev, ino: identified.exeIno },
      exePath: identified.exePath ?? '',
      uid: identified.uid,
      ...(identified.jailRoot === undefined
        ? {}
        : { jailRoot: identified.jailRoot }),
    }
  }

  const assertRealDirectory = async (
    target: string,
    what: string
  ): Promise<void> => {
    let st
    try {
      st = await lstat(target)
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === 'ENOENT') {
        throw new VmValidationError(`${what} does not exist: ${target}`)
      }
      throw err
    }
    if (st.isSymbolicLink() || !st.isDirectory()) {
      throw new VmValidationError(
        `${what} must be a real directory (not a symlink): ${target}`
      )
    }
  }

  const ensureRunDir = async (): Promise<void> => {
    try {
      await lstat(runDirAbs)
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== 'ENOENT') throw err
      await mkdir(runDirAbs, { recursive: true, mode: 0o700 })
    }
    await assertRealDirectory(runDirAbs, 'runDir')
  }

  const createExclusiveDir = async (
    target: string,
    what: string
  ): Promise<void> => {
    try {
      await mkdir(target, { mode: 0o700 })
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === 'EEXIST') {
        throw new VmValidationError(`${what} already exists: ${target}`)
      }
      throw err
    }
    await chmod(target, 0o700)
    await assertRealDirectory(target, what)
  }

  const createInstanceDir = async (instanceId: string): Promise<string> => {
    const dir = instanceDir(instanceId)
    if (!isPathInside(runDirAbs, dir)) {
      throw new VmValidationError(`instance dir escapes runDir: ${dir}`)
    }
    await createExclusiveDir(dir, 'instance dir')
    return dir
  }

  const ensureJailParent = async (): Promise<void> => {
    await assertRealDirectory(chrootBaseAbs, 'chrootBase')
    const parent = jailParent()
    try {
      await lstat(parent)
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== 'ENOENT') throw err
      await mkdir(parent, { mode: 0o700 })
      await chmod(parent, 0o700)
    }
    await assertRealDirectory(parent, 'jail parent')
  }

  const copyRootfs = async (src: string, dst: string): Promise<void> => {
    const result = await runner.run(
      [
        'cp',
        '--reflink=auto',
        '--sparse=always',
        '--no-preserve=mode,ownership',
        src,
        dst,
      ],
      { timeoutMs: 120_000 }
    )
    if (result.code !== 0) {
      throw new Error(
        `copying rootfs failed (exit ${result.code}): ${result.stderr.trim().slice(0, 512)}`
      )
    }
  }

  const chownIfRoot = async (target: string): Promise<void> => {
    if (typeof process.getuid === 'function' && process.getuid() !== 0) {
      // Only the privileged agent can hand files to the jail uid. Tests and
      // dev runs deliberately skip it.
      logger.debug({ target }, 'not root; skipping jail chown')
      return
    }
    await chown(target, config.jailUid, config.jailGid)
  }

  const placeIntoJail = async (src: string, dst: string): Promise<void> => {
    try {
      await link(src, dst)
    } catch {
      // Different filesystem (or protected hardlinks): fall back to a copy.
      await copyRootfs(src, dst)
    }
  }

  const prepareJail = async (
    instanceId: string,
    image: ResolvedImage,
    runRootfs: string
  ): Promise<{
    apiSocketHostPath: string
    kernelApiPath: string
    rootfsApiPath: string
    initrdApiPath?: string
  }> => {
    await ensureJailParent()
    const base = jailBase(instanceId)
    await createExclusiveDir(base, 'jail dir')
    const root = jailRoot(instanceId)
    await createExclusiveDir(root, 'jail root')

    const kernelDst = path.join(root, 'vmlinux')
    await copyFile(image.vmlinux, kernelDst)
    await chmod(kernelDst, 0o444)
    await chownIfRoot(kernelDst)

    const rootfsDst = path.join(root, 'rootfs.ext4')
    await placeIntoJail(runRootfs, rootfsDst)
    await chmod(rootfsDst, 0o600)
    await chownIfRoot(rootfsDst)

    let initrdApiPath: string | undefined
    if (image.initrd !== undefined) {
      const initrdDst = path.join(root, 'initrd')
      await copyFile(image.initrd, initrdDst)
      await chmod(initrdDst, 0o400)
      await chownIfRoot(initrdDst)
      initrdApiPath = '/initrd'
    }

    await chownIfRoot(root)

    return {
      apiSocketHostPath: path.join(root, 'api.sock'),
      kernelApiPath: '/vmlinux',
      rootfsApiPath: '/rootfs.ext4',
      ...(initrdApiPath === undefined ? {} : { initrdApiPath }),
    }
  }

  /**
   * Jailer argv. The instance id is validated by INSTANCE_ID_REGEX, all paths
   * are absolute and passed as separate argv elements: no shell is involved
   * and nothing can be injected. Jailer already passes `--id <id>` to the
   * Firecracker it execs, so only `--api-sock` follows `--`: passing `--id`
   * again makes Firecracker reject the duplicate flag. Seccomp stays at
   * Firecracker's default level (jailer does not disable it).
   */
  const buildSpawnArgv = (
    instanceId: string,
    apiSocketHostPath: string,
    diskMiB: number
  ): string[] => {
    if (config.mode === 'direct') {
      return [
        firecrackerBinAbs,
        '--id',
        instanceId,
        '--api-sock',
        apiSocketHostPath,
      ]
    }
    return [
      jailerBinAbs,
      '--id',
      instanceId,
      '--exec-file',
      firecrackerBinAbs,
      '--uid',
      String(config.jailUid),
      '--gid',
      String(config.jailGid),
      '--chroot-base-dir',
      chrootBaseAbs,
      '--cgroup-version',
      '2',
      ...(config.parentCgroup === undefined
        ? []
        : ['--parent-cgroup', config.parentCgroup]),
      // Jailer only creates a cgroup-v2 child when at least one --cgroup is
      // supplied. Limits come from the operator's config (no guessing).
      ...config.cgroupLimits.flatMap(limit => ['--cgroup', limit]),
      '--new-pid-ns',
      // `--resource-limit` may be repeated; do not join the pairs.
      '--resource-limit',
      // fsize must cover every offset Firecracker may write in the rootfs.
      `fsize=${Math.max(config.fsizeLimitBytes, diskMiB * MIB)}`,
      '--resource-limit',
      `no-file=${config.noFileLimit}`,
      '--',
      '--api-sock',
      '/api.sock',
    ]
  }

  const killChild = async (
    child: SpawnedVm,
    startTicks: number | undefined
  ): Promise<void> => {
    // Never signal a recycled pid: the child must still have the start ticks
    // captured right after this launch's spawn. Without ticks, leave it to the
    // strict scan/rollback path.
    if (startTicks === undefined) return
    if ((await readStartTicks(child.pid)) !== startTicks) return
    try {
      child.kill('SIGKILL')
    } catch {
      // already gone
    }
    await Promise.race([
      child.exited.catch(() => -1),
      sleep(2000).then(() => -1),
    ])
  }

  /**
   * With `--new-pid-ns` the jailer forks Firecracker into a new PID namespace
   * and exits; the host-visible Firecracker pid is written to
   * `<jailRoot>/<firecracker basename>.pid` (jailer docs/source). The pid file
   * is never trusted on its own: the pid must pass the strict identity scan
   * (executable device+inode, uid and jail root) before we track it.
   */
  const waitForJailerChildPid = async (
    child: SpawnedVm,
    instanceId: string
  ): Promise<{ pid: number; startTicks: number }> => {
    const pidFile = path.join(jailRoot(instanceId), `${firecrackerBase}.pid`)
    let exitCode: number | undefined
    child.exited.then(
      code => {
        exitCode = code
      },
      () => {
        exitCode = -1
      }
    )
    let sawPidFile = false
    const deadline = now() + config.apiStartTimeoutMs
    while (now() < deadline) {
      let pid: number | undefined
      try {
        const raw = await readFile(pidFile, 'utf8')
        const parsed = Number(raw.trim())
        if (Number.isSafeInteger(parsed) && parsed > 0) pid = parsed
      } catch {
        // not written yet
      }
      if (pid !== undefined) {
        sawPidFile = true
        // Jailer copies the exec into the jail before it starts it; wait for
        // that file to exist so the inode check has a trust anchor.
        const trust = await currentTrust(instanceId)
        if (trust !== undefined) {
          const identity = await inspectProcess(pid, trustExpectation(trust))
          if (identity !== undefined) {
            return { pid: identity.pid, startTicks: identity.startTicks }
          }
        }
      }
      if (exitCode !== undefined && !sawPidFile) {
        throw new Error(
          `jailer exited (code ${exitCode}) before writing its child pid file`
        )
      }
      await sleep(25)
    }
    throw new Error(
      `timed out after ${config.apiStartTimeoutMs}ms waiting for the jailer pid file`
    )
  }

  /**
   * Wait until the spawned process is verifiably our Firecracker (executable
   * device+inode, uid, optional jail root and adjacent `--id <id>`), returning
   * the start ticks captured by that same scan.
   */
  const waitForVerifiedProcess = async (
    pid: number,
    trust: InstanceTrust,
    timeoutMs = config.apiStartTimeoutMs
  ): Promise<number> => {
    const deadline = now() + timeoutMs
    const expectation = trustExpectation(trust)
    for (;;) {
      const identity = await inspectProcess(pid, expectation)
      if (identity !== undefined) return identity.startTicks
      if ((await readStartTicks(pid)) === undefined) {
        throw new Error(
          `firecracker (pid ${pid}) exited before it could be verified`
        )
      }
      if (now() >= deadline) {
        throw new Error(
          `timed out after ${timeoutMs}ms verifying firecracker (pid ${pid})`
        )
      }
      await sleep(10)
    }
  }

  const connectUnix = (
    socketPath: string,
    timeoutMs: number
  ): Promise<boolean> =>
    new Promise(resolve => {
      let settled = false
      const socket = createConnection({ path: socketPath })
      const finish = (value: boolean): void => {
        if (settled) return
        settled = true
        socket.destroy()
        resolve(value)
      }
      socket.setTimeout(timeoutMs)
      socket.once('connect', () => finish(true))
      socket.once('timeout', () => finish(false))
      socket.once('error', () => finish(false))
    })

  /**
   * API socket readiness is a successful connect, not the existence of a
   * socket *file* (stale files, or a file created before listen(), would lie).
   * Retries with backoff until the deadline and fails if the VM dies.
   */
  const waitForApiSocket = async (
    pid: number,
    pidStartTicks: number,
    apiSocketHostPath: string,
    expectation: ProcessExpectation
  ): Promise<void> => {
    const deadline = now() + config.apiStartTimeoutMs
    let backoff = 10
    for (;;) {
      if (!(await processMatchesIdentity(pid, pidStartTicks, expectation))) {
        throw new Error(
          `firecracker (pid ${pid}) exited before creating its API socket`
        )
      }
      if (await connectUnix(apiSocketHostPath, 250)) return
      if (now() >= deadline) {
        throw new Error(
          `timed out after ${config.apiStartTimeoutMs}ms waiting for the firecracker API socket`
        )
      }
      await sleep(backoff)
      backoff = Math.min(100, Math.ceil(backoff * 1.5))
    }
  }

  const configureAndStart = async (
    handle: VmHandle,
    request: VmLaunchRequest,
    storage: StorageLayout
  ): Promise<void> => {
    const api = new FirecrackerApi(handle.apiSocket, {
      timeoutMs: config.apiTimeoutMs,
    })
    const diskLimiter = rateLimiter(
      config.diskIops,
      config.diskBandwidthMiBps * MIB
    )
    const netLimiter = rateLimiter(
      config.netPps,
      config.netBandwidthMiBps * MIB
    )

    await api.put('/boot-source', {
      kernel_image_path: storage.kernelApiPath,
      boot_args: buildBootArgs(
        request.lease,
        request.kernelArgs,
        config.defaultInit
      ),
      ...(storage.initrdApiPath === undefined
        ? {}
        : { initrd_path: storage.initrdApiPath }),
    })
    await api.put('/drives/rootfs', {
      drive_id: 'rootfs',
      path_on_host: storage.rootfsApiPath,
      is_root_device: true,
      is_read_only: false,
      rate_limiter: diskLimiter,
    })
    await api.put('/network-interfaces/eth0', {
      iface_id: 'eth0',
      guest_mac: request.lease.guestMac,
      host_dev_name: request.lease.tapName,
      tx_rate_limiter: netLimiter,
      rx_rate_limiter: netLimiter,
    })
    await api.put('/machine-config', {
      vcpu_count: request.vcpus,
      mem_size_mib: request.memMiB,
      smt: false,
    })
    await api.put('/mmds/config', {
      version: 'V2',
      network_interfaces: ['eth0'],
    })
    // Guest metadata (flags) only ever travels over this API call. The client
    // never logs the body and nothing is written to disk.
    await api.put('/mmds', request.metadata)
    await api.put('/actions', { action_type: 'InstanceStart' })
  }

  const removeExpectedSocket = async (handle: VmHandle): Promise<void> => {
    const candidates = new Set<string>([expectedApiSocket(handle.instanceId)])
    candidates.add(handle.apiSocket)
    const persisted = persistedIdentity(handle.instanceId)
    // `persisted` is a promise; the marker may not exist for legacy handles.
    const marker = await persisted
    if (marker !== undefined) candidates.add(marker.apiSocket)
    const allowed = new Set<string>([
      instanceDir(handle.instanceId),
      ...(await listJailRoots(handle.instanceId)),
    ])
    const identified = handle as IdentifiedVmHandle
    if (identified.jailRoot !== undefined) allowed.add(identified.jailRoot)
    for (const candidate of candidates) {
      if (
        ![...allowed].some(
          base => candidate === base || isPathInside(base, candidate)
        )
      ) {
        continue
      }
      await rm(candidate, { force: true })
    }
  }

  /** Remove `<id>` below EVERY jail parent (any exec basename), not just today's. */
  const removeJailTrees = async (instanceId: string): Promise<void> => {
    for (const parent of await listJailParentDirs()) {
      await removeInstanceTree(parent, instanceId)
    }
  }

  const removeInstanceStorage = async (instanceId: string): Promise<void> => {
    await removeInstanceTree(runDirAbs, instanceId)
    await removeJailTrees(instanceId)
  }

  const cgroupParents = (): string[] => [
    ...new Set([config.parentCgroup ?? firecrackerBase, firecrackerBase]),
  ]

  const cgroupCandidates = async (instanceId: string): Promise<string[]> => {
    const candidates = new Set<string>([
      path.join(cgroupRootAbs, instanceId),
      ...cgroupParents().map(parent =>
        path.join(cgroupRootAbs, parent, instanceId)
      ),
    ])
    // A binary change moves the jailer's default parent cgroup, so also look
    // under every existing first-level cgroup (e.g. an old firecracker name).
    const entries = await readdir(cgroupRootAbs, { withFileTypes: true }).catch(
      () => [] as const
    )
    for (const entry of entries) {
      if (!entry.isDirectory() || entry.isSymbolicLink()) continue
      candidates.add(path.join(cgroupRootAbs, entry.name, instanceId))
    }
    return [...candidates]
      .filter(candidate => isPathInside(cgroupRootAbs, candidate))
      .sort()
  }

  const readProcMounts =
    deps.readMounts ??
    (async (): Promise<{ mountpoint: string; fstype: string }[]> => {
      let raw: string
      try {
        raw = await readFile('/proc/mounts', 'utf8')
      } catch {
        return []
      }
      const mounts: { mountpoint: string; fstype: string }[] = []
      for (const line of raw.split('\n')) {
        const fields = line.trim().split(/\s+/)
        if (fields.length < 3) continue
        const [mountpoint, fstype] = [fields[1], fields[2]]
        if (mountpoint === undefined || fstype === undefined) continue
        mounts.push({ mountpoint: decodeMountPath(mountpoint), fstype })
      }
      return mounts
    })

  const cgroupRootIsUsable = async (): Promise<boolean> => {
    // Exact mountpoint or a real descendant of a cgroup2 mount. A nonexistent
    // descendant is not usable (jailer would fail), and the agent must be able
    // to create the per-instance cgroup below it.
    let st
    try {
      st = await stat(cgroupRootAbs)
    } catch {
      return false
    }
    if (!st.isDirectory()) return false
    if (
      !(await canAccess(
        cgroupRootAbs,
        fsConstants.R_OK | fsConstants.W_OK | fsConstants.X_OK
      ))
    ) {
      return false
    }
    const mounts = await readProcMounts()
    return mounts.some(
      mount =>
        mount.fstype === 'cgroup2' &&
        (mount.mountpoint === cgroupRootAbs ||
          isPathInside(mount.mountpoint, cgroupRootAbs))
    )
  }

  const removeCgroups = async (instanceId: string): Promise<void> => {
    for (const candidate of await cgroupCandidates(instanceId)) {
      let attempt = 0
      for (;;) {
        try {
          await rmdir(candidate)
          break
        } catch (err) {
          const code = (err as NodeJS.ErrnoException).code
          if (code === 'ENOENT') break
          if (code !== 'EBUSY' && code !== 'ENOTEMPTY') throw err
          if (attempt >= 4) {
            logger.error(
              {
                instanceId,
                op: 'vm.cgroupCleanup',
                candidate,
                ...errorFields(err),
              },
              'cgroup cleanup failed after retries'
            )
            throw err
          }
          attempt += 1
          await sleep(20 * attempt)
        }
      }
    }
  }

  const isAlive = async (handle: VmHandle): Promise<boolean> => {
    const fromHandle = trustFromHandle(handle)
    let trusts: InstanceTrust[] = []
    if (fromHandle !== undefined) {
      trusts = [fromHandle]
    } else {
      // A valid-but-stale sidecar must not hide the other anchors (jail copy,
      // configured binary), and a handle written by an older agent (or whose
      // optional identity fields were stripped) still recovers one from disk.
      trusts = await trustsForInstance(handle.instanceId)
    }

    for (let attempt = 0; attempt < 3; attempt += 1) {
      let sawProcess = false
      for (const trust of trusts) {
        const identity = await inspectProcess(
          handle.pid,
          trustExpectation(trust)
        )
        if (identity === undefined) continue
        sawProcess = true
        if (identity.startTicks === handle.pidStartTicks) return true
      }
      if (trusts.length === 0) {
        // Previous-version fallback only when there is no inode anchor at all.
        const legacy = await inspectProcessLegacy(
          handle.pid,
          firecrackerExeNames,
          handle.instanceId
        )
        if (legacy !== undefined) {
          return legacy.startTicks === handle.pidStartTicks
        }
      }
      if (sawProcess) return false
      if ((await readStartTicks(handle.pid)) === undefined) return false
      // A process that is mid-exec briefly exposes an empty cmdline. Retry a
      // few times before calling it dead.
      await sleep(5)
    }
    return false
  }

  const tcpProbe = (
    host: string,
    port: number,
    timeoutMs: number,
    signal?: AbortSignal
  ): Promise<boolean> =>
    new Promise(resolve => {
      let settled = false
      const socket = createConnection({ host, port })
      const onAbort = (): void => finish(false)
      const finish = (value: boolean): void => {
        if (settled) return
        settled = true
        signal?.removeEventListener('abort', onAbort)
        socket.destroy()
        resolve(value)
      }
      if (signal?.aborted) {
        finish(false)
        return
      }
      signal?.addEventListener('abort', onAbort, { once: true })
      socket.setTimeout(timeoutMs)
      socket.once('connect', () => finish(true))
      socket.once('timeout', () => finish(false))
      socket.once('error', () => finish(false))
    })

  const httpProbe = async (
    host: string,
    port: number,
    pathname: string,
    expectStatus: number,
    timeoutMs: number,
    signal?: AbortSignal
  ): Promise<boolean> => {
    const timeout = AbortSignal.timeout(timeoutMs)
    const fetchSignal =
      signal === undefined ? timeout : combineAbortSignals(signal, timeout)
    try {
      const response = await fetch(`http://${host}:${port}${pathname}`, {
        signal: fetchSignal,
        redirect: 'manual',
      })
      await response.body?.cancel()
      return response.status === expectStatus
    } catch {
      return false
    }
  }

  const waitReady: VmDriver['waitReady'] = async (handle, probe, signal) => {
    if (signal?.aborted) throw abortError(signal.reason)
    if (!(await isAlive(handle))) {
      throw new Error(`VM ${handle.instanceId} is not running`)
    }
    if (probe.readiness.kind === 'none') return

    const deadline = now() + probe.timeoutMs
    const readiness = probe.readiness
    for (;;) {
      if (signal?.aborted) throw abortError(signal.reason)
      if (!(await isAlive(handle))) {
        throw new Error(
          `VM ${handle.instanceId} exited before readiness passed`
        )
      }
      if (now() >= deadline) {
        throw new Error(
          `VM ${handle.instanceId} was not ready within ${probe.timeoutMs}ms`
        )
      }
      const attemptTimeout = Math.max(50, Math.min(2000, deadline - now()))
      const ok =
        readiness.kind === 'tcp'
          ? await tcpProbe(
              probe.guestIp,
              readiness.port,
              attemptTimeout,
              signal
            )
          : await httpProbe(
              probe.guestIp,
              readiness.port,
              readiness.path ?? '/',
              readiness.expectStatus ?? 200,
              attemptTimeout,
              signal
            )
      if (ok) {
        // A probe can succeed just as the caller cancels or the VM dies; do
        // not report readiness for either.
        if (signal?.aborted) throw abortError(signal.reason)
        if (!(await isAlive(handle))) {
          throw new Error(
            `VM ${handle.instanceId} exited before readiness passed`
          )
        }
        return
      }
      const remaining = deadline - now()
      if (remaining <= 0) {
        throw new Error(
          `VM ${handle.instanceId} was not ready within ${probe.timeoutMs}ms`
        )
      }
      await sleepAbortable(
        Math.min(config.readinessIntervalMs, remaining),
        signal
      )
    }
  }

  const stop: VmDriver['stop'] = async (handle, opts) => {
    if (!(await isAlive(handle))) {
      await removeExpectedSocket(handle)
      return
    }

    try {
      const api = new FirecrackerApi(handle.apiSocket, {
        timeoutMs: Math.min(config.apiTimeoutMs, 2000),
      })
      await api.put('/actions', { action_type: 'SendCtrlAltDel' })
    } catch (err) {
      logger.debug(
        {
          instanceId: handle.instanceId,
          op: 'vm.stop',
          ...errorFields(err),
        },
        'SendCtrlAltDel failed; falling back to SIGKILL'
      )
    }

    const graceDeadline = now() + Math.max(0, opts.graceMs)
    while (now() < graceDeadline) {
      if (!(await isAlive(handle))) {
        await removeExpectedSocket(handle)
        return
      }
      await sleep(100)
    }

    // Re-verify the full identity immediately before signalling: never
    // SIGKILL a recycled pid (or any process that is not this Firecracker).
    if (await isAlive(handle)) {
      try {
        process.kill(handle.pid, 'SIGKILL')
      } catch (err) {
        if ((err as NodeJS.ErrnoException).code !== 'ESRCH') throw err
      }
    }

    const killDeadline = now() + config.killWaitMs
    while (now() < killDeadline) {
      if (!(await isAlive(handle))) break
      await sleep(50)
    }
    if (await isAlive(handle)) {
      throw new Error(
        `VM ${handle.instanceId} (pid ${handle.pid}) did not exit after SIGKILL`
      )
    }
    await removeExpectedSocket(handle)
  }

  interface TerminationTarget {
    pid: number
    startTicks: number
    expectation: ProcessExpectation
  }

  /** A now-closed window: three empty scans spread over at least 400ms. */
  const ROLLBACK_EMPTY_SCANS = 3
  const ROLLBACK_SETTLE_MS = 400
  const ROLLBACK_SCAN_INTERVAL_MS = 100
  const ROLLBACK_MAX_MS = 3000

  /**
   * The pre-exec jailer child. Jailer clones before it execs Firecracker, so
   * the child still runs the *jailer* executable and keeps the jailer argv
   * (`--id <id>`). This is the only pre-exec identity we accept: command-line
   * text alone (e.g. a path mentioned as an argument) never authorizes a kill.
   */
  const preExecJailerExpectation = async (
    instanceId: string
  ): Promise<ProcessExpectation | undefined> => {
    if (config.mode !== 'jailer') return undefined
    const exe = await identityAt(jailerBinAbs)
    if (exe === undefined) return undefined
    return { instanceId, exe, uid: currentUid() }
  }

  const looksLikeVmExecutable = (exe: string): boolean => {
    const target = exe.endsWith(' (deleted)')
      ? exe.slice(0, -' (deleted)'.length)
      : exe
    return /^(?:firecracker|jailer)(?:[._-].*)?$/i.test(path.basename(target))
  }

  /**
   * Processes that claim this instance (`--id <id>`) and look like a
   * Firecracker/Jailer binary but do not authenticate against ANY known anchor
   * (sidecar, current jail executable, configured binaries). Such a process is
   * never signalled: destroy must fail and keep the storage so the manager
   * keeps the teardown pending for operator intervention.
   */
  const findUnresolvedProcesses = async (
    instanceId: string,
    trusts: InstanceTrust[]
  ): Promise<{ pid: number; exe: string }[]> => {
    const expectations = trusts.map(trustExpectation)
    const preExec = await preExecJailerExpectation(instanceId)
    const unresolved: { pid: number; exe: string }[] = []
    for (const pid of await listPids()) {
      const snapshot = await readProcSnapshot(pid)
      if (snapshot === undefined) continue
      if (!hasInstanceIdArg(snapshot.argv, instanceId)) continue
      if (!looksLikeVmExecutable(snapshot.exe)) continue
      let authenticated = false
      for (const expectation of expectations) {
        if ((await inspectProcess(pid, expectation)) !== undefined) {
          authenticated = true
          break
        }
      }
      if (
        !authenticated &&
        preExec !== undefined &&
        (await inspectProcess(pid, preExec)) !== undefined
      ) {
        authenticated = true
      }
      if (!authenticated) unresolved.push({ pid, exe: snapshot.exe })
    }
    return unresolved
  }

  /**
   * Kill every process that can be authenticated for this instance.
   *
   * Verification happens immediately before every signal. Storage may only be
   * removed after three consecutive empty scans spread over at least 400ms, so
   * a jailer child that appears between clone and exec (which can take longer
   * than two quick scans) is still caught. The whole scan is bounded.
   */
  const terminateInstanceProcesses = async (
    instanceId: string,
    trusts?: InstanceTrust[]
  ): Promise<boolean> => {
    const anchors = trusts ?? (await trustsForInstance(instanceId))
    const preExec = await preExecJailerExpectation(instanceId)
    const deadline =
      now() +
      Math.min(
        Math.max(
          config.killWaitMs,
          ROLLBACK_SETTLE_MS + ROLLBACK_SCAN_INTERVAL_MS
        ),
        ROLLBACK_MAX_MS
      )
    let emptyScans = 0
    let firstEmptyAt: number | undefined
    for (;;) {
      const at = now()
      const targets = new Map<number, TerminationTarget>()
      for (const trust of anchors) {
        const expectation = trustExpectation(trust)
        for (const proc of await findInstanceProcesses(expectation)) {
          targets.set(proc.pid, {
            pid: proc.pid,
            startTicks: proc.startTicks,
            expectation,
          })
        }
      }
      if (preExec !== undefined) {
        for (const proc of await findInstanceProcesses(preExec)) {
          if (!targets.has(proc.pid)) {
            targets.set(proc.pid, {
              pid: proc.pid,
              startTicks: proc.startTicks,
              expectation: preExec,
            })
          }
        }
      }

      if (targets.size === 0) {
        emptyScans += 1
        if (firstEmptyAt === undefined) firstEmptyAt = at
        if (
          emptyScans >= ROLLBACK_EMPTY_SCANS &&
          at - firstEmptyAt >= ROLLBACK_SETTLE_MS
        ) {
          return true
        }
      } else {
        emptyScans = 0
        firstEmptyAt = undefined
        for (const target of targets.values()) {
          // Re-verify the exact process immediately before the signal.
          if (
            !(await processMatchesIdentity(
              target.pid,
              target.startTicks,
              target.expectation
            ))
          ) {
            continue
          }
          try {
            killProcess(target.pid, 'SIGKILL')
          } catch (err) {
            if ((err as NodeJS.ErrnoException).code !== 'ESRCH') throw err
          }
        }
      }

      if (at >= deadline) return false
      await sleep(ROLLBACK_SCAN_INTERVAL_MS)
    }
  }

  const destroy = async (instanceId: string): Promise<void> => {
    assertInstanceId(instanceId)
    const trusts = await trustsForInstance(instanceId)
    if (!(await terminateInstanceProcesses(instanceId, trusts))) {
      throw new Error(`firecracker for ${instanceId} survived SIGKILL`)
    }
    // Never declare a process absent when it cannot be authenticated: a
    // previous-binary VM without a sidecar must keep its storage so the
    // manager retries the teardown (and an operator can intervene).
    const unresolved = await findUnresolvedProcesses(instanceId, trusts)
    if (unresolved.length > 0) {
      logger.error(
        {
          instanceId,
          op: 'vm.destroy',
          unresolved: unresolved.map(proc => ({
            pid: proc.pid,
            exe: path.basename(proc.exe),
          })),
        },
        'unresolved process for instance; refusing to remove storage'
      )
      throw new Error(
        `unresolved process for ${instanceId} (pid ${unresolved
          .map(proc => proc.pid)
          .join(', ')})`
      )
    }
    await removeInstanceStorage(instanceId)
    await removeCgroups(instanceId)
  }

  const launch: VmDriver['launch'] = async request => {
    validateLaunchRequest(request)
    if (config.mode === 'direct') {
      logger.warn(
        { instanceId: request.instanceId },
        'SECURITY: Firecracker is running in direct mode (no jailer: no ' +
          'chroot, uid/gid drop, cgroup or pid-namespace isolation). ' +
          "Firecracker's built-in seccomp filter remains enabled. Never use " +
          'this in production.'
      )
    }
    const image = await resolveImage(config, request.image, request.diskMiB)
    await ensureRunDir()

    // Stale state from a previous launch/restart: never reuse it, and never
    // touch a live process that actually belongs to this instance. Every
    // persisted/derived trust anchor is checked (binary changes included).
    for (const trust of await trustsForInstance(request.instanceId)) {
      if ((await findInstanceProcesses(trustExpectation(trust))).length > 0) {
        throw new VmValidationError(
          `instance ${request.instanceId} already has a live firecracker process`
        )
      }
    }
    await removeInstanceStorage(request.instanceId)
    await removeCgroups(request.instanceId)

    let child: SpawnedVm | undefined
    let childStartTicks: number | undefined
    try {
      const dir = await createInstanceDir(request.instanceId)
      const runRootfs = path.join(dir, 'rootfs.ext4')
      await copyRootfs(image.rootfs, runRootfs)
      await chmod(runRootfs, 0o600)

      let storage: StorageLayout
      if (config.mode === 'jailer') {
        const jail = await prepareJail(request.instanceId, image, runRootfs)
        storage = {
          instanceDir: dir,
          apiSocketHostPath: jail.apiSocketHostPath,
          kernelApiPath: jail.kernelApiPath,
          rootfsApiPath: jail.rootfsApiPath,
          ...(jail.initrdApiPath === undefined
            ? {}
            : { initrdApiPath: jail.initrdApiPath }),
        }
      } else {
        storage = {
          instanceDir: dir,
          apiSocketHostPath: path.join(dir, 'api.sock'),
          kernelApiPath: image.vmlinux,
          rootfsApiPath: runRootfs,
          ...(image.initrd === undefined
            ? {}
            : { initrdApiPath: image.initrd }),
        }
      }

      const argv = buildSpawnArgv(
        request.instanceId,
        storage.apiSocketHostPath,
        request.diskMiB
      )
      child = spawn(argv, { cwd: dir })
      childStartTicks = await readStartTicks(child.pid)

      const directTrust =
        config.mode === 'direct'
          ? await currentTrust(request.instanceId)
          : undefined
      if (config.mode === 'direct' && directTrust === undefined) {
        throw new Error('firecracker binary is not available for direct mode')
      }

      let firecrackerPid = child.pid
      let pidStartTicks: number
      if (config.mode === 'jailer') {
        const verified = await waitForJailerChildPid(child, request.instanceId)
        firecrackerPid = verified.pid
        pidStartTicks = verified.startTicks
      } else {
        pidStartTicks = await waitForVerifiedProcess(
          firecrackerPid,
          directTrust as InstanceTrust
        )
      }
      const trust = directTrust ?? (await currentTrust(request.instanceId))
      if (trust === undefined) {
        throw new Error('trusted firecracker executable is unavailable')
      }
      const handle: IdentifiedVmHandle = {
        instanceId: request.instanceId,
        pid: firecrackerPid,
        pidStartTicks,
        apiSocket: storage.apiSocketHostPath,
        dir: dirForHandle(request.instanceId),
        exeDev: trust.exe.dev,
        exeIno: trust.exe.ino,
        exePath: trust.exePath,
        uid: trust.uid,
        ...(trust.jailRoot === undefined ? {} : { jailRoot: trust.jailRoot }),
      }
      await persistIdentity(handle)

      await waitForApiSocket(
        firecrackerPid,
        pidStartTicks,
        storage.apiSocketHostPath,
        trustExpectation(trust)
      )
      await configureAndStart(handle, request, storage)
      return handle
    } catch (err) {
      logger.error(
        {
          instanceId: request.instanceId,
          op: 'vm.launch',
          ...errorFields(err),
        },
        'VM launch failed; rolling back'
      )
      if (child !== undefined) await killChild(child, childStartTicks)
      // In jailer mode Firecracker is a child of a (usually already exited)
      // jailer, and the pid file may be missing entirely. Scan for every
      // strictly-identified process (post-exec Firecracker or pre-exec jailer
      // child) instead of trusting the tracked pid.
      const terminated = await terminateInstanceProcesses(request.instanceId)
      if (!terminated) {
        // Keep the storage: `listInstanceIds` still reports it, so the
        // manager/reconciler can retry cleanup later.
        logger.error(
          {
            instanceId: request.instanceId,
            op: 'vm.launchRollback',
            error: 'ProcessSurvived',
          },
          'VM launch rollback could not confirm process exit; keeping storage for later cleanup'
        )
        throw err
      }
      try {
        await removeInstanceStorage(request.instanceId)
        await removeCgroups(request.instanceId)
      } catch (cleanupErr) {
        logger.error(
          {
            instanceId: request.instanceId,
            op: 'vm.launchRollback',
            ...errorFields(cleanupErr),
          },
          'VM launch rollback failed'
        )
      }
      throw err
    }
  }

  const scanInstanceDirs = async (
    base: string,
    ids: Set<string>
  ): Promise<void> => {
    let entries
    try {
      entries = await readdir(base, { withFileTypes: true })
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === 'ENOENT') return
      throw err
    }
    for (const entry of entries) {
      if (
        entry.isDirectory() &&
        !entry.isSymbolicLink() &&
        INSTANCE_ID_REGEX.test(entry.name)
      ) {
        ids.add(entry.name)
      }
    }
  }

  const scanCgroupInstanceDirs = async (ids: Set<string>): Promise<void> => {
    await scanInstanceDirs(cgroupRootAbs, ids)
    let entries
    try {
      entries = await readdir(cgroupRootAbs, { withFileTypes: true })
    } catch {
      return
    }
    for (const entry of entries) {
      if (!entry.isDirectory() || entry.isSymbolicLink()) continue
      await scanInstanceDirs(path.join(cgroupRootAbs, entry.name), ids)
    }
    for (const parent of cgroupParents()) {
      const base = path.join(cgroupRootAbs, parent)
      if (isPathInside(cgroupRootAbs, base)) await scanInstanceDirs(base, ids)
    }
  }

  const listInstanceIds = async (): Promise<string[]> => {
    const ids = new Set<string>()
    await scanInstanceDirs(runDirAbs, ids)
    // Jail-only leftovers and jails created under a previous binary name.
    for (const parent of await listJailParentDirs()) {
      await scanInstanceDirs(parent, ids)
    }
    await scanCgroupInstanceDirs(ids)

    // Running processes are only listed when their executable authenticates
    // against a persisted marker, a jail copy, or the current binary.
    const trustCache = new Map<string, Promise<InstanceTrust[]>>()
    for (const pid of await listPids()) {
      const snapshot = await readProcSnapshot(pid)
      if (snapshot === undefined) continue
      const instanceId = instanceIdFromArgv(snapshot.argv)
      if (instanceId === undefined) continue
      let trusts = trustCache.get(instanceId)
      if (trusts === undefined) {
        trusts = trustsForInstance(instanceId)
        trustCache.set(instanceId, trusts)
      }
      for (const trust of await trusts) {
        if (
          (await inspectProcess(pid, trustExpectation(trust))) !== undefined
        ) {
          ids.add(instanceId)
          break
        }
      }
    }
    return [...ids].sort()
  }

  const adopt = async (instanceId: string): Promise<VmHandle | undefined> => {
    assertInstanceId(instanceId)
    const persisted = await persistedIdentity(instanceId)
    const trusts =
      persisted === undefined
        ? await trustsForInstance(instanceId)
        : [
            {
              instanceId,
              exe: persisted.exe,
              exePath: persisted.exePath,
              uid: persisted.uid,
              ...(persisted.jailRoot === undefined
                ? {}
                : { jailRoot: persisted.jailRoot }),
            } satisfies InstanceTrust,
            ...(await trustsForInstance(instanceId)),
          ]
    const seen = new Set<string>()
    for (const trust of trusts) {
      const key = `${trust.exe.dev}:${trust.exe.ino}:${trust.jailRoot ?? ''}`
      if (seen.has(key)) continue
      seen.add(key)
      const processes = await findInstanceProcesses(trustExpectation(trust))
      for (const proc of processes) {
        const persistedPaths =
          persisted !== undefined &&
          persisted.exe.dev === trust.exe.dev &&
          persisted.exe.ino === trust.exe.ino
            ? {
                apiSocket: persisted.apiSocket,
                dir: persisted.dir,
              }
            : trust.jailRoot !== undefined
              ? {
                  apiSocket: path.join(trust.jailRoot, 'api.sock'),
                  dir: path.dirname(trust.jailRoot),
                }
              : {
                  apiSocket: expectedApiSocket(instanceId),
                  dir: dirForHandle(instanceId),
                }
        const handle: IdentifiedVmHandle = {
          instanceId,
          pid: proc.pid,
          pidStartTicks: proc.startTicks,
          apiSocket: persistedPaths.apiSocket,
          dir: persistedPaths.dir,
          exeDev: trust.exe.dev,
          exeIno: trust.exe.ino,
          exePath: trust.exePath,
          uid: trust.uid,
          ...(trust.jailRoot === undefined ? {} : { jailRoot: trust.jailRoot }),
        }
        return handle
      }
    }
    return undefined
  }

  const canAccess = async (target: string, mode: number): Promise<boolean> => {
    try {
      await access(target, mode)
      return true
    } catch {
      return false
    }
  }

  const isExecutable = async (target: string): Promise<boolean> => {
    try {
      const st = await stat(target)
      if (!st.isFile()) return false
      await access(target, fsConstants.X_OK)
      return true
    } catch {
      return false
    }
  }

  const isDirectoryReadable = async (target: string): Promise<boolean> => {
    try {
      const st = await stat(target)
      if (!st.isDirectory()) return false
      await access(target, fsConstants.R_OK | fsConstants.X_OK)
      return true
    } catch {
      return false
    }
  }

  const isDirectoryAccessible = async (target: string): Promise<boolean> => {
    try {
      const st = await stat(target)
      if (!st.isDirectory()) return false
      await access(
        target,
        fsConstants.R_OK | fsConstants.W_OK | fsConstants.X_OK
      )
      return true
    } catch {
      return false
    }
  }

  const probeReflink = async (): Promise<boolean> => {
    const suffix = `${process.pid}-${Date.now()}`
    const src = path.join(runDirAbs, `.reflink-probe-${suffix}`)
    const dst = `${src}.copy`
    try {
      await writeFile(src, 'rctf-reflink-probe')
      await copyFile(src, dst, fsConstants.COPYFILE_FICLONE_FORCE)
      return true
    } catch {
      return false
    } finally {
      await rm(src, { force: true }).catch(() => undefined)
      await rm(dst, { force: true }).catch(() => undefined)
    }
  }

  const preflight = async (): Promise<PreflightResult> => {
    let kvm = false
    try {
      const st = await stat('/dev/kvm')
      kvm =
        st.isCharacterDevice() &&
        (await canAccess('/dev/kvm', fsConstants.R_OK | fsConstants.W_OK))
    } catch {
      kvm = false
    }

    const checks: Record<string, boolean> = {
      kvm,
      firecrackerBin: await isExecutable(firecrackerBinAbs),
      jailerBin:
        config.mode === 'jailer' ? await isExecutable(jailerBinAbs) : true,
      imagesDir: await isDirectoryReadable(config.imagesDir),
      imagesTrusted: await checkImagesTrusted(config),
      runDir: await isDirectoryAccessible(runDirAbs),
      // Jailer discovers its cgroup-v2 hierarchy from /proc/mounts; if the
      // configured root is not a cgroup2 mount, jailer would create dirs on
      // the wrong filesystem (or fail). Report it instead of guessing. The
      // directory must exist and be writable (per-instance cgroups are
      // created below it). Direct mode never uses cgroups, so it is not
      // required there (like chrootBase).
      cgroupRoot: config.mode === 'jailer' ? await cgroupRootIsUsable() : true,
      chrootBase:
        config.mode === 'jailer'
          ? await canAccess(chrootBaseAbs, fsConstants.W_OK | fsConstants.X_OK)
          : true,
      reflink: await probeReflink(),
      // A unix socket path must fit in sockaddr_un.sun_path (108 bytes incl.
      // NUL). Firecracker exits immediately ("path must be shorter than
      // SUN_LEN") for a deeper runDir/chrootBase, and the agent can only report
      // "exited before creating its API socket", so catch it up front using
      // the longest possible instance id.
      apiSocketPath:
        Buffer.byteLength(expectedApiSocket('x'.repeat(32))) <=
        MAX_UNIX_SOCKET_PATH,
    }

    let images: string[] = []
    try {
      images = await listImageNames(config)
    } catch {
      checks.imagesDir = false
    }

    return { checks, images }
  }

  return {
    launch,
    isAlive,
    waitReady,
    stop,
    destroy,
    listInstanceIds,
    adopt,
    preflight,
  }
}
