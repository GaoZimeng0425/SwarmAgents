import { describe, expect, it, vi } from 'vitest'

// pi Agent mock: echoes a per-actor message count so we can prove the SAME
// resident agent handled multiple messages (context accumulation within a residency).
vi.mock('@earendil-works/pi-agent-core', () => {
  class Agent {
    state = { messages: [] as any[] }
    private sub: ((e: unknown) => void) | null = null
    private n = 0
    constructor(_c: unknown) {}
    subscribe(fn: (e: unknown) => void) {
      this.sub = fn
    }
    abort() {}
    async prompt(goal: string) {
      this.n += 1
      this.sub?.({
        type: 'message_update',
        assistantMessageEvent: { type: 'text_delta', delta: `turn${this.n}:${goal}` },
      })
      this.sub?.({ type: 'agent_end' })
    }
  }
  return { Agent }
})

import { createConversationStore } from './conversation-store'
import { createSessionManager } from './session-manager'

const fakeProvider = { model: 'test', apiStyle: 'anthropic', apiKey: 'k' } as any

describe('run-loop e2e', () => {
  it('two messages to the same resident actor are handled by one agent (turn count grows)', async () => {
    const store = createConversationStore(':memory:')
    const mgr = createSessionManager({
      store,
      broadcaster: { broadcast: () => {} },
      maxConcurrent: 4,
      getProvider: () => fakeProvider,
    })
    const { sessionId } = mgr.createSession(fakeProvider)
    ;(mgr as any).__ensureActorForTest(sessionId, 'default', 'w')
    const r1 = await (mgr as any).__sendMessageForTest(sessionId, 'x', 'w', 'one', 'rpc')
    const r2 = await (mgr as any).__sendMessageForTest(sessionId, 'x', 'w', 'two', 'rpc')
    expect(r1.reply).toContain('turn1:one')
    expect(r2.reply).toContain('turn2:two') // same agent instance → turn count advanced
  })

  it('maxConcurrent=1 mutual-ish rpc completes (no deadlock)', async () => {
    const store = createConversationStore(':memory:')
    const mgr = createSessionManager({
      store,
      broadcaster: { broadcast: () => {} },
      maxConcurrent: 1,
      getProvider: () => fakeProvider,
    })
    const { sessionId } = mgr.createSession(fakeProvider)
    ;(mgr as any).__ensureActorForTest(sessionId, 'default', 'b')
    const res = await Promise.race([
      (mgr as any).__sendMessageForTest(sessionId, 'a', 'b', 'go', 'rpc'),
      new Promise((_, rej) => setTimeout(() => rej(new Error('DEADLOCK')), 2000)),
    ])
    expect((res as any).reply).toContain('turn1:go')
  })
})
