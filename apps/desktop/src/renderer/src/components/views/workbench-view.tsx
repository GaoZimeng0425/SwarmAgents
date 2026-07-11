// Workbench (工作面板) — a kanban task board ported from the WorkPanel macOS app.
// Layout: header (title + count + filter toggle) over an optional filter bar,
// then a horizontally-draggable row of columns. Each column has a scrollable,
// vertically-draggable list of task cards. Creating and editing tasks both open
// the same TaskDialog. Filtering is pure renderer state (BoardFilter).
import { useMemo, useState } from 'react'
import {
  type CollisionDetection,
  closestCorners,
  DndContext,
  type DragEndEvent,
  DragOverlay,
  type DragStartEvent,
  PointerSensor,
  pointerWithin,
  rectIntersection,
  useDroppable,
  useSensor,
  useSensors,
} from '@dnd-kit/core'
import {
  horizontalListSortingStrategy,
  SortableContext,
  useSortable,
  verticalListSortingStrategy,
} from '@dnd-kit/sortable'
import { CSS } from '@dnd-kit/utilities'
import type { Priority, WorkbenchColumn, WorkbenchTask } from '@swarm/protocol'
import {
  Badge,
  Button,
  Calendar,
  Checkbox,
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
  Input,
  Popover,
  PopoverContent,
  PopoverTrigger,
  Textarea,
} from '@swarm/ui'
import { zhCN } from 'date-fns/locale'
import { CalendarClock, CalendarDays, Filter, MoreVertical, Pencil, Plus, Search, Tag, Trash2, X } from 'lucide-react'

import {
  useAddColumn,
  useCompleteTask,
  useCreateTask,
  useDeleteColumn,
  useDeleteTask,
  useMoveTask,
  useRenameColumn,
  useReopenTask,
  useReorderColumns,
  useUpdateTask,
  useWorkbenchData,
  useWorkbenchSync,
} from '@/hooks/use-workbench'
import { cn } from '@/lib/utils'
import { parseInput } from '@/lib/workbench/input-parser'
import { GanttView } from './workbench/gantt-view'
import { MatrixView } from './workbench/matrix-view'
import { PriorityView } from './workbench/priority-view'

// --- Constants & helpers -----------------------------------------------------

const PRIORITY_LABEL: Record<Priority, string> = { high: '高', medium: '中', low: '低' }
const PRIORITY_DOT: Record<Priority, string> = {
  high: 'bg-red-500',
  medium: 'bg-yellow-500',
  low: 'bg-blue-400',
}
const PRIORITIES: Priority[] = ['high', 'medium', 'low']
const URGENT_WINDOW_MS = 48 * 3600_000

function formatDeadline(iso: string | null): string | null {
  if (!iso) return null
  const d = new Date(iso)
  const now = new Date()
  const sameYear = d.getFullYear() === now.getFullYear()
  const fmt = new Intl.DateTimeFormat('zh-CN', {
    month: 'numeric',
    day: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
    ...(sameYear ? {} : { year: 'numeric' }),
  })
  return fmt.format(d)
}

/** Date-only format for the date picker display (no hour/minute). */
function formatDate(iso: string | null): string | null {
  if (!iso) return null
  const d = new Date(iso)
  const now = new Date()
  const sameYear = d.getFullYear() === now.getFullYear()
  return new Intl.DateTimeFormat('zh-CN', {
    month: 'numeric',
    day: 'numeric',
    ...(sameYear ? {} : { year: 'numeric' }),
  }).format(d)
}

/** Parse an ISO string into a Date for Calendar's `selected` prop. */
function toDate(iso: string | null): Date | undefined {
  if (!iso) return undefined
  const d = new Date(iso)
  return Number.isNaN(d.getTime()) ? undefined : d
}

/** Convert a Date back to an ISO string for storage. */
function toISODate(date: Date | undefined): string {
  return date ? date.toISOString() : ''
}

function isOverdue(iso: string | null): boolean {
  if (!iso) return false
  return new Date(iso).getTime() < Date.now()
}

function isUrgent(task: WorkbenchTask): boolean {
  if (!task.deadline) return false
  return new Date(task.deadline).getTime() <= Date.now() + URGENT_WINDOW_MS
}

// --- Board filter (ported from WorkPanel's BoardFilter.swift) ----------------

type BoardFilter = {
  search: string
  priorities: Set<Priority>
  urgentOnly: boolean
  tags: Set<string>
}

