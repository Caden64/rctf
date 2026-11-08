import { afterEach, describe, expect, test } from 'bun:test'
import {
  access,
  constants,
  lstat,
  mkdir,
  mkdtemp,
  readFile,
  readdir,
  rm,
  stat,
  symlink,
  writeFile,
} from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { shQuote } from './helpers'

const GUEST_DIR = path.resolve(
  import.meta.dir,
  '../../../../deploy/firecracker/guest'
)
const INIT = path.join(GUEST_DIR, 'init')
const BUILD = path.join(GUEST_DIR, 'build-rootfs.sh')
const roots: string[] = []

afterEach(async () => {
  for (const root of roots.splice(0)) {
    await rm(root, { recursive: true, force: true })
  }
})

const tempRoot = async (prefix: string): Promise<string> => {
  const root = await mkdtemp(path.join(os.tmpdir(), prefix))
  roots.push(root)
  return root
}

interface ShellResult {
  code: number
  stdout: string
  stderr: string
}

const runSh = async (
  script: string,
  env: Record<string, string> = {},
  cwd?: string
): Promise<ShellResult> => {
  const proc = Bun.spawn(['/bin/sh', '-c', script], {
    cwd,
    env: { ...process.env, ...env },
    stdin: 'ignore',
    stdout: 'pipe',
    stderr: 'pipe',
  })
  const [stdout, stderr, code] = await Promise.all([
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
    proc.exited,
  ])
  return { code, stdout, stderr }
}

const sourceInit = (body: string): string =>
  `RCTF_INIT_SOURCE_ONLY=1 . ${shQuote(INIT)}\n${body}`

const fakeNc = async (
  root: string,
  response: string
): Promise<{ binDir: string; capture: string }> => {
  const binDir = path.join(root, 'bin')
  await mkdir(binDir, { recursive: true, mode: 0o700 })
  const capture = path.join(root, 'nc-request.bin')
  await writeFile(
    path.join(binDir, 'nc'),
    `#!/bin/sh\ncat > ${shQuote(capture)}\nprintf '%s' ${shQuote(response)}\n`,
    { mode: 0o755 }
  )
  // A PATH without curl so the init uses its nc fallback. It still needs the
  // tools the fallback itself calls.
  for (const tool of ['awk', 'tr', 'cat']) {
    await symlink(`/usr/bin/${tool}`, path.join(binDir, tool))
  }
  return { binDir, capture }
}

const fakeJqDir = async (root: string): Promise<string> => {
  const binDir = path.join(root, 'bin')
  await mkdir(binDir, { recursive: true, mode: 0o700 })
  await installFakeJq(binDir)
  return binDir
}

const installFakeJq = async (binDir: string): Promise<void> => {
  await writeFile(
    path.join(binDir, 'jq'),
    `#!/bin/sh\nexec ${shQuote(process.execPath)} ${shQuote(path.join(import.meta.dir, 'fake-jq.ts'))} "$@"\n`,
    { mode: 0o755 }
  )
}

/** Symlink the requested host tools into a restricted PATH directory. */
const guestBin = async (root: string, tools: string[]): Promise<string> => {
  const binDir = path.join(root, 'bin')
  await mkdir(binDir, { recursive: true, mode: 0o700 })
  for (const tool of tools) {
    let linked = false
    for (const dir of ['/usr/bin', '/bin', '/usr/sbin', '/sbin']) {
      const candidate = path.join(dir, tool)
      try {
        await access(candidate, constants.X_OK)
        await symlink(candidate, path.join(binDir, tool))
        linked = true
        break
      } catch {
        // try the next directory
      }
    }
    if (!linked) throw new Error(`test host has no ${tool}`)
  }
  return binDir
}

/** A fake nc that answers PUT with `token` and anything else with `document`. */
const writeFakeNc = async (
  root: string,
  binDir: string,
  responses: { token: string; document: string }
): Promise<string> => {
  const capture = path.join(root, 'nc-request.bin')
  const tokenFile = path.join(root, 'nc-token-response')
  const documentFile = path.join(root, 'nc-document-response')
  await writeFile(tokenFile, responses.token)
  await writeFile(documentFile, responses.document)
  await writeFile(
    path.join(binDir, 'nc'),
    `#!/bin/sh
req=$(cat)
printf '%s\\n' "$req" >> ${shQuote(capture)}
case "$req" in
  "PUT "*) cat ${shQuote(tokenFile)} ;;
  *) cat ${shQuote(documentFile)} ;;
esac
`,
    { mode: 0o755 }
  )
  return capture
}

/** A fake curl: records argv, writes -o body, prints the configured code. */
const fakeCurl = async (
  root: string,
  options: { code: string; body: string; exitCode?: number }
): Promise<{ binDir: string; capture: string }> => {
  const binDir = path.join(root, 'bin')
  await mkdir(binDir, { recursive: true, mode: 0o700 })
  const capture = path.join(root, 'curl-args')
  const bodyFile = path.join(root, 'curl-body')
  await writeFile(bodyFile, options.body)
  await writeFile(
    path.join(binDir, 'curl'),
    `#!/bin/sh
printf '%s\\n' "$@" > ${shQuote(capture)}
out=
while [ $# -gt 0 ]; do
  case $1 in
    -o) out=$2; shift 2 ;;
    -m|-X|-w|-H) shift 2 ;;
    *) shift ;;
  esac
done
if [ -n "$out" ]; then cat ${shQuote(bodyFile)} > "$out"; fi
printf '%s' ${shQuote(options.code)}
exit ${options.exitCode ?? 0}
`,
    { mode: 0o755 }
  )
  return { binDir, capture }
}

