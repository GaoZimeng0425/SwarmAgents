import { differenceInCalendarDays, format } from 'date-fns'

// Persisted history events are JSON-parsed without zod re-validation, so a
// legacy or corrupt event can reach the renderer with a non-finite timestamp.
// date-fns `format` throws "Invalid time value" on such input, which would crash
// the entire ConversationThread. Coerce to epoch 0 so a single bad value
// degrades to a harmless row instead of taking down the whole view.
function safeTs(ts: number): number {
  return Number.isFinite(ts) ? ts : 0
}

/** Wall-clock time of a message, e.g. "09:05" (24h, local timezone). */
export function formatMessageTime(ts: number): string {
  return format(safeTs(ts), 'HH:mm')
}

/** Stable per-calendar-day key (local timezone) for detecting day boundaries. */
export function dayKey(ts: number): string {
  return format(safeTs(ts), 'yyyy-MM-dd')
}

/** Human label for a day divider: "Today" / "Yesterday" / "Jun 20, 2026". */
export function formatDayLabel(ts: number, now: number): string {
  const t = safeTs(ts)
  const diff = differenceInCalendarDays(now, t)
  if (diff === 0) return 'Today'
  if (diff === 1) return 'Yesterday'
  return format(t, 'MMM d, yyyy')
}
