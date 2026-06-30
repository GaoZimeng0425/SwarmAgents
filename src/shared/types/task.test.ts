import { describe, expect, it } from 'vitest'

import {
  AcceptanceCriterionSchema,
  DelegationItemSchema,
  ExecutableCheckSchema,
  emptyBudget,
  TaskSchema,
  taskStatusValues,
  VerificationRoundSchema,
} from './task'

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

describe('acceptance criteria schemas', () => {
  it('parses a command check', () => {
    const c = ExecutableCheckSchema.parse({ kind: 'command', command: 'npm test', expectExitCode: 0 })
    expect(c.kind).toBe('command')
  })

  it('parses a file_exists check', () => {
    const c = ExecutableCheckSchema.parse({ kind: 'file_exists', path: 'dist/out.js' })
    expect(c.kind).toBe('file_exists')
  })

  it('rejects an unknown check kind', () => {
    expect(ExecutableCheckSchema.safeParse({ kind: 'http', url: 'x' }).success).toBe(false)
  })

  it('parses a criterion with and without a check', () => {
    expect(
      AcceptanceCriterionSchema.parse({
        id: 'c1',
        description: 'tests pass',
        check: { kind: 'command', command: 'npm test' },
      }).id
    ).toBe('c1')
    expect(AcceptanceCriterionSchema.parse({ id: 'c2', description: 'reads well' }).check).toBeUndefined()
  })

  it('parses a verification round', () => {
    const r = VerificationRoundSchema.parse({
      round: 0,
      verdict: 'fail',
      results: [{ criterionId: 'c1', pass: false, detail: 'exit 1' }],
      gaps: ['c1: exit 1'],
      ts: 123,
    })
    expect(r.verdict).toBe('fail')
  })

  it('accepts a task carrying criteria and verifications', () => {
    const t = TaskSchema.parse({
      ...baseTask,
      acceptanceCriteria: [{ id: 'c1', description: 'tests pass' }],
      verifications: [{ round: 0, verdict: 'pass', results: [], gaps: [], ts: 1 }],
    })
    expect(t.acceptanceCriteria).toHaveLength(1)
    expect(t.verifications).toHaveLength(1)
  })

  it('accepts a task without criteria (backward compatible)', () => {
    expect(TaskSchema.parse(baseTask).acceptanceCriteria).toBeUndefined()
  })
})

describe('delegation plan schemas', () => {
  it('parses a minimal item and defaults dependsOn to []', () => {
    const item = DelegationItemSchema.parse({ id: 'd1', goal: 'do X' })
    expect(item.dependsOn).toEqual([])
    expect(item.ownerAgentType).toBeUndefined()
    expect(item.acceptanceCriteria).toBeUndefined()
  })

  it('parses a full item with owner, dependsOn, and item criteria', () => {
    const item = DelegationItemSchema.parse({
      id: 'd2',
      goal: 'do Y',
      ownerAgentType: 'engineer',
      dependsOn: ['d1'],
      acceptanceCriteria: [{ id: 'c1', description: 'X shipped' }],
    })
    expect(item.dependsOn).toEqual(['d1'])
    expect(item.acceptanceCriteria).toHaveLength(1)
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
