// Pure derivation of calendar "Agent 洞察" cards from a day's items. No React,
// no side effects. Mirrors the style of lib/formations/build-agent-activity.ts.

export type InsightInput = {
  kind: 'event' | 'projection' | 'run'
  source: 'google' | 'local' | 'task'
  title: string
  startMs: number
  endMs: number
}

export type CalendarInsight = {
  kind: 'conflict' | 'delegable' | 'focus'
  tag: string
  text: string
  tone: 'danger' | 'violet' | 'green'
}

const MIN_GAP_FOR_CONFLICT_MS = 30 * 60 * 1000 // <30min between events = conflict
const MIN_FOCUS_BLOCK_MS = 90 * 60 * 1000 // >=90min contiguous free = focus
const LUNCH_START_HOUR = 12
const LUNCH_END_HOUR = 13
const DAY_START_HOUR = 9
const DAY_END_HOUR = 18

function fmtTime(ms: number): string {
  const d = new Date(ms)
  return `${d.getHours().toString().padStart(2, '0')}:${d.getMinutes().toString().padStart(2, '0')}`
}

// Free blocks that are NOT inside the 12:00-13:00 lunch band and fall in work hours.
function freeBlocksOutsideLunch(
  events: InsightInput[],
  dayStartMs: number,
  dayEndMs: number
): { startMs: number; endMs: number }[] {
  // Build free gaps between sorted events within [dayStart, dayEnd].
  const sorted = [...events].sort((a, b) => a.startMs - b.startMs)
  const gaps: { startMs: number; endMs: number }[] = []
  let cursor = dayStartMs
  for (const e of sorted) {
    if (e.startMs > cursor) gaps.push({ startMs: cursor, endMs: e.startMs })
    cursor = Math.max(cursor, e.endMs)
  }
  if (cursor < dayEndMs) gaps.push({ startMs: cursor, endMs: dayEndMs })
  // Drop any gap fully inside lunch.
  return gaps.filter((g) => {
    const s = new Date(g.startMs)
    const e = new Date(g.endMs)
    const sInLunch = s.getHours() >= LUNCH_START_HOUR && s.getHours() < LUNCH_END_HOUR
    const eInLunch = e.getHours() > LUNCH_START_HOUR && e.getHours() <= LUNCH_END_HOUR
    return !(sInLunch && eInLunch)
  })
}

export function buildCalendarInsights(items: InsightInput[]): CalendarInsight[] {
  if (items.length === 0) return []
  const out: CalendarInsight[] = []
  const events = items.filter((i) => i.kind === 'event')
  const sortedEvents = [...events].sort((a, b) => a.startMs - b.startMs)

  // Conflict: adjacent events with <30min gap or overlap.
  for (let i = 1; i < sortedEvents.length; i++) {
    const prev = sortedEvents[i - 1]
    const cur = sortedEvents[i]
    const gap = cur.startMs - prev.endMs
    if (gap < MIN_GAP_FOR_CONFLICT_MS) {
      out.push({
        kind: 'conflict',
        tag: '日程冲突',
        text: `${fmtTime(prev.startMs)} 「${prev.title}」与 ${fmtTime(cur.startMs)} 「${cur.title}」之间${gap < 0 ? '时间重叠' : `仅 ${Math.round(gap / 60000)} 分钟缓冲`}。`,
        tone: 'danger',
      })
      break // one conflict insight is enough
    }
  }

  // Delegable: any local event or cron projection.
  const delegated = items.filter((i) => (i.kind === 'event' && i.source === 'local') || i.kind === 'projection')
  if (delegated.length > 0) {
    out.push({
      kind: 'delegable',
      tag: '可委派',
      text: `今日有 ${delegated.length} 个事项已交给 Agent：${delegated
        .map((d) => d.title)
        .slice(0, 2)
        .join('、')}${delegated.length > 2 ? ' 等' : ''}。`,
      tone: 'violet',
    })
  }

  // Focus: a >=90min contiguous free block that spans across the lunch hour
  // (12:00-13:00), within work hours (09:00-18:00). A long stretch bridging
  // lunch is a meaningful deep-work window; morning-only / afternoon-only edge
  // blocks (e.g. a single midday meeting) are too common to be noteworthy, so
  // they are excluded by requiring the block to straddle the lunch band.
  const firstStart = Math.min(...items.map((i) => i.startMs))
  const d = new Date(firstStart)
  const dayStartMs = new Date(d.getFullYear(), d.getMonth(), d.getDate(), DAY_START_HOUR).getTime()
  const dayEndMs = new Date(d.getFullYear(), d.getMonth(), d.getDate(), DAY_END_HOUR).getTime()
  const lunchStartMs = new Date(d.getFullYear(), d.getMonth(), d.getDate(), LUNCH_START_HOUR).getTime()
  const lunchEndMs = new Date(d.getFullYear(), d.getMonth(), d.getDate(), LUNCH_END_HOUR).getTime()
  const focusBlock = freeBlocksOutsideLunch(events, dayStartMs, dayEndMs).find(
    (g) => g.endMs - g.startMs >= MIN_FOCUS_BLOCK_MS && g.startMs < lunchEndMs && g.endMs > lunchStartMs
  )
  if (focusBlock) {
    out.push({
      kind: 'focus',
      tag: '专注时段',
      text: `${fmtTime(focusBlock.startMs)}–${fmtTime(focusBlock.endMs)} 无会议，是连续专注时段。`,
      tone: 'green',
    })
  }

  return out
}
