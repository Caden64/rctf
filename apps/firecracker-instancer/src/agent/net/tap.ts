import type { CommandRunner, NetLease } from '../../interfaces'
import type { Logger } from '../../log'
import { TAP_NAME_REGEX, assertTapName, isValidIpv4 } from './validate'

const DEFAULT_TIMEOUT_MS = 15_000

export const TAP_PREFIX = 'fctap'
export const TAP_LINK_REGEX = /^fctap/

/** `Cannot find device "x"` / ENODEV after a link disappeared underneath us. */
const ABSENT_LINK =
  /cannot find device|does not exist|no such device|no such file|ENODEV/i

/**
 * Per-artifact ownership of one `create()` call. The manager passes this in
 * and rolls back ONLY what is still false-free, so a failed allocation can
 * never delete an interface it did not create (e.g. an operator's pre-existing
 * `fctapN`, or one belonging to another lease).
 */
export interface TapOwnership {
  tapCreated: boolean
  addressAdded: boolean
  linkUp: boolean
}

export const newTapOwnership = (): TapOwnership => ({
  tapCreated: false,
  addressAdded: false,
  linkUp: false,
})

/**
 * The name is already taken by an interface this allocation did not create.
 * Nothing was changed on the host; the manager must skip/quarantine the index
 * and must NOT delete the interface.
 */
export class TapNameConflictError extends Error {
  constructor(readonly tapName: string) {
    super(
      `interface ${tapName} already exists on the host and does not belong to this lease; refusing to reuse or delete it`
    )
    this.name = 'TapNameConflictError'
  }
}

export interface TapInspection {
  exists: boolean
  up: boolean
  /** IPv4 CIDRs configured on the link (`10.200.0.1/30`). */
  addresses: string[]
}

const isConflict = (output: string): boolean =>
  /File exists|exists/i.test(output) &&
  /TUNSETIFF|tuntap|device|interface/i.test(output)

/**
 * Thin, argv-only wrapper around `ip(8)`. Never uses a shell, never retries a
 * failed mutation, and only talks to the injected runner (tests use a fake).
 */
export class TapController {
  constructor(
    private readonly runner: CommandRunner,
    private readonly tapOwner: { user?: string; group?: string } = {},
    private readonly logger?: Logger
  ) {}

  private async mustRun(argv: string[]): Promise<void> {
    const result = await this.runner.run(argv, {
      timeoutMs: DEFAULT_TIMEOUT_MS,
    })
    if (result.code !== 0) {
      throw new Error(
        `${argv.join(' ')} failed (${result.code}): ${result.stderr.trim() || result.stdout.trim() || 'no output'}`
      )
    }
  }

  private async run(argv: string[]): Promise<{ code: number; text: string }> {
    const result = await this.runner.run(argv, {
      timeoutMs: DEFAULT_TIMEOUT_MS,
    })
    return {
      code: result.code,
      text: `${result.stdout}\n${result.stderr}`.trim(),
    }
  }

  /** Inspect a link without mutating it. Absent links are not an error. */
  async inspect(tapName: string): Promise<TapInspection> {
    assertTapName(tapName)
    const link = await this.run(['ip', '-o', 'link', 'show', 'dev', tapName])
    if (link.code !== 0) {
      if (ABSENT_LINK.test(link.text)) {
        return { exists: false, up: false, addresses: [] }
      }
      throw new Error(
        `ip -o link show dev ${tapName} failed (${link.code}): ${link.text || 'no output'}`
      )
    }
    const up = /state UP|[,<]UP[,>]/.test(link.text)
    const addr = await this.run([
      'ip',
      '-o',
      '-4',
      'addr',
      'show',
      'dev',
      tapName,
    ])
    if (addr.code !== 0) {
      throw new Error(
        `ip -o -4 addr show dev ${tapName} failed (${addr.code}): ${addr.text || 'no output'}`
      )
    }
    const addresses = [...addr.text.matchAll(/inet\s+([0-9./]+)/g)]
      .map(match => match[1])
      .filter((cidr): cidr is string => cidr !== undefined)
    return { exists: true, up, addresses }
  }

