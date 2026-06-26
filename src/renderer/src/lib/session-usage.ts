import type { TaskRecord } from './apply-event'

/**
 * The usage display (context ring, cost, transcript footer) reflects the
 * conversation's own turns, so it must read from top-level tasks only. Sub-agent
 * children are spawned mid-run — they sort newest by startedAt but persist no
 * usage and no contextWindow, so including them blanks the display once a session
 * is rehydrated from disk on restart. Returns the most recent top-level task, or
 * undefined if the session has none yet.
 */
export function latestTopLevelTask(records: TaskRecord[]): TaskRecord | undefined {
  let latest: TaskRecord | undefined
  for (const r of records) {
    if (r.parentTaskId) continue
    if (!latest || r.startedAt > latest.startedAt) latest = r
  }
  return latest
}
