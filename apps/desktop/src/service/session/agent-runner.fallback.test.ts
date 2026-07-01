import { beforeEach, describe, expect, it, vi } from 'vitest'

// Model-aware pi Agent mock. Unlike the retry-test mock, this one reads the
// current model id from `state.model.id` so the fallback loop's model swap is
// observable: a prompt fails iff the active model is in `failingModels`. The
// resolved model's `id` equals the provider's `model` string (resolveModel
// clones the template with `id: p.model`), so tests address models by that name.
let failingModels = new Map<string, string>() // modelId -> error message
let promptModels: string[] = [] // model id used on each prompt() call

vi.mock('@earendil-works/pi-agent-core', () => {
  class Agent {
    state = { messages: [] as Array<Record<string, unknown>>, model: { id: 'unset' } as { id: string } }
    private sub: ((e: unknown) => void) | null = null
    constructor(c: { initialState: { model: { id: string } } }) {
      this.state.model = c.initialState.model
    }
    subscribe(fn: (e: unknown) => void) {
      this.sub = fn
    }
    abort() {}
    async prompt(goal: string) {
      const modelId = this.state.model.id
      promptModels.push(modelId)
      this.state.messages.push({ role: 'user', content: goal })
      const failMsg = failingModels.get(modelId)
      if (failMsg) {
        const failure = {
          role: 'assistant',
          content: [{ type: 'text', text: '' }],
          stopReason: 'error',
          errorMessage: failMsg,
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
  return { Agent, DEFAULT_COMPACTION_SETTINGS: {}, shouldCompact: () => false }
})

import type { AgentRunnerDeps } from './agent-runner'
import { buildAgentSession, isPermanentModelFailure } from './agent-runner'

const injection = (model: string) => ({ id: model, model, apiStyle: 'anthropic', apiKey: 'k' }) as never

const deps = (
  emit: (event: string, data: unknown) => void,
  overrides: Partial<AgentRunnerDeps> = {}
): AgentRunnerDeps =>
  ({
    task: {
      id: 't1',
      goal: 'hello',
      cwd: undefined,
      attachments: [],
      budget: { calls: 100, wallMs: 60000, usdCents: 1000, tokens: 1e9 },
      permissionMode: 'full',
    } as never,
    provider: injection('primary'),
    agentDefinition: { id: 'default', systemPrompt: 'sys', toolScope: 'all', maxIterations: 25 } as never,
    sessionId: 's1',
    emit,
    permissionRegistry: { request: async () => 'grant', resolve: () => {} } as never,
    toolRegistry: { resolve: () => ({ tools: [], riskOf: () => 'low' }) } as never,
    initialMessages: [],
    spawnChild: async () => ({ childTaskId: 'c', result: { summary: '', artifacts: [] } }),
    retry: { maxRetries: 2, delayMs: 0 },
    ...overrides,
  }) as never

beforeEach(() => {
  failingModels = new Map()
  promptModels = []
})

describe('isPermanentModelFailure', () => {
  it('flags auth / not-found / quota errors as permanent', () => {
    for (const m of ['401 Unauthorized', 'invalid api key', 'model not found', 'insufficient_quota']) {
      expect(isPermanentModelFailure(m)).toBe(true)
    }
  })
  it('treats transient transport errors as retryable (not permanent)', () => {
    for (const m of ['transient 503', 'rate limit exceeded', 'connection reset', 'timeout']) {
      expect(isPermanentModelFailure(m)).toBe(false)
    }
  })
})

describe('promptOnce — model fallback chain', () => {
  it('falls back to the next model after the primary exhausts its retries', async () => {
    failingModels.set('primary', 'transient 503')
    const emit = vi.fn()
    const session = buildAgentSession(deps(emit, { fallbackProviders: [injection('backup')] }))

    const r = await session.promptOnce('hi')

    expect(r.status).toBe('completed')
    // primary tried 1 + 2 retries = 3 times, then backup succeeds on the 1st try.
    expect(promptModels).toEqual(['primary', 'primary', 'primary', 'backup'])
    // No terminal failure was emitted — the chain recovered.
    expect(emit).not.toHaveBeenCalledWith('task.error', expect.anything())
    expect(emit).toHaveBeenCalledWith('task.complete', expect.anything())
  })

  it('switches immediately on a permanent failure without burning retries', async () => {
    failingModels.set('primary', '401 unauthorized — invalid api key')
    const emit = vi.fn()
    const session = buildAgentSession(deps(emit, { fallbackProviders: [injection('backup')] }))

    const r = await session.promptOnce('hi')

    expect(r.status).toBe('completed')
    expect(promptModels).toEqual(['primary', 'backup']) // no retries on the dead key
  })

  it('emits a transient model-switch notice naming the fallback model', async () => {
    failingModels.set('primary', 'transient 503')
    const emit = vi.fn()
    const session = buildAgentSession(deps(emit, { fallbackProviders: [injection('backup')] }))

    await session.promptOnce('hi')

    const switches = emit.mock.calls.filter(
      ([event, data]) =>
        event === 'task.progress' &&
        (data as { event?: { error?: { code?: string } } }).event?.error?.code === 'agent_model_fallback'
    )
    expect(switches).toHaveLength(1)
    expect((switches[0][1] as { event: { error: { message: string } } }).event.error.message).toContain('backup')
  })

  it('uses the chain carried on provider.fallbackProviders when deps.fallbackProviders is unset', async () => {
    failingModels.set('primary', 'transient 503')
    const emit = vi.fn()
    // No deps.fallbackProviders — the chain rides on the injection (as Main resolves it).
    const session = buildAgentSession(
      deps(emit, { provider: { ...injection('primary'), fallbackProviders: [injection('backup')] } as never })
    )

    const r = await session.promptOnce('hi')

    expect(r.status).toBe('completed')
    expect(promptModels).toEqual(['primary', 'primary', 'primary', 'backup'])
  })

  it('gives up with a single terminal task.error once every model in the chain fails', async () => {
    failingModels.set('primary', 'transient 503')
    failingModels.set('backup', 'transient 503')
    const emit = vi.fn()
    const session = buildAgentSession(deps(emit, { fallbackProviders: [injection('backup')] }))

    const r = await session.promptOnce('hi')

    expect(r.status).toBe('failed')
    // primary: 3 attempts, backup: 3 attempts.
    expect(promptModels).toEqual(['primary', 'primary', 'primary', 'backup', 'backup', 'backup'])
    const errors = emit.mock.calls.filter(([event]) => event === 'task.error')
    expect(errors).toHaveLength(1)
  })
})
