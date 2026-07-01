import type { ActorMessage } from '@swarm/protocol'
import { describe, expect, it, vi } from 'vitest'

// Stub runResident to simulate a resident actor: drain whatever is delivered,
// call onConsumed + onReply, and resolve when told to idle.
const delivered: any[] = []
vi.mock('./agent-runner', () => ({
  createAgentRunner: (d: any) => ({
    run: async () => ({ status: 'completed', summary: `ran:${d.task.goal}`, messages: [], used: {} }),
  }),
  buildAgentSession: () => ({}),
  runResident: async (_deps: any, mailbox: any, hooks: any, _idleMs: number) => {
    // process exactly the messages already queued, then idle out
    for (;;) {
      let msg: ActorMessage
      try {
        msg = await mailbox.receive({ idleMs: 5 })
      } catch {
        return
      }
      delivered.push(msg.id)
      await hooks.acquireTurnSlot()
      hooks.releaseTurnSlot()
      hooks.onConsumed(msg.id)
      if (msg.kind === 'rpc' && msg.correlationId) hooks.onReply(msg.correlationId, `reply:${msg.id}`)
    }
  },
}))

import { createConversationStore } from '../conversation/store'
import { createSessionManager } from './manager'

const fakeProvider = { model: 'test', apiStyle: 'anthropic' } as any
const mk = () => {
  const store = createConversationStore(':memory:')
  const mgr = createSessionManager({
    store,
    broadcaster: { broadcast: () => {} },
    maxConcurrent: 4,
    getProvider: () => fakeProvider,
  })
  return { store, mgr }
}

describe('resident send wiring', () => {
  it('fire-and-forget send spawns a resident loop that consumes the message', async () => {
    delivered.length = 0
    const { store, mgr } = mk()
    const { sessionId } = mgr.createSession(fakeProvider)
    const a = (mgr as any).__ensureActorForTest(sessionId, 'default', 'worker')
    await (mgr as any).__sendMessageForTest(sessionId, null, 'worker', 'do-it', 'send')
    await new Promise((r) => setTimeout(r, 30))
    expect(delivered.length).toBeGreaterThanOrEqual(1)
    expect(store.nextUnconsumedFor(a.address)).toBeUndefined() // marked consumed
  })

  it('rpc send awaits and returns the resident reply', async () => {
    delivered.length = 0
    const { mgr } = mk()
    const { sessionId } = mgr.createSession(fakeProvider)
    ;(mgr as any).__ensureActorForTest(sessionId, 'default', 'reviewer')
    const res = await (mgr as any).__sendMessageForTest(sessionId, null, 'reviewer', 'check', 'rpc')
    expect(res.reply).toMatch(/^reply:/)
  })
})
