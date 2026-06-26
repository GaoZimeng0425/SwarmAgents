import { describe, expect, it } from 'vitest'

import type { TaskRecord } from './apply-event'
import { classifyComposerTurns } from './composer-turns'

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

describe('classifyComposerTurns', () => {
  it('treats a lone pending turn as active, not queued (the created→dispatched window)', () => {
    // Submitting while idle: the turn is 'pending' until task.dispatched arrives.
    // With no running turn ahead of it, it is the active/starting turn — not a
    // staging card.
    const { activeTask, queuedTasks } = classifyComposerTurns([rec({ id: 't1', status: 'pending', startedAt: 100 })])
    expect(activeTask?.id).toBe('t1')
    expect(queuedTasks).toEqual([])
  })

  it('queues pending turns behind a running turn', () => {
    const running = rec({ id: 'r', status: 'running', startedAt: 100 })
    const queued = rec({ id: 'q', status: 'pending', startedAt: 200 })
    const { activeTask, queuedTasks } = classifyComposerTurns([queued, running])
    expect(activeTask?.id).toBe('r')
    expect(queuedTasks.map((t) => t.id)).toEqual(['q'])
  })

  it('promotes the earliest pending turn and queues the rest when nothing is running', () => {
    const a = rec({ id: 'a', status: 'pending', startedAt: 300 })
    const b = rec({ id: 'b', status: 'pending', startedAt: 100 })
    const c = rec({ id: 'c', status: 'pending', startedAt: 200 })
    const { activeTask, queuedTasks } = classifyComposerTurns([a, b, c])
    expect(activeTask?.id).toBe('b')
    expect(queuedTasks.map((t) => t.id)).toEqual(['c', 'a'])
  })

  it('treats an awaiting_user turn as the active turn', () => {
    const awaiting = rec({ id: 'w', status: 'awaiting_user', startedAt: 100 })
    const pending = rec({ id: 'p', status: 'pending', startedAt: 200 })
    const { activeTask, queuedTasks } = classifyComposerTurns([awaiting, pending])
    expect(activeTask?.id).toBe('w')
    expect(queuedTasks.map((t) => t.id)).toEqual(['p'])
  })

  it('ignores sub-agent children — only top-level turns count', () => {
    const child = rec({ id: 'c', status: 'pending', startedAt: 100, parentTaskId: 'top' })
    const { activeTask, queuedTasks } = classifyComposerTurns([child])
    expect(activeTask).toBeUndefined()
    expect(queuedTasks).toEqual([])
  })

  it('has no active turn when all top-level turns are terminal', () => {
    const done = rec({ id: 'd', status: 'completed', startedAt: 100 })
    const { activeTask, queuedTasks } = classifyComposerTurns([done])
    expect(activeTask).toBeUndefined()
    expect(queuedTasks).toEqual([])
  })
})
