import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip'
import { formatTokens } from '@/lib/format-usage'
import { cn } from '@/lib/utils'

type Props = {
  /** Latest turn's context occupancy in tokens. */
  used: number
  /** Model's context-window size in tokens. */
  window: number
  /** Cumulative spend in USD cents, for the tooltip. */
  usdCents?: number
}

const R = 7
const CIRC = 2 * Math.PI * R

/** Circular progress ring showing how full the model's context window is. */
export function ContextRing({ used, window, usdCents }: Props): React.JSX.Element | null {
  if (!window) return null
  const pct = Math.min(1, used / window)
  const color = pct > 0.9 ? 'text-red-500' : pct > 0.75 ? 'text-amber-500' : 'text-primary'

  const tip = [`${formatTokens(used)} / ${formatTokens(window)} tokens (${Math.round(pct * 100)}%)`]
  if (usdCents && usdCents > 0) tip.push(`$${(usdCents / 100).toFixed(2)}`)

  return (
    <Tooltip>
      <TooltipTrigger
        aria-label="Context window usage"
        className="flex items-center gap-1.5 text-muted-foreground text-xs tabular-nums"
        type="button"
      >
        <svg aria-hidden="true" className={cn('-rotate-90', color)} height="20" viewBox="0 0 20 20" width="20">
          <circle className="text-border" cx="10" cy="10" fill="none" r={R} stroke="currentColor" strokeWidth="2.5" />
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
        <span>{Math.round(pct * 100)}%</span>
      </TooltipTrigger>
      <TooltipContent>{tip.join(' · ')}</TooltipContent>
    </Tooltip>
  )
}
