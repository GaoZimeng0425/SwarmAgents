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
  createAgentRunner: () => ({
    run: async () => ({ status: 'completed', summary: 'done', messages: [], used: {} }),
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
    const task = store.getSessionTasks(sessionId).find((t) => t.id === work.taskId)

    expect(task).toBeDefined()
    // Post-3b: the typed Task no longer carries verifications/acceptanceCriteria
    // fields (Task 5 dropped them from the schema). Regression guard: if either
    // field were re-added without re-wiring persistence, this would silently
    // flip to a non-undefined value.
    expect((task as { verifications?: unknown } | undefined)?.verifications ?? []).toHaveLength(0)
    expect((task as { acceptanceCriteria?: unknown } | undefined)?.acceptanceCriteria ?? []).toHaveLength(0)
    // Single-shot: the work task reached a terminal status with no verify loop.
    expect(['completed', 'failed']).toContain(task?.status)

    store.close()
  })
})
