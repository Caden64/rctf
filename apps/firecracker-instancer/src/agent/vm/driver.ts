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
  readdir,
  readFile,
  rm,
  rmdir,
  stat,
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
  findInstanceProcesses,
  inspectProcess,
  listProcessInstanceIds,
  processMatchesIdentity,
  readStartTicks,
} from './proc'

const MIB = 1024 * 1024
const MAC_REGEX = /^[0-9a-f]{2}(:[0-9a-f]{2}){5}$/i
const TAP_NAME_REGEX = /^[A-Za-z0-9_.-]{1,15}$/

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

export const createVmDriver = (
  config: VmConfig,
  deps: VmDeps = {}
): VmDriver => {
  const runner = deps.runner ?? bunCommandRunner
  const logger = deps.logger ?? createLogger('firecracker-vm')
  const spawn = deps.spawn ?? defaultSpawn
  const now = deps.now ?? Date.now
  const sleep = deps.sleep ?? delay

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
   * (canonical executable + `--id <id>`) before we track it.
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
        const identity = await inspectProcess(
          pid,
          firecrackerExeNames,
          instanceId
        )
        if (identity !== undefined) {
          return { pid: identity.pid, startTicks: identity.startTicks }
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
   * Wait until the spawned process is verifiably our Firecracker (canonical
   * executable basename + adjacent `--id <id>`), returning the start ticks
   * captured by that same scan.
   */
  const waitForVerifiedProcess = async (
    pid: number,
    instanceId: string,
    timeoutMs = config.apiStartTimeoutMs
  ): Promise<number> => {
    const deadline = now() + timeoutMs
    for (;;) {
      const identity = await inspectProcess(
        pid,
        firecrackerExeNames,
        instanceId
      )
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
    instanceId: string
  ): Promise<void> => {
    const deadline = now() + config.apiStartTimeoutMs
    let backoff = 10
    for (;;) {
      if (
        !(await processMatchesIdentity(
          pid,
          pidStartTicks,
          firecrackerExeNames,
          instanceId
        ))
      ) {
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
    const expected = expectedApiSocket(handle.instanceId)
    if (handle.apiSocket !== expected) return
    await rm(expected, { force: true })
  }

  const removeJailTree = async (instanceId: string): Promise<void> => {
    const parent = jailParent()
    let st
    try {
      st = await lstat(parent)
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === 'ENOENT') return
      throw err
    }
    if (st.isSymbolicLink() || !st.isDirectory()) {
      throw new VmValidationError(
        `refusing to clean up through non-directory jail parent: ${parent}`
      )
    }
    await removeInstanceTree(parent, instanceId)
  }

  const removeInstanceStorage = async (instanceId: string): Promise<void> => {
    await removeInstanceTree(runDirAbs, instanceId)
    await removeJailTree(instanceId)
  }

  const cgroupParents = (): string[] => [
    ...new Set([config.parentCgroup ?? firecrackerBase, firecrackerBase]),
  ]

  const cgroupCandidates = (instanceId: string): string[] => {
    const candidates = [
      path.join(cgroupRootAbs, instanceId),
      ...cgroupParents().map(parent =>
        path.join(cgroupRootAbs, parent, instanceId)
      ),
    ]
    return [...new Set(candidates)].filter(candidate =>
      isPathInside(cgroupRootAbs, candidate)
    )
  }

  const removeCgroups = async (instanceId: string): Promise<void> => {
    for (const candidate of cgroupCandidates(instanceId)) {
      try {
        await rmdir(candidate)
      } catch (err) {
        const code = (err as NodeJS.ErrnoException).code
        if (code !== 'ENOENT' && code !== 'ENOTEMPTY' && code !== 'EBUSY') {
          logger.debug({ candidate, err: String(err) }, 'cgroup cleanup failed')
        }
      }
    }
  }

  const isAlive = async (handle: VmHandle): Promise<boolean> => {
    for (let attempt = 0; attempt < 3; attempt += 1) {
      const identity = await inspectProcess(
        handle.pid,
        firecrackerExeNames,
        handle.instanceId
      )
      if (identity !== undefined) {
        return identity.startTicks === handle.pidStartTicks
      }
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
        { instanceId: handle.instanceId, err: String(err) },
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

  /** Kill every strictly-identified process for this instance; true when all are gone. */
  const terminateInstanceProcesses = async (
    instanceId: string
  ): Promise<boolean> => {
    const processes = await findInstanceProcesses(
      instanceId,
      firecrackerExeNames
    )
    for (const proc of processes) {
      // Only signal a pid that still passes the strict check (ticks included).
      if (
        !(await processMatchesIdentity(
          proc.pid,
          proc.startTicks,
          firecrackerExeNames,
          instanceId
        ))
      ) {
        continue
      }
      try {
        process.kill(proc.pid, 'SIGKILL')
      } catch (err) {
        if ((err as NodeJS.ErrnoException).code !== 'ESRCH') throw err
      }
    }
    const deadline = now() + config.killWaitMs
    for (;;) {
      if (
        (await findInstanceProcesses(instanceId, firecrackerExeNames))
          .length === 0
      ) {
        return true
      }
      if (now() >= deadline) return false
      await sleep(50)
    }
  }

  const destroy = async (instanceId: string): Promise<void> => {
    assertInstanceId(instanceId)
    if (!(await terminateInstanceProcesses(instanceId))) {
      throw new Error(`firecracker for ${instanceId} survived SIGKILL`)
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
    // touch a live process that actually belongs to this instance.
    if (
      (await findInstanceProcesses(request.instanceId, firecrackerExeNames))
        .length > 0
    ) {
      throw new VmValidationError(
        `instance ${request.instanceId} already has a live firecracker process`
      )
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

      let firecrackerPid = child.pid
      let pidStartTicks: number
      if (config.mode === 'jailer') {
        const verified = await waitForJailerChildPid(child, request.instanceId)
        firecrackerPid = verified.pid
        pidStartTicks = verified.startTicks
      } else {
        pidStartTicks = await waitForVerifiedProcess(
          firecrackerPid,
          request.instanceId
        )
      }
      const handle: VmHandle = {
        instanceId: request.instanceId,
        pid: firecrackerPid,
        pidStartTicks,
        apiSocket: storage.apiSocketHostPath,
        dir: dirForHandle(request.instanceId),
      }

      await waitForApiSocket(
        firecrackerPid,
        pidStartTicks,
        storage.apiSocketHostPath,
        request.instanceId
      )
      await configureAndStart(handle, request, storage)
      return handle
    } catch (err) {
      logger.error(
        {
          instanceId: request.instanceId,
          err: err instanceof Error ? err.message : String(err),
        },
        'VM launch failed; rolling back'
      )
      if (child !== undefined) await killChild(child, childStartTicks)
      // In jailer mode Firecracker is a child of a (usually already exited)
      // jailer, and the pid file may be missing entirely. Scan for every
      // strictly-identified process instead of trusting the tracked pid.
      const terminated = await terminateInstanceProcesses(request.instanceId)
      if (!terminated) {
        // Keep the storage: `listInstanceIds` still reports it, so the
        // manager/reconciler can retry cleanup later.
        logger.error(
          { instanceId: request.instanceId },
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
            err:
              cleanupErr instanceof Error
                ? cleanupErr.message
                : String(cleanupErr),
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

  const listInstanceIds = async (): Promise<string[]> => {
    const ids = new Set<string>(
      await listProcessInstanceIds(firecrackerExeNames)
    )
    await scanInstanceDirs(runDirAbs, ids)
    // Jail-only leftovers (e.g. Firecracker died but the chroot remained).
    await scanInstanceDirs(jailParent(), ids)
    // cgroup leftovers: direct children plus the default/parent locations.
    const cgroupBases = new Set([
      cgroupRootAbs,
      path.join(cgroupRootAbs, firecrackerBase),
      ...cgroupParents().map(parent => path.join(cgroupRootAbs, parent)),
    ])
    for (const base of cgroupBases) {
      if (!isPathInside(cgroupRootAbs, base)) continue
      await scanInstanceDirs(base, ids)
    }
    return [...ids].sort()
  }

  const adopt = async (instanceId: string): Promise<VmHandle | undefined> => {
    assertInstanceId(instanceId)
    const processes = await findInstanceProcesses(
      instanceId,
      firecrackerExeNames
    )
    for (const proc of processes) {
      const handle: VmHandle = {
        instanceId,
        pid: proc.pid,
        pidStartTicks: proc.startTicks,
        apiSocket: expectedApiSocket(instanceId),
        dir: dirForHandle(instanceId),
      }
      if (await isAlive(handle)) return handle
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
      imagesDir: await isDirectoryAccessible(config.imagesDir),
      imagesTrusted: await checkImagesTrusted(config),
      runDir: await isDirectoryAccessible(runDirAbs),
      chrootBase:
        config.mode === 'jailer'
          ? await canAccess(chrootBaseAbs, fsConstants.W_OK | fsConstants.X_OK)
          : true,
      reflink: await probeReflink(),
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
