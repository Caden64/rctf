/**
 * Shared TLS material loading for the controller <-> agent control plane.
 *
 * Everything here is fail-closed and runs at startup:
 * - files must be regular files owned by root or the current uid;
 * - private keys and leaf certificates must not be readable/writable by group
 *   or other (mode 0600 is the expected install);
 * - a CA bundle is public, but must not be writable by group/other;
 * - PEM must parse (node:crypto X509Certificate / createPrivateKey);
 * - the leaf certificate must be currently valid (small clock-skew margin) and
 *   its public key must match the private key.
 *
 * Errors name the file and the reason, never the PEM/key bytes, so callers can
 * log the message safely.
 */
import { X509Certificate, createPrivateKey, type KeyObject } from 'node:crypto'
import { closeSync, fstatSync, openSync, readFileSync } from 'node:fs'

/** How close to `notAfter` a certificate may be before startup fails. */
export const DEFAULT_CERT_EXPIRY_SKEW_MS = 60_000

export interface TlsFileConfig {
  certFile: string
  keyFile: string
  /** CA bundle used to verify peers (server: client certs, client: server). */
  caFile?: string
}

export interface LoadedTlsIdentity {
  /** PEM certificate chain (leaf first). */
  cert: string
  /** PEM private key. */
  key: string
  /** PEM CA bundle, when configured. */
  ca?: string
}

/** The TLS options subset both `Bun.serve` and `fetch` accept. */
export interface LoadedTlsMaterial {
  cert?: string
  key?: string
  ca?: string
}

export interface TlsValidationOptions {
  /** Prefix for every error, e.g. `host fc1 client certificate`. */
  label: string
  /** Injectable clock (ms since epoch) for tests. */
  now?: number
  /** Reject certificates expiring within this window. */
  expirySkewMs?: number
}

const currentUid = (): number =>
  typeof process.getuid === 'function' ? process.getuid() : 0

type FileKind = 'key' | 'cert' | 'ca'

const fileWhat = (kind: FileKind): string =>
  kind === 'key' ? 'private key' : kind === 'cert' ? 'certificate' : 'CA bundle'

/**
 * Read a file through a single descriptor so the stat and the bytes describe
 * the same inode (no validate-then-reopen race).
 */
const readCheckedFile = (
  path: string,
  kind: FileKind,
  label: string
): string => {
  const what = fileWhat(kind)
  let fd: number
  try {
    fd = openSync(path, 'r')
  } catch (error) {
    throw new Error(
      `${label}: cannot read ${what} ${path}: ${
        error instanceof Error ? error.message : String(error)
      }`
    )
  }
  try {
    const stat = fstatSync(fd)
    if (!stat.isFile()) {
      throw new Error(`${label}: ${what} ${path} is not a regular file`)
    }
    const uid = currentUid()
    if (stat.uid !== 0 && stat.uid !== uid) {
      throw new Error(
        `${label}: ${what} ${path} is owned by uid ${stat.uid}, expected root or ${uid}`
      )
    }
    // A key or leaf certificate is secret-adjacent: require 0600 (no group or
    // other bits at all). A CA bundle is public, so only write access by
    // group/other is unsafe.
    const forbidden = kind === 'ca' ? 0o022 : 0o077
    if ((stat.mode & forbidden) !== 0) {
      const hint = kind === 'ca' ? 'chmod 644' : 'chmod 600'
      throw new Error(
        `${label}: ${what} ${path} must not be ${
          kind === 'ca' ? 'group/world-writable' : 'group/world-accessible'
        } (mode ${(stat.mode & 0o777).toString(8)}); ${hint} ${path}`
      )
    }
    return readFileSync(fd).toString('utf8')
  } finally {
    closeSync(fd)
  }
}

const CERT_PEM_BLOCK =
  /-----BEGIN CERTIFICATE-----[\s\S]*?-----END CERTIFICATE-----/g

const parseCertificates = (
  pem: string,
  label: string,
  source: string
): X509Certificate[] => {
  const blocks = pem.match(CERT_PEM_BLOCK) ?? []
  if (blocks.length === 0) {
    throw new Error(
      `${label}: ${source} does not contain a PEM certificate (-----BEGIN CERTIFICATE-----)`
    )
  }
  return blocks.map(block => {
    try {
      return new X509Certificate(block)
    } catch (error) {
      throw new Error(
        `${label}: invalid PEM certificate in ${source}: ${
          error instanceof Error ? error.message : String(error)
        }`
      )
    }
  })
}

