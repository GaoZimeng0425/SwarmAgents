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
