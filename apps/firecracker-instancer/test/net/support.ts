import { mkdir, mkdtemp } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type {
  CommandResult,
  CommandRunner,
  NetLease,
  NetExposeRequest,
} from '../../src/interfaces'
import {
  networkConfigSchema,
  type NetworkConfig,
} from '../../src/agent/net/config'
import { tapAlias } from '../../src/agent/net/tap'

export interface FakeCall {
  argv: string[]
  stdin?: string
}

export type FakeLinkKind = 'tap' | 'dummy' | 'other'

interface FakeLink {
  addresses: Set<string>
  up: boolean
  kind: FakeLinkKind
  alias: string | undefined
}

/** One tracked conntrack flow. Selectors are matched as a conjunction. */
export interface FakeFlow {
  proto?: string
  origSrc: string
  origDst: string
  origPortDst?: number
  replySrc: string
  replyDst: string
  replyPortSrc?: number
}

export interface SeedTapOptions {
  kind?: FakeLinkKind
  alias?: string
}

const ok = (stdout = ''): CommandResult => ({ code: 0, stdout, stderr: '' })
const fail = (stderr: string): CommandResult => ({
  code: 1,
  stdout: '',
  stderr,
})

/**
 * Recording fake for `ip`/`nft`/`conntrack`. Never touches the host. It models
 * interface type/alias (so durable ownership is testable without a namespace)
 * and conntrack entries by tuple (so deletions can be asserted exactly).
 *
 * `failAt` injects a failure into exactly the Nth runner call (1-based);
 * `failMatch` injects at a semantic step. Every other call is simulated
 * normally so rollback paths can complete.
 */
export class FakeHost implements CommandRunner {
  readonly calls: FakeCall[] = []
  readonly links = new Map<string, FakeLink>()
  readonly flows: FakeFlow[] = []
  nftText = ''
  nftWrites = 0
  failAt: number | undefined
  failMatch: ((argv: readonly string[]) => boolean) | undefined
  nftOk = true
  ipOk = true
  conntrackOk = true
  /** `conntrack -D` reports "0 flow entries have been deleted" (exit 1). */
  conntrackEmpty = false
  /** Any conntrack delete fails with this stderr (simulates EPERM etc.). */
  conntrackFlushError: string | undefined
  /** Fail `ip link del dev <name>` for exactly this device. */
  failDeleteTap: string | undefined

  seedTap(
    name: string,
    addresses: string[] = [],
    up = true,
    options: SeedTapOptions = {}
  ): void {
    this.links.set(name, {
      addresses: new Set(addresses),
      up,
      kind: options.kind ?? 'dummy',
      alias: options.alias,
    })
  }

  seedTapAsAgent(name: string, addresses: string[] = [], up = true): void {
    this.seedTap(name, addresses, up, {
      kind: 'tap',
      alias: tapAlias('rctf-fc'),
    })
  }

  seedFlow(flow: FakeFlow): void {
    this.flows.push({ ...flow })
  }

  async run(
    argv: readonly string[],
    opts: { timeoutMs?: number; stdin?: string } = {}
  ): Promise<CommandResult> {
    const call: FakeCall = { argv: [...argv] }
    if (opts.stdin !== undefined) {
      call.stdin = opts.stdin
    }
    this.calls.push(call)
    if (this.failAt !== undefined && this.calls.length === this.failAt) {
      return fail('injected failure')
    }
    if (this.failMatch?.(argv) === true) {
      return fail('injected failure')
    }
    if (argv[0] === 'ip') {
      return this.ip([...argv])
    }
    if (argv[0] === 'nft') {
      return this.nft([...argv], opts.stdin ?? '')
    }
    if (argv[0] === 'conntrack') {
      return this.conntrack([...argv])
    }
    return fail(`unexpected binary: ${argv[0] ?? '<empty>'}`)
  }

