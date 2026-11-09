import { afterEach, describe, expect, test } from 'bun:test'
import pino from 'pino'
import type { Logger } from '../../src/log'
import {
  chmod,
  mkdir,
  mkdtemp,
  readFile,
  realpath,
  rm,
  stat,
  truncate,
  writeFile,
} from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import type { VmHandle } from '../../src/interfaces'
import type { VmConfig } from '../../src/agent/vm/config'
import { createVmDriver } from '../../src/agent/vm'
import type { VmSpawn } from '../../src/agent/vm/driver'
import {
  FLAG_VALUE,
  clearFakeEnv,
  findDirectInstances,
  makeDirs,
  makeImage,
  makeLogger,
  makeRequest,
  makeRunner,
  makeVmConfig,
  newInstanceId,
  readRequests,
  readTree,
  setFakeEnv,
  spawnWithEnv,
} from './helpers'

const API_ORDER = [
  '/boot-source',
  '/drives/rootfs',
  '/network-interfaces/eth0',
  '/machine-config',
  '/mmds/config',
  '/mmds',
  '/actions',
]

interface Harness {
  root: string
  config: VmConfig
  driver: ReturnType<typeof createVmDriver>
  runner: ReturnType<typeof makeRunner>
  logger: ReturnType<typeof makeLogger>
  spawnCalls: string[][]
  dirs: Awaited<ReturnType<typeof makeDirs>>
}

const roots: string[] = []

const harness = async (
  overrides: Partial<VmConfig> = {},
  spawnOverride?: VmSpawn
): Promise<Harness> => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'rctf-vm-launch-'))
  roots.push(root)
  const dirs = await makeDirs(root)
  const config = await makeVmConfig({ dirs, overrides })
  const runner = makeRunner()
  const logger = makeLogger()
  const spawnCalls: string[][] = []
  const spawn: VmSpawn = (argv, opts) => {
    spawnCalls.push([...argv])
    return (spawnOverride ?? spawnWithEnv)(argv, opts)
  }
  const driver = createVmDriver(config, {
    runner: runner.runner,
    logger: logger.logger,
    spawn,
  })
  return { root, config, driver, runner, logger, spawnCalls, dirs }
}

afterEach(async () => {
  while (roots.length > 0) {
    const root = roots.pop()
    if (root !== undefined) await rm(root, { recursive: true, force: true })
  }
})

const teardown = async (
  h: Harness,
  instanceId: string,
  handle?: VmHandle
): Promise<void> => {
  if (handle !== undefined) {
    await h.driver.stop(handle, { graceMs: 100 }).catch(() => undefined)
  }
  await h.driver.destroy(instanceId).catch(() => undefined)
  clearFakeEnv(instanceId)
}

