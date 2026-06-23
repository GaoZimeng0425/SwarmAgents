import { describe, expect, it } from 'vitest'

import { createConversationStore } from './store'

function freshStore() {
  // In-memory SQLite: dbPath ':memory:' (matches existing store tests).
  return createConversationStore(':memory:')
}

describe('consumeAndPersist', () => {
  it('marks the message consumed AND writes actor.state in one shot', () => {
    const store = freshStore()
    const now = 1_000
    store.upsertActor({
      address: 'a1',
      agentDefId: 'default',
      sessionId: 's1',
      name: null,
      state: null,
      lastTaskId: 't1',
      createdAt: now,
      updatedAt: now,
    })
    store.enqueueMessage({
      id: 'm1',
      toAddr: 'a1',
      fromAddr: null,
      kind: 'send',
      correlationId: null,
      payload: 'hi',
      consumed: false,
      retries: 0,
      dead: false,
      ts: now,
    })

    store.consumeAndPersist('m1', 'a1', '{"v":1,"messages":[]}', 2_000)

    expect(store.nextUnconsumedFor('a1')).toBeUndefined() // consumed
    const actor = store.getActor('a1')
    expect(actor?.state).toBe('{"v":1,"messages":[]}')
    expect(actor?.updatedAt).toBe(2_000)
    expect(actor?.lastTaskId).toBe('t1') // untouched by the targeted UPDATE
    store.close()
  })
})
