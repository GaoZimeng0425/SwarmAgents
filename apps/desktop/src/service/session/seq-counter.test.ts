import { describe, expect, it } from 'vitest'
import type { Task } from '@swarm/protocol'

import { createSeqCounter } from './seq-counter'

// Minimal Task shape — createSeqCounter only reads t.history[].seq.
const task = (seqs: Array<number | undefined>): Task =>
  ({
    id: 't',
    parentId: null,
    agentDefId: 'default',
    goal: 'g',
    status: 'completed',
    assignedWorkerId: null,
    toolAllowlist: [],
    history: seqs.map((seq, i) => ({
      kind: 'llm.message',
      role: 'assistant',
      content: `${i}`,
      ts: i,
      ...(seq === undefined ? {} : { seq }),
    })),
    plan: [],
    acceptanceCriteria: [],
    verifications: [],
    delegationPlan: [],
    result: null,
    used: { tokens: 0, calls: 0, wallMs: 0, usdCents: 0, cacheRead: 0, cacheWrite: 0 },
    contextWindow: 0,
    artifacts: [],
    createdAt: 0,
    startedAt: null,
    endedAt: null,
  }) as unknown as Task

describe('createSeqCounter', () => {
  it('counts from 1 for a fresh session', () => {
    const c = createSeqCounter(() => [])
    expect(c.nextSeq('s')).toBe(1)
    expect(c.nextSeq('s')).toBe(2)
  })

  it('resumes past the persisted max after a restart', () => {
    // "Restart": a brand-new counter over the same persisted history (seqs 5, 9).
    const c = createSeqCounter(() => [task([5, 9])])
    expect(c.nextSeq('s')).toBe(10)
  })

  it('counters are independent per session', () => {
    const c = createSeqCounter(() => [])
    expect(c.nextSeq('a')).toBe(1)
    expect(c.nextSeq('b')).toBe(1)
    expect(c.nextSeq('a')).toBe(2)
  })

  it('ignores legacy events without seq when initing', () => {
    const c = createSeqCounter(() => [task([undefined, 7, undefined])])
    expect(c.nextSeq('s')).toBe(8)
  })
})
