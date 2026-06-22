import { expect, it, vi } from 'vitest'

const delivered: string[] = []
vi.mock('./agent-runner', () => ({
  createAgentRunner: (_d: unknown) => ({
    run: async () => ({ status: 'completed', summary: '', messages: [], used: {} }),
  }),
  buildAgentSession: () => ({}),
  runResident: async (
    _d: unknown,
    mailbox: { receive(o: { idleMs: number }): Promise<{ id: string }> },
    hooks: {
      acquireTurnSlot(): Promise<void>
      releaseTurnSlot(): void
      onConsumed(id: string): void
    }
  ) => {
    for (;;) {
      let m: { id: string }
      try {
        m = await mailbox.receive({ idleMs: 5 })
      } catch {
        return
      }
      delivered.push(m.id)
      await hooks.acquireTurnSlot()
      hooks.releaseTurnSlot()
      hooks.onConsumed(m.id)
    }
  },
}))

import { createConversationStore } from './conversation-store'
import { createSessionManager } from './session-manager'

const fakeProvider = { model: 'test', apiStyle: 'anthropic' } as never

it('re-drains unconsumed messages for a known actor on startup', async () => {
  const store = createConversationStore(':memory:')
  // Pre-seed a session, actor, and an unconsumed message (simulating a crash).
  const mgr0 = createSessionManager({
    store,
    broadcaster: { broadcast: () => {} },
    maxConcurrent: 4,
    getProvider: () => fakeProvider,
  })
  const { sessionId } = mgr0.createSession(fakeProvider)
  const a = (
    mgr0 as unknown as { __ensureActorForTest(s: string, d: string, n: string): { address: string } }
  ).__ensureActorForTest(sessionId, 'default', 'w')
  store.enqueueMessage({
    id: 'orphan',
    toAddr: a.address,
    fromAddr: null,
    kind: 'send',
    correlationId: null,
    payload: 'z',
    consumed: false,
    retries: 0,
    dead: false,
    ts: 1,
  })
  delivered.length = 0
  // New manager over the same store → should re-drain on init.
  createSessionManager({
    store,
    broadcaster: { broadcast: () => {} },
    maxConcurrent: 4,
    getProvider: () => fakeProvider,
  })
  await new Promise((r) => setTimeout(r, 30))
  expect(delivered).toContain('orphan')
})
