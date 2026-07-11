// src/service/e2e/conversation-off-task.e2e.test.ts
//
// End-to-end guard: a trivial conversation message runs single-shot and its
// user + assistant messages land on the session run-event stream as run.progress
// llm.message events (no verification). Real work is agent-authored via
// runWork, which is also a Task-less run on the same stream. Post-switchover this
// drives the REAL SessionService + launch + engine, pi Agent mocked.

import type { ProviderInjection } from '@swarm/protocol'
import { describe, expect, it, vi } from 'vitest'

const MockAgent = vi.hoisted(() => vi.fn())
vi.mock('@earendil-works/pi-agent-core', () => ({ Agent: MockAgent }))

import { createConversationStore } from '../conversation/store'
import { createSessionService } from '../session/session-service'

function installAgent(reply = 'hi there'): void {
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
    this.prompt = async (prompt: string): Promise<void> => {
      ;(this.state as { messages: unknown[] }).messages.push({ role: 'user', content: prompt })
      const ok = { role: 'assistant', content: [{ type: 'text', text: reply }], stopReason: 'end_turn' }
      ;(this.state as { messages: unknown[] }).messages.push(ok)
      // A flushed assistant delta → run.progress llm.message role assistant.
      sub?.({ type: 'message_update', assistantMessageEvent: { type: 'text_delta', delta: reply } })
      sub?.({ type: 'turn_end', message: { usage: undefined } })
      sub?.({ type: 'agent_end', messages: [ok] })
    }
  })
}

const fakeProvider = { id: 'p', model: 'test', apiStyle: 'anthropic', apiKey: 'k' } as unknown as ProviderInjection
const flush = (): Promise<void> => new Promise((r) => setTimeout(r, 30))

const isProgressRole = (r: { event: { kind?: string } }, role: string): boolean =>
  (r.event as { kind?: string }).kind === 'message.progress' &&
  (r.event as { event?: { kind?: string; role?: string } }).event?.kind === 'llm.message' &&
  (r.event as { event?: { role?: string } }).event?.role === role

describe('conversation off task', () => {
  it('a trivial message runs single-shot; runWork makes a work run — both on the run stream', async () => {
    installAgent()
    const store = createConversationStore(':memory:')
    const service = createSessionService({
      store,
      broadcaster: { broadcast: () => {} },
      maxConcurrent: 4,
      getProvider: () => fakeProvider,
    })
    const { sessionId } = service.createSession(fakeProvider)

    const { messageId: turnId } = service.submitPrompt(sessionId, '你好')
    await flush()

    // The run stream carries the user + assistant messages, no verification.
    const rows = store.getMessageEvents(sessionId)
    expect(rows.some((r) => isProgressRole(r, 'user'))).toBe(true)
    expect(rows.some((r) => isProgressRole(r, 'assistant'))).toBe(true)
    expect(rows.some((r) => (r.event as { event?: { kind?: string } }).event?.kind === 'verification')).toBe(false)
    // The returned id is the conversation run id (a ULID), not a Task id.
    expect(turnId).toMatch(/^[0-9A-Z]{26}$/)

    // Agent-authored work via runWork is a top-level run on the run-event stream.
    const work = await service.runWork(sessionId, 'build it')
    expect(store.getMessageEvents(sessionId).some((r) => r.messageId === work.messageId)).toBe(true)

    store.close()
  })
})
