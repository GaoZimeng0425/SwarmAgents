import { beforeEach, describe, expect, it, vi } from 'vitest'

const MockAgent = vi.hoisted(() => vi.fn())

vi.mock('@earendil-works/pi-agent-core', () => ({ Agent: MockAgent }))

import type { RunEmitInput } from './emit'
import { createEngine, type EngineDeps, EngineSetupError } from './engine'

type Emitted = RunEmitInput[]

const collect = (): { out: Emitted; emit: (i: RunEmitInput) => void } => {
  const out: Emitted = []
  return { out, emit: (i) => out.push(i) }
}

const terminals = (out: Emitted) => out.filter((e) => e.kind === 'run.complete' || e.kind === 'run.error')

const baseDeps = (emit: (i: RunEmitInput) => void, over: Partial<EngineDeps> = {}): EngineDeps =>
  ({
    runId: 'r1',
    sessionId: 's1',
    agentDefinition: {
      id: 'default',
      name: 'd',
      description: 'd',
      systemPrompt: '',
      toolScope: 'all',
      maxIterations: 25,
    },
    provider: { id: 'c1', model: 'test-model', apiStyle: 'anthropic', apiKey: 'k' },
    history: [],
    budget: { calls: 100, wallMs: 600_000, usdCents: 100_000 },
    permissionMode: 'full',
    tools: [],
    riskOf: () => 'low',
    emit,
    permissionRegistry: { request: vi.fn(async () => 'grant'), resolve: vi.fn() },
    retry: { maxRetries: 2, delayMs: 0 },
    ...over,
  }) as never

// --- Style A: hook-capturing mock with a held prompt (gate tests) ---
type BeforeToolCall = (ctx: { toolCall: { name: string }; args: unknown }) => Promise<{ block?: boolean } | undefined>
function installAgent(): {
  abortSpy: ReturnType<typeof vi.fn>
  getBeforeToolCall: () => BeforeToolCall
  getPrepareNextTurn: () => () => unknown
  emitEvent: (e: unknown) => void
  resolvePrompt: () => void
} {
  const abortSpy = vi.fn()
  let beforeToolCall: BeforeToolCall = async () => undefined
  let prepareNextTurn: () => unknown = () => undefined
  let listener: (e: unknown) => void = () => undefined
  let resolvePrompt: () => void = () => undefined
  MockAgent.mockImplementation(function (
    this: Record<string, unknown>,
    opts: { beforeToolCall: BeforeToolCall; prepareNextTurn: () => unknown; initialState?: { messages?: unknown[] } }
  ) {
    beforeToolCall = opts.beforeToolCall
    prepareNextTurn = opts.prepareNextTurn
    this.subscribe = (l: (e: unknown) => void) => {
      listener = l
      return () => undefined
    }
    this.abort = abortSpy
    this.prompt = () =>
      new Promise<void>((r) => {
        resolvePrompt = r
      })
    this.state = { messages: [...((opts.initialState?.messages as unknown[]) ?? [])], model: undefined }
  })
  return {
    abortSpy,
    getBeforeToolCall: () => beforeToolCall,
    getPrepareNextTurn: () => prepareNextTurn,
    emitEvent: (e) => listener(e),
    resolvePrompt: () => resolvePrompt(),
  }
}

// --- Style B: programmable auto-completing mock (retry/summary tests) ---
let failTimes = 0
let promptCalls = 0
function installAutoAgent(reply = 'done.') {
  MockAgent.mockImplementation(function (
    this: Record<string, unknown>,
    opts: { initialState?: { messages?: unknown[] } }
  ) {
    let sub: ((e: unknown) => void) | null = null
    this.state = { messages: [...((opts.initialState?.messages as unknown[]) ?? [])], model: undefined }
    this.subscribe = (fn: (e: unknown) => void) => {
      sub = fn
    }
    this.abort = () => undefined
    this.prompt = async (goal: string) => {
      promptCalls++
      const msgs = this.state as { messages: Array<Record<string, unknown>> }
      msgs.messages.push({ role: 'user', content: goal })
      if (promptCalls <= failTimes) {
        const failure = { role: 'assistant', content: [], stopReason: 'error', errorMessage: 'transient 503' }
        msgs.messages.push(failure)
        sub?.({ type: 'message_end', message: failure })
        sub?.({ type: 'agent_end', messages: [failure] })
        return
      }
      const ok = { role: 'assistant', content: [{ type: 'text', text: reply }], stopReason: 'end_turn' }
      msgs.messages.push(ok)
      if (reply) sub?.({ type: 'message_update', assistantMessageEvent: { type: 'text_delta', delta: reply } })
      sub?.({ type: 'agent_end', messages: [ok] })
    }
  })
}

