import type { ResourceBudget } from '@swarm/protocol'

export const formatTokens = (n: number): string => (n >= 1000 ? `${(n / 1000).toFixed(1)}k` : `${n}`)

/** Compact one-line resource summary for a task, e.g. "1.5k used · 3 calls · $0.07". */
export function formatUsage(used: ResourceBudget): string {
  const parts = [`${formatTokens(used.tokens)} used`, `${used.calls} call${used.calls === 1 ? '' : 's'}`]
  if (used.usdCents > 0) parts.push(`$${(used.usdCents / 100).toFixed(2)}`)
  return parts.join(' · ')
}

/** Multi-line hover explanation for the compact usage summary above. */
export function usageTooltip(used: ResourceBudget): string {
  return [
    `${used.tokens.toLocaleString()} tokens in the conversation right now (current context size, not a running total)`,
    `${used.calls} tool call${used.calls === 1 ? '' : 's'} made`,
    `$${(used.usdCents / 100).toFixed(2)} spent so far`,
  ].join('\n')
}
