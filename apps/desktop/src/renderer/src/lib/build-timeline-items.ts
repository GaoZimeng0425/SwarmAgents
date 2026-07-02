import type { ReactNode } from 'react'
import { sortBy } from 'es-toolkit'

import type { TaskRecord } from '@shared/lib/apply-event'
import { groupSegments } from './group-segments'
import { type Segment, taskSegments } from './task-segments'
import { dayKey } from './timeline'

export type TimelineItem = {
  key: string
  node: ReactNode
  /** Global ordering key (replaces wall-clock ts). */
  seq: number
  /** Display-only: timestamp label + day-divider source. */
  ts: number
}

type RenderSegment = (seg: Segment, isLiveTail: boolean, nested?: boolean) => ReactNode

// Render callbacks keep this module pure (no JSX / component imports). The
// caller (task-transcript.tsx) supplies real components; tests supply stubs.
type Render = {
  segment: RenderSegment
  subagent: (t: TaskRecord, segs: Segment[], lastKey: string | undefined) => ReactNode
  toolGroup: (segs: Segment[]) => ReactNode
  dayDivider: (ts: number) => ReactNode
}

type Opts = {
  busy: boolean
  showDayDividers?: boolean
}

// Interleave segments from multiple tasks in true causal order (by seq). A
// top-level task contributes its segments individually; a spawned sub-agent
// contributes one grouped SubagentBlock at its spawn point. Optional day
// dividers. Extracted from TaskTimeline so the chat thread and the read-only
// results card share one source of truth, ordered by seq not ts.
export function buildTimelineItems(tasks: TaskRecord[], render: Render, opts: Opts): TimelineItem[] {
  const ordered = sortBy(tasks, [(t) => t.events[0]?.seq ?? t.startedAt])

  // The live tail = the segment with the largest seq (gets the pulsing state).
  let lastKey: string | undefined
  let lastSeq = Number.NEGATIVE_INFINITY
  for (const t of ordered) {
    for (const s of taskSegments(t)) {
      if (s.seq >= lastSeq) {
        lastSeq = s.seq
        lastKey = s.key
      }
    }
  }

  type Raw = { key: string; seq: number; ts: number; node: ReactNode }
  const raw: Raw[] = []
  for (const t of ordered) {
    const segs = taskSegments(t)
    if (t.parentTaskId) {
      raw.push({
        key: t.id,
        seq: t.events[0]?.seq ?? t.startedAt,
        ts: t.startedAt,
        node: render.subagent(t, segs, lastKey),
      })
    } else {
      for (const item of groupSegments(segs)) {
        if (item.kind === 'single') {
          const seg = item.seg
          raw.push({ key: seg.key, seq: seg.seq, ts: seg.ts, node: render.segment(seg, seg.key === lastKey) })
        } else {
          const first = item.segs[0]
          raw.push({ key: first.key, seq: first.seq, ts: first.ts, node: render.toolGroup(item.segs) })
        }
      }
    }
  }

  const sorted = sortBy(raw, ['seq'])

  if (!opts.showDayDividers) {
    return sorted.map((r) => ({ key: r.key, node: r.node, seq: r.seq, ts: r.ts }))
  }

  // Splice day dividers using ts (display), placed at seq - 0.5 so a divider
  // sorts just before the item whose day it opens.
  const out: TimelineItem[] = []
  let prevDay: string | undefined
  for (const r of sorted) {
    const d = dayKey(r.ts)
    if (d !== prevDay) {
      out.push({ key: `day-${d}`, node: render.dayDivider(r.ts), seq: r.seq - 0.5, ts: r.ts })
      prevDay = d
    }
    out.push({ key: r.key, node: r.node, seq: r.seq, ts: r.ts })
  }
  return out
}
