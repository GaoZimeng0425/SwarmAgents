// src/service/e2e/multi-level-verify.e2e.test.ts
//
// Phase 3b regression: drives the REAL manager task tree (runWorkTask →
// spawnChild) with a scripted createAgentRunner mock that exercises the
// three-level delegation chain (CEO → team Leaders → leaf engineers).
//
// Post-3b every level runs single-shot: there is no `maxVerifyRounds` field
// on the runner deps, no `acceptanceCriteria` is threaded into spawnChild,
// and no verification audit is persisted on tasks. The DB columns
// `verifications`/`acceptance_criteria` are KEPT (rollback safety) but stay
// at their default `'[]'`, and the typed `Task` no longer surfaces them.
//
// This file was deleted in Task 1 (it asserted the removed `maxVerifyRounds`
// threading) and is recreated here for the agent-driven model.

import { defaultAgents } from '@swarm/shared'
import { describe, expect, it, vi } from 'vitest'

import { createConversationStore } from '../conversation/store'
import { createSessionManager } from '../session/manager'

type RunRecord = {
  taskId: string
  agent: string
  isHead: boolean
  // Post-3b: maxVerifyRounds is gone from deps. Recorded to prove the field
  // is not threaded into any level of the tree (every entry is undefined).
  maxVerifyRounds: unknown
}

const runs = vi.hoisted(() => [] as RunRecord[])

vi.mock('../session/agent-runner', () => ({
  createAgentRunner: (deps: any) => ({
    run: async () => {
      runs.push({
        taskId: deps.correlationId,
        agent: deps.agentDefinition.id,
        isHead: deps.agentDefinition.teamRole === 'head',
        maxVerifyRounds: deps.maxVerifyRounds,
      })
      // CEO: spawn two Leaders in parallel. Post-3b spawnChild takes only
      // (parentTaskId, goal, suggestedTools?, providerKey?, agentType?) —
      // no options struct, no criteria/verify threading.
      if (deps.agentDefinition.id === 'ceo') {
        await Promise.all([
          deps.spawnChild(deps.correlationId, 'lead dev', undefined, undefined, 'engineering-lead'),
          deps.spawnChild(deps.correlationId, 'lead qa', undefined, undefined, 'qa-lead'),
        ])
      } else if (deps.agentDefinition.teamRole === 'head') {
        // Leader (team head): record a delegation plan, then spawn a leaf.
        // The Leader self-reports — no verify loop runs over the leaf.
        deps.emit('task.delegation_plan', {
          taskId: deps.correlationId,
          plan: [{ id: 'd1', goal: 'leaf work', dependsOn: [] }],
          ts: Date.now(),
        })
        await deps.spawnChild(deps.correlationId, 'leaf work', undefined, undefined, 'engineer')
      }
      // Post-4b the translator emits task.complete (→ run_events); the mock
      // stands in for it so every run reaches a terminal event.
      deps.emit('task.complete', {
        taskId: deps.correlationId,
        result: { summary: `${deps.agentDefinition.id}: done`, artifacts: [] },
        ts: Date.now(),
      })
      return {
        status: 'completed',
        summary: `${deps.agentDefinition.id}: delivered`,
        messages: [],
        used: {},
      }
    },
  }),
  buildAgentSession: () => ({}),
  runResident: async () => {},
}))

const fakeProvider = { model: 'test', apiStyle: 'anthropic' } as never
const roleStore = { get: (id: string) => defaultAgents.find((a) => a.id === id), list: () => defaultAgents }

function makeMgr() {
  const store = createConversationStore(':memory:')
  const mgr = createSessionManager({
    store,
    broadcaster: { broadcast: () => {} },
    maxConcurrent: 8,
    getProvider: () => fakeProvider,
    agentStore: roleStore as never,
  })
  return { store, mgr }
}

const flush = (): Promise<void> => new Promise((r) => setTimeout(r, 30))

describe('CEO → Leader → subagent pipeline (single-shot, agent-driven)', () => {
  it('runs three levels single-shot; no maxVerifyRounds, no criteria/verifications on tasks', async () => {
    runs.length = 0
    const { store, mgr } = makeMgr()
    const { sessionId } = mgr.createSession(fakeProvider)

    const { taskId } = await (
      mgr as unknown as {
        __runWorkTaskForTest: (
          s: string,
          g: string,
          options?: { agentType?: string }
        ) => Promise<{ taskId: string; result: unknown }>
      }
    ).__runWorkTaskForTest(sessionId, 'ship it', { agentType: 'ceo' })
    // Let any tail child persistence settle.
    await flush()

    const ceo = runs.find((r) => r.agent === 'ceo')
    const heads = runs.filter((r) => r.isHead)
    const leaves = runs.filter((r) => r.agent === 'engineer')

    // All three levels ran: 1 CEO, 2 Leaders (engineering-lead + qa-lead), 2 leaves.
    expect(ceo).toBeDefined()
    expect(heads).toHaveLength(2)
    expect(leaves).toHaveLength(2)

    // Post-3b: maxVerifyRounds is gone from deps at every level — single-shot
    // for CEO, Leaders, and leaves alike.
    for (const r of runs) expect(r.maxVerifyRounds).toBeUndefined()

    // Post-4b: no Task rows — the tree shape lives in run_events.parentRunId.
    const allEvents = store.getRunEvents(sessionId)
    const parentOf = (runId: string): string | null => allEvents.find((r) => r.runId === runId)?.parentRunId ?? null
    const isTerminal = (runId: string): boolean =>
      allEvents.some(
        (r) =>
          r.runId === runId &&
          ((r.event as { kind?: string }).kind === 'task.complete' ||
            (r.event as { kind?: string }).kind === 'task.error')
      )

    // Tree shape: heads parented by the CEO, leaves parented by a head.
    const headIds = heads.map((h) => h.taskId)
    for (const h of heads) expect(parentOf(h.taskId)).toBe(taskId)
    for (const l of leaves) expect(headIds).toContain(parentOf(l.taskId))

    // Single-shot — every run reaches a terminal event, no verify stall.
    for (const r of runs) expect(isTerminal(r.taskId)).toBe(true)

    // Leaders that declared a delegation plan emit it on the run stream.
    for (const h of heads) {
      const planEvt = allEvents.find(
        (r) => r.runId === h.taskId && (r.event as { kind?: string }).kind === 'task.delegation_plan'
      )
      expect((planEvt?.event as { plan?: unknown[] } | undefined)?.plan ?? []).toHaveLength(1)
    }

    store.close()
  })
})