describe('vm launch', () => {
  test('configures the VM over the API in the documented order', async () => {
    const h = await harness()
    const id = newInstanceId()
    await makeImage(h.config.imagesDir, 'web-demo')
    const logPath = path.join(h.dirs.logsDir, `${id}.jsonl`)
    setFakeEnv(id, { LOG: logPath })
    const request = makeRequest(id, 'web-demo')
    let handle: VmHandle | undefined

    try {
      handle = await h.driver.launch(request)
      const requests = await readRequests(logPath)
      expect(requests.map(r => r.path)).toEqual(API_ORDER)
      expect(requests.every(r => r.method === 'PUT')).toBe(true)

      const boot = JSON.parse(requests[0]?.body ?? '{}')
      expect(boot.kernel_image_path).toBe(
        path.join(h.config.imagesDir, 'web-demo', 'vmlinux')
      )
      expect(boot.boot_args).toBe(
        'console=ttyS0 reboot=k panic=1 pci=off ' +
          'ip=10.200.0.2::10.200.0.1:255.255.255.252::eth0:off ' +
          'init=/rctf/init init_on_alloc=1'
      )

      const drive = JSON.parse(requests[1]?.body ?? '{}')
      expect(drive.drive_id).toBe('rootfs')
      expect(drive.path_on_host).toBe(
        path.join(h.config.runDir, id, 'rootfs.ext4')
      )
      expect(drive.is_root_device).toBe(true)
      expect(drive.is_read_only).toBe(false)
      expect(drive.rate_limiter.ops.size).toBe(h.config.diskIops)
      expect(drive.rate_limiter.bandwidth.size).toBe(
        h.config.diskBandwidthMiBps * 1024 * 1024
      )

      const nic = JSON.parse(requests[2]?.body ?? '{}')
      expect(nic).toMatchObject({
        iface_id: 'eth0',
        guest_mac: '02:00:00:00:00:01',
        host_dev_name: 'fctap1234',
      })
      expect(nic.tx_rate_limiter).toBeDefined()
      expect(nic.rx_rate_limiter).toBeDefined()

      expect(JSON.parse(requests[3]?.body ?? '{}')).toEqual({
        vcpu_count: 2,
        mem_size_mib: 256,
        smt: false,
      })
      expect(JSON.parse(requests[4]?.body ?? '{}')).toEqual({
        version: 'V2',
        network_interfaces: ['eth0'],
      })
      expect(JSON.parse(requests[5]?.body ?? '{}')).toEqual(request.metadata)
      expect(JSON.parse(requests[6]?.body ?? '{}')).toEqual({
        action_type: 'InstanceStart',
      })

      expect(handle.pid).toBeGreaterThan(0)
      expect(handle.pidStartTicks).toBeGreaterThan(0)
      expect(await h.driver.isAlive(handle)).toBe(true)

      const rootfsStat = await stat(
        path.join(h.config.runDir, id, 'rootfs.ext4')
      )
      expect(rootfsStat.mode & 0o777).toBe(0o600)
      const dirStat = await stat(path.join(h.config.runDir, id))
      expect(dirStat.mode & 0o777).toBe(0o700)

      const [argv] = h.spawnCalls
      expect(argv).toEqual([
        await realpath(h.config.firecrackerBin),
        '--id',
        id,
        '--api-sock',
        path.join(h.config.runDir, id, 'api.sock'),
      ])

      const cpCall = h.runner.calls.find(call => call[0] === 'cp')
      expect(cpCall).toEqual([
        'cp',
        '--reflink=auto',
        '--sparse=always',
        '--no-preserve=mode,ownership',
        path.join(h.config.imagesDir, 'web-demo', 'rootfs.ext4'),
        path.join(h.config.runDir, id, 'rootfs.ext4'),
      ])
    } finally {
      if (handle !== undefined) await teardown(h, id, handle)
      else await teardown(h, id)
    }
  })

  test('never puts the flag on argv, logs, or any file under runDir', async () => {
    const h = await harness()
    const id = newInstanceId()
    await makeImage(h.config.imagesDir, 'web-demo')
    const logPath = path.join(h.dirs.logsDir, `${id}.jsonl`)
    setFakeEnv(id, { LOG: logPath })
    let handle: VmHandle | undefined

    try {
      handle = await h.driver.launch(makeRequest(id, 'web-demo'))

      const files = [
        ...(await readTree(h.config.runDir)),
        ...(await readTree(h.config.chrootBase)),
      ]
      for (const file of files) {
        expect(file.contents.toString('utf8')).not.toContain(FLAG_VALUE)
      }
      expect(h.runner.calls.flat().join(' ')).not.toContain(FLAG_VALUE)
      expect(h.spawnCalls.flat().join(' ')).not.toContain(FLAG_VALUE)
      expect(h.logger.text()).not.toContain(FLAG_VALUE)
      expect(await readFile(logPath, 'utf8')).toContain(FLAG_VALUE)
    } finally {
      if (handle !== undefined) await teardown(h, id, handle)
      else await teardown(h, id)
    }
  })

  test('leaks no flag through errors, pino logs or files when /mmds echoes its body', async () => {
    const h = await harness()
    const id = newInstanceId()
    await makeImage(h.config.imagesDir, 'web-demo')
    setFakeEnv(id, {
      LOG: path.join(h.dirs.logsDir, `${id}.jsonl`),
      FAIL_PATH: '/mmds',
      FAIL_STATUS: '400',
      ECHO_BODY: '1',
    })
    const chunks: string[] = []
    const logger = pino(
      { level: 'debug' },
      { write: (chunk: string) => chunks.push(chunk) }
    ) as unknown as Logger
    const driver = createVmDriver(h.config, {
      runner: h.runner.runner,
      logger,
      spawn: spawnWithEnv,
    })
    let message = ''
    try {
      await driver.launch(makeRequest(id, 'web-demo'))
    } catch (err) {
      message = err instanceof Error ? err.message : String(err)
    } finally {
      clearFakeEnv(id)
    }
    expect(message).toContain('HTTP 400')
    expect(message).not.toContain(FLAG_VALUE)
    expect(chunks.join('')).not.toContain(FLAG_VALUE)
    for (const file of [
      ...(await readTree(h.config.runDir)),
      ...(await readTree(h.config.chrootBase)),
    ]) {
      expect(file.contents.toString('utf8')).not.toContain(FLAG_VALUE)
    }
    await teardown(h, id)
  })

  test('passes an initrd image to /boot-source', async () => {
    const h = await harness()
    const id = newInstanceId()
    await makeImage(h.config.imagesDir, 'with-initrd', { initrd: true })
    const logPath = path.join(h.dirs.logsDir, `${id}.jsonl`)
    setFakeEnv(id, { LOG: logPath })
    let handle: VmHandle | undefined
    try {
      handle = await h.driver.launch(makeRequest(id, 'with-initrd'))
      const requests = await readRequests(logPath)
      expect(JSON.parse(requests[0]?.body ?? '{}').initrd_path).toBe(
        path.join(h.config.imagesDir, 'with-initrd', 'initrd')
      )
    } finally {
      if (handle !== undefined) await teardown(h, id, handle)
      else await teardown(h, id)
    }
  })

  test('warns loudly in direct mode', async () => {
    const h = await harness({ mode: 'direct' })
    const id = newInstanceId()
    await makeImage(h.config.imagesDir, 'web-demo')
    setFakeEnv(id, { LOG: path.join(h.dirs.logsDir, `${id}.jsonl`) })
    let handle: VmHandle | undefined
    try {
      handle = await h.driver.launch(makeRequest(id, 'web-demo'))
      const warning = h.logger.lines.find(
        line =>
          line.level === 'warn' &&
          JSON.stringify(line.args).includes('direct mode')
      )
      expect(warning).toBeDefined()
      const text = JSON.stringify(warning?.args)
      expect(text).toContain('seccomp')
      expect(text).toContain('remains enabled')
      expect(text).not.toContain('no seccomp')
    } finally {
      if (handle !== undefined) await teardown(h, id, handle)
      else await teardown(h, id)
    }
  })

  for (const failPath of API_ORDER) {
    test(`rolls back completely when ${failPath} fails`, async () => {
      const h = await harness({ apiStartTimeoutMs: 1000 })
      const id = newInstanceId()
      await makeImage(h.config.imagesDir, 'web-demo')
      setFakeEnv(id, {
        LOG: path.join(h.dirs.logsDir, `${id}.jsonl`),
        FAIL_PATH: failPath,
      })
      try {
        await expect(
          h.driver.launch(makeRequest(id, 'web-demo'))
        ).rejects.toThrow(new RegExp(failPath))
        expect(await pathExists(path.join(h.config.runDir, id))).toBe(false)
        expect(await findDirectInstances(h.config, id)).toEqual([])
        expect(await h.driver.listInstanceIds()).not.toContain(id)
      } finally {
        await teardown(h, id)
      }
    })
  }

  test('rolls back when the rootfs copy fails', async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), 'rctf-vm-launch-'))
    roots.push(root)
    const dirs = await makeDirs(root)
    const config = await makeVmConfig({ dirs })
    const runner = makeRunner({ failOn: argv => argv[0] === 'cp' })
    const logger = makeLogger()
    const driver = createVmDriver(config, {
      runner: runner.runner,
      logger: logger.logger,
      spawn: spawnWithEnv,
    })
    const id = newInstanceId()
    await makeImage(config.imagesDir, 'web-demo')
    try {
      await expect(driver.launch(makeRequest(id, 'web-demo'))).rejects.toThrow(
        /copying rootfs failed/
      )
      expect(await pathExists(path.join(config.runDir, id))).toBe(false)
    } finally {
      await teardown(
        { root, config, driver, runner, logger, spawnCalls: [], dirs },
        id
      )
    }
  })

  test('rolls back when the firecracker binary cannot be spawned', async () => {
    const h = await harness({
      firecrackerBin: '/nonexistent/firecracker-missing',
    })
    const id = newInstanceId()
    await makeImage(h.config.imagesDir, 'web-demo')
    try {
      await expect(
        h.driver.launch(makeRequest(id, 'web-demo'))
      ).rejects.toThrow()
      expect(await pathExists(path.join(h.config.runDir, id))).toBe(false)
    } finally {
      await teardown(h, id)
    }
  })

  test('rolls back when the API socket never appears', async () => {
    const h = await harness({ apiStartTimeoutMs: 300 })
    const id = newInstanceId()
    await makeImage(h.config.imagesDir, 'web-demo')
    setFakeEnv(id, { NO_SOCKET: '1' })
    try {
      await expect(
        h.driver.launch(makeRequest(id, 'web-demo'))
      ).rejects.toThrow(/API socket/)
      expect(await pathExists(path.join(h.config.runDir, id))).toBe(false)
      expect(await findDirectInstances(h.config, id)).toEqual([])
    } finally {
      await teardown(h, id)
    }
  })

  test('retries until the API socket is listening', async () => {
    const h = await harness({ apiStartTimeoutMs: 3000 })
    const id = newInstanceId()
    await makeImage(h.config.imagesDir, 'web-demo')
    setFakeEnv(id, {
      LOG: path.join(h.dirs.logsDir, `${id}.jsonl`),
      SOCKET_DELAY_MS: '200',
    })
    let handle: VmHandle | undefined
    try {
      handle = await h.driver.launch(makeRequest(id, 'web-demo'))
      expect(await h.driver.isAlive(handle)).toBe(true)
    } finally {
      if (handle !== undefined) await teardown(h, id, handle)
      else await teardown(h, id)
    }
  })

  test('does not accept a socket file without a listener as ready', async () => {
    const h = await harness({ apiStartTimeoutMs: 500 })
    const id = newInstanceId()
    await makeImage(h.config.imagesDir, 'web-demo')
    setFakeEnv(id, { STALE_SOCKET: '1' })
    try {
      await expect(
        h.driver.launch(makeRequest(id, 'web-demo'))
      ).rejects.toThrow(/API socket/)
      expect(await pathExists(path.join(h.config.runDir, id))).toBe(false)
      expect(await findDirectInstances(h.config, id)).toEqual([])
    } finally {
      await teardown(h, id)
    }
  })

  test('rejects traversal and oversized images before creating anything', async () => {
    const h = await harness()
    const id = newInstanceId()
    await makeImage(h.config.imagesDir, 'web-demo')
    await expect(h.driver.launch(makeRequest(id, '../etc'))).rejects.toThrow(
      /image name/
    )

    const big = path.join(h.config.imagesDir, 'web-demo', 'rootfs.ext4')
    await chmod(big, 0o600)
    await truncate(big, 65 * 1024 * 1024)
    await chmod(big, 0o400)
    await expect(h.driver.launch(makeRequest(id, 'web-demo'))).rejects.toThrow(
      /larger than/
    )
    expect(await pathExists(path.join(h.config.runDir, id))).toBe(false)
    await teardown(h, id)
  })

  test('never logs injected exception messages (flags or JSON-escaped) on launch failure', async () => {
    const h = await harness()
    const id = newInstanceId()
    await makeImage(h.config.imagesDir, 'web-demo')
    const chunks: string[] = []
    const logger = pino(
      { level: 'debug' },
      { write: (chunk: string) => chunks.push(chunk) }
    ) as unknown as Logger
    const escaped = FLAG_VALUE.replace('{', '\\u007b')
    const runner = {
      async run(): Promise<never> {
        throw new Error(
          `copy failed: ${FLAG_VALUE} ${JSON.stringify(FLAG_VALUE)} ${escaped}`
        )
      },
    }
    const driver = createVmDriver(h.config, {
      runner,
      logger,
      spawn: spawnWithEnv,
    })
    let thrown = ''
    try {
      await driver.launch(makeRequest(id, 'web-demo'))
    } catch (err) {
      thrown = err instanceof Error ? err.message : String(err)
    }
    const logged = chunks.join('')
    expect(thrown).toContain(FLAG_VALUE)
    expect(logged).not.toContain(FLAG_VALUE)
    expect(logged).not.toContain(escaped)
    expect(logged).not.toContain('copy failed')
    expect(logged).toContain('vm.launch')
    expect(logged).toContain('Error')
    await teardown(h, id)
  })

  test('rejects a malformed instance id before spawning', async () => {
    const h = await harness()
    await makeImage(h.config.imagesDir, 'web-demo')
    const id = 'bad; rm -rf /'
    await expect(h.driver.launch(makeRequest(id, 'web-demo'))).rejects.toThrow(
      /instance id/
    )
    expect(h.spawnCalls).toEqual([])
  })
})

