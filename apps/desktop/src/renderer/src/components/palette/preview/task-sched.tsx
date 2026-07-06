// apps/desktop/src/renderer/src/components/palette/preview/task-sched.tsx
// Scheduled (cron) task preview: name/cron as title + key/value rows for the
// cron expression, next run, and last run, plus a 上次结果 readout. Timestamps
// are stored as epoch ms; format them locally.
import type { PreviewData } from '../../../lib/palette/types'

export type TaskSchedPreviewData = Extract<PreviewData, { type: 'taskSched' }>

export function TaskSchedPreview({ data }: { data: TaskSchedPreviewData }): React.JSX.Element {
  const { task } = data
  const rows: { label: string; value: string }[] = [
    { label: 'cron 表达式', value: task.cron },
    { label: '下次运行', value: formatTs(task.nextRun) },
    { label: '上次运行', value: formatTs(task.lastRun) },
  ]
  return (
    <div className="p-4">
      <h4 className="font-semibold text-sm">{task.name ?? task.cron}</h4>
      <dl className="mt-3 space-y-1.5 text-xs">
        {rows.map((r) => (
          <div className="flex justify-between gap-3" key={r.label}>
            <dt className="text-muted-foreground">{r.label}</dt>
            <dd className="truncate text-right font-medium">{r.value}</dd>
          </div>
        ))}
      </dl>
      <div className="mt-3 text-muted-foreground text-xs">上次结果</div>
      <div className="mt-1 font-medium text-xs">{task.lastStatus ?? '—'}</div>
    </div>
  )
}

function formatTs(ms: number | null): string {
  if (ms == null) return '—'
  try {
    return new Date(ms).toLocaleString()
  } catch {
    return String(ms)
  }
}
