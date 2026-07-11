// src/service/e2e/agent-driven-verify.e2e.test.ts
//
// Focused regression: a single agent-authored work run runs single-shot and
// reaches a terminal event on the run stream. There is no verification audit
// and no acceptance-criteria contract — every run is single-shot post-3b.
//
// Companion to multi-level-verify.e2e.test.ts (the delegation tree). This file
// isolates the simplest path: one work run, no spawns, no CEOs. Post-switchover
// it drives the REAL SessionService + launch + engine, pi Agent mocked.

import type { ProviderInjection } from '@swarm/protocol'
import { describe, expect, it, vi } from 'vitest'

const MockAgent = vi.hoisted(() => vi.fn())
vi.mock('@earendil-works/pi-agent-core', () => ({ Agent: MockAgent }))

import { createConversationStore } from '../conversation/store'
import { createSessionService } from '../session/session-service'

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
    this.prompt = async (prompt: string): Promise<void> => {
      ;(this.state as { messages: unknown[] }).messages.push({ role: 'user', content: prompt })
      const ok = { role: 'assistant', content: [{ type: 'text', text: reply }], stopReason: 'end_turn' }
      ;(this.state as { messages: unknown[] }).messages.push(ok)
      sub?.({ type: 'turn_end', message: { usage: undefined } })
      sub?.({ type: 'agent_end', messages: [ok] })
    }
  })
}

const fakeProvider = { id: 'p', model: 'test', apiStyle: 'anthropic', apiKey: 'k' } as unknown as ProviderInjection

describe('agent-driven verify — single-shot work run', () => {
  it('a work run runs single-shot with no verify rounds and no criteria contract', async () => {
    installAgent()
    const store = createConversationStore(':memory:')
    const service = createSessionService({
      store,
      broadcaster: { broadcast: () => {} },
      maxConcurrent: 4,
      getProvider: () => fakeProvider,
    })
    const { sessionId } = service.createSession(fakeProvider)

    const work = await service.runWork(sessionId, 'build it')
    expect(work.status).toBe('completed')

    // No Task row for a work run — assert against the run stream.
    const events = store.getRunEvents(sessionId).filter((r) => r.runId === work.runId)
    const isTerminal = (r: { event: { kind?: string } }): boolean =>
      r.event.kind === 'run.complete' || r.event.kind === 'run.error'
    expect(events.some(isTerminal)).toBe(true)
    // No verification event on the stream (single-shot).
    expect(events.some((r) => (r.event as { event?: { kind?: string } }).event?.kind === 'verification')).toBe(false)

    store.close()
  })
})
