import { createHash } from 'node:crypto'
import {
  access,
  chmod,
  constants as fsConstants,
  mkdir,
  readdir,
  readFile,
  realpath,
  rename,
  rm,
  symlink,
  writeFile,
} from 'node:fs/promises'
import { createServer } from 'node:net'
import os from 'node:os'
import path from 'node:path'
import type {
  CommandRunner,
  NetLease,
  VmHandle,
  VmLaunchRequest,
} from '../../src/interfaces'
import type { Logger } from '../../src/log'
import { bunCommandRunner } from '../../src/util/exec'
import { vmConfigSchema, type VmConfig } from '../../src/agent/vm/config'
import type { VmSpawn } from '../../src/agent/vm/driver'
import { readStartTicks } from '../../src/agent/vm/proc'

export const FAKE_SCRIPT = path.join(import.meta.dir, 'fake-firecracker.ts')

export const shQuote = (value: string): string =>
  `'${value.replaceAll("'", "'\\''")}'`

/**
 * Compile the fake once per content hash. `/proc/<pid>/exe` must have the
 * canonical binary basename, which a `#!/bin/sh` wrapper cannot provide (the
 * kernel reports the interpreter instead), so tests run a real native binary.
 */
let compiledFakePromise: Promise<string> | undefined

export const compiledFakeFirecracker = (): Promise<string> => {
  if (compiledFakePromise !== undefined) return compiledFakePromise
  compiledFakePromise = (async () => {
    const source = await readFile(FAKE_SCRIPT)
    const hash = createHash('sha256')
      .update(source)
      .update(process.versions.bun ?? 'bun')
      .digest('hex')
      .slice(0, 16)
    const dir = path.join(os.tmpdir(), 'rctf-fake-firecracker', hash)
    const binary = path.join(dir, 'firecracker-v1.2.3')
    try {
      await access(binary, fsConstants.X_OK)
      return binary
    } catch {
      // build it
    }
    await mkdir(dir, { recursive: true, mode: 0o700 })
    const staging = `${binary}.${process.pid}.${Date.now()}.tmp`
    const proc = Bun.spawn(
      [
        process.execPath,
        'build',
        '--compile',
        FAKE_SCRIPT,
        '--outfile',
        staging,
      ],
      { stdout: 'ignore', stderr: 'pipe', env: process.env }
    )
    const code = await proc.exited
    if (code !== 0) {
      const stderr = await new Response(proc.stderr).text()
      await rm(staging, { force: true }).catch(() => undefined)
      throw new Error(
        `could not compile fake firecracker (exit ${code}): ${stderr.slice(0, 512)}`
      )
    }
    await chmod(staging, 0o755)
    await rename(staging, binary)
    return binary
  })()
  return compiledFakePromise
}

/** Write `<root>/bin/firecracker` as a symlink to the canonical compiled fake. */
export const ensureFakeFirecracker = async (root: string): Promise<string> => {
  const binDir = path.join(root, 'bin')
  await mkdir(binDir, { recursive: true, mode: 0o700 })
  const wrapper = path.join(binDir, 'firecracker')
  const binary = await compiledFakeFirecracker()
  await rm(wrapper, { force: true })
  await symlink(binary, wrapper)
  return wrapper
}

/** Canonical executable basename the driver resolves for this config. */
export const canonicalFirecrackerBasename = async (
  firecrackerBin: string
): Promise<string> => path.basename(await realpath(firecrackerBin))

export const exeNamesFor = async (
  firecrackerBin: string
): Promise<ReadonlySet<string>> =>
  new Set([await canonicalFirecrackerBasename(firecrackerBin)])

export interface RecordedRunner {
  runner: CommandRunner
  calls: string[][]
}

export const makeRunner = (
  opts: {
    failOn?: (argv: readonly string[]) => boolean
  } = {}
): RecordedRunner => {
  const calls: string[][] = []
  const runner: CommandRunner = {
    async run(argv, runOpts) {
      calls.push([...argv])
      if (opts.failOn?.(argv)) {
        return { code: 1, stdout: '', stderr: 'injected failure' }
      }
      return bunCommandRunner.run(argv, runOpts)
    },
  }
  return { runner, calls }
}

