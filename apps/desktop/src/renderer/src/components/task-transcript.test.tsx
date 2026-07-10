// @vitest-environment jsdom

import '@testing-library/jest-dom/vitest'
import type { RunRecord } from '@shared/lib/apply-event'
import { cleanup, render, screen } from '@testing-library/react'
import { afterEach, describe, expect, it } from 'vitest'

import { TaskTimeline } from './task-transcript'

afterEach(() => {
  cleanup()
})

// Persisted history events are JSON-parsed without zod re-validation, so a
// legacy or corrupt task can reach the renderer with a non-finite startedAt /
// event ts. One such value must not take down <TaskTimeline>; it degrades to a
// harmless row (see safeTs in lib/timeline.ts).
function task(overrides: Partial<RunRecord> = {}): RunRecord {
  return {
    id: 't1',
    sessionId: 's1',
    goal: 'do x',
    status: 'running',
    summary: null,
    startedAt: 1,
    attachments: [],
    events: [],
    ...overrides,
  }
}

describe('TaskTimeline', () => {
  it('does not crash when a task startedAt is non-finite (corrupt/legacy event)', () => {
    expect(() =>
      render(<TaskTimeline busy={false} onCopy={() => {}} tasks={[task({ startedAt: Number.NaN })]} />)
    ).not.toThrow()
    expect(screen.getByText('do x')).toBeInTheDocument()
  })

  it('shows a frozen elapsed timer above a completed assistant reply', () => {
    const completed = task({
      status: 'completed',
      startedAt: 1000,
      events: [
        {
          kind: 'run.progress',
          sessionId: 's1',
          runId: 't1',
          seq: 1,
          ts: 1000,
          event: { kind: 'llm.message', role: 'assistant', content: 'hello', ts: 1000, seq: 1 },
        },
        { kind: 'run.complete', sessionId: 's1', runId: 't1', seq: 2, ts: 13_000, summary: 'done' },
      ] as RunRecord['events'],
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
