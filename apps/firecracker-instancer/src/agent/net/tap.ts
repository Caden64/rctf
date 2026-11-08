import type { CommandRunner, NetLease } from '../../interfaces'
import type { Logger } from '../../log'
import { TAP_NAME_REGEX, assertTapName, isValidIpv4 } from './validate'

const DEFAULT_TIMEOUT_MS = 15_000

export const TAP_PREFIX = 'fctap'
export const TAP_LINK_REGEX = /^fctap/

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

  /** Create a fresh tap, assign the host side of the /30 and bring it up. */
  async create(lease: NetLease): Promise<void> {
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
    await this.mustRun(argv)
    await this.mustRun([
      'ip',
      'addr',
      'add',
      `${lease.hostIp}/${lease.prefixLength}`,
      'dev',
      tap,
    ])
    await this.mustRun(['ip', 'link', 'set', 'dev', tap, 'up'])
  }

  /**
   * Idempotent create used by `restore`: inspect first, create/complete only
   * what is missing, and always leave the link up.
   */
  async ensure(lease: NetLease): Promise<void> {
    const tap = assertTapName(lease.tapName)
    if (!isValidIpv4(lease.hostIp) || lease.prefixLength !== 30) {
      throw new Error(`invalid lease address for ${lease.instanceId}`)
    }
    const link = await this.runner.run(
      ['ip', '-o', 'link', 'show', 'dev', tap],
      {
        timeoutMs: DEFAULT_TIMEOUT_MS,
      }
    )
    if (link.code !== 0) {
      await this.create(lease)
      return
    }
    const cidr = `${lease.hostIp}/${lease.prefixLength}`
    const addr = await this.runner.run(
      ['ip', '-o', '-4', 'addr', 'show', 'dev', tap],
      { timeoutMs: DEFAULT_TIMEOUT_MS }
    )
    if (addr.code !== 0 || !addr.stdout.includes(`${cidr} `)) {
      await this.mustRun(['ip', 'addr', 'add', cidr, 'dev', tap])
    }
    await this.mustRun(['ip', 'link', 'set', 'dev', tap, 'up'])
  }

  /**
   * Delete a tap. Missing links are not an error (`ip link del` returns
   * non-zero then), so release/rollback stay idempotent.
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
    if (result.code !== 0) {
      this.logger?.debug(
        { tap: tapName, code: result.code, stderr: result.stderr.trim() },
        'ip link del reported a missing/failed link (tolerated)'
      )
    }
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
