import pino, { type DestinationStream, type Logger } from 'pino'

export type LoggerBindings = {
  process: 'main' | 'worker' | 'test'
  workerId?: string
  taskId?: string
}

const isDev = process.env.NODE_ENV !== 'production'

/**
 * Pino logger configured for synchronous newline-delimited JSON to stdout.
 *
 * We deliberately do NOT use pino-pretty as a transport: pino transports run
 * in worker_threads, which are fragile inside Electron utilityProcesses and
 * surface as "the worker has exited" errors when those utilityProcesses (or
 * the app itself) shut down. To get pretty output in development, pipe the
 * raw JSON through the pino-pretty CLI:
 *
 *   pnpm dev | npx pino-pretty
 *
 * An optional `destination` stream may be supplied (used by tests to capture
 * output; pino writes via sonic-boom directly to the fd in production, which
 * bypasses any patching of `process.stdout.write`).
 */
export function createLogger(bindings: LoggerBindings, destination?: DestinationStream): Logger {
  return pino(
    {
      level: process.env.LOG_LEVEL ?? (isDev ? 'debug' : 'info'),
      base: bindings,
      redact: {
        paths: ['apiKey', '*.apiKey', 'provider.apiKey', 'providers.*.apiKey', 'key', '*.key'],
        censor: '[REDACTED]',
      },
    },
    destination,
  )
}
