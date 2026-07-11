// @vitest-environment node

import type { MessageRecord } from '@shared/lib/apply-event'
import { describe, expect, it } from 'vitest'

import { minimapItems } from './minimap-items'

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

describe('minimapItems', () => {
  it('returns [] for no tasks', () => {
    expect(minimapItems([])).toEqual([])
  })

  it('maps top-level tasks to {messageId, text, ts} ordered by order', () => {
    const items = minimapItems([
      task({ id: 'b', prompt: 'second', createdAt: 20, order: 2 }),
      task({ id: 'a', prompt: 'first', createdAt: 10, order: 1 }),
    ])
    expect(items).toEqual([
      { messageId: 'a', text: 'first', ts: 10 },
      { messageId: 'b', text: 'second', ts: 20 },
    ])
  })

  it('excludes sub-agent tasks (parentMessageId set)', () => {
    const items = minimapItems([
      task({ id: 'top', createdAt: 1, order: 1 }),
      task({ id: 'sub', createdAt: 2, parentMessageId: 'top', order: 2 }),
    ])
    expect(items.map((i) => i.messageId)).toEqual(['top'])
  })
})
