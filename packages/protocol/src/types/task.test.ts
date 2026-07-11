import { describe, expect, it } from 'vitest'

import { DelegationItemSchema, emptyBudget, TaskEventSchema, taskStatusValues } from './task'

describe('Task types', () => {
  it('exposes the full status enum', () => {
    expect(taskStatusValues).toEqual([
      'pending',
      'planning',
      'dispatched',
      'running',
      'awaiting_user',
      'paused',
      'completed',
      'failed',
      'cancelled',
      'interrupted',
    ])
  })

  it('emptyBudget returns zeroed counters', () => {
    expect(emptyBudget()).toEqual({ calls: 0, wallMs: 0, usdCents: 0 })
  })
})

describe('delegation plan schemas', () => {
  it('parses a minimal item and defaults dependsOn to []', () => {
    const item = DelegationItemSchema.parse({ id: 'd1', prompt: 'do X' })
    expect(item.dependsOn).toEqual([])
    expect(item.ownerAgentType).toBeUndefined()
  })

  it('parses a full item with owner and dependsOn', () => {
    const item = DelegationItemSchema.parse({
      id: 'd2',
      prompt: 'do Y',
      ownerAgentType: 'engineer',
      dependsOn: ['d1'],
    })
    expect(item.dependsOn).toEqual(['d1'])
  })
})

describe('TaskEvent.seq', () => {
  it('parses a legacy event without seq', () => {
    const legacy = { kind: 'llm.message', role: 'assistant', content: 'hi', ts: 1 }
    expect(() => TaskEventSchema.parse(legacy)).not.toThrow()
    expect(TaskEventSchema.parse(legacy).seq).toBeUndefined()
  })

  it('parses a new event with seq', () => {
    const ev = { kind: 'llm.message', role: 'assistant', content: 'hi', ts: 1, seq: 42 }
    expect(TaskEventSchema.parse(ev).seq).toBe(42)
  })
})
