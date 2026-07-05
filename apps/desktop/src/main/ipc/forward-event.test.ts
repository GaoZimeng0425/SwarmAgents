import { applyEvent } from '@shared/lib/apply-event'
import { describe, expect, it } from 'vitest'

import { toRendererEvent } from './forward-event'

describe('toRendererEvent', () => {
  it('re-attaches the SSE event name as the UIEvent kind', () => {
    const e = toRendererEvent('run.created', { runId: 't1', goal: '你好', ts: 1 })
    expect(e).toEqual({ kind: 'run.created', runId: 't1', goal: '你好', ts: 1 })
  })

  // Regression for the "(unknown run)" / stuck-running bug: a forwarded
  // run.created must create a real record with the user's goal, not a stub.
  it('forwarded events flow through applyEvent without becoming a stub', () => {
    const created = toRendererEvent('run.created', { runId: 't1', goal: '你好', ts: 1, seq: 1 })
    const afterCreate = applyEvent([], created)
    expect(afterCreate[0]).toMatchObject({ id: 't1', goal: '你好', status: 'pending' })

    const complete = toRendererEvent('run.complete', { runId: 't1', summary: 'done', ts: 2, seq: 2 })
    const afterComplete = applyEvent(afterCreate, complete)
    expect(afterComplete).toHaveLength(1)
    expect(afterComplete[0]).toMatchObject({ status: 'completed', summary: 'done' })
  })
})
