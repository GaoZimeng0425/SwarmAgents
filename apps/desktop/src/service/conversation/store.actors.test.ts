import { afterEach, beforeEach, describe, expect, it } from 'vitest'

import { type ConversationStore, createConversationStore } from './store'

let store: ConversationStore
beforeEach(() => {
  store = createConversationStore(':memory:')
})
afterEach(() => store.close())

const now = 1_000

describe('actor persistence', () => {
  it('upserts and reads an actor by address and by name', () => {
    store.upsertActor({
      address: 'addr-1',
      agentDefId: 'default',
      sessionId: 's1',
      name: 'researcher-1',
      state: null,
      lastTaskId: null,
      createdAt: now,
      updatedAt: now,
    })
    expect(store.getActor('addr-1')?.agentDefId).toBe('default')
    expect(store.getActorByName('s1', 'researcher-1')?.address).toBe('addr-1')
    expect(store.getActorByName('s1', 'nope')).toBeUndefined()
  })

  it('enqueues, reads next unconsumed in ts order, and marks consumed', () => {
    store.upsertActor({
      address: 'addr-1',
      agentDefId: 'default',
      sessionId: 's1',
      name: null,
      state: null,
      lastTaskId: null,
      createdAt: now,
      updatedAt: now,
    })
    store.enqueueMessage({
      id: 'm2',
      toAddr: 'addr-1',
      fromAddr: null,
      kind: 'send',
      correlationId: null,
      payload: '{}',
      consumed: false,
      retries: 0,
      dead: false,
      ts: 20,
    })
    store.enqueueMessage({
      id: 'm1',
      toAddr: 'addr-1',
      fromAddr: null,
      kind: 'send',
      correlationId: null,
      payload: '{}',
      consumed: false,
      retries: 0,
      dead: false,
      ts: 10,
    })
    expect(store.nextUnconsumedFor('addr-1')?.id).toBe('m1') // earliest ts first
    store.markConsumed('m1')
    expect(store.nextUnconsumedFor('addr-1')?.id).toBe('m2')
  })

  it('upsertActor updates fields on conflict while preserving createdAt', () => {
    store.upsertActor({
      address: 'addr-up',
      agentDefId: 'default',
      sessionId: 's1',
      name: null,
      state: null,
      lastTaskId: null,
      createdAt: now,
      updatedAt: now,
    })
    // Re-upsert same address with updated fields
    store.upsertActor({
      address: 'addr-up',
      agentDefId: 'default',
      sessionId: 's1',
      name: null,
      state: null,
      lastTaskId: 'task-9',
      createdAt: now,
      updatedAt: now + 5,
    })
    const actor = store.getActor('addr-up')
    expect(actor?.lastTaskId).toBe('task-9')
    expect(actor?.updatedAt).toBe(now + 5)
    expect(actor?.createdAt).toBe(now) // creation timestamp must not change
  })

  it('marks dead and bumps retries', () => {
    store.enqueueMessage({
      id: 'm1',
      toAddr: 'ghost',
      fromAddr: null,
      kind: 'send',
      correlationId: null,
      payload: '{}',
      consumed: false,
      retries: 0,
      dead: false,
      ts: 10,
    })
    expect(store.bumpRetries('m1')).toBe(1)
    store.markDead('m1')
    expect(store.nextUnconsumedFor('ghost')).toBeUndefined() // dead excluded
  })

  it('listUnconsumedAddresses returns distinct addrs with pending, non-dead messages', () => {
    store.upsertActor({
      address: 'a1',
      agentDefId: 'default',
      sessionId: 's1',
      name: null,
      state: null,
      lastTaskId: null,
      createdAt: 1,
      updatedAt: 1,
    })
    store.enqueueMessage({
      id: 'm1',
      toAddr: 'a1',
      fromAddr: null,
      kind: 'send',
      correlationId: null,
      payload: 'x',
      consumed: false,
      retries: 0,
      dead: false,
      ts: 1,
    })
    store.enqueueMessage({
      id: 'm2',
      toAddr: 'a1',
      fromAddr: null,
      kind: 'send',
      correlationId: null,
      payload: 'y',
      consumed: true,
      retries: 0,
      dead: false,
      ts: 2,
    })
    expect(store.listUnconsumedAddresses()).toEqual(['a1'])
  })

  it('allUnconsumedFor returns all pending, non-dead messages in ts order', () => {
    store.upsertActor({
      address: 'a1',
      agentDefId: 'default',
      sessionId: 's1',
      name: null,
      state: null,
      lastTaskId: null,
      createdAt: 1,
      updatedAt: 1,
    })
    store.enqueueMessage({
      id: 'later',
      toAddr: 'a1',
      fromAddr: null,
      kind: 'send',
      correlationId: null,
      payload: 'b',
      consumed: false,
      retries: 0,
      dead: false,
      ts: 20,
    })
    store.enqueueMessage({
      id: 'earlier',
      toAddr: 'a1',
      fromAddr: null,
      kind: 'send',
      correlationId: null,
      payload: 'a',
      consumed: false,
      retries: 0,
      dead: false,
      ts: 10,
    })
    store.enqueueMessage({
      id: 'done',
      toAddr: 'a1',
      fromAddr: null,
      kind: 'send',
      correlationId: null,
      payload: 'c',
      consumed: true,
      retries: 0,
      dead: false,
      ts: 30,
    })
    expect(store.allUnconsumedFor('a1').map((m) => m.id)).toEqual(['earlier', 'later'])
  })
})
