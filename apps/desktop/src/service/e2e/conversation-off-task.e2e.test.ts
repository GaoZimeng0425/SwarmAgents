// src/service/e2e/conversation-off-task.e2e.test.ts
//
// Phase 3a end-to-end guard: a trivial conversation message creates NO Task and
// runs single-shot (no verify loop); its events land on the session-conversation
// stream. Real work is agent-authored via create_task (driven here through the
// __runWorkTaskForTest seam), which DOES create a work Task that runs the verify
// loop. The verify-loop logic itself is unit-tested elsewhere; here it is simulated.

import { describe, expect, it, vi } from 'vitest'

import { createConversationStore } from '../conversation/store'
import { createSessionManager } from '../session/manager'

const seen = vi.hoisted(() => [] as Array<{ max: number }>)

vi.mock('../session/agent-runner', () => ({
  createAgentRunner: (deps: any) => ({
    run: async () => {
      seen.push({ max: deps.maxVerifyRounds ?? 0 })
      // A conversation turn (single-shot) streams an assistant reply.
      if ((deps.maxVerifyRounds ?? 0) === 0) {
        deps.emit('task.progress', {
          event: { kind: 'llm.message', role: 'assistant', content: 'hi there', ts: Date.now() },
        })
      }
      return {
        status: 'completed',
        summary: 'ok',
        messages: [],
        used: { tokens: 10, calls: 1, wallMs: 5, usdCents: 1, cacheRead: 0, cacheWrite: 0 },
      }
    },
  }),
  buildAgentSession: () => ({}),
  runResident: async () => {},
}))

const fakeProvider = { model: 'test', apiStyle: 'anthropic' } as never
const flush = (): Promise<void> => new Promise((r) => setTimeout(r, 30))

describe('conversation off task', () => {
  it('a trivial message creates no Task and runs single-shot; create_task makes a work Task', async () => {
    seen.length = 0
    const store = createConversationStore(':memory:')
    const manager = createSessionManager({
      store,
      broadcaster: { broadcast: () => {} },
      maxConcurrent: 4,
      getProvider: () => fakeProvider,
    })
    const { sessionId } = manager.createSession(fakeProvider)

    const { taskId: turnId } = manager.submitGoal(sessionId, '你好')
    await flush()

    // No Task row for a conversation turn.
    expect(store.getSessionTasks(sessionId)).toHaveLength(0)
    // The conversation stream carries the user + assistant messages, no verification.
    const conv = store.getConversationEvents(sessionId)
    expect(conv.some((r) => (r.event as { role?: string }).role === 'user')).toBe(true)
    expect(conv.some((r) => (r.event as { role?: string }).role === 'assistant')).toBe(true)
    expect(conv.some((r) => (r.event as { kind?: string }).kind === 'verification')).toBe(false)
    // The conversation turn ran single-shot (the cutover's key invariant).
    expect(seen.some((s) => s.max === 0)).toBe(true)
    // The returned id is the conversation turnId, not a Task id.
    expect(turnId).toMatch(/^[0-9A-Z]{26}$/)

    // Agent-authored work via create_task DOES make a Task and runs the verify loop.
    const work = await (
      manager as unknown as {
        __runWorkTaskForTest: (s: string, g: string) => Promise<{ taskId: string }>
      }
    ).__runWorkTaskForTest(sessionId, 'build it')
    expect(store.getSessionTasks(sessionId).find((t) => t.id === work.taskId)).toBeDefined()
    expect(seen.some((s) => s.max > 0)).toBe(true)

    store.close()
  })
})
