// Priority lens — 3 columns (high/medium/low). Drag a card into a column to set
// its priority. Ported from WorkPanel's PriorityLensView.swift. Unlike Kanban,
// there is no within-column reorder here — only priority assignment via drop.
import { closestCorners, DndContext, type DragEndEvent, PointerSensor, useSensor, useSensors } from '@dnd-kit/core'
import { SortableContext, useSortable, verticalListSortingStrategy } from '@dnd-kit/sortable'
import { CSS } from '@dnd-kit/utilities'
import type { Priority, WorkbenchTask } from '@swarm/protocol'
import { Checkbox } from '@swarm/ui'
import { CalendarClock } from 'lucide-react'

import { useCompleteTask, useReopenTask, useUpdateTask } from '@/hooks/use-workbench'
import { cn } from '@/lib/utils'

const PRIORITY_DOT: Record<Priority, string> = {
  high: 'bg-red-500',
  medium: 'bg-yellow-500',
  low: 'bg-blue-400',
}
const PRIORITY_LABEL: Record<Priority, string> = { high: '高', medium: '中', low: '低' }
const PRIORITIES: Priority[] = ['high', 'medium', 'low']

function formatDeadline(iso: string | null): string | null {
  if (!iso) return null
  const d = new Date(iso)
  return d.toLocaleDateString('zh-CN', { month: 'numeric', day: 'numeric', hour: '2-digit', minute: '2-digit' })
}

export function PriorityView(props: {
  tasks: WorkbenchTask[]
  onEditTask: (task: WorkbenchTask) => void
}): React.JSX.Element {
  const { tasks, onEditTask } = props
  const updateTask = useUpdateTask()
  const sensors = useSensors(useSensor(PointerSensor, { activationConstraint: { distance: 6 } }))

  const onDragEnd = (e: DragEndEvent): void => {
    const { active, over } = e
    if (!over) return
    const overId = String(over.id)
    // over can be a task (another card) or a column droppable `prio:high` etc.
    let targetPriority: Priority | null = null
    if (overId.startsWith('prio:')) {
      targetPriority = overId.slice(5) as Priority
    } else {
      // over is a task → use its priority
      const overTask = tasks.find((t) => t.id === overId)
      if (overTask) targetPriority = overTask.priority
    }
    if (!targetPriority) return
    const task = tasks.find((t) => t.id === String(active.id))
    if (!task || task.priority === targetPriority) return
    updateTask.mutate({ id: task.id, patch: { priority: targetPriority } })
  }

  return (
    <div className="flex min-h-0 flex-1 gap-3 p-3">
      <DndContext collisionDetection={closestCorners} onDragEnd={onDragEnd} sensors={sensors}>
        {PRIORITIES.map((p) => (
          <PriorityColumn
            items={tasks.filter((t) => !t.isCompleted && t.priority === p).sort((a, b) => a.boardOrder - b.boardOrder)}
            key={p}
            onEdit={onEditTask}
            priority={p}
          />
        ))}
      </DndContext>
    </div>
  )
}

function PriorityColumn(props: {
  priority: Priority
  items: WorkbenchTask[]
  onEdit: (task: WorkbenchTask) => void
}): React.JSX.Element {
  const { priority, items, onEdit } = props
  return (
    <div className="flex w-72 shrink-0 flex-col rounded-xl border border-border/60 bg-muted/30 p-2.5">
      <div className="mb-2 flex items-center gap-1.5">
        <span className={cn('inline-block size-2 rounded-full', PRIORITY_DOT[priority])} />
        <span className="font-semibold text-[13px] text-foreground">{PRIORITY_LABEL[priority]}</span>
        <span className="text-muted-foreground text-xs">{items.length}</span>
      </div>
      <div className="cmdscroll flex min-h-0 flex-1 flex-col gap-1.5 overflow-y-auto" id={`prio:${priority}`}>
        <SortableContext items={items.map((t) => t.id)} strategy={verticalListSortingStrategy}>
          {items.length === 0 ? (
            <span className="px-2 py-3 text-muted-foreground/60 text-xs">暂无任务</span>
          ) : (
            items.map((task) => <SortableCard key={task.id} onEdit={onEdit} task={task} />)
          )}
        </SortableContext>
      </div>
    </div>
  )
}

function SortableCard(props: { task: WorkbenchTask; onEdit: (task: WorkbenchTask) => void }): React.JSX.Element {
  const { task, onEdit } = props
  const { attributes, listeners, setNodeRef, transform, transition, isDragging } = useSortable({ id: task.id })
  const completeTask = useCompleteTask()
  const reopenTask = useReopenTask()
  const deadlineStr = formatDeadline(task.deadline)

  return (
    <div
      className={cn(
        'flex flex-col gap-0.5 rounded-lg border border-border/50 bg-background p-2.5 transition-colors hover:border-border',
        isDragging && 'opacity-40'
      )}
      ref={setNodeRef}
      style={{ transform: CSS.Transform.toString(transform), transition }}
      {...attributes}
      {...listeners}
    >
      <div className="flex items-start gap-2">
        <Checkbox
          checked={task.isCompleted}
          className="mt-0.5"
          onCheckedChange={() => (task.isCompleted ? reopenTask.mutate(task.id) : completeTask.mutate(task.id))}
        />
        <button className="flex-1 text-left text-sm leading-snug" onClick={() => onEdit(task)} type="button">
          <span className="line-clamp-2">{task.title}</span>
        </button>
      </div>
      {deadlineStr && (
        <span className="flex items-center gap-0.5 pl-6 text-[10px] text-muted-foreground">
          <CalendarClock className="size-2.5" />
          {deadlineStr}
        </span>
      )}
    </div>
  )
}
