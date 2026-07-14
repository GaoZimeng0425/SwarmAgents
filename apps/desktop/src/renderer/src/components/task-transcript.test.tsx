// @vitest-environment jsdom

import '@testing-library/jest-dom/vitest'
import type { MessageRecord } from '@shared/lib/apply-event'
import { cleanup, render, screen } from '@testing-library/react'
import { afterEach, describe, expect, it } from 'vitest'

import { TaskTimeline } from './task-transcript'

afterEach(() => {
  cleanup()
})

// Persisted history events are JSON-parsed without zod re-validation, so a
// legacy or corrupt task can reach the renderer with a non-finite createdAt /
// event ts. One such value must not take down <TaskTimeline>; it degrades to a
// harmless row (see safe_ts in lib/timeline.ts).
function task(overrides: Partial<MessageRecord> = {}): MessageRecord {
  return {
    id: 't1',
    sessionId: 's1',
    prompt: 'do x',
    status: 'running',
    summary: null,
    createdAt: 1,
    attachments: [],
    order: 1,
    events: [
      // The user's input content arrives as a role:'user' progress event;
      // message.created no longer carries it.
      {
        kind: 'message.progress',
        sessionId: 's1',
        messageId: 't1',
        seq: 1,
        ts: 1,
        event: { kind: 'llm.message', role: 'user', content: 'do x', ts: 1 },
      } as MessageRecord['events'][number],
    ],
    ...overrides,
  }
}

describe('TaskTimeline', () => {
  it('does not crash when a task createdAt is non-finite (corrupt/legacy event)', () => {
    expect(() =>
      render(<TaskTimeline busy={false} onCopy={() => {}} tasks={[task({ createdAt: Number.NaN })]} />)
    ).not.toThrow()
    expect(screen.getByText('do x')).toBeInTheDocument()
  })

  it('shows a frozen elapsed timer above a completed assistant reply', () => {
    const completed = task({
      status: 'completed',
      createdAt: 1000,
      events: [
        {
          kind: 'message.progress',
          sessionId: 's1',
          messageId: 't1',
          seq: 1,
          ts: 1000,
          event: { kind: 'llm.message', role: 'assistant', content: 'hello', ts: 1000, seq: 1 },
        },
        { kind: 'message.complete', sessionId: 's1', messageId: 't1', seq: 2, ts: 13_000, summary: 'done' },
      ] as MessageRecord['events'],
    })
    render(<TaskTimeline busy={false} onCopy={() => {}} tasks={[completed]} />)
    // 13_000ms - 1000ms = 12s, frozen (run is terminal).
    expect(screen.getByText('hello')).toBeInTheDocument()
    expect(screen.getByText('12s')).toBeInTheDocument()
    // Copy action renders alongside the timestamp (Base UI Tooltip mirrors the
    // trigger, so more than one matching node is expected).
    expect(screen.getAllByRole('button', { name: 'Copy' }).length).toBeGreaterThan(0)
  })
})
