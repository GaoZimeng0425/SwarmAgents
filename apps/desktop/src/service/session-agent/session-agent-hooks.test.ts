import { createLogger } from '@shared/logger'
import type { AgentWireEvent, PlanTodo, ResourceBudget } from '@swarm/protocol'
import Database from 'better-sqlite3'
import type { Logger } from 'pino'
import { beforeEach, describe, expect, it, vi } from 'vitest'

// Hook-capturing mock (same style as message-engine/engine.test.ts): swaps out
// only `Agent` so beforeToolCall/afterToolCall passed to its constructor can be
// invoked directly, without driving a real tool-call round trip through a fake
// LLM stream.
const MockAgent = vi.hoisted(() => vi.fn())
vi.mock('@earendil-works/pi-agent-core', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@earendil-works/pi-agent-core')>()
  return { ...actual, Agent: MockAgent }
})

import { createRunHooks } from './run-hooks'
import { SessionAgent, type SessionAgentDeps } from './session-agent'
import { createEntryStore, ensureEntriesSchema } from './sqlite-storage'

function silentLogger(): Logger {
  const log = createLogger({ process: 'test' })
  log.level = 'silent'
  return log
}

type BlockResult = { block?: boolean; reason?: string } | undefined
type Hook = (
  ctx: { toolCall: { name: string }; args?: unknown; result?: unknown },
  signal?: AbortSignal
) => Promise<BlockResult>

beforeEach(() => {
  MockAgent.mockReset()
})

/** Captures afterToolCall for direct invocation, and auto-completes the run (no tool calls during continue()). */
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

/**
 * Drives one simulated turn through the SessionAgent-wrapped beforeToolCall,
 * plus an `emitUsage` escape hatch to simulate a turn_end usage/cost report
 * (as the real pi Agent would emit) before the tool call — used to prove the
 * shared `used` object flows from usageSnapshot() into run-hooks.ts's budget
 * gate. Finishes with an 'aborted' assistant message iff any driven call was
 * blocked, mirroring what a real Agent does when a hook blocks it mid-turn.
 */
function installDrivenAgent(
  driveTurn: (ctx: { beforeToolCall: Hook; emitUsage: (costCents: number) => void }) => Promise<void>
): void {
  MockAgent.mockImplementation(function (this: Record<string, unknown>, opts: { beforeToolCall: Hook }) {
    let listener: (e: unknown) => void = () => undefined
    const state = { messages: [] as unknown[], model: undefined }
    this.subscribe = (fn: (e: unknown) => void) => {
      listener = fn
      return () => undefined
    }
    this.abort = vi.fn()
    this.continue = vi.fn(async () => {
      let blocked = false
      const wrappedBeforeToolCall: Hook = async (ctx, signal) => {
        const result = await opts.beforeToolCall(ctx, signal)
        if (result?.block) blocked = true
        return result
      }
      const emitUsage = (costCents: number) => {
        const usageMessage = {
          role: 'assistant',
          content: [],
          stopReason: 'stop',
          usage: {
            input: 1,
            output: 1,
            cacheRead: 0,
            cacheWrite: 0,
            totalTokens: 2,
            cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: costCents / 100 },
          },
        }
        listener({ type: 'turn_end', message: usageMessage, toolResults: [] })
      }
      await driveTurn({ beforeToolCall: wrappedBeforeToolCall, emitUsage })
      const assistantMsg = { role: 'assistant', content: [], stopReason: blocked ? 'aborted' : 'stop' }
      state.messages.push(assistantMsg)
      listener({ type: 'message_end', message: assistantMsg })
      listener({ type: 'agent_end', messages: [assistantMsg] })
    })
    this.state = state
  })
}

function makeEntries() {
  const db = new Database(':memory:')
  ensureEntriesSchema(db)
  return createEntryStore(db)
}

function makeDeps(over: Partial<SessionAgentDeps> = {}): SessionAgentDeps {
  return {
    sessionId: 's1',
    entries: makeEntries(),
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
  it('forwards afterToolCall to deps.hooks(...).afterToolCall', async () => {
    const { getAfterToolCall } = installAgent()
    const hookSpy = vi.fn(async () => undefined)
    const agent = new SessionAgent(makeDeps({ hooks: () => ({ afterToolCall: hookSpy }) }))

    agent.submitUserMessage('hi')
    await agent.waitForCompletion()

    const ctx = { toolCall: { name: 'update_plan' }, result: { details: { todos: [] } } }
    await getAfterToolCall()(ctx)

    expect(hookSpy).toHaveBeenCalledWith(ctx, undefined)
  })
})