const validMetadata = (overrides: Record<string, unknown> = {}): string =>
  JSON.stringify({
    rctf: {
      version: 1,
      instanceId: 'instance-1',
      hostname: 'instance-1.fc1.example.test',
      env: { CHALLENGE: 'web-demo' },
      flags: [{ provider: 'main', flag: 'flag{boot-contract}' }],
      ...overrides,
    },
  })

const httpResponse = (body: string, status = '200 OK'): string =>
  `HTTP/1.1 ${status}\r\nContent-Length: ${Buffer.byteLength(body)}\r\n\r\n${body}`

interface GuestMainOptions {
  /** `null` makes every document GET fail with 500. */
  document?: string | null
  token?: string
  withJq?: boolean
  envFileIsDirectory?: boolean
  extraEnv?: Record<string, string>
}

interface GuestMainResult extends ShellResult {
  marker: string
  runRoot: string
  capture: string
}

/**
 * Run the real init end to end (as a normal process, not PID 1) with faked
 * mounts, ip, hostname, nc and jq. `.mmds-body` and flags therefore land in a
 * temp directory while the script's control flow is unchanged.
 */
const runGuestMain = async (
  root: string,
  options: GuestMainOptions = {}
): Promise<GuestMainResult> => {
  const binDir = await guestBin(root, [
    'mkdir',
    'chmod',
    'awk',
    'tr',
    'cat',
    'sleep',
    'date',
    'rm',
  ])
  // main calls these; fakes keep the test away from real mounts and routes.
  for (const tool of ['mount', 'ip', 'hostname']) {
    await writeFile(path.join(binDir, tool), '#!/bin/sh\nexit 0\n', {
      mode: 0o755,
    })
  }
  if (options.withJq !== false) await installFakeJq(binDir)

  const capture = await writeFakeNc(root, binDir, {
    token:
      options.token ?? httpResponse('token-0123456789abcdef0123456789abcdef'),
    document:
      options.document === null
        ? httpResponse('no metadata', '500 Server Error')
        : (options.document ?? validMetadata()),
  })

  const runMount = path.join(root, 'run')
  await mkdir(runMount, { recursive: true })
  const runRoot = path.join(runMount, 'rctf')
  const mounts = path.join(root, 'mounts')
  await writeFile(mounts, `none ${runMount} tmpfs rw,nosuid,nodev 0 0\n`)
  if (options.envFileIsDirectory) {
    await mkdir(path.join(runRoot, 'env.sh'), { recursive: true })
  }

  const marker = path.join(root, 'service-ran')
  const service = path.join(root, 'service.sh')
  await writeFile(
    service,
    `#!/bin/sh
printf 'SERVICE-RAN\\n'
printf 'FLAGS_DIR=%s\\n' "$RCTF_FLAGS_DIR"
for f in "$RCTF_FLAGS_DIR"/*; do
  [ -e "$f" ] || continue
  printf 'FLAG-FILE=%s\\n' "\${f##*/}"
done
printf 'ran\\n' > ${shQuote(marker)}
`,
    { mode: 0o755 }
  )

  const result = await runSh(`/bin/sh ${shQuote(INIT)}`, {
    PATH: binDir,
    RCTF_INIT_SOURCE_ONLY: '0',
    RCTF_RUN_MOUNT: runMount,
    RCTF_RUN_ROOT: runRoot,
    RCTF_PROC_MOUNTS: mounts,
    RCTF_MMDS_HOST: '127.0.0.1',
    RCTF_MMDS_PORT: '8080',
    RCTF_MMDS_BODY_FILE: path.join(runRoot, '.mmds-body'),
    RCTF_BOOT_BUDGET: '0',
    RCTF_FETCH_TIMEOUT: '1',
    RCTF_RETRY_INTERVAL: '0',
    RCTF_SERVICE: service,
    ...options.extraEnv,
  })
  return { ...result, marker, runRoot, capture }
}

describe('guest init: PATH', () => {
  test('puts /rctf first so the bundled /rctf/jq is found', async () => {
    // Found by booting a real guest: the builder installs jq at /rctf/jq but
    // init called plain `jq`, so init decided jq was missing and wrote no flags.
    const result = await runSh(sourceInit('printf %s "$PATH"'), {
      PATH: '/bin',
    })
    expect(result.code).toBe(0)
    expect(result.stdout.startsWith('/rctf:')).toBe(true)
  })
})

