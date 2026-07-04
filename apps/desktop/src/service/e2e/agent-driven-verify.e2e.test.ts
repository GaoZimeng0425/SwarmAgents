// src/service/e2e/agent-driven-verify.e2e.test.ts
//
// Phase 3b focused regression: a single agent-authored work task runs
// single-shot, and the resulting Task carries no verification audit and no
// acceptance-criteria contract. The DB columns `verifications`/
// `acceptance_criteria` are KEPT (rollback safety) but stay at their default
// '[]'; the typed Task no longer surfaces them.
//
// Companion to multi-level-verify.e2e.test.ts (which exercises the
// delegation tree). This file isolates the simplest path: one work task,
// no spawns, no CEOs — just the post-3b Task shape.

import { describe, expect, it, vi } from 'vitest'

import { createConversationStore } from '../conversation/store'
import { createSessionManager } from '../session/manager'

vi.mock('../session/agent-runner', () => ({
  createAgentRunner: (deps: any) => ({
    run: async () => {
      // Post-4b the runner's translator emits task.complete (→ run_events);
      // the mock stands in for the translator.
      deps.emit('task.complete', {
        taskId: deps.correlationId,
        result: { summary: 'done', artifacts: [] },
        ts: Date.now(),
      })
      return { status: 'completed', summary: 'done', messages: [], used: {} }
    },
  }),
  buildAgentSession: () => ({}),
  runResident: async () => {},
}))

const fakeProvider = { model: 'test', apiStyle: 'anthropic' } as never

describe('agent-driven verify — single-shot work task', () => {
  it('a work task runs single-shot with no verify rounds and no criteria contract', async () => {
    const store = createConversationStore(':memory:')
    const manager = createSessionManager({
      store,
      broadcaster: { broadcast: () => {} },
      maxConcurrent: 4,
      getProvider: () => fakeProvider,
    })
    const { sessionId } = manager.createSession(fakeProvider)

    const work = await (
      manager as unknown as {
        __runWorkTaskForTest: (s: string, g: string) => Promise<{ taskId: string; result: unknown }>
      }
    ).__runWorkTaskForTest(sessionId, 'build it')

    // Post-4b: no Task row for a work run — assert against the run stream.
    const events = store.getRunEvents(sessionId).filter((r) => r.runId === work.taskId)
    const isTerminal = (r: { event: { kind?: string } }): boolean =>
      r.event.kind === 'task.complete' || r.event.kind === 'task.error'
    expect(events.some(isTerminal)).toBe(true)
    expect(store.getSessionTasks(sessionId)).toHaveLength(0)

    store.close()
  })
})