describe('SessionAgent.appendPlanTodos', () => {
  it('persists a custom plan entry and broadcasts entry_appended', () => {
    const entries = makeEntries()
    const events: AgentWireEvent[] = []
    const agent = new SessionAgent(makeDeps({ entries, broadcast: (e) => events.push(e) }))

    const todos: PlanTodo[] = [{ content: 'step one', status: 'in_progress' }]
    agent.appendPlanTodos(todos)

    const rows = entries.list('s1')
    expect(rows).toHaveLength(1)
    expect(rows[0].entry).toMatchObject({ type: 'custom', customType: 'plan', data: { todos } })
    expect(events).toHaveLength(1)
    expect(events[0]).toMatchObject({ kind: 'entry_appended', sessionId: 's1' })
  })
})

describe('SessionAgent + createRunHooks integration (abortRun / shared used)', () => {
  it('a run-hooks calls-budget gate ends the run cancelled with the budget reason', async () => {
    installDrivenAgent(async ({ beforeToolCall }) => {
      await beforeToolCall({ toolCall: { name: 'x' }, args: {} })
      await beforeToolCall({ toolCall: { name: 'x' }, args: {} })
    })
    const budget: ResourceBudget = { calls: 1, wallMs: 60_000, usdCents: 100_000 }

    const agent: SessionAgent = new SessionAgent(
      makeDeps({
        hooks: (ctx) =>
          createRunHooks({
            sessionId: 's1',
            runId: ctx.runId,
            used: ctx.used,
            risk: () => 'low',
            permissionMode: () => 'ask',
            requestPermission: async () => 'grant',
            budget,
            broadcast: () => {},
            log: silentLogger(),
            signal: () => undefined,
            onPlanTodos: () => {},
            abortRun: (reason) => agent.abortRun(reason),
          }),
      })
    )

    agent.submitUserMessage('hi')
    const result = await agent.waitForCompletion()

    expect(result.status).toBe('cancelled')
    expect(result.summary).toBe('Budget exhausted (calls).')
  })

  it('a usdCents overrun recorded via usageSnapshot trips the shared budget on the next tool call', async () => {
    installDrivenAgent(async ({ beforeToolCall, emitUsage }) => {
      // 10 cents of reported turn cost, over the 5-cent budget below — this
      // goes through SessionAgent's real usageSnapshot(), which must write
      // onto the SAME `used` object run-hooks.ts's gate reads.
      emitUsage(10)
      await beforeToolCall({ toolCall: { name: 'x' }, args: {} })
    })
    const budget: ResourceBudget = { calls: 100, wallMs: 60_000, usdCents: 5 }

    const agent: SessionAgent = new SessionAgent(
      makeDeps({
        hooks: (ctx) =>
          createRunHooks({
            sessionId: 's1',
            runId: ctx.runId,
            used: ctx.used,
            risk: () => 'low',
            permissionMode: () => 'ask',
            requestPermission: async () => 'grant',
            budget,
            broadcast: () => {},
            log: silentLogger(),
            signal: () => undefined,
            onPlanTodos: () => {},
            abortRun: (reason) => agent.abortRun(reason),
          }),
      })
    )

    agent.submitUserMessage('hi')
    const result = await agent.waitForCompletion()

    expect(result.status).toBe('cancelled')
    expect(result.summary).toBe('Budget exhausted (usdCents).')
  })
})

describe('SessionAgent call counting (single point of truth)', () => {
  it('counts calls unconditionally even with no hooks wired, so turn_end usage reports calls>0', async () => {
    installDrivenAgent(async ({ beforeToolCall, emitUsage }) => {
      await beforeToolCall({ toolCall: { name: 'x' }, args: {} })
      // Triggers usageSnapshot()/turn_end so the current used.calls is on the wire.
      emitUsage(0)
    })

    const events: AgentWireEvent[] = []
    // Deliberately NO `hooks` dep — regressing this must not silently zero out
    // call counting (Task 3 guarantee).
    const agent = new SessionAgent(makeDeps({ broadcast: (e) => events.push(e) }))

    agent.submitUserMessage('hi')
    const result = await agent.waitForCompletion()

    expect(result.status).toBe('completed')
    const turnEnd = events.find((e) => e.kind === 'turn_end')
    expect(turnEnd).toBeDefined()
    if (turnEnd?.kind === 'turn_end') expect(turnEnd.used.calls).toBeGreaterThan(0)
  })
})