describe('guest init: nc HTTP fallback', () => {
  test('writes CRLF headers and never literal backslash escapes', async () => {
    const root = await tempRoot('rctf-guest-nc-')
    const response = 'HTTP/1.1 200 OK\r\nContent-Length: 2\r\n\r\nok'
    const { binDir, capture } = await fakeNc(root, response)
    const result = await runSh(
      sourceInit(
        'raw_http PUT /latest/api/token "X-metadata-token-ttl-seconds: 21600"'
      ),
      {
        PATH: `${binDir}:/usr/bin:/bin`,
        RCTF_MMDS_HOST: '127.0.0.1',
        RCTF_MMDS_PORT: '8080',
      }
    )
    expect(result.code).toBe(0)
    expect(result.stdout).toBe(response)
    const request = await readFile(capture, 'utf8')
    expect(request).toBe(
      'PUT /latest/api/token HTTP/1.1\r\n' +
        'Host: 127.0.0.1\r\n' +
        'Connection: close\r\n' +
        'X-metadata-token-ttl-seconds: 21600\r\n' +
        '\r\n'
    )
    expect(request).not.toContain('\\r\\n')
  })

  test('the token PUT carries Content-Length: 0 (real MMDS ignores a bodyless PUT without it)', async () => {
    // Found by booting a real Firecracker 1.17 guest: without this header the
    // MMDS never answered, init started the service without flags.
    const root = await tempRoot('rctf-guest-nc-')
    const { binDir, capture } = await fakeNc(
      root,
      'HTTP/1.1 200 OK\r\nContent-Length: 5\r\n\r\ntoken'
    )
    const result = await runSh(sourceInit('fetch_token'), {
      PATH: binDir,
      RCTF_MMDS_HOST: '127.0.0.1',
      RCTF_MMDS_PORT: '8080',
    })
    expect(result.code).toBe(0)
    expect(result.stdout.trim()).toBe('token')
    const request = await readFile(capture, 'utf8')
    expect(request).toContain('\r\nContent-Length: 0\r\n')
    expect(request.startsWith('PUT /latest/api/token HTTP/1.1\r\n')).toBe(true)
  })

  test('combines token and Accept headers as separate CRLF lines', async () => {
    const root = await tempRoot('rctf-guest-nc-')
    const { binDir, capture } = await fakeNc(
      root,
      'HTTP/1.1 200 OK\r\nContent-Length: 2\r\n\r\n{}'
    )
    const result = await runSh(
      sourceInit(
        'raw_http GET / "X-metadata-token: token-123" "Accept: application/json"'
      ),
      {
        PATH: `${binDir}:/usr/bin:/bin`,
        RCTF_MMDS_HOST: '127.0.0.1',
        RCTF_MMDS_PORT: '8080',
      }
    )
    expect(result.code).toBe(0)
    const request = await readFile(capture, 'utf8')
    expect(request).toContain(
      'X-metadata-token: token-123\r\nAccept: application/json\r\n\r\n'
    )
  })

  test('accepts a body only for a 200 status line', async () => {
    const root = await tempRoot('rctf-guest-status-')
    const { binDir } = await fakeNc(
      root,
      'HTTP/1.1 400 Bad Request\r\n\r\n{"error":"nope"}'
    )
    const bad = await runSh(
      sourceInit(
        'printf "HTTP/1.1 400 Bad Request\\r\\n\\r\\nflag{not-a-body}" | http_body'
      ),
      { PATH: `${binDir}:/usr/bin:/bin` }
    )
    expect(bad.stdout).toBe('')
    expect(bad.code).not.toBe(0)

    const malformed = await runSh(
      sourceInit('printf "NOT HTTP\\r\\n\\r\\nleak" | http_body'),
      { PATH: `${binDir}:/usr/bin:/bin` }
    )
    expect(malformed.stdout).toBe('')
    expect(malformed.code).not.toBe(0)

    const good = await runSh(
      sourceInit(
        'printf "HTTP/1.1 200 OK\\r\\nContent-Length: 5\\r\\n\\r\\nhello" | http_body'
      ),
      { PATH: `${binDir}:/usr/bin:/bin` }
    )
    expect(good.stdout).toBe('hello\n')
    expect(good.code).toBe(0)
  })

  test('fetch_metadata fails closed on a non-200 MMDS response', async () => {
    const root = await tempRoot('rctf-guest-fetch-')
    const { binDir } = await fakeNc(
      root,
      'HTTP/1.1 500 Server Error\r\n\r\nnot-metadata'
    )
    const result = await runSh(
      sourceInit(
        'out=$(fetch_metadata token); rc=$?; printf "rc=%s out=%s\\n" "$rc" "$out"'
      ),
      {
        PATH: binDir,
        RCTF_MMDS_HOST: '127.0.0.1',
        RCTF_MMDS_PORT: '8080',
      }
    )
    expect(result.stdout).toBe('rc=1 out=\n')
  })

  test('treats a completely empty response as a failure', async () => {
    const root = await tempRoot('rctf-guest-status-')
    const { binDir } = await fakeNc(root, '')
    const result = await runSh(
      sourceInit('printf "" | http_body; printf "rc=%s\\n" "$?"'),
      { PATH: `${binDir}:/usr/bin:/bin` }
    )
    expect(result.stdout).toBe('rc=1\n')
  })
})

describe('guest init: bounded metadata retries', () => {
  test('retries the document GET through the whole boot budget and returns nothing', async () => {
    const root = await tempRoot('rctf-guest-retry-')
    const binDir = await guestBin(root, ['awk', 'tr', 'cat', 'sleep', 'date'])
    const capture = await writeFakeNc(root, binDir, {
      token: httpResponse('token'),
      document: httpResponse('not-metadata', '500 Server Error'),
    })
    const result = await runSh(
      sourceInit(
        'out=$(fetch_metadata_document); rc=$?; printf "rc=%s len=%s\\n" "$rc" "${#out}"'
      ),
      {
        PATH: binDir,
        RCTF_MMDS_HOST: '127.0.0.1',
        RCTF_MMDS_PORT: '8080',
        // 3 / (1 + 0) = 3 rounds, no sleeping, so the test is fast and the
        // number of requests is deterministic.
        RCTF_BOOT_BUDGET: '3',
        RCTF_FETCH_TIMEOUT: '1',
        RCTF_RETRY_INTERVAL: '0',
      }
    )
    expect(result.stdout).toBe('rc=1 len=0\n')
    const requests = await readFile(capture, 'utf8')
    const puts = requests.split('\n').filter(line => line.startsWith('PUT '))
    const gets = requests.split('\n').filter(line => line.startsWith('GET '))
    // The token is fetched once and reused; every round retries the document.
    expect(puts).toHaveLength(1)
    expect(gets).toHaveLength(3)
  })

  test('retries the token PUT when it never succeeds', async () => {
    const root = await tempRoot('rctf-guest-retry-')
    const binDir = await guestBin(root, ['awk', 'tr', 'cat', 'sleep', 'date'])
    const capture = await writeFakeNc(root, binDir, {
      token: httpResponse('denied', '403 Forbidden'),
      document: httpResponse(validMetadata()),
    })
    const result = await runSh(
      sourceInit(
        'out=$(fetch_metadata_document); rc=$?; printf "rc=%s len=%s\\n" "$rc" "${#out}"'
      ),
      {
        PATH: binDir,
        RCTF_MMDS_HOST: '127.0.0.1',
        RCTF_MMDS_PORT: '8080',
        RCTF_BOOT_BUDGET: '3',
        RCTF_FETCH_TIMEOUT: '1',
        RCTF_RETRY_INTERVAL: '0',
      }
    )
    expect(result.stdout).toBe('rc=1 len=0\n')
    const requests = await readFile(capture, 'utf8')
    const puts = requests.split('\n').filter(line => line.startsWith('PUT '))
    const gets = requests.split('\n').filter(line => line.startsWith('GET '))
    expect(puts).toHaveLength(3)
    // No token means the document is never requested.
    expect(gets).toHaveLength(0)
  })
})

