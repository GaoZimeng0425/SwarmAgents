import type { ResourceBudget } from '@shared/types/task'

export const formatTokens = (n: number): string => (n >= 1000 ? `${(n / 1000).toFixed(1)}k` : `${n}`)

/** Compact one-line resource summary for a task, e.g. "1.5k tok · 3 calls · $0.07". */
export function formatUsage(used: ResourceBudget): string {
  const parts = [`${formatTokens(used.tokens)} tok`, `${used.calls} call${used.calls === 1 ? '' : 's'}`]
  if (used.usdCents > 0) parts.push(`$${(used.usdCents / 100).toFixed(2)}`)
  return parts.join(' · ')
}