  private ip(argv: string[]): CommandResult {
    if (!this.ipOk) {
      return fail('ip: injected unavailable')
    }
    if (argv[1] === '-V') {
      return ok('ip utility, iproute2-6.1.0\n')
    }
    const dev = argv.includes('dev') ? argv[argv.indexOf('dev') + 1] : undefined

    const isLinkShow =
      (argv[1] === '-o' && argv[2] === 'link' && argv[3] === 'show') ||
      (argv[1] === '-d' &&
        argv[2] === '-o' &&
        argv[3] === 'link' &&
        argv[4] === 'show')
    if (isLinkShow) {
      if (dev !== undefined) {
        const link = this.links.get(dev)
        return link === undefined
          ? fail(`Device "${dev}" does not exist.`)
          : ok(this.linkLine(dev, link))
      }
      return ok(
        [...this.links.entries()]
          .map(([name, link], index) => this.linkLine(name, link, index + 1))
          .join('\n')
      )
    }
    if (argv[1] === '-o' && argv[2] === '-4' && argv[3] === 'addr') {
      const link = dev === undefined ? undefined : this.links.get(dev)
      if (link === undefined) {
        return fail(`Device "${dev ?? ''}" does not exist.`)
      }
      return ok(
        [...link.addresses]
          .map(
            (cidr, index) =>
              `${index + 2}: ${dev}    inet ${cidr} scope global ${dev}\n`
          )
          .join('')
      )
    }
    if (argv[1] === 'tuntap' && argv[2] === 'add' && dev !== undefined) {
      if (this.links.has(dev)) {
        return fail(`ioctl(TUNSETIFF): File exists`)
      }
      this.links.set(dev, {
        addresses: new Set(),
        up: false,
        kind: 'tap',
        alias: undefined,
      })
      return ok()
    }
    if (argv[1] === 'addr' && argv[2] === 'add' && dev !== undefined) {
      const link = this.links.get(dev)
      const cidr = argv[3]
      if (link === undefined) {
        return fail(`Device "${dev}" does not exist.`)
      }
      if (cidr === undefined) {
        return fail('missing address')
      }
      if (link.addresses.has(cidr)) {
        return fail('RTNETLINK answers: File exists')
      }
      link.addresses.add(cidr)
      return ok()
    }
    if (argv[1] === 'link' && argv[2] === 'set' && dev !== undefined) {
      const link = this.links.get(dev)
      if (link === undefined) {
        return fail(`Device "${dev}" does not exist.`)
      }
      if (argv.includes('alias')) {
        const alias = argv[argv.indexOf('alias') + 1]
        if (alias === undefined) {
          return fail('missing alias')
        }
        link.alias = alias
      }
      if (argv.includes('up')) {
        link.up = true
      }
      return ok()
    }
    if (argv[1] === 'link' && argv[2] === 'del' && dev !== undefined) {
      if (this.failDeleteTap === dev) {
        return fail('RTNETLINK answers: Operation not permitted')
      }
      if (!this.links.delete(dev)) {
        return fail(`Cannot find device "${dev}"`)
      }
      return ok()
    }
    return fail(`unhandled ip invocation: ${argv.join(' ')}`)
  }

  private conntrack(argv: string[]): CommandResult {
    if (!this.conntrackOk) {
      return { code: 127, stdout: '', stderr: 'conntrack: command not found' }
    }
    if (argv.includes('--version')) {
      return ok('conntrack v1.4.7 (conntrack-tools)\n')
    }
    if (argv[1] === '-D') {
      if (this.conntrackFlushError !== undefined) {
        return fail(this.conntrackFlushError)
      }
      const selector = (flag: string): string | undefined => {
        const index = argv.indexOf(flag)
        return index >= 0 ? argv[index + 1] : undefined
      }
      const origSrc = selector('--orig-src')
      const origDst = selector('--orig-dst')
      const replySrc = selector('--reply-src')
      const replyDst = selector('--reply-dst')
      const origPortDst = selector('--orig-port-dst')
      const proto = selector('-p')
      const before = this.flows.length
      for (let index = this.flows.length - 1; index >= 0; index--) {
        const flow = this.flows[index] as FakeFlow
        if (
          (origSrc === undefined || flow.origSrc === origSrc) &&
          (origDst === undefined || flow.origDst === origDst) &&
          (replySrc === undefined || flow.replySrc === replySrc) &&
          (replyDst === undefined ||
            String(flow.replyDst) === String(replyDst)) &&
          (origPortDst === undefined ||
            String(flow.origPortDst) === origPortDst) &&
          (proto === undefined || (flow.proto ?? 'tcp') === proto)
        ) {
          this.flows.splice(index, 1)
        }
      }
      const deleted = before - this.flows.length
      if (deleted === 0) {
        return {
          code: 1,
          stdout: '0 flow entries have been deleted.\n',
          stderr: '',
        }
      }
      return ok(`${deleted} flow entries have been deleted.\n`)
    }
    return fail(`unhandled conntrack invocation: ${argv.join(' ')}`)
  }

