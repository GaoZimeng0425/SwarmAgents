// src/service/e2e/unified-runs.e2e.test.ts
//
// Phase 4a/4b end-to-end guard: a conversation turn AND an agent-authored work
// run both write their full lifecycle to run_events (the renderer's only replay
// source), so each reaches a terminal status on replay. Post-4b the work run
// leaves no Task row — it lives entirely in run_events.

import { describe, expect, it, vi } from 'vitest'

import { createConversationStore } from '../conversation/store'
import { createSessionManager } from '../session/manager'

vi.mock('../session/agent-runner', () => ({
  // Stub runner: emits task.complete so the terminal event reaches run_events
  // via makeRunEmit, then resolves completed.
  createAgentRunner: (deps: any) => ({
    run: async () => {
      deps.emit('task.complete', {
        taskId: deps.correlationId,
        result: { summary: 'done', artifacts: [] },
        ts: Date.now(),
      })
      return {
        status: 'completed',
        summary: 'done',
        messages: [],
        used: { tokens: 1, calls: 0, wallMs: 0, usdCents: 0, cacheRead: 0, cacheWrite: 0 },
      }
    },
  }),
  buildAgentSession: () => ({}),
  runResident: async () => {},
}))

const fakeProvider = { model: 'test', apiStyle: 'anthropic' } as never
const flush = (): Promise<void> => new Promise((r) => setTimeout(r, 30))

describe('unified runs', () => {
  it('a work run + conversation turn both reach a terminal event in run_events', async () => {
    const store = createConversationStore(':memory:')
    const manager = createSessionManager({
      store,
      broadcaster: { broadcast: () => {} },
      maxConcurrent: 4,
      getProvider: () => fakeProvider,
    })
    const { sessionId } = manager.createSession(fakeProvider)

    // Conversation turn (no Task row).
    manager.submitGoal(sessionId, '你好')
    await flush()

    // Agent-authored work run (creates a Task row via create_task).
    const work = await (
      manager as unknown as {
        __runWorkTaskForTest: (s: string, g: string) => Promise<{ taskId: string }>
      }
    ).__runWorkTaskForTest(sessionId, 'build it')
    await flush()

    const rows = store.getRunEvents(sessionId)
    const isTerminal = (r: { event: { kind?: string } }): boolean =>
      r.event.kind === 'task.complete' || r.event.kind === 'task.error'
    // Both runs reached a terminal event in run_events.
    expect(rows.filter((r) => r.runId === work.taskId).some(isTerminal)).toBe(true) // work
    expect(rows.filter((r) => r.runId !== work.taskId).some(isTerminal)).toBe(true) // conversation

    store.close()
  })
})
