import { describe, expect, it, vi } from 'vitest'

import { encodeActorState } from './actor-state'

const initialMessagesSeen: any[][] = []
vi.mock('./agent-runner', () => ({
  createAgentRunner: (d: any) => ({ run: async () => ({ status: 'completed', summary: '', messages: [], used: {} }) }),
  buildAgentSession: () => ({}),
  runResident: async (deps: any, mailbox: any, hooks: any, _idleMs: number) => {
    initialMessagesSeen.push(deps.initialMessages)
    for (;;) {
      let msg
      try {
        msg = await mailbox.receive({ idleMs: 5 })
      } catch {
        return
      }
      await hooks.acquireTurnSlot()
      hooks.releaseTurnSlot()
      // Persist a non-empty conversation so the NEXT activation replays it.
      const state = encodeActorState([
        { role: 'user', content: msg.payload },
        { role: 'assistant', content: 'ok' },
      ] as any)
      hooks.onConsumed(msg.id, state)
      if (msg.kind === 'rpc' && msg.correlationId) hooks.onReply(msg.correlationId, 'r')
    }
  },
}))

import { createConversationStore } from './conversation-store'
import { createSessionManager } from './session-manager'

const fakeProvider = { model: 'test', apiStyle: 'anthropic' } as any

describe('cross-dormancy state replay', () => {
  it('replays persisted actor state on re-activation (memory survives dormancy)', async () => {
    initialMessagesSeen.length = 0
    const store = createConversationStore(':memory:')
    const mgr = createSessionManager({
      store,
      broadcaster: { broadcast: () => {} },
      maxConcurrent: 4,
      getProvider: () => fakeProvider,
    })
    const { sessionId } = mgr.createSession(fakeProvider)
    ;(mgr as any).__ensureActorForTest(sessionId, 'default', 'researcher-1')

    // First activation: actor.state null -> initialMessages []
    await (mgr as any).__sendMessageForTest(sessionId, null, 'researcher-1', 'remember blue', 'send')
    await new Promise((r) => setTimeout(r, 50)) // drain + persist + idle out

    // Second activation: re-spawn -> initialMessages replayed from actor.state
    await (mgr as any).__sendMessageForTest(sessionId, null, 'researcher-1', 'what colour?', 'send')
    await new Promise((r) => setTimeout(r, 50))

    expect(initialMessagesSeen.length).toBeGreaterThanOrEqual(2)
    expect(initialMessagesSeen[0]).toEqual([]) // first activation: fresh
    expect(initialMessagesSeen[1].length).toBeGreaterThan(0) // second: replayed
  })
})
