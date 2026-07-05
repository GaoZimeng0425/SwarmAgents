// src/service/e2e/unified-runs.e2e.test.ts
//
// End-to-end guard: a conversation turn AND an agent-authored work run both
// write their full run.* lifecycle to run_events (the renderer's only replay
// source), so each reaches a terminal event on replay. Neither leaves a Task
// row — both live entirely in run_events. Post-switchover this drives the REAL
// SessionService + launch + engine over a real store, with only the pi Agent
// mocked to auto-complete.

import type { ProviderInjection } from '@swarm/protocol'
import { describe, expect, it, vi } from 'vitest'

const MockAgent = vi.hoisted(() => vi.fn())
vi.mock('@earendil-works/pi-agent-core', () => ({ Agent: MockAgent }))

import { createConversationStore } from '../conversation/store'
import { createSessionService } from '../session/session-service'

// Minimal auto-completing pi Agent: appends the user turn, emits a turn_end +
// agent_end so the engine reaches its single run.complete terminal.
function installAgent(reply = 'done'): void {
  MockAgent.mockImplementation(function (
    this: Record<string, unknown>,
    opts: { initialState?: { messages?: unknown[] } }
  ) {
    let sub: ((e: unknown) => void) | null = null
    this.state = { messages: [...((opts.initialState?.messages as unknown[]) ?? [])] }
    this.subscribe = (fn: (e: unknown) => void): void => {
      sub = fn
    }
    this.abort = (): void => undefined
    this.prompt = async (goal: string): Promise<void> => {
      ;(this.state as { messages: unknown[] }).messages.push({ role: 'user', content: goal })
      const ok = { role: 'assistant', content: [{ type: 'text', text: reply }], stopReason: 'end_turn' }
      ;(this.state as { messages: unknown[] }).messages.push(ok)
      sub?.({ type: 'message_update', assistantMessageEvent: { type: 'text_delta', delta: reply } })
      sub?.({ type: 'turn_end', message: { usage: undefined } })
      sub?.({ type: 'agent_end', messages: [ok] })
    }
  })
}

const fakeProvider = { id: 'p', model: 'test', apiStyle: 'anthropic', apiKey: 'k' } as unknown as ProviderInjection
const flush = (): Promise<void> => new Promise((r) => setTimeout(r, 30))

describe('unified runs', () => {
  it('a work run + conversation turn both reach a terminal event in run_events', async () => {
    installAgent()
    const store = createConversationStore(':memory:')
    const service = createSessionService({
      store,
      broadcaster: { broadcast: () => {} },
      maxConcurrent: 4,
      getProvider: () => fakeProvider,
    })
    const { sessionId } = service.createSession(fakeProvider)

    // Conversation turn.
    const turn = service.submitPrompt(sessionId, '你好')
    await flush()

    // Agent-authored top-level work run.
    const work = await service.runWork(sessionId, 'build it')
    await flush()

    const rows = store.getRunEvents(sessionId)
    const isTerminal = (r: { event: { kind?: string } }): boolean =>
      r.event.kind === 'run.complete' || r.event.kind === 'run.error'
    // Both runs reached a terminal event in run_events.
    expect(rows.filter((r) => r.runId === work.runId).some(isTerminal)).toBe(true) // work
    expect(rows.filter((r) => r.runId === turn.runId).some(isTerminal)).toBe(true) // conversation

    store.close()
  })
})
