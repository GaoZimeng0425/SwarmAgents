import { defaultAgents } from '@shared/constants/agents'
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
  get: (id: string) => defaultAgents.find((a) => a.id === id),
  list: () => defaultAgents,
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

  it('re-seeds a deleted company-critical role before kicking off the CEO', async () => {
    const present = new Map(defaultAgents.map((a) => [a.id, a]))
    present.delete('ceo') // simulate the user having deleted the CEO
    const saved: string[] = []
    const healingStore = {
      get: (id: string) => present.get(id),
      list: () => [...present.values()],
      save: (def: any) => {
        present.set(def.id, def)
        saved.push(def.id)
        return { ok: true, agents: [...present.values()] }
      },
    }
    const store = createConversationStore(':memory:')
    const mgr = createSessionManager({
      store,
      broadcaster: { broadcast: () => {} },
      maxConcurrent: 4,
      getProvider: () => fakeProvider,
      agentStore: healingStore as any,
    })
    const { sessionId } = mgr.createSession(fakeProvider)

    const result = await mgr.startCompany(sessionId, 'build a thing')

    expect(saved).toContain('ceo')        // the deleted role was re-seeded
    expect(result).toEqual({ reply: 'FINAL: shipped' }) // CEO ran as the real CEO
  })
})