const emptyFilter = (): BoardFilter => ({ search: '', priorities: new Set(), urgentOnly: false, tags: new Set() })

function isFilterActive(f: BoardFilter): boolean {
  return f.search.trim() !== '' || f.priorities.size > 0 || f.urgentOnly || f.tags.size > 0
}

/** AND across dimensions, OR within. Ported from BoardFilter.apply. */
function applyFilter(tasks: WorkbenchTask[], f: BoardFilter): WorkbenchTask[] {
  if (!isFilterActive(f)) return tasks
  const q = f.search.trim().toLowerCase()
  return tasks.filter((t) => {
    if (q && !t.title.toLowerCase().includes(q) && !t.notes.toLowerCase().includes(q)) return false
    if (f.priorities.size > 0 && !f.priorities.has(t.priority)) return false
    if (f.urgentOnly && !isUrgent(t)) return false
    if (f.tags.size > 0 && !t.tags.some((tag) => f.tags.has(tag))) return false
    return true
  })
}

// --- Dialog state ------------------------------------------------------------

type DialogState = { mode: 'create'; columnId: string } | { mode: 'edit'; task: WorkbenchTask } | null

type ViewMode = 'kanban' | 'matrix' | 'priority' | 'gantt'

const VIEW_TABS: { mode: ViewMode; label: string }[] = [
  { mode: 'kanban', label: '看板' },
  { mode: 'matrix', label: '象限' },
  { mode: 'priority', label: '优先级' },
  { mode: 'gantt', label: '甘特' },
]

// =========================================================================== //
//                              WorkbenchView                                   //
// =========================================================================== //

export function WorkbenchView(): React.JSX.Element {
  const { data } = useWorkbenchData()
  useWorkbenchSync()

  const columns = useMemo(() => [...data.columns].sort((a, b) => a.order - b.order), [data.columns])
  const [filter, setFilter] = useState<BoardFilter>(emptyFilter)
  const [showFilter, setShowFilter] = useState(true)
  const [viewMode, setViewMode] = useState<ViewMode>('kanban')
  const [dialog, setDialog] = useState<DialogState>(null)

  // Derive unique tags from all tasks (no backend Tag entity needed).
  const allTags = useMemo(() => {
    const set = new Set<string>()
    for (const t of data.tasks) for (const tag of t.tags) set.add(tag)
    return [...set].sort()
  }, [data.tasks])

  const filteredTasks = useMemo(() => applyFilter(data.tasks, filter), [data.tasks, filter])
  const totalTasks = data.tasks.filter((t) => !t.isCompleted).length

  return (
    <div className="flex h-full w-full flex-col">
      <header className="flex flex-none flex-col gap-2 border-border/70 border-b px-5 pt-4 pb-3">
        <div className="flex flex-wrap items-center justify-between gap-3">
          <div>
            <h1 className="font-semibold text-foreground text-xl tracking-tight">工作面板</h1>
            <p className="mt-0.5 text-muted-foreground text-xs">看板任务管理 · {totalTasks} 个进行中</p>
          </div>
          {/* View mode tab strip */}
          <div className="flex items-center gap-0.5 rounded-lg border border-border/60 bg-muted/30 p-0.5">
            {VIEW_TABS.map((tab) => (
              <button
                className={cn(
                  'rounded-md px-3 py-1 font-medium text-xs transition-colors',
                  viewMode === tab.mode ? 'bg-primary/10 text-primary' : 'text-muted-foreground hover:text-foreground'
                )}
                key={tab.mode}
                onClick={() => setViewMode(tab.mode)}
                type="button"
              >
                {tab.label}
              </button>
            ))}
          </div>
          <div className="flex items-center gap-2">
            <Button
              className={cn('gap-1.5', isFilterActive(filter) && 'text-primary')}
              onClick={() => setShowFilter((v) => !v)}
              size="sm"
              variant="ghost"
            >
              <Filter className="size-4" />
              筛选
              {isFilterActive(filter) && <span className="size-1.5 rounded-full bg-primary" />}
            </Button>
            <Button
              className="gap-1.5"
              onClick={() => setDialog({ mode: 'create', columnId: columns[0]?.id ?? '' })}
              size="sm"
            >
              <Plus className="size-4" />
              新建任务
            </Button>
          </div>
        </div>
        {showFilter && <WorkbenchFilterBar allTags={allTags} filter={filter} onChange={setFilter} />}
      </header>

      {viewMode === 'kanban' && (
        <BoardArea
          columns={columns}
          filteredTasks={filteredTasks}
          onEditTask={(task) => setDialog({ mode: 'edit', task })}
        />
      )}
      {viewMode === 'matrix' && (
        <MatrixView onEditTask={(task) => setDialog({ mode: 'edit', task })} tasks={filteredTasks} />
      )}
      {viewMode === 'priority' && (
        <PriorityView onEditTask={(task) => setDialog({ mode: 'edit', task })} tasks={filteredTasks} />
      )}
      {viewMode === 'gantt' && (
        <GanttView columns={columns} onEditTask={(task) => setDialog({ mode: 'edit', task })} tasks={filteredTasks} />
      )}

      {dialog && <TaskDialog onClose={() => setDialog(null)} state={dialog} />}
    </div>
  )
}

