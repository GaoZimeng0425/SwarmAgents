import type { AgentMessage } from '@earendil-works/pi-agent-core'
import type { Task } from '@shared/types/task'
import { beforeEach, describe, expect, it, vi } from 'vitest'

import { createAgentRunner } from './agent-runner'
import { createToolRegistry } from './tools/registry'

const MockAgent = vi.hoisted(() => vi.fn())

// Mock pi-agent-core Agent class
vi.mock('@earendil-works/pi-agent-core', () => ({
  Agent: MockAgent,
}))

// Mock pi-ai so resolveModel and the dynamic Type import succeed
vi.mock('@earendil-works/pi-ai', () => ({
  getModel: vi.fn(() => ({
    id: 'claude-haiku-4-5-20251001',
    provider: 'anthropic',
    api: 'anthropic-messages',
    baseUrl: 'https://api.anthropic.com',
    compat: {},
  })),
  getModels: vi.fn(() => []),
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
  budget: { tokens: 1000, calls: 10, wallMs: 60000, usdCents: 10 },
  used: { tokens: 0, calls: 0, wallMs: 0, usdCents: 0 },
  history: [],
  result: null,
  createdAt: Date.now(),
  startedAt: null,
  endedAt: null,
})

describe('AgentRunner', () => {
  beforeEach(() => {
    MockAgent.mockReset()
  })

  it('emits task.error and returns { status: failed, summary: "" } when apiKey is empty', async () => {
    const emitted: Array<{ event: string; data: unknown }> = []
    const runner = createAgentRunner({
      task: mkTask('t-1'),
      provider: { id: 'anthropic', model: 'claude-haiku-4-5-20251001', apiKey: '' },
      agentDefinition: { id: 'default', name: 'Default', systemPrompt: '', toolScope: 'all', maxIterations: 1 },
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
      task: { ...mkTask('t-2'), goal: 'do it' },
      provider: { id: 'anthropic', model: 'claude-haiku-4-5-20251001', apiKey: 'k' },
      agentDefinition: { id: 'default', name: 'd', systemPrompt: '', toolScope: 'all', maxIterations: 25 },
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
  function installAgent(): {
    abortSpy: ReturnType<typeof vi.fn>
    getBeforeToolCall: () => BeforeToolCall
    emitEvent: (e: unknown) => void
    resolvePrompt: () => void
  } {
    const abortSpy = vi.fn()
    let beforeToolCall: BeforeToolCall = async () => undefined
    let listener: Listener = () => undefined
    let resolvePrompt: () => void = () => undefined
    MockAgent.mockImplementation(function (this: Record<string, unknown>, opts: { beforeToolCall: BeforeToolCall }) {
      beforeToolCall = opts.beforeToolCall
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
      emitEvent: (e) => listener(e),
      resolvePrompt: () => resolvePrompt(),
    }
  }

  const baseDeps = (task: Task) => ({
    task,
    provider: { id: 'anthropic' as const, model: 'claude-haiku-4-5-20251001', apiKey: 'k' },
    agentDefinition: { id: 'default', name: 'd', systemPrompt: '', toolScope: 'all' as const, maxIterations: 25 },
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

  it('blocks and aborts when the token budget is exhausted', async () => {
    const h = installAgent()
    const task = { ...mkTask('t-tokens'), budget: { tokens: 1000, calls: 100, wallMs: 600_000, usdCents: 100_000 } }
    const runner = createAgentRunner(baseDeps(task))
    const p = runner.run()

    h.emitEvent({
      type: 'turn_end',
      message: {
        role: 'assistant',
        usage: {
          input: 0,
          output: 0,
          cacheRead: 0,
          cacheWrite: 0,
          totalTokens: 2000,
          cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
        },
      },
      toolResults: [],
    })

    const blocked = await h.getBeforeToolCall()({ toolCall: { name: 'tool' }, args: {} })
    expect(blocked).toMatchObject({ block: true })
    expect(h.abortSpy).toHaveBeenCalled()

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
