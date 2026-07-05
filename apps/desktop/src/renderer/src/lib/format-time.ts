// Relative-time formatting for dashboard rows ("X 分钟前" / "昨天" / "X 天前").
// Pure; unit-tested. All inputs/outputs are epoch ms.
//
// Bucket boundaries (for ts <= now):
//   < 1 min   → "刚刚"
//   < 1 hour  → "X 分钟前"
//   < 1 day   → "X 小时前"
//   < 2 days  → "昨天"
//   < 7 days  → "X 天前"
//   else      → localized date (YYYY-MM-DD via toLocaleDateString, varies by locale)
// Future timestamps clamp to "刚刚" (clock skew / optimistic timestamps).

const MIN = 60_000
const HOUR = 60 * MIN
const DAY = 24 * HOUR

export function formatRelativeTime(ts: number, now: number): string {
  const diff = now - ts
  if (diff < MIN) return '刚刚'
  if (diff < HOUR) return `${Math.floor(diff / MIN)} 分钟前`
  if (diff < DAY) return `${Math.floor(diff / HOUR)} 小时前`
  if (diff < 2 * DAY) return '昨天'
  if (diff < 7 * DAY) return `${Math.floor(diff / DAY)} 天前`
  return new Date(ts).toLocaleDateString()
}