// --- Filter bar --------------------------------------------------------------

function WorkbenchFilterBar(props: {
  filter: BoardFilter
  allTags: string[]
  onChange: (f: BoardFilter) => void
}): React.JSX.Element {
  const { filter, allTags, onChange } = props

  const togglePriority = (p: Priority): void => {
    const next = new Set(filter.priorities)
    if (next.has(p)) next.delete(p)
    else next.add(p)
    onChange({ ...filter, priorities: next })
  }

  const toggleTag = (tag: string): void => {
    const next = new Set(filter.tags)
    if (next.has(tag)) next.delete(tag)
    else next.add(tag)
    onChange({ ...filter, tags: next })
  }

  return (
    <div className="flex flex-wrap items-center gap-2">
      <div className="relative">
        <Search className="absolute top-1/2 left-2 size-3.5 -translate-y-1/2 text-muted-foreground" />
        <Input
          className="h-8 w-48 pl-7 text-sm"
          onChange={(e) => onChange({ ...filter, search: e.target.value })}
          placeholder="搜索标题 / 备注"
          value={filter.search}
        />
      </div>
      <div className="flex items-center gap-1">
        {PRIORITIES.map((p) => (
          <PillButton
            active={filter.priorities.has(p)}
            color={PRIORITY_DOT[p]}
            key={p}
            label={PRIORITY_LABEL[p]}
            onClick={() => togglePriority(p)}
          />
        ))}
      </div>
      <PillButton
        active={filter.urgentOnly}
        color="bg-orange-500"
        label="⚡ 紧急"
        onClick={() => onChange({ ...filter, urgentOnly: !filter.urgentOnly })}
      />
      <Popover>
        <PopoverTrigger
          render={
            <button
              className={cn(
                'flex items-center gap-1 rounded-full border px-2.5 py-1 text-xs transition-colors',
                filter.tags.size > 0
                  ? 'border-primary/50 bg-primary/10 text-primary'
                  : 'border-border/70 text-muted-foreground hover:bg-muted'
              )}
              type="button"
            >
              <Tag className="size-3" />
              标签{filter.tags.size > 0 ? ` ${filter.tags.size}` : ''}
            </button>
          }
        />
        <PopoverContent align="start">
          <div className="flex max-h-60 w-48 flex-col gap-0.5 overflow-y-auto">
            {allTags.length === 0 ? (
              <p className="px-2 py-3 text-center text-muted-foreground text-xs">暂无标签</p>
            ) : (
              allTags.map((tag) => (
                <button
                  className={cn(
                    'flex items-center justify-between rounded-md px-2 py-1.5 text-left text-sm transition-colors hover:bg-muted',
                    filter.tags.has(tag) && 'text-primary'
                  )}
                  key={tag}
                  onClick={() => toggleTag(tag)}
                  type="button"
                >
                  <span className="truncate">#{tag}</span>
                  {filter.tags.has(tag) && <span className="text-xs">✓</span>}
                </button>
              ))
            )}
          </div>
        </PopoverContent>
      </Popover>
      {isFilterActive(filter) && (
        <button
          className="flex items-center gap-1 text-muted-foreground text-xs transition-colors hover:text-foreground"
          onClick={() => onChange(emptyFilter())}
          type="button"
        >
          <X className="size-3" />
          清除
        </button>
      )}
    </div>
  )
}

