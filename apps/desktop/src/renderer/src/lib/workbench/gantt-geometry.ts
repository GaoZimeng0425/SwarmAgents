// Gantt geometry — pure date/float math ported from WorkPanel's GanttGeometry.swift.
// No React, no DOM. Operates on day timestamps at local-midnight + a dayWidth number.

export type GanttRow = {
  id: string
  start: string | null
  end: string | null
}

export type DatedRow = {
  id: string
  start: string | null
  end: string | null
  /** Effective start = start ?? end (used for sorting scheduled rows). */
  effectiveStart: string
  isScheduled: boolean
}

// --- Day helpers -------------------------------------------------------------

function startOfDay(d: Date): Date {
  const r = new Date(d)
  r.setHours(0, 0, 0, 0)
  return r
}

function addDays(d: Date, days: number): Date {
  const r = new Date(d)
  r.setDate(r.getDate() + days)
  return r
}

function dayDiff(from: Date, to: Date): number {
  const ms = startOfDay(to).getTime() - startOfDay(from).getTime()
  return Math.round(ms / 86_400_000)
}

/** Whole-day index of `date` from `timelineStart` (floors to day). */
export function dayIndex(date: Date, timelineStart: Date): number {
  return dayDiff(timelineStart, date)
}

/** Pixel x for `date` on a timeline starting at `timelineStart` with `dayWidth`. */
export function xForDate(date: Date, timelineStart: Date, dayWidth: number): number {
  return dayIndex(date, timelineStart) * dayWidth
}

/**
 * Bar rect on the timeline. Ported from GanttGeometry.barFrame:
 * - both nil → null (no bar)
 * - both present: inclusive span (end day - start day + 1)
 * - start after end → single cell at start
 * - single-sided → 1 day wide at that date
 */
export function barFrame(
  start: string | null,
  end: string | null,
  timelineStart: Date,
  dayWidth: number
): { x: number; width: number } | null {
  if (!start && !end) return null
  if (start && end) {
    const sd = new Date(start)
    const ed = new Date(end)
    if (startOfDay(ed) >= startOfDay(sd)) {
      const days = dayIndex(ed, timelineStart) - dayIndex(sd, timelineStart) + 1
      return { x: xForDate(sd, timelineStart, dayWidth), width: days * dayWidth }
    }
    return { x: xForDate(sd, timelineStart, dayWidth), width: dayWidth }
  }
  if (start) return { x: xForDate(new Date(start), timelineStart, dayWidth), width: dayWidth }
  return { x: xForDate(new Date(end!), timelineStart, dayWidth), width: dayWidth }
}

/** Pixels → whole days (rounded). */
export function daysDelta(translationX: number, dayWidth: number): number {
  return Math.round(translationX / dayWidth)
}

/** Translate both dates by `days`, preserving nulls. */
export function shifted(
  start: string | null,
  end: string | null,
  days: number
): { start: string | null; end: string | null } {
  return {
    start: start ? addDays(new Date(start), days).toISOString() : null,
    end: end ? addDays(new Date(end), days).toISOString() : null,
  }
}

/**
 * Move the left edge by `days`, clamping to not pass the end's day (min 1 day).
 * Preserves the time-of-day of the original start.
 */
export function resizedStart(start: string, end: string | null, days: number): string {
  const moved = addDays(new Date(start), days)
  if (!end) return moved.toISOString()
  if (startOfDay(moved) > startOfDay(new Date(end))) {
    return clampDay(moved, new Date(end)).toISOString()
  }
  return moved.toISOString()
}

/**
 * Move the right edge by `days`, clamping to not pass the start's day (min 1 day).
 * Preserves the time-of-day of the original end.
 */
export function resizedEnd(start: string | null, end: string, days: number): string {
  const moved = addDays(new Date(end), days)
  if (!start) return moved.toISOString()
  if (startOfDay(moved) < startOfDay(new Date(start))) {
    return clampDay(moved, new Date(start)).toISOString()
  }
  return moved.toISOString()
}

/** Keep date's time-of-day but swap its calendar day to `ref`. */
function clampDay(date: Date, ref: Date): Date {
  const r = new Date(ref)
  r.setHours(date.getHours(), date.getMinutes(), date.getSeconds(), date.getMilliseconds())
  return r
}

// --- Partitioning ------------------------------------------------------------

function toDated(row: GanttRow): DatedRow {
  const effectiveStart = row.start ?? row.end ?? ''
  return { ...row, effectiveStart, isScheduled: row.start != null || row.end != null }
}

/** Split into scheduled (sorted by effectiveStart asc) + unscheduled (original order). */
export function partition(rows: GanttRow[]): { scheduled: DatedRow[]; unscheduled: DatedRow[] } {
  const dated = rows.map(toDated)
  return {
    scheduled: dated.filter((r) => r.isScheduled).sort((a, b) => a.effectiveStart.localeCompare(b.effectiveStart)),
    unscheduled: dated.filter((r) => !r.isScheduled),
  }
}

// --- Timeline bounds ---------------------------------------------------------

/**
 * Default window: today .. today+13 (14 days). Expands outward to fit every
 * scheduled task's start and end.
 */
export function timelineBounds(scheduled: DatedRow[]): { start: Date; days: number } {
  const today = startOfDay(new Date())
  let minDay = today
  let maxDay = addDays(today, 13)

  for (const r of scheduled) {
    for (const d of [r.start, r.end]) {
      if (!d) continue
      const day = startOfDay(new Date(d))
      if (day < minDay) minDay = day
      if (day > maxDay) maxDay = day
    }
  }

  const days = dayDiff(minDay, maxDay) + 1
  return { start: minDay, days }
}