describe('guest init: curl transport', () => {
  test('uses the configured MMDS port for both the token and document URLs', async () => {
    const root = await tempRoot('rctf-guest-curl-')
    const { binDir, capture } = await fakeCurl(root, {
      code: '200',
      body: 'token-1',
    })
    const token = await runSh(sourceInit('fetch_token'), {
      PATH: `${binDir}:/usr/bin:/bin`,
      RCTF_MMDS_HOST: '127.0.0.1',
      RCTF_MMDS_PORT: '8123',
      RCTF_MMDS_BODY_FILE: path.join(root, 'body'),
    })
    expect(token.code).toBe(0)
    expect(token.stdout).toBe('token-1')
    const tokenArgs = await readFile(capture, 'utf8')
    expect(tokenArgs).toContain('http://127.0.0.1:8123/latest/api/token')

    const metadataRoot = await tempRoot('rctf-guest-curl-')
    const metadataCurl = await fakeCurl(metadataRoot, {
      code: '200',
      body: validMetadata(),
    })
    const metadata = await runSh(sourceInit('fetch_metadata token-1'), {
      PATH: `${metadataCurl.binDir}:/usr/bin:/bin`,
      RCTF_MMDS_HOST: '127.0.0.1',
      RCTF_MMDS_PORT: '8124',
      RCTF_MMDS_BODY_FILE: path.join(metadataRoot, 'body'),
    })
    expect(metadata.code).toBe(0)
    expect(metadata.stdout).toBe(validMetadata())
    const metadataArgs = await readFile(metadataCurl.capture, 'utf8')
    expect(metadataArgs).toContain('http://127.0.0.1:8124/')
  })

  test('requires exactly HTTP 200, not just any non-error status', async () => {
    for (const code of ['204', '301', '500']) {
      const root = await tempRoot('rctf-guest-curl-')
      const { binDir } = await fakeCurl(root, {
        code,
        body: 'not-a-document',
      })
      const bodyFile = path.join(root, 'body')
      const result = await runSh(
        sourceInit(
          'out=$(fetch_metadata token); rc=$?; printf "rc=%s out=%s\\n" "$rc" "$out"'
        ),
        {
          PATH: `${binDir}:/usr/bin:/bin`,
          RCTF_MMDS_HOST: '127.0.0.1',
          RCTF_MMDS_PORT: '8080',
          RCTF_MMDS_BODY_FILE: bodyFile,
        }
      )
      expect(result.stdout).toBe('rc=1 out=\n')
      // A rejected response body never lingers on tmpfs.
      await expect(lstat(bodyFile)).rejects.toThrow()
    }
  })

  test('fails closed when curl itself fails', async () => {
    const root = await tempRoot('rctf-guest-curl-')
    const { binDir } = await fakeCurl(root, {
      code: '000',
      body: '',
      exitCode: 7,
    })
    const result = await runSh(
      sourceInit(
        'out=$(fetch_token); rc=$?; printf "rc=%s out=%s\\n" "$rc" "$out"'
      ),
      {
        PATH: `${binDir}:/usr/bin:/bin`,
        RCTF_MMDS_HOST: '127.0.0.1',
        RCTF_MMDS_PORT: '8080',
        RCTF_MMDS_BODY_FILE: path.join(root, 'body'),
      }
    )
    expect(result.stdout).toBe('rc=1 out=\n')
  })
})

