import { describe, expect, it } from 'vitest'

import { formatCost, formatCount, heatmapShade } from './usage-format'

describe('usage-format', () => {
  it('formats counts compactly (zh-CN 万)', () => {
    expect(formatCount(2_418_000)).toContain('万')
    expect(formatCount(0)).toBe('0')
  })

  it('formats cost from usdCents', () => {
    expect(formatCost(1234)).toBe('$12.34')
    expect(formatCost(0)).toBe('$0.00')
  })

  it('buckets heatmap shades 0..4', () => {
    expect(heatmapShade(0, 100)).toBe(0)
    expect(heatmapShade(100, 100)).toBe(4)
    expect(heatmapShade(1, 100)).toBe(1)
    expect(heatmapShade(50, 0)).toBe(0) // guard divide-by-zero
  })
})
