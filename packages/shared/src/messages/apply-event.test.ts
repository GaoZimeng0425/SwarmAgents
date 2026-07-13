import { describe, expect, it } from 'vitest'

import { applyEvent, type MessageRecord } from './apply-event'

const baseRecord = (id = 'm1'): MessageRecord => ({
  id,
  sessionId: 's',
  prompt: 'hi',
  status: 'running',
  summary: null,
  createdAt: 0,
  attachments: [],
  order: 0,
  events: [],
})

function baseEvent(messageId: string) {
  return { sessionId: 's', messageId, seq: 0, ts: 0 }
}

describe('applyEvent delegation', () => {
  it('message.delegation_plan sets delegationPlan', () => {
    const rec = baseRecord()
    const result = applyEvent([rec], {
      ...baseEvent(rec.id),
      kind: 'message.delegation_plan',
      plan: [{ id: 'd1', prompt: 'x', dependsOn: [] }],
    })
    expect(result[0].delegationPlan).toEqual([{ id: 'd1', prompt: 'x', dependsOn: [] }])
  })

  it('message.delegation_plan replaces a previous plan wholesale', () => {
    const rec = baseRecord()
    const first = applyEvent([rec], {
      ...baseEvent(rec.id),
      kind: 'message.delegation_plan',
      plan: [{ id: 'd1', prompt: 'first', dependsOn: [] }],
    })
    const second = applyEvent(first, {
      ...baseEvent(rec.id),
      kind: 'message.delegation_plan',
      plan: [{ id: 'd2', prompt: 'second', dependsOn: [] }],
    })
    expect(second[0].delegationPlan).toEqual([{ id: 'd2', prompt: 'second', dependsOn: [] }])
  })

  it('message.delegation_update appends to delegationUpdates', () => {
    const rec = baseRecord()
    const e1 = applyEvent([rec], {
      ...baseEvent(rec.id),
      kind: 'message.delegation_update',
      itemId: 'd1',
      status: 'running',
      result: [],
    })
    const e2 = applyEvent(e1, {
      ...baseEvent(rec.id),
      kind: 'message.delegation_update',
      itemId: 'd1',
      status: 'completed',
      result: [{ kind: 'note', text: 'done' }],
    })
    expect(e2[0].delegationUpdates).toHaveLength(2)
    expect(e2[0].delegationUpdates?.[0]).toEqual({ itemId: 'd1', status: 'running', result: [] })
    expect(e2[0].delegationUpdates?.[1].status).toBe('completed')
    expect(e2[0].delegationUpdates?.[1].result).toEqual([{ kind: 'note', text: 'done' }])
  })

  it('message.delegation_update does not mutate the prior update (pure append)', () => {
    const rec = baseRecord()
    const e1 = applyEvent([rec], {
      ...baseEvent(rec.id),
      kind: 'message.delegation_update',
      itemId: 'd1',
      status: 'running',
      result: [],
    })
    applyEvent(e1, {
      ...baseEvent(rec.id),
      kind: 'message.delegation_update',
      itemId: 'd1',
      status: 'completed',
      result: [{ kind: 'note', text: 'done' }],
    })
    expect(e1[0].delegationUpdates).toHaveLength(1)
  })
})