const parsePrivateKey = (
  pem: string,
  label: string,
  source: string
): KeyObject => {
  if (!/-----BEGIN (?:[A-Z ]+ )?PRIVATE KEY-----/.test(pem)) {
    throw new Error(
      `${label}: ${source} does not contain a PEM private key (-----BEGIN ... PRIVATE KEY-----)`
    )
  }
  try {
    return createPrivateKey(pem)
  } catch (error) {
    throw new Error(
      `${label}: invalid PEM private key in ${source}: ${
        error instanceof Error ? error.message : String(error)
      }`
    )
  }
}

const assertCertificateValid = (
  cert: X509Certificate,
  label: string,
  source: string,
  now: number,
  expirySkewMs: number
): void => {
  const notBefore = Date.parse(cert.validFrom)
  const notAfter = Date.parse(cert.validTo)
  if (!Number.isFinite(notBefore) || !Number.isFinite(notAfter)) {
    throw new Error(
      `${label}: certificate ${source} has unreadable validity dates`
    )
  }
  // No skew on notBefore: a not-yet-valid certificate is rejected outright.
  // A peer would refuse it during the handshake anyway, which would produce a
  // listener that starts but cannot communicate. The skew margin applies to
  // expiry only, where a certificate that just expired must not race a
  // restart into accepting it.
  if (now < notBefore) {
    throw new Error(
      `${label}: certificate ${source} is not valid yet (notBefore ${cert.validFrom})`
    )
  }
  if (now + expirySkewMs >= notAfter) {
    throw new Error(
      `${label}: certificate ${source} is expired or expires within ${
        expirySkewMs / 1000
      }s (notAfter ${cert.validTo})`
    )
  }
}

const assertKeyMatchesCertificate = (
  cert: X509Certificate,
  key: KeyObject,
  label: string,
  certPath: string,
  keyPath: string
): void => {
  let matches: boolean
  try {
    // X509Certificate.checkPrivateKey compares the public halves (Node and
    // Bun 1.4.4 both implement it).
    matches = cert.checkPrivateKey(key)
  } catch (error) {
    throw new Error(
      `${label}: cannot compare certificate ${certPath} with key ${keyPath}: ${
        error instanceof Error ? error.message : String(error)
      }`
    )
  }
  if (!matches) {
    throw new Error(
      `${label}: certificate ${certPath} does not match private key ${keyPath}`
    )
  }
}

/** Validate a PEM CA bundle (one or more certificates). */
export const loadCaBundle = (
  pem: string,
  opts: { label: string; source: string }
): string => {
  parseCertificates(pem, opts.label, opts.source)
  return pem
}

/** Validate and read a CA bundle file. */
export const loadCaFile = (path: string, opts: { label: string }): string =>
  loadCaBundle(readCheckedFile(path, 'ca', opts.label), {
    label: opts.label,
    source: path,
  })

/**
 * Load a certificate/key pair (and optional CA bundle) from disk, validating
 * everything a startup can check before a listener or client uses it.
 */
export const loadTlsIdentity = (
  files: TlsFileConfig,
  opts: TlsValidationOptions
): LoadedTlsIdentity => {
  const now = opts.now ?? Date.now()
  const expirySkewMs = opts.expirySkewMs ?? DEFAULT_CERT_EXPIRY_SKEW_MS
  const certPem = readCheckedFile(files.certFile, 'cert', opts.label)
  const keyPem = readCheckedFile(files.keyFile, 'key', opts.label)
  const certificates = parseCertificates(certPem, opts.label, files.certFile)
  const leaf = certificates[0]!
  const key = parsePrivateKey(keyPem, opts.label, files.keyFile)

  assertCertificateValid(leaf, opts.label, files.certFile, now, expirySkewMs)
  assertKeyMatchesCertificate(
    leaf,
    key,
    opts.label,
    files.certFile,
    files.keyFile
  )

  const loaded: LoadedTlsIdentity = { cert: certPem, key: keyPem }
  if (files.caFile !== undefined) {
    loaded.ca = loadCaFile(files.caFile, { label: opts.label })
  }
  return loaded
}
