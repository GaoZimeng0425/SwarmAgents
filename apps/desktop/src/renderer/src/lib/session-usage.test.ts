import type { RunRecord } from '@shared/lib/apply-event'
import { describe, expect, it } from 'vitest'

import { latestTopLevelTask, sessionDisplayUsage } from './session-usage'

const used = (tokens: number, usdCents: number): RunRecord['used'] => ({
  tokens,
  calls: 1,
  wallMs: 0,
  usdCents,
  cacheRead: 0,
  cacheWrite: 0,
})

const rec = (over: Partial<RunRecord>): RunRecord => ({
  id: 'x',
  sessionId: 's',
  prompt: 'g',
  status: 'completed',
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
    const child = rec({ id: 'child', startedAt: 200, parentRunId: 'top', used: used(0, 0) })
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
    expect(latestTopLevelTask([rec({ id: 'k', parentRunId: 'p' })])).toBeUndefined()
  })
})

const usedFull = (tokens: number, calls: number, usdCents: number): RunRecord['used'] => ({
  tokens,
  calls,
  wallMs: 0,
  usdCents,
  cacheRead: 0,
  cacheWrite: 0,
})

describe('sessionDisplayUsage', () => {
  it('sums cost + calls across turns but takes tokens from the latest turn', () => {
    const turn1 = rec({ id: 't1', startedAt: 100, used: usedFull(5000, 1, 6), contextWindow: 1_048_576 })
    const turn2 = rec({ id: 't2', startedAt: 300, used: usedFull(8000, 2, 4), contextWindow: 1_048_576 })
    const child = rec({ id: 'c1', startedAt: 350, parentRunId: 't2', used: usedFull(0, 0, 0) })
    const u = sessionDisplayUsage([turn1, turn2, child])
    // Cost + calls are the whole-session total (matches the session list)…
    expect(u?.usdCents).toBe(10)
    expect(u?.calls).toBe(3)
    // …while tokens reflect the latest turn's context size (a gauge, not a sum).
    expect(u?.tokens).toBe(8000)
  })

  it('returns undefined when the session has no top-level turn', () => {
    expect(sessionDisplayUsage([rec({ id: 'k', parentRunId: 'p', used: usedFull(0, 0, 0) })])).toBeUndefined()
  })
})
