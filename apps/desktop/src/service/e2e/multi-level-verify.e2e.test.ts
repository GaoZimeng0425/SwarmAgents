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
        return { status: 'completed', summary: 'CEO: shipped', messages: [], used: {} }
      }
      // Leader (team head): record a delegation plan, then spawn a leaf.
      // The Leader self-reports — no verify loop runs over the leaf.
      if (deps.agentDefinition.teamRole === 'head') {
        deps.emit('task.delegation_plan', {
          taskId: deps.correlationId,
          plan: [{ id: 'd1', goal: 'leaf work', dependsOn: [] }],
          ts: Date.now(),
        })
        await deps.spawnChild(deps.correlationId, 'leaf work', undefined, undefined, 'engineer')
        return { status: 'completed', summary: `${deps.agentDefinition.id}: delivered`, messages: [], used: {} }
      }
      // Leaf sub-agent: single-shot, returns its summary.
      return { status: 'completed', summary: 'leaf: done', messages: [], used: {} }
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

    // Tree shape: heads parented by the CEO, leaves parented by a head.
    for (const h of heads) {
      expect(store.getTask(h.taskId)?.parentId).toBe(taskId)
    }
    const headIds = heads.map((h) => h.taskId)
    for (const l of leaves) {
      const t = store.getTask(l.taskId)
      expect(t?.parentId).toBeDefined()
      expect(headIds).toContain(t!.parentId)
    }

    // Post-3b: the typed Task no longer carries acceptanceCriteria/verifications.
    // Assert their absence on every task in the tree (regression guard for the
    // protocol type cleanup in Task 5).
    const allTasks = [taskId, ...headIds, ...leaves.map((l) => l.taskId)].map((id) => store.getTask(id)!)
    for (const t of allTasks) {
      expect((t as { acceptanceCriteria?: unknown }).acceptanceCriteria).toBeUndefined()
      expect((t as { verifications?: unknown }).verifications).toBeUndefined()
      // Single-shot — every task reaches a terminal status, no verify stall.
      expect(['completed', 'failed']).toContain(t.status)
    }

    // Leaders that declared a delegation plan persist it for audit + UI.
    for (const h of heads) {
      expect(store.getTask(h.taskId)?.delegationPlan ?? []).toHaveLength(1)
    }

    store.close()
  })
})