describe('guest init: metadata schema', () => {
  const violations: [string, string][] = [
    ['version is not 1', validMetadata({ version: 2 })],
    [
      'version is missing',
      JSON.stringify({
        rctf: { instanceId: 'i', hostname: 'h', env: {}, flags: [] },
      }),
    ],
    [
      'instanceId is missing',
      JSON.stringify({
        rctf: { version: 1, hostname: 'h', env: {}, flags: [] },
      }),
    ],
    ['instanceId is empty', validMetadata({ instanceId: '' })],
    ['instanceId is not a string', validMetadata({ instanceId: 7 })],
    [
      'hostname is missing',
      JSON.stringify({
        rctf: { version: 1, instanceId: 'i', env: {}, flags: [] },
      }),
    ],
    ['hostname is empty', validMetadata({ hostname: '' })],
    ['env is an array', validMetadata({ env: [] })],
    [
      'env is missing',
      JSON.stringify({
        rctf: { version: 1, instanceId: 'i', hostname: 'h', flags: [] },
      }),
    ],
    ['flags is an object', validMetadata({ flags: { main: 'x' } })],
    [
      'flags is missing',
      JSON.stringify({
        rctf: { version: 1, instanceId: 'i', hostname: 'h', env: {} },
      }),
    ],
    ['a flag has no provider', validMetadata({ flags: [{ flag: 'x' }] })],
    ['a flag has no value', validMetadata({ flags: [{ provider: 'main' }] })],
    [
      'a flag value is not a string',
      validMetadata({ flags: [{ provider: 'main', flag: 1 }] }),
    ],
    ['the document is malformed JSON', '{"rctf":'],
  ]

  test('rejects every incomplete or malformed document', async () => {
    const root = await tempRoot('rctf-guest-schema-')
    const binDir = await fakeJqDir(root)
    for (const [name, document] of violations) {
      const result = await runSh(
        sourceInit('validate_metadata "$DOC"; printf "rc=%s\\n" "$?"'),
        {
          PATH: `${binDir}:/usr/bin:/bin`,
          DOC: document,
        }
      )
      expect({ name, rc: result.stdout.trim() }).toEqual({
        name,
        rc: 'rc=1',
      })
      // Never echo the document (it may carry flags) or jq diagnostics.
      expect(result.stdout).not.toContain('flag{boot-contract}')
      expect(result.stderr).toBe('')
    }
  })

  test('accepts the full document and an empty flags array', async () => {
    const root = await tempRoot('rctf-guest-schema-')
    const binDir = await fakeJqDir(root)
    for (const document of [validMetadata(), validMetadata({ flags: [] })]) {
      const result = await runSh(
        sourceInit('validate_metadata "$DOC"; printf "rc=%s\\n" "$?"'),
        {
          PATH: `${binDir}:/usr/bin:/bin`,
          DOC: document,
        }
      )
      expect(result.stdout.trim()).toBe('rc=0')
      expect(result.stderr).toBe('')
    }
  })
})

describe('guest init: boot contract is fail-closed', () => {
  test('starts the service for a flagless challenge (empty flags array)', async () => {
    const root = await tempRoot('rctf-guest-main-')
    const result = await runGuestMain(root, {
      document: httpResponse(validMetadata({ flags: [] })),
    })
    expect(result.code).toBe(0)
    expect(result.stdout).toContain('SERVICE-RAN')
    await expect(readFile(result.marker, 'utf8')).resolves.toBe('ran\n')
    const flags = path.join(result.runRoot, 'flags')
    expect((await stat(flags)).isDirectory()).toBe(true)
    expect(await readdir(flags)).toEqual([])
  })

  test('does not start the service when the document GET fails through every retry', async () => {
    const root = await tempRoot('rctf-guest-main-')
    const result = await runGuestMain(root, { document: null })
    expect(result.code).not.toBe(0)
    expect(result.stdout).not.toContain('SERVICE-RAN')
    expect(result.stderr).toContain('could not fetch MMDS metadata')
    await expect(lstat(result.marker)).rejects.toThrow()
  })

  test('does not start the service when the document is malformed JSON', async () => {
    const root = await tempRoot('rctf-guest-main-')
    const result = await runGuestMain(root, {
      document: httpResponse('{"rctf":'),
    })
    expect(result.code).not.toBe(0)
    expect(result.stdout).not.toContain('SERVICE-RAN')
    expect(result.stderr).toContain('does not match the v1 schema')
    await expect(lstat(result.marker)).rejects.toThrow()
  })

  test('does not start the service on a schema violation, and never logs the document', async () => {
    const root = await tempRoot('rctf-guest-main-')
    const result = await runGuestMain(root, {
      document: httpResponse(
        validMetadata({
          version: 2,
          flags: [{ provider: 'main', flag: 'flag{secret-in-document}' }],
        })
      ),
    })
    expect(result.code).not.toBe(0)
    expect(result.stdout).not.toContain('SERVICE-RAN')
    expect(result.stderr).toContain('does not match the v1 schema')
    expect(result.stdout).not.toContain('flag{secret-in-document}')
    expect(result.stderr).not.toContain('flag{secret-in-document}')
    await expect(lstat(result.marker)).rejects.toThrow()
  })

  test('does not start the service when jq is missing', async () => {
    const root = await tempRoot('rctf-guest-main-')
    const result = await runGuestMain(root, {
      document: httpResponse(validMetadata()),
      withJq: false,
    })
    expect(result.code).not.toBe(0)
    expect(result.stdout).not.toContain('SERVICE-RAN')
    expect(result.stderr).toContain('jq is required')
    await expect(lstat(result.marker)).rejects.toThrow()
  })

  test('does not start the service when the environment cannot be prepared', async () => {
    const root = await tempRoot('rctf-guest-main-')
    const result = await runGuestMain(root, {
      document: httpResponse(
        validMetadata({
          flags: [{ provider: 'main', flag: 'flag{env-failure}' }],
        })
      ),
      envFileIsDirectory: true,
    })
    expect(result.code).not.toBe(0)
    expect(result.stdout).not.toContain('SERVICE-RAN')
    expect(result.stderr).toContain('MMDS boot contract failed')
    await expect(lstat(result.marker)).rejects.toThrow()
    // The flag was written before the failure, but diagnostics stay clean.
    expect(result.stdout).not.toContain('flag{env-failure}')
    expect(result.stderr).not.toContain('flag{env-failure}')
  })

  test('writes flags and environment before starting the service', async () => {
    const root = await tempRoot('rctf-guest-main-')
    const result = await runGuestMain(root, {
      document: httpResponse(
        validMetadata({
          env: { CHALLENGE: 'web-demo' },
          flags: [{ provider: 'main', flag: 'flag{delivered}' }],
        })
      ),
    })
    expect(result.code).toBe(0)
    expect(result.stdout).toContain('SERVICE-RAN')
    expect(result.stdout).toContain('FLAG-FILE=main')
    expect(
      await readFile(path.join(result.runRoot, 'flags', 'main'), 'utf8')
    ).toBe('flag{delivered}')
    expect(await readFile(path.join(result.runRoot, 'env.sh'), 'utf8')).toBe(
      "export CHALLENGE='web-demo'\n"
    )
  })
})

