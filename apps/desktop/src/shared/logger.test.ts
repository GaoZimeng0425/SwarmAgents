import { describe, expect, it } from 'vitest'

import { createLogger } from './logger'

describe('createLogger', () => {
  it('produces a logger that exposes info/warn/error/debug', () => {
    const log = createLogger({ process: 'test' })
    expect(typeof log.info).toBe('function')
    expect(typeof log.warn).toBe('function')
    expect(typeof log.error).toBe('function')
    expect(typeof log.debug).toBe('function')
  })

  it('returns a child logger with merged bindings', () => {
    const log = createLogger({ process: 'main' })
    const child = log.child({ workerId: 'w1' })
    expect(child.bindings()).toMatchObject({ process: 'main', workerId: 'w1' })
  })
})

describe('logger redaction', () => {
  it('redacts apiKey and provider.apiKey fields from logged objects', () => {
    // pino writes via sonic-boom directly to the file descriptor, bypassing
    // process.stdout.write. Pass an explicit destination stream we can capture.
    const written: string[] = []
    const stream = {
      write(chunk: string) {
        written.push(chunk)
      },
    }
    const log = createLogger({ process: 'test' }, stream)
    log.info({ apiKey: 'sk-direct', provider: { apiKey: 'sk-nested', id: 'anthropic' } })
    const joined = written.join('')
    expect(joined).not.toContain('sk-direct')
    expect(joined).not.toContain('sk-nested')
    expect(joined).toContain('"id":"anthropic"') // non-secret fields survive
  })
})
