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
import { CalendarClock, ChevronLeft, ChevronRight, PanelRightClose, Trash2 } from 'lucide-react'

import { Button } from '@/components/ui/button'
import { ScrollArea } from '@/components/ui/scroll-area'
import { useAllCronJobs, useCancelCronJob } from '@/hooks/use-cron'
import { occurrencesInRange } from '@/lib/cron-occurrences'
import { cn } from '@/lib/utils'

type Run = { at: Date; task: ScheduledTask }

const WEEK_OPTS = { weekStartsOn: 1 } as const // Monday-first
const WEEKDAYS = ['一', '二', '三', '四', '五', '六', '日']

export function ScheduledCalendarView(): React.JSX.Element {
  const navigate = useNavigate()
  const { data: tasks = [] } = useAllCronJobs()
  const cancel = useCancelCronJob()
  const [month, setMonth] = useState(() => startOfMonth(new Date()))
  const [selected, setSelected] = useState<Date | null>(null)

  const monthStart = startOfMonth(month)
  const gridStart = startOfWeek(monthStart, WEEK_OPTS)
  const gridEnd = endOfWeek(endOfMonth(month), WEEK_OPTS)
  const days = useMemo(() => eachDayOfInterval({ start: gridStart, end: gridEnd }), [gridStart, gridEnd])

  // Expand every job across the visible grid once. Each task only counts from
  // its own creation time, so runs before createdAt are dropped — a schedule
  // created today never back-fills the previous months.
  const runsByDay = useMemo(() => {
    const map = new Map<string, Run[]>()
    for (const task of tasks) {
      const effectiveFrom = new Date(Math.max(gridStart.getTime(), task.createdAt))
      for (const at of occurrencesInRange(task.cron, effectiveFrom, gridEnd)) {
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
  const totalThisMonth = useMemo(() => {
    let n = 0
    for (let i = 1; i <= 31; i++) {
      const key = format(new Date(month.getFullYear(), month.getMonth(), i), 'yyyy-MM-dd')
      n += runsByDay.get(key)?.length ?? 0
    }
    return n
  }, [runsByDay, month])

  // Clicking the already-selected day toggles the detail panel closed again.
  const pick = (day: Date): void => setSelected((cur) => (cur && isSameDay(cur, day) ? null : day))

  return (
    <div className="flex h-full">
      <div className="flex min-w-0 flex-1 flex-col px-6 pt-5 pb-4">
        <header className="mb-4 flex items-center gap-3">
          <div className="flex items-center gap-2.5">
            <CalendarClock className="size-[18px] text-primary" />
            <h1 className="font-semibold text-[17px] tracking-tight">{format(month, 'yyyy 年 M 月')}</h1>
            <span className="text-muted-foreground text-xs tabular-nums">{totalThisMonth} 次运行</span>
          </div>
          <div className="ml-auto flex items-center gap-1">
            <Button onClick={() => setMonth(startOfMonth(new Date()))} size="sm" variant="ghost">
              今天
            </Button>
            <div className="mx-1 flex items-center rounded-md border border-border/60">
              <Button
                aria-label="Previous month"
                className="rounded-r-none border-border/60 border-r"
                onClick={() => setMonth((m) => addMonths(m, -1))}
                size="icon-sm"
                variant="ghost"
              >
                <ChevronLeft />
              </Button>
              <Button
                aria-label="Next month"
                className="rounded-l-none"
                onClick={() => setMonth((m) => addMonths(m, 1))}
                size="icon-sm"
                variant="ghost"
              >
                <ChevronRight />
              </Button>
            </div>
          </div>
        </header>

        <div className="grid grid-cols-7 border-border/60 border-b font-medium text-[11px] text-muted-foreground uppercase">
          {WEEKDAYS.map((d) => (
            <div className="px-2 py-2 text-center" key={d}>
              {d}
            </div>
          ))}
        </div>

        <div className="grid min-h-0 flex-1 grid-cols-7 grid-rows-6 gap-px">
          {days.map((day) => {
            const runs = runsFor(day)
            const inMonth = isSameMonth(day, month)
            const isToday = isSameDay(day, new Date())
            const isSelected = !!selected && isSameDay(day, selected)
            return (
              <button
                className={cn(
                  'group/cell relative m-0 flex min-h-0 flex-col overflow-hidden rounded-md border border-border/40 px-1.5 py-1 text-left transition-colors',
                  'hover:bg-muted/50 focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring',
                  !inMonth && 'opacity-40',
                  isSelected && 'bg-primary/10 ring-1 ring-primary/40 ring-inset'
                )}
                key={day.toISOString()}
                onClick={() => pick(day)}
                type="button"
              >
                <span
                  className={cn(
                    'mb-1 flex size-[22px] items-center justify-center self-start rounded-full font-medium text-[11px] tabular-nums',
                    isToday ? 'bg-primary text-primary-foreground' : 'text-foreground/80',
                    !inMonth && !isToday && 'text-muted-foreground'
                  )}
                >
                  {format(day, 'd')}
                </span>

                <div className="flex min-h-0 flex-1 flex-col gap-0.5 overflow-hidden">
                  {runs.slice(0, 3).map((r) => (
                    <span
                      className="flex items-center gap-1 truncate rounded bg-primary/10 px-1 text-[10px] text-primary leading-tight"
                      key={r.at.getTime()}
                      title={`${format(r.at, 'HH:mm')} · ${r.task.name ?? r.task.goal}`}
                    >
                      <span className="shrink-0 tabular-nums">{format(r.at, 'HH:mm')}</span>
                      <span className="truncate">{r.task.name ?? r.task.goal}</span>
                    </span>
                  ))}
                  {runs.length > 3 && (
                    <span className="px-1 text-[10px] text-muted-foreground">+{runs.length - 3}</span>
                  )}
                </div>
              </button>
            )
          })}
        </div>
      </div>

      {selected && (
        <aside className="flex w-[300px] shrink-0 flex-col border-border/60 border-l bg-sidebar/40 backdrop-blur-sm">
          <div className="flex h-12 items-center justify-between border-border/60 border-b px-4">
            <div className="flex flex-col leading-tight">
              <span className="font-medium text-[13px]">{format(selected, 'M 月 d 日 EEEE')}</span>
              <span className="text-[11px] text-muted-foreground tabular-nums">
                {selectedRuns.length > 0 ? `${selectedRuns.length} 个定时任务` : '当天无任务'}
              </span>
            </div>
            <Button
              aria-label="收起详情"
              className="size-7 text-muted-foreground hover:text-foreground"
              onClick={() => setSelected(null)}
              size="icon-sm"
              variant="ghost"
            >
              <PanelRightClose className="size-4" />
            </Button>
          </div>

          <ScrollArea className="min-h-0 flex-1">
            <div className="flex flex-col gap-2 p-3">
              {selectedRuns.length === 0 && (
                <div className="mt-10 flex flex-col items-center gap-2 text-center">
                  <CalendarClock className="size-7 text-muted-foreground/40" />
                  <p className="text-muted-foreground text-xs">这一天没有定时任务</p>
                </div>
              )}
              {selectedRuns.map((r) => (
                <div
                  className="rounded-lg border border-border/60 bg-card/50 p-3 text-[13px] transition-colors hover:bg-accent/40"
                  key={r.at.getTime()}
                >
                  <div className="flex items-start justify-between gap-2">
                    <div className="flex min-w-0 flex-col">
                      <span className="font-medium text-primary tabular-nums">{format(r.at, 'HH:mm')}</span>
                      <span className="mt-0.5 truncate">{r.task.name ?? '(未命名)'}</span>
                    </div>
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
                  {r.task.sessionTitle && (
                    <p className="mt-1.5 truncate text-[11px] text-muted-foreground">{r.task.sessionTitle}</p>
                  )}
                  <p className="mt-1.5 line-clamp-3 text-foreground/70 text-xs">{r.task.goal}</p>
                  <button
                    className="mt-2 text-[11px] text-primary hover:underline"
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
