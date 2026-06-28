// @vitest-environment jsdom
import '@testing-library/jest-dom/vitest'
import { cleanup, render, screen } from '@testing-library/react'
import { afterEach, describe, expect, it } from 'vitest'
import { TranscribeProgress } from './transcribe-progress'

afterEach(cleanup)

const stateOf = (key: string): string | null => screen.getByTestId(`step-${key}`).getAttribute('data-state')

describe('TranscribeProgress', () => {
  it('marks the active step and leaves later steps pending', () => {
    render(<TranscribeProgress stage="transcribing" />)
    expect(stateOf('audio')).toBe('done')
    expect(stateOf('transcribing')).toBe('active')
    expect(stateOf('summarizing')).toBe('pending')
  })

  it('marks all steps pending while queued', () => {
    render(<TranscribeProgress stage="queued" />)
    expect(stateOf('audio')).toBe('pending')
    expect(stateOf('transcribing')).toBe('pending')
    expect(stateOf('summarizing')).toBe('pending')
  })

  it('marks earlier steps done on the last step', () => {
    render(<TranscribeProgress stage="summarizing" />)
    expect(stateOf('audio')).toBe('done')
    expect(stateOf('transcribing')).toBe('done')
    expect(stateOf('summarizing')).toBe('active')
  })
})
