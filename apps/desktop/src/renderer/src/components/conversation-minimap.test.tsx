// @vitest-environment jsdom
import '@testing-library/jest-dom/vitest'
import type { MessageRecord } from '@shared/lib/apply-event'
import { cleanup, render, screen } from '@testing-library/react'
import { afterEach, describe, expect, it } from 'vitest'

import { ConversationMinimap } from './conversation-minimap'

function task(over: Partial<MessageRecord>): MessageRecord {
  return {
    id: 't',
    sessionId: 's1',
    prompt: 'g',
    status: 'completed',
    summary: null,
    createdAt: 0,
    attachments: [],
    order: 0,
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
          task({ id: 'a', prompt: 'first', createdAt: 1 }),
          task({ id: 'b', prompt: 'second', createdAt: 2 }),
          task({ id: 'sub', prompt: 'nested', createdAt: 3, parentMessageId: 'a' }),
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
