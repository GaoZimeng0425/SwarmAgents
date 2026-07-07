// The 最近完成 section: recently-ended sessions as rows (green check + name +
// relative time). Clicking a row reopens the session. Empty state when none.

import { useNavigate } from '@tanstack/react-router'
import { Check, CheckCircle2 } from 'lucide-react'

import { DashboardEmpty } from '@/components/views/dashboard/dashboard-empty'
import type { DashboardRecentRow } from '@/lib/dashboard-recent'
import { formatRelativeTime } from '@/lib/format-time'
import { cn } from '@/lib/utils'

type Props = { rows: DashboardRecentRow[]; now: number }

export function RecentList({ rows, now }: Props): React.JSX.Element | null {
  const navigate = useNavigate()

  if (rows.length === 0) {
    return (
      <section>
        <h2 className="mb-3 font-semibold text-[13px] text-foreground">最近完成</h2>
        <DashboardEmpty icon={CheckCircle2}>还没有完成的任务。完成的会话会显示在这里。</DashboardEmpty>
      </section>
    )
  }

  return (
    <section>
      <h2 className="mb-3 font-semibold text-[13px] text-foreground">最近完成</h2>
      <ul className="overflow-hidden rounded-2xl border border-border bg-secondary">
        {rows.map((r, i) => (
          <li
            className={cn('flex items-center gap-2.5 px-4 py-3', i < rows.length - 1 && 'border-border/60 border-b')}
            key={r.id}
          >
            <button
              className="flex w-full items-center gap-2.5 text-left"
              onClick={() => void navigate({ to: '/session/$sessionId', params: { sessionId: r.id } })}
              type="button"
            >
              <span className="flex size-3.5 shrink-0 items-center justify-center">
                <Check aria-hidden="true" className="size-3.5 stroke-[2.4px] text-emerald-600 dark:text-emerald-400" />
              </span>
              <span className="min-w-0 flex-1 truncate text-[13px] text-foreground">{r.name}</span>
              <span className="shrink-0 text-[11.5px] text-muted-foreground">
                {formatRelativeTime(r.lastActiveAt, now)}
              </span>
            </button>
          </li>
        ))}
      </ul>
    </section>
  )
}
