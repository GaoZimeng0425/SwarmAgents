import { describe, expect, it, vi } from 'vitest'

// Deadlock regression (acceptance core for Task 7).
//
// Real runResident + real mailbox + real messaging tools; only the pi Agent is
// mocked. Actor 'a' is kicked off with a fire-and-forget `send`; its turn calls
// the real `send_and_wait` tool to issue an rpc to peer 'b'. Because 'a''s
// resident loop holds the only turn-slot (maxConcurrent=1) while it awaits the
// reply, 'b' cannot acquire a slot to run unless 'a' yields its slot during the
// wait. WITHOUT the fix this deadlocks (times out); WITH it, 'b' runs, replies,
// and 'a' re-acquires its slot and completes.

// Records the reply 'a' receives from its send_and_wait('b'), so the test can
// observe the rpc completing end-to-end.
let resolveReply: (r: string) => void
const replyFromB = new Promise<string>((resolve) => {
  resolveReply = resolve
})

vi.mock('@earendil-works/pi-agent-core', () => {
  type Tool = { name: string; execute(id: string, params: unknown): Promise<unknown> }
  class Agent {
    state = { messages: [] as unknown[] }
    private sub: ((e: unknown) => void) | null = null
    private tools: Tool[]
    constructor(c: { initialState?: { tools?: Tool[] } }) {
      this.tools = c.initialState?.tools ?? []
    }
    subscribe(fn: (e: unknown) => void) {
      this.sub = fn
    }
    abort() {}
    async prompt(goal: string) {
      if (goal === 'kickoff') {
        // Actor 'a''s turn: issue a real rpc to 'b' via the send_and_wait tool.
        // This call only returns once 'b' has replied — proving no deadlock.
        const tool = this.tools.find((t) => t.name === 'send_and_wait')
        if (!tool) throw new Error('send_and_wait tool not resolved for actor a')
        const res = (await tool.execute('call-1', { to: 'b', payload: 'please' })) as {
          content: { type: string; text: string }[]
        }
        const reply = res.content[0]?.text ?? ''
        resolveReply(reply)
        this.sub?.({ type: 'message_update', assistantMessageEvent: { type: 'text_delta', delta: reply } })
      } else {
        // Actor 'b''s turn: reply to the rpc.
        this.sub?.({ type: 'message_update', assistantMessageEvent: { type: 'text_delta', delta: `done:${goal}` } })
      }
      this.sub?.({ type: 'agent_end' })
    }
  }
  return {
    Agent,
    shouldCompact: () => false,
    DEFAULT_COMPACTION_SETTINGS: {},
  }
})

import { createConversationStore } from '../conversation/store'
import { createSessionManager } from './manager'

const fakeProvider = { id: 'test', model: 'test', apiStyle: 'anthropic', apiKey: 'k' } as unknown as never

describe('session-manager deadlock regression', () => {
  it('maxConcurrent=1: an rpc issued from within a slot-holding turn does not deadlock', async () => {
    const store = createConversationStore(':memory:')
    const mgr = createSessionManager({
      store,
      broadcaster: { broadcast: () => {} },
      maxConcurrent: 1,
      getProvider: () => fakeProvider,
    } as never)
    const { sessionId } = mgr.createSession(fakeProvider)

    // Create both named actors up front so 'a' can address 'b' by name.
    const ensure = (mgr as unknown as { __ensureActorForTest(s: string, d: string, n: string): unknown })
      .__ensureActorForTest
    ensure(sessionId, 'default', 'a')
    ensure(sessionId, 'default', 'b')

    // Kick off 'a' with a fire-and-forget send (the top-level caller holds no
    // slot). 'a''s resident acquires the only slot, then its turn rpc's 'b'.
    await (
      mgr as unknown as {
        __sendMessageForTest(s: string, f: string | null, t: string, p: string, k: 'send' | 'rpc'): Promise<unknown>
      }
    ).__sendMessageForTest(sessionId, null, 'a', 'kickoff', 'send')

    const reply = await Promise.race([
      replyFromB,
      new Promise<string>((_, rej) => setTimeout(() => rej(new Error('DEADLOCK')), 2000)),
    ])
    expect(reply).toContain('done:please')
  })
})