beforeEach(() => {
  MockAgent.mockReset()
  failTimes = 0
  promptCalls = 0
})

describe('createEngine — setup', () => {
  it('throws EngineSetupError when the API key is empty, emitting nothing', () => {
    const { out, emit } = collect()
    expect(() =>
      createEngine(baseDeps(emit, { provider: { id: 'c1', model: 'm', apiStyle: 'anthropic', apiKey: '' } as never }))
    ).toThrow(EngineSetupError)
    expect(out).toHaveLength(0)
  })
})

describe('engine gates — each aborted run emits exactly ONE terminal', () => {
  it('blocks over-budget tool calls and terminates with budget_exhausted', async () => {
    const h = installAgent()
    const { out, emit } = collect()
    const engine = createEngine(baseDeps(emit, { budget: { calls: 2, wallMs: 600_000, usdCents: 100_000 } as never }))
    const p = engine.run('go')
    const call = () => h.getBeforeToolCall()({ toolCall: { name: 'tool' }, args: {} })
    expect(await call()).toBeUndefined()
    expect(await call()).toBeUndefined()
    expect(await call()).toMatchObject({ block: true })
    expect(h.abortSpy).toHaveBeenCalled()
    h.emitEvent({ type: 'agent_end', messages: [{ role: 'assistant', content: [], stopReason: 'aborted' }] })
    h.resolvePrompt()
    const r = await p
    expect(r.status).toBe('failed')
    const t = terminals(out)
    expect(t).toHaveLength(1)
    expect(t[0]).toMatchObject({ kind: 'run.error', error: { code: 'budget_exhausted' } })
  })

  it('terminates with context_window_full when the snapshot exceeds the window', async () => {
    const h = installAgent()
    const { out, emit } = collect()
    const engine = createEngine(
      baseDeps(emit, {
        provider: { id: 'c1', model: 'm', apiStyle: 'openai', apiKey: 'k', contextWindow: 1000 } as never,
      })
    )
    const p = engine.run('go')
    h.emitEvent({
      type: 'turn_end',
      message: {
        role: 'assistant',
        usage: {
          input: 2000,
          output: 0,
          cacheRead: 0,
          cacheWrite: 0,
          totalTokens: 2000,
          cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
        },
      },
      toolResults: [],
    })
    expect(await h.getBeforeToolCall()({ toolCall: { name: 'tool' }, args: {} })).toMatchObject({ block: true })
    h.emitEvent({ type: 'agent_end', messages: [{ role: 'assistant', content: [], stopReason: 'aborted' }] })
    h.resolvePrompt()
    const r = await p
    expect(r.status).toBe('failed')
    expect(terminals(out)).toHaveLength(1)
    expect(terminals(out)[0]).toMatchObject({ kind: 'run.error', error: { code: 'context_window_full' } })
  })

  it('terminates with max_iterations when the turn cap trips — even on a natural-finish turn without an aborted stamp', async () => {
    // Spec §7 residual: v1 double-terminated when pi ended naturally after the
    // iterations abort. The engine owns the terminal, so no agent_end shape can
    // produce a second one — pin BOTH shapes.
    for (const endMessages of [
      [{ role: 'assistant', content: [], stopReason: 'aborted' }],
      [{ role: 'assistant', content: [{ type: 'text', text: 'done anyway.' }], stopReason: 'end_turn' }],
    ]) {
      MockAgent.mockReset()
      const h = installAgent()
      const { out, emit } = collect()
      const engine = createEngine(
        baseDeps(emit, {
          agentDefinition: {
            id: 'default',
            name: 'd',
            description: 'd',
            systemPrompt: '',
            toolScope: 'all',
            maxIterations: 2,
          } as never,
        })
      )
      const p = engine.run('go')
      h.getPrepareNextTurn()()
      h.getPrepareNextTurn()()
      expect(h.abortSpy).toHaveBeenCalled()
      h.emitEvent({ type: 'agent_end', messages: endMessages })
      h.resolvePrompt()
      const r = await p
      expect(r.status).toBe('failed')
      const t = terminals(out)
      expect(t).toHaveLength(1)
      expect(t[0]).toMatchObject({ kind: 'run.error', error: { code: 'max_iterations' } })
    }
  })

  it('terminates cancelled exactly once when the signal fires (aborted stamp included)', async () => {
    const h = installAgent()
    const { out, emit } = collect()
    const ac = new AbortController()
    const engine = createEngine(baseDeps(emit, { signal: ac.signal }))
    const p = engine.run('go')
    await Promise.resolve()
    ac.abort()
    expect(h.abortSpy).toHaveBeenCalled()
    h.emitEvent({ type: 'agent_end', messages: [{ role: 'assistant', content: [], stopReason: 'aborted' }] })
    h.resolvePrompt()
    const r = await p
    expect(r.status).toBe('cancelled')
    const t = terminals(out)
    expect(t).toHaveLength(1)
    expect(t[0]).toMatchObject({ kind: 'run.error', error: { code: 'cancelled' } })
  })

  it('treats an externally aborted run with no recorded cause as cancelled (precedence rule 3)', async () => {
    const h = installAgent()
    const { out, emit } = collect()
    const engine = createEngine(baseDeps(emit))
    const p = engine.run('go')
    engine.abort() // direct abort — no stopCause, no signal
    h.emitEvent({ type: 'agent_end', messages: [{ role: 'assistant', content: [], stopReason: 'aborted' }] })
    h.resolvePrompt()
    const r = await p
    expect(r.status).toBe('cancelled')
    expect(terminals(out)).toHaveLength(1)
  })

  it('escalates medium-risk tools to the permission registry under ask, and bypasses under full', async () => {
    for (const [mode, expectedCalls] of [
      ['ask', 1],
      ['full', 0],
    ] as const) {
      MockAgent.mockReset()
      const h = installAgent()
      const { emit } = collect()
      const request = vi.fn(async () => 'grant' as const)
      const engine = createEngine(
        baseDeps(emit, {
          permissionMode: mode,
          riskOf: () => 'medium',
          permissionRegistry: { request, resolve: vi.fn() } as never,
        })
      )
      const p = engine.run('go')
      const result = await h.getBeforeToolCall()({ toolCall: { name: 'mutate' }, args: {} })
      expect(result).toBeUndefined()
      expect(request).toHaveBeenCalledTimes(expectedCalls)
      h.emitEvent({ type: 'agent_end', messages: [{ role: 'assistant', content: [], stopReason: 'end_turn' }] })
      h.resolvePrompt()
      await p
    }
  })

  it('reads getPermissionMode live so a mid-run switch to full takes effect', async () => {
    const h = installAgent()
    const { emit } = collect()
    const request = vi.fn(async () => 'grant' as const)
    let mode: 'ask' | 'full' = 'ask'
    const engine = createEngine(
      baseDeps(emit, {
        permissionMode: 'ask',
        getPermissionMode: () => mode,
        riskOf: () => 'medium',
        permissionRegistry: { request, resolve: vi.fn() } as never,
      })
    )
    const p = engine.run('go')
    await h.getBeforeToolCall()({ toolCall: { name: 'mutate' }, args: {} })
    expect(request).toHaveBeenCalledTimes(1)
    mode = 'full'
    await h.getBeforeToolCall()({ toolCall: { name: 'mutate' }, args: {} })
    expect(request).toHaveBeenCalledTimes(1)
    h.emitEvent({ type: 'agent_end', messages: [{ role: 'assistant', content: [], stopReason: 'end_turn' }] })
    h.resolvePrompt()
    await p
  })

  it('emits run.usage on turn_end with the live model id and calls saveSnapshot', async () => {
    const h = installAgent()
    const { out, emit } = collect()
    const saveSnapshot = vi.fn()
    const engine = createEngine(baseDeps(emit, { saveSnapshot }))
    const p = engine.run('go')
    h.emitEvent({
      type: 'turn_end',
      message: {
        role: 'assistant',
        usage: {
          input: 0,
          output: 0,
          cacheRead: 0,
          cacheWrite: 0,
          totalTokens: 1500,
          cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0.05 },
        },
      },
      toolResults: [],
    })
    const usage = out.find((e) => e.kind === 'run.usage') as
      | { used: { tokens: number; usdCents: number }; model?: string }
      | undefined
    expect(usage).toBeDefined()
    expect(usage!.used.tokens).toBe(1500)
    expect(usage!.used.usdCents).toBe(5)
    expect(usage!.model).toBe('test-model')
    expect(saveSnapshot).toHaveBeenCalled()
    h.emitEvent({ type: 'agent_end', messages: [{ role: 'assistant', content: [], stopReason: 'end_turn' }] })
    h.resolvePrompt()
    await p
  })

  it('chargeExternalUsd folds spend into usdCents and emits run.usage', async () => {
    installAutoAgent()
    const { out, emit } = collect()
    const engine = createEngine(baseDeps(emit))
    engine.chargeExternalUsd(0.5)
    expect(engine.getUsed().usdCents).toBe(50)
    expect(out.some((e) => e.kind === 'run.usage')).toBe(true)
  })

  it('rewrites the generic "Operation aborted" tool result to the real stop cause (carry-over c)', async () => {
    const h = installAgent()
    const { emit } = collect()
    const ac = new AbortController()
    const engine = createEngine(baseDeps(emit, { signal: ac.signal }))
    const p = engine.run('go')
    await Promise.resolve()
    ac.abort()
    const evt = {
      type: 'tool_execution_end',
      toolName: 'shell',
      isError: true,
      result: { content: [{ type: 'text', text: 'Operation aborted' }] },
    }
    h.emitEvent(evt)
    expect(evt.result.content[0].text).toBe('Stopped by user.')
    h.emitEvent({ type: 'agent_end', messages: [{ role: 'assistant', content: [], stopReason: 'aborted' }] })
    h.resolvePrompt()
    await p
  })
})

