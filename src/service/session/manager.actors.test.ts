import { describe, expect, it } from 'vitest'

import { createConversationStore } from '../conversation/store'
import { createSessionManager } from './manager'

// Minimal broadcaster + provider stubs (mirror existing session-manager tests).
const noopBroadcaster = { broadcast: () => {} }
const fakeProvider = { model: 'test', apiStyle: 'anthropic' } as any

function makeManager() {
  const store = createConversationStore(':memory:')
  const mgr = createSessionManager({
    store,
    broadcaster: noopBroadcaster,
    maxConcurrent: 2,
    getProvider: () => fakeProvider,
  })
  return { store, mgr }
}

describe('actor addressing', () => {
  it('ensureActor reuses an actor with the same session+name', () => {
    const { store, mgr } = makeManager()
    const { sessionId } = mgr.createSession(fakeProvider)
    // __ensureActorForTest is a test-only hook exported from session-manager (see Step 3).
    const a = (mgr as any).__ensureActorForTest(sessionId, 'default', 'researcher-1')
    const b = (mgr as any).__ensureActorForTest(sessionId, 'default', 'researcher-1')
    expect(a.address).toBe(b.address)
    expect(store.getActorByName(sessionId, 'researcher-1')?.address).toBe(a.address)
  })

  it('ensureActor without a name mints a fresh ULID address each call', () => {
    const { mgr } = makeManager()
    const { sessionId } = mgr.createSession(fakeProvider)
    const a = (mgr as any).__ensureActorForTest(sessionId, 'default')
    const b = (mgr as any).__ensureActorForTest(sessionId, 'default')
    expect(a.address).not.toBe(b.address)
  })
})
