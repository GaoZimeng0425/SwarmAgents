import { beforeEach, describe, expect, it, vi } from 'vitest'

// Programmable pi Agent mock: fail the first `failTimes` prompts (pi's
// stopReason 'error' event sequence — prompt() still resolves void), then
// succeed. Tracks prompt() call count and mirrors pi by pushing the user +
// assistant messages onto state.messages, so the retry loop's transcript
// restore is observable.
let failTimes = 0
let promptCalls = 0

vi.mock('@earendil-works/pi-agent-core', () => {
  class Agent {
    state = { messages: [] as Array<Record<string, unknown>> }
    private sub: ((e: unknown) => void) | null = null
    constructor(_c: unknown) {}
    subscribe(fn: (e: unknown) => void) {
      this.sub = fn
    }
    abort() {}
    async prompt(goal: string) {
      promptCalls++
      this.state.messages.push({ role: 'user', content: goal })
      if (promptCalls <= failTimes) {
        const failure = {
          role: 'assistant',
          content: [{ type: 'text', text: '' }],
          stopReason: 'error',
          errorMessage: 'transient 503',
        }
        this.state.messages.push(failure)
        this.sub?.({ type: 'message_end', message: failure })
        this.sub?.({ type: 'turn_end', message: failure, toolResults: [] })
        this.sub?.({ type: 'agent_end', messages: [failure] })
        return
      }
      const ok = { role: 'assistant', content: [{ type: 'text', text: 'done' }], stopReason: 'end_turn' }
      this.state.messages.push(ok)
      this.sub?.({ type: 'message_update', assistantMessageEvent: { type: 'text_delta', delta: 'done' } })
      this.sub?.({ type: 'turn_end', message: ok, toolResults: [] })
      this.sub?.({ type: 'agent_end', messages: [ok] })
    }
  }
  return { Agent }
})

import type { AgentRunnerDeps } from './agent-runner'
import { buildAgentSession } from './agent-runner'

const deps = (
  emit: (event: string, data: unknown) => void,
  overrides: Partial<AgentRunnerDeps> = {}
): AgentRunnerDeps =>
  ({
    correlationId: 't1',
    cwd: undefined,
    attachments: [],
    budget: { calls: 100, wallMs: 60000, usdCents: 1000, tokens: 1e9 },
    permissionMode: 'full',
    provider: { model: 'test', apiStyle: 'anthropic', apiKey: 'k' } as any,
    agentDefinition: { id: 'default', systemPrompt: 'sys', toolScope: 'all', maxIterations: 25 } as any,
    sessionId: 's1',
    emit,
    permissionRegistry: { request: async () => 'grant', resolve: () => {} } as any,
    toolRegistry: { resolve: () => ({ tools: [], riskOf: () => 'low' }) } as any,
    initialMessages: [],
    spawnChild: async () => ({ childTaskId: 'c', result: { summary: '', artifacts: [] } }),
    retry: { maxRetries: 10, delayMs: 0 },
    ...overrides,
  }) as any

beforeEach(() => {
  failTimes = 0
  promptCalls = 0
})

describe('promptOnce — transient-failure retry', () => {
  it('retries a failing request and completes once it succeeds', async () => {
    failTimes = 3 // fail 3 times, succeed on the 4th attempt
    const emit = vi.fn()
    const session = buildAgentSession(deps(emit))

    const r = await session.promptOnce('hi')

    expect(r.status).toBe('completed')
    expect(promptCalls).toBe(4) // 1 initial + 3 retries
  })

  it('surfaces each retried failure to the UI without ending the task', async () => {
    failTimes = 2
    const emit = vi.fn()
    const session = buildAgentSession(deps(emit))

    await session.promptOnce('hi')

    // A retried failure must NOT flip the task to failed (no terminal task.error)...
    expect(emit).not.toHaveBeenCalledWith('task.error', expect.anything())
    // ...but each failure IS visible in the transcript as a transient error notice.
    const notices = emit.mock.calls.filter(
      ([event, data]) =>
        event === 'task.progress' &&
        (data as { event?: { kind?: string; error?: { tier?: string } } }).event?.kind === 'error' &&
        (data as { event?: { error?: { tier?: string } } }).event?.error?.tier === 'transient'
    )
    expect(notices).toHaveLength(2) // one per failed-then-retried attempt
    expect((notices[0][1] as { event: { error: { message: string } } }).event.error.message).toContain('transient 503')
    // The eventual success is still reported.
    expect(emit).toHaveBeenCalledWith('task.complete', expect.anything())
  })

  it('restores the transcript before each retry so user/error messages are not duplicated', async () => {
    failTimes = 3
    const emit = vi.fn()
    const session = buildAgentSession(deps(emit))

    await session.promptOnce('hi')

    // Failed turns are discarded: only the final user goal + success reply remain.
    const messages = session.agent.state.messages
    expect(messages).toHaveLength(2)
    expect(messages.some((m) => (m as { stopReason?: string }).stopReason === 'error')).toBe(false)
  })

  it('gives up after the retries are exhausted and emits task.error once', async () => {
    failTimes = 999 // never succeeds
    const emit = vi.fn()
    const session = buildAgentSession(deps(emit, { retry: { maxRetries: 4, delayMs: 0 } }))

    const r = await session.promptOnce('hi')

    expect(r.status).toBe('failed')
    expect(promptCalls).toBe(5) // 1 initial + 4 retries
    const errorCalls = emit.mock.calls.filter(([event]) => event === 'task.error')
    expect(errorCalls).toHaveLength(1)
    expect(errorCalls[0][1]).toMatchObject({
      error: { code: 'agent_request_failed', message: 'transient 503' },
    })
  })

  it('aborts a pending retry when the run is cancelled during the wait', async () => {
    failTimes = 999
    const controller = new AbortController()
    controller.abort() // already cancelled when the wait is reached
    const emit = vi.fn()
    const session = buildAgentSession(deps(emit, { signal: controller.signal }))

    const r = await session.promptOnce('hi')

    expect(r.status).toBe('cancelled')
    expect(promptCalls).toBe(1) // no further attempts after cancellation
    expect(emit).toHaveBeenCalledWith(
      'task.error',
      expect.objectContaining({ error: expect.objectContaining({ code: 'cancelled' }) })
    )
  })
})
