// Gantt lens — tasks drawn as horizontal bars on a day-grid timeline.
// Drag bar body to move (start+end together); drag left/right handles to resize.
// Unscheduled tasks (no start AND no deadline) listed at the bottom.
// Ported from WorkPanel's GanttLensView.swift + GanttGeometry.swift.
import { useMemo, useRef, useState } from 'react'
import type { WorkbenchColumn, WorkbenchTask } from '@swarm/protocol'

import { useUpdateTask } from '@/hooks/use-workbench'
import { cn } from '@/lib/utils'
import {
  barFrame,
  daysDelta,
  partition,
  resizedEnd,
  resizedStart,
  shifted,
  timelineBounds,
} from '@/lib/workbench/gantt-geometry'

const NAME_W = 132
const ROW_H = 30
const ROW_GAP = 6
const HEADER_H = 26
const HANDLE_W = 8

const COLUMN_PALETTE = ['#4DA6FF', '#5BC16E', '#FFB340', '#B98BFF', '#FF6B9D', '#4DD0E1']

function columnColor(task: WorkbenchTask, columns: WorkbenchColumn[]): string {
  if (!task.columnId) return 'var(--color-muted-foreground)'
  const col = columns.find((c) => c.id === task.columnId)
  if (!col) return 'var(--color-muted-foreground)'
  return COLUMN_PALETTE[((col.order % COLUMN_PALETTE.length) + COLUMN_PALETTE.length) % COLUMN_PALETTE.length]
}

type DragState = { taskId: string; mode: 'move' | 'resizeLeft' | 'resizeRight'; startX: number }

