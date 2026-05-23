import { describe, expect, it } from 'vitest'

import { emptyBudget, TaskSchema, taskStatusValues } from './task'

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