describe('jailer canonical layout', () => {
  test('uses the resolved binary basename for exec-file, jail layout, adopt and cleanup', async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), 'rctf-vm-jail-'))
    roots.push(root)
    const dirs = await makeDirs(root)
    const jailerBin = path.join(root, 'bin', 'jailer')
    await mkdir(path.dirname(jailerBin), { recursive: true, mode: 0o700 })
    await writeFile(
      jailerBin,
      `#!/bin/sh
set -eu
id=
exec_file=
base=
while [ $# -gt 0 ]; do
  case $1 in
    --id) id=$2; shift 2 ;;
    --exec-file) exec_file=$2; shift 2 ;;
    --chroot-base-dir) base=$2; shift 2 ;;
    *) shift ;;
  esac
done
b=$(basename "$exec_file")
dir=$base/$b/$id/root
mkdir -p "$dir"
cp "$exec_file" "$dir/$b"
chmod 0755 "$dir/$b"
"$dir/$b" --id "$id" --api-sock "$dir/api.sock" </dev/null >/dev/null 2>&1 &
printf '%s\\n' "$!" > "$dir/$b.pid"
`,
      { mode: 0o755 }
    )
    const config = await makeVmConfig({
      dirs,
      overrides: {
        mode: 'jailer',
        jailerBin,
        apiStartTimeoutMs: 3000,
        killWaitMs: 3000,
      },
    })
    const spawnCalls: string[][] = []
    const driver = createVmDriver(config, {
      runner: makeRunner().runner,
      logger: makeLogger().logger,
      spawn: (argv, opts) => {
        spawnCalls.push([...argv])
        return spawnWithEnv(argv, opts)
      },
    })
    const id = newInstanceId()
    await makeImage(config.imagesDir, 'web-demo')
    let handle: VmHandle | undefined
    try {
      handle = await driver.launch(makeRequest(id, 'web-demo'))
      const canonical = await realpath(config.firecrackerBin)
      const fcBase = path.basename(canonical)
      const jail = path.join(config.chrootBase, fcBase, id)
      expect(handle.dir).toBe(jail)
      expect(handle.apiSocket).toBe(path.join(jail, 'root', 'api.sock'))
      expect(await driver.isAlive(handle)).toBe(true)
      expect((await driver.adopt(id))?.pid).toBe(handle.pid)
      expect(await driver.listInstanceIds()).toContain(id)

      const argv = spawnCalls[0] ?? []
      expect(argv[argv.indexOf('--exec-file') + 1]).toBe(canonical)
      expect(argv.slice(argv.indexOf('--') + 1)).toEqual([
        '--api-sock',
        '/api.sock',
      ])
      expect(await pathExists(path.join(jail, 'root', `${fcBase}.pid`))).toBe(
        true
      )
    } finally {
      if (handle !== undefined) {
        await driver.stop(handle, { graceMs: 500 }).catch(() => undefined)
      }
      await driver.destroy(id).catch(() => undefined)
    }
  })
})

