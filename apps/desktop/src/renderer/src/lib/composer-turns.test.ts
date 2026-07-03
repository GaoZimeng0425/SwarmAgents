import type { RunRecord } from '@shared/lib/apply-event'
import { describe, expect, it } from 'vitest'

import { classifyComposerTurns } from './composer-turns'

const rec = (over: Partial<RunRecord>): RunRecord => ({
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

  it('keeps a turn submitted mid-run out of the transcript (only in the pending list)', () => {
    const running = rec({ id: 'r', status: 'running', startedAt: 100 })
    const queued = rec({ id: 'q', status: 'pending', startedAt: 200 })
    const { queuedTasks, transcriptTasks } = classifyComposerTurns([queued, running])
    expect(queuedTasks.map((t) => t.id)).toEqual(['q'])
    // The queued turn is staged in the composer; the transcript shows only the
    // active running turn — not the just-submitted pending one.
    expect(transcriptTasks.map((t) => t.id)).toEqual(['r'])
  })

  it('keeps the active (running and starting) turns in the transcript', () => {
    const running = rec({ id: 'r', status: 'running', startedAt: 100 })
    const done = rec({ id: 'd', status: 'completed', startedAt: 50 })
    const { transcriptTasks } = classifyComposerTurns([done, running])
    expect(transcriptTasks.map((t) => t.id).sort()).toEqual(['d', 'r'])
  })

  it('keeps sub-agent children in the transcript', () => {
    const running = rec({ id: 'r', status: 'running', startedAt: 100 })
    const child = rec({ id: 'c', status: 'pending', startedAt: 150, parentTaskId: 'r' })
    const queued = rec({ id: 'q', status: 'pending', startedAt: 200 })
    const { transcriptTasks } = classifyComposerTurns([running, child, queued])
    // Children belong in the transcript; only the top-level queued turn is excluded.
    expect(transcriptTasks.map((t) => t.id).sort()).toEqual(['c', 'r'])
  })

  it('renders pending turns as transcript (not queued cards) for a non-active session', () => {
    // An interrupted/ended session can't resume any turn, so its pending turns
    // are zombies — they must not be painted as staging cards.
    const a = rec({ id: 'a', status: 'pending', startedAt: 100 })
    const b = rec({ id: 'b', status: 'pending', startedAt: 200 })
    for (const status of ['interrupted', 'ended'] as const) {
      const { activeTask, queuedTasks, transcriptTasks } = classifyComposerTurns([a, b], status)
      expect(activeTask).toBeUndefined()
      expect(queuedTasks).toEqual([])
      expect(transcriptTasks.map((t) => t.id).sort()).toEqual(['a', 'b'])
    }
  })
})
