import { describe, expect, it, vi } from 'vitest'

const prompts: string[] = []
// Module-scope flag: flip to true to make shouldCompact() return true in a test.
const hoisted = vi.hoisted(() => ({ compactWhen: false }))
// Module-scope array: collects every Agent instance created in the mock constructor.
const instances: Array<{ compact: ReturnType<typeof vi.fn> }> = []

vi.mock('@earendil-works/pi-agent-core', () => {
  class Agent {
    state = { messages: [] as Array<{ role: string; content: string }> }
    compact = vi.fn(async function (this: Agent) {
      // Mutate messages in-place to simulate compaction shrinking the context window.
      this.state.messages = [{ role: 'system', content: 'COMPACTED_SUMMARY' }]
      return { summary: 's', firstKeptEntryId: 'x', tokensBefore: 1 }
    })
    private sub: ((e: unknown) => void) | null = null
    constructor(_c: unknown) {
      instances.push(this as unknown as { compact: ReturnType<typeof vi.fn> })
    }
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
  return {
    Agent,
    shouldCompact: (..._args: unknown[]) => hoisted.compactWhen,
    DEFAULT_COMPACTION_SETTINGS: {},
  }
})

import type { ActorMessage } from '@swarm/protocol'

import { createMailbox } from '../actor/mailbox'
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
    hoisted.compactWhen = false
    instances.length = 0
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
        onError: () => {},
      },
      20
    ) // tiny idle so the loop exits quickly after draining
    expect(prompts).toEqual(['first', 'second'])
    expect(consumed).toEqual(['m1', 'm2'])
  })

  it('routes an rpc message turn result via onReply(correlationId)', async () => {
    prompts.length = 0
    hoisted.compactWhen = false
    instances.length = 0
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
        onError: () => {},
      },
      20
    )
    expect(replies[0][0]).toBe('corr-1')
    expect(replies[0][1]).toContain('ack:review')
  })

  it('persists encoded actor state via onConsumed each turn', async () => {
    prompts.length = 0
    hoisted.compactWhen = false
    instances.length = 0
    const consumed: Array<{ id: string; state: string }> = []
    const mb = createMailbox()
    mb.deliver(m('m1', 'send', null, 'hello'))
    await runResident(
      deps(),
      mb,
      {
        acquireTurnSlot: async () => {},
        releaseTurnSlot: () => {},
        onConsumed: (id, state) => consumed.push({ id, state }),
        onReply: () => {},
        onError: () => {},
      },
      20
    )
    expect(consumed).toHaveLength(1)
    expect(consumed[0].id).toBe('m1')
    // State is the versioned blob carrying the stub agent's accumulated messages.
    expect(JSON.parse(consumed[0].state)).toMatchObject({ v: 1 })
    expect(JSON.parse(consumed[0].state).messages.length).toBeGreaterThan(0)
  })

  it('compacts before persisting when context exceeds threshold', async () => {
    prompts.length = 0
    hoisted.compactWhen = true
    instances.length = 0
    const mb = createMailbox()
    mb.deliver(m('m1', 'send', null, 'x'))
    await runResident(
      deps(),
      mb,
      {
        acquireTurnSlot: async () => {},
        releaseTurnSlot: () => {},
        onConsumed: () => {},
        onReply: () => {},
        onError: () => {},
      },
      20
    )
    // The mock Agent instance was constructed inside runResident via buildAgentSession.
    // Assert compact() was called exactly once on that instance.
    expect(instances.at(-1)?.compact).toHaveBeenCalledTimes(1)
  })

  it('persists post-compaction state: serialization happens AFTER compact() mutates messages', async () => {
    prompts.length = 0
    hoisted.compactWhen = true
    instances.length = 0
    const captured: string[] = []
    const mb = createMailbox()
    mb.deliver(m('m1', 'send', null, 'x'))
    await runResident(
      deps(),
      mb,
      {
        acquireTurnSlot: async () => {},
        releaseTurnSlot: () => {},
        onConsumed: (_id, state) => captured.push(state),
        onReply: () => {},
        onError: () => {},
      },
      20
    )
    expect(captured).toHaveLength(1)
    // The persisted state must reflect what compact() left in state.messages,
    // not the pre-compaction accumulated messages.
    const decoded = JSON.parse(captured[0])
    expect(decoded.messages).toEqual([{ role: 'system', content: 'COMPACTED_SUMMARY' }])
  })
})
