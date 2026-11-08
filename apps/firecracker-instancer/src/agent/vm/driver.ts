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
import { KERNEL_ARGS_REGEX } from '@rctf/firecracker-protocol'
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
import { listImageNames, resolveImage } from './images'
import {
  VmValidationError,
  assertInstanceId,
  fileExists,
  isPathInside,
  removeInstanceTree,
} from './paths'
import {
  cmdlineMatchesInstance,
  findInstanceProcesses,
  listProcessInstanceIds,
  processMatches,
  readCmdline,
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

/** Boot contract v1: kernel IP autoconfig on the single virtio NIC. */
export const buildBootArgs = (
  lease: VmLaunchRequest['lease'],
  extra?: string
): string => {
  const base = [
    'console=ttyS0',
    'reboot=k',
    'panic=1',
    'pci=off',
    `ip=${lease.guestIp}::${lease.hostIp}:255.255.255.252::eth0:off`,
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
  const firecrackerBase = path.basename(config.firecrackerBin)

  const jailBase = (instanceId: string): string =>
    path.join(chrootBaseAbs, firecrackerBase, instanceId)
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

  const ensureRunDir = async (): Promise<void> => {
    await mkdir(runDirAbs, { recursive: true, mode: 0o700 })
    const st = await stat(runDirAbs)
    if (!st.isDirectory()) {
      throw new VmValidationError(`runDir is not a directory: ${runDirAbs}`)
    }
  }

  const createInstanceDir = async (instanceId: string): Promise<string> => {
    const dir = instanceDir(instanceId)
    if (!isPathInside(runDirAbs, dir)) {
      throw new VmValidationError(`instance dir escapes runDir: ${dir}`)
    }
    try {
      const st = await lstat(dir)
      if (st.isSymbolicLink()) {
        throw new VmValidationError(
          `refusing to reuse symlinked instance dir: ${dir}`
        )
      }
      throw new VmValidationError(`instance dir already exists: ${dir}`)
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== 'ENOENT') throw err
    }
    await mkdir(dir, { mode: 0o700 })
    await chmod(dir, 0o700)
    return dir
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
    const root = jailRoot(instanceId)
    await mkdir(root, { recursive: true, mode: 0o700 })
    await chmod(root, 0o700)

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
   * and nothing can be injected. Firecracker args after `--` are minimal: the
   * whole configuration goes over the API socket. Seccomp stays at
   * Firecracker's default level (jailer does not disable it).
   */
  const buildSpawnArgv = (
    instanceId: string,
    apiSocketHostPath: string,
    diskMiB: number
  ): string[] => {
    if (config.mode === 'direct') {
      return [
        config.firecrackerBin,
        '--id',
        instanceId,
        '--api-sock',
        apiSocketHostPath,
      ]
    }
    return [
      config.jailerBin,
      '--id',
      instanceId,
      '--exec-file',
      config.firecrackerBin,
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
      '--id',
      instanceId,
      '--api-sock',
      '/api.sock',
    ]
  }

  const killChild = async (child: SpawnedVm): Promise<void> => {
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
   * `<jailRoot>/<firecracker basename>.pid` (jailer docs/source).
   */
  const waitForJailerChildPid = async (
    child: SpawnedVm,
    instanceId: string
  ): Promise<number> => {
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
    const deadline = now() + config.apiStartTimeoutMs
    while (now() < deadline) {
      try {
        const raw = await readFile(pidFile, 'utf8')
        const pid = Number(raw.trim())
        if (Number.isSafeInteger(pid) && pid > 0) return pid
      } catch {
        // not written yet
      }
      if (exitCode !== undefined) {
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

  const captureStartTicks = async (pid: number): Promise<number> => {
    const deadline = now() + 2000
    while (now() < deadline) {
      const ticks = await readStartTicks(pid)
      if (ticks !== undefined) return ticks
      await sleep(10)
    }
    throw new Error(`timed out reading /proc/${pid}/stat`)
  }

  const waitForApiSocket = async (
    pid: number,
    apiSocketHostPath: string
  ): Promise<void> => {
    const deadline = now() + config.apiStartTimeoutMs
    while (now() < deadline) {
      if (await fileExists(apiSocketHostPath)) return
      if ((await readStartTicks(pid)) === undefined) {
        throw new Error(
          `firecracker (pid ${pid}) exited before creating its API socket`
        )
      }
      await sleep(50)
    }
    throw new Error(
      `timed out after ${config.apiStartTimeoutMs}ms waiting for the firecracker API socket`
    )
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
      boot_args: buildBootArgs(request.lease, request.kernelArgs),
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

  const removeInstanceStorage = async (instanceId: string): Promise<void> => {
    await removeInstanceTree(runDirAbs, instanceId)
    await removeInstanceTree(
      path.join(chrootBaseAbs, firecrackerBase),
      instanceId
    )
  }

  const removeCgroups = async (instanceId: string): Promise<void> => {
    const parents = new Set([
      config.parentCgroup ?? firecrackerBase,
      firecrackerBase,
    ])
    const candidates = [
      path.join(cgroupRootAbs, instanceId),
      ...[...parents].map(parent =>
        path.join(cgroupRootAbs, parent, instanceId)
      ),
    ]
    for (const candidate of candidates) {
      if (!isPathInside(cgroupRootAbs, candidate)) continue
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
    if (!(await processMatches(handle.pid, handle.pidStartTicks))) return false
    // A process that is mid-exec (jailer -> firecracker, or a test wrapper)
    // briefly exposes an empty cmdline. Retry a few times before calling it
    // dead; pid + start ticks already prove this is the process we captured.
    for (let attempt = 0; attempt < 3; attempt += 1) {
      const argv = await readCmdline(handle.pid)
      if (argv !== undefined && argv.length > 0) {
        return cmdlineMatchesInstance(argv, handle.instanceId)
      }
      if (!(await processMatches(handle.pid, handle.pidStartTicks)))
        return false
      await sleep(5)
    }
    return false
  }

  const tcpProbe = (
    host: string,
    port: number,
    timeoutMs: number
  ): Promise<boolean> =>
    new Promise(resolve => {
      let settled = false
      const socket = createConnection({ host, port })
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

  const httpProbe = async (
    host: string,
    port: number,
    pathname: string,
    expectStatus: number,
    timeoutMs: number
  ): Promise<boolean> => {
    try {
      const response = await fetch(`http://${host}:${port}${pathname}`, {
        signal: AbortSignal.timeout(timeoutMs),
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
          ? await tcpProbe(probe.guestIp, readiness.port, attemptTimeout)
          : await httpProbe(
              probe.guestIp,
              readiness.port,
              readiness.path ?? '/',
              readiness.expectStatus ?? 200,
              attemptTimeout
            )
      if (ok) return
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
    if (!(await processMatches(handle.pid, handle.pidStartTicks))) {
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
      if (!(await processMatches(handle.pid, handle.pidStartTicks))) {
        await removeExpectedSocket(handle)
        return
      }
      await sleep(100)
    }

    // Re-verify immediately before signalling: never SIGKILL a recycled pid.
    if (await processMatches(handle.pid, handle.pidStartTicks)) {
      try {
        process.kill(handle.pid, 'SIGKILL')
      } catch (err) {
        if ((err as NodeJS.ErrnoException).code !== 'ESRCH') throw err
      }
    }

    const killDeadline = now() + config.killWaitMs
    while (now() < killDeadline) {
      if (!(await processMatches(handle.pid, handle.pidStartTicks))) break
      await sleep(50)
    }
    if (await processMatches(handle.pid, handle.pidStartTicks)) {
      throw new Error(
        `VM ${handle.instanceId} (pid ${handle.pid}) did not exit after SIGKILL`
      )
    }
    await removeExpectedSocket(handle)
  }

  const destroy = async (instanceId: string): Promise<void> => {
    assertInstanceId(instanceId)
    const processes = await findInstanceProcesses(instanceId)
    for (const proc of processes) {
      if (!(await processMatches(proc.pid, proc.startTicks))) continue
      try {
        process.kill(proc.pid, 'SIGKILL')
      } catch (err) {
        if ((err as NodeJS.ErrnoException).code !== 'ESRCH') throw err
      }
    }
    const deadline = now() + config.killWaitMs
    while (now() < deadline) {
      if ((await findInstanceProcesses(instanceId)).length === 0) break
      await sleep(50)
    }
    if ((await findInstanceProcesses(instanceId)).length > 0) {
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
        'SECURITY: Firecracker is running in direct mode (no jailer, no ' +
          'chroot/cgroups/seccomp isolation). Never use this in production.'
      )
    }
    const image = await resolveImage(config, request.image, request.diskMiB)
    await ensureRunDir()

    let child: SpawnedVm | undefined
    let createdDir = false
    let trackedPid: number | undefined
    let trackedTicks: number | undefined
    try {
      const dir = await createInstanceDir(request.instanceId)
      createdDir = true
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
      let firecrackerPid = child.pid
      if (config.mode === 'jailer') {
        firecrackerPid = await waitForJailerChildPid(child, request.instanceId)
      }
      trackedPid = firecrackerPid
      const pidStartTicks = await captureStartTicks(firecrackerPid)
      trackedTicks = pidStartTicks
      const handle: VmHandle = {
        instanceId: request.instanceId,
        pid: firecrackerPid,
        pidStartTicks,
        apiSocket: storage.apiSocketHostPath,
        dir: dirForHandle(request.instanceId),
      }

      await waitForApiSocket(firecrackerPid, storage.apiSocketHostPath)
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
      if (child !== undefined) await killChild(child)
      // In jailer mode Firecracker is a child of a (usually already exited)
      // jailer, so the spawned pid alone is not enough to roll back.
      if (
        trackedPid !== undefined &&
        (child === undefined || trackedPid !== child.pid)
      ) {
        if (
          trackedTicks === undefined ||
          (await processMatches(trackedPid, trackedTicks))
        ) {
          try {
            process.kill(trackedPid, 'SIGKILL')
          } catch {
            // already gone / not ours anymore
          }
        }
        const killDeadline = now() + config.killWaitMs
        while (
          now() < killDeadline &&
          (await readStartTicks(trackedPid)) !== undefined
        ) {
          await sleep(50)
        }
      }
      if (createdDir) {
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
      }
      throw err
    }
  }

  const listInstanceIds = async (): Promise<string[]> => {
    const ids = new Set<string>(await listProcessInstanceIds())
    try {
      const entries = await readdir(runDirAbs, { withFileTypes: true })
      for (const entry of entries) {
        if (entry.isDirectory() && /^[a-z0-9]{16,32}$/.test(entry.name)) {
          ids.add(entry.name)
        }
      }
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== 'ENOENT') throw err
    }
    return [...ids].sort()
  }

  const adopt = async (instanceId: string): Promise<VmHandle | undefined> => {
    assertInstanceId(instanceId)
    const processes = await findInstanceProcesses(instanceId)
    for (const proc of processes) {
      if (proc.jailer) continue
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
      firecrackerBin: await isExecutable(config.firecrackerBin),
      jailerBin:
        config.mode === 'jailer' ? await isExecutable(config.jailerBin) : true,
      imagesDir: await isDirectoryAccessible(config.imagesDir),
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
