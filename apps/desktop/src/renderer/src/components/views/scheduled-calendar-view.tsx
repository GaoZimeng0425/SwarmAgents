import { useEffect, useMemo, useState } from 'react'
import type { CalendarEvent, CronRun, ScheduledTask } from '@swarm/protocol'
import { SYSTEM_SESSION_ID } from '@swarm/shared'
import { Button, Input } from '@swarm/ui'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { useNavigate } from '@tanstack/react-router'
import {
  addMonths,
  eachDayOfInterval,
  endOfMonth,
  endOfWeek,
  format,
  formatDistanceToNow,
  isSameDay,
  isSameMonth,
  startOfMonth,
  startOfWeek,
} from 'date-fns'
import { zhCN } from 'date-fns/locale'
import { sortBy } from 'es-toolkit'
import {
  CalendarClock,
  Check,
  ChevronLeft,
  ChevronRight,
  Loader2,
  Mail,
  PanelRightClose,
  Plus,
  RefreshCw,
  Trash2,
  X,
} from 'lucide-react'

import { HtmlText } from '@/components/html-text'
import { ScrollArea } from '@/components/ui/scroll-area'
import { CalendarInsights } from '@/components/views/calendar-insights'
import { useCalendarEvents, useCreateLocalEvent, useDeleteLocalEvent } from '@/hooks/use-calendar'
import { useAllCronJobs, useAllCronRuns, useCancelCronJob } from '@/hooks/use-cron'
import { swarmApi } from '@/lib/api'
import type { InsightInput } from '@/lib/calendar/build-insights'
import { occurrencesInRange } from '@/lib/cron-occurrences'
import { cn } from '@/lib/utils'

// A calendar entry is an actual past execution (with status, openable), a
// projected future cron occurrence, or a calendar event (Google cached or
// app-local).
type DayItem =
  | { kind: 'run'; at: Date; run: CronRun; task: ScheduledTask | undefined }
  | { kind: 'projection'; at: Date; task: ScheduledTask }
  | { kind: 'event'; at: Date; event: CalendarEvent }

const itemLabel = (it: DayItem): string =>
  it.kind === 'run'
    ? (it.task?.name ?? it.task?.goal ?? '(已删除任务)')
    : it.kind === 'projection'
      ? (it.task.name ?? it.task.goal)
      : it.event.title

// Run status → a colored dot / icon. Past actuals show outcome; projections are hollow.
const runTone = (status: string): string =>
  status === 'completed'
    ? 'text-emerald-500'
    : status === 'failed' || status === 'error'
      ? 'text-destructive'
      : status === 'running'
        ? 'text-primary'
        : 'text-muted-foreground'

const WEEK_OPTS = { weekStartsOn: 1 } as const // Monday-first
const WEEKDAYS = ['一', '二', '三', '四', '五', '六', '日']

// event pill classes by source.
const eventPillTone = (ev: CalendarEvent): string =>
  ev.source === 'google'
    ? 'bg-blue-500/10 text-blue-600 dark:text-blue-400'
    : 'bg-violet-500/10 text-violet-600 dark:text-violet-400'

const eventDot = (ev: CalendarEvent): string => (ev.source === 'google' ? 'text-blue-500' : 'text-violet-500')

