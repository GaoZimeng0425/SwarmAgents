import { describe, it, expect, vi, beforeEach } from 'vitest'
import { createAgentRunner } from './agent-runner'
import type { Task } from '@shared/types/task'
import type { AgentMessage } from '@earendil-works/pi-agent-core'

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
  id, parentId: null, agentDefId: 'default', goal: 'test goal',
  status: 'pending', assignedWorkerId: null, toolAllowlist: [],
  budget: { tokens: 1000, calls: 10, wallMs: 60000, usdCents: 10 },
  used: { tokens: 0, calls: 0, wallMs: 0, usdCents: 0 },
  history: [], result: null, createdAt: Date.now(), startedAt: null, endedAt: null,
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
        get() { return { messages: [{ role: 'assistant', content: 'reply' }] } },
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
    })

    const out = await runner.run()
    expect(capturedInitial).toEqual(seed)
    expect(out.messages).toEqual([{ role: 'assistant', content: 'reply' }])
  })
})