  /**
   * Create a fresh tap, assign the host side of the /30 and bring it up.
   * Ownership flags are recorded as each step succeeds; a `File exists` from
   * `ip tuntap add` means the name belongs to somebody else and raises
   * `TapNameConflictError` without touching the link.
   */
  async create(lease: NetLease, owned?: TapOwnership): Promise<void> {
    const tap = assertTapName(lease.tapName)
    if (!isValidIpv4(lease.hostIp) || lease.prefixLength !== 30) {
      throw new Error(`invalid lease address for ${lease.instanceId}`)
    }
    const argv = ['ip', 'tuntap', 'add', 'dev', tap, 'mode', 'tap']
    if (this.tapOwner.user !== undefined) {
      argv.push('user', this.tapOwner.user)
    }
    if (this.tapOwner.group !== undefined) {
      argv.push('group', this.tapOwner.group)
    }
    const added = await this.runner.run(argv, {
      timeoutMs: DEFAULT_TIMEOUT_MS,
    })
    if (added.code !== 0) {
      const output = `${added.stderr}\n${added.stdout}`
      if (isConflict(output)) {
        throw new TapNameConflictError(tap)
      }
      throw new Error(
        `${argv.join(' ')} failed (${added.code}): ${output.trim() || 'no output'}`
      )
    }
    if (owned !== undefined) {
      owned.tapCreated = true
    }
    await this.mustRun([
      'ip',
      'addr',
      'add',
      `${lease.hostIp}/${lease.prefixLength}`,
      'dev',
      tap,
    ])
    if (owned !== undefined) {
      owned.addressAdded = true
    }
    await this.mustRun(['ip', 'link', 'set', 'dev', tap, 'up'])
    if (owned !== undefined) {
      owned.linkUp = true
    }
  }

  /**
   * Idempotent create used by `restore`: inspect first, create/complete only
   * what is missing, and always leave the link up.
   */
  async ensure(lease: NetLease, owned?: TapOwnership): Promise<void> {
    const tap = assertTapName(lease.tapName)
    if (!isValidIpv4(lease.hostIp) || lease.prefixLength !== 30) {
      throw new Error(`invalid lease address for ${lease.instanceId}`)
    }
    const link = await this.inspect(tap)
    if (!link.exists) {
      await this.create(lease, owned)
      return
    }
    const cidr = `${lease.hostIp}/${lease.prefixLength}`
    if (!link.addresses.includes(cidr)) {
      await this.mustRun(['ip', 'addr', 'add', cidr, 'dev', tap])
      if (owned !== undefined) {
        owned.addressAdded = true
      }
    }
    await this.mustRun(['ip', 'link', 'set', 'dev', tap, 'up'])
    if (owned !== undefined) {
      owned.linkUp = true
    }
  }

  /**
   * Delete a tap. Missing links are not an error; every other failure is
   * propagated so `release()` keeps the lease reserved and can be retried.
   */
  async remove(tapName: string): Promise<void> {
    if (!TAP_NAME_REGEX.test(tapName)) {
      throw new Error(`refusing to delete non-agent interface: ${tapName}`)
    }
    const result = await this.runner.run(
      ['ip', 'link', 'del', 'dev', tapName],
      {
        timeoutMs: DEFAULT_TIMEOUT_MS,
      }
    )
    if (result.code === 0) {
      return
    }
    // A nonzero exit alone is not proof of absence: confirm with a fresh
    // `ip link show`. Only a confirmed absence is tolerated.
    let link: TapInspection
    try {
      link = await this.inspect(tapName)
    } catch (error) {
      throw new Error(
        `ip link del dev ${tapName} failed (${result.code}: ${result.stderr.trim() || result.stdout.trim() || 'no output'}) and absence could not be confirmed: ${error instanceof Error ? error.message : String(error)}`
      )
    }
    if (!link.exists) {
      this.logger?.debug(
        { tap: tapName, code: result.code },
        'tap was already absent'
      )
      return
    }
    throw new Error(
      `ip link del dev ${tapName} failed (${result.code}: ${result.stderr.trim() || result.stdout.trim() || 'no output'})`
    )
  }

  /** All host interfaces whose name starts with `fctap` (orphan detection). */
  async listAgentLinks(): Promise<string[]> {
    const result = await this.runner.run(['ip', '-o', 'link', 'show'], {
      timeoutMs: DEFAULT_TIMEOUT_MS,
    })
    if (result.code !== 0) {
      throw new Error(
        `ip -o link show failed (${result.code}): ${result.stderr.trim() || 'no output'}`
      )
    }
    const names: string[] = []
    for (const line of result.stdout.split('\n')) {
      const match = /^\d+:\s+([^\s:@]+)/.exec(line)
      if (match?.[1] !== undefined && TAP_LINK_REGEX.test(match[1])) {
        names.push(match[1])
      }
    }
    return names
  }
}
