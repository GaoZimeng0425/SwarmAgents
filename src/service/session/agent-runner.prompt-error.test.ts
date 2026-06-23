import { describe, expect, it, vi } from 'vitest'

// Mock the pi Agent matching its REAL contract: prompt() resolves with `void`.
// A failed model/transport request is NOT thrown out of prompt() — pi's
// handleRunFailure routes a final assistant message (stopReason 'error' +
// errorMessage, empty text) through the EVENT STREAM (message_end / turn_end /
// agent_end), then prompt() resolves normally. The error lives only in events.
vi.mock('@earendil-works/pi-agent-core', () => {
  class Agent {
    state = { messages: [] as Array<{ role: string; content: string }> }
    private sub: ((e: unknown) => void) | null = null
    constructor(_c: unknown) {}
    subscribe(fn: (e: unknown) => void) {
      this.sub = fn
    }
    abort() {}
    async prompt(_goal: string) {
      const failure = {
        role: 'assistant',
        content: [{ type: 'text', text: '' }],
        stopReason: 'error',
        errorMessage: 'boom: upstream 500',
      }
      // Mirror pi's failure event sequence; no text deltas.
      this.sub?.({ type: 'message_end', message: failure })
      this.sub?.({ type: 'turn_end', message: failure, toolResults: [] })
      this.sub?.({ type: 'agent_end', messages: [failure] })
      // prompt() returns void — the error is only observable via the events above.
    }
  }
  return { Agent }
})

import type { AgentRunnerDeps } from './agent-runner'
import { buildAgentSession } from './agent-runner'

const deps = (emit: (event: string, data: unknown) => void): AgentRunnerDeps =>
  ({
    task: {
      id: 't1',
      goal: 'hello',
      cwd: undefined,
      attachments: [],
      budget: { calls: 100, wallMs: 60000, usdCents: 1000, tokens: 1e9 },
      permissionMode: 'full',
    } as any,
    provider: { model: 'test', apiStyle: 'anthropic', apiKey: 'k' } as any,
    agentDefinition: { id: 'default', systemPrompt: 'sys', toolScope: 'all', maxIterations: 25 } as any,
    sessionId: 's1',
    emit,
    permissionRegistry: { request: async () => 'grant', resolve: () => {} } as any,
    toolRegistry: { resolve: () => ({ tools: [], riskOf: () => 'low' }) } as any,
    initialMessages: [],
    spawnChild: async () => ({ childTaskId: 'c', result: { summary: '', artifacts: [] } }),
  }) as any

describe('promptOnce — model request failure (stopReason: error)', () => {
  it('returns failed and emits task.error with the provider errorMessage', async () => {
    const emit = vi.fn()
    const session = buildAgentSession(deps(emit))

    const r = await session.promptOnce('hi')

    expect(r.status).toBe('failed')
    expect(emit).toHaveBeenCalledWith(
      'task.error',
      expect.objectContaining({
        taskId: 't1',
        error: expect.objectContaining({ code: 'agent_request_failed', message: 'boom: upstream 500' }),
      })
    )
    // A failed run must NOT masquerade as a completed one.
    expect(emit).not.toHaveBeenCalledWith('task.complete', expect.anything())
  })
})
