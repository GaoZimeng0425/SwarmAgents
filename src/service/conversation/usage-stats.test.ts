import { describe, expect, it } from 'vitest'

import { currentStreak, dayKey, dayKeysEndingAt, rangeCutoffMs, zeroFillDaily } from './usage-stats'

const at = (s: string) => new Date(s) // local-time parse for 'YYYY-MM-DDTHH:mm'

describe('usage-stats helpers', () => {
  it('dayKey formats local YYYY-MM-DD', () => {
    expect(dayKey(at('2026-06-17T09:30'))).toBe('2026-06-17')
  })

  it('dayKeysEndingAt returns ascending keys ending today', () => {
    expect(dayKeysEndingAt(at('2026-06-17T10:00'), 3)).toEqual(['2026-06-15', '2026-06-16', '2026-06-17'])
  })

  it('rangeCutoffMs is start-of-day rangeDays-1 days back', () => {
    expect(rangeCutoffMs(at('2026-06-17T10:00'), 7)).toBe(at('2026-06-11T00:00').getTime())
  })

  it('currentStreak counts consecutive days ending today; gap breaks it', () => {
    const now = at('2026-06-17T10:00')
    expect(currentStreak(new Set(['2026-06-17', '2026-06-16', '2026-06-15']), now)).toBe(3)
    expect(currentStreak(new Set(['2026-06-17', '2026-06-15']), now)).toBe(1)
    expect(currentStreak(new Set(['2026-06-16', '2026-06-15']), now)).toBe(0) // today missing
    expect(currentStreak(new Set(), now)).toBe(0)
  })

  it('zeroFillDaily fills gaps and preserves key order', () => {
    const out = zeroFillDaily([{ date: '2026-06-16', tokens: 50 }], ['2026-06-15', '2026-06-16', '2026-06-17'])
    expect(out).toEqual([
      { date: '2026-06-15', tokens: 0 },
      { date: '2026-06-16', tokens: 50 },
      { date: '2026-06-17', tokens: 0 },
    ])
  })
})
