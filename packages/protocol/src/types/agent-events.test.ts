import { describe, expect, it } from 'vitest'

import type { AgentWireEvent } from './agent-events'

describe('AgentWireEvent', () => {
  it('narrows by kind', () => {
    const e: AgentWireEvent = { kind: 'agent_end', sessionId: 's1', runId: 'r1', status: 'completed' }
    if (e.kind === 'agent_end') expect(e.status).toBe('completed')
  })
  it('entry_appended carries rowId cursor', () => {
    const e: AgentWireEvent = {
      kind: 'entry_appended',
      sessionId: 's1',
      rowId: 42,
      entry: { type: 'message', id: 'e1', parentId: null, timestamp: 't', message: { role: 'user', content: 'hi' } },
    }
    expect(e.rowId).toBe(42)
  })
})
