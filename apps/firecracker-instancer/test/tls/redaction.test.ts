import { describe, expect, test } from 'bun:test'
import { createLogger } from '../../src/log'
import { fixture } from './helpers'

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

    const text = lines.join('')
    expect(text).not.toContain('PRIVATE KEY')
    for (const pem of Object.values(material)) {
      expect(text).not.toContain(pem.split('\n')[1]!)
    }
    expect(text).toContain('<redacted>')
  })
})