function PillButton(props: { label: string; color: string; active: boolean; onClick: () => void }): React.JSX.Element {
  return (
    <button
      className={cn(
        'rounded-full border px-2.5 py-1 font-medium text-xs transition-colors',
        props.active ? 'border-transparent text-foreground' : 'border-border/70 text-muted-foreground hover:bg-muted'
      )}
      onClick={props.onClick}
      style={props.active ? { backgroundColor: 'var(--color-muted)' } : undefined}
      type="button"
    >
      <span className={cn('mr-1 inline-block size-2 rounded-full align-middle', props.color)} />
      {props.label}
    </button>
  )
}

// =========================================================================== //
//                              Board DnD area                                   //
// =========================================================================== //

/**
 * Custom collision detection for the kanban board. The board mixes horizontal
 * column reordering with vertical/cross-column card drops, and empty columns
 * have no sortable children for closestCorners to latch onto — so a pure
 * closestCorners strategy skips empty columns and drops cards into the wrong
 * column. We resolve this in two stages:
 *  1. pointerWithin — what is the pointer actually inside? This reliably hits
 *     empty-column droppables (id = `col:<id>`) because it tests the pointer
 *     against the full droppable rect, not just sortable children.
 *  2. closestCorners — if pointerWithin returns nothing (e.g. pointer moved
 *     outside every droppable during a fast drag), fall back to corner distance.
 */
const boardCollisionDetection: CollisionDetection = (args) => {
  const pointerHits = pointerWithin(args)
  if (pointerHits.length > 0) {
    // Prefer a column droppable hit (so empty columns are drop targets); if
    // only task sortable items were hit, closestCorners among them gives
    // better intra-column positioning.
    const colHit = pointerHits.find((h) => String(h.id).startsWith('col:'))
    if (colHit) return [colHit]
    return closestCorners({ ...args, droppableContainers: args.droppableContainers })
  }
  return rectIntersection(args)
}

function BoardArea(props: {
  columns: WorkbenchColumn[]
  filteredTasks: WorkbenchTask[]
  onEditTask: (task: WorkbenchTask) => void
}): React.JSX.Element {
  const { columns, filteredTasks, onEditTask } = props
  const reorderColumns = useReorderColumns()
  const moveTask = useMoveTask()

  // Track the active drag item so DragOverlay can render a floating preview.
  const [activeId, setActiveId] = useState<string | null>(null)
  const activeTask = activeId ? filteredTasks.find((t) => t.id === activeId) : null

  const onDragStart = (e: DragStartEvent): void => {
    setActiveId(String(e.active.id))
  }
  const onDragEndInternal = (e: DragEndEvent): void => {
    setActiveId(null)
    onColumnDragEnd(e)
    onCardDragEnd(e)
  }

  const sensors = useSensors(useSensor(PointerSensor, { activationConstraint: { distance: 6 } }))

  const onColumnDragEnd = (e: DragEndEvent): void => {
    const { active, over } = e
    if (!over || active.id === over.id) return
    const oldIndex = columns.findIndex((c) => c.id === active.id)
    const newIndex = columns.findIndex((c) => c.id === over.id)
    if (oldIndex < 0 || newIndex < 0) return
    const ordered = [...columns]
    ordered.splice(oldIndex, 1)
    ordered.splice(newIndex, 0, columns[oldIndex])
    reorderColumns.mutate(ordered.map((c) => c.id))
  }

  // Card drag: active.id / over.id are task ids. Resolve the target column from
  // `over` — if over is a task, use its columnId + position; if over is a column
  // droppable id, append to the end of that column.
  const onCardDragEnd = (e: DragEndEvent): void => {
    const { active, over } = e
    if (!over) return
    const activeId = String(active.id)
    const overId = String(over.id)
    const activeTask = filteredTasks.find((t) => t.id === activeId)
    if (!activeTask) return

    // over is another task → target column is its columnId, index is its position
    if (overId !== activeId) {
      const overTask = filteredTasks.find((t) => t.id === overId)
      if (overTask) {
        const targetColumnId = overTask.columnId ?? ''
        if (!targetColumnId) return
        const colTasks = filteredTasks
          .filter((t) => t.columnId === targetColumnId && !t.isCompleted)
          .sort((a, b) => a.boardOrder - b.boardOrder)
        const overIndex = colTasks.findIndex((t) => t.id === overId)
        moveTask.mutate({ taskId: activeId, columnId: targetColumnId, index: overIndex >= 0 ? overIndex : 0 })
        return
      }
    }
    // over is a column droppable (id = `col:${id}`) → append to end
    if (overId.startsWith('col:')) {
      const targetColumnId = overId.slice(4)
      moveTask.mutate({ taskId: activeId, columnId: targetColumnId, index: Number.MAX_SAFE_INTEGER })
      return
    }
    // over is a column sortable id (the column itself, not a card inside it) → append to end
    if (columns.some((c) => c.id === overId)) {
      moveTask.mutate({ taskId: activeId, columnId: overId, index: Number.MAX_SAFE_INTEGER })
    }
  }

  return (
    // Single DndContext for both column-level (horizontal) and card-level
    // (vertical + cross-column) drag. Nested DndContexts break cross-column
    // card drops, so both dimensions share one context.
    <DndContext
      collisionDetection={boardCollisionDetection}
      onDragEnd={onDragEndInternal}
      onDragStart={onDragStart}
      sensors={sensors}
    >
      <SortableContext items={columns.map((c) => c.id)} strategy={horizontalListSortingStrategy}>
        <div className="cmdscroll flex min-h-0 flex-1 gap-3 overflow-x-auto p-4">
          {columns.map((col) => (
            <SortableColumn col={col} filteredTasks={filteredTasks} key={col.id} onEditTask={onEditTask} />
          ))}
          <AddColumnButton />
        </div>
      </SortableContext>
      <DragOverlay dropAnimation={null}>
        {activeTask ? (
          <div className="w-64 rounded-lg border border-border/50 bg-background p-2.5 shadow-xl">
            <span className="text-sm leading-snug">{activeTask.title}</span>
          </div>
        ) : null}
      </DragOverlay>
    </DndContext>
  )
}

