// @vitest-environment jsdom

import '@testing-library/jest-dom/vitest'
import type { Segment } from '@swarm/shared'
import { cleanup, render, screen } from '@testing-library/react'
import { afterEach, describe, expect, it } from 'vitest'

import { TaskTimeline } from './task-transcript'

afterEach(() => {
  cleanup()
})

const userSeg = (text: string, key = 'u1'): Segment => ({ kind: 'user', text, key, ts: 1 })
const assistantSeg = (text: string, key = 'a1'): Segment => ({ kind: 'assistant', text, key, ts: 2 })

describe('TaskTimeline', () => {
  it('renders user and assistant segments', () => {
    render(<TaskTimeline busy={false} onCopy={() => {}} segments={[userSeg('do x'), assistantSeg('hello')]} />)
    expect(screen.getByText('do x')).toBeInTheDocument()
    expect(screen.getByText('hello')).toBeInTheDocument()
    // Copy action renders alongside the timestamp (Base UI Tooltip mirrors the
    // trigger, so more than one matching node is expected).
    expect(screen.getAllByRole('button', { name: 'Copy' }).length).toBeGreaterThan(0)
  })

  it('does not crash on a segment with a non-finite ts (corrupt/legacy entry)', () => {
    expect(() =>
      render(
        <TaskTimeline
          busy={false}
          onCopy={() => {}}
          segments={[{ kind: 'user', text: 'do x', key: 'u1', ts: Number.NaN }]}
        />
      )
    ).not.toThrow()
    expect(screen.getByText('do x')).toBeInTheDocument()
  })
})
