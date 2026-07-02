import { applyEvent } from '@shared/lib/apply-event'
import { describe, expect, it } from 'vitest'

import { toRendererEvent } from './forward-event'

describe('toRendererEvent', () => {
  it('re-attaches the SSE event name as the UIEvent kind', () => {
    const e = toRendererEvent('task.created', { taskId: 't1', goal: '你好', ts: 1 })
    expect(e).toEqual({ kind: 'task.created', taskId: 't1', goal: '你好', ts: 1 })
  })

  // Regression for the "(unknown task)" / stuck-running bug: a forwarded
  // task.created must create a real record with the user's goal, not a stub.
  it('forwarded events flow through applyEvent without becoming a stub', () => {
    const created = toRendererEvent('task.created', { taskId: 't1', goal: '你好', ts: 1 })
    const afterCreate = applyEvent([], created)
    expect(afterCreate[0]).toMatchObject({ id: 't1', goal: '你好', status: 'pending' })

    const complete = toRendererEvent('task.complete', { taskId: 't1', summary: 'done', ts: 2 })
    const afterComplete = applyEvent(afterCreate, complete)
    expect(afterComplete).toHaveLength(1)
    expect(afterComplete[0]).toMatchObject({ status: 'completed', summary: 'done' })
  })
})
