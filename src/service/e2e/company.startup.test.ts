import { builtinAgents } from '@shared/agents/builtins'
import { describe, expect, it, vi } from 'vitest'

import { createConversationStore } from '../conversation/store'
import { createSessionManager } from '../session/manager'

// CEO stub: replies with a fixed final summary; others not exercised here.
vi.mock('../session/agent-runner', () => ({
  createAgentRunner: () => ({ run: async () => ({ status: 'completed', summary: '', messages: [], used: {} }) }),
  buildAgentSession: () => ({}),
  runResident: async (deps: any, mailbox: any, hooks: any) => {
    for (;;) {
      let msg
      try {
        msg = await mailbox.receive({ idleMs: 5 })
      } catch {
        return
      }
      await hooks.acquireTurnSlot()
      hooks.releaseTurnSlot()
      const summary = deps.agentDefinition.id === 'ceo' ? 'FINAL: shipped' : `ack:${msg.payload}`
      hooks.onConsumed(msg.id, '{"v":1,"messages":[]}')
      if (msg.kind === 'rpc' && msg.correlationId) hooks.onReply(msg.correlationId, summary)
    }
  },
}))

const fakeProvider = { model: 'test', apiStyle: 'anthropic' } as any
const roleStore = {
  get: (id: string) => builtinAgents.find((a) => a.id === id),
  list: () => builtinAgents,
}

describe('startCompany', () => {
  it('seeds the fixed roster as named actors and rpc-kicks the CEO', async () => {
    const store = createConversationStore(':memory:')
    const mgr = createSessionManager({
      store,
      broadcaster: { broadcast: () => {} },
      maxConcurrent: 4,
      getProvider: () => fakeProvider,
      agentStore: roleStore as any,
    })
    const { sessionId } = mgr.createSession(fakeProvider)

    const result = await mgr.startCompany(sessionId, 'build a thing')

    // CEO's reply is the run result.
    expect(result).toEqual({ reply: 'FINAL: shipped' })
    // All four roles were seeded as named, addressable actors.
    for (const id of ['ceo', 'pm', 'engineer', 'reviewer']) {
      expect(store.getActorByName(sessionId, id), `missing actor ${id}`).toBeTruthy()
    }
  })
})
