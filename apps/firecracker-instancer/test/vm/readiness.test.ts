import { afterEach, describe, expect, test } from 'bun:test'
import { mkdtemp, rm } from 'node:fs/promises'
import {
  createServer,
  type AddressInfo,
  type Server,
  type Socket,
} from 'node:net'
import os from 'node:os'
import path from 'node:path'
import type { VmHandle } from '../../src/interfaces'
import { createVmDriver } from '../../src/agent/vm'
import {
  findFreePort,
  makeDirs,
  makeLogger,
  makeRunner,
  makeVmConfig,
  newInstanceId,
  startLiveFake,
} from './helpers'

const cleanup: (() => Promise<void> | void)[] = []
const roots: string[] = []

afterEach(async () => {
  for (const fn of cleanup.splice(0).reverse()) await fn()
  for (const root of roots.splice(0)) {
    await rm(root, { recursive: true, force: true })
  }
})

const makeDriver = async (): Promise<{
  root: string
  driver: ReturnType<typeof createVmDriver>
}> => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'rctf-vm-ready-'))
  roots.push(root)
  const dirs = await makeDirs(root)
  const config = await makeVmConfig({
    dirs,
    overrides: { readinessIntervalMs: 50 },
  })
  const driver = createVmDriver(config, {
    runner: makeRunner().runner,
    logger: makeLogger().logger,
  })
  return { root, driver }
}

const listenTcp = async (): Promise<number> => {
  const server: Server = createServer(socket => socket.end())
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve))
  cleanup.push(
    () =>
      new Promise<void>(resolve => {
        server.close(() => resolve())
      })
  )
  return (server.address() as AddressInfo).port
}

const listenSilent = async (): Promise<number> => {
  const sockets = new Set<Socket>()
  const server: Server = createServer(socket => {
    sockets.add(socket)
    socket.on('close', () => sockets.delete(socket))
  })
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve))
  cleanup.push(
    () =>
      new Promise<void>(resolve => {
        for (const socket of sockets) socket.destroy()
        server.close(() => resolve())
      })
  )
  return (server.address() as AddressInfo).port
}

const serveHttp = (status: number, pathname = '/health'): number => {
  const server = Bun.serve({
    hostname: '127.0.0.1',
    port: 0,
    fetch: request =>
      new URL(request.url).pathname === pathname
        ? new Response(null, { status })
        : new Response('not found', { status: 404 }),
  })
  cleanup.push(() => server.stop(true))
  if (server.port === undefined) {
    throw new Error('Bun.serve did not bind a port')
  }
  return server.port
}

const withLive = async (
  root: string
): Promise<{ handle: VmHandle; kill: () => void; pid: number }> => {
  const id = newInstanceId()
  const live = await startLiveFake(root, id)
  cleanup.push(() => live.kill())
  return live
}

