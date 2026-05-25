import type { Outbound } from '@shared/types/ipc'
import type { Task } from '@shared/types/task'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const agentInstances: Array<{ config: unknown; promptCalls: string[] }> = []

vi.mock('@earendil-works/pi-agent-core', () => ({
  Agent: vi.fn().mockImplementation(function (this: object, config: unknown) {
    const promptCalls: string[] = []
    Object.assign(this, {
      subscribe: vi.fn(() => () => {}),
      prompt: vi.fn(async (g: string) => {
        promptCalls.push(g)
      }),
    })
    agentInstances.push({ config, promptCalls })
  }),
}))

vi.mock('@earendil-works/pi-ai', () => ({
  getModel: vi.fn(() => ({ __stub: 'model' })),
}))

// peekaboo tool wiring depends on environment / electron — keep it inert.
vi.mock('./tools/peekaboo', () => ({
  buildPeekabooTools: vi.fn(() => ({})),
}))

import { runPiAgent } from './index'

const mkTask = (goal: string): Task => ({
  id: '01HX00000000000000000PIAGT',
  parentId: null,
  goal,
  status: 'dispatched',
  assignedWorkerId: null,
  toolAllowlist: [],
  budget: { tokens: 0, calls: 0, wallMs: 0, usdCents: 0 },
  used: { tokens: 0, calls: 0, wallMs: 0, usdCents: 0 },
  history: [],
  result: null,
  createdAt: 1,
  startedAt: null,
  endedAt: null,
})

beforeEach(() => {
  agentInstances.length = 0
})

afterEach(() => {
  vi.clearAllMocks()
})

describe('runPiAgent', () => {
  it('constructs Agent with apiKey from the injection (not from process.env)', async () => {
    const original = process.env.ANTHROPIC_API_KEY
    delete process.env.ANTHROPIC_API_KEY
    try {
      const sent: Outbound[] = []
      await runPiAgent(mkTask('test'), {
        send: (m) => sent.push(m),
        permissionClient: { request: async () => 'grant', resolve: () => {} },
        provider: { id: 'anthropic', model: 'claude-sonnet-4-5', apiKey: 'sk-injection' },
      })
      expect(agentInstances).toHaveLength(1)
      // Agent constructor takes AgentOptions, which exposes a `getApiKey(provider)`
      // callback (not a top-level `apiKey` field). Returning the injected key
      // here is what keeps pi-ai from reading process.env.
      const config = agentInstances[0].config as {
        getApiKey?: (provider: string) => string | undefined
      }
      expect(config.getApiKey?.('anthropic')).toBe('sk-injection')
      // No missing-api-key error should be emitted — the env var is irrelevant now.
      expect(sent.find((m) => m.type === 'task.error')).toBeUndefined()
    } finally {
      if (original !== undefined) process.env.ANTHROPIC_API_KEY = original
    }
  })

  it('passes the injected model id through to getModel', async () => {
    const { getModel } = await import('@earendil-works/pi-ai')
    await runPiAgent(mkTask('test'), {
      send: () => {},
      permissionClient: { request: async () => 'grant', resolve: () => {} },
      provider: { id: 'anthropic', model: 'claude-haiku-4-5', apiKey: 'sk-x' },
    })
    expect(getModel).toHaveBeenCalledWith('anthropic', 'claude-haiku-4-5')
  })

  it('forwards the goal to agent.prompt', async () => {
    await runPiAgent(mkTask('do a thing'), {
      send: () => {},
      permissionClient: { request: async () => 'grant', resolve: () => {} },
      provider: { id: 'anthropic', model: 'claude-sonnet-4-5', apiKey: 'sk-x' },
    })
    expect(agentInstances[0].promptCalls).toEqual(['do a thing'])
  })
})
