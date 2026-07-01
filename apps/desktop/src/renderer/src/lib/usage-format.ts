const countFmt = new Intl.NumberFormat('zh-CN', { notation: 'compact', maximumFractionDigits: 1 })

export function formatCount(n: number): string {
  return countFmt.format(n)
}

export function formatCost(usdCents: number): string {
  return `$${(usdCents / 100).toFixed(2)}`
}

/** Quantile-ish bucket 0..4; 0 only when tokens === 0. */
export function heatmapShade(tokens: number, max: number): 0 | 1 | 2 | 3 | 4 {
  if (tokens <= 0 || max <= 0) return 0
  const ratio = tokens / max
  if (ratio > 0.75) return 4
  if (ratio > 0.5) return 3
  if (ratio > 0.25) return 2
  return 1
}
