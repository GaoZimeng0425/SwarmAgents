import type { EntryRow } from '@swarm/protocol'
import { emptySessionView, type SessionView } from '@swarm/shared'
import { describe, expect, it } from 'vitest'

import { sessionDisplayUsage } from './session-usage'

// An assistant message entry carrying pi usage (totalTokens + cost.total$).
function assistantRow(rowId: number, totalTokens: number, costUsd: number): EntryRow {
  return {
    rowId,
    entry: {
      id: `a${rowId}`,
      parentId: null,
      timestamp: '2026-01-01T00:00:00.000Z',
      type: 'message',
      message: {
        role: 'assistant',
        content: 'hi',
        usage: { totalTokens, cost: { total: costUsd }, cacheRead: 0, cacheWrite: 0 },
      },
    },
  }
}

function viewOf(rows: EntryRow[]): SessionView {
  return { ...emptySessionView(), entries: rows, cursor: rows.at(-1)?.rowId ?? 0 }
}

describe('sessionDisplayUsage', () => {
  it('sums cost across assistant turns but takes tokens from the latest turn', () => {
    const u = sessionDisplayUsage(viewOf([assistantRow(1, 5000, 0.06), assistantRow(2, 8000, 0.04)]))
    // Cost is the whole-session total (matches the session list)…
    expect(u?.usdCents).toBe(10)
    expect(u?.calls).toBe(2)
    // …while tokens reflect the latest turn's context size (a gauge, not a sum).
    expect(u?.tokens).toBe(8000)
  })

  it('prefers the live turn_end snapshot for current context size', () => {
    const view: SessionView = {
      ...viewOf([assistantRow(1, 5000, 0.06)]),
      usage: {
        used: { tokens: 0, calls: 3, wallMs: 100, usdCents: 0, cacheRead: 12, cacheWrite: 0 },
        contextTokens: 9001,
      },
    }
    const u = sessionDisplayUsage(view)
    expect(u?.tokens).toBe(9001)
    expect(u?.cacheRead).toBe(12)
    expect(u?.usdCents).toBe(6)
  })

  it('returns undefined when the session has no assistant usage yet', () => {
    expect(sessionDisplayUsage(emptySessionView())).toBeUndefined()
  })
})
