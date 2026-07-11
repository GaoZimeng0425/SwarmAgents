// apps/desktop/src/renderer/src/lib/workspace/build-timeline.ts
// Pure builder: flattens a session's RunRecord[].events into a flat timeline.
// run.progress / run.usage / run.plan / run.delegation_plan / run.spawned are
// filtered out — too dense for a glanceable log, and their substance shows
// elsewhere (plan tab, transcript).

import type { RunRecord } from '@shared/lib/apply-event'
import type { UIEvent } from '@swarm/protocol'

export type TimelineKind = 'start' | 'dispatch' | 'tool' | 'permission' | 'complete' | 'error'

export type TimelineRow = {
  /** `${runId}:${seq}` — unique within the session. */
  id: string
  ts: number
  kind: TimelineKind
  label: string
}

const KEEP: Record<string, TimelineKind | undefined> = {
  'run.created': 'start',
  'run.dispatched': 'dispatch',
  'run.tool_call': 'tool',
  'run.permission_request': 'permission',
  'run.complete': 'complete',
  'run.error': 'error',
}

function label(e: UIEvent & { ts: number }): string {
  // Narrow per kind; the KEEP guard above guarantees these members.
  switch (e.kind) {
    case 'run.created':
      return e.prompt
    case 'run.dispatched':
      return '派发'
    case 'run.tool_call':
      return e.tool
    case 'run.permission_request':
      return e.summary
    case 'run.complete':
      return e.summary
    case 'run.error':
      return e.error.message
    default:
      return e.kind
  }
}

/** Flatten all runs' events into one timeline, filtering noisy kinds, sorted by ts. */
export function buildTimeline(runs: RunRecord[]): TimelineRow[] {
  const rows: TimelineRow[] = []
  for (const run of runs) {
    for (const e of run.events) {
      const kind = KEEP[e.kind]
      if (!kind) continue
      rows.push({ id: `${run.id}:${e.seq}`, ts: e.ts, kind, label: label(e) })
    }
  }
  rows.sort((a, b) => a.ts - b.ts)
  return rows
}
