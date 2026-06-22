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

it('re-drains a message lost to the idle/deliver race after the resident exits', async () => {
  const store = createConversationStore(':memory:')
  const mgr = createSessionManager({
    store,
    broadcaster: { broadcast: () => {} },
    maxConcurrent: 4,
    getProvider: () => fakeProvider,
  })
  const { sessionId } = mgr.createSession(fakeProvider)
  const a = (
    mgr as unknown as { __ensureActorForTest(s: string, d: string, n: string): { address: string } }
  ).__ensureActorForTest(sessionId, 'default', 'w')

  // Enqueue an unconsumed DB row WITHOUT going through sendMessage's deliver —
  // this simulates a message that landed in the DB but missed live delivery
  // (the idle-timeout window where runResident has exited but the handle still
  // existed). The post-completion re-drain must pick it up.
  store.enqueueMessage({
    id: 'lost',
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

  // Drive a normal send: spawns the resident, which drains 'live', then idles
  // out and returns. The .finally re-drain then finds the unconsumed 'lost' row
  // and re-spawns to deliver it.
  await (
    mgr as unknown as {
      __sendMessageForTest(s: string, f: string | null, t: string, p: string, k: 'send' | 'rpc'): Promise<unknown>
    }
  ).__sendMessageForTest(sessionId, null, a.address, 'live', 'send')

  // Wait for the resident loop to idle out, exit, and the post-exit re-drain
  // to pick up the lost row and consume it.
  await vi.waitFor(
    () => {
      expect(store.allUnconsumedFor(a.address)).toHaveLength(0)
    },
    { timeout: 1000, interval: 10 }
  )
  expect(delivered).toContain('lost')
})
