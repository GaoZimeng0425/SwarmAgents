import { describe, expect, it, vi } from 'vitest'

import { createConversationStore } from './conversation-store'
import { createSessionManager } from './session-manager'

// Stub the agent-runner so a "turn" just echoes the delivered goal as its
// summary. runResident drains the mailbox, marks each message consumed, and
// replies to rpc messages via onReply — mirroring the real resident loop.
vi.mock('./agent-runner', () => ({
  createAgentRunner: (deps: any) => ({
    run: async () => ({
      status: 'completed',
      summary: `ran:${deps.task.goal}`,
      messages: [],
      used: { tokens: 0, calls: 0, wallMs: 0, usdCents: 0 },
    }),
  }),
  buildAgentSession: () => ({}),
  runResident: async (_deps: any, mailbox: any, hooks: any, _idleMs: number) => {
    for (;;) {
      let msg
      try {
        msg = await mailbox.receive({ idleMs: 5 })
      } catch {
        return
      }
      await hooks.acquireTurnSlot()
      hooks.releaseTurnSlot()
      hooks.onConsumed(msg.id)
      if (msg.kind === 'rpc' && msg.correlationId) hooks.onReply(msg.correlationId, `ran:${msg.payload}`)
    }
  },
}))

const noopBroadcaster = { broadcast: () => {} }
const fakeProvider = { model: 'test', apiStyle: 'anthropic' } as any

function makeManager() {
  const store = createConversationStore(':memory:')
  const mgr = createSessionManager({
    store,
    broadcaster: noopBroadcaster,
    maxConcurrent: 4,
    getProvider: () => fakeProvider,
  })
  return { store, mgr }
}

describe('sendMessage', () => {
  it('rpc activates the target actor and returns its summary as reply', async () => {
    const { mgr } = makeManager()
    const { sessionId } = mgr.createSession(fakeProvider)
    const target = (mgr as any).__ensureActorForTest(sessionId, 'default', 'b')
    const res = await (mgr as any).__sendMessageForTest(sessionId, null, target.address, 'review X', 'rpc')
    expect(res.reply).toBe('ran:review X')
  })

  it('send to a non-existent address dead-letters and does not throw', async () => {
    const { store, mgr } = makeManager()
    const { sessionId } = mgr.createSession(fakeProvider)
    const res = await (mgr as any).__sendMessageForTest(sessionId, null, 'ghost-addr', 'hi', 'send')
    expect(res).toEqual({ delivered: true })
    // The message is persisted dead; no unconsumed work remains for the ghost.
    expect(store.nextUnconsumedFor('ghost-addr')).toBeUndefined()
  })

  it('resolves a target by readable name within the session', async () => {
    const { mgr } = makeManager()
    const { sessionId } = mgr.createSession(fakeProvider)
    ;(mgr as any).__ensureActorForTest(sessionId, 'default', 'reviewer')
    const res = await (mgr as any).__sendMessageForTest(sessionId, null, 'reviewer', 'check', 'rpc')
    expect(res.reply).toBe('ran:check')
  })
})
