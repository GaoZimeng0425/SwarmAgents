import { useMemo, useState } from 'react'
import type { ScheduledTask } from '@shared/types/ui'
import { useNavigate } from '@tanstack/react-router'
import {
  addMonths,
  eachDayOfInterval,
  endOfMonth,
  endOfWeek,
  format,
  isSameDay,
  isSameMonth,
  startOfMonth,
  startOfWeek,
} from 'date-fns'
import { CalendarClock, ChevronLeft, ChevronRight, Trash2 } from 'lucide-react'

import { Button } from '@/components/ui/button'
import { ScrollArea } from '@/components/ui/scroll-area'
import { useAllCronJobs, useCancelCronJob } from '@/hooks/use-cron'
import { occurrencesInRange } from '@/lib/cron-occurrences'
import { cn } from '@/lib/utils'

type Run = { at: Date; task: ScheduledTask }

const WEEK_OPTS = { weekStartsOn: 1 } as const // Monday-first

export function ScheduledCalendarView(): React.JSX.Element {
  const navigate = useNavigate()
  const { data: tasks = [] } = useAllCronJobs()
  const cancel = useCancelCronJob()
  const [month, setMonth] = useState(() => startOfMonth(new Date()))
  const [selected, setSelected] = useState<Date | null>(null)

  const gridStart = startOfWeek(startOfMonth(month), WEEK_OPTS)
  const gridEnd = endOfWeek(endOfMonth(month), WEEK_OPTS)
  const days = useMemo(() => eachDayOfInterval({ start: gridStart, end: gridEnd }), [gridStart, gridEnd])

  // Expand all jobs across the visible grid once, bucketed per ISO day.
  const runsByDay = useMemo(() => {
    const map = new Map<string, Run[]>()
    for (const task of tasks) {
      for (const at of occurrencesInRange(task.cron, gridStart, gridEnd)) {
        const key = format(at, 'yyyy-MM-dd')
        const list = map.get(key) ?? []
        list.push({ at, task })
        map.set(key, list)
      }
    }
    for (const list of map.values()) list.sort((a, b) => a.at.getTime() - b.at.getTime())
    return map
  }, [tasks, gridStart, gridEnd])

  const runsFor = (d: Date): Run[] => runsByDay.get(format(d, 'yyyy-MM-dd')) ?? []
  const selectedRuns = selected ? runsFor(selected) : []

  return (
    <div className="flex h-full">
      <div className="flex min-w-0 flex-1 flex-col p-4">
        <header className="mb-3 flex items-center gap-2">
          <CalendarClock className="size-5 text-primary" />
          <h1 className="font-semibold text-lg">{format(month, 'yyyy 年 M 月')}</h1>
          <div className="ml-auto flex items-center gap-1">
            <Button onClick={() => setMonth(startOfMonth(new Date()))} size="sm" variant="ghost">
              今天
            </Button>
            <Button
              aria-label="Previous month"
              onClick={() => setMonth((m) => addMonths(m, -1))}
              size="icon-sm"
              variant="ghost"
            >
              <ChevronLeft />
            </Button>
            <Button
              aria-label="Next month"
              onClick={() => setMonth((m) => addMonths(m, 1))}
              size="icon-sm"
              variant="ghost"
            >
              <ChevronRight />
            </Button>
          </div>
        </header>
        <div className="grid grid-cols-7 gap-px border-b text-center text-muted-foreground text-xs">
          {['一', '二', '三', '四', '五', '六', '日'].map((d) => (
            <div className="py-1" key={d}>
              {d}
            </div>
          ))}
        </div>
        <div className="grid min-h-0 flex-1 grid-cols-7 gap-px">
          {days.map((day) => {
            const runs = runsFor(day)
            const isToday = isSameDay(day, new Date())
            return (
              <button
                className={cn(
                  'flex flex-col items-start overflow-hidden border p-1 text-left text-xs hover:bg-muted/40',
                  !isSameMonth(day, month) && 'text-muted-foreground/40',
                  selected && isSameDay(day, selected) && 'ring-1 ring-primary'
                )}
                key={day.toISOString()}
                onClick={() => setSelected(day)}
                type="button"
              >
                <span className={cn('mb-0.5 font-medium', isToday && 'text-primary')}>{format(day, 'd')}</span>
                {runs.slice(0, 3).map((r, i) => (
                  <span className="w-full truncate text-[10px] text-primary/80" key={i}>
                    ● {format(r.at, 'HH:mm')} {r.task.name ?? r.task.goal}
                  </span>
                ))}
                {runs.length > 3 && <span className="text-[10px] text-muted-foreground">+{runs.length - 3}</span>}
              </button>
            )
          })}
        </div>
      </div>
      {selected && (
        <aside className="flex w-80 shrink-0 flex-col border-l bg-sidebar/50">
          <div className="flex h-11 items-center border-b px-3 font-medium text-sm">
            {format(selected, 'yyyy-MM-dd')} · {selectedRuns.length} 个运行
          </div>
          <ScrollArea className="min-h-0 flex-1">
            <div className="flex flex-col gap-2 p-3">
              {selectedRuns.length === 0 && <p className="text-muted-foreground text-sm">当天无定时任务。</p>}
              {selectedRuns.map((r, i) => (
                <div className="rounded-lg border bg-background/50 p-3 text-sm" key={`${r.task.id}-${i}`}>
                  <div className="flex items-start justify-between gap-2">
                    <span className="font-medium">
                      {format(r.at, 'HH:mm')} · {r.task.name ?? '(unnamed)'}
                    </span>
                    <Button
                      aria-label="Cancel task"
                      className="size-7 shrink-0 text-muted-foreground hover:text-destructive"
                      onClick={() => cancel.mutate(r.task.id)}
                      size="icon"
                      variant="ghost"
                    >
                      <Trash2 className="size-4" />
                    </Button>
                  </div>
                  <p className="mt-1 text-muted-foreground text-xs">{r.task.sessionTitle ?? 'Untitled chat'}</p>
                  <p className="mt-2 line-clamp-3 text-foreground/80 text-xs">{r.task.goal}</p>
                  <button
                    className="mt-2 text-primary text-xs hover:underline"
                    onClick={() =>
                      void navigate({ to: '/session/$sessionId', params: { sessionId: r.task.sessionId } })
                    }
                    type="button"
                  >
                    打开会话 →
                  </button>
                </div>
              ))}
            </div>
          </ScrollArea>
        </aside>
      )}
    </div>
  )
}
