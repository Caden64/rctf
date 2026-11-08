/**
 * Test-only stand-in for the Firecracker binary. It speaks the same HTTP API
 * over a unix socket and records requests so tests can assert order/payloads.
 *
 * Behaviour is selected per instance id through environment variables
 * (`FAKE_FC_<id>_<KNOB>`), which the test harness sets before spawning:
 *   LOG=<path>        append one JSON line per request
 *   FAIL_PATH=<path>  answer with FAIL_STATUS (default 500) for this API path
 *   FAIL_AFTER=<n>    answer 500 after n successful requests
 *   FAIL_STATUS=<n>   status used by FAIL_PATH/FAIL_AFTER (default 500)
 *   ECHO_BODY=1       put the request body in a failure response
 *   NO_SOCKET=1       stay alive without creating the API socket
 *   STALE_SOCKET=1    create a regular file at --api-sock, never listen
 *   SOCKET_DELAY_MS=n wait n ms before listening
 *   IGNORE_CTRL=1     ignore SendCtrlAltDel
 */
import { appendFile, mkdir, writeFile } from 'node:fs/promises'
import path from 'node:path'

const argv = process.argv.slice(2)
const flagValue = (flag: string): string | undefined => {
  const index = argv.indexOf(flag)
  return index >= 0 ? argv[index + 1] : undefined
}

const instanceId = flagValue('--id') ?? 'unknown'
const apiSocket = flagValue('--api-sock')
const env = (name: string): string | undefined =>
  process.env[`FAKE_FC_${instanceId}_${name}`]

if (apiSocket === undefined) {
  console.error('fake-firecracker: --api-sock is required')
  process.exit(2)
}

if (env('NO_SOCKET') === '1') {
  // Stay alive (so the driver's cleanup has something to kill) but never
  // create the socket: launch must time out and roll back.
  await new Promise(() => undefined)
}

if (env('STALE_SOCKET') === '1') {
  // A socket *file* without a listener must not count as readiness.
  await mkdir(path.dirname(apiSocket), { recursive: true })
  await writeFile(apiSocket, 'not a socket\n', { mode: 0o600 })
  await new Promise(() => undefined)
}

const socketDelayMs = Number(env('SOCKET_DELAY_MS') ?? '0')
if (socketDelayMs > 0) {
  await new Promise(resolve => setTimeout(resolve, socketDelayMs))
}

const logPath = env('LOG')
const failPath = env('FAIL_PATH')
const failAfter = Number(env('FAIL_AFTER') ?? '0')
const failStatus = Number(env('FAIL_STATUS') ?? '500')
const echoBody = env('ECHO_BODY') === '1'
const ignoreCtrlAltDel = env('IGNORE_CTRL') === '1'
let requests = 0

Bun.serve({
  unix: apiSocket,
  fetch: async request => {
    const body = await request.text()
    const pathName = new URL(request.url).pathname
    requests += 1
    if (logPath !== undefined) {
      await appendFile(
        logPath,
        `${JSON.stringify({
          method: request.method,
          path: pathName,
          body,
        })}\n`
      )
    }
    if (failPath === pathName) {
      return new Response(echoBody ? body : 'injected failure', {
        status: failStatus,
      })
    }
    if (failAfter > 0 && requests > failAfter) {
      return new Response(echoBody ? body : 'injected failure', {
        status: failStatus,
      })
    }
    if (pathName === '/actions') {
      let action: unknown
      try {
        action = (JSON.parse(body) as { action_type?: unknown }).action_type
      } catch {
        action = undefined
      }
      if (action === 'SendCtrlAltDel' && !ignoreCtrlAltDel) {
        setTimeout(() => process.exit(0), 20)
      }
    }
    return new Response(null, { status: 204 })
  },
})
