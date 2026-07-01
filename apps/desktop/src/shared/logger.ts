import fs from 'node:fs'
import pino, { type DestinationStream, type Logger } from 'pino'

export type LoggerBindings = {
  process: 'main' | 'worker' | 'test' | 'service'
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
 * When `SWARM_LOG_FILE` is set in the environment, logs are tee'd to that file
 * via pino's built-in multistream (no worker_thread, safe in utilityProcess).
 * Main process injects this for both itself and forked workers so dev sessions
 * persist a single inspectable log without piping shells.
 *
 * An optional `destination` stream may be supplied (used by tests to capture
 * output; pino writes via sonic-boom directly to the fd in production, which
 * bypasses any patching of `process.stdout.write`).
 */
export function createLogger(bindings: LoggerBindings, destination?: DestinationStream): Logger {
  const options = {
    level: process.env.LOG_LEVEL ?? (isDev ? 'debug' : 'info'),
    base: bindings,
    redact: {
      paths: ['apiKey', '*.apiKey', 'provider.apiKey', 'providers.*.apiKey', 'key', '*.key'],
      censor: '[REDACTED]',
    },
  }
  if (destination) return pino(options, destination)

  const filePath = process.env.SWARM_LOG_FILE
  if (!filePath) return pino(options)

  try {
    const fileStream = fs.createWriteStream(filePath, { flags: 'a' })
    return pino(options, pino.multistream([{ stream: process.stdout }, { stream: fileStream }]))
  } catch {
    // best-effort: fall back to stdout-only if the file can't be opened
    return pino(options)
  }
}