// --- Sortable column ---------------------------------------------------------

function SortableColumn(props: {
  col: WorkbenchColumn
  filteredTasks: WorkbenchTask[]
  onEditTask: (task: WorkbenchTask) => void
}): React.JSX.Element {
  const { col, filteredTasks, onEditTask } = props
  const deleteColumn = useDeleteColumn()
  const renameColumn = useRenameColumn()
  const [renaming, setRenaming] = useState(false)
  const [renameValue, setRenameValue] = useState(col.name)

  // Column-level sortable (for horizontal reordering) + droppable (card drop target).
  const { attributes, listeners, setNodeRef, transform, transition, isDragging } = useSortable({ id: col.id })
  const { setNodeRef: setDropRef } = useDroppable({ id: `col:${col.id}` })

  const columnTasks = useMemo(
    () =>
      filteredTasks
        .filter((t) => t.columnId === col.id)
        .sort((a, b) => {
          if (a.isCompleted !== b.isCompleted) return a.isCompleted ? 1 : -1
          return a.boardOrder - b.boardOrder
        }),
    [filteredTasks, col.id]
  )

  const submitRename = (): void => {
    const name = renameValue.trim()
    if (name && name !== col.name) renameColumn.mutate({ id: col.id, name })
    setRenaming(false)
  }

  return (
    <div
      className={cn(
        'flex w-72 shrink-0 flex-col rounded-xl border border-border/60 bg-muted/30',
        isDragging && 'opacity-50'
      )}
      ref={setNodeRef}
      style={{ transform: CSS.Translate.toString(transform), transition }}
      {...attributes}
    >
      {/* Column header — the drag handle for column reordering. Listeners are
          scoped here (not the whole container) so card DnD in the list below
          isn't intercepted. */}
      <div className="flex items-center justify-between gap-1 border-border/60 border-b px-3 py-2" {...listeners}>
        {renaming ? (
          <Input
            autoFocus
            className="h-7 text-sm"
            onBlur={submitRename}
            onChange={(e) => setRenameValue(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Enter') submitRename()
              if (e.key === 'Escape') setRenaming(false)
            }}
            value={renameValue}
          />
        ) : (
          <button
            className="truncate font-medium text-foreground text-sm"
            onClick={() => {
              setRenameValue(col.name)
              setRenaming(true)
            }}
            type="button"
          >
            {col.name}
          </button>
        )}
        <span className="text-muted-foreground text-xs">{columnTasks.filter((t) => !t.isCompleted).length}</span>
        <DropdownMenu>
          <DropdownMenuTrigger
            render={
              <button className="text-muted-foreground transition-colors hover:text-foreground" type="button">
                <MoreVertical className="size-4" />
              </button>
            }
          />
          <DropdownMenuContent align="end">
            <DropdownMenuItem
              onClick={() => {
                setRenameValue(col.name)
                setRenaming(true)
              }}
            >
              <Pencil className="mr-2 size-3.5" /> 重命名
            </DropdownMenuItem>
            {!col.isDefault && (
              <>
                <DropdownMenuSeparator />
                <DropdownMenuItem className="text-destructive" onClick={() => deleteColumn.mutate(col.id)}>
                  <Trash2 className="mr-2 size-3.5" /> 删除列
                </DropdownMenuItem>
              </>
            )}
          </DropdownMenuContent>
        </DropdownMenu>
      </div>

      {/* Task list (card-level DnD via the shared DndContext in BoardArea).
          The droppable ref makes the whole list area a drop target so cards
          can be dropped here even when the column is empty. min-h-0 + flex-1
          fills the column height; min-h-[80px] ensures empty columns keep a
          usable drop target. */}
      <div className="cmdscroll flex min-h-[80px] flex-1 flex-col p-2" ref={setDropRef}>
        <SortableContext items={columnTasks.map((t) => t.id)} strategy={verticalListSortingStrategy}>
          <div className="flex flex-col gap-1.5">
            {columnTasks.map((task) => (
              <SortableTaskCard key={task.id} onEdit={() => onEditTask(task)} task={task} />
            ))}
          </div>
        </SortableContext>
      </div>
    </div>
  )
}