export interface LogLine {
  level: string
  args: unknown[]
}

export interface RecordingLogger {
  logger: Logger
  lines: LogLine[]
  text: () => string
}

export const makeLogger = (): RecordingLogger => {
  const lines: LogLine[] = []
  const record =
    (level: string) =>
    (...args: unknown[]): void => {
      lines.push({ level, args })
    }
  const logger = {
    trace: record('trace'),
    debug: record('debug'),
    info: record('info'),
    warn: record('warn'),
    error: record('error'),
    fatal: record('fatal'),
  } as unknown as Logger
  return {
    logger,
    lines,
    text: () => lines.map(line => JSON.stringify(line)).join('\n'),
  }
}

/** Spawns the (fake) binary with the test process environment, detached like the real driver. */
export const spawnWithEnv: VmSpawn = (argv, opts) => {
  const proc = Bun.spawn([...argv], {
    cwd: opts.cwd,
    detached: true,
    stdin: 'ignore',
    stdout: 'ignore',
    stderr: 'ignore',
    env: process.env,
  })
  return {
    pid: proc.pid,
    kill: signal => proc.kill(signal),
    exited: proc.exited,
  }
}

export interface DirSet {
  root: string
  imagesDir: string
  runDir: string
  chrootBase: string
  cgroupRoot: string
  logsDir: string
}

export const makeDirs = async (root: string): Promise<DirSet> => {
  const dirs: DirSet = {
    root,
    imagesDir: path.join(root, 'images'),
    runDir: path.join(root, 'run'),
    chrootBase: path.join(root, 'jail'),
    cgroupRoot: path.join(root, 'cgroup'),
    logsDir: path.join(root, 'logs'),
  }
  for (const dir of [
    dirs.imagesDir,
    dirs.runDir,
    dirs.chrootBase,
    dirs.cgroupRoot,
    dirs.logsDir,
  ]) {
    await mkdir(dir, { recursive: true, mode: 0o700 })
    await chmod(dir, 0o700)
  }
  return dirs
}

export interface MakeConfigOptions {
  dirs: DirSet
  overrides?: Partial<VmConfig>
}

export const makeVmConfig = async (
  options: MakeConfigOptions
): Promise<VmConfig> => {
  const { dirs, overrides = {} } = options
  const roots: Record<string, unknown> = {
    imagesDir: dirs.imagesDir,
    runDir: dirs.runDir,
    chrootBase: dirs.chrootBase,
    cgroupRoot: dirs.cgroupRoot,
    mode: 'direct',
    apiStartTimeoutMs: 2000,
    apiTimeoutMs: 2000,
    killWaitMs: 3000,
    readinessIntervalMs: 50,
    ...overrides,
  }
  if (roots.firecrackerBin === undefined) {
    roots.firecrackerBin = await ensureFakeFirecracker(dirs.root)
  }
  return vmConfigSchema.parse(roots)
}

export const makeImage = async (
  imagesDir: string,
  name: string,
  opts: { rootfsBytes?: number; initrd?: boolean } = {}
): Promise<string> => {
  const dir = path.join(imagesDir, name)
  await mkdir(dir, { recursive: true, mode: 0o700 })
  await chmod(dir, 0o700)
  await writeFile(path.join(dir, 'vmlinux'), 'fake vmlinux\n', { mode: 0o444 })
  await writeFile(
    path.join(dir, 'rootfs.ext4'),
    Buffer.alloc(opts.rootfsBytes ?? 8192),
    { mode: 0o400 }
  )
  if (opts.initrd) {
    await writeFile(path.join(dir, 'initrd'), 'fake initrd\n', { mode: 0o400 })
  }
  return dir
}

export const makeLease = (instanceId: string): NetLease => ({
  instanceId,
  tapName: 'fctap1234',
  hostIp: '10.200.0.1',
  guestIp: '10.200.0.2',
  prefixLength: 30,
  guestMac: '02:00:00:00:00:01',
  publicPorts: {},
  publicHostnames: {},
  egress: false,
})

export const FLAG_VALUE = 'flag{leak-canary-do-not-log-or-persist}'

