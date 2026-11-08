import pino, { type Logger } from 'pino'

export type { Logger }

/**
 * Shared logger. Redacts anything that can hold a flag, in case a caller logs a spec by mistake.
 * Callers should still use `redactSpec` and never log request bodies. TLS private
 * keys are redacted too: config objects are easy to log by accident.
 */
export const createLogger = (
  name: string,
  level = process.env.LOG_LEVEL ?? 'info',
  destination?: pino.DestinationStream
): Logger =>
  pino(
    {
      name,
      level,
      redact: {
        paths: [
          'flags',
          '*.flags',
          'spec.flags',
          'metadata',
          '*.metadata',
          'rctf.flags',
          'token',
          '*.token',
          'authToken',
          'adminToken',
          'tlsMaterial',
          '*.tlsMaterial',
          'tlsMaterial.key',
          '*.tlsMaterial.key',
          'tls.key',
          '*.tls.key',
          'tls.cert',
          '*.tls.cert',
          'tls.ca',
          '*.tls.ca',
        ],
        censor: '<redacted>',
      },
    },
    destination
  )