describe('jailer argv', () => {
  test('uses the documented flags and never a shell', async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), 'rctf-vm-jail-'))
    roots.push(root)
    const dirs = await makeDirs(root)
    const fakeJailer = path.join(root, 'bin', 'jailer')
    await mkdir(path.dirname(fakeJailer), { recursive: true })
    await Bun.write(fakeJailer, '#!/bin/sh\nexit 0\n')
    await chmod(fakeJailer, 0o755)

    const config = await makeVmConfig({
      dirs,
      overrides: {
        mode: 'jailer',
        jailerBin: fakeJailer,
        jailUid: 12345,
        jailGid: 12346,
        fsizeLimitBytes: 4096,
        noFileLimit: 512,
        parentCgroup: 'rctf',
        cgroupLimits: ['pids.max=512'],
        apiStartTimeoutMs: 50,
      },
    })
    const recorded: string[][] = []
    const spawn: VmSpawn = argv => {
      recorded.push([...argv])
      return {
        pid: 2_147_483_000,
        kill: () => undefined,
        exited: new Promise<number>(() => undefined),
      }
    }
    let clock = 0
    const driver = createVmDriver(config, {
      runner: makeRunner().runner,
      logger: makeLogger().logger,
      spawn,
      now: () => (clock += 1000),
      sleep: async () => undefined,
    })
    const id = newInstanceId()
    await makeImage(config.imagesDir, 'web-demo')

    await expect(driver.launch(makeRequest(id, 'web-demo'))).rejects.toThrow()

    expect(recorded).toHaveLength(1)
    const argv = recorded[0] ?? []
    expect(argv[0]).toBe(await realpath(fakeJailer))
    expect(argv[argv.indexOf('--exec-file') + 1]).toBe(
      await realpath(config.firecrackerBin)
    )
    expect(argv).toContain('--uid')
    expect(argv[argv.indexOf('--uid') + 1]).toBe('12345')
    expect(argv[argv.indexOf('--gid') + 1]).toBe('12346')
    expect(argv[argv.indexOf('--chroot-base-dir') + 1]).toBe(
      path.resolve(config.chrootBase)
    )
    expect(argv[argv.indexOf('--cgroup-version') + 1]).toBe('2')
    expect(argv[argv.indexOf('--parent-cgroup') + 1]).toBe('rctf')
    expect(argv[argv.indexOf('--cgroup') + 1]).toBe('pids.max=512')
    expect(argv).toContain('--new-pid-ns')
    const limits: string[] = []
    for (let i = 0; i < argv.length; i += 1) {
      if (argv[i] === '--resource-limit' && argv[i + 1] !== undefined) {
        limits.push(argv[i + 1] as string)
      }
    }
    expect(limits).toEqual([`fsize=${64 * 1024 * 1024}`, 'no-file=512'])
    const separator = argv.indexOf('--')
    expect(separator).toBeGreaterThan(0)
    // Jailer already passes `--id <id>` to Firecracker; passing it again after
    // `--` is a duplicate flag and Firecracker refuses to start.
    expect(argv.slice(separator + 1)).toEqual(['--api-sock', '/api.sock'])
    expect(argv.filter(arg => arg === '--id')).toHaveLength(1)
    // No shell metacharacters reach argv; the fake jailer would have been
    // exec'd with an argv array, so injection is impossible by construction.
    for (const arg of argv) expect(typeof arg).toBe('string')
    expect(await pathExists(path.join(config.runDir, id))).toBe(false)
  })

  test('rejects a shell-injection instance id before spawn', async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), 'rctf-vm-jail-'))
    roots.push(root)
    const dirs = await makeDirs(root)
    const config = await makeVmConfig({
      dirs,
      overrides: { mode: 'jailer' },
    })
    const recorded: string[][] = []
    const driver = createVmDriver(config, {
      spawn: argv => {
        recorded.push([...argv])
        return {
          pid: 1,
          kill: () => undefined,
          exited: new Promise<number>(() => undefined),
        }
      },
    })
    await makeImage(config.imagesDir, 'web-demo')
    await expect(
      driver.launch(makeRequest('abc;touch /tmp/pwned', 'web-demo'))
    ).rejects.toThrow(/instance id/)
    expect(recorded).toEqual([])
  })
})

const pathExists = async (target: string): Promise<boolean> => {
  try {
    await stat(target)
    return true
  } catch {
    return false
  }
}