describe('waitReady', () => {
  test('resolves once a TCP port accepts connections', async () => {
    const { root, driver } = await makeDriver()
    const live = await withLive(root)
    const port = await listenTcp()
    await driver.waitReady(live.handle, {
      readiness: { kind: 'tcp', port },
      guestIp: '127.0.0.1',
      timeoutMs: 3000,
    })
  })

  test('resolves once HTTP returns the expected status on the expected path', async () => {
    const { root, driver } = await makeDriver()
    const live = await withLive(root)
    const port = serveHttp(204)
    await driver.waitReady(live.handle, {
      readiness: { kind: 'http', port, path: '/health', expectStatus: 204 },
      guestIp: '127.0.0.1',
      timeoutMs: 3000,
    })
  })

  test('keeps retrying an HTTP status mismatch until the timeout', async () => {
    const { root, driver } = await makeDriver()
    const live = await withLive(root)
    const port = serveHttp(200)
    const started = Date.now()
    await expect(
      driver.waitReady(live.handle, {
        readiness: { kind: 'http', port, path: '/health', expectStatus: 204 },
        guestIp: '127.0.0.1',
        timeoutMs: 300,
      })
    ).rejects.toThrow(/not ready/)
    expect(Date.now() - started).toBeLessThan(3000)
  })

  test('times out when nothing listens', async () => {
    const { root, driver } = await makeDriver()
    const live = await withLive(root)
    const port = await findFreePort()
    const started = Date.now()
    await expect(
      driver.waitReady(live.handle, {
        readiness: { kind: 'tcp', port },
        guestIp: '127.0.0.1',
        timeoutMs: 250,
      })
    ).rejects.toThrow(/not ready/)
    expect(Date.now() - started).toBeLessThan(3000)
  })

  test('rejects promptly when the abort signal fires', async () => {
    const { root, driver } = await makeDriver()
    const live = await withLive(root)
    const port = await findFreePort()
    const controller = new AbortController()
    setTimeout(() => controller.abort(), 100)
    await expect(
      driver.waitReady(
        live.handle,
        {
          readiness: { kind: 'tcp', port },
          guestIp: '127.0.0.1',
          timeoutMs: 5000,
        },
        controller.signal
      )
    ).rejects.toHaveProperty('name', 'AbortError')
  })

  test('rejects an already-aborted signal immediately', async () => {
    const { root, driver } = await makeDriver()
    const live = await withLive(root)
    const controller = new AbortController()
    controller.abort()
    await expect(
      driver.waitReady(
        live.handle,
        {
          readiness: { kind: 'tcp', port: 1 },
          guestIp: '127.0.0.1',
          timeoutMs: 5000,
        },
        controller.signal
      )
    ).rejects.toHaveProperty('name', 'AbortError')
  })

  test('rejects when the VM dies while waiting', async () => {
    const { root, driver } = await makeDriver()
    const live = await withLive(root)
    const port = await findFreePort()
    const started = Date.now()
    setTimeout(() => live.kill(), 200)
    await expect(
      driver.waitReady(live.handle, {
        readiness: { kind: 'tcp', port },
        guestIp: '127.0.0.1',
        timeoutMs: 5000,
      })
    ).rejects.toThrow(/exited before readiness/)
    expect(Date.now() - started).toBeLessThan(3000)
  })

  test('kind=none resolves for a live VM and rejects for a dead one', async () => {
    const { root, driver } = await makeDriver()
    const live = await withLive(root)
    await driver.waitReady(live.handle, {
      readiness: { kind: 'none' },
      guestIp: '127.0.0.1',
      timeoutMs: 0,
    })
    live.kill()
    // wait for the process to disappear before asserting
    const deadline = Date.now() + 3000
    while (Date.now() < deadline) {
      if (!(await driver.isAlive(live.handle))) break
      await new Promise(resolve => setTimeout(resolve, 20))
    }
    await expect(
      driver.waitReady(live.handle, {
        readiness: { kind: 'none' },
        guestIp: '127.0.0.1',
        timeoutMs: 0,
      })
    ).rejects.toThrow(/not running/)
  })

  test('rejects when the VM dies immediately after a successful probe', async () => {
    const { root, driver } = await makeDriver()
    const live = await withLive(root)
    const server = Bun.serve({
      hostname: '127.0.0.1',
      port: 0,
      fetch: async () => {
        live.kill()
        await Bun.sleep(100)
        return new Response(null, { status: 200 })
      },
    })
    cleanup.push(() => server.stop(true))
    await expect(
      driver.waitReady(live.handle, {
        readiness: { kind: 'http', port: server.port ?? 1, path: '/' },
        guestIp: '127.0.0.1',
        timeoutMs: 5000,
      })
    ).rejects.toThrow(/exited before readiness/)
  })

  test('rejects when the caller aborts immediately after a successful probe', async () => {
    const { root, driver } = await makeDriver()
    const live = await withLive(root)
    const controller = new AbortController()
    const server = Bun.serve({
      hostname: '127.0.0.1',
      port: 0,
      fetch: async () => {
        controller.abort()
        await Bun.sleep(20)
        return new Response(null, { status: 200 })
      },
    })
    cleanup.push(() => server.stop(true))
    await expect(
      driver.waitReady(
        live.handle,
        {
          readiness: { kind: 'http', port: server.port ?? 1, path: '/' },
          guestIp: '127.0.0.1',
          timeoutMs: 5000,
        },
        controller.signal
      )
    ).rejects.toHaveProperty('name', 'AbortError')
  })

  test('cancels an in-flight HTTP probe promptly', async () => {
    const { root, driver } = await makeDriver()
    const live = await withLive(root)
    const port = await listenSilent()
    const controller = new AbortController()
    setTimeout(() => controller.abort(), 100)
    const started = Date.now()
    await expect(
      driver.waitReady(
        live.handle,
        {
          readiness: { kind: 'http', port, path: '/', expectStatus: 200 },
          guestIp: '127.0.0.1',
          timeoutMs: 5000,
        },
        controller.signal
      )
    ).rejects.toHaveProperty('name', 'AbortError')
    expect(Date.now() - started).toBeLessThan(1000)
  })
})