describe('guest init: flag storage', () => {
  test('refuses to write flags when /run is not tmpfs', async () => {
    const root = await tempRoot('rctf-guest-run-')
    const runMount = path.join(root, 'run')
    const runRoot = path.join(runMount, 'rctf')
    await mkdir(runMount, { recursive: true })
    const mounts = path.join(root, 'mounts')
    await writeFile(mounts, `none ${runMount} ext4 rw 0 0\n`)
    const result = await runSh(
      sourceInit('prepare_run_root; printf "rc=%s\\n" "$?"'),
      {
        RCTF_RUN_MOUNT: runMount,
        RCTF_RUN_ROOT: runRoot,
        RCTF_PROC_MOUNTS: mounts,
      }
    )
    expect(result.stdout).toContain('rc=1')
    expect(result.stderr).toContain('not a tmpfs')
    await expect(lstat(path.join(runRoot, 'flags'))).rejects.toThrow()
  })

  test('creates the flag directory when /run is tmpfs', async () => {
    const root = await tempRoot('rctf-guest-run-')
    const runMount = path.join(root, 'run')
    const runRoot = path.join(runMount, 'rctf')
    await mkdir(runMount, { recursive: true })
    const mounts = path.join(root, 'mounts')
    await writeFile(mounts, `none ${runMount} tmpfs rw,nosuid,nodev 0 0\n`)
    const result = await runSh(
      sourceInit('prepare_run_root; printf "rc=%s\\n" "$?"'),
      {
        RCTF_RUN_MOUNT: runMount,
        RCTF_RUN_ROOT: runRoot,
        RCTF_PROC_MOUNTS: mounts,
      }
    )
    expect(result.stdout).toContain('rc=0')
    const st = await stat(path.join(runRoot, 'flags'))
    expect(st.isDirectory()).toBe(true)
    expect(st.mode & 0o777).toBe(0o700)
  })

  test('recovers flag bytes exactly and never overwrites a colliding provider', async () => {
    const root = await tempRoot('rctf-guest-flags-')
    const binDir = await fakeJqDir(root)
    const runRoot = path.join(root, 'rctf')
    const flagsDir = path.join(runRoot, 'flags')
    await mkdir(flagsDir, { recursive: true, mode: 0o700 })
    const values = [
      'plain',
      'back\\slash',
      'tab\tvalue',
      'line1\nline2',
      'quote"and\'single',
      'unicode-\u2713-\u{1f600}',
      ' leading and trailing ',
    ]
    const metadata = JSON.stringify({
      rctf: {
        version: 1,
        instanceId: 'id',
        hostname: 'host',
        env: {},
        flags: [
          { provider: 'main', flag: values[0] },
          { provider: 'main', flag: values[1] },
          { provider: 'weird name!', flag: values[2] },
          { provider: 'back\\slash', flag: values[3] },
          { provider: 'quote', flag: values[4] },
          { provider: 'unicode', flag: values[5] },
          { provider: 'spaces', flag: values[6] },
        ],
      },
    })
    const result = await runSh(
      sourceInit('write_flags "$WRITE_METADATA"; printf "rc=%s\\n" "$?"'),
      {
        PATH: `${binDir}:/usr/bin:/bin`,
        RCTF_RUN_ROOT: runRoot,
        WRITE_METADATA: metadata,
      }
    )
    expect(result.stdout).toContain('rc=0')
    const expected: [string, string][] = [
      ['main', values[0] as string],
      ['main.1', values[1] as string],
      ['weird_name_', values[2] as string],
      ['back_slash', values[3] as string],
      ['quote', values[4] as string],
      ['unicode', values[5] as string],
      ['spaces', values[6] as string],
    ]
    for (const [name, value] of expected) {
      const contents = await readFile(path.join(flagsDir, name))
      expect(contents.equals(Buffer.from(value, 'utf8'))).toBe(true)
      const st = await stat(path.join(flagsDir, name))
      expect(st.mode & 0o777).toBe(0o400)
    }
  })

  test('rejects a provider whose sanitised name is empty', async () => {
    const root = await tempRoot('rctf-guest-flags-')
    const binDir = await fakeJqDir(root)
    const runRoot = path.join(root, 'rctf')
    const flagsDir = path.join(runRoot, 'flags')
    await mkdir(flagsDir, { recursive: true, mode: 0o700 })
    // Provider is non-empty so the index loop runs, but only characters that
    // sanitise away cannot produce an empty result (tr maps them to `_`), so
    // exercise the guard with an empty provider.
    const metadata = JSON.stringify({
      rctf: {
        version: 1,
        instanceId: 'id',
        hostname: 'host',
        env: {},
        flags: [{ provider: '', flag: 'secret' }],
      },
    })
    const result = await runSh(
      sourceInit('write_flags "$WRITE_METADATA"; printf "rc=%s\\n" "$?"'),
      {
        PATH: `${binDir}:/usr/bin:/bin`,
        RCTF_RUN_ROOT: runRoot,
        WRITE_METADATA: metadata,
      }
    )
    expect(result.stdout).toContain('rc=1')
    expect(result.stderr).toContain('sanitizes to empty')
  })
})

