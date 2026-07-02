import type { ReactNode } from 'react'
import type { TaskRecord } from '@shared/lib/apply-event'
import { describe, expect, it } from 'vitest'

import { buildTimelineItems } from './build-timeline-items'
import type { Segment } from './task-segments'

// Minimal TaskRecord — buildTimelineItems only reads id, startedAt, parentTaskId, events.
const task = (id: string, events: TaskRecord['events'], startedAt = 1): TaskRecord =>
  ({
    id,
    sessionId: 's',
    goal: `goal-${id}`,
    status: 'running',
    workerId: null,
    summary: null,
    startedAt,
    attachments: [],
    events,
  }) as unknown as TaskRecord

const render = {
  // Tag by kind so the test can read the seq order out of the node list. Adjacent
  // assistants coalesce in taskSegments, so the inversion test uses assistant+tool.
  segment: (seg: Segment): ReactNode =>
    seg.kind === 'assistant' ? `A:${seg.text}` : seg.kind === 'tool' ? `T:${seg.tool}` : null,
  subagent: (): ReactNode => null,
  toolGroup: (): ReactNode => null,
  dayDivider: (): ReactNode => null,
}

describe('buildTimelineItems', () => {
  it('sorts items by seq, not ts (the whole point)', () => {
    // Within one task: an assistant (high seq, low ts) and a tool (low seq, high ts).
    // Output must follow seq (tool before assistant), not ts (assistant before tool).
    const t = task('t1', [
      { kind: 'task.created', sessionId: 's', taskId: 't1', goal: 'g', ts: 1, seq: 1 } as TaskRecord['events'][number],
      {
        kind: 'task.progress',
        sessionId: 's',
        taskId: 't1',
        event: { kind: 'llm.message', role: 'assistant', content: 'X', ts: 2 },
        ts: 2,
        seq: 10,
      } as TaskRecord['events'][number],
      {
        kind: 'task.progress',
        sessionId: 's',
        taskId: 't1',
        event: { kind: 'tool.call', server: 'fs', tool: 'read', args: {}, ts: 3 },
        ts: 3,
        seq: 5,
      } as TaskRecord['events'][number],
    ])
    const items = buildTimelineItems([t], render, { busy: false, showDayDividers: false })
    const tags = items.map((i) => i.node).filter((n): n is string => typeof n === 'string')
    // seq order: tool(5) before assistant(10). ts order would be assistant(2) before tool(3).
    expect(tags).toEqual(['T:read', 'A:X'])
  })

  it('interleaves two tasks by seq regardless of array order', () => {
    const a = task('ta', [
      { kind: 'task.created', sessionId: 's', taskId: 'ta', goal: 'a', ts: 1, seq: 5 } as TaskRecord['events'][number],
    ])
    const b = task('tb', [
      { kind: 'task.created', sessionId: 's', taskId: 'tb', goal: 'b', ts: 1, seq: 1 } as TaskRecord['events'][number],
    ])
    // Pass in "wrong" array order (a before b); output follows seq (b before a).
    const items = buildTimelineItems([a, b], render, { busy: false, showDayDividers: false })
    expect(items.map((i) => i.seq)).toEqual([1, 5])
  })

  it('renders the first user message before the assistant reply (first-message-order bug)', () => {
    // A top-level turn: the user message is a real event with the smallest seq.
    const t = task('t1', [
      { kind: 'task.created', sessionId: 's', taskId: 't1', goal: 'hi', ts: 1 } as TaskRecord['events'][number],
      {
        kind: 'task.progress',
        sessionId: 's',
        taskId: 't1',
        event: { kind: 'llm.message', role: 'user', content: 'hi', ts: 1 },
        ts: 1,
        seq: 1,
      } as TaskRecord['events'][number],
      {
        kind: 'task.progress',
        sessionId: 's',
        taskId: 't1',
        event: { kind: 'llm.message', role: 'assistant', content: 'hello there', ts: 2 },
        ts: 2,
        seq: 10,
      } as TaskRecord['events'][number],
    ])
    const items = buildTimelineItems([t], render, { busy: false, showDayDividers: false })
    // task.created renders no segment, so items are [user(seq 1), assistant(seq 10)].
    // The user message (smallest seq) is first — the bug was it sorted last.
    expect(items.map((i) => i.seq)).toEqual([1, 10])
  })
})
