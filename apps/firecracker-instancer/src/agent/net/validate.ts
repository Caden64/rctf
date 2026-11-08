/**
 * Strict allow-list validation for everything this track interpolates into a
 * privileged argument (ip/nft) or a Traefik rule/file name. Nothing here is
 * allowed to be a "best effort" sanitiser: callers must reject, never repair.
 */

/** Dotted-quad IPv4, no leading zeros, no shorthand. */
export const IPV4_REGEX =
  /^(?:(?:25[0-5]|2[0-4]\d|1\d\d|[1-9]?\d)\.){3}(?:25[0-5]|2[0-4]\d|1\d\d|[1-9]?\d)$/

/** Lowercase, colon separated MAC. */
export const MAC_ADDRESS_REGEX = /^[0-9a-f]{2}(?::[0-9a-f]{2}){5}$/

/** Linux interface names: 1..15 bytes, no slash/whitespace/quotes. */
export const IFACE_NAME_REGEX = /^[A-Za-z0-9_.-]{1,15}$/

/** Tap names this agent creates: `fctap` + allocation index. */
export const TAP_NAME_REGEX = /^fctap\d{1,10}$/

/** Strict fctap prefix (also used to spot stray taps for orphan cleanup). */
export const TAP_PREFIX_REGEX = /^fctap/

/** `ip tuntap add ... user/group` accepts a name or a numeric uid/gid. */
export const USER_GROUP_REGEX = /^[A-Za-z0-9_][A-Za-z0-9_.-]{0,31}$/

/** Traefik entrypoint names. */
export const ENTRYPOINT_REGEX = /^[A-Za-z0-9_.-]{1,64}$/

/** One DNS label, RFC 1035 length. Lowercase only (config is normalised by us). */
export const DNS_LABEL_GENERIC_REGEX = /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/

export const isValidIpv4 = (value: string): boolean => IPV4_REGEX.test(value)

/** Parse a dotted quad into an unsigned 32 bit number, or undefined. */
export const parseIpv4 = (value: string): number | undefined => {
  if (!IPV4_REGEX.test(value)) {
    return undefined
  }
  const [a = 0, b = 0, c = 0, d = 0] = value.split('.').map(Number)
  return ((a << 24) | (b << 16) | (c << 8) | d) >>> 0
}

export const formatIpv4 = (value: number): string =>
  [
    value >>> 24,
    (value >>> 16) & 0xff,
    (value >>> 8) & 0xff,
    value & 0xff,
  ].join('.')

export interface Ipv4Cidr {
  /** First address of the network (host bits are required to be zero). */
  base: number
  prefixLength: number
  /** Number of addresses in the CIDR. */
  size: number
  /** `true` when the supplied address is not aligned to its prefix. */
  aligned: boolean
}

/**
 * Parse an IPv4 CIDR. Rejects host bits set (e.g. `10.0.0.5/24`) so the
 * per-VM /30 carving is deterministic instead of silently rounding down.
 */
export const parseIpv4Cidr = (value: string): Ipv4Cidr | undefined => {
  const slash = value.indexOf('/')
  if (slash <= 0 || slash !== value.lastIndexOf('/')) {
    return undefined
  }
  const address = parseIpv4(value.slice(0, slash))
  const prefixText = value.slice(slash + 1)
  if (address === undefined || !/^\d{1,2}$/.test(prefixText)) {
    return undefined
  }
  const prefixLength = Number(prefixText)
  if (prefixLength < 1 || prefixLength > 32) {
    return undefined
  }
  const mask =
    prefixLength === 32 ? 0xffffffff : (0xffffffff << (32 - prefixLength)) >>> 0
  const base = (address & mask) >>> 0
  return {
    base,
    prefixLength,
    size: 2 ** (32 - prefixLength),
    aligned: base === address,
  }
}

export const isValidIpv4Cidr = (value: string): boolean => {
  const parsed = parseIpv4Cidr(value)
  return parsed !== undefined && parsed.aligned
}

export const isValidMacAddress = (value: string): boolean =>
  MAC_ADDRESS_REGEX.test(value)

export const isValidIfaceName = (value: string): boolean =>
  IFACE_NAME_REGEX.test(value)

/** A hostname (no trailing dot): 1..253 chars, lowercase DNS labels. */
export const isValidHostname = (value: string): boolean => {
  if (value.length === 0 || value.length > 253) {
    return false
  }
  return value.split('.').every(label => DNS_LABEL_GENERIC_REGEX.test(label))
}

export const isValidDomain = isValidHostname

export const isValidPort = (value: number): boolean =>
  Number.isInteger(value) && value >= 1 && value <= 65535

export const assertInstanceId = (value: string): string => {
  // Duplicated from @rctf/firecracker-protocol on purpose: this module must not
  // depend on config parsing order, and the regex is frozen there.
  if (!/^[a-z0-9]{16,32}$/.test(value)) {
    throw new Error(`invalid instance id: ${JSON.stringify(value)}`)
  }
  return value
}

export const assertTapName = (value: string): string => {
  if (!TAP_NAME_REGEX.test(value)) {
    throw new Error(`invalid tap name: ${JSON.stringify(value)}`)
  }
  return value
}

export const assertIfaceName = (value: string): string => {
  if (!IFACE_NAME_REGEX.test(value) || TAP_PREFIX_REGEX.test(value)) {
    throw new Error(`invalid network interface: ${JSON.stringify(value)}`)
  }
  return value
}

export const assertIpv4 = (value: string): string => {
  if (!isValidIpv4(value)) {
    throw new Error(`invalid IPv4 address: ${JSON.stringify(value)}`)
  }
  return value
}

export const assertPort = (value: number): number => {
  if (!isValidPort(value)) {
    throw new Error(`invalid port: ${JSON.stringify(value)}`)
  }
  return value
}

export const assertHostname = (value: string): string => {
  if (!isValidHostname(value)) {
    throw new Error(`invalid hostname: ${JSON.stringify(value)}`)
  }
  return value
}

/** Random, unicast, locally administered MAC (`02:...`). */
export const randomGuestMac = (): string => {
  const bytes = crypto.getRandomValues(new Uint8Array(6))
  bytes[0] = ((bytes[0] ?? 0) & 0xfc) | 0x02
  return [...bytes].map(byte => byte.toString(16).padStart(2, '0')).join(':')
}
