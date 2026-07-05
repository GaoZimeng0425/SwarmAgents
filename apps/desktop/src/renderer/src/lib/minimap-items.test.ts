// @vitest-environment node

import type { RunRecord } from '@shared/lib/apply-event'
import { describe, expect, it } from 'vitest'

import { minimapItems } from './minimap-items'

function task(over: Partial<RunRecord>): RunRecord {
  return {
    id: 't',
    sessionId: 's1',
    goal: 'g',
    status: 'completed',
    summary: null,
    startedAt: 0,
    attachments: [],
    events: [],
    ...over,
  }
}

describe('minimapItems', () => {
  it('returns [] for no tasks', () => {
    expect(minimapItems([])).toEqual([])
  })

  it('maps top-level tasks to {runId, text, ts} ordered by startedAt', () => {
    const items = minimapItems([
      task({ id: 'b', goal: 'second', startedAt: 20 }),
      task({ id: 'a', goal: 'first', startedAt: 10 }),
    ])
    expect(items).toEqual([
      { runId: 'a', text: 'first', ts: 10 },
      { runId: 'b', text: 'second', ts: 20 },
    ])
  })

  it('excludes sub-agent tasks (parentRunId set)', () => {
    const items = minimapItems([
      task({ id: 'top', startedAt: 1 }),
      task({ id: 'sub', startedAt: 2, parentRunId: 'top' }),
    ])
    expect(items.map((i) => i.runId)).toEqual(['top'])
  })
})
