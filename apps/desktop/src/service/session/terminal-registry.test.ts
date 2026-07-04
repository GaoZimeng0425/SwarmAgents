import { describe, expect, it, vi } from 'vitest'

import { createTerminalRegistry } from './terminal-registry'

describe('terminal registry', () => {
  it('marks terminal once (idempotent) and fires the listener', () => {
    const cb = vi.fn()
    const reg = createTerminalRegistry([])
    reg.onTerminal(cb)
    reg.markTerminal('r1', 'completed')
    reg.markTerminal('r1', 'failed') // second mark is a no-op (first terminal wins)
    expect(reg.isTerminal('r1')).toBe(true)
    expect(reg.getStatus('r1')).toBe('completed')
    expect(cb).toHaveBeenCalledTimes(1)
    expect(cb).toHaveBeenCalledWith('r1', 'completed')
  })

  it('loads initial statuses from run_events at construction', () => {
    const reg = createTerminalRegistry([
      { runId: 'r1', status: 'completed' },
      { runId: 'r2', status: 'failed' },
    ])
    expect(reg.isTerminal('r1')).toBe(true)
    expect(reg.isTerminal('r2')).toBe(true)
    expect(reg.isTerminal('r3')).toBe(false)
  })
})
