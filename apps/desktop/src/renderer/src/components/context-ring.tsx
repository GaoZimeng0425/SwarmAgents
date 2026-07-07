import { HoverCard, HoverCardContent, HoverCardTrigger } from '@swarm/ui'

import { formatTokens } from '@/lib/format-usage'
import { cn } from '@/lib/utils'

type Props = {
  /** Latest turn's context occupancy in tokens. */
  used: number
  /** Model's context-window size in tokens. */
  window: number
  /** Cumulative spend in USD cents. */
  usdCents?: number
  /** Latest turn's cache-hit (read) tokens. */
  cacheRead?: number
}

const R = 7
const CIRC = 2 * Math.PI * R

function Row({ label, value }: { label: string; value: string }): React.JSX.Element {
  return (
    <div className="flex items-center justify-between gap-6">
      <span className="text-muted-foreground">{label}</span>
      <span className="font-medium text-foreground tabular-nums">{value}</span>
    </div>
  )
}

/**
 * Circular context-window gauge in the composer. Hovering opens a small panel
 * with the token / cache / cost breakdown (the transcript no longer repeats it).
 */
export function ContextRing({ used, window, usdCents, cacheRead }: Props): React.JSX.Element | null {
  if (!window) return null
  const pct = Math.min(1, used / window)
  const pctLabel = Math.round(pct * 100)
  const color = pct > 0.9 ? 'text-red-500' : pct > 0.75 ? 'text-amber-500' : 'text-primary'

  return (
    <HoverCard>
      <HoverCardTrigger
        render={
          <button
            aria-label="上下文用量"
            className="flex items-center rounded-full outline-hidden focus-visible:ring-2 focus-visible:ring-ring"
            type="button"
          >
            <svg aria-hidden="true" className={cn('-rotate-90', color)} height="20" viewBox="0 0 20 20" width="20">
              <circle
                className="text-border"
                cx="10"
                cy="10"
                fill="none"
                r={R}
                stroke="currentColor"
                strokeWidth="2.5"
              />
              <circle
                cx="10"
                cy="10"
                fill="none"
                r={R}
                stroke="currentColor"
                strokeDasharray={CIRC}
                strokeDashoffset={CIRC * (1 - pct)}
                strokeLinecap="round"
                strokeWidth="2.5"
              />
            </svg>
          </button>
        }
      />
      <HoverCardContent align="end" className="w-56 p-0" side="top">
        <div className="flex items-center justify-between border-border/60 border-b px-3.5 py-2.5">
          <span className="font-medium text-[13px]">上下文窗口</span>
          <span className={cn('font-semibold text-[13px] tabular-nums', color)}>{pctLabel}%</span>
        </div>
        <div className="flex flex-col gap-2 px-3.5 py-3 text-[12.5px]">
          <Row label="已用" value={`${formatTokens(used)} / ${formatTokens(window)}`} />
          {cacheRead && used > 0 ? (
            <Row label="缓存命中" value={`${formatTokens(cacheRead)} · ${Math.round((cacheRead / used) * 100)}%`} />
          ) : null}
          {usdCents && usdCents > 0 ? <Row label="本会话花费" value={`$${(usdCents / 100).toFixed(2)}`} /> : null}
        </div>
      </HoverCardContent>
    </HoverCard>
  )
}
