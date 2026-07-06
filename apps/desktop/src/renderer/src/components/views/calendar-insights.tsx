import { Sparkles } from 'lucide-react'

import type { InsightInput } from '@/lib/calendar/build-insights'
import { buildCalendarInsights } from '@/lib/calendar/build-insights'
import { cn } from '@/lib/utils'

const TONE: Record<string, { wrap: string; tag: string; icon: string }> = {
  danger: {
    wrap: 'border-red-500/20 bg-card',
    tag: 'text-red-600 dark:text-red-400',
    icon: 'bg-red-500/10 text-red-500',
  },
  violet: {
    wrap: 'border-violet-500/20 bg-card',
    tag: 'text-violet-600 dark:text-violet-400',
    icon: 'bg-violet-500/10 text-violet-500',
  },
  green: {
    wrap: 'border-emerald-500/20 bg-card',
    tag: 'text-emerald-600 dark:text-emerald-400',
    icon: 'bg-emerald-500/10 text-emerald-500',
  },
}

export function CalendarInsights({ items }: { items: InsightInput[] }): React.JSX.Element | null {
  const insights = buildCalendarInsights(items)
  if (insights.length === 0) return null
  return (
    <div className="flex flex-col gap-2">
      <div className="flex items-center gap-1.5">
        <span className="flex size-5 items-center justify-center rounded-md bg-linear-to-br from-violet-500 to-primary">
          <Sparkles className="size-3 text-white" />
        </span>
        <span className="font-medium text-[13px]">Agent 洞察</span>
      </div>
      {insights.map((ins, i) => {
        const tone = TONE[ins.tone]
        return (
          <div className={cn('rounded-lg border p-3 text-[12px]', tone.wrap)} key={`${ins.kind}-${i}`}>
            <div className={cn('mb-1 font-semibold text-[11.5px]', tone.tag)}>{ins.tag}</div>
            <div className="text-foreground/80 leading-5">{ins.text}</div>
          </div>
        )
      })}
    </div>
  )
}
