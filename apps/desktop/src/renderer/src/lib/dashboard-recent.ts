// Pure selector for the dashboard's 最近完成 section. Approximates "recently
// completed tasks" with recently-ended *sessions* (per the spec's locked
// decision: no per-task IPC in Phase 2). Excludes the system (cron) session.
//
// Phase-2 limitation (documented): a session shows as one row regardless of how
// many tasks it ran; the success icon is always green because SessionSummary
// carries no per-session success/failure flag. Per-task granularity needs a new
// IPC and is deferred.

import type { SessionSummary } from '@swarm/protocol'

export type DashboardRecentRow = {
  id: string
  name: string
  /** The session's lastActiveAt, carried through for relative-time formatting in the view. */
  lastActiveAt: number
}

export function selectDashboardRecent(sessions: SessionSummary[]): { rows: DashboardRecentRow[] } {
  const rows = sessions
    .filter((s) => s.status === 'ended' && !s.isSystem)
    .sort((a, b) => b.lastActiveAt - a.lastActiveAt)
    .slice(0, 5)
    .map((s) => ({ id: s.id, name: s.title ?? '未命名任务', lastActiveAt: s.lastActiveAt }))
  return { rows }
}