export function ScheduledCalendarView(): React.JSX.Element {
  const navigate = useNavigate()
  const qc = useQueryClient()
  const { data: tasks = [] } = useAllCronJobs()
  const { data: runs = [] } = useAllCronRuns()
  const cancel = useCancelCronJob()
  const [month, setMonth] = useState(() => startOfMonth(new Date()))
  const [selected, setSelected] = useState<Date | null>(null)

  const monthStart = startOfMonth(month)
  const gridStart = startOfWeek(monthStart, WEEK_OPTS)
  const gridEnd = endOfWeek(endOfMonth(month), WEEK_OPTS)
  const days = useMemo(() => eachDayOfInterval({ start: gridStart, end: gridEnd }), [gridStart, gridEnd])

  // Calendar events (Google cached + local) for the visible grid range.
  const { data: events = [] } = useCalendarEvents(gridStart, gridEnd)
  const createLocal = useCreateLocalEvent()
  const deleteLocal = useDeleteLocalEvent()

  // Linked Google account — surfaced in the header so it's clear whose calendar
  // this is. Kept live by the calendarOnStateChanged invalidation below.
  const { data: calStatus } = useQuery({
    queryKey: ['calendar', 'status'],
    queryFn: () => swarmApi.calendarGetStatus(),
  })

  // Manual "refresh" pulls the Google calendar cache now instead of waiting for
  // the background daemon's next poll. State refetches via calendarOnStateChanged.
  const sync = useMutation({
    mutationFn: () => swarmApi.calendarSyncNow(),
    onSettled: () => qc.invalidateQueries({ queryKey: ['calendar'] }),
  })

  // Background daemon syncs push calendar:stateChanged; refetch the range.
  useEffect(
    () =>
      swarmApi.calendarOnStateChanged(() => {
        void qc.invalidateQueries({ queryKey: ['calendar'] })
      }),
    [qc]
  )

  // Re-render once a minute so the relative "last synced" label stays fresh
  // between syncs (nothing else re-renders this header while idle).
  const [, setNowTick] = useState(0)
  useEffect(() => {
    const id = setInterval(() => setNowTick((t) => t + 1), 60_000)
    return () => clearInterval(id)
  }, [])
  const lastSyncedLabel =
    calStatus?.lastSyncAt != null ? formatDistanceToNow(calStatus.lastSyncAt, { addSuffix: true, locale: zhCN }) : null

  // Inline "new local event" form state (scoped to the selected day).
  const [showCreate, setShowCreate] = useState(false)
  const [draftTitle, setDraftTitle] = useState('')
  const [draftStart, setDraftStart] = useState('')
  const [draftEnd, setDraftEnd] = useState('')

  // Past/today shows what ACTUALLY ran (cron_runs, with outcome); the future
  // shows projections from the cron expression. Calendar events merge in by
  // start time. A projected slot in the past that never produced a run is
  // intentionally absent — the calendar reflects history, not just the schedule.
  const itemsByDay = useMemo(() => {
    const map = new Map<string, DayItem[]>()
    const push = (at: Date, item: DayItem): void => {
      const key = format(at, 'yyyy-MM-dd')
      const list = map.get(key) ?? []
      list.push(item)
      map.set(key, list)
    }
    const taskById = new Map(tasks.map((t) => [t.id, t]))
    for (const run of runs) {
      const at = new Date(run.triggeredAt)
      if (at < gridStart || at > gridEnd) continue
      push(at, { kind: 'run', at, run, task: taskById.get(run.jobId) })
    }
    const now = new Date()
    for (const task of tasks) {
      const from = new Date(Math.max(gridStart.getTime(), task.createdAt, now.getTime()))
      for (const at of occurrencesInRange(task.cron, from, gridEnd)) {
        push(at, { kind: 'projection', at, task })
      }
    }
    for (const ev of events) {
      const at = new Date(ev.startMs)
      if (at < gridStart || at > gridEnd) continue
      push(at, { kind: 'event', at, event: ev })
    }
    for (const [key, list] of map) map.set(key, sortBy(list, [(i) => i.at.getTime()]))
    return map
  }, [tasks, runs, events, gridStart, gridEnd])

  const itemsFor = (d: Date): DayItem[] => itemsByDay.get(format(d, 'yyyy-MM-dd')) ?? []
  const selectedItems = selected ? itemsFor(selected) : []
  const totalThisMonth = useMemo(() => {
    let n = 0
    for (let i = 1; i <= 31; i++) {
      const key = format(new Date(month.getFullYear(), month.getMonth(), i), 'yyyy-MM-dd')
      n += itemsByDay.get(key)?.length ?? 0
    }
    return n
  }, [itemsByDay, month])

  // Open the transcript of a specific run inside the system session, scrolled
  // to that execution's task.
  const openRun = (runId: string): void => {
    void navigate({ to: '/session/$sessionId', params: { sessionId: SYSTEM_SESSION_ID }, search: { task: runId } })
  }

  // Clicking the already-selected day toggles the detail panel closed again.
  const pick = (day: Date): void => setSelected((cur) => (cur && isSameDay(cur, day) ? null : day))

  const resetDraft = (): void => {
    setDraftTitle('')
    setDraftStart('')
    setDraftEnd('')
    setShowCreate(false)
  }

  const submitDraft = (): void => {
    const title = draftTitle.trim()
    if (!title || !draftStart || !selected) return
    const startMs = Date.parse(`${format(selected, 'yyyy-MM-dd')}T${draftStart}`)
    if (Number.isNaN(startMs)) return
    const endMs = draftEnd ? Date.parse(`${format(selected, 'yyyy-MM-dd')}T${draftEnd}`) : startMs + 60 * 60 * 1000
    if (Number.isNaN(endMs) || endMs < startMs) return
    createLocal.mutate({ title, startMs, endMs })
    resetDraft()
  }

  return (
    <div className="flex h-full">
      <div className="flex min-w-0 flex-1 flex-col px-6 pt-5 pb-4">
        <header className="mb-4 flex items-center gap-3">
          <div className="flex items-center gap-2.5">
            <CalendarClock className="size-[18px] text-primary" />
            <h1 className="font-semibold text-[17px] tracking-tight">{format(month, 'yyyy 年 M 月')}</h1>
            <span className="text-muted-foreground text-xs tabular-nums">{totalThisMonth} 个事项</span>
            {calStatus?.accountEmail && (
              <span
                className="flex items-center gap-1 rounded-full bg-blue-500/10 px-2 py-0.5 text-[11px] text-blue-600 dark:text-blue-400"
                title={`Google 账号：${calStatus.accountEmail}`}
              >
                <Mail className="size-3" />
                <span className="max-w-[180px] truncate">{calStatus.accountEmail}</span>
              </span>
            )}
          </div>
          <div className="ml-auto flex items-center gap-1">
            {lastSyncedLabel && (
              <span className="mr-1 text-[11px] text-muted-foreground tabular-nums" title="上次同步时间">
                {sync.isPending ? '同步中…' : `更新于${lastSyncedLabel}`}
              </span>
            )}
            <Button
              aria-label="刷新日历"
              disabled={sync.isPending}
              onClick={() => sync.mutate()}
              size="icon-sm"
              title="刷新 Google 日历"
              variant="ghost"
            >
              <RefreshCw className={cn('size-4', sync.isPending && 'animate-spin')} />
            </Button>
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
            const items = itemsFor(day)
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
                  {items.slice(0, 3).map((it, i) => (
                    <span
                      className={cn(
                        'flex items-center gap-1 truncate rounded px-1 text-[10px] leading-tight',
                        it.kind === 'run'
                          ? 'bg-muted/60 text-foreground/80'
                          : it.kind === 'projection'
                            ? 'bg-primary/5 text-muted-foreground'
                            : eventPillTone(it.event)
                      )}
                      key={`${it.at.getTime()}-${i}`}
                      title={`${format(it.at, 'HH:mm')} · ${itemLabel(it)}`}
                    >
                      {it.kind === 'run' ? (
                        <span className={cn('shrink-0', runTone(it.run.status))}>●</span>
                      ) : it.kind === 'projection' ? (
                        <span className="shrink-0 text-muted-foreground/40">○</span>
                      ) : (
                        <span className={cn('shrink-0', eventDot(it.event))}>◆</span>
                      )}
                      <span className="shrink-0 tabular-nums">
                        {it.kind === 'event' && it.event.allDay ? '全天' : format(it.at, 'HH:mm')}
                      </span>
                      <span className="truncate">{itemLabel(it)}</span>
                    </span>
                  ))}
                  {items.length > 3 && (
                    <span className="px-1 text-[10px] text-muted-foreground">+{items.length - 3}</span>
                  )}
                </div>
              </button>
            )
          })}
        </div>
      </div>

      {selected && (
        <aside className="flex w-[320px] shrink-0 flex-col border-border/60 border-l bg-sidebar/40 backdrop-blur-sm">
          <div className="flex h-12 items-center justify-between border-border/60 border-b px-4">
            <div className="flex flex-col leading-tight">
              <span className="font-medium text-[13px]">{format(selected, 'M 月 d 日 EEEE')}</span>
              <span className="text-[11px] text-muted-foreground tabular-nums">
                {selectedItems.length > 0 ? `${selectedItems.length} 个事项` : '当天无事项'}
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
              <div className="flex flex-col gap-2">
                <Button
                  className="w-full justify-start gap-1.5"
                  onClick={() => {
                    setShowCreate((v) => !v)
                    setDraftStart('09:00')
                    setDraftEnd('10:00')
                  }}
                  size="sm"
                  variant="outline"
                >
                  <Plus className="size-3.5" />
                  新建本地事件
                </Button>
                {showCreate && (
                  <div className="flex flex-col gap-2 rounded-lg border border-border/60 bg-card/50 p-2.5 text-[12px]">
                    <Input onChange={(e) => setDraftTitle(e.target.value)} placeholder="标题" value={draftTitle} />
                    <div className="flex items-center gap-2">
                      <span className="text-muted-foreground">起</span>
                      <Input
                        className="h-8"
                        onChange={(e) => setDraftStart(e.target.value)}
                        type="time"
                        value={draftStart}
                      />
                    </div>
                    <div className="flex items-center gap-2">
                      <span className="text-muted-foreground">止</span>
                      <Input
                        className="h-8"
                        onChange={(e) => setDraftEnd(e.target.value)}
                        type="time"
                        value={draftEnd}
                      />
                    </div>
                    <div className="flex gap-2">
                      <Button
                        disabled={createLocal.isPending || !draftTitle.trim() || !draftStart}
                        onClick={submitDraft}
                        size="sm"
                      >
                        保存
                      </Button>
                      <Button onClick={resetDraft} size="sm" variant="ghost">
                        取消
                      </Button>
                    </div>
                  </div>
                )}
              </div>

              {selectedItems.length === 0 && (
                <div className="mt-10 flex flex-col items-center gap-2 text-center">
                  <CalendarClock className="size-7 text-muted-foreground/40" />
                  <p className="text-muted-foreground text-xs">这一天没有事项</p>
                </div>
              )}
              {selectedItems.map((it, i) => {
                if (it.kind === 'event') {
                  const ev = it.event
                  const when = ev.allDay
                    ? '全天'
                    : `${format(new Date(ev.startMs), 'HH:mm')} – ${format(new Date(ev.endMs), 'HH:mm')}`
                  return (
                    <div
                      className="rounded-lg border border-border/60 bg-card/50 p-3 text-[13px]"
                      key={`${it.at.getTime()}-${i}`}
                    >
                      <div className="flex items-start justify-between gap-2">
                        <div className="flex min-w-0 flex-col">
                          <span className={cn('flex items-center gap-1.5 font-medium tabular-nums', eventDot(ev))}>
                            <span>◆</span>
                            {when}
                            <span className="font-normal text-[10px] text-muted-foreground">
                              {ev.source === 'google' ? 'Google' : '本地'}
                            </span>
                          </span>
                          <span className="mt-0.5 truncate">{ev.title}</span>
                          {ev.location && (
                            <span className="mt-0.5 truncate text-[11px] text-muted-foreground">@ {ev.location}</span>
                          )}
                          {ev.description && (
                            <HtmlText className="mt-1 line-clamp-3 text-foreground/70 text-xs">
                              {ev.description}
                            </HtmlText>
                          )}
                        </div>
                        {ev.source === 'local' && (
                          <Button
                            aria-label="Delete local event"
                            className="size-7 shrink-0 text-muted-foreground hover:text-destructive"
                            disabled={deleteLocal.isPending}
                            onClick={() => deleteLocal.mutate(ev.id)}
                            size="icon"
                            variant="ghost"
                          >
                            <Trash2 className="size-4" />
                          </Button>
                        )}
                      </div>
                    </div>
                  )
                }
                const task = it.task
                const jobId = task?.id
                const goal = task?.goal
                return (
                  <div
                    className="rounded-lg border border-border/60 bg-card/50 p-3 text-[13px] transition-colors hover:bg-accent/40"
                    key={`${it.at.getTime()}-${i}`}
                  >
                    <div className="flex items-start justify-between gap-2">
                      <div className="flex min-w-0 flex-col">
                        <span className="flex items-center gap-1.5 font-medium text-primary tabular-nums">
                          {it.kind === 'run' && (
                            <span className={runTone(it.run.status)}>
                              {it.run.status === 'completed' ? (
                                <Check className="size-3.5" />
                              ) : it.run.status === 'failed' || it.run.status === 'error' ? (
                                <X className="size-3.5" />
                              ) : it.run.status === 'running' ? (
                                <Loader2 className="size-3.5 animate-spin" />
                              ) : (
                                <span className="text-[10px]">●</span>
                              )}
                            </span>
                          )}
                          {format(it.at, 'HH:mm')}
                          {it.kind === 'projection' && (
                            <span className="font-normal text-[10px] text-muted-foreground">计划中</span>
                          )}
                        </span>
                        <span className="mt-0.5 truncate">{itemLabel(it)}</span>
                      </div>
                      {jobId && (
                        <Button
                          aria-label="Cancel task"
                          className="size-7 shrink-0 text-muted-foreground hover:text-destructive"
                          onClick={() => cancel.mutate(jobId)}
                          size="icon"
                          variant="ghost"
                        >
                          <Trash2 className="size-4" />
                        </Button>
                      )}
                    </div>
                    {it.kind === 'run' && it.run.error && (
                      <p className="mt-1.5 line-clamp-2 text-[11px] text-destructive">{it.run.error}</p>
                    )}
                    {goal && <p className="mt-1.5 line-clamp-3 text-foreground/70 text-xs">{goal}</p>}
                    <div className="mt-2 flex flex-col gap-1">
                      {it.kind === 'run' && it.run.taskId && (
                        <button
                          className="text-left text-[11px] text-primary hover:underline"
                          onClick={() => openRun(it.run.taskId as string)}
                          type="button"
                        >
                          查看运行记录 →
                        </button>
                      )}
                      {task?.originSessionId && task.originSessionTitle ? (
                        <button
                          className="truncate text-left text-[11px] text-muted-foreground hover:text-foreground hover:underline"
                          onClick={() =>
                            void navigate({
                              to: '/session/$sessionId',
                              params: { sessionId: task.originSessionId as string },
                            })
                          }
                          type="button"
                        >
                          在「{task.originSessionTitle}」中创建 →
                        </button>
                      ) : (
                        <span className="text-[11px] text-muted-foreground/60">创建来源不可用</span>
                      )}
                    </div>
                  </div>
                )
              })}

              {/* Agent insights (front-end derived; nothing to show when no rules fire) */}
              <CalendarInsights
                items={selectedItems.map(
                  (it): InsightInput => ({
                    kind: it.kind === 'event' ? 'event' : it.kind === 'projection' ? 'projection' : 'run',
                    source: it.kind === 'event' ? it.event.source : 'task',
                    title: itemLabel(it),
                    startMs: it.kind === 'event' ? it.event.startMs : it.at.getTime(),
                    endMs: it.kind === 'event' ? it.event.endMs : it.at.getTime(),
                  })
                )}
              />
            </div>
          </ScrollArea>
        </aside>
      )}
    </div>
  )
}
