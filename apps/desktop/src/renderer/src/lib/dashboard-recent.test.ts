import type { SessionSummary } from '@swarm/protocol'
import { describe, expect, it } from 'vitest'

import { selectDashboardRecent } from '@/lib/dashboard-recent'

const NOW = 1_000_000
const session = (over: Partial<SessionSummary> & Pick<SessionSummary, 'id'>): SessionSummary => ({
  title: 't',
  status: 'ended',
  lastActiveAt: NOW,
  taskCount: 0,
  pinned: false,
  sortOrder: 0,
  isSystem: false,
  ...over,
})

describe('selectDashboardRecent', () => {
  it('keeps only ended sessions, sorted by lastActiveAt desc, top 5', () => {
    const sessions = [
      session({ id: 'active', status: 'active', lastActiveAt: NOW + 1 }),
      session({ id: 'old', status: 'ended', lastActiveAt: NOW - 10_000 }),
      session({ id: 'new', status: 'ended', lastActiveAt: NOW - 1_000 }),
      session({ id: 'interrupted', status: 'interrupted', lastActiveAt: NOW }),
    ]
    const out = selectDashboardRecent(sessions)
    expect(out.rows.map((r) => r.id)).toEqual(['new', 'old'])
  })

  it('carries lastActiveAt through to the row (for relative-time formatting)', () => {
    const sessions = [session({ id: 's1', status: 'ended', lastActiveAt: NOW - 5_000 })]
    expect(selectDashboardRecent(sessions).rows[0].lastActiveAt).toBe(NOW - 5_000)
  })

  it('limits to 5', () => {
    const sessions = Array.from({ length: 8 }, (_, i) =>
      session({ id: `s${i}`, status: 'ended', lastActiveAt: NOW - i })
    )
    expect(selectDashboardRecent(sessions).rows).toHaveLength(5)
  })

  it('falls back to "未命名任务" when title is null', () => {
    const sessions = [session({ id: 's1', status: 'ended', title: null })]
    expect(selectDashboardRecent(sessions).rows[0].name).toBe('未命名任务')
  })

  it('excludes the system session', () => {
    const sessions = [session({ id: 'sys', status: 'ended', isSystem: true }), session({ id: 'real', status: 'ended' })]
    expect(selectDashboardRecent(sessions).rows.map((r) => r.id)).toEqual(['real'])
  })
})
