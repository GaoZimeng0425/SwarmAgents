// The 定时任务 section: a card of upcoming cron jobs (next-run time + name +
// status). "查看日历 →" links to /scheduled. Empty state when no jobs exist.

import { useNavigate } from '@tanstack/react-router'
import { ArrowRight, CalendarClock } from 'lucide-react'

import { DashboardEmpty } from '@/components/views/dashboard/dashboard-empty'
import type { DashboardCronRow } from '@/lib/dashboard-cron'
import { cn } from '@/lib/utils'

type Props = { rows: DashboardCronRow[] }

const STATUS_TONE: Record<DashboardCronRow['statusKind'], string> = {
  success: 'text-emerald-600 dark:text-emerald-400',
  failed: 'text-red-500 dark:text-red-400',
  pending: 'text-muted-foreground',
}

export function ScheduledList({ rows }: Props): React.JSX.Element | null {
  const navigate = useNavigate()

  if (rows.length === 0) {
    return (
      <section>
        <h2 className="mb-3 font-semibold text-[13px] text-foreground">定时任务</h2>
        <DashboardEmpty icon={CalendarClock}>暂无定时任务。在「对话」中创建一个定时任务后会显示在这里。</DashboardEmpty>
      </section>
    )
  }

  return (
    <section>
      <h2 className="mb-3 flex items-baseline gap-2 font-semibold text-[13px] text-foreground">
        定时任务
        <button
          className="ml-auto flex items-center gap-1 font-medium text-[12px] text-primary hover:underline"
          onClick={() => void navigate({ to: '/scheduled' })}
          type="button"
        >
          查看日历
          <ArrowRight aria-hidden="true" className="size-3" />
        </button>
      </h2>
      <ul className="overflow-hidden rounded-2xl border border-border bg-secondary">
        {rows.map((r, i) => (
          <li
            className={cn('flex items-center gap-2.5 px-4 py-3', i < rows.length - 1 && 'border-border/60 border-b')}
            key={r.id}
          >
            <span className="w-16 shrink-0 font-mono text-[12px] text-muted-foreground">{r.timeLabel}</span>
            <span className="min-w-0 flex-1 truncate text-[13px] text-foreground">{r.name}</span>
            <span className={cn('shrink-0 text-[11.5px]', STATUS_TONE[r.statusKind])}>{r.statusLabel}</span>
          </li>
        ))}
      </ul>
    </section>
  )
}