export function GanttView(props: {
  tasks: WorkbenchTask[]
  columns: WorkbenchColumn[]
  onEditTask: (task: WorkbenchTask) => void
}): React.JSX.Element {
  const { tasks, columns, onEditTask } = props
  const updateTask = useUpdateTask()
  const containerRef = useRef<HTMLDivElement>(null)
  const dayWidth = 40
  const [drag, setDrag] = useState<DragState | null>(null)

  const { scheduled, unscheduled } = useMemo(() => {
    const rows = tasks.filter((t) => !t.isCompleted).map((t) => ({ id: t.id, start: t.startDate, end: t.deadline }))
    return partition(rows)
  }, [tasks])

  const { start: timelineStart, days } = useMemo(() => timelineBounds(scheduled), [scheduled])
  const contentW = days * dayWidth

  const onPointerMove = (e: React.PointerEvent): void => {
    if (!drag) return
    const dx = e.clientX - drag.startX
    const delta = daysDelta(dx, dayWidth)
    if (delta === 0) return
    const task = tasks.find((t) => t.id === drag.taskId)
    if (!task) return

    if (drag.mode === 'move') {
      const { start, end } = shifted(task.startDate, task.deadline, delta)
      updateTask.mutate({ id: task.id, patch: { startDate: start, deadline: end } })
    } else if (drag.mode === 'resizeLeft' && task.startDate) {
      const newStart = resizedStart(task.startDate, task.deadline, delta)
      updateTask.mutate({ id: task.id, patch: { startDate: newStart } })
    } else if (drag.mode === 'resizeRight' && task.deadline) {
      const newEnd = resizedEnd(task.startDate, task.deadline, delta)
      updateTask.mutate({ id: task.id, patch: { deadline: newEnd } })
    }
    // Reset startX so we accumulate one day at a time
    setDrag({ ...drag, startX: e.clientX })
  }

  const startDrag = (e: React.PointerEvent, taskId: string, mode: DragState['mode']): void => {
    e.stopPropagation()
    e.preventDefault()
    setDrag({ taskId, mode, startX: e.clientX })
  }

  const endDrag = (): void => setDrag(null)

  if (scheduled.length === 0 && unscheduled.length === 0) {
    return (
      <div className="flex min-h-0 flex-1 items-center justify-center text-muted-foreground text-sm">还没有任务</div>
    )
  }

  return (
    <div
      className="flex min-h-0 flex-1 flex-col overflow-hidden p-3"
      onPointerMove={onPointerMove}
      onPointerUp={endDrag}
      ref={containerRef}
    >
      {/* Header (date strip) */}
      <div className="flex flex-none" style={{ height: HEADER_H }}>
        <div className="shrink-0" style={{ width: NAME_W }} />
        <div className="cmdscroll relative flex min-w-0 flex-1 overflow-x-auto">
          <div className="flex" style={{ width: contentW }}>
            {Array.from({ length: days }, (_, i) => {
              const date = new Date(timelineStart)
              date.setDate(date.getDate() + i)
              const isToday = date.toDateString() === new Date().toDateString()
              return (
                <div
                  className="flex flex-col items-center justify-center"
                  key={date.toDateString()}
                  style={{ width: dayWidth }}
                >
                  <span className="text-[9px] text-muted-foreground">
                    {date.toLocaleDateString('zh-CN', { weekday: 'narrow' })}
                  </span>
                  <span className={cn('text-[11px]', isToday ? 'font-bold text-primary' : 'text-muted-foreground')}>
                    {date.getDate()}
                  </span>
                </div>
              )
            })}
          </div>
        </div>
      </div>
      <div className="mb-1 h-px w-full flex-none" style={{ backgroundColor: 'var(--color-border)' }} />

      {/* Body */}
      <div className="cmdscroll flex min-h-0 flex-1 overflow-auto">
        <div className="flex min-w-0 flex-1" style={{ minWidth: NAME_W + contentW }}>
          {/* Frozen name column */}
          <div className="flex shrink-0 flex-col" style={{ width: NAME_W }}>
            {scheduled.map((row) => {
              const task = tasks.find((t) => t.id === row.id)
              if (!task) return null
              return (
                <button
                  className="flex items-center truncate px-2 pr-2 text-left text-[12px] text-foreground"
                  key={row.id}
                  onClick={() => onEditTask(task)}
                  style={{ height: ROW_H, marginBottom: ROW_GAP }}
                  type="button"
                >
                  <span className="truncate">{task.title}</span>
                </button>
              )
            })}
          </div>

          {/* Timeline */}
          <div className="relative flex-1" style={{ width: contentW }}>
            {/* Grid lines */}
            <div className="absolute inset-0 flex">
              {Array.from({ length: days }, (_, i) => {
                const date = new Date(timelineStart)
                date.setDate(date.getDate() + i)
                const isToday = date.toDateString() === new Date().toDateString()
                return (
                  <div
                    className="h-full border-border/40 border-l"
                    key={date.toDateString()}
                    style={{
                      width: dayWidth,
                      backgroundColor: isToday ? 'var(--color-primary)' : undefined,
                      opacity: isToday ? 0.05 : 1,
                    }}
                  />
                )
              })}
            </div>

            {/* Bars */}
            {scheduled.map((row) => {
              const task = tasks.find((t) => t.id === row.id)
              if (!task) return null
              const frame = barFrame(task.startDate, task.deadline, timelineStart, dayWidth)
              if (!frame) return null
              const color = columnColor(task, columns)
              return (
                <div key={row.id} style={{ height: ROW_H, marginBottom: ROW_GAP }}>
                  {/* Bar */}
                  <div
                    className="absolute flex items-center overflow-hidden rounded-md"
                    onPointerDown={(e) => startDrag(e, task.id, 'move')}
                    style={{
                      left: frame.x,
                      width: Math.max(dayWidth, frame.width),
                      height: ROW_H - 6,
                      top: 3,
                      backgroundColor: color,
                      opacity: 0.85,
                      cursor: 'grab',
                    }}
                  >
                    <span className="truncate px-1.5 font-medium text-[10px] text-white/95">{task.title}</span>

                    {/* Left resize handle */}
                    <div
                      className="absolute top-0 left-0 flex items-center justify-center"
                      onPointerDown={(e) => startDrag(e, task.id, 'resizeLeft')}
                      style={{ width: HANDLE_W, height: '100%', cursor: 'ew-resize' }}
                    >
                      <div className="bg-white/55" style={{ width: 2, height: '50%' }} />
                    </div>

                    {/* Right resize handle */}
                    <div
                      className="absolute top-0 right-0 flex items-center justify-center"
                      onPointerDown={(e) => startDrag(e, task.id, 'resizeRight')}
                      style={{ width: HANDLE_W, height: '100%', cursor: 'ew-resize' }}
                    >
                      <div className="bg-white/55" style={{ width: 2, height: '50%' }} />
                    </div>
                  </div>
                </div>
              )
            })}
          </div>
        </div>
      </div>

      {/* Unscheduled section */}
      {unscheduled.length > 0 && (
        <div className="cmdscroll flex flex-none flex-col gap-1.5 overflow-y-auto pt-2">
          <span className="font-semibold text-[11px] text-muted-foreground">未排期</span>
          {unscheduled.map((row) => {
            const task = tasks.find((t) => t.id === row.id)
            if (!task) return null
            return (
              <button
                className="rounded-md bg-muted px-2 py-1 text-left text-[12px] text-muted-foreground"
                key={row.id}
                onClick={() => onEditTask(task)}
                type="button"
              >
                {task.title}
              </button>
            )
          })}
        </div>
      )}
    </div>
  )
}
