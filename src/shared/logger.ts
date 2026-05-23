import pino, { type Logger } from 'pino'

export type LoggerBindings = {
  process: 'main' | 'worker' | 'test'
  workerId?: string
  taskId?: string
}

const isDev = process.env.NODE_ENV !== 'production'

export function createLogger(bindings: LoggerBindings): Logger {
  return pino({
    level: process.env.LOG_LEVEL ?? (isDev ? 'debug' : 'info'),
    base: bindings,
    transport: isDev
      ? { target: 'pino-pretty', options: { colorize: true, translateTime: 'HH:MM:ss.l' } }
      : undefined,
  })
}
