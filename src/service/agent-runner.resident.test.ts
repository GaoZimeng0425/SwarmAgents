import { describe, expect, it, vi } from 'vitest'

const prompts: string[] = []
vi.mock('@earendil-works/pi-agent-core', () => {
  class Agent {
    state = { messages: [] as Array<{ role: string; content: string }> }
    private sub: ((e: unknown) => void) | null = null
    constructor(_c: unknown) {}
    subscribe(fn: (e: unknown) => void) {
      this.sub = fn
    }
    abort() {}
    async prompt(goal: string) {
      prompts.push(goal)
      this.state.messages.push({ role: 'assistant', content: `ack:${goal}` })
      this.sub?.({ type: 'message_update', assistantMessageEvent: { type: 'text_delta', delta: `ack:${goal}` } })
      this.sub?.({ type: 'agent_end' })
    }
  }
  return { Agent }
})

import type { ActorMessage } from '@shared/types/actor'

import { createMailbox } from './actor-mailbox'
import type { AgentRunnerDeps } from './agent-runner'
import { runResident } from './agent-runner'

const deps = (): AgentRunnerDeps => ({
  task: {
    id: 't1',
    goal: '',
    cwd: undefined,
    attachments: [],
    budget: { calls: 1000, wallMs: 600000, usdCents: 100000, tokens: 1e9 },
    permissionMode: 'full',
  } as any,
  provider: { model: 'test', apiStyle: 'anthropic', apiKey: 'k' } as any,
  agentDefinition: { id: 'default', systemPrompt: 'sys', toolScope: 'all', maxIterations: 25 } as any,
  sessionId: 's1',
  emit: () => {},
  permissionRegistry: { request: async () => 'grant', resolve: () => {} } as any,
  toolRegistry: { resolve: () => ({ tools: [], riskOf: () => 'low' }) } as any,
  initialMessages: [],
  spawnChild: async () => ({ childTaskId: 'c', result: { summary: '', artifacts: [] } }) as any,
})

const m = (id: string, kind: 'send' | 'rpc', correlationId: string | null, payload: string): ActorMessage => ({
  id,
  toAddr: 'a',
  fromAddr: null,
  kind,
  correlationId,
  payload,
  consumed: false,
  retries: 0,
  dead: false,
  ts: 1,
})

describe('runResident', () => {
  it('drains queued messages onto one shared agent, marks each consumed, exits on idle', async () => {
    prompts.length = 0
    const consumed: string[] = []
    const mb = createMailbox()
    mb.deliver(m('m1', 'send', null, 'first'))
    mb.deliver(m('m2', 'send', null, 'second'))
    await runResident(
      deps(),
      mb,
      {
        acquireTurnSlot: async () => {},
        releaseTurnSlot: () => {},
        onConsumed: (id) => consumed.push(id),
        onReply: () => {},
      },
      20
    ) // tiny idle so the loop exits quickly after draining
    expect(prompts).toEqual(['first', 'second'])
    expect(consumed).toEqual(['m1', 'm2'])
  })

  it('routes an rpc message turn result via onReply(correlationId)', async () => {
    prompts.length = 0
    const replies: Array<[string, string]> = []
    const mb = createMailbox()
    mb.deliver(m('m1', 'rpc', 'corr-1', 'review'))
    await runResident(
      deps(),
      mb,
      {
        acquireTurnSlot: async () => {},
        releaseTurnSlot: () => {},
        onConsumed: () => {},
        onReply: (c, s) => replies.push([c, s]),
      },
      20
    )
    expect(replies[0][0]).toBe('corr-1')
    expect(replies[0][1]).toContain('ack:review')
  })
})