// --- Sortable task card ------------------------------------------------------

function SortableTaskCard(props: { task: WorkbenchTask; onEdit: () => void }): React.JSX.Element {
  const { task, onEdit } = props
  const { attributes, listeners, setNodeRef, transform, transition, isDragging } = useSortable({ id: task.id })
  const completeTask = useCompleteTask()
  const reopenTask = useReopenTask()
  const deleteTask = useDeleteTask()

  const overdue = !task.isCompleted && isOverdue(task.deadline)
  const deadlineStr = formatDeadline(task.deadline)
  const startDateStr = formatDate(task.startDate)

  return (
    <div
      className={cn(
        'group flex flex-col gap-1 rounded-lg border border-border/50 bg-background p-2.5 transition-colors hover:border-border',
        task.isCompleted && 'opacity-50',
        isDragging && 'opacity-0'
      )}
      ref={setNodeRef}
      style={{ transform: CSS.Translate.toString(transform), transition }}
      {...attributes}
      {...listeners}
    >
      <div className="flex items-start gap-2">
        <Checkbox
          checked={task.isCompleted}
          className="mt-0.5"
          onCheckedChange={() => (task.isCompleted ? reopenTask.mutate(task.id) : completeTask.mutate(task.id))}
        />
        <button
          className={cn('flex-1 text-left text-sm leading-snug', task.isCompleted && 'line-through')}
          onClick={onEdit}
          type="button"
        >
          <span className="line-clamp-2">{task.title}</span>
        </button>
        <DropdownMenu>
          <DropdownMenuTrigger
            render={
              <button
                className="text-muted-foreground opacity-0 transition-opacity hover:text-foreground group-hover:opacity-100"
                type="button"
              >
                <MoreVertical className="size-4" />
              </button>
            }
          />
          <DropdownMenuContent align="end">
            <DropdownMenuItem onClick={onEdit}>
              <Pencil className="mr-2 size-3.5" /> 编辑
            </DropdownMenuItem>
            <DropdownMenuSeparator />
            <DropdownMenuItem className="text-destructive" onClick={() => deleteTask.mutate(task.id)}>
              <Trash2 className="mr-2 size-3.5" /> 删除
            </DropdownMenuItem>
          </DropdownMenuContent>
        </DropdownMenu>
      </div>

      {/* Badges */}
      {(startDateStr || deadlineStr || task.tags.length > 0) && (
        <div className="flex flex-wrap items-center gap-1 pl-6">
          {startDateStr && (
            <Badge className="text-muted-foreground" variant="outline">
              <CalendarDays className="mr-1 size-3" />
              {startDateStr}
            </Badge>
          )}
          {deadlineStr && (
            <Badge className={overdue ? 'text-destructive' : 'text-muted-foreground'} variant="outline">
              <CalendarClock className="mr-1 size-3" />
              {deadlineStr}
            </Badge>
          )}
          {task.tags.slice(0, 3).map((tag) => (
            <Badge key={tag} variant="secondary">
              #{tag}
            </Badge>
          ))}
          {task.tags.length > 3 && <Badge variant="ghost">+{task.tags.length - 3}</Badge>}
        </div>
      )}

      {/* Priority dot */}
      <div className="flex items-center gap-1 pl-6">
        <span className={cn('inline-block size-2 rounded-full', PRIORITY_DOT[task.priority])} />
        <span className="text-[10px] text-muted-foreground">{PRIORITY_LABEL[task.priority]}</span>
      </div>
    </div>
  )
}

