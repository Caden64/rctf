import { chmodSync } from 'node:fs'
import { X509Certificate } from 'node:crypto'
import { afterEach, describe, expect, test } from 'bun:test'
import {
  DEFAULT_CERT_EXPIRY_SKEW_MS,
  loadCaBundle,
  loadCaFile,
  loadTlsIdentity,
} from '../../src/util/tls'
import {
  cleanupDir,
  fixture,
  installFixtures,
  testDir,
  writePem,
  type FixturePaths,
} from './helpers'

const dirs: string[] = []

afterEach(() => {
  while (dirs.length > 0) cleanupDir(dirs.pop()!)
})

const setup = (): FixturePaths => {
  const dir = testDir()
  dirs.push(dir)
  return installFixtures(dir)
}

const label = 'test tls'

describe('loadTlsIdentity', () => {
  test('loads a matching certificate/key pair and CA bundle', () => {
    const paths = setup()
    const loaded = loadTlsIdentity(
      {
        certFile: paths.serverCert,
        keyFile: paths.serverKey,
        caFile: paths.caCert,
      },
      { label }
    )
    expect(loaded.cert).toBe(fixture('server.crt'))
    expect(loaded.key).toBe(fixture('server.key'))
    expect(loaded.ca).toBe(fixture('ca.crt'))
  })

  test('fails on a missing certificate file', () => {
    const paths = setup()
    expect(() =>
      loadTlsIdentity(
        { certFile: `${paths.dir}/missing.crt`, keyFile: paths.serverKey },
        { label }
      )
    ).toThrow(/cannot read certificate .*missing\.crt/)
  })

  test('fails on a missing private key file', () => {
    const paths = setup()
    expect(() =>
      loadTlsIdentity(
        { certFile: paths.serverCert, keyFile: `${paths.dir}/missing.key` },
        { label }
      )
    ).toThrow(/cannot read private key .*missing\.key/)
  })

  test('fails on garbage instead of a certificate', () => {
    const paths = setup()
    const certFile = writePem(paths.dir, 'garbage.crt', 'not a certificate\n')
    expect(() =>
      loadTlsIdentity({ certFile, keyFile: paths.serverKey }, { label })
    ).toThrow(/does not contain a PEM certificate/)
  })

  test('fails on a malformed PEM certificate block', () => {
    const paths = setup()
    const certFile = writePem(
      paths.dir,
      'malformed.crt',
      '-----BEGIN CERTIFICATE-----\nAAAA\n-----END CERTIFICATE-----\n'
    )
    expect(() =>
      loadTlsIdentity({ certFile, keyFile: paths.serverKey }, { label })
    ).toThrow(/invalid PEM certificate/)
  })

  test('fails on garbage instead of a private key', () => {
    const paths = setup()
    const keyFile = writePem(paths.dir, 'garbage.key', 'not a key\n')
    expect(() =>
      loadTlsIdentity({ certFile: paths.serverCert, keyFile }, { label })
    ).toThrow(/does not contain a PEM private key/)
  })

  test('fails on a malformed PEM private key block', () => {
    const paths = setup()
    const keyFile = writePem(
      paths.dir,
      'malformed.key',
      '-----BEGIN PRIVATE KEY-----\nAAAA\n-----END PRIVATE KEY-----\n'
    )
    expect(() =>
      loadTlsIdentity({ certFile: paths.serverCert, keyFile }, { label })
    ).toThrow(/invalid PEM private key/)
  })

  test('fails on an expired certificate', () => {
    const paths = setup()
    expect(() =>
      loadTlsIdentity(
        { certFile: paths.serverCert, keyFile: paths.serverKey },
        { label, now: Date.parse('2200-01-01T00:00:00Z') }
      )
    ).toThrow(/expired or expires within/)
  })

  test('fails on a certificate that is not valid yet', () => {
    const paths = setup()
    expect(() =>
      loadTlsIdentity(
        { certFile: paths.serverCert, keyFile: paths.serverKey },
        { label, now: Date.parse('2000-01-01T00:00:00Z') }
      )
    ).toThrow(/not valid yet/)
  })

  test('accepts a certificate exactly at notBefore and rejects one millisecond earlier', () => {
    const paths = setup()
    // There is no skew on notBefore (the margin applies to expiry only), so
    // the boundary is exact.
    const cert = new X509Certificate(fixture('server.crt'))
    const notBefore = Date.parse(cert.validFrom)
    expect(() =>
      loadTlsIdentity(
        { certFile: paths.serverCert, keyFile: paths.serverKey },
        { label, now: notBefore }
      )
    ).not.toThrow()
    expect(() =>
      loadTlsIdentity(
        { certFile: paths.serverCert, keyFile: paths.serverKey },
        { label, now: notBefore - 1 }
      )
    ).toThrow(/not valid yet/)
  })

  test('fails inside the expiry skew window', () => {
    const paths = setup()
    // Ask for a very large skew: the fixture is valid for decades, but the
    // check must still fail closed when the margin swallows the whole life.
    expect(() =>
      loadTlsIdentity(
        { certFile: paths.serverCert, keyFile: paths.serverKey },
        {
          label,
          now: Date.now(),
          expirySkewMs: 200 * 365 * 24 * 60 * 60 * 1000,
        }
      )
    ).toThrow(/expired or expires within/)
    expect(DEFAULT_CERT_EXPIRY_SKEW_MS).toBeGreaterThan(0)
  })

  test('fails when the private key does not match the certificate', () => {
    const paths = setup()
    expect(() =>
      loadTlsIdentity(
        { certFile: paths.serverCert, keyFile: paths.clientKey },
        { label }
      )
    ).toThrow(/does not match private key/)
  })

  test('fails on a group/world-readable private key', () => {
    const paths = setup()
    chmodSync(paths.serverKey, 0o644)
    expect(() =>
      loadTlsIdentity(
        { certFile: paths.serverCert, keyFile: paths.serverKey },
        { label }
      )
    ).toThrow(/private key .*group\/world-accessible/)
  })

  test('fails on a group-readable private key', () => {
    const paths = setup()
    chmodSync(paths.serverKey, 0o640)
    expect(() =>
      loadTlsIdentity(
        { certFile: paths.serverCert, keyFile: paths.serverKey },
        { label }
      )
    ).toThrow(/group\/world-accessible/)
  })

  test('fails on a group/world-readable certificate', () => {
    const paths = setup()
    chmodSync(paths.serverCert, 0o644)
    expect(() =>
      loadTlsIdentity(
        { certFile: paths.serverCert, keyFile: paths.serverKey },
        { label }
      )
    ).toThrow(/certificate .*group\/world-accessible/)
  })

  test('fails on a group/world-writable CA bundle', () => {
    const paths = setup()
    chmodSync(paths.caCert, 0o666)
    expect(() =>
      loadTlsIdentity(
        {
          certFile: paths.serverCert,
          keyFile: paths.serverKey,
          caFile: paths.caCert,
        },
        { label }
      )
    ).toThrow(/CA bundle .*group\/world-writable/)
  })

  test('accepts a world-readable (but not writable) CA bundle', () => {
    const paths = setup()
    chmodSync(paths.caCert, 0o644)
    expect(() =>
      loadTlsIdentity(
        {
          certFile: paths.serverCert,
          keyFile: paths.serverKey,
          caFile: paths.caCert,
        },
        { label }
      )
    ).not.toThrow()
  })

  test('never puts key or certificate bytes in error messages', () => {
    const paths = setup()
    let message = ''
    try {
      loadTlsIdentity(
        { certFile: paths.serverCert, keyFile: paths.clientKey },
        { label }
      )
    } catch (error) {
      message = error instanceof Error ? error.message : String(error)
    }
    expect(message).not.toBe('')
    for (const pem of [fixture('server.crt'), fixture('client.key')]) {
      const body = pem.split('\n')[1]!
      expect(message).not.toContain(body)
    }
    expect(message).not.toContain('PRIVATE KEY')
  })
})

describe('loadCaBundle', () => {
  test('accepts one or more PEM certificates', () => {
    const bundle = `${fixture('ca.crt')}${fixture('other-ca.crt')}`
    expect(loadCaBundle(bundle, { label, source: 'inline' })).toBe(bundle)
  })

  test('rejects an empty or garbage bundle', () => {
    expect(() => loadCaBundle('', { label, source: 'inline' })).toThrow(
      /does not contain a PEM certificate/
    )
    expect(() => loadCaBundle('hello', { label, source: 'inline' })).toThrow(
      /does not contain a PEM certificate/
    )
  })
})

describe('loadCaFile', () => {
  test('reads and validates a CA file', () => {
    const paths = setup()
    expect(loadCaFile(paths.caCert, { label })).toBe(fixture('ca.crt'))
  })
})
