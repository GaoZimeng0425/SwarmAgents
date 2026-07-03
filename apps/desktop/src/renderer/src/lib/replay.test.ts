import type { Task, TaskEvent } from '@swarm/protocol'
import { describe, expect, it } from 'vitest'

import { conversationTurnsToRecords, tasksToRecords } from './replay'

const baseTask = (over: Partial<Task>): Task => ({
  id: '01HRX0000000000000000000R1',
  parentId: null,
  agentDefId: 'default',
  goal: 'g',
  status: 'completed',
  assignedWorkerId: null,
  toolAllowlist: [],
  budget: { tokens: 0, calls: 0, wallMs: 0, usdCents: 0 },
  used: { tokens: 0, calls: 0, wallMs: 0, usdCents: 0, cacheRead: 0, cacheWrite: 0 },
  history: [],
  plan: [],
  attachments: [],
  result: null,
  createdAt: 1,
  startedAt: null,
  endedAt: null,
  ...over,
})

describe('tasksToRecords', () => {
  it('builds a record per task with goal + history as progress events', () => {
    const records = tasksToRecords('ses-1', [
      baseTask({
        goal: 'tidy',
        history: [{ kind: 'llm.message', role: 'assistant', content: 'done', ts: 2 }],
        result: { summary: 'all tidy', artifacts: [] },
      }),
    ])
    expect(records).toHaveLength(1)
    expect(records[0].sessionId).toBe('ses-1')
    expect(records[0].goal).toBe('tidy')
    expect(records[0].summary).toBe('all tidy')
    expect(records[0].events[0].kind).toBe('task.created')
    expect(records[0].events.some((e) => e.kind === 'task.progress')).toBe(true)
  })

  it('orders records newest createdAt first', () => {
    const records = tasksToRecords('ses-1', [
      baseTask({ id: '01HRX0000000000000000000R1', createdAt: 1 }),
      baseTask({ id: '01HRX0000000000000000000R2', createdAt: 5 }),
    ])
    expect(records[0].id).toBe('01HRX0000000000000000000R2')
  })

  it('rehydrates a persisted plan onto the record', () => {
    const records = tasksToRecords('ses-1', [
      baseTask({
        plan: [
          { content: 'step one', status: 'completed' },
          { content: 'step two', status: 'in_progress' },
        ],
      }),
    ])
    expect(records[0].plan).toEqual([
      { content: 'step one', status: 'completed' },
      { content: 'step two', status: 'in_progress' },
    ])
  })

  it('leaves plan undefined when the persisted plan is empty', () => {
    const records = tasksToRecords('ses-1', [baseTask({ plan: [] })])
    expect(records[0].plan).toBeUndefined()
  })

  it('anchors a history event with a missing/invalid ts to the task createdAt', () => {
    // Persisted history is JSON-parsed without zod re-validation, so a legacy or
    // corrupt event can lack a ts. It must not produce a NaN/undefined event ts
    // (which crashes the timeline), but fall back to the task's createdAt.
    const records = tasksToRecords('ses-1', [
      baseTask({
        createdAt: 100,
        history: [{ kind: 'reasoning', content: 'hmm' } as unknown as TaskEvent],
      }),
    ])
    const progress = records[0].events.find((e) => e.kind === 'task.progress')
    expect(progress?.ts).toBe(100)
  })

  it('restores usage + context numbers so the display survives a reload', () => {
    const records = tasksToRecords('ses-1', [
      baseTask({
        used: { tokens: 16_000, calls: 8, wallMs: 1000, usdCents: 18, cacheRead: 12_000, cacheWrite: 2000 },
        contextWindow: 200_000,
      }),
    ])
    expect(records[0].used).toEqual({
      tokens: 16_000,
      calls: 8,
      wallMs: 1000,
      usdCents: 18,
      cacheRead: 12_000,
      cacheWrite: 2000,
    })
    expect(records[0].contextTokens).toBe(16_000) // ring numerator = last snapshot
    expect(records[0].contextWindow).toBe(200_000)
  })
})

describe('tasksToRecords seq', () => {
  it('uses persisted seq when present', () => {
    const records = tasksToRecords('ses-1', [
      baseTask({ history: [{ kind: 'llm.message', role: 'assistant', content: 'hi', ts: 5, seq: 77 }] }),
    ])
    const progress = records[0].events.find((e) => e.kind === 'task.progress')
    expect(progress?.seq).toBe(77)
  })

  it('falls back to ts for legacy events without seq', () => {
    const records = tasksToRecords('ses-1', [
      baseTask({ history: [{ kind: 'llm.message', role: 'assistant', content: 'hi', ts: 9 }] }),
    ])
    const progress = records[0].events.find((e) => e.kind === 'task.progress')
    expect(progress?.seq).toBe(9)
  })

  it('gives every rebuilt UIEvent a finite seq', () => {
    const records = tasksToRecords('ses-1', [
      baseTask({ createdAt: 100, history: [{ kind: 'llm.message', role: 'assistant', content: 'x', ts: 3 }] }),
    ])
    expect(records[0].events.every((e) => Number.isFinite(e.seq))).toBe(true)
    expect(records[0].events[0]).toMatchObject({ kind: 'task.created' })
  })
})

describe('conversationTurnsToRecords', () => {
  it('groups conversation events by turnId into TaskRecords keyed by turnId', () => {
    const rows = [
      { turnId: 't1', seq: 1, ts: 1, event: { kind: 'llm.message', role: 'user', content: 'hi', ts: 1 } },
      { turnId: 't1', seq: 2, ts: 2, event: { kind: 'llm.message', role: 'assistant', content: 'yo', ts: 2 } },
      { turnId: 't2', seq: 3, ts: 3, event: { kind: 'llm.message', role: 'user', content: 'again', ts: 3 } },
    ] as never[]
    const recs = conversationTurnsToRecords('ses', rows)
    expect(recs).toHaveLength(2)
    const t1 = recs.find((r) => r.id === 't1')!
    expect(t1.sessionId).toBe('ses')
    // Each row becomes a task.progress event carrying its persisted seq.
    expect(t1.events.map((e) => e.seq)).toEqual([1, 2])
    expect(t1.events.every((e) => e.kind === 'task.progress')).toBe(true)
    expect(t1.isConversation).toBe(true)
    // goal is derived from the first user message so anything reading .goal works.
    expect(t1.goal).toBe('hi')
  })

  it('orders turns newest startedAt first', () => {
    const rows = [
      { turnId: 't1', seq: 1, ts: 10, event: { kind: 'llm.message', role: 'user', content: 'old', ts: 10 } },
      { turnId: 't2', seq: 2, ts: 20, event: { kind: 'llm.message', role: 'user', content: 'new', ts: 20 } },
    ] as never[]
    const recs = conversationTurnsToRecords('ses', rows)
    expect(recs.map((r) => r.id)).toEqual(['t2', 't1'])
  })
})
