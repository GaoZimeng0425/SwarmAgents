// @vitest-environment jsdom

import '@testing-library/jest-dom/vitest'
import { cleanup, render, screen } from '@testing-library/react'
import { afterEach, describe, expect, it } from 'vitest'

import type { TaskRecord } from '@shared/lib/apply-event'
import { TaskTimeline } from './task-transcript'

afterEach(() => {
  cleanup()
})

// Persisted history events are JSON-parsed without zod re-validation, so a
// legacy or corrupt task can reach the renderer with a non-finite startedAt /
// event ts. One such value must not take down <TaskTimeline>; it degrades to a
// harmless row (see safeTs in lib/timeline.ts).
function task(overrides: Partial<TaskRecord> = {}): TaskRecord {
  return {
    id: 't1',
    sessionId: 's1',
    goal: 'do x',
    status: 'running',
    workerId: null,
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
})
