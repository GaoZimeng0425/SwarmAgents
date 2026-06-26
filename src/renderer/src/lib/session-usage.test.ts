import { describe, expect, it } from 'vitest'

import type { TaskRecord } from './apply-event'
import { latestTopLevelTask } from './session-usage'

const used = (tokens: number, usdCents: number): TaskRecord['used'] => ({
  tokens,
  calls: 1,
  wallMs: 0,
  usdCents,
  cacheRead: 0,
  cacheWrite: 0,
})

const rec = (over: Partial<TaskRecord>): TaskRecord => ({
  id: 'x',
  sessionId: 's',
  goal: 'g',
  status: 'completed',
  workerId: null,
  summary: null,
  startedAt: 0,
  attachments: [],
  events: [],
  ...over,
})

describe('latestTopLevelTask', () => {
  it('ignores later-created sub-agent children (zero usage) and returns the top-level task', () => {
    // Mirrors the real bug: the child is created after the parent (newer
    // startedAt) but carries no usage / contextWindow once rehydrated.
    const top = rec({ id: 'top', startedAt: 100, used: used(5000, 6), contextWindow: 1_048_576 })
    const child = rec({ id: 'child', startedAt: 200, parentTaskId: 'top', used: used(0, 0) })
    const latest = latestTopLevelTask([top, child])
    expect(latest?.id).toBe('top')
    expect(latest?.contextWindow).toBe(1_048_576)
    expect(latest?.used?.usdCents).toBe(6)
  })

  it('returns the most recent among multiple top-level tasks', () => {
    const a = rec({ id: 'a', startedAt: 100 })
    const b = rec({ id: 'b', startedAt: 300 })
    const c = rec({ id: 'c', startedAt: 200 })
    expect(latestTopLevelTask([a, b, c])?.id).toBe('b')
  })

  it('returns undefined when only sub-agent children exist', () => {
    expect(latestTopLevelTask([rec({ id: 'k', parentTaskId: 'p' })])).toBeUndefined()
  })
})
