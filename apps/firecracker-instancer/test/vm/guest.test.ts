import { afterEach, describe, expect, test } from 'bun:test'
import {
  lstat,
  mkdir,
  mkdtemp,
  readFile,
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
  await writeFile(
    path.join(binDir, 'jq'),
    `#!/bin/sh\nexec ${shQuote(process.execPath)} ${shQuote(path.join(import.meta.dir, 'fake-jq.ts'))} "$@"\n`,
    { mode: 0o755 }
  )
  return binDir
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
    await writeFile(jqFile, 'fake jq bytes\n')
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
    expect(await readFile(path.join(capture, 'jq'), 'utf8')).toBe(
      'fake jq bytes\n'
    )
    await expect(
      readFile(path.join(capture, 'usr', 'bin', 'jq'))
    ).rejects.toThrow()
    const args = await readFile(mkfsArgs, 'utf8')
    expect(args).toContain('-d\n')
  })
})
