import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import type { AgentMessage } from '@earendil-works/pi-agent-core'
import { getBuiltinModel as getModel } from '@earendil-works/pi-ai/providers/all'
import type { Task } from '@swarm/protocol'
import { beforeEach, describe, expect, it, vi } from 'vitest'

import { createToolRegistry } from '../tools/registry'
import { buildToolContext, createAgentRunner, pricingToCost } from './agent-runner'

describe('AgentRunner decoupling guard', () => {
  // AgentRunner must not re-acquire a dependency on the Task domain concept.
  it('agent-runner.ts references neither deps.task nor `task: Task`', () => {
    const src = readFileSync(fileURLToPath(new URL('./agent-runner.ts', import.meta.url)), 'utf8')
    expect(src).not.toMatch(/deps\.task\b/)
    expect(src).not.toMatch(/\btask:\s*Task\b/)
  })
})

const MockAgent = vi.hoisted(() => vi.fn())

// Mock pi-agent-core Agent class
vi.mock('@earendil-works/pi-agent-core', () => ({
  Agent: MockAgent,
  shouldCompact: () => false,
  DEFAULT_COMPACTION_SETTINGS: {},
}))

// Mock the builtin model catalog (moved out of the pi-ai root in 0.80.x)
vi.mock('@earendil-works/pi-ai/providers/all', () => ({
  getBuiltinModel: vi.fn(() => ({
    id: 'claude-haiku-4-5-20251001',
    provider: 'anthropic',
    api: 'anthropic-messages',
    baseUrl: 'https://api.anthropic.com',
    compat: {},
  })),
  getBuiltinModels: vi.fn(() => []),
}))

// Mock pi-ai so resolveModel and the dynamic Type import succeed
vi.mock('@earendil-works/pi-ai', () => ({
  clampThinkingLevel: vi.fn((_model: unknown, level: string) => level),
  Type: {
    Object: (props: Record<string, unknown>) => ({ type: 'object', properties: props }),
    String: (opts?: unknown) => ({ type: 'string', ...((opts as object) ?? {}) }),
    Optional: (s: unknown) => s,
    Array: (s: unknown, opts?: unknown) => ({ type: 'array', items: s, ...((opts as object) ?? {}) }),
    Literal: (v: unknown) => ({ type: 'string', const: v }),
    Union: (schemas: unknown[]) => ({ anyOf: schemas }),
  },
}))

const mkTask = (id: string): Task => ({
  id,
  parentId: null,
  agentDefId: 'default',
  goal: 'test goal',
  status: 'pending',
  assignedWorkerId: null,
  toolAllowlist: [],
  plan: [],
  budget: { tokens: 1000, calls: 10, wallMs: 60000, usdCents: 10 },
  used: { tokens: 0, calls: 0, wallMs: 0, usdCents: 0, cacheRead: 0, cacheWrite: 0 },
  history: [],
  attachments: [],
  result: null,
  createdAt: Date.now(),
  startedAt: null,
  endedAt: null,
})

const runCtxFrom = (t: Task) => ({
  correlationId: t.id,
  cwd: t.cwd,
  goal: t.goal,
  executionMode: t.executionMode,
  budget: t.budget,
  toolAllowlist: t.toolAllowlist,
  attachments: t.attachments,
  permissionMode: t.permissionMode,
})

