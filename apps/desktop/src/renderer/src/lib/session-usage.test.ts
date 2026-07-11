import type { MessageRecord } from '@shared/lib/apply-event'
import { describe, expect, it } from 'vitest'

import { latestTopLevelTask, sessionDisplayUsage } from './session-usage'

const used = (tokens: number, usdCents: number): MessageRecord['used'] => ({
  tokens,
  calls: 1,
  wallMs: 0,
  usdCents,
  cacheRead: 0,
  cacheWrite: 0,
})

const rec = (over: Partial<MessageRecord>): MessageRecord => ({
  id: 'x',
  sessionId: 's',
  prompt: 'g',
  status: 'completed',
  summary: null,
  createdAt: 0,
  attachments: [],
  order: 0,
  events: [],
  ...over,
})

describe('latestTopLevelTask', () => {
  it('ignores later-created sub-agent children (zero usage) and returns the top-level task', () => {
    // Mirrors the real bug: the child is created after the parent (newer
    // createdAt) but carries no usage once rehydrated.
    const top = rec({ id: 'top', createdAt: 100, used: used(5000, 6) })
    const child = rec({ id: 'child', createdAt: 200, parentMessageId: 'top', used: used(0, 0) })
    const latest = latestTopLevelTask([top, child])
    expect(latest?.id).toBe('top')
    expect(latest?.used?.usdCents).toBe(6)
  })

  it('returns the most recent among multiple top-level tasks', () => {
    const a = rec({ id: 'a', createdAt: 100 })
    const b = rec({ id: 'b', createdAt: 300 })
    const c = rec({ id: 'c', createdAt: 200 })
    expect(latestTopLevelTask([a, b, c])?.id).toBe('b')
  })

  it('returns undefined when only sub-agent children exist', () => {
    expect(latestTopLevelTask([rec({ id: 'k', parentMessageId: 'p' })])).toBeUndefined()
  })
})

const usedFull = (tokens: number, calls: number, usdCents: number): MessageRecord['used'] => ({
  tokens,
  calls,
  wallMs: 0,
  usdCents,
  cacheRead: 0,
  cacheWrite: 0,
})

describe('sessionDisplayUsage', () => {
  it('sums cost + calls across turns but takes tokens from the latest turn', () => {
    const turn1 = rec({ id: 't1', createdAt: 100, used: usedFull(5000, 1, 6) })
    const turn2 = rec({ id: 't2', createdAt: 300, used: usedFull(8000, 2, 4) })
    const child = rec({ id: 'c1', createdAt: 350, parentMessageId: 't2', used: usedFull(0, 0, 0) })
    const u = sessionDisplayUsage([turn1, turn2, child])
    // Cost + calls are the whole-session total (matches the session list)…
    expect(u?.usdCents).toBe(10)
    expect(u?.calls).toBe(3)
    // …while tokens reflect the latest turn's context size (a gauge, not a sum).
    expect(u?.tokens).toBe(8000)
  })

  it('returns undefined when the session has no top-level turn', () => {
    expect(sessionDisplayUsage([rec({ id: 'k', parentMessageId: 'p', used: usedFull(0, 0, 0) })])).toBeUndefined()
  })
})
