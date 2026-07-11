import { describe, expect, it } from 'vitest'

import { terminalStatusForMessageEvent } from './message'

describe('terminalStatusForMessageEvent — the single event→terminal rule', () => {
  it('maps message.complete to completed', () => {
    expect(terminalStatusForMessageEvent({ kind: 'message.complete' })).toBe('completed')
  })

  it('maps message.error with code cancelled to cancelled', () => {
    expect(terminalStatusForMessageEvent({ kind: 'message.error', error: { code: 'cancelled' } })).toBe('cancelled')
  })

  it('maps message.error with any other code to failed', () => {
    expect(terminalStatusForMessageEvent({ kind: 'message.error', error: { code: 'budget_exhausted' } })).toBe('failed')
  })

  it('maps message.error without a structured error to failed', () => {
    expect(terminalStatusForMessageEvent({ kind: 'message.error' })).toBe('failed')
    expect(terminalStatusForMessageEvent({ kind: 'message.error', error: 'boom' })).toBe('failed')
  })

  it('returns undefined for every non-terminal kind', () => {
    for (const kind of [
      'message.created',
      'message.dispatched',
      'message.progress',
      'message.usage',
      'message.plan',
      'message.spawned',
    ]) {
      expect(terminalStatusForMessageEvent({ kind })).toBeUndefined()
    }
  })
})
