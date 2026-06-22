import { describe, expect, it, vi } from 'vitest'

// Mock the pi Agent so promptOnce runs without an LLM. The mock records each
// prompt and accumulates them into state.messages, and emits an agent_end so
// the event translator produces a summary.
const prompts: string[] = []
vi.mock('@earendil-works/pi-agent-core', () => {
  class Agent {
    state = { messages: [] as Array<{ role: string; content: string }> }
    private subscriber: ((e: unknown) => void) | null = null
    constructor(_cfg: unknown) {}
    subscribe(fn: (e: unknown) => void) {
      this.subscriber = fn
    }
    abort() {}
    async prompt(goal: string) {
      prompts.push(goal)
      this.state.messages.push({ role: 'user', content: goal })
      this.state.messages.push({ role: 'assistant', content: `ack:${goal}` })
      // Minimal event stream: a text delta then agent_end so the translator
      // assembles a summary.
      this.subscriber?.({
        type: 'message_update',
        assistantMessageEvent: { type: 'text_delta', delta: `ack:${goal}` },
      })
      this.subscriber?.({ type: 'agent_end' })
    }
  }
  return {
    Agent,
    shouldCompact: () => false,
    DEFAULT_COMPACTION_SETTINGS: {},
  }
})

import type { AgentRunnerDeps } from './agent-runner'
import { buildAgentSession } from './agent-runner'

const deps = (): AgentRunnerDeps =>
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
    emit: () => {},
    permissionRegistry: { request: async () => 'grant', resolve: () => {} } as any,
    toolRegistry: { resolve: () => ({ tools: [], riskOf: () => 'low' }) } as any,
    initialMessages: [],
    spawnChild: async () => ({ childTaskId: 'c', result: { summary: '', artifacts: [] } }),
  }) as any

describe('buildAgentSession', () => {
  it('promptOnce returns a completed summary for the prompt', async () => {
    prompts.length = 0
    const s = buildAgentSession(deps())
    const r = await s.promptOnce('first')
    expect(r.status).toBe('completed')
    expect(r.summary).toContain('ack:first')
    expect(prompts).toEqual(['first'])
  })

  it('two promptOnce calls reuse the same agent state (context accumulates)', async () => {
    prompts.length = 0
    const s = buildAgentSession(deps())
    await s.promptOnce('first')
    await s.promptOnce('second')
    // Both prompts went to the SAME agent; its message history holds both turns.
    expect(prompts).toEqual(['first', 'second'])
    expect(s.agent.state.messages.map((m) => m.content)).toEqual(['first', 'ack:first', 'second', 'ack:second'])
  })

  it('exposes contextWindow and a getContextTokens snapshot', () => {
    const s = buildAgentSession(deps())
    expect(typeof s.contextWindow).toBe('number')
    expect(s.contextWindow).toBeGreaterThan(0)
    expect(s.getContextTokens()).toBe(0) // no turn run yet
  })
})
