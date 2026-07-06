import { describe, expect, it } from 'vitest'

import { formatRelativeTime } from '@/lib/format-time'

// Fixed "now" = 2026-07-05T12:00:00Z (local noon-ish). All inputs are ms.
const NOW = Date.UTC(2026, 5, 5, 12, 0, 0)
const MIN = 60_000
const HOUR = 60 * MIN
const DAY = 24 * HOUR

describe('formatRelativeTime', () => {
  it('returns "刚刚" for < 1 minute', () => {
    expect(formatRelativeTime(NOW - 10_000, NOW)).toBe('刚刚')
    expect(formatRelativeTime(NOW, NOW)).toBe('刚刚')
  })

  it('returns "X 分钟前" for < 1 hour', () => {
    expect(formatRelativeTime(NOW - 1 * MIN, NOW)).toBe('1 分钟前')
    expect(formatRelativeTime(NOW - 30 * MIN, NOW)).toBe('30 分钟前')
    expect(formatRelativeTime(NOW - 59 * MIN, NOW)).toBe('59 分钟前')
  })

  it('returns "X 小时前" for < 24 hours', () => {
    expect(formatRelativeTime(NOW - 1 * HOUR, NOW)).toBe('1 小时前')
    expect(formatRelativeTime(NOW - 5 * HOUR, NOW)).toBe('5 小时前')
    expect(formatRelativeTime(NOW - 23 * HOUR, NOW)).toBe('23 小时前')
  })

  it('returns "昨天" for 24–48 hours', () => {
    expect(formatRelativeTime(NOW - 1 * DAY, NOW)).toBe('昨天')
    expect(formatRelativeTime(NOW - 47 * HOUR, NOW)).toBe('昨天')
  })

  it('returns "X 天前" for 2–6 days', () => {
    expect(formatRelativeTime(NOW - 2 * DAY, NOW)).toBe('2 天前')
    expect(formatRelativeTime(NOW - 6 * DAY, NOW)).toBe('6 天前')
  })

  it('returns a localized date for >= 7 days', () => {
    // Exact format depends on locale; assert it contains the month/day digits.
    const out = formatRelativeTime(NOW - 30 * DAY, NOW)
    expect(out).toMatch(/2026|26/)
  })

  it('clamps future timestamps to "刚刚"', () => {
    expect(formatRelativeTime(NOW + 5 * MIN, NOW)).toBe('刚刚')
  })
})