// --- Add Column Button -------------------------------------------------------

function AddColumnButton(): React.JSX.Element {
  const addColumn = useAddColumn()
  const [adding, setAdding] = useState(false)
  const [name, setName] = useState('')

  const submit = (): void => {
    const trimmed = name.trim()
    if (trimmed) addColumn.mutate({ name: trimmed })
    setName('')
    setAdding(false)
  }

  if (!adding) {
    return (
      <button
        className="flex w-72 shrink-0 flex-col items-center justify-center gap-2 rounded-xl border border-border/60 border-dashed text-muted-foreground transition-colors hover:border-border hover:text-foreground"
        onClick={() => setAdding(true)}
        type="button"
      >
        <Plus className="size-5" />
        <span className="text-sm">添加列</span>
      </button>
    )
  }

  return (
    <div className="flex w-72 shrink-0 flex-col gap-2 rounded-xl border border-border/60 bg-muted/30 p-3">
      <Input
        autoFocus
        onChange={(e) => setName(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === 'Enter') submit()
          if (e.key === 'Escape') setAdding(false)
        }}
        placeholder="列名称"
        value={name}
      />
      <div className="flex gap-2">
        <Button className="h-8 flex-1" onClick={submit} size="sm">
          添加
        </Button>
        <Button className="h-8" onClick={() => setAdding(false)} size="sm" variant="outline">
          取消
        </Button>
      </div>
    </div>
  )
}

// --- Date picker field (Popover + Calendar, date-only, clearable) ------------

function DatePickerField(props: {
  label: string
  value: string
  onChange: (iso: string) => void
  placeholder?: string
}): React.JSX.Element {
  const { label, value, onChange, placeholder = '留空' } = props
  const [open, setOpen] = useState(false)
  const selected = toDate(value)
  const display = formatDate(value)

  return (
    <div className="flex-1">
      <span className="mb-1 block text-muted-foreground text-xs">{label}</span>
      <div className="flex gap-1">
        <Popover onOpenChange={setOpen} open={open}>
          <PopoverTrigger
            render={
              <Button className="flex-1 justify-start font-normal" type="button" variant="outline">
                <CalendarDays className="mr-1 size-3.5 text-muted-foreground" />
                {display ?? <span className="text-muted-foreground">{placeholder}</span>}
              </Button>
            }
          />
          <PopoverContent align="start" className="w-auto p-0">
            <Calendar
              captionLayout="dropdown"
              locale={zhCN}
              mode="single"
              onSelect={(date) => {
                onChange(toISODate(date ?? undefined))
                setOpen(false)
              }}
              selected={selected}
            />
          </PopoverContent>
        </Popover>
        {value && (
          <Button className="shrink-0" onClick={() => onChange('')} size="icon" type="button" variant="outline">
            <X className="size-3.5" />
          </Button>
        )}
      </div>
    </div>
  )
}

// --- Task Dialog (unified create + edit) -------------------------------------

