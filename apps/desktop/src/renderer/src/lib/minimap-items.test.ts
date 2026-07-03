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
    workerId: null,
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

  it('maps top-level tasks to {taskId, text, ts} ordered by startedAt', () => {
    const items = minimapItems([
      task({ id: 'b', goal: 'second', startedAt: 20 }),
      task({ id: 'a', goal: 'first', startedAt: 10 }),
    ])
    expect(items).toEqual([
      { taskId: 'a', text: 'first', ts: 10 },
      { taskId: 'b', text: 'second', ts: 20 },
    ])
  })

  it('excludes sub-agent tasks (parentTaskId set)', () => {
    const items = minimapItems([
      task({ id: 'top', startedAt: 1 }),
      task({ id: 'sub', startedAt: 2, parentTaskId: 'top' }),
    ])
    expect(items.map((i) => i.taskId)).toEqual(['top'])
  })
})