  private nft(argv: string[], stdin: string): CommandResult {
    if (!this.nftOk) {
      return fail('nft: injected failure')
    }
    if (argv.includes('--version')) {
      return ok('nftables v1.0.9 (Old Doc Yak #3)\n')
    }
    if (argv[1] === 'list' && argv[2] === 'table') {
      // Only the managed table is modelled; absence is the normal first boot.
      if (this.nftText.trim() === '') {
        return fail(
          `Error: No such file or directory; did you mean table 'filter'?`
        )
      }
      return ok(this.nftText)
    }
    if (argv[1] === '-f' && argv[2] === '-') {
      const error = this.validateRuleset(stdin)
      if (error !== undefined) {
        return fail(error)
      }
      this.nftText = stdin
      this.nftWrites += 1
      return ok()
    }
    return fail(`unhandled nft invocation: ${argv.join(' ')}`)
  }

  /** Non-empty, both managed tables present, balanced braces. */
  private validateRuleset(text: string): string | undefined {
    if (text.trim() === '') {
      return 'nft: empty ruleset'
    }
    if (
      !/\badd table inet rctf_fc\b/.test(text) ||
      !/\badd table arp rctf_fc_arp\b/.test(text)
    ) {
      return 'nft: missing managed rctf tables'
    }
    let depth = 0
    for (const char of text) {
      if (char === '{') {
        depth += 1
      } else if (char === '}') {
        depth -= 1
        if (depth < 0) {
          return 'nft: unbalanced ruleset braces'
        }
      }
    }
    return depth === 0 ? undefined : 'nft: unbalanced ruleset braces'
  }

  private linkLine(name: string, link: FakeLink, index = 2): string {
    const flags = link.up
      ? '<BROADCAST,MULTICAST,UP,LOWER_UP>'
      : '<BROADCAST,MULTICAST>'
    const details =
      link.kind === 'tap'
        ? 'tun type tap pi off vnet_hdr off persist on'
        : link.kind === 'dummy'
          ? 'dummy'
          : 'link/ether'
    const alias = link.alias === undefined ? '' : `\\    alias ${link.alias}`
    return `${index}: ${name}: ${flags} mtu 1500 qdisc fq_codel state ${
      link.up ? 'UP' : 'DOWN'
    } mode DEFAULT group default qlen 1000\\    link/ether 02:00:00:00:00:01 brd ff:ff:ff:ff:ff:ff ${details}${alias}\n`
  }
}

export const instanceId = (n: number): string =>
  `a${n.toString(36).padStart(15, '0')}`

export const makeConfig = (
  overrides: Partial<Record<keyof NetworkConfig, unknown>> = {}
): NetworkConfig =>
  networkConfigSchema.parse({
    publicHost: 'fc.example.com',
    httpDomain: 'fc1.example.com',
    ...overrides,
  })

/** Temp config with existing Traefik directory and quarantine file. */
export const makeTempConfig = async (
  overrides: Partial<Record<keyof NetworkConfig, unknown>> = {}
): Promise<NetworkConfig> => {
  const root = await mkdtemp(join(tmpdir(), 'rctf-fc-net-'))
  const traefikDynamicDir = join(root, 'traefik')
  await mkdir(traefikDynamicDir, { recursive: true })
  return makeConfig({
    traefikDynamicDir,
    quarantineFile: join(root, 'net-quarantine.json'),
    ...overrides,
  })
}

export const makeLease = (overrides: Partial<NetLease> = {}): NetLease => ({
  instanceId: instanceId(1),
  tapName: 'fctap0',
  hostIp: '10.200.0.1',
  guestIp: '10.200.0.2',
  prefixLength: 30,
  guestMac: '02:00:00:00:00:01',
  expose: [],
  publicPorts: {},
  publicHostnames: {},
  egress: false,
  ...overrides,
})

export const tcpExpose = (
  port: number,
  hostPrefix = 'svc'
): NetExposeRequest => ({ kind: 'tcp', hostPrefix, port })