describe('AgentRunner', () => {
  beforeEach(() => {
    MockAgent.mockReset()
  })

  it('emits task.error and returns { status: failed, summary: "" } when apiKey is empty', async () => {
    const emitted: Array<{ event: string; data: unknown }> = []
    const runner = createAgentRunner({
      ...runCtxFrom(mkTask('t-1')),
      provider: {
        id: 'anthropic',
        registry: 'anthropic',
        apiStyle: 'anthropic',
        model: 'claude-haiku-4-5-20251001',
        apiKey: '',
      },
      agentDefinition: {
        id: 'default',
        name: 'Default',
        description: 'd',
        systemPrompt: '',
        toolScope: 'all',
        maxIterations: 1,
      },
      emit: (event, data) => emitted.push({ event, data }),
      permissionRegistry: { request: vi.fn(), resolve: vi.fn() },
      spawnChild: vi.fn(),
      sessionId: 'ses-1',
      initialMessages: [],
      toolRegistry: createToolRegistry(),
    })
    const result = await runner.run()
    expect(result.status).toBe('failed')
    expect(result.summary).toBe('')
    const errEvent = emitted.find((e) => e.event === 'task.error')
    expect(errEvent).toBeDefined()
    const errData = errEvent!.data as { taskId: string; error: { code: string } }
    expect(errData.taskId).toBe('t-1')
    expect(errData.error.code).toBeTruthy()
  })

  it('seeds the agent with initialMessages and returns final messages', async () => {
    const seed = [{ role: 'user', content: 'earlier turn' }] as unknown as AgentMessage[]
    let capturedInitial: unknown

    MockAgent.mockImplementation(function (this: unknown, opts: { initialState?: { messages?: unknown } }) {
      capturedInitial = opts.initialState?.messages
      Object.defineProperty(this, 'state', {
        get() {
          return { messages: [{ role: 'assistant', content: 'reply' }] }
        },
        configurable: true,
      })
      ;(this as Record<string, unknown>).subscribe = () => undefined
      ;(this as Record<string, unknown>).prompt = async () => undefined
    })

    const runner = createAgentRunner({
      ...runCtxFrom({ ...mkTask('t-2'), goal: 'do it' }),
      provider: {
        id: 'anthropic',
        registry: 'anthropic',
        apiStyle: 'anthropic',
        model: 'claude-haiku-4-5-20251001',
        apiKey: 'k',
      },
      agentDefinition: {
        id: 'default',
        name: 'd',
        description: 'd',
        systemPrompt: '',
        toolScope: 'all',
        maxIterations: 25,
      },
      sessionId: 'ses-1',
      emit: () => undefined,
      permissionRegistry: { request: vi.fn(async () => 'grant' as const), resolve: vi.fn() },
      spawnChild: async () => ({ childTaskId: 'c', result: { summary: '', artifacts: [] } }),
      initialMessages: seed,
      toolRegistry: createToolRegistry(),
    })

    const out = await runner.run()
    expect(capturedInitial).toEqual(seed)
    expect(out.messages).toEqual([{ role: 'assistant', content: 'reply' }])
  })

  type BeforeToolCall = (ctx: { toolCall: { name: string }; args: unknown }) => Promise<{ block?: boolean } | undefined>
  type Listener = (e: unknown) => void

  // Installs a MockAgent that captures the beforeToolCall hook, the subscribe
  // listener, and an abort spy, and lets the test control when prompt resolves.
  type PrepareNextTurn = () => unknown
  function installAgent(): {
    abortSpy: ReturnType<typeof vi.fn>
    getBeforeToolCall: () => BeforeToolCall
    getPrepareNextTurn: () => PrepareNextTurn
    emitEvent: (e: unknown) => void
    resolvePrompt: () => void
  } {
    const abortSpy = vi.fn()
    let beforeToolCall: BeforeToolCall = async () => undefined
    let prepareNextTurn: PrepareNextTurn = () => undefined
    let listener: Listener = () => undefined
    let resolvePrompt: () => void = () => undefined
    MockAgent.mockImplementation(function (
      this: Record<string, unknown>,
      opts: { beforeToolCall: BeforeToolCall; prepareNextTurn: PrepareNextTurn }
    ) {
      beforeToolCall = opts.beforeToolCall
      prepareNextTurn = opts.prepareNextTurn
      this.subscribe = (l: Listener) => {
        listener = l
        return () => undefined
      }
      this.abort = abortSpy
      this.prompt = () =>
        new Promise<void>((r) => {
          resolvePrompt = r
        })
      Object.defineProperty(this, 'state', { get: () => ({ messages: [] }), configurable: true })
    })
    return {
      abortSpy,
      getBeforeToolCall: () => beforeToolCall,
      getPrepareNextTurn: () => prepareNextTurn,
      emitEvent: (e) => listener(e),
      resolvePrompt: () => resolvePrompt(),
    }
  }

  const baseDeps = (task: Task) => ({
    ...runCtxFrom(task),
    provider: {
      id: 'anthropic' as const,
      registry: 'anthropic' as const,
      apiStyle: 'anthropic' as const,
      model: 'claude-haiku-4-5-20251001',
      apiKey: 'k',
    },
    agentDefinition: {
      id: 'default',
      name: 'd',
      description: 'd',
      systemPrompt: '',
      toolScope: 'all' as const,
      maxIterations: 25,
    },
    sessionId: 'ses-1',
    emit: () => undefined,
    permissionRegistry: { request: vi.fn(async () => 'grant' as const), resolve: vi.fn() },
    spawnChild: async () => ({ childTaskId: 'c', result: { summary: '', artifacts: [] } }),
    initialMessages: [],
    toolRegistry: createToolRegistry(),
  })

  it('blocks the tool call and aborts the run when the call budget is exhausted', async () => {
    const h = installAgent()
    const task = { ...mkTask('t-calls'), budget: { tokens: 1_000_000, calls: 2, wallMs: 600_000, usdCents: 100_000 } }
    const runner = createAgentRunner(baseDeps(task))
    const p = runner.run()
    const before = h.getBeforeToolCall()
    const call = () => before({ toolCall: { name: 'tool' }, args: {} })

    expect(await call()).toBeUndefined() // call 1 — within budget
    expect(await call()).toBeUndefined() // call 2 — within budget
    expect(await call()).toMatchObject({ block: true }) // call 3 — over budget
    expect(h.abortSpy).toHaveBeenCalled()

    h.resolvePrompt()
    await p
  })

  it('aborts and fails with max_iterations once the turn count hits maxIterations', async () => {
    const h = installAgent()
    const emitted: Array<{ event: string; data: unknown }> = []
    const runner = createAgentRunner({
      ...baseDeps(mkTask('t-iter')),
      agentDefinition: {
        id: 'default',
        name: 'd',
        description: 'd',
        systemPrompt: '',
        toolScope: 'all' as const,
        maxIterations: 3,
      },
      emit: (event, data) => emitted.push({ event, data }),
    })
    const p = runner.run()
    const prepare = h.getPrepareNextTurn()

    prepare() // turn 1
    prepare() // turn 2
    expect(h.abortSpy).not.toHaveBeenCalled()
    prepare() // turn 3 — reaches maxIterations
    expect(h.abortSpy).toHaveBeenCalled()

    h.resolvePrompt()
    const out = await p
    expect(out.status).toBe('failed')
    const errEvent = emitted.find(
      (e) => e.event === 'task.error' && (e.data as { error?: { code?: string } }).error?.code === 'max_iterations'
    )
    expect(errEvent).toBeDefined()
  })

  it('forwards writeAgent/writeSkill from deps to the tool context', () => {
    const calls: string[] = []
    const ctx = buildToolContext({
      ...baseDeps(mkTask('t-write')),
      writeAgent: () => {
        calls.push('agent')
        return { ok: true, agents: [] }
      },
      writeSkill: () => {
        calls.push('skill')
        return { ok: true, skills: [] }
      },
    })
    ctx.writeAgent?.({} as never)
    ctx.writeSkill?.({} as never)
    expect(calls).toEqual(['agent', 'skill'])
  })

  const usageWithSnapshot = (snapshotTokens: number) => ({
    type: 'turn_end',
    message: {
      role: 'assistant',
      usage: {
        input: snapshotTokens,
        output: 0,
        cacheRead: 0,
        cacheWrite: 0,
        totalTokens: snapshotTokens,
        cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
      },
    },
    toolResults: [],
  })

  it('blocks and aborts when the context snapshot exceeds the model window', async () => {
    const h = installAgent()
    const runner = createAgentRunner({
      ...baseDeps(mkTask('t-context')),
      provider: { id: 'custom', model: 'mystery-model', apiKey: 'k', apiStyle: 'openai', contextWindow: 1000 },
    })
    const p = runner.run()

    h.emitEvent(usageWithSnapshot(2000)) // 2000 > 1000 window

    const blocked = await h.getBeforeToolCall()({ toolCall: { name: 'tool' }, args: {} })
    expect(blocked).toMatchObject({ block: true })
    expect(h.abortSpy).toHaveBeenCalled()

    h.resolvePrompt()
    const out = await p
    expect(out.status).toBe('failed')
  })

  it('does not block on cumulative token spend — only the live snapshot vs window matters', async () => {
    const h = installAgent()
    // budget.tokens is tiny (1000), but it is no longer gated; the snapshot
    // (16k) sits well under the window, so the run continues.
    const runner = createAgentRunner({
      ...baseDeps(mkTask('t-no-token-budget')),
      provider: { id: 'custom', model: 'mystery-model', apiKey: 'k', apiStyle: 'openai', contextWindow: 200_000 },
    })
    const p = runner.run()

    h.emitEvent(usageWithSnapshot(16_000))

    const result = await h.getBeforeToolCall()({ toolCall: { name: 'tool' }, args: {} })
    expect(result).toBeUndefined() // not blocked
    expect(h.abortSpy).not.toHaveBeenCalled()

    h.resolvePrompt()
    await p
  })

  // An unknown tool name resolves to 'medium' risk (registry fail-safe), so the
  // default 'ask' mode escalates it while 'full' must bypass the prompt. The two
  // tests together prove the permissionMode branch — not just that nothing throws.
  it('escalates medium/high-risk tools to permissionRegistry.request in the default ask mode', async () => {
    const h = installAgent()
    const request = vi.fn(async () => 'grant' as const)
    const runner = createAgentRunner({
      ...baseDeps(mkTask('t-ask')),
      permissionRegistry: { request, resolve: vi.fn() },
    })
    const p = runner.run()

    const result = await h.getBeforeToolCall()({ toolCall: { name: 'mutate' }, args: {} })
    expect(request).toHaveBeenCalledTimes(1)
    expect(result).toBeUndefined() // granted

    h.resolvePrompt()
    await p
  })

  it('bypasses the permission prompt for medium/high-risk tools when permissionMode is full', async () => {
    const h = installAgent()
    const request = vi.fn(async () => 'grant' as const)
    const runner = createAgentRunner({
      ...baseDeps({ ...mkTask('t-full'), permissionMode: 'full' }),
      permissionRegistry: { request, resolve: vi.fn() },
    })
    const p = runner.run()

    const result = await h.getBeforeToolCall()({ toolCall: { name: 'mutate' }, args: {} })
    expect(result).toBeUndefined()
    expect(request).not.toHaveBeenCalled()

    h.resolvePrompt()
    await p
  })

  it('resolves the gate from getPermissionMode live, so a mid-run switch to full takes effect', async () => {
    const h = installAgent()
    const request = vi.fn(async () => 'grant' as const)
    let mode: 'ask' | 'full' = 'ask'
    const runner = createAgentRunner({
      ...baseDeps(mkTask('t-live')),
      getPermissionMode: () => mode,
      permissionRegistry: { request, resolve: vi.fn() },
    })
    const p = runner.run()

    // First medium-risk call under 'ask' escalates to the user.
    await h.getBeforeToolCall()({ toolCall: { name: 'mutate' }, args: {} })
    expect(request).toHaveBeenCalledTimes(1)

    // User flips the composer toggle to 'full' mid-run.
    mode = 'full'

    // The next call reads the live mode and bypasses the prompt — no new request.
    const result = await h.getBeforeToolCall()({ toolCall: { name: 'mutate' }, args: {} })
    expect(result).toBeUndefined()
    expect(request).toHaveBeenCalledTimes(1)

    h.resolvePrompt()
    await p
  })

  it('aborts the agent and returns status cancelled when the provided signal fires', async () => {
    const h = installAgent()
    const ac = new AbortController()
    const runner = createAgentRunner({ ...baseDeps(mkTask('t-cancel')), signal: ac.signal })
    const p = runner.run()
    await Promise.resolve()

    ac.abort()
    expect(h.abortSpy).toHaveBeenCalled()

    h.resolvePrompt()
    const out = await p
    expect(out.status).toBe('cancelled')
  })

  it('emits task.usage on turn_end and returns final used', async () => {
    const h = installAgent()
    const emitted: Array<{ event: string; data: Record<string, unknown> }> = []
    const runner = createAgentRunner({
      ...baseDeps(mkTask('t-usage')),
      emit: (event, data) => emitted.push({ event, data: data as Record<string, unknown> }),
    })
    const p = runner.run()

    await h.getBeforeToolCall()({ toolCall: { name: 'tool' }, args: {} }) // calls -> 1
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

    const usage = emitted.find((e) => e.event === 'task.usage')
    expect(usage).toBeDefined()
    const used = usage!.data.used as { tokens: number; calls: number; usdCents: number }
    expect(used.tokens).toBe(1500)
    expect(used.usdCents).toBe(5) // round(0.05 * 100)
    expect(used.calls).toBe(1)

    h.resolvePrompt()
    const out = await p
    expect(out.used).toMatchObject({ tokens: 1500, calls: 1, usdCents: 5 })
  })

  const cwUsageEvent = {
    type: 'turn_end',
    message: {
      role: 'assistant',
      usage: {
        input: 0,
        output: 0,
        cacheRead: 0,
        cacheWrite: 0,
        totalTokens: 100,
        cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
      },
    },
    toolResults: [],
  }

  it('resolves an unknown custom model context window to the 200k default', async () => {
    const h = installAgent()
    const emitted: Array<{ event: string; data: Record<string, unknown> }> = []
    const runner = createAgentRunner({
      ...baseDeps(mkTask('t-cw-default')),
      provider: { id: 'custom', model: 'mystery-model', apiKey: 'k', apiStyle: 'openai' },
      emit: (event, data) => emitted.push({ event, data: data as Record<string, unknown> }),
    })
    const p = runner.run()
    h.emitEvent(cwUsageEvent)
    const usage = emitted.find((e) => e.event === 'task.usage')
    expect(usage!.data.contextWindow).toBe(200_000)
    h.resolvePrompt()
    await p
  })

  // Regression: custom providers now carry a generated UUID id (multi-custom v2),
  // not the literal 'custom'. resolveModel must look them up by apiStyle, never by
  // the id — else pi-ai throws "has no registered models for provider <uuid>".
  it('looks up a UUID-id custom provider by its apiStyle, not its id', async () => {
    vi.mocked(getModel).mockClear()
    const h = installAgent()
    const runner = createAgentRunner({
      ...baseDeps(mkTask('t-uuid')),
      provider: {
        id: '1ec9df3a-02f0-4d29-b83b-c21bc8644801',
        model: 'glm-4',
        apiKey: 'k',
        apiStyle: 'openai',
      },
    })
    const p = runner.run()
    h.resolvePrompt()
    await p
    const providersQueried = vi.mocked(getModel).mock.calls.map((c) => c[0])
    expect(providersQueried).toContain('openai')
    expect(providersQueried).not.toContain('1ec9df3a-02f0-4d29-b83b-c21bc8644801')
  })

  it('honors an explicit custom contextWindow override', async () => {
    const h = installAgent()
    const emitted: Array<{ event: string; data: Record<string, unknown> }> = []
    const runner = createAgentRunner({
      ...baseDeps(mkTask('t-cw-override')),
      provider: { id: 'custom', model: 'mystery-model', apiKey: 'k', apiStyle: 'openai', contextWindow: 1_000_000 },
      emit: (event, data) => emitted.push({ event, data: data as Record<string, unknown> }),
    })
    const p = runner.run()
    h.emitEvent(cwUsageEvent)
    const usage = emitted.find((e) => e.event === 'task.usage')
    expect(usage!.data.contextWindow).toBe(1_000_000)
    h.resolvePrompt()
    await p
  })

  it('emits task.plan with the structured todos when update_plan runs', async () => {
    const h = installAgent()
    const emitted: Array<{ event: string; data: Record<string, unknown> }> = []
    const runner = createAgentRunner({
      ...baseDeps(mkTask('t-plan')),
      emit: (event, data) => emitted.push({ event, data: data as Record<string, unknown> }),
    })
    const p = runner.run()

    const todos = [
      { content: 'step one', status: 'completed' },
      { content: 'step two', status: 'in_progress' },
    ]
    h.emitEvent({
      type: 'tool_execution_end',
      toolName: 'update_plan',
      isError: false,
      result: { content: [{ type: 'text', text: 'Plan (2 steps): ...' }], details: { todos } },
    })

    const plan = emitted.find((e) => e.event === 'task.plan')
    expect(plan).toBeDefined()
    expect(plan!.data.todos).toEqual(todos)

    h.resolvePrompt()
    await p
  })
})

describe('pricingToCost', () => {
  it('maps full pricing (all four fields present) to the Model.cost shape', () => {
    expect(pricingToCost({ inputPerM: 3, outputPerM: 15, cacheReadPerM: 0.3, cacheWritePerM: 1 })).toEqual({
      input: 3,
      output: 15,
      cacheRead: 0.3,
      cacheWrite: 1,
    })
  })

  it('defaults absent cache fields to 0', () => {
    expect(pricingToCost({ inputPerM: 3, outputPerM: 15 })).toEqual({
      input: 3,
      output: 15,
      cacheRead: 0,
      cacheWrite: 0,
    })
  })
})
