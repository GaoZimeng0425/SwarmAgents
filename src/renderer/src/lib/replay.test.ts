import type { Task } from '@shared/types/task'
import { describe, expect, it } from 'vitest'

import { tasksToRecords } from './replay'

const baseTask = (over: Partial<Task>): Task => ({
  id: '01HRX0000000000000000000R1',
  parentId: null,
  agentDefId: 'default',
  goal: 'g',
  status: 'completed',
  assignedWorkerId: null,
  toolAllowlist: [],
  budget: { tokens: 0, calls: 0, wallMs: 0, usdCents: 0 },
  used: { tokens: 0, calls: 0, wallMs: 0, usdCents: 0 },
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
})
