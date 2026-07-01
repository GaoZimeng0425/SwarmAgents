import type { ConsumedResources } from '@swarm/protocol'

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

/**
 * Usage shown inside a session, mixing two scopes deliberately so the figures
 * match the session list:
 *  - `tokens` / `cacheRead` / `cacheWrite` are the latest top-level turn's
 *    snapshot — "current context size", a fill gauge, NOT a running total.
 *  - `usdCents` / `calls` / `wallMs` are cumulative across the session's
 *    top-level turns — "spent so far" — so the cost equals the session list's
 *    per-session total (which sums the same `used` snapshots). Sub-agent children
 *    persist zeroed usage, so summing top-level turns equals summing every task.
 * Returns undefined when the session has no top-level turn yet.
 */
export function sessionDisplayUsage(records: TaskRecord[]): ConsumedResources | undefined {
  const latest = latestTopLevelTask(records)
  if (!latest) return undefined
  let usdCents = 0
  let calls = 0
  let wallMs = 0
  for (const r of records) {
    if (r.parentTaskId || !r.used) continue
    usdCents += r.used.usdCents
    calls += r.used.calls
    wallMs += r.used.wallMs
  }
  const ctx = latest.used
  return {
    tokens: ctx?.tokens ?? 0,
    cacheRead: ctx?.cacheRead ?? 0,
    cacheWrite: ctx?.cacheWrite ?? 0,
    usdCents,
    calls,
    wallMs,
  }
}
