import { describe, expect, it } from 'vitest'

import { DelegationItemSchema, emptyBudget, TaskEventSchema, TaskSchema, taskStatusValues } from './task'

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
    expect(emptyBudget()).toEqual({ tokens: 0, calls: 0, wallMs: 0, usdCents: 0 })
  })

  it('TaskSchema accepts a minimal valid task', () => {
    const t = {
      id: '01HX0000000000000000000000',
      parentId: null,
      goal: 'do a thing',
      status: 'pending' as const,
      assignedWorkerId: null,
      toolAllowlist: ['peekaboo.*'],
      budget: { tokens: 100_000, calls: 50, wallMs: 600_000, usdCents: 200 },
      used: emptyBudget(),
      history: [],
      result: null,
      createdAt: 1700000000000,
      startedAt: null,
      endedAt: null,
    }
    expect(() => TaskSchema.parse(t)).not.toThrow()
  })

  it('TaskSchema rejects an unknown status', () => {
    const bad = { status: 'whatever' }
    expect(() => TaskSchema.parse(bad)).toThrow()
  })
})

describe('TaskSchema.attachments', () => {
  const base = {
    id: '01234567890123456789012345',
    parentId: null,
    agentDefId: 'default',
    goal: 'g',
    status: 'pending',
    assignedWorkerId: null,
    toolAllowlist: [],
    budget: { tokens: 0, calls: 0, wallMs: 0, usdCents: 0 },
    used: { tokens: 0, calls: 0, wallMs: 0, usdCents: 0 },
    history: [],
    result: null,
    createdAt: 1,
    startedAt: null,
    endedAt: null,
  }

  it('defaults attachments to [] when omitted', () => {
    const t = TaskSchema.parse(base)
    expect(t.attachments).toEqual([])
  })

  it('accepts image attachments', () => {
    const t = TaskSchema.parse({ ...base, attachments: [{ data: 'AAAA', mimeType: 'image/png', name: 'a.png' }] })
    expect(t.attachments[0]).toEqual({ data: 'AAAA', mimeType: 'image/png', name: 'a.png' })
  })
})

const baseTask = {
  id: '01HZZZZZZZZZZZZZZZZZZZZZZZ',
  parentId: null,
  agentDefId: 'default',
  goal: 'do it',
  status: 'pending',
  assignedWorkerId: null,
  toolAllowlist: [],
  budget: { tokens: 1, calls: 1, wallMs: 1, usdCents: 1 },
  used: { tokens: 0, calls: 0, wallMs: 0, usdCents: 0, cacheRead: 0, cacheWrite: 0 },
  history: [],
  attachments: [],
  plan: [],
  result: null,
  createdAt: 1,
  startedAt: null,
  endedAt: null,
}

describe('delegation plan schemas', () => {
  it('parses a minimal item and defaults dependsOn to []', () => {
    const item = DelegationItemSchema.parse({ id: 'd1', goal: 'do X' })
    expect(item.dependsOn).toEqual([])
    expect(item.ownerAgentType).toBeUndefined()
  })

  it('parses a full item with owner and dependsOn', () => {
    const item = DelegationItemSchema.parse({
      id: 'd2',
      goal: 'do Y',
      ownerAgentType: 'engineer',
      dependsOn: ['d1'],
    })
    expect(item.dependsOn).toEqual(['d1'])
  })

  it('round-trips a task carrying a delegationPlan', () => {
    const t = TaskSchema.parse({
      ...baseTask,
      delegationPlan: [{ id: 'd1', goal: 'g', ownerAgentType: 'engineer' }],
    })
    expect(t.delegationPlan).toHaveLength(1)
    expect(t.delegationPlan?.[0].ownerAgentType).toBe('engineer')
  })

  it('accepts a task without delegationPlan (backward compatible)', () => {
    expect(TaskSchema.parse(baseTask).delegationPlan).toBeUndefined()
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
