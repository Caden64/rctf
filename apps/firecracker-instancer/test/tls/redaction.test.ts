import { describe, expect, test } from 'bun:test'
import { createLogger } from '../../src/log'
import { fixture, opensslAvailable } from './helpers'

describe('TLS material log redaction', () => {
  test('never writes key, certificate or CA bytes when a config is logged', () => {
    const lines: string[] = []
    const logger = createLogger('tls-redaction-test', 'trace', {
      write: (chunk: string) => {
        lines.push(chunk)
      },
    })
    const material = {
      cert: fixture('server.crt'),
      key: fixture('server.key'),
      ca: fixture('ca.crt'),
    }
    logger.info({ tlsMaterial: material }, 'loaded tls')
    logger.info({ host: { tls: material } }, 'host tls')
    logger.info({ tls: { key: material.key } }, 'nested key')
    // Controller configuration shapes: whole HostConfig objects, with and
    // without a wrapping `config` key or another parent object.
    const host = {
      id: 'fc1',
      url: 'https://10.0.0.11:7001',
      token: 'host-token',
      tls: material,
    }
    logger.info({ hosts: [host] }, 'hosts')
    logger.info({ config: { hosts: [host] } }, 'controller config')
    logger.info({ controller: { hosts: [host] } }, 'nested controller config')

    const text = lines.join('')
    expect(text).not.toContain('PRIVATE KEY')
    expect(text).not.toContain('host-token')
    for (const pem of Object.values(material)) {
      expect(text).not.toContain(pem.split('\n')[1]!)
    }
    expect(text).toContain('<redacted>')
  })

  test('reports a missing openssl binary as unavailable instead of throwing', () => {
    expect(opensslAvailable('definitely-not-a-real-openssl-binary')).toBe(false)
  })
})