function TaskDialog(props: { state: NonNullable<DialogState>; onClose: () => void }): React.JSX.Element {
  const { state, onClose } = props
  const existing = state.mode === 'edit' ? state.task : null
  const isEdit = existing !== null

  const createTask = useCreateTask()
  const updateTask = useUpdateTask()

  const [title, setTitle] = useState(existing?.title ?? '')
  const [notes, setNotes] = useState(existing?.notes ?? '')
  const [priority, setPriority] = useState<Priority>(existing?.priority ?? 'medium')
  const [deadline, setDeadline] = useState(existing?.deadline ?? '')
  const [startDate, setStartDate] = useState(existing?.startDate ?? '')
  const [tagsText, setTagsText] = useState(existing?.tags.join(' ') ?? '')

  const parsed = title ? parseInput(title) : null
  const effectivePriority = isEdit ? priority : (parsed?.priority ?? priority)
  const effectiveTags = isEdit ? tagsText : parsed && parsed.tags.length > 0 ? parsed.tags.join(' ') : tagsText
  // In create mode the parsed deadline is the default, but a manual picker
  // selection (deadline state) takes precedence once the user picks one.
  const effectiveDeadline = isEdit ? deadline : deadline || parsed?.deadline || ''

  const save = (): void => {
    const trimmedTitle = title.trim()
    if (!trimmedTitle) return

    if (isEdit && existing) {
      updateTask.mutate({
        id: existing.id,
        patch: {
          title: trimmedTitle,
          notes,
          priority,
          deadline: deadline || null,
          startDate: startDate || null,
          tags: tagsText.split(/\s+/).filter(Boolean),
        },
      })
    } else {
      createTask.mutate({
        title: parsed?.title || trimmedTitle,
        notes,
        deadline: deadline || parsed?.deadline || null,
        startDate: startDate || null,
        priority: effectivePriority,
        tags: (isEdit ? tagsText : effectiveTags).split(/\s+/).filter(Boolean),
        columnId: state.mode === 'create' ? state.columnId : null,
      })
    }
    onClose()
  }

  const preview = parsed && (parsed.tags.length > 0 || parsed.deadline || parsed.priority !== 'medium')

  return (
    <Dialog
      onOpenChange={(open) => {
        if (!open) onClose()
      }}
      open
    >
      <DialogContent className="max-w-md">
        <DialogHeader>
          <DialogTitle>{isEdit ? '编辑任务' : '新建任务'}</DialogTitle>
        </DialogHeader>
        <div className="flex flex-col gap-3 py-2">
          <div>
            <span className="mb-1 block text-muted-foreground text-xs">标题</span>
            <Input
              autoFocus
              onChange={(e) => setTitle(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) save()
              }}
              placeholder="标题 (可含 !高 #标签 明天 18:00)"
              value={title}
            />
            {!isEdit && preview && (
              <div className="mt-1.5 flex flex-wrap gap-1">
                {parsed?.deadline && (
                  <Badge variant="outline">
                    <CalendarClock className="mr-1 size-3" />
                    {formatDeadline(parsed.deadline)}
                  </Badge>
                )}
                {parsed?.tags.map((t) => (
                  <Badge key={t} variant="secondary">
                    #{t}
                  </Badge>
                ))}
                {parsed && parsed.priority !== 'medium' && (
                  <Badge variant="ghost">{PRIORITY_LABEL[parsed.priority]}</Badge>
                )}
              </div>
            )}
          </div>
          <div>
            <span className="mb-1 block text-muted-foreground text-xs">备注</span>
            <Textarea className="min-h-[80px]" onChange={(e) => setNotes(e.target.value)} value={notes} />
          </div>
          <div className="flex gap-3">
            <div className="flex-1">
              <span className="mb-1 block text-muted-foreground text-xs">优先级</span>
              <div className="flex gap-1">
                {PRIORITIES.map((p) => (
                  <button
                    className={cn(
                      'flex-1 rounded-md border px-2 py-1.5 text-sm transition-colors',
                      effectivePriority === p
                        ? 'border-primary bg-primary/10 text-primary'
                        : 'border-border text-muted-foreground hover:bg-muted'
                    )}
                    key={p}
                    onClick={() => {
                      if (isEdit) setPriority(p)
                    }}
                    type="button"
                  >
                    {PRIORITY_LABEL[p]}
                  </button>
                ))}
              </div>
            </div>
          </div>
          <div className="flex gap-3">
            <DatePickerField label="开始日期" onChange={setStartDate} value={startDate} />
            <DatePickerField label="截止日期" onChange={setDeadline} value={effectiveDeadline} />
          </div>
          <div>
            <span className="mb-1 block text-muted-foreground text-xs">标签 (空格分隔)</span>
            <Input
              onChange={(e) => {
                if (isEdit) setTagsText(e.target.value)
              }}
              placeholder="工作 学习 个人"
              value={effectiveTags}
            />
          </div>
        </div>
        <div className="flex justify-end gap-2">
          <Button onClick={onClose} variant="outline">
            取消
          </Button>
          <Button disabled={!title.trim()} onClick={save}>
            {isEdit ? '保存' : '创建'}
          </Button>
        </div>
      </DialogContent>
    </Dialog>
  )
}
