import type { ReactNode } from 'react'
import type { MessageRecord } from '@shared/lib/apply-event'
import { describe, expect, it } from 'vitest'

import { buildTimelineItems } from './build-timeline-items'
import type { Segment } from './task-segments'

// Minimal MessageRecord — buildTimelineItems reads id, createdAt, parentMessageId, order, events.
const task = (id: string, events: MessageRecord['events'], createdAt = 1, order = 0): MessageRecord =>
  ({
    id,
    sessionId: 's',
    prompt: `goal-${id}`,
    status: 'running',
    summary: null,
    createdAt,
    attachments: [],
    order,
    events,
  }) as unknown as MessageRecord

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
  it('sorts items by order, not ts (the whole point)', () => {
    // Within one task: an assistant (high order, low ts) and a tool (low order, high ts).
    // Output must follow order (tool before assistant), not ts (assistant before tool).
    const t = task('t1', [
      {
        kind: 'message.created',
        sessionId: 's',
        messageId: 't1',
        prompt: 'g',
        ts: 1,
        seq: 1,
      } as MessageRecord['events'][number],
      {
        kind: 'message.progress',
        sessionId: 's',
        messageId: 't1',
        event: { kind: 'llm.message', role: 'assistant', content: 'X', ts: 2 },
        ts: 2,
        seq: 10,
      } as MessageRecord['events'][number],
      {
        kind: 'message.progress',
        sessionId: 's',
        messageId: 't1',
        event: { kind: 'tool.call', server: 'fs', tool: 'read', args: {}, ts: 3 },
        ts: 3,
        seq: 5,
      } as MessageRecord['events'][number],
    ])
    const items = buildTimelineItems([t], render, { busy: false, showDayDividers: false })
    const tags = items.map((i) => i.node).filter((n): n is string => typeof n === 'string')
    // order order: tool(5) before assistant(10). ts order would be assistant(2) before tool(3).
    expect(tags).toEqual(['T:read', 'A:X'])
  })

  it('interleaves two tasks by order regardless of array order', () => {
    const a = task(
      'ta',
      [
        {
          kind: 'message.progress',
          sessionId: 's',
          messageId: 'ta',
          event: { kind: 'llm.message', role: 'user', content: 'a', ts: 1 },
          ts: 1,
          seq: 5,
        } as MessageRecord['events'][number],
      ],
      1,
      5
    )
    const b = task(
      'tb',
      [
        {
          kind: 'message.progress',
          sessionId: 's',
          messageId: 'tb',
          event: { kind: 'llm.message', role: 'user', content: 'b', ts: 1 },
          ts: 1,
          seq: 1,
        } as MessageRecord['events'][number],
      ],
      1,
      1
    )
    // Pass in "wrong" array order (a before b); output follows order (b before a).
    const items = buildTimelineItems([a, b], render, { busy: false, showDayDividers: false })
    expect(items.map((i) => i.order)).toEqual([1, 5])
  })

  it('renders the first user message before the assistant reply (first-message-order bug)', () => {
    // A top-level turn: the user message is a real event with the smallest order.
    const t = task('t1', [
      {
        kind: 'message.created',
        sessionId: 's',
        messageId: 't1',
        ts: 1,
      } as MessageRecord['events'][number],
      {
        kind: 'message.progress',
        sessionId: 's',
        messageId: 't1',
        event: { kind: 'llm.message', role: 'user', content: 'hi', ts: 1 },
        ts: 1,
        seq: 1,
      } as MessageRecord['events'][number],
      {
        kind: 'message.progress',
        sessionId: 's',
        messageId: 't1',
        event: { kind: 'llm.message', role: 'assistant', content: 'hello there', ts: 2 },
        ts: 2,
        seq: 10,
      } as MessageRecord['events'][number],
    ])
    const items = buildTimelineItems([t], render, { busy: false, showDayDividers: false })
    // task.created renders no segment, so items are [user(order 1), assistant(order 10)].
    // The user message (smallest order) is first — the bug was it sorted last.
    expect(items.map((i) => i.order)).toEqual([1, 10])
  })
})
