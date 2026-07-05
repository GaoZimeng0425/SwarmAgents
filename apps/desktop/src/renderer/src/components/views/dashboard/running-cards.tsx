// The 进行中 section: header (label + count of running/pending) and a card wall
// of running and awaiting-approval cards. Empty state when nothing is active.
//
// Count rule (locked): the header count = running.length ONLY (pending+running),
// not awaiting — matching the top-bar pill. Awaiting cards still render here.

import { RunningCard } from '@/components/views/dashboard/running-card'
import type { DashboardRun } from '@/lib/dashboard-runs'

type Props = { running: DashboardRun[]; awaiting: DashboardRun[] }

export function RunningCards({ running, awaiting }: Props): React.JSX.Element | null {
  const total = running.length + awaiting.length
  if (total === 0) {
    return (
      <section>
        <h2 className="mb-3 font-semibold text-[13px] text-foreground">进行中</h2>
        <p className="rounded-xl border border-border border-dashed bg-muted/20 px-4 py-6 text-center text-[13px] text-muted-foreground">
          暂无运行中的任务。从上方描述一个目标开始。
        </p>
      </section>
    )
  }

  return (
    <section>
      <h2 className="mb-3 flex items-baseline gap-2 font-semibold text-[13px] text-foreground">
        进行中
        <span className="text-[12px] text-muted-foreground tabular-nums">{running.length}</span>
      </h2>
      <div className="grid grid-cols-1 gap-3 sm:grid-cols-2 lg:grid-cols-3">
        {running.map((r) => (
          <RunningCard key={r.id} run={r} />
        ))}
        {awaiting.map((r) => (
          <RunningCard key={r.id} run={r} />
        ))}
      </div>
    </section>
  )
}
