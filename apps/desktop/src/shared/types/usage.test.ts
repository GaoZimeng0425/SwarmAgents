import { describe, expect, it } from 'vitest'

import { HEATMAP_DAYS, UsageStatsSchema } from './usage'

describe('UsageStatsSchema', () => {
  it('parses a well-formed stats object', () => {
    const ok = UsageStatsSchema.safeParse({
      rangeDays: 30,
      totals: {
        tokens: 100,
        cacheRead: 40,
        usdCents: 5,
        sessions: 2,
        messages: 8,
        activeDays: 1,
        currentStreak: 1,
        topModel: { model: 'GLM-5.2', tokens: 100, usdCents: 5, pct: 100 },
      },
      daily: [{ date: '2026-06-17', tokens: 100 }],
      dailyByModel: [{ date: '2026-06-17', model: 'GLM-5.2', tokens: 100 }],
      byModel: [{ model: 'GLM-5.2', tokens: 100, usdCents: 5, pct: 100 }],
      heatmap: [{ date: '2026-06-17', tokens: 100 }],
    })
    expect(ok.success).toBe(true)
  })

  it('rejects an invalid rangeDays and exposes the heatmap window', () => {
    expect(UsageStatsSchema.safeParse({ rangeDays: 99 }).success).toBe(false)
    expect(HEATMAP_DAYS).toBe(364)
  })
})
