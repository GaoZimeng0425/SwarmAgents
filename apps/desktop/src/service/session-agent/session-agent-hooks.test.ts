import { createLogger } from '@shared/logger'
import type { AgentWireEvent, PlanTodo } from '@swarm/protocol'
import Database from 'better-sqlite3'
import type { Logger } from 'pino'
import { describe, expect, it, vi } from 'vitest'

// Hook-capturing mock (same style as message-engine/engine.test.ts): swaps out
// only `Agent` so beforeToolCall/afterToolCall passed to its constructor can be
// invoked directly, without driving a real tool-call round trip through a fake
// LLM stream.
const MockAgent = vi.hoisted(() => vi.fn())
vi.mock('@earendil-works/pi-agent-core', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@earendil-works/pi-agent-core')>()
  return { ...actual, Agent: MockAgent }
})

import { SessionAgent, type SessionAgentDeps } from './session-agent'
import { createEntryStore, ensureEntriesSchema } from './sqlite-storage'

function silentLogger(): Logger {
  const log = createLogger({ process: 'test' })
  log.level = 'silent'
  return log
}

type Hook = (ctx: { toolCall: { name: string }; args?: unknown; result?: unknown }, signal?: AbortSignal) => Promise<unknown>

function installAgent(): { getAfterToolCall: () => Hook } {
  let afterToolCall: Hook = async () => undefined
  MockAgent.mockImplementation(function (this: Record<string, unknown>, opts: { afterToolCall: Hook }) {
    afterToolCall = opts.afterToolCall
    let listener: (e: unknown) => void = () => undefined
    const state = { messages: [] as unknown[], model: undefined }
    this.subscribe = (fn: (e: unknown) => void) => {
      listener = fn
      return () => undefined
    }
    this.abort = vi.fn()
    // Emits message_end + agent_end so SessionAgent persists the assistant
    // reply into `entries` — without this, hasUnansweredUserTail() never
    // sees an answer and runLoop spins forever (state.messages alone isn't
    // enough: SessionAgent's completion check reads the entry log).
    this.continue = vi.fn(async () => {
      const assistantMsg = { role: 'assistant', content: [{ type: 'text', text: 'ok' }], stopReason: 'stop' }
      state.messages.push(assistantMsg)
      listener({ type: 'message_end', message: assistantMsg })
      listener({ type: 'agent_end', messages: [assistantMsg] })
    })
    this.state = state
  })
  return { getAfterToolCall: () => afterToolCall }
}

function makeDeps(over: Partial<SessionAgentDeps> = {}): SessionAgentDeps {
  const db = new Database(':memory:')
  ensureEntriesSchema(db)
  return {
    sessionId: 's1',
    entries: createEntryStore(db),
    broadcast: () => {},
    acquireSlot: async () => () => {},
    buildAgentConfig: () => ({
      systemPrompt: 'test',
      model: {} as never,
      thinkingLevel: 'off',
      tools: [],
      maxTurns: 5,
    }),
    log: silentLogger(),
    ...over,
  }
}

describe('SessionAgent hook forwarding', () => {
  it('forwards afterToolCall to deps.hooks.afterToolCall', async () => {
    const { getAfterToolCall } = installAgent()
    const hookSpy = vi.fn(async () => undefined)
    const agent = new SessionAgent(makeDeps({ hooks: { afterToolCall: hookSpy } }))

    agent.submitUserMessage('hi')
    await agent.waitForCompletion()

    const ctx = { toolCall: { name: 'update_plan' }, result: { details: { todos: [] } } }
    await getAfterToolCall()(ctx)

    expect(hookSpy).toHaveBeenCalledWith(ctx, undefined)
  })
})

describe('SessionAgent.appendPlanTodos', () => {
  it('persists a custom plan entry and broadcasts entry_appended', () => {
    const db = new Database(':memory:')
    ensureEntriesSchema(db)
    const entries = createEntryStore(db)
    const events: AgentWireEvent[] = []
    const agent = new SessionAgent(
      makeDeps({
        entries,
        broadcast: (e) => events.push(e),
      })
    )

    const todos: PlanTodo[] = [{ content: 'step one', status: 'in_progress' }]
    agent.appendPlanTodos(todos)

    const rows = entries.list('s1')
    expect(rows).toHaveLength(1)
    expect(rows[0].entry).toMatchObject({ type: 'custom', customType: 'plan', data: { todos } })
    expect(events).toHaveLength(1)
    expect(events[0]).toMatchObject({ kind: 'entry_appended', sessionId: 's1' })
  })
})
