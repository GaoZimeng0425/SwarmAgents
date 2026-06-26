// src/service/e2e/multi-team-company.e2e.test.ts

import { defaultAgents } from '@shared/constants/agents'
import { describe, expect, it, vi } from 'vitest'

import { createConversationStore } from '../conversation/store'
import { createAgentDirectory } from '../directory/receptionist'
import { createSessionManager } from '../session/manager'

// Records the routed message chain and what discovery returned, so the test can
// assert the multi-team collaboration flow. Module-scope so the hoisted mock
// factory can close over it.
const { chain, discovered } = vi.hoisted(() => ({
  chain: [] as string[],
  discovered: { heads: [] as string[] },
}))

// Per-role scripted behavior. Unlike the single-team harness, routing here is
// DISCOVERY-driven: each role uses the REAL directory (deps.findPeers) to find
// teammates by team/teamRole and messages them by address — exercising the
// team/teamRole filtering end-to-end with only the agent-runner stubbed.
vi.mock('../session/agent-runner', () => ({
  createAgentRunner: () => ({ run: async () => ({ status: 'completed', summary: '', messages: [], used: {} }) }),
  buildAgentSession: () => ({}),
  runResident: async (deps: any, mailbox: any, hooks: any) => {
    const role = deps.agentDefinition.id
    for (;;) {
      let msg
      try {
        msg = await mailbox.receive({ idleMs: 5 })
      } catch {
        return
      }
      await hooks.acquireTurnSlot()
      let summary = ''
      try {
        chain.push(`${role}:recv`)
        if (role === 'ceo') {
          const heads = deps.findPeers({ teamRole: 'head' })
          discovered.heads = heads.map((p: any) => p.role).sort()
          const devHead = heads.find((p: any) => p.role === 'pm')
          const r = await deps.sendMessage(deps.selfAddress, devHead.address, msg.payload, 'rpc')
          summary = `FINAL(${r.reply})`
        } else if (role === 'pm') {
          const eng = deps.findPeers({ team: 'dev', role: 'engineer' })[0]
          const built = await deps.sendMessage(deps.selfAddress, eng.address, 'implement', 'rpc')
          const rev = deps.findPeers({ team: 'dev', role: 'reviewer' })[0]
          const verdict = (await deps.sendMessage(deps.selfAddress, rev.address, `review ${built.reply}`, 'rpc')).reply
          summary = `deliverable: built+${verdict}`
        } else if (role === 'engineer') {
          summary = 'built X, tests pass'
        } else if (role === 'reviewer') {
          summary = 'APPROVED'
        }
        // training-head / training-author idle out — not exercised in this flow.
      } finally {
        hooks.releaseTurnSlot()
      }
      hooks.onConsumed(msg.id, '{"v":1,"messages":[]}')
      if (msg.kind === 'rpc' && msg.correlationId) hooks.onReply(msg.correlationId, summary)
    }
  },
}))

const fakeProvider = { model: 'test', apiStyle: 'anthropic' } as any
const roleStore = { get: (id: string) => defaultAgents.find((a) => a.id === id), list: () => defaultAgents }

function makeMgr() {
  const store = createConversationStore(':memory:')
  const mgr = createSessionManager({
    store,
    broadcaster: { broadcast: () => {} },
    maxConcurrent: 8,
    getProvider: () => fakeProvider,
    agentStore: roleStore as any,
  })
  return { store, mgr }
}

describe('multi-team company — routing', () => {
  it('CEO discovers heads, dev head drives its team, deliverable flows back to the CEO', async () => {
    chain.length = 0
    discovered.heads = []
    const { store, mgr } = makeMgr()
    const { sessionId } = mgr.createSession(fakeProvider)

    const result = (await mgr.startCompany(sessionId, 'build a thing')) as { reply: string }

    // The CEO's discovery of team heads returned exactly the two team entry points.
    expect(discovered.heads).toEqual(['pm', 'training-head'])

    // Every dev-team role participated, in order (engineer before reviewer).
    expect(chain).toContain('ceo:recv')
    expect(chain).toContain('pm:recv')
    expect(chain).toContain('engineer:recv')
    expect(chain).toContain('reviewer:recv')
    expect(chain.indexOf('engineer:recv')).toBeLessThan(chain.indexOf('reviewer:recv'))

    // The deliverable that flowed pm->engineer->reviewer->pm->ceo is the run result.
    expect(result.reply).toBe('FINAL(deliverable: built+APPROVED)')

    // The session seeded all six named actors; the real directory filters by team/teamRole.
    const dir = createAgentDirectory({
      listActors: (s) => store.listActorsForSession(s),
      isLive: () => true,
      getAgentDef: (id) => defaultAgents.find((a) => a.id === id),
    })
    expect(dir.find(sessionId, {}).map((p) => p.role).sort()).toEqual(
      ['ceo', 'engineer', 'pm', 'reviewer', 'training-author', 'training-head'].sort()
    )
    expect(dir.find(sessionId, { teamRole: 'head' }).map((p) => p.role).sort()).toEqual(['pm', 'training-head'])
    expect(dir.find(sessionId, { team: 'dev' }).map((p) => p.role).sort()).toEqual(['engineer', 'pm', 'reviewer'])
  })
})
