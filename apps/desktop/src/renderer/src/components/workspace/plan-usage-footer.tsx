// apps/desktop/src/renderer/src/components/workspace/plan-usage-footer.tsx
// Tiny footer for the 计划 tab: elapsed-since-first-run duration + session token total.

import type { RunRecord } from '@shared/lib/apply-event'

import { useNow } from '@/hooks/use-now'

type Props = {
  runs: RunRecord[]
  /** Session.tokensUsed (cumulative). Treat undefined/0 as hidden. */
  tokensUsed?: number
}

function formatDuration(ms: number): string {
  if (ms < 60_000) return `${Math.max(1, Math.round(ms / 1000))} 秒`
  const min = Math.floor(ms / 60_000)
  const sec = Math.round((ms % 60_000) / 1_000)
  return sec > 0 ? `${min} 分 ${sec} 秒` : `${min} 分`
}

function formatTokens(n: number): string {
  return n >= 1000 ? `${(n / 1000).toFixed(1)}k` : String(n)
}

export function PlanUsageFooter({ runs, tokensUsed }: Props): React.JSX.Element {
  const now = useNow()
  const firstStart = runs.length > 0 ? Math.min(...runs.map((r) => r.startedAt)) : null
  const duration = firstStart ? formatDuration(Math.max(0, now - firstStart)) : '—'
  const tokens = tokensUsed ? formatTokens(tokensUsed) : null
  return (
    <div className="flex items-center justify-between px-1 py-2 text-[11.5px] text-muted-foreground">
      <span>用时 {duration}</span>
      {tokens && <span>{tokens} tokens</span>}
    </div>
  )
}
