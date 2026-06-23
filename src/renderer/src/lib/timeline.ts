import { differenceInCalendarDays, format } from 'date-fns'

/** Wall-clock time of a message, e.g. "09:05" (24h, local timezone). */
export function formatMessageTime(ts: number): string {
  return format(ts, 'HH:mm')
}

/** Stable per-calendar-day key (local timezone) for detecting day boundaries. */
export function dayKey(ts: number): string {
  return format(ts, 'yyyy-MM-dd')
}

/** Human label for a day divider: "Today" / "Yesterday" / "Jun 20, 2026". */
export function formatDayLabel(ts: number, now: number): string {
  const diff = differenceInCalendarDays(now, ts)
  if (diff === 0) return 'Today'
  if (diff === 1) return 'Yesterday'
  return format(ts, 'MMM d, yyyy')
}
