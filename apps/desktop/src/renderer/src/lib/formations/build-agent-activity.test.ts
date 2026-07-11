// apps/desktop/src/renderer/src/lib/formations/build-agent-activity.test.ts

import type { MessageRecord } from '@shared/lib/apply-event'
import type { SessionSummary } from '@swarm/protocol'
import { describe, expect, it } from 'vitest'

import { buildAgentActivity } from './build-agent-activity'

function mkRun(over: Partial<MessageRecord> & Pick<MessageRecord, 'id'>): MessageRecord {
  return {
    sessionId: 's1',
    prompt: 'do something',
    status: 'running',
    summary: null,
    createdAt: 1000,
    attachments: [],
    order: 0,
    events: [],
    ...over,
  }
}
function mkSession(over: Partial<SessionSummary> & Pick<SessionSummary, 'id'>): SessionSummary {
  return {
    title: null,
    status: 'active',
    lastActiveAt: 1,
    taskCount: 0,
    pinned: false,
    sortOrder: 0,
    isSystem: false,
    ...over,
  }
}

describe('buildAgentActivity', () => {
  it('returns an empty map when no runs are active', () => {
    expect(buildAgentActivity([], [])).toEqual(new Map())
    expect(buildAgentActivity([mkRun({ id: 'r1', status: 'completed' })], [])).toEqual(new Map())
  })

  it('maps a sub-run (with agentDefId) to that agent id', () => {
    const runs = [mkRun({ id: 'r1', status: 'running', agentDefId: 'engineer', prompt: '修复登录', createdAt: 100 })]
    const out = buildAgentActivity(runs, [])
    expect(out.get('engineer')).toMatchObject({ status: 'running', currentTask: '修复登录' })
  })

  it('maps a top-level run (no agentDefId) via the session agentType', () => {
    const runs = [mkRun({ id: 'r1', status: 'running', sessionId: 'sX', prompt: '发布产品' })]
    const sessions = [mkSession({ id: 'sX', agentType: 'ceo' })]
    const out = buildAgentActivity(runs, sessions)
    expect(out.get('ceo')).toMatchObject({ status: 'running', currentTask: '发布产品' })
  })

  it('skips runs whose agent resolves to undefined', () => {
    const runs = [mkRun({ id: 'r1', status: 'running', sessionId: 'sX', prompt: 'g' })] // no agentDefId
    const sessions = [mkSession({ id: 'sX' })] // no agentType
    expect(buildAgentActivity(runs, sessions)).toEqual(new Map())
  })

  it('keeps only pending/running; drops awaiting_user/completed/etc', () => {
    const runs = [
      mkRun({ id: 'r1', status: 'running', agentDefId: 'a' }),
      mkRun({ id: 'r2', status: 'pending', agentDefId: 'b' }),
      mkRun({ id: 'r3', status: 'awaiting_user', agentDefId: 'c' }),
      mkRun({ id: 'r4', status: 'completed', agentDefId: 'd' }),
    ]
    const out = buildAgentActivity(runs, [])
    expect([...out.keys()].sort()).toEqual(['a', 'b'])
  })

  it('stepProgress = "n/m 步" from the plan, counting completed only', () => {
    const runs = [
      mkRun({
        id: 'r1',
        status: 'running',
        agentDefId: 'engineer',
        plan: [
          { content: 'a', status: 'completed' },
          { content: 'b', status: 'in_progress' },
          { content: 'c', status: 'pending' },
        ],
      }),
    ]
    const out = buildAgentActivity(runs, [])
    expect(out.get('engineer')?.stepProgress).toBe('1/3 步')
  })

  it('omits stepProgress when the run has no plan', () => {
    const runs = [mkRun({ id: 'r1', status: 'running', agentDefId: 'a' })]
    expect(buildAgentActivity(runs, []).get('a')?.stepProgress).toBeUndefined()
  })

  it('truncates currentTask to 40 chars', () => {
    const long = 'x'.repeat(80)
    const runs = [mkRun({ id: 'r1', status: 'running', agentDefId: 'a', prompt: long })]
    expect(buildAgentActivity(runs, []).get('a')?.currentTask).toBe(`${'x'.repeat(39)}…`)
  })

  it('keeps only the newest active run per agent (max createdAt)', () => {
    const runs = [
      mkRun({ id: 'r1', status: 'running', agentDefId: 'a', prompt: '旧的', createdAt: 100 }),
      mkRun({ id: 'r2', status: 'running', agentDefId: 'a', prompt: '新的', createdAt: 500 }),
    ]
    expect(buildAgentActivity(runs, []).get('a')?.currentTask).toBe('新的')
  })
})
