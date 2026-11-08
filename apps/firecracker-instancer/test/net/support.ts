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

export interface FakeCall {
  argv: string[]
  stdin?: string
}

interface FakeLink {
  addresses: Set<string>
  up: boolean
}

const ok = (stdout = ''): CommandResult => ({ code: 0, stdout, stderr: '' })
const fail = (stderr: string): CommandResult => ({
  code: 1,
  stdout: '',
  stderr,
})

/**
 * Recording fake for `ip`/`nft`. Never touches the host. `failAt` injects a
 * failure into exactly the Nth runner call (1-based); every other call is
 * simulated normally so rollback paths can complete.
 */
export class FakeHost implements CommandRunner {
  readonly calls: FakeCall[] = []
  readonly links = new Map<string, FakeLink>()
  nftText = ''
  nftWrites = 0
  failAt: number | undefined
  nftOk = true
  ipOk = true

  seedTap(name: string, addresses: string[] = []): void {
    this.links.set(name, { addresses: new Set(addresses), up: true })
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
    if (argv[0] === 'ip') {
      return this.ip([...argv])
    }
    if (argv[0] === 'nft') {
      return this.nft([...argv], opts.stdin ?? '')
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

    if (argv[1] === '-o' && argv[2] === 'link' && argv[3] === 'show') {
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
      this.links.set(dev, { addresses: new Set(), up: false })
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
      if (argv.includes('up')) {
        link.up = true
      }
      return ok()
    }
    if (argv[1] === 'link' && argv[2] === 'del' && dev !== undefined) {
      if (!this.links.delete(dev)) {
        return fail(`Cannot find device "${dev}"`)
      }
      return ok()
    }
    return fail(`unhandled ip invocation: ${argv.join(' ')}`)
  }

  private nft(argv: string[], stdin: string): CommandResult {
    if (!this.nftOk) {
      return fail('nft: injected failure')
    }
    if (argv.includes('--version')) {
      return ok('nftables v1.0.9 (Old Doc Yak #3)\n')
    }
    if (argv[1] === '-f' && argv[2] === '-') {
      this.nftText = stdin
      this.nftWrites += 1
      return ok()
    }
    return fail(`unhandled nft invocation: ${argv.join(' ')}`)
  }

  private linkLine(name: string, link: FakeLink, index = 2): string {
    const flags = link.up
      ? '<BROADCAST,MULTICAST,UP,LOWER_UP>'
      : '<BROADCAST,MULTICAST>'
    return `${index}: ${name}: ${flags} mtu 1500 qdisc fq_codel state ${
      link.up ? 'UP' : 'DOWN'
    } mode DEFAULT group default qlen 1000\\    link/ether 02:00:00:00:00:01 brd ff:ff:ff:ff:ff:ff\n`
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

/** Temp config with existing Traefik/routes directories. */
export const makeTempConfig = async (
  overrides: Partial<Record<keyof NetworkConfig, unknown>> = {}
): Promise<NetworkConfig> => {
  const root = await mkdtemp(join(tmpdir(), 'rctf-fc-net-'))
  const traefikDynamicDir = join(root, 'traefik')
  const routesDir = join(root, 'routes')
  await mkdir(traefikDynamicDir, { recursive: true })
  await mkdir(routesDir, { recursive: true })
  return makeConfig({ traefikDynamicDir, routesDir, ...overrides })
}

export const makeLease = (overrides: Partial<NetLease> = {}): NetLease => ({
  instanceId: instanceId(1),
  tapName: 'fctap0',
  hostIp: '10.200.0.1',
  guestIp: '10.200.0.2',
  prefixLength: 30,
  guestMac: '02:00:00:00:00:01',
  guestPorts: {},
  publicPorts: {},
  publicHostnames: {},
  egress: false,
  ...overrides,
})

export const tcpExpose = (
  port: number,
  hostPrefix = 'svc'
): NetExposeRequest => ({ kind: 'tcp', hostPrefix, port })
