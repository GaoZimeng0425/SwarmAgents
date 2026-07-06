import { Sparkles } from 'lucide-react'

import type { GmailGroupKey } from '@/lib/gmail/classify-thread'
import { cn } from '@/lib/utils'

const GROUPS: { key: GmailGroupKey; label: string; smart: boolean }[] = [
  { key: 'all', label: '全部', smart: false },
  { key: 'reply', label: '待回复', smart: true },
  { key: 'important', label: '重要', smart: true },
  { key: 'archive', label: '可归档', smart: true },
  { key: 'news', label: '资讯', smart: true },
]

export function GmailGroupBar({
  groups,
  active,
  onPick,
}: {
  groups: Record<GmailGroupKey, number>
  active: GmailGroupKey
  onPick: (g: GmailGroupKey) => void
}): React.JSX.Element {
  return (
    <div className="flex flex-wrap items-center gap-2">
      {GROUPS.map((g) => {
        const isActive = active === g.key
        return (
          <button
            className={cn(
              'inline-flex items-center gap-1.5 rounded-full border px-3 py-1 text-xs transition-colors',
              isActive
                ? 'border-foreground bg-foreground text-background'
                : 'border-border bg-card text-foreground/70 hover:bg-accent'
            )}
            key={g.key}
            onClick={() => onPick(g.key)}
            type="button"
          >
            {g.smart ? <Sparkles className={cn('size-3', isActive ? 'text-violet-300' : 'text-violet-500')} /> : null}
            <span className="font-semibold">{g.label}</span>
            <span className={cn('tabular-nums', isActive ? 'text-background/70' : 'text-muted-foreground')}>
              {groups[g.key]}
            </span>
          </button>
        )
      })}
    </div>
  )
}
