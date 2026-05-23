import pino, { type Logger } from 'pino'

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
 */
export function createLogger(bindings: LoggerBindings): Logger {
  return pino({
    level: process.env.LOG_LEVEL ?? (isDev ? 'debug' : 'info'),
    base: bindings,
  })
}
