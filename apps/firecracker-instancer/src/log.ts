import pino, { type Logger } from 'pino'

export type { Logger }

/**
 * Shared logger. Redacts anything that can hold a flag, in case a caller logs a spec by mistake.
 * Callers should still use `redactSpec` and never log request bodies.
 */
export const createLogger = (
  name: string,
  level = process.env.LOG_LEVEL ?? 'info'
): Logger =>
  pino({
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
      ],
      censor: '<redacted>',
    },
  })
