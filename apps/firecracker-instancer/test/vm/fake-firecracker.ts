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

/**
 * Real Firecracker rejects a repeated option ("The argument '--id' was
 * provided more than once"). The fake does the same so driver tests can catch
 * a duplicate `--id`/`--api-sock` before booting a real VM.
 */
const parseOptions = (
  args: readonly string[]
): Map<string, string | undefined> => {
  const options = new Map<string, string | undefined>()
  const fail = (message: string): never => {
    console.error(`fake-firecracker: ${message}`)
    process.exit(2)
  }
  for (let i = 0; i < args.length; i += 1) {
    const arg = args[i]
    if (arg === undefined || !arg.startsWith('--')) continue
    const equals = arg.indexOf('=')
    const name = equals >= 0 ? arg.slice(0, equals) : arg
    if (options.has(name)) fail(`duplicate option ${name}`)
    if (equals >= 0) {
      options.set(name, arg.slice(equals + 1))
      continue
    }
    const value = args[i + 1]
    if (value === undefined || value.startsWith('--')) {
      fail(`missing value for ${name}`)
    }
    options.set(name, value)
    i += 1
  }
  return options
}

const options = parseOptions(argv)
const flagValue = (flag: string): string | undefined => options.get(flag)

const instanceId = flagValue('--id') ?? 'unknown'
const apiSocket = flagValue('--api-sock')
const env = (name: string): string | undefined =>
  process.env[`FAKE_FC_${instanceId}_${name}`]

if (instanceId === 'unknown') {
  console.error('fake-firecracker: --id is required')
  process.exit(2)
}

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

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value)
const nonEmptyString = (value: unknown): value is string =>
  typeof value === 'string' && value.length > 0
const isBoolean = (value: unknown): value is boolean =>
  typeof value === 'boolean'
const positiveInteger = (value: unknown): value is number =>
  typeof value === 'number' && Number.isSafeInteger(value) && value > 0

/**
 * Field names follow the Firecracker swagger:
 * https://github.com/firecracker-microvm/firecracker/blob/main/src/firecracker/swagger/firecracker.yaml
 * Real Firecracker rejects a missing required field; the fake does too so a
 * driver regression cannot pass here and fail on a real host.
 */
const validateRequest = (
  pathName: string,
  rawBody: string
): string | undefined => {
  let body: unknown
  try {
    body = JSON.parse(rawBody)
  } catch {
    return 'body is not valid JSON'
  }
  if (!isRecord(body)) return 'body must be a JSON object'

  if (pathName === '/boot-source') {
    if (!nonEmptyString(body.kernel_image_path)) {
      return 'boot-source.kernel_image_path is required'
    }
    if (body.boot_args !== undefined && typeof body.boot_args !== 'string') {
      return 'boot-source.boot_args must be a string'
    }
    if (body.initrd_path !== undefined && !nonEmptyString(body.initrd_path)) {
      return 'boot-source.initrd_path must be a string'
    }
    return undefined
  }
  if (pathName.startsWith('/drives/')) {
    if (!nonEmptyString(body.drive_id)) return 'drive.drive_id is required'
    if (!nonEmptyString(body.path_on_host)) {
      return 'drive.path_on_host is required'
    }
    if (!isBoolean(body.is_root_device)) {
      return 'drive.is_root_device is required'
    }
    if (!isBoolean(body.is_read_only)) {
      return 'drive.is_read_only is required'
    }
    return undefined
  }
  if (pathName.startsWith('/network-interfaces/')) {
    if (!nonEmptyString(body.iface_id)) {
      return 'network-interface.iface_id is required'
    }
    if (!nonEmptyString(body.host_dev_name)) {
      return 'network-interface.host_dev_name is required'
    }
    if (body.guest_mac !== undefined && typeof body.guest_mac !== 'string') {
      return 'network-interface.guest_mac must be a string'
    }
    return undefined
  }
  if (pathName === '/machine-config') {
    if (!positiveInteger(body.vcpu_count)) {
      return 'machine-config.vcpu_count is required'
    }
    if (!positiveInteger(body.mem_size_mib)) {
      return 'machine-config.mem_size_mib is required'
    }
    if (body.smt !== undefined && !isBoolean(body.smt)) {
      return 'machine-config.smt must be a boolean'
    }
    return undefined
  }
  if (pathName === '/mmds/config') {
    if (
      !Array.isArray(body.network_interfaces) ||
      !body.network_interfaces.every(nonEmptyString)
    ) {
      return 'mmds-config.network_interfaces is required'
    }
    if (
      body.version !== undefined &&
      body.version !== 'V1' &&
      body.version !== 'V2'
    ) {
      return 'mmds-config.version must be V1 or V2'
    }
    return undefined
  }
  return undefined
}

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
    const invalid = validateRequest(pathName, body)
    if (invalid !== undefined) {
      // The MMDS body carries secrets; never echo it in a validation error.
      return new Response(
        pathName === '/mmds'
          ? 'invalid request'
          : `invalid request: ${invalid}`,
        { status: 400 }
      )
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
