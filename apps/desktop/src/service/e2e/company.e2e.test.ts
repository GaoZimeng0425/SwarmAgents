// src/service/e2e/company.e2e.test.ts

import type { ActorMessage } from '@swarm/protocol'
import { defaultAgents } from '@swarm/shared'
import { describe, expect, it, vi } from 'vitest'

import { createConversationStore } from '../conversation/store'
import { createSessionManager } from '../session/manager'

// Records the routed message chain so the test can assert the collaboration
// flow. Module-scope so the hoisted mock factory can close over it.
const { chain, reviewerVerdicts } = vi.hoisted(() => ({
  chain: [] as string[],
  reviewerVerdicts: [] as string[], // controls reviewer replies per call
}))

// Per-role scripted behavior, exercising the REAL send_and_wait routing via
// deps.sendMessage. Each role's turn holds a slot only while working; nested
// rpc awaits run within maxConcurrent=4 (max concurrent holders = 3).
vi.mock('../session/agent-runner', () => ({
  createAgentRunner: () => ({ run: async () => ({ status: 'completed', summary: '', messages: [], used: {} }) }),
  buildAgentSession: () => ({}),
  runResident: async (deps: any, mailbox: any, hooks: any) => {
    const role = deps.agentDefinition.id
    for (;;) {
      let msg: ActorMessage
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
          const r = await deps.sendMessage(deps.selfAddress, 'engineering-lead', msg.payload, 'rpc')
          summary = `FINAL(${r.reply})`
        } else if (role === 'engineering-lead') {
          const built = await deps.sendMessage(deps.selfAddress, 'engineer', 'implement', 'rpc')
          let verdict = (await deps.sendMessage(deps.selfAddress, 'reviewer', `review ${built.reply}`, 'rpc')).reply
          let rounds = 0
          while (verdict.startsWith('NEEDS') && rounds < 10) {
            rounds++
            await deps.sendMessage(deps.selfAddress, 'engineer', 'fix', 'rpc')
            verdict = (await deps.sendMessage(deps.selfAddress, 'reviewer', 'review again', 'rpc')).reply
          }
          summary = `DELIVERED(${verdict}, rounds=${rounds})`
        } else if (role === 'engineer') {
          summary = 'built:ok'
        } else if (role === 'reviewer') {
          summary = reviewerVerdicts.shift() ?? 'APPROVED'
        }
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
    maxConcurrent: 4,
    getProvider: () => fakeProvider,
    agentStore: roleStore as any,
  })
  return { store, mgr }
}

describe('emergent company — collaboration chain', () => {
  it('routes goal CEO->PM->engineer+reviewer and returns the assembled result (approve first pass)', async () => {
    chain.length = 0
    reviewerVerdicts.length = 0 // defaults to APPROVED
    const { mgr } = makeMgr()
    const { sessionId } = mgr.createSession(fakeProvider)

    const result = (await mgr.startCompany(sessionId, 'build a thing')) as { reply: string }

    expect(result.reply).toBe('FINAL(DELIVERED(APPROVED, rounds=0))')
    // Every role participated, in order.
    expect(chain).toContain('ceo:recv')
    expect(chain).toContain('engineering-lead:recv')
    expect(chain).toContain('engineer:recv')
    expect(chain).toContain('reviewer:recv')
    // PM must dispatch the engineer before the reviewer — order, not just presence.
    expect(chain.indexOf('engineer:recv')).toBeLessThan(chain.indexOf('reviewer:recv'))
  })

  it('drives the fix/review loop when the reviewer first reports NEEDS CHANGES', async () => {
    chain.length = 0
    reviewerVerdicts.length = 0
    reviewerVerdicts.push('NEEDS CHANGES: 1. fix it', 'APPROVED') // round 1 fails, round 2 passes
    const { mgr } = makeMgr()
    const { sessionId } = mgr.createSession(fakeProvider)

    const result = (await mgr.startCompany(sessionId, 'build a thing')) as { reply: string }

    expect(result.reply).toBe('FINAL(DELIVERED(APPROVED, rounds=1))')
    // engineer was re-invoked for the fix (recv appears at least twice).
    expect(chain.filter((c) => c === 'engineer:recv').length).toBeGreaterThanOrEqual(2)
    // First review fails, second passes ⇒ reviewer invoked exactly twice.
    expect(chain.filter((c) => c === 'reviewer:recv').length).toBe(2)
  })
})
