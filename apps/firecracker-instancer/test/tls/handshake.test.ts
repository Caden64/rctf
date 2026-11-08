import { afterAll, beforeAll, describe, expect, test } from 'bun:test'
import { createAgentServer, type AgentServer } from '../../src/agent/server'
import { HttpAgentClient } from '../../src/controller/agent-client'
import type { HostConfig } from '../../src/controller/config'
import {
  AgentRejectedError,
  AgentUnreachableError,
  type InstanceManager,
} from '../../src/interfaces'
import { makeConfig } from '../agent/fakes'
import {
  cleanupDir,
  generateEphemeralPki,
  opensslAvailable,
  testDir,
  type EphemeralPki,
} from './helpers'

const hasOpenssl = opensslAvailable()
if (!hasOpenssl) {
  console.warn(
    '[tls] openssl CLI not found: skipping the real TLS/mTLS handshake tests. Install openssl to run them.'
  )
}

const agentInfo = {
  version: 'tls-test',
  hostId: 'host1',
  timeMs: Date.now(),
  capacity: { vcpus: 4, memMiB: 1024, diskMiB: 4096, maxInstances: 4 },
  usage: { vcpus: 0, memMiB: 0, diskMiB: 0, instances: 0 },
  accepting: true,
  checks: {},
  images: [],
}

const managerStub = (): InstanceManager =>
  ({
    info: async () => agentInfo,
  }) as unknown as InstanceManager

const hostCapacity = {
  vcpus: 4,
  memMiB: 1024,
  diskMiB: 4096,
  maxInstances: 4,
}

describe.skipIf(!hasOpenssl)('real TLS and mTLS handshake', () => {
  let dir = ''
  let pki: EphemeralPki
  const servers: AgentServer[] = []

  beforeAll(() => {
    dir = testDir()
    pki = generateEphemeralPki(dir)
  })

  afterAll(async () => {
    for (const server of servers.splice(0)) {
      await server.stop(0).catch(() => {})
    }
    if (dir !== '') cleanupDir(dir)
  })

  const startAgent = (opts?: { caFile?: string }): string => {
    const config = makeConfig(pki.dir, {
      listen: { host: '127.0.0.1', port: 0 },
      tls: {
        certFile: pki.serverCert,
        keyFile: pki.serverKey,
        ...(opts?.caFile === undefined ? {} : { caFile: opts.caFile }),
      },
    })
    const agent = createAgentServer({ config, manager: managerStub() })
    servers.push(agent)
    // The capability check in createAgentServer already guarantees this, but
    // assert it so a silent plaintext listener can never pass this test.
    expect(agent.server.protocol).toBe('https')
    return `https://127.0.0.1:${agent.server.port}`
  }

  const clientFor = (
    url: string,
    overrides: Partial<HostConfig> = {},
    token = 'agent-token'
  ): HttpAgentClient =>
    new HttpAgentClient(
      {
        id: 'host-a',
        url,
        token,
        capacity: hostCapacity,
        ...overrides,
      },
      { timeoutMs: 5000 }
    )

  test('a client trusting the CA verifies the server over a real handshake', async () => {
    const url = startAgent()
    const info = await clientFor(url, {
      caCertificateFile: pki.caCert,
    }).info()
    expect(info.hostId).toBe('host1')
  })

  test('bearer-token auth still applies over TLS', async () => {
    const url = startAgent()
    const wrong = await clientFor(
      url,
      { caCertificateFile: pki.caCert },
      'wrong-token'
    )
      .info()
      .catch(error => error)
    expect(wrong).toBeInstanceOf(AgentRejectedError)
    expect((wrong as AgentRejectedError).code).toBe('unauthorized')

    const missing = await clientFor(
      url,
      {
        caCertificateFile: pki.caCert,
      },
      ''
    )
      .info()
      .catch(error => error)
    expect(missing).toBeInstanceOf(AgentRejectedError)
    expect((missing as AgentRejectedError).code).toBe('unauthorized')
  })

  test('a client trusting the wrong CA fails certificate verification', async () => {
    const url = startAgent()
    const error = await clientFor(url, {
      caCertificateFile: pki.otherCaCert,
    })
      .info()
      .catch(error => error)
    expect(error).toBeInstanceOf(AgentUnreachableError)
  })

  test('mTLS rejects a client with no certificate', async () => {
    const url = startAgent({ caFile: pki.caCert })
    const error = await clientFor(url, {
      caCertificateFile: pki.caCert,
    })
      .info()
      .catch(error => error)
    expect(error).toBeInstanceOf(AgentUnreachableError)
  })

  test('mTLS accepts a client certificate signed by the configured CA', async () => {
    const url = startAgent({ caFile: pki.caCert })
    const info = await clientFor(url, {
      caCertificateFile: pki.caCert,
      clientCertFile: pki.clientCert,
      clientKeyFile: pki.clientKey,
    }).info()
    expect(info.hostId).toBe('host1')
  })

  test('mTLS rejects a client certificate signed by another CA', async () => {
    const url = startAgent({ caFile: pki.caCert })
    const error = await clientFor(url, {
      caCertificateFile: pki.caCert,
      clientCertFile: pki.foreignClientCert,
      clientKeyFile: pki.foreignClientKey,
    })
      .info()
      .catch(error => error)
    expect(error).toBeInstanceOf(AgentUnreachableError)
  })
})
