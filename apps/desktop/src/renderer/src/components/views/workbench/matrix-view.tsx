// Matrix lens — read-only Eisenhower 4-quadrant view. Buckets active (non-completed)
// tasks by (important × urgent). Clicking a card opens the editor. Ported from
// WorkPanel's MatrixLensView.swift.
import type { WorkbenchTask } from '@swarm/protocol'
import { CalendarClock } from 'lucide-react'

import { cn } from '@/lib/utils'

const URGENT_WINDOW_MS = 48 * 3600_000

type QuadrantDef = {
  important: boolean
  urgent: boolean
  title: string
  action: string
  dotClass: string
  titleClass: string
}

const QUADRANTS: [QuadrantDef, QuadrantDef, QuadrantDef, QuadrantDef] = [
  {
    important: true,
    urgent: true,
    title: '重要 · 紧急',
    action: '马上做',
    dotClass: 'bg-red-500',
    titleClass: 'text-red-500',
  },
  {
    important: true,
    urgent: false,
    title: '重要 · 不紧急',
    action: '计划做',
    dotClass: 'bg-blue-400',
    titleClass: 'text-blue-400',
  },
  {
    important: false,
    urgent: true,
    title: '不重要 · 紧急',
    action: '尽快处理',
    dotClass: 'bg-yellow-500',
    titleClass: 'text-yellow-500',
  },
  {
    important: false,
    urgent: false,
    title: '不重要 · 不紧急',
    action: '有空再说',
    dotClass: 'bg-muted-foreground',
    titleClass: 'text-muted-foreground',
  },
]

function isImportant(t: WorkbenchTask): boolean {
  return t.priority !== 'low'
}

function isUrgent(t: WorkbenchTask): boolean {
  if (!t.deadline) return false
  return new Date(t.deadline).getTime() <= Date.now() + URGENT_WINDOW_MS
}

export function MatrixView(props: {
  tasks: WorkbenchTask[]
  onEditTask: (task: WorkbenchTask) => void
}): React.JSX.Element {
  const { tasks, onEditTask } = props
  const active = tasks.filter((t) => !t.isCompleted)

  return (
    <div className="flex min-h-0 flex-1 flex-col gap-2.5 p-3">
      <div className="grid min-h-0 flex-1 grid-cols-2 grid-rows-2 gap-2.5">
        {QUADRANTS.map((q) => {
          const items = active
            .filter((t) => isImportant(t) === q.important && isUrgent(t) === q.urgent)
            .sort((a, b) => a.boardOrder - b.boardOrder)
          return <Quadrant def={q} items={items} key={`${q.important}-${q.urgent}`} onEdit={onEditTask} />
        })}
      </div>
    </div>
  )
}

function Quadrant(props: {
  def: QuadrantDef
  items: WorkbenchTask[]
  onEdit: (task: WorkbenchTask) => void
}): React.JSX.Element {
  const { def, items, onEdit } = props
  return (
    <div className="flex min-h-0 flex-col rounded-xl border border-border/60 bg-muted/30 p-2.5">
      {/* Header */}
      <div className="mb-2 flex items-center gap-1.5">
        <span className={cn('inline-block size-2 rounded-full', def.dotClass)} />
        <span className={cn('font-semibold text-[13px]', def.titleClass)}>{def.title}</span>
        <span className="text-muted-foreground text-xs">{items.length}</span>
        <span className="ml-auto text-[11px] text-muted-foreground">{def.action}</span>
      </div>
      <div className="mb-2 h-px w-full" style={{ backgroundColor: 'var(--color-border)' }} />

      {/* Cards */}
      <div className="cmdscroll grid min-h-0 flex-1 grid-cols-3 gap-2 overflow-y-auto">
        {items.length === 0 ? (
          <span className="col-span-3 py-3 text-muted-foreground/60 text-xs">空</span>
        ) : (
          items.map((task) => (
            <button
              className={cn(
                'flex flex-col gap-0.5 rounded-lg border border-border/50 bg-background p-2 text-left transition-colors hover:border-border',
                task.isCompleted && 'opacity-50'
              )}
              key={task.id}
              onClick={() => onEdit(task)}
              type="button"
            >
              <span className="line-clamp-2 text-[12px] leading-snug">{task.title}</span>
              {task.deadline && (
                <span className="flex items-center gap-0.5 text-[10px] text-muted-foreground">
                  <CalendarClock className="size-2.5" />
                  {new Date(task.deadline).toLocaleDateString('zh-CN', { month: 'numeric', day: 'numeric' })}
                </span>
              )}
            </button>
          ))
        )}
      </div>
    </div>
  )
}
