import { useEffect, useState } from 'react'
import type { RunRecord, TaskStatus } from '@shared/lib/apply-event'
import { format } from 'date-fns'
import { CalendarClock, Check, ChevronRight, Loader2, X } from 'lucide-react'
import { toast } from 'sonner'

import { TaskTimeline } from '@/components/task-transcript'
import { ScrollArea } from '@/components/ui/scroll-area'
import { useAllCronJobs, useAllCronRuns } from '@/hooks/use-cron'
import { buildScheduledRows, collectSubtree, formatDuration } from '@/lib/scheduled-rows'
import { cn } from '@/lib/utils'

// Status → colored outcome icon, mirroring the calendar's run tones.
function StatusIcon({ status }: { status: TaskStatus }): React.JSX.Element {
  if (status === 'completed') return <Check className="size-4 text-emerald-500" />
  if (status === 'failed') return <X className="size-4 text-destructive" />
  if (status === 'running' || status === 'pending') return <Loader2 className="size-4 animate-spin text-primary" />
  return <span className="text-[10px] text-muted-foreground">●</span>
}

export function ScheduledResultsView({
  tasks,
  focusTaskId,
}: {
  tasks: RunRecord[]
  focusTaskId?: string
}): React.JSX.Element {
  const { data: jobs = [] } = useAllCronJobs()
  const { data: runs = [] } = useAllCronRuns()
  const rows = buildScheduledRows(tasks, runs, jobs)
  const [expanded, setExpanded] = useState<Set<string>>(new Set())

  const toggle = (taskId: string): void =>
    setExpanded((prev) => {
      const next = new Set(prev)
      if (next.has(taskId)) next.delete(taskId)
      else next.add(taskId)
      return next
    })

  // Deep-link (from the calendar's "查看运行记录 →"): expand the focused run's
  // card and scroll it into view with a brief highlight ring. Re-runs as tasks
  // hydrate (rows.length) so it lands once the card is in the DOM.
  useEffect(() => {
    if (!focusTaskId) return
    setExpanded((prev) => (prev.has(focusTaskId) ? prev : new Set(prev).add(focusTaskId)))
    const el = document.querySelector<HTMLElement>(`[data-card-id="${focusTaskId}"]`)
    if (!el) return
    const id = window.setTimeout(() => {
      el.scrollIntoView({ block: 'center', behavior: 'smooth' })
      el.classList.add('ring-2', 'ring-primary', 'ring-offset-2', 'ring-offset-background')
      window.setTimeout(
        () => el.classList.remove('ring-2', 'ring-primary', 'ring-offset-2', 'ring-offset-background'),
        2200
      )
    }, 120)
    return () => window.clearTimeout(id)
  }, [focusTaskId, rows.length])

  const onCopy = (text: string): void => {
    void navigator.clipboard.writeText(text)
    toast.success('Message copied to clipboard')
  }

  if (rows.length === 0) {
    return (
      <div className="flex flex-1 flex-col items-center justify-center gap-3 text-center">
        <CalendarClock className="size-7 text-muted-foreground/40" />
        <p className="text-muted-foreground text-sm">还没有定时任务运行记录</p>
      </div>
    )
  }

  return (
    <ScrollArea className="flex-1">
      <div className="mx-auto flex max-w-3xl flex-col gap-3 p-4">
        {rows.map((row) => {
          const open = expanded.has(row.taskId)
          const preview = row.error ?? row.summary
          return (
            <div
              className="rounded-xl border border-border/60 bg-card/40 transition-colors"
              data-card-id={row.taskId}
              key={row.taskId}
            >
              <button
                className="flex w-full items-center gap-2.5 px-4 py-3 text-left"
                onClick={() => toggle(row.taskId)}
                type="button"
              >
                <StatusIcon status={row.status} />
                <span className="min-w-0 flex-1 truncate font-medium text-sm">{row.name}</span>
                <span className="shrink-0 text-muted-foreground text-xs tabular-nums">
                  {format(row.startedAt, 'MM-dd HH:mm')}
                </span>
                {row.durationMs != null && (
                  <span className="shrink-0 text-muted-foreground/70 text-xs tabular-nums">
                    {formatDuration(row.durationMs)}
                  </span>
                )}
                <ChevronRight
                  className={cn('size-4 shrink-0 text-muted-foreground transition-transform', open && 'rotate-90')}
                />
              </button>
              {!open && preview && (
                <p
                  className={cn(
                    'line-clamp-2 px-4 pb-3 text-xs',
                    row.error ? 'text-destructive' : 'text-foreground/70'
                  )}
                >
                  {preview}
                </p>
              )}
              {open && (
                <div className="user-content flex flex-col gap-4 border-border/50 border-t p-4">
                  <TaskTimeline
                    busy={false}
                    onCopy={onCopy}
                    showDayDividers={false}
                    tasks={collectSubtree(tasks, row.taskId)}
                  />
                </div>
              )}
            </div>
          )
        })}
      </div>
    </ScrollArea>
  )
}
