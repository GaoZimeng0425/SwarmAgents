// src/service/e2e/multi-level-verify.e2e.test.ts
//
// Drives the REAL manager task tree (submitGoal → spawnChild) with a scripted
// createAgentRunner mock that calls deps.spawnChild / deps.emit directly. This
// exercises the integration the unit tests can't: that spawnChild threads
// acceptanceCriteria + maxVerifyRounds onto real child tasks, that Leaders
// (verify on) and leaves (single-shot) coexist in one tree, and that the
// task.criteria / task.delegation_plan events persist. The verify-loop logic
// itself is unit-tested in agent-runner.verify.test.ts; here it is simulated.

import { defaultAgents } from '@swarm/shared'
import { describe, expect, it, vi } from 'vitest'

import { createConversationStore } from '../conversation/store'
import { createSessionManager } from '../session/manager'

type RunRecord = {
  taskId: string
  agent: string
  isHead: boolean
  maxVerifyRounds: number
  criteria: number
  parent: string | null
}

const runs = vi.hoisted(() => [] as RunRecord[])

vi.mock('../session/agent-runner', () => ({
  createAgentRunner: (deps: any) => ({
    run: async () => {
      runs.push({
        taskId: deps.task.id,
        agent: deps.agentDefinition.id,
        isHead: deps.agentDefinition.teamRole === 'head',
        maxVerifyRounds: deps.maxVerifyRounds ?? 0,
        criteria: (deps.task.acceptanceCriteria ?? []).length,
        parent: deps.task.parentId ?? null,
      })
      // CEO: derive top-level criteria, then spawn two Leaders in parallel with
      // verify on + their sliced criteria.
      if (deps.agentDefinition.id === 'ceo') {
        deps.emit('task.criteria', {
          taskId: deps.task.id,
          criteria: [{ id: 'c1', description: 'goal shipped across teams' }],
          ts: Date.now(),
        })
        await Promise.all([
          deps.spawnChild(deps.task.id, 'lead dev', undefined, undefined, 'engineering-lead', {
            acceptanceCriteria: [{ id: 'c1', description: 'dev deliverable done' }],
            maxVerifyRounds: 3,
          }),
          deps.spawnChild(deps.task.id, 'lead qa', undefined, undefined, 'qa-lead', {
            acceptanceCriteria: [{ id: 'c1', description: 'qa sign-off' }],
            maxVerifyRounds: 3,
          }),
        ])
        return { status: 'completed', summary: 'CEO: shipped', messages: [], used: {} }
      }
      // Leader (team head): record a delegation plan, then spawn a leaf
      // sub-agent WITHOUT maxVerifyRounds (single-shot — the Leader verifies).
      if (deps.agentDefinition.teamRole === 'head') {
        deps.emit('task.delegation_plan', {
          taskId: deps.task.id,
          plan: [{ id: 'd1', goal: 'leaf work', dependsOn: [] }],
          ts: Date.now(),
        })
        await deps.spawnChild(deps.task.id, 'leaf work', undefined, undefined, 'engineer', {
          acceptanceCriteria: [{ id: 'c1', description: 'leaf done' }],
        })
        return { status: 'completed', summary: 'team: done', messages: [], used: {} }
      }
      // Leaf sub-agent: single-shot.
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

describe('CEO → Leader → subagent verified pipeline', () => {
  it('runs three levels: Leaders verify, leaves are single-shot, criteria + plans persist', async () => {
    runs.length = 0
    const { store, mgr } = makeMgr()
    const { sessionId } = mgr.createSession(fakeProvider)

    let resolveDone!: () => void
    const done = new Promise<void>((r) => {
      resolveDone = r
    })
    const { taskId } = mgr.submitGoal(sessionId, 'ship it', undefined, undefined, () => resolveDone(), {
      agentType: 'ceo',
    })
    await done
    // Let any tail child persistence settle.
    await new Promise((r) => setTimeout(r, 30))

    const ceo = runs.find((r) => r.agent === 'ceo')
    const heads = runs.filter((r) => r.isHead)
    const leaves = runs.filter((r) => r.agent === 'engineer')

    // All three levels ran.
    expect(ceo).toBeDefined()
    expect(heads).toHaveLength(2)
    expect(leaves).toHaveLength(2)

    // Verify threading: CEO + Leaders run the verify loop (3 rounds); leaves are
    // single-shot (0) — exactly the two-level verify the vision calls for.
    expect(ceo!.maxVerifyRounds).toBe(3)
    expect(heads.every((h) => h.maxVerifyRounds === 3)).toBe(true)
    expect(leaves.every((l) => l.maxVerifyRounds === 0)).toBe(true)

    // The acceptance-criteria contract reached the Leaders (CEO-spawned).
    expect(heads.every((h) => h.criteria === 1)).toBe(true)

    // Tree shape: heads are children of the CEO; leaves are children of a head.
    expect(heads.every((h) => h.parent === taskId)).toBe(true)
    const headIds = heads.map((h) => h.taskId)
    expect(leaves.every((l) => headIds.includes(l.parent!))).toBe(true)

    // Events persisted on the real tasks.
    expect(store.getTask(taskId)?.acceptanceCriteria).toHaveLength(1)
    for (const h of heads) expect(store.getTask(h.taskId)?.delegationPlan).toHaveLength(1)

    // The CEO task reached a terminal status.
    expect(['completed', 'failed']).toContain(store.getTask(taskId)?.status)
  })
})
