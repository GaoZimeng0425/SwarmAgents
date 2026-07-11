import type { ReactNode } from 'react'
import type { MessageRecord } from '@shared/lib/apply-event'
import { sortBy } from 'es-toolkit'

import { groupSegments } from './group-segments'
import { type Segment, taskSegments } from './task-segments'
import { dayKey } from './timeline'

export type TimelineItem = {
  key: string
  node: ReactNode
  /** Global ordering key (replaces wall-clock ts). */
  order: number
  /** Display-only: timestamp label + day-divider source. */
  ts: number
}

type RenderSegment = (seg: Segment, isLiveTail: boolean, nested?: boolean) => ReactNode

// Render callbacks keep this module pure (no JSX / component imports). The
// caller (task-transcript.tsx) supplies real components; tests supply stubs.
type Render = {
  segment: RenderSegment
  subagent: (t: MessageRecord, segs: Segment[], lastKey: string | undefined) => ReactNode
  toolGroup: (segs: Segment[]) => ReactNode
  dayDivider: (ts: number) => ReactNode
}

type Opts = {
  busy: boolean
  showDayDividers?: boolean
}

// Interleave segments from multiple tasks in true causal order (by order). A
// top-level task contributes its segments individually; a spawned sub-agent
// contributes one grouped SubagentBlock at its spawn point. Optional day
// dividers. Extracted from TaskTimeline so the chat thread and the read-only
// results card share one source of truth, ordered by order not ts.
export function buildTimelineItems(tasks: MessageRecord[], render: Render, opts: Opts): TimelineItem[] {
  const ordered = sortBy(tasks, ['order'])

  // The live tail = the segment with the largest order (gets the pulsing state).
  let lastKey: string | undefined
  let lastOrder = Number.NEGATIVE_INFINITY
  for (const t of ordered) {
    for (const s of taskSegments(t)) {
      if (s.order >= lastOrder) {
        lastOrder = s.order
        lastKey = s.key
      }
    }
  }

  type Raw = { key: string; order: number; ts: number; node: ReactNode }
  const raw: Raw[] = []
  for (const t of ordered) {
    const segs = taskSegments(t)
    if (t.parentMessageId) {
      raw.push({
        key: t.id,
        order: t.order,
        ts: t.createdAt,
        node: render.subagent(t, segs, lastKey),
      })
    } else {
      for (const item of groupSegments(segs)) {
        if (item.kind === 'single') {
          const seg = item.seg
          raw.push({ key: seg.key, order: seg.order, ts: seg.ts, node: render.segment(seg, seg.key === lastKey) })
        } else {
          const first = item.segs[0]
          raw.push({ key: first.key, order: first.order, ts: first.ts, node: render.toolGroup(item.segs) })
        }
      }
    }
  }

  const sorted = sortBy(raw, ['order'])

  if (!opts.showDayDividers) {
    return sorted.map((r) => ({ key: r.key, node: r.node, order: r.order, ts: r.ts }))
  }

  // Splice day dividers using ts (display), placed at order - 0.5 so a divider
  // sorts just before the item whose day it opens.
  const out: TimelineItem[] = []
  let prevDay: string | undefined
  for (const r of sorted) {
    const d = dayKey(r.ts)
    if (d !== prevDay) {
      out.push({ key: `day-${d}`, node: render.dayDivider(r.ts), order: r.order - 0.5, ts: r.ts })
      prevDay = d
    }
    out.push({ key: r.key, node: r.node, order: r.order, ts: r.ts })
  }
  return out
}
