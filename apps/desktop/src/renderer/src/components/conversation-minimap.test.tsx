// @vitest-environment jsdom
import '@testing-library/jest-dom/vitest'
import type { RunRecord } from '@shared/lib/apply-event'
import { cleanup, render, screen } from '@testing-library/react'
import { afterEach, describe, expect, it } from 'vitest'

import { ConversationMinimap } from './conversation-minimap'

function task(over: Partial<RunRecord>): RunRecord {
  return {
    id: 't',
    sessionId: 's1',
    goal: 'g',
    status: 'completed',
    summary: null,
    startedAt: 0,
    attachments: [],
    events: [],
    ...over,
  }
}

afterEach(cleanup)

describe('ConversationMinimap', () => {
  it('renders one tick per top-level turn', () => {
    render(
      <ConversationMinimap
        tasks={[
          task({ id: 'a', goal: 'first', startedAt: 1 }),
          task({ id: 'b', goal: 'second', startedAt: 2 }),
          task({ id: 'sub', goal: 'nested', startedAt: 3, parentRunId: 'a' }),
        ]}
      />
    )
    expect(screen.getAllByRole('button')).toHaveLength(2)
  })

  it('renders nothing with fewer than 2 turns', () => {
    const { container } = render(<ConversationMinimap tasks={[task({ id: 'only' })]} />)
    expect(container).toBeEmptyDOMElement()
  })
})
