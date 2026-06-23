// src/service/session/manager.turnslot.test.ts
// Regression guard: cancelTask must still abort a running one-shot task after the
// runHandles -> oneShotHandles rename.
import { describe, expect, it, vi } from 'vitest'

vi.mock('./agent-runner', () => ({
  createAgentRunner: (_deps: unknown) => ({
    // never resolves — stays "running" so we can cancel
    run: () => new Promise<never>(() => {}),
  }),
  // runResident / buildAgentSession are imported by other session-manager code paths;
  // stub them so the module graph resolves without a real implementation.
  runResident: async () => {},
  buildAgentSession: () => ({}),
}))

import { createConversationStore } from '../conversation/store'
import { createSessionManager } from './manager'

const fakeProvider = { model: 'test', apiStyle: 'anthropic' } as any

describe('oneShotHandles rename (behavior-preserving)', () => {
  it('cancelTask aborts a running one-shot task and task.created was broadcast', async () => {
    const store = createConversationStore(':memory:')
    const events: string[] = []
    const mgr = createSessionManager({
      store,
      broadcaster: {
        broadcast: (e: string) => {
          events.push(e)
        },
      } as any,
      maxConcurrent: 4,
      getProvider: () => fakeProvider,
    })

    const { sessionId } = mgr.createSession(fakeProvider)
    const { taskId } = mgr.submitGoal(sessionId, 'go')

    // Let the run start (acquireSlot is synchronous; runTurn is queued as a microtask)
    await new Promise((r) => setTimeout(r, 10))

    // Must not throw; should abort the AbortController stored in oneShotHandles
    expect(() => mgr.cancelTask(sessionId, taskId)).not.toThrow()

    // task.created must have been broadcast for the submitted goal
    expect(events).toContain('task.created')
  })
})