describe('guest init: challenge environment', () => {
  test('cannot overwrite init internals or the reserved RCTF_* exports', async () => {
    const root = await tempRoot('rctf-guest-env-')
    const binDir = await fakeJqDir(root)
    const runRoot = path.join(root, 'rctf')
    const flagsDir = path.join(runRoot, 'flags')
    await mkdir(flagsDir, { recursive: true, mode: 0o700 })
    const service = path.join(root, 'service.sh')
    await writeFile(
      service,
      `#!/bin/sh
printf 'RCTF_FLAGS_DIR=%s\\n' "$RCTF_FLAGS_DIR"
printf 'RCTF_INSTANCE_ID=%s\\n' "$RCTF_INSTANCE_ID"
printf 'RCTF_HOSTNAME=%s\\n' "$RCTF_HOSTNAME"
printf 'NORMAL=%s\\n' "$NORMAL"
`,
      { mode: 0o755 }
    )
    const metadata = JSON.stringify({
      rctf: {
        version: 1,
        instanceId: 'real-instance',
        hostname: 'real-host',
        env: {
          FLAGS_DIR: '/challenge/flags',
          RCTF_FLAGS_DIR: '/challenge/reserved',
          RCTF_INSTANCE_ID: 'evil-instance',
          RCTF_HOSTNAME: 'evil-host',
          NORMAL: 'kept',
        },
        flags: [{ provider: 'main', flag: 'flag{env-test}' }],
      },
    })
    const result = await runSh(
      sourceInit(`
        instance_id=real-instance
        hostname=real-host
        write_env_file "$METADATA"
        printf 'INIT_FLAGS_DIR=%s\\n' "$FLAGS_DIR"
        write_flags "$METADATA"
        SERVICE=${shQuote(service)}
        run_service
      `),
      {
        PATH: `${binDir}:/usr/bin:/bin`,
        RCTF_RUN_ROOT: runRoot,
        METADATA: metadata,
      }
    )
    expect(result.code).toBe(0)
    const lines = result.stdout.trim().split('\n')
    expect(lines).toContain(`INIT_FLAGS_DIR=${flagsDir}`)
    expect(lines).toContain(`RCTF_FLAGS_DIR=${flagsDir}`)
    expect(lines).toContain('RCTF_INSTANCE_ID=real-instance')
    expect(lines).toContain('RCTF_HOSTNAME=real-host')
    expect(lines).toContain('NORMAL=kept')
    // Reserved keys are omitted from the service environment and logged.
    expect(result.stdout).not.toContain('/challenge/reserved')
    expect(result.stdout).not.toContain('evil-instance')
    expect(result.stderr).toContain('RCTF_ prefix is reserved')
    // Flags still land in init's own tmpfs directory, not the challenge path.
    expect(await readFile(path.join(flagsDir, 'main'), 'utf8')).toBe(
      'flag{env-test}'
    )
    await expect(readFile('/challenge/flags/main')).rejects.toThrow()
  })
})

describe('guest init: SERVICE is a legitimate challenge variable', () => {
  test('a challenge env key named SERVICE does not change the executable init selected', async () => {
    // Reproduced by review: init sourced the challenge env and THEN executed
    // $SERVICE, so a challenge variable named SERVICE replaced the real service.
    const root = await tempRoot('rctf-guest-svc-')
    const binDir = await fakeJqDir(root)
    const runRoot = path.join(root, 'rctf')
    await mkdir(path.join(runRoot, 'flags'), { recursive: true, mode: 0o700 })
    const service = path.join(root, 'real-service.sh')
    await writeFile(
      service,
      `#!/bin/sh\nprintf 'REAL-SERVICE SERVICE_ENV=%s\\n' "$SERVICE"\n`,
      { mode: 0o755 }
    )
    const metadata = JSON.stringify({
      rctf: {
        version: 1,
        instanceId: 'i',
        hostname: 'h',
        env: { SERVICE: '/bin/false' },
        flags: [],
      },
    })
    const result = await runSh(
      sourceInit(`
        instance_id=i
        hostname=h
        write_env_file "$METADATA"
        SERVICE=${shQuote(service)}
        run_service
      `),
      {
        PATH: `${binDir}:/usr/bin:/bin`,
        RCTF_RUN_ROOT: runRoot,
        METADATA: metadata,
      }
    )
    expect(result.code).toBe(0)
    // The selected executable ran, and SERVICE is still delivered as plain env.
    expect(result.stdout).toContain('REAL-SERVICE SERVICE_ENV=/bin/false')
  })
})

/** Minimal ELF header bytes with a chosen class and e_machine. */
const elfBinary = (
  machine: number,
  options: { bits?: 32 | 64 } = {}
): Buffer => {
  const bytes = Buffer.alloc(64)
  bytes.write('\x7fELF', 0, 'latin1')
  bytes[4] = (options.bits ?? 64) === 64 ? 2 : 1 // EI_CLASS
  bytes[5] = 1 // EI_DATA: little-endian
  bytes[6] = 1 // EI_VERSION
  bytes.writeUInt16LE(machine, 18) // e_machine
  return bytes
}

interface BuilderRun extends ShellResult {
  out: string
}