export const makeRequest = (
  instanceId: string,
  image: string,
  overrides: Partial<VmLaunchRequest> = {}
): VmLaunchRequest => ({
  instanceId,
  image,
  vcpus: 2,
  memMiB: 256,
  diskMiB: 64,
  kernelArgs: 'init_on_alloc=1',
  lease: makeLease(instanceId),
  metadata: {
    rctf: {
      version: 1,
      instanceId,
      hostname: `${instanceId}.fc1.example.test`,
      env: { CHALLENGE: 'web-demo' },
      flags: [{ provider: 'main', flag: FLAG_VALUE }],
    },
  },
  ...overrides,
})

export interface RecordedRequest {
  method: string
  path: string
  body: string
}

export const readRequests = async (
  logPath: string
): Promise<RecordedRequest[]> => {
  const raw = await readFile(logPath, 'utf8')
  return raw
    .split('\n')
    .filter(line => line.trim().length > 0)
    .map(line => JSON.parse(line) as RecordedRequest)
}

export const readTree = async (
  dir: string
): Promise<{ path: string; contents: Buffer }[]> => {
  const files: { path: string; contents: Buffer }[] = []
  const walk = async (current: string): Promise<void> => {
    let entries
    try {
      entries = await readdir(current, { withFileTypes: true })
    } catch {
      return
    }
    for (const entry of entries) {
      const target = path.join(current, entry.name)
      if (entry.isDirectory()) {
        await walk(target)
      } else if (entry.isFile()) {
        files.push({ path: target, contents: await readFile(target) })
      }
    }
  }
  await walk(dir)
  return files
}

export const findFreePort = (): Promise<number> =>
  new Promise((resolve, reject) => {
    const server = createServer()
    server.listen(0, '127.0.0.1', () => {
      const address = server.address()
      if (address === null || typeof address === 'string') {
        server.close()
        reject(new Error('could not allocate a port'))
        return
      }
      const { port } = address
      server.close(() => resolve(port))
    })
    server.once('error', reject)
  })

export const waitForTicks = async (
  pid: number,
  timeoutMs = 2000
): Promise<number> => {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    const ticks = await readStartTicks(pid)
    if (ticks !== undefined) return ticks
    await new Promise(resolve => setTimeout(resolve, 10))
  }
  throw new Error(`timed out waiting for /proc/${pid}/stat`)
}

export interface LiveFake {
  handle: VmHandle
  pid: number
  kill: () => void
}

/** A live fake-firecracker process with a real /proc entry and a working API socket. */
export const startLiveFake = async (
  root: string,
  instanceId: string
): Promise<LiveFake> => {
  const wrapper = await ensureFakeFirecracker(root)
  const dir = path.join(root, 'live', instanceId)
  await mkdir(dir, { recursive: true, mode: 0o700 })
  const apiSocket = path.join(dir, 'api.sock')
  const proc = Bun.spawn(
    [wrapper, '--id', instanceId, '--api-sock', apiSocket],
    {
      detached: true,
      stdin: 'ignore',
      stdout: 'ignore',
      stderr: 'ignore',
      env: process.env,
    }
  )
  const pidStartTicks = await waitForTicks(proc.pid)
  return {
    handle: {
      instanceId,
      pid: proc.pid,
      pidStartTicks,
      apiSocket,
      dir,
    },
    pid: proc.pid,
    kill: () => proc.kill('SIGKILL'),
  }
}

export const fakeEnvKey = (instanceId: string, name: string): string =>
  `FAKE_FC_${instanceId}_${name}`

export const setFakeEnv = (
  instanceId: string,
  values: Record<string, string>
): void => {
  for (const [name, value] of Object.entries(values)) {
    process.env[fakeEnvKey(instanceId, name)] = value
  }
}

export const clearFakeEnv = (instanceId: string): void => {
  for (const key of Object.keys(process.env)) {
    if (key.startsWith(`FAKE_FC_${instanceId}_`)) delete process.env[key]
  }
}

export const newInstanceId = (): string => {
  const chars = 'abcdefghijklmnopqrstuvwxyz0123456789'
  let id = 'vm'
  for (let i = 0; i < 20; i++) {
    id += chars[Math.floor(Math.random() * chars.length)]
  }
  return id
}
