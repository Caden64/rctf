#!/usr/bin/env bun
/**
 * Runs INSIDE host-a (the controller host) for the ambiguous-create scenario.
 *
 * It wraps the fault-injection proxy from the edge harness
 * (`deploy/firecracker/e2e/proxy.ts`) around host-b's agent. The controller's
 * `controller-proxy.yaml` points host-b's URL at this listener, so a fault can
 * be armed for exactly one `PUT /v1/instances/:id`:
 *
 *   hold-request   swallow the create request; the controller sees a transport
 *                  error and keeps a `creating` row. Nothing exists on the
 *                  agent, so the reconciler must fence the id after
 *                  `createFenceSeconds` and a replayed PUT must be rejected.
 *   drop-response  forward the create, wait for the agent's complete response,
 *                  then close the controller connection without relaying it.
 *                  The VM exists, so the reconciler must adopt it.
 *
 * Control is file based (the driver writes over ssh):
 *   <dir>/faultproxy.mode          `hold-request` | `drop-response` | empty
 *   <dir>/faultproxy.port          listener port (written once)
 *   <dir>/faultproxy.pid           this process (written once)
 *   <dir>/faultproxy.captured.json captured held requests (id/method/target/...)
 *   <dir>/faultproxy.forwarded.json ids of creates forwarded upstream
 *   <dir>/faultproxy.replay.body   raw body of the last captured request
 *
 * Usage: faultproxy.ts <upstream-host> <upstream-port> <dir>
 */
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import net from 'node:net'
import path from 'node:path'
import { FaultProxy, type CreateFault } from '../e2e/proxy'

const upstreamHost = process.argv[2]
const upstreamPort = Number(process.argv[3])
const dir = process.argv[4]
if (
  upstreamHost === undefined ||
  !Number.isInteger(upstreamPort) ||
  dir === undefined
) {
  console.error('usage: faultproxy.ts <upstream-host> <upstream-port> <dir>')
  process.exit(2)
}
mkdirSync(dir, { recursive: true })

/** Ask the kernel for a free loopback port, then hand it to the proxy. */
const freePort = async (): Promise<number> =>
  await new Promise<number>((resolve, reject) => {
    const server = net.createServer()
    server.once('error', reject)
    server.listen(0, '127.0.0.1', () => {
      const address = server.address()
      const port =
        typeof address === 'object' && address !== null ? address.port : 0
      server.close(() => resolve(port))
    })
  })

const listenPort = await freePort()
if (listenPort <= 0) {
  console.error('could not allocate a loopback port')
  process.exit(1)
}

const proxy = new FaultProxy(listenPort, upstreamHost, upstreamPort)
await proxy.start()
writeFileSync(path.join(dir, 'faultproxy.port'), `${listenPort}\n`)
writeFileSync(path.join(dir, 'faultproxy.pid'), `${process.pid}\n`)
console.log(
  `faultproxy listening on 127.0.0.1:${listenPort} -> ${upstreamHost}:${upstreamPort}`
)

let armed: CreateFault | null = null
let capturedCount = -1
let forwardedCount = -1

const tick = (): void => {
  let mode = ''
  try {
    mode = readFileSync(path.join(dir, 'faultproxy.mode'), 'utf8').trim()
  } catch {
    // no mode file: stay disarmed
  }
  const next: CreateFault | null =
    mode === 'hold-request' || mode === 'drop-response' ? mode : null
  if (next !== armed) {
    armed = next
    if (next === null) proxy.disarm()
    else proxy.arm(next)
  }
  if (proxy.captured.length !== capturedCount) {
    capturedCount = proxy.captured.length
    writeFileSync(
      path.join(dir, 'faultproxy.captured.json'),
      JSON.stringify(
        proxy.captured.map(request => ({
          id: request.id,
          method: request.method,
          target: request.target,
          headers: request.headers,
          bodyBase64: request.body.toString('base64'),
        }))
      )
    )
    const last = proxy.captured[proxy.captured.length - 1]
    if (last !== undefined) {
      writeFileSync(path.join(dir, 'faultproxy.replay.body'), last.body)
    }
  }
  if (proxy.forwardedCreateIds.length !== forwardedCount) {
    forwardedCount = proxy.forwardedCreateIds.length
    writeFileSync(
      path.join(dir, 'faultproxy.forwarded.json'),
      JSON.stringify(proxy.forwardedCreateIds)
    )
  }
}

setInterval(tick, 50)

const shutdown = async (): Promise<void> => {
  try {
    await proxy.stop()
  } finally {
    process.exit(0)
  }
}
process.on('SIGTERM', () => void shutdown())
process.on('SIGINT', () => void shutdown())
