import { describe, expect, it } from 'vitest'

import { dayKey, formatDayLabel, formatMessageTime } from './timeline'

describe('timeline helpers', () => {
  it('formatMessageTime renders 24h HH:mm', () => {
    const ts = new Date(2026, 5, 23, 9, 5).getTime()
    expect(formatMessageTime(ts)).toBe('09:05')
  })

  it('dayKey groups timestamps by local calendar day', () => {
    const earlyDay1 = new Date(2026, 5, 23, 0, 30).getTime()
    const lateDay1 = new Date(2026, 5, 23, 23, 30).getTime()
    const day2 = new Date(2026, 5, 24, 0, 30).getTime()
    expect(dayKey(earlyDay1)).toBe(dayKey(lateDay1))
    expect(dayKey(earlyDay1)).not.toBe(dayKey(day2))
  })

  it('formatDayLabel shows Today, Yesterday, then an absolute date', () => {
    const now = new Date(2026, 5, 23, 12, 0).getTime()
    expect(formatDayLabel(new Date(2026, 5, 23, 9, 0).getTime(), now)).toBe('Today')
    expect(formatDayLabel(new Date(2026, 5, 22, 9, 0).getTime(), now)).toBe('Yesterday')
    expect(formatDayLabel(new Date(2026, 5, 20, 9, 0).getTime(), now)).toBe('Jun 20, 2026')
  })
})
