import { describe, expect, it, vi } from 'vitest'

import { createConversationStore } from './conversation-store'
import { createSessionManager } from './session-manager'

// Runner stub: a "review" goal replies "LGTM"; everyone else echoes. The
// resident loop drains the mailbox, marks consumed, and replies to rpc.
vi.mock('./agent-runner', () => ({
  createAgentRunner: (deps: any) => ({
    run: async () => ({
      status: 'completed',
      summary: deps.task.goal.includes('review') ? 'LGTM' : `echo:${deps.task.goal}`,
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
      const summary = msg.payload.includes('review') ? 'LGTM' : `echo:${msg.payload}`
      if (msg.kind === 'rpc' && msg.correlationId) hooks.onReply(msg.correlationId, summary)
    }
  },
}))

const noopBroadcaster = { broadcast: () => {} }
const fakeProvider = { model: 'test', apiStyle: 'anthropic' } as any

describe('agent cluster — sibling RPC', () => {
  it('an actor can rpc a named peer and get its reply, persisted as consumed', async () => {
    const store = createConversationStore(':memory:')
    const mgr = createSessionManager({
      store,
      broadcaster: noopBroadcaster,
      maxConcurrent: 4,
      getProvider: () => fakeProvider,
    })
    const { sessionId } = mgr.createSession(fakeProvider)
    ;(mgr as any).__ensureActorForTest(sessionId, 'default', 'reviewer')

    const { reply } = await (mgr as any).__sendMessageForTest(
      sessionId,
      'author',
      'reviewer',
      'please review the draft',
      'rpc'
    )
    expect(reply).toBe('LGTM')
    // The reviewer actor recorded a lastTaskId activation — activation persisted.
    expect(store.getActorByName(sessionId, 'reviewer')?.lastTaskId).toBeTruthy()
  })
})
