import { applyEvent } from '@shared/lib/apply-event'
import { describe, expect, it } from 'vitest'

import { toRendererEvent } from './forward-event'

describe('toRendererEvent', () => {
  it('re-attaches the SSE event name as the UIEvent kind', () => {
    const e = toRendererEvent('message.created', { messageId: 't1', ts: 1 })
    expect(e).toEqual({ kind: 'message.created', messageId: 't1', ts: 1 })
  })

  // Regression for the "(unknown run)" / stuck-running bug: a forwarded
  // message.created must create a real record, and the user's prompt is
  // back-filled from the role:'user' progress event (not from created).
  it('forwarded events flow through applyEvent without becoming a stub', () => {
    const created = toRendererEvent('message.created', { messageId: 't1', ts: 1, seq: 1 })
    const afterCreate = applyEvent([], created)
    expect(afterCreate[0]).toMatchObject({ id: 't1', status: 'pending' })

    const progress = toRendererEvent('message.progress', {
      messageId: 't1',
      event: { kind: 'llm.message', role: 'user', content: '你好', ts: 1 },
      ts: 1,
      seq: 2,
    })
    const afterProgress = applyEvent(afterCreate, progress)
    expect(afterProgress[0]).toMatchObject({ id: 't1', prompt: '你好' })

    const complete = toRendererEvent('message.complete', { messageId: 't1', summary: 'done', ts: 2, seq: 3 })
    const afterComplete = applyEvent(afterProgress, complete)
    expect(afterComplete).toHaveLength(1)
    expect(afterComplete[0]).toMatchObject({ status: 'completed', summary: 'done' })
  })
})
