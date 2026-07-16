import type { SessionSummary } from '@swarm/protocol'
import { describe, expect, it } from 'vitest'

import { selectDashboardMessages } from '@/lib/dashboard-messages'

const NOW = 1_000_000
const session = (over: Partial<SessionSummary> & Pick<SessionSummary, 'id'>): SessionSummary => ({
  title: 't',
  status: 'active',
  lastActiveAt: NOW,
  taskCount: 0,
  pinned: false,
  sortOrder: 0,
  isSystem: false,
  ...over,
})

describe('selectDashboardMessages', () => {
  it('partitions running sessions into `running` and awaiting sessions into `awaiting`', () => {
    const sessions = [session({ id: 's1' }), session({ id: 's2' }), session({ id: 's3' })]
    const out = selectDashboardMessages(new Set(['s1', 's2']), new Set(['s3']), sessions, [], NOW)
    expect(out.running.map((r) => r.sessionId).sort()).toEqual(['s1', 's2'])
    expect(out.awaiting.map((r) => r.sessionId)).toEqual(['s3'])
  })

  it('awaiting outranks running for a session that is both running and awaiting', () => {
    const sessions = [session({ id: 's1' })]
    const out = selectDashboardMessages(new Set(['s1']), new Set(['s1']), sessions, [], NOW)
    expect(out.running).toHaveLength(0)
    expect(out.awaiting.map((r) => r.sessionId)).toEqual(['s1'])
  })

  it('excludes the system session', () => {
    const sessions = [session({ id: 'sys', isSystem: true }), session({ id: 's1' })]
    const out = selectDashboardMessages(new Set(['sys', 's1']), new Set(), sessions, [], NOW)
    expect(out.running.map((r) => r.sessionId)).toEqual(['s1'])
  })

  it('sorts running newest-first by lastActiveAt and uses the title as the prompt', () => {
    const sessions = [
      session({ id: 'old', title: 'Old', lastActiveAt: NOW - 10_000 }),
      session({ id: 'new', title: 'New', lastActiveAt: NOW - 1_000 }),
    ]
    const out = selectDashboardMessages(new Set(['old', 'new']), new Set(), sessions, [], NOW)
    expect(out.running.map((r) => r.sessionId)).toEqual(['new', 'old'])
    expect(out.running[0].prompt).toBe('New')
  })

  it('joins session cwd + agentType and maps agentType via teamOptions', () => {
    const sessions = [session({ id: 's1', cwd: '/repo/x', agentType: 'team-a' })]
    const teamOptions = [
      { id: 'ceo', label: '默认 Agent' },
      { id: 'team-a', label: '团队 A' },
    ]
    const out = selectDashboardMessages(new Set(['s1']), new Set(), sessions, teamOptions, NOW)
    expect(out.running[0]).toMatchObject({ cwd: '/repo/x', agentLabel: '团队 A' })
  })

  it('falls back to the raw agentType id when no teamOption matches', () => {
    const sessions = [session({ id: 's1', agentType: 'unknown' })]
    const out = selectDashboardMessages(new Set(['s1']), new Set(), sessions, [], NOW)
    expect(out.running[0].agentLabel).toBe('unknown')
  })

  it('computes wallMs from now - lastActiveAt', () => {
    const sessions = [session({ id: 's1', lastActiveAt: NOW - 60_000 })]
    const out = selectDashboardMessages(new Set(['s1']), new Set(), sessions, [], NOW)
    expect(out.running[0].wallMs).toBe(60_000)
  })
})
