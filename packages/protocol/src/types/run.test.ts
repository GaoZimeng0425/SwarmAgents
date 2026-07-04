import { describe, expect, it } from 'vitest'

import { terminalStatusForRunEvent } from './run'

describe('terminalStatusForRunEvent — the single event→terminal rule', () => {
  it('maps run.complete to completed', () => {
    expect(terminalStatusForRunEvent({ kind: 'run.complete' })).toBe('completed')
  })

  it('maps run.error with code cancelled to cancelled', () => {
    expect(terminalStatusForRunEvent({ kind: 'run.error', error: { code: 'cancelled' } })).toBe('cancelled')
  })

  it('maps run.error with any other code to failed', () => {
    expect(terminalStatusForRunEvent({ kind: 'run.error', error: { code: 'budget_exhausted' } })).toBe('failed')
  })

  it('maps run.error without a structured error to failed', () => {
    expect(terminalStatusForRunEvent({ kind: 'run.error' })).toBe('failed')
    expect(terminalStatusForRunEvent({ kind: 'run.error', error: 'boom' })).toBe('failed')
  })

  it('returns undefined for every non-terminal kind', () => {
    for (const kind of ['run.created', 'run.dispatched', 'run.progress', 'run.usage', 'run.plan', 'run.spawned']) {
      expect(terminalStatusForRunEvent({ kind })).toBeUndefined()
    }
  })
})
