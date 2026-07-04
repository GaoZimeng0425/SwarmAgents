// src/service/e2e/conversation-off-task.e2e.test.ts
//
// Phase 3a/3b/4b end-to-end guard: a trivial conversation message creates NO
// Task and runs single-shot; its events land on the session run-event stream.
// Real work is agent-authored via create_task (driven here through the
// __runWorkTaskForTest seam), which post-4b is also Task-less — just a run on
// the run-event stream. After 3b every run is single-shot — there is no verify
// loop distinction anymore.

import { describe, expect, it, vi } from 'vitest'

import { createConversationStore } from '../conversation/store'
import { createSessionManager } from '../session/manager'

const seen = vi.hoisted(() => [] as Array<{ max: number }>)

vi.mock('../session/agent-runner', () => ({
  createAgentRunner: (deps: any) => ({
    run: async () => {
      // After 3b the runner no longer accepts maxVerifyRounds; this stays at
      // 0 by definition. Kept as a structural record so the test still asserts
      // the runner was invoked.
      seen.push({ max: deps.maxVerifyRounds ?? 0 })
      deps.emit('task.progress', {
        event: { kind: 'llm.message', role: 'assistant', content: 'hi there', ts: Date.now() },
      })
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
  it('a trivial message creates no Task; create_task makes a work Task — both run single-shot', async () => {
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

    // The run stream carries the user + assistant messages, no verification.
    const rows = store.getRunEvents(sessionId)
    expect(
      rows.some(
        (r) =>
          (r.event as { kind?: string }).kind === 'task.progress' &&
          (r.event as { event?: { role?: string } }).event?.role === 'user'
      )
    ).toBe(true)
    expect(
      rows.some(
        (r) =>
          (r.event as { kind?: string }).kind === 'task.progress' &&
          (r.event as { event?: { role?: string } }).event?.role === 'assistant'
      )
    ).toBe(true)
    expect(rows.some((r) => (r.event as { event?: { kind?: string } }).event?.kind === 'verification')).toBe(false)
    // The conversation turn ran (3b: every run is single-shot).
    expect(seen.length).toBeGreaterThanOrEqual(1)
    // The returned id is the conversation turnId, not a Task id.
    expect(turnId).toMatch(/^[0-9A-Z]{26}$/)

    // Agent-authored work via create_task also creates no Task row post-4b —
    // it is a top-level run on the run-event stream.
    const work = await (
      manager as unknown as {
        __runWorkTaskForTest: (s: string, g: string) => Promise<{ taskId: string }>
      }
    ).__runWorkTaskForTest(sessionId, 'build it')
    expect(store.getRunEvents(sessionId).some((r) => r.runId === work.taskId)).toBe(true)

    store.close()
  })
})
