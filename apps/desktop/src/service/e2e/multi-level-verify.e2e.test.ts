// src/service/e2e/multi-level-verify.e2e.test.ts
//
// End-to-end guard for the three-level delegation machinery (CEO → team Leaders
// → leaf engineers) over the REAL SessionService + launch + engine and a real
// store. Every level runs single-shot: no maxVerifyRounds, no acceptance
// criteria, no verification audit. The tree shape lives in run_events.parentRunId.
//
// The delegation is driven from the test through each run's captured
// ToolRunContext (ctx.spawnChild / ctx.setDelegationPlan) — the same seam the
// create_task/delegation tools use in production — because the mocked pi Agent
// auto-completes and cannot itself decide to spawn.

import type { ProviderInjection } from '@swarm/protocol'
import { defaultAgents } from '@swarm/shared'
import { describe, expect, it, vi } from 'vitest'

const MockAgent = vi.hoisted(() => vi.fn())
vi.mock('@earendil-works/pi-agent-core', () => ({ Agent: MockAgent }))

import { createConversationStore } from '../conversation/store'
import { createSessionService } from '../session/session-service'
import type { ToolRegistry, ToolRunContext } from '../tools/registry'

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
      sub?.({ type: 'turn_end', message: { usage: undefined } })
      sub?.({ type: 'agent_end', messages: [ok] })
    }
  })
}

// Stub registry that records every ToolRunContext (one per run launched).
function stubRegistry(): { registry: ToolRegistry; ctxs: ToolRunContext[] } {
  const ctxs: ToolRunContext[] = []
  const registry = {
    resolve: (_allow: string[], ctx: ToolRunContext) => {
      ctxs.push(ctx)
      return { tools: [], riskOf: () => 'low' as const }
    },
  } as unknown as ToolRegistry
  return { registry, ctxs }
}

const fakeProvider = { id: 'p', model: 'test', apiStyle: 'anthropic', apiKey: 'k' } as unknown as ProviderInjection
const roleStore = { get: (id: string) => defaultAgents.find((a) => a.id === id), list: () => defaultAgents }
const flush = (): Promise<void> => new Promise((r) => setTimeout(r, 30))

describe('CEO → Leader → subagent pipeline (single-shot, agent-driven)', () => {
  it('runs three levels single-shot; tree shape + terminals live in run_events', async () => {
    installAgent()
    const store = createConversationStore(':memory:')
    const { registry, ctxs } = stubRegistry()
    const service = createSessionService({
      store,
      broadcaster: { broadcast: () => {} },
      maxConcurrent: 8,
      getProvider: () => fakeProvider,
      agentStore: roleStore as never,
      toolRegistry: registry,
    })
    const { sessionId } = service.createSession(fakeProvider)

    // Level 1: CEO. runWork returns { runId, status, summary }; a spawned child
    // returns { childTaskId, status, result } (the tool-facing shape).
    const ceo = await service.runWork(sessionId, 'ship it', { agentType: 'ceo' })
    const ceoCtx = ctxs[0]

    // Level 2: two Leaders under the CEO. Each records a delegation plan and
    // then spawns one leaf engineer (level 3).
    const leadA = await ceoCtx.spawnChild('lead dev', undefined, undefined, 'engineering-lead')
    const leadACtx = ctxs[ctxs.length - 1]
    leadACtx.setDelegationPlan!([{ id: 'd1', goal: 'leaf work', dependsOn: [] }])
    const leafA = await leadACtx.spawnChild('leaf work', undefined, undefined, 'engineer')

    const leadB = await ceoCtx.spawnChild('lead qa', undefined, undefined, 'qa-lead')
    const leadBCtx = ctxs[ctxs.length - 1]
    leadBCtx.setDelegationPlan!([{ id: 'd2', goal: 'leaf work', dependsOn: [] }])
    const leafB = await leadBCtx.spawnChild('leaf work', undefined, undefined, 'engineer')
    await flush()

    // Every run completed.
    expect(ceo.status).toBe('completed')
    for (const r of [leadA, leadB, leafA, leafB]) expect(r.status).toBe('completed')

    const allEvents = store.getRunEvents(sessionId)
    const parentOf = (runId: string): string | null => allEvents.find((r) => r.runId === runId)?.parentRunId ?? null
    const isTerminal = (runId: string): boolean =>
      allEvents.some(
        (r) =>
          r.runId === runId &&
          ((r.event as { kind?: string }).kind === 'run.complete' ||
            (r.event as { kind?: string }).kind === 'run.error')
      )

    // Tree shape: Leaders parented by the CEO, leaves parented by their Leader.
    expect(parentOf(leadA.childTaskId)).toBe(ceo.runId)
    expect(parentOf(leadB.childTaskId)).toBe(ceo.runId)
    expect(parentOf(leafA.childTaskId)).toBe(leadA.childTaskId)
    expect(parentOf(leafB.childTaskId)).toBe(leadB.childTaskId)

    // Single-shot — every run reaches a terminal event, no verify stall.
    for (const id of [ceo.runId, leadA.childTaskId, leadB.childTaskId, leafA.childTaskId, leafB.childTaskId])
      expect(isTerminal(id)).toBe(true)

    // Leaders that declared a delegation plan emit it on the run stream.
    for (const lead of [leadA, leadB]) {
      const planEvt = allEvents.find(
        (r) => r.runId === lead.childTaskId && (r.event as { kind?: string }).kind === 'run.delegation_plan'
      )
      expect((planEvt?.event as { plan?: unknown[] } | undefined)?.plan ?? []).toHaveLength(1)
    }

    store.close()
  })
})