describe('engine retry/fallback', () => {
  it('retries transient failures with visible transient notices, then completes — one terminal total', async () => {
    installAutoAgent()
    failTimes = 2
    const { out, emit } = collect()
    const engine = createEngine(baseDeps(emit))
    const r = await engine.run('go')
    expect(r.status).toBe('completed')
    expect(promptCalls).toBe(3)
    const notices = out.filter(
      (e) =>
        e.kind === 'run.progress' &&
        (e as { event: { kind: string; error?: { tier?: string } } }).event.kind === 'error'
    )
    expect(notices).toHaveLength(2)
    expect(terminals(out)).toHaveLength(1)
    expect(terminals(out)[0].kind).toBe('run.complete')
  })

  it('gives up after retries exhaust with a single agent_request_failed terminal', async () => {
    installAutoAgent()
    failTimes = 999
    const { out, emit } = collect()
    const engine = createEngine(baseDeps(emit))
    const r = await engine.run('go')
    expect(r.status).toBe('failed')
    expect(promptCalls).toBe(3) // 1 + maxRetries(2)
    const t = terminals(out)
    expect(t).toHaveLength(1)
    expect(t[0]).toMatchObject({ kind: 'run.error', error: { code: 'agent_request_failed', message: 'transient 503' } })
  })

  it('advances to the fallback model after exhausting the primary, announcing the switch', async () => {
    installAutoAgent()
    failTimes = 3 // primary: 1 + 2 retries all fail; fallback's first attempt (call 4) succeeds
    const { out, emit } = collect()
    const engine = createEngine(
      baseDeps(emit, {
        fallbackProviders: [{ id: 'fb', model: 'fallback-model', apiStyle: 'openai', apiKey: 'k' }] as never,
      })
    )
    const r = await engine.run('go')
    expect(r.status).toBe('completed')
    expect(promptCalls).toBe(4)
    expect(
      out.some(
        (e) =>
          e.kind === 'run.progress' &&
          (e as { event: { error?: { code?: string } } }).event.error?.code === 'agent_model_fallback'
      )
    ).toBe(true)
    expect(terminals(out)).toHaveLength(1)
  })

  it('restores the transcript before each retry so failed turns are discarded', async () => {
    installAutoAgent()
    failTimes = 2
    const { emit } = collect()
    const engine = createEngine(baseDeps(emit))
    const r = await engine.run('go')
    expect(r.messages).toHaveLength(2) // final user goal + success reply only
    expect(r.messages.some((m) => (m as { stopReason?: string }).stopReason === 'error')).toBe(false)
  })
})

describe('engine summary (carry-over a)', () => {
  it('completes with the trimmed assembled summary', async () => {
    installAutoAgent('done.')
    const { out, emit } = collect()
    const r = await createEngine(baseDeps(emit)).run('go')
    expect(r.summary).toBe('done.')
    expect(terminals(out)[0]).toMatchObject({ kind: 'run.complete', summary: 'done.' })
  })

  it('falls back to "Completed run <id>." when the model produced no text', async () => {
    installAutoAgent('')
    const { out, emit } = collect()
    const r = await createEngine(baseDeps(emit)).run('go')
    expect(r.status).toBe('completed')
    expect(terminals(out)[0]).toMatchObject({ kind: 'run.complete', summary: 'Completed run r1.' })
    expect(r.summary).toBe('Completed run r1.')
  })
})
