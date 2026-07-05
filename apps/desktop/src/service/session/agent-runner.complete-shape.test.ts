import { describe, expect, it, vi } from 'vitest'

// Self-contained pi mock (same pattern as agent-runner.retry.test.ts): prompt()
// streams a text delta then ends the run, so the translator's agent_end path —
// the only production task.complete emitter — is exercised for real.
vi.mock('@earendil-works/pi-agent-core', () => {
  class Agent {
    state = { messages: [] as Array<Record<string, unknown>> }
    private sub: ((e: unknown) => void) | null = null
    constructor(_c: unknown) {}
    subscribe(fn: (e: unknown) => void) {
      this.sub = fn
    }
    abort() {}
    async prompt(goal: string) {
      this.state.messages.push({ role: 'user', content: goal })
      const ok = { role: 'assistant', content: [{ type: 'text', text: 'done' }], stopReason: 'end_turn' }
      this.state.messages.push(ok)
      this.sub?.({ type: 'message_update', assistantMessageEvent: { type: 'text_delta', delta: 'done.' } })
      this.sub?.({ type: 'turn_end', message: ok, toolResults: [] })
      this.sub?.({ type: 'agent_end', messages: [ok] })
    }
  }
  return { Agent, shouldCompact: () => false, DEFAULT_COMPACTION_SETTINGS: {} }
})

import { applyEvent } from '@shared/lib/apply-event'
import type { UIEvent } from '@swarm/protocol'

import type { AgentRunnerDeps } from './agent-runner'
import { createAgentRunner } from './agent-runner'

const deps = (emit: (event: string, data: unknown) => void): AgentRunnerDeps =>
  ({
    correlationId: 'r-shape',
    attachments: [],
    budget: { calls: 100, wallMs: 60000, usdCents: 1000, tokens: 1e9 },
    permissionMode: 'full',
    provider: { model: 'test', apiStyle: 'anthropic', apiKey: 'k' } as never,
    agentDefinition: { id: 'default', systemPrompt: 'sys', toolScope: 'all', maxIterations: 25 } as never,
    sessionId: 'ses-shape',
    emit,
    permissionRegistry: { request: async () => 'grant', resolve: () => {} } as never,
    toolRegistry: { resolve: () => ({ tools: [], riskOf: () => 'low' }) } as never,
    initialMessages: [{ role: 'user', content: 'do it' }] as never,
    spawnChild: async () => ({ childTaskId: 'c', result: { summary: '', artifacts: [] } }),
  }) as AgentRunnerDeps

describe('task.complete wire shape', () => {
  it('emits a flat summary that the real renderer reducer stores on the RunRecord', async () => {
    const emitted: Array<{ event: string; data: Record<string, unknown> }> = []
    const runner = createAgentRunner(
      deps((event, data) => emitted.push({ event, data: data as Record<string, unknown> }))
    )
    await runner.run()

    const complete = emitted.find((e) => e.event === 'task.complete')
    expect(complete).toBeDefined()
    // Flat shape per protocol ui.ts — no nested result.*.
    expect(complete!.data.summary).toBe('done.')
    expect('result' in complete!.data).toBe(false)

    // Round-trip the REAL emitted payload through the REAL reducer: this is the
    // cross-layer drift the old fabricated-shape tests missed.
    // The reducer now keys on run.* (the runner's task.* emit is bridged to run.*
    // in Task 3); round-trip the emitted summary through a run.* wire so this
    // stays a real cross-layer reducer check.
    const created: UIEvent = {
      kind: 'run.created',
      sessionId: 'ses-shape',
      runId: 'r-shape',
      goal: 'do it',
      ts: 1,
      seq: 1,
    }
    const wire: UIEvent = {
      kind: 'run.complete',
      sessionId: 'ses-shape',
      runId: 'r-shape',
      summary: complete!.data.summary as string,
      ts: 2,
      seq: 2,
    }
    const rows = applyEvent(applyEvent([], created), wire)
    expect(rows[0].status).toBe('completed')
    expect(rows[0].summary).toBe('done.')
  })
})