/** Run only the builder's jq check path with a fake mkfs.ext4. */
const runBuilderNegative = async (
  root: string,
  jqBytes: Buffer,
  extraArgs = ''
): Promise<BuilderRun> => {
  const caseRoot = await mkdtemp(path.join(root, 'case-'))
  const source = path.join(caseRoot, 'source')
  await mkdir(path.join(source, 'etc'), { recursive: true })
  await writeFile(path.join(source, 'etc', 'hostname'), 'guest\n')
  const fakeBin = path.join(caseRoot, 'bin')
  await mkdir(fakeBin, { recursive: true, mode: 0o700 })
  await writeFile(
    path.join(fakeBin, 'mkfs.ext4'),
    `#!/bin/sh
if [ "$1" = "-h" ]; then echo " -d"; exit 0; fi
exit 0
`,
    { mode: 0o755 }
  )
  const jqFile = path.join(caseRoot, 'jq-binary')
  await writeFile(jqFile, jqBytes)
  const out = path.join(caseRoot, 'rootfs.ext4')
  const result = await runSh(
    `${shQuote(BUILD)} --dir ${shQuote(source)} --out ${shQuote(out)} --jq ${shQuote(jqFile)} ${extraArgs}`,
    { PATH: `${fakeBin}:/usr/bin:/bin` }
  )
  return { ...result, out }
}

describe('guest build-rootfs', () => {
  test('never writes through a source symlink into the host', async () => {
    const root = await tempRoot('rctf-guest-build-')
    const outside = path.join(root, 'outside')
    const outsideRctf = path.join(root, 'outside-rctf')
    await mkdir(outside, { recursive: true })
    await mkdir(outsideRctf, { recursive: true })
    const sentinel = 'HOST SENTINEL: must not be touched\n'
    await writeFile(path.join(outside, 'init'), sentinel)
    await writeFile(path.join(outsideRctf, 'init'), sentinel)

    const source = path.join(root, 'source')
    await mkdir(path.join(source, 'etc'), { recursive: true })
    await writeFile(path.join(source, 'etc', 'hostname'), 'guest\n')
    await symlink(outside, path.join(source, 'sbin'))
    await symlink(outsideRctf, path.join(source, 'rctf'))

    const fakeBin = path.join(root, 'bin')
    const capture = path.join(root, 'capture')
    await mkdir(fakeBin, { recursive: true, mode: 0o700 })
    await mkdir(capture, { recursive: true, mode: 0o700 })
    const mkfsArgs = path.join(root, 'mkfs-args')
    await writeFile(
      path.join(fakeBin, 'mkfs.ext4'),
      `#!/bin/sh
if [ "$1" = "-h" ]; then echo " -d"; exit 0; fi
printf '%s\\n' "$@" > ${shQuote(mkfsArgs)}
prev=
for arg in "$@"; do
  if [ "$prev" = "-d" ]; then
    cp -a "$arg/rctf/init" ${shQuote(path.join(capture, 'init'))}
    cp -a "$arg/rctf/jq" ${shQuote(path.join(capture, 'jq'))}
  fi
  prev=$arg
done
exit 0
`,
      { mode: 0o755 }
    )
    const jqFile = path.join(root, 'jq-binary')
    const jqBytes = elfBinary(62)
    await writeFile(jqFile, jqBytes)
    const out = path.join(root, 'rootfs.ext4')

    const result = await runSh(
      `${shQuote(BUILD)} --dir ${shQuote(source)} --out ${shQuote(out)} --jq ${shQuote(jqFile)}`,
      { PATH: `${fakeBin}:/usr/bin:/bin` }
    )
    expect(result.stderr).toBe('')
    expect(result.code).toBe(0)

    // Neither source-controlled symlink was followed.
    expect(await readFile(path.join(outside, 'init'), 'utf8')).toBe(sentinel)
    expect(await readFile(path.join(outsideRctf, 'init'), 'utf8')).toBe(
      sentinel
    )
    await expect(lstat(path.join(outside, 'rctf'))).rejects.toThrow()

    // New layout: only /rctf/init and /rctf/jq.
    expect(await readFile(path.join(capture, 'init'), 'utf8')).toBe(
      await readFile(INIT, 'utf8')
    )
    expect((await readFile(path.join(capture, 'jq'))).equals(jqBytes)).toBe(
      true
    )
    await expect(
      readFile(path.join(capture, 'usr', 'bin', 'jq'))
    ).rejects.toThrow()
    const args = await readFile(mkfsArgs, 'utf8')
    expect(args).toContain('-d\n')
  })

  test('rejects a jq that is not an ELF binary', async () => {
    const root = await tempRoot('rctf-guest-build-')
    for (const jqBytes of [
      Buffer.from('#!/bin/sh\nexec jq "$@"\n'),
      Buffer.alloc(8),
    ]) {
      const result = await runBuilderNegative(root, jqBytes)
      expect(result.code).not.toBe(0)
      expect(result.stderr).toContain('not an ELF binary')
      await expect(lstat(result.out)).rejects.toThrow()
    }
  })

  test('rejects a 32-bit jq', async () => {
    const root = await tempRoot('rctf-guest-build-')
    const result = await runBuilderNegative(root, elfBinary(62, { bits: 32 }))
    expect(result.code).not.toBe(0)
    expect(result.stderr).toContain('32-bit ELF')
  })

  test('rejects a jq built for the wrong guest architecture', async () => {
    const root = await tempRoot('rctf-guest-build-')
    const result = await runBuilderNegative(root, elfBinary(183))
    expect(result.code).not.toBe(0)
    expect(result.stderr).toContain('wrong guest architecture')
  })

  test('accepts a matching architecture when --arch says so', async () => {
    const root = await tempRoot('rctf-guest-build-')
    const result = await runBuilderNegative(
      root,
      elfBinary(183),
      '--arch aarch64'
    )
    expect(result.code).toBe(0)
    expect(result.stderr).toBe('')
  })
})
