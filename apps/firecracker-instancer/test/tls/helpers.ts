import {
  chmodSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs'
import { join } from 'node:path'

export const testDir = (): string =>
  mkdtempSync(join('/tmp/opencode', 'fc-tls-'))

export const cleanupDir = (dir: string): void => {
  rmSync(dir, { recursive: true, force: true })
}

/** Read a committed, test-only PEM fixture. */
export const fixture = (name: string): string =>
  readFileSync(new URL(`./fixtures/${name}`, import.meta.url), 'utf8')

export const writePem = (
  dir: string,
  name: string,
  contents: string,
  mode = 0o600
): string => {
  const path = join(dir, name)
  writeFileSync(path, contents, { mode })
  // writeFileSync only applies `mode` when creating; make it explicit anyway.
  chmodSync(path, mode)
  return path
}

export interface FixturePaths {
  dir: string
  caCert: string
  serverCert: string
  serverKey: string
  clientCert: string
  clientKey: string
  otherCaCert: string
}

/**
 * Copy the fixtures into a fresh directory with install-like modes. Git does
 * not preserve 0600, so tests must not rely on the checkout's modes.
 */
export const installFixtures = (dir: string): FixturePaths => ({
  dir,
  caCert: writePem(dir, 'ca.crt', fixture('ca.crt'), 0o644),
  serverCert: writePem(dir, 'server.crt', fixture('server.crt')),
  serverKey: writePem(dir, 'server.key', fixture('server.key')),
  clientCert: writePem(dir, 'client.crt', fixture('client.crt')),
  clientKey: writePem(dir, 'client.key', fixture('client.key')),
  otherCaCert: writePem(dir, 'other-ca.crt', fixture('other-ca.crt'), 0o644),
})

export const opensslAvailable = (): boolean =>
  Bun.spawnSync(['openssl', 'version'], {
    stdout: 'pipe',
    stderr: 'pipe',
  }).exitCode === 0

const run = (cwd: string, args: string[]): void => {
  const result = Bun.spawnSync(args, {
    cwd,
    stdout: 'pipe',
    stderr: 'pipe',
  })
  if (result.exitCode !== 0) {
    throw new Error(
      `${args.join(' ')} failed (${result.exitCode}): ${result.stderr.toString()}`
    )
  }
}

export interface EphemeralPki extends FixturePaths {
  /** Client certificate/key signed by the OTHER CA (must be rejected). */
  foreignClientCert: string
  foreignClientKey: string
  /** CA certificate of the other CA (wrong trust anchor). */
  otherCaKey: string
}

/**
 * Generate a throwaway CA, a server leaf for 127.0.0.1 and client leaves with
 * the openssl CLI. One-day validity is enough for a test run and never needs
 * wall-clock freezing.
 */
export const generateEphemeralPki = (dir: string): EphemeralPki => {
  const cert = (name: string): void => {
    run(dir, [
      'openssl',
      'req',
      '-x509',
      '-newkey',
      'rsa:2048',
      '-nodes',
      '-keyout',
      `${name}.key`,
      '-out',
      `${name}.crt`,
      '-days',
      '1',
      '-subj',
      `/CN=rctf-firecracker-test-${name}`,
    ])
  }
  const leaf = (
    name: string,
    ca: string,
    ext: string,
    subject: string
  ): void => {
    run(dir, [
      'openssl',
      'req',
      '-newkey',
      'rsa:2048',
      '-nodes',
      '-keyout',
      `${name}.key`,
      '-out',
      `${name}.csr`,
      '-subj',
      subject,
    ])
    writeFileSync(join(dir, `${name}.ext`), ext)
    run(dir, [
      'openssl',
      'x509',
      '-req',
      '-in',
      `${name}.csr`,
      '-CA',
      `${ca}.crt`,
      '-CAkey',
      `${ca}.key`,
      '-CAcreateserial',
      '-out',
      `${name}.crt`,
      '-days',
      '1',
      '-extfile',
      `${name}.ext`,
    ])
  }

  cert('ca')
  cert('other-ca')
  leaf(
    'server',
    'ca',
    'subjectAltName=IP:127.0.0.1,DNS:localhost\n',
    '/CN=127.0.0.1'
  )
  leaf(
    'client',
    'ca',
    'extendedKeyUsage=clientAuth\n',
    '/CN=rctf-firecracker-test-controller'
  )
  leaf(
    'foreign-client',
    'other-ca',
    'extendedKeyUsage=clientAuth\n',
    '/CN=rctf-firecracker-test-foreign-controller'
  )

  return {
    dir,
    caCert: writePem(
      dir,
      'ca.crt',
      readFileSync(join(dir, 'ca.crt'), 'utf8'),
      0o644
    ),
    serverCert: writePem(
      dir,
      'server.crt',
      readFileSync(join(dir, 'server.crt'), 'utf8')
    ),
    serverKey: writePem(
      dir,
      'server.key',
      readFileSync(join(dir, 'server.key'), 'utf8')
    ),
    clientCert: writePem(
      dir,
      'client.crt',
      readFileSync(join(dir, 'client.crt'), 'utf8')
    ),
    clientKey: writePem(
      dir,
      'client.key',
      readFileSync(join(dir, 'client.key'), 'utf8')
    ),
    foreignClientCert: writePem(
      dir,
      'foreign-client.crt',
      readFileSync(join(dir, 'foreign-client.crt'), 'utf8')
    ),
    foreignClientKey: writePem(
      dir,
      'foreign-client.key',
      readFileSync(join(dir, 'foreign-client.key'), 'utf8')
    ),
    otherCaCert: writePem(
      dir,
      'other-ca.crt',
      readFileSync(join(dir, 'other-ca.crt'), 'utf8'),
      0o644
    ),
    otherCaKey: join(dir, 'other-ca.key'),
  }
}
