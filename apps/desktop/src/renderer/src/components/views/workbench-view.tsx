// Workbench (工作面板) — a kanban task board ported from the WorkPanel macOS app.
// Layout: header (title + task count) over a horizontally-scrolling row of
// columns + an "add column" button. Each column has an inline quick-capture
// input (parsed by input-parser), a scrollable list of task cards, and a
// header menu (rename / delete). Cards have a complete-checkbox, priority dot,
// title, badges (deadline / tags), and a context menu (edit / move / delete).
// No drag-and-drop yet — cards are moved via the context menu's "move to" submenu.
import { useState } from 'react'
import type { Priority, WorkbenchColumn, WorkbenchTask } from '@swarm/protocol'
import {
  Badge,
  Button,
  Checkbox,
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuSub,
  DropdownMenuSubContent,
  DropdownMenuSubTrigger,
  DropdownMenuTrigger,
  Input,
  Textarea,
} from '@swarm/ui'
import { useQuery } from '@tanstack/react-query'
import { ArrowDown, ArrowUp, CalendarClock, MoreVertical, Pencil, Plus, Trash2 } from 'lucide-react'

import {
  useAddColumn,
  useCompleteTask,
  useCreateTask,
  useDeleteColumn,
  useDeleteTask,
  useMoveTask,
  useRenameColumn,
  useReopenTask,
  useUpdateTask,
  useWorkbenchData,
  useWorkbenchSync,
} from '@/hooks/use-workbench'
import { parseInput } from '@/lib/workbench/input-parser'

const PRIORITY_LABEL: Record<Priority, string> = { high: '高', medium: '中', low: '低' }
const PRIORITY_DOT: Record<Priority, string> = {
  high: 'bg-red-500',
  medium: 'bg-yellow-500',
  low: 'bg-blue-400',
}

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

function isOverdue(iso: string | null): boolean {
  if (!iso) return false
  return new Date(iso).getTime() < Date.now()
}

export function WorkbenchView(): React.JSX.Element {
  const { data } = useWorkbenchData()
  useWorkbenchSync()

  const columns = [...data.columns].sort((a, b) => a.order - b.order)
  const totalTasks = data.tasks.filter((t) => !t.isCompleted).length

  return (
    <div className="flex h-full w-full flex-col">
      <header className="flex flex-none flex-col gap-3 border-border/70 border-b px-5 pt-4 pb-3">
        <div className="flex flex-wrap items-center justify-between gap-3">
          <div>
            <h1 className="font-semibold text-foreground text-xl tracking-tight">工作面板</h1>
            <p className="mt-0.5 text-muted-foreground text-xs">看板任务管理 · {totalTasks} 个进行中</p>
          </div>
        </div>
      </header>

      <div className="cmdscroll flex min-h-0 flex-1 gap-3 overflow-x-auto p-4">
        {columns.map((col) => (
          <WorkbenchColumnView col={col} columns={columns} key={col.id} tasks={data.tasks} />
        ))}
        <AddColumnButton />
      </div>
    </div>
  )
}

// --- Column ------------------------------------------------------------------

function WorkbenchColumnView(props: {
  col: WorkbenchColumn
  columns: WorkbenchColumn[]
  tasks: WorkbenchTask[]
}): React.JSX.Element {
  const { col, columns, tasks } = props
  const createTask = useCreateTask()
  const deleteColumn = useDeleteColumn()
  const renameColumn = useRenameColumn()
  const moveTask = useMoveTask()
  const [draft, setDraft] = useState('')
  const [renaming, setRenaming] = useState(false)
  const [renameValue, setRenameValue] = useState(col.name)
  const [editingTask, setEditingTask] = useState<WorkbenchTask | null>(null)

  const columnTasks = tasks
    .filter((t) => t.columnId === col.id)
    .sort((a, b) => {
      // Incomplete first, then by boardOrder
      if (a.isCompleted !== b.isCompleted) return a.isCompleted ? 1 : -1
      return a.boardOrder - b.boardOrder
    })

  const submitDraft = (): void => {
    const trimmed = draft.trim()
    if (!trimmed) return
    const parsed = parseInput(trimmed)
    createTask.mutate({
      title: parsed.title || trimmed,
      notes: '',
      deadline: parsed.deadline,
      priority: parsed.priority,
      tags: parsed.tags,
      columnId: col.id,
    })
    setDraft('')
  }

  const submitRename = (): void => {
    const name = renameValue.trim()
    if (name && name !== col.name) {
      renameColumn.mutate({ id: col.id, name })
    }
    setRenaming(false)
  }

  return (
    <div className="flex w-72 shrink-0 flex-col rounded-xl border border-border/60 bg-muted/30">
      {/* Column header */}
      <div className="flex items-center justify-between gap-1 border-border/60 border-b px-3 py-2">
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

      {/* Quick capture */}
      <div className="border-border/60 border-b px-3 py-2">
        <Input
          className="h-8 text-sm"
          onChange={(e) => setDraft(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Enter') submitDraft()
          }}
          placeholder="写周报 明天 18:00 !高 #工作"
          value={draft}
        />
      </div>

      {/* Task list */}
      <div className="cmdscroll flex min-h-0 flex-1 flex-col gap-1.5 overflow-y-auto p-2">
        {columnTasks.length === 0 ? (
          <p className="py-4 text-center text-muted-foreground text-xs">暂无任务</p>
        ) : (
          columnTasks.map((task, i) => (
            <TaskCard
              columns={columns}
              index={i}
              key={task.id}
              onEdit={() => setEditingTask(task)}
              onMove={(toColId, toIndex) => moveTask.mutate({ taskId: task.id, columnId: toColId, index: toIndex })}
              task={task}
              totalInColumn={columnTasks.filter((t) => !t.isCompleted).length}
            />
          ))
        )}
      </div>

      {/* Task edit dialog */}
      {editingTask && <TaskEditDialog onClose={() => setEditingTask(null)} task={editingTask} />}
    </div>
  )
}

// --- Task Card ---------------------------------------------------------------

function TaskCard(props: {
  task: WorkbenchTask
  columns: WorkbenchColumn[]
  index: number
  totalInColumn: number
  onEdit: () => void
  onMove: (toColId: string, index: number) => void
}): React.JSX.Element {
  const { task, columns, index, totalInColumn, onEdit, onMove } = props
  const completeTask = useCompleteTask()
  const reopenTask = useReopenTask()
  const deleteTask = useDeleteTask()

  const overdue = !task.isCompleted && isOverdue(task.deadline)
  const deadlineStr = formatDeadline(task.deadline)

  return (
    <div
      className={`group flex flex-col gap-1 rounded-lg border border-border/50 bg-background p-2.5 transition-colors hover:border-border ${
        task.isCompleted ? 'opacity-50' : ''
      }`}
    >
      <div className="flex items-start gap-2">
        <Checkbox
          checked={task.isCompleted}
          className="mt-0.5"
          onCheckedChange={() => (task.isCompleted ? reopenTask.mutate(task.id) : completeTask.mutate(task.id))}
        />
        <button
          className={`flex-1 text-left text-sm leading-snug ${task.isCompleted ? 'line-through' : ''}`}
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
            {index > 0 && (
              <DropdownMenuItem onClick={() => onMove(task.columnId ?? '', index - 1)}>
                <ArrowUp className="mr-2 size-3.5" /> 上移
              </DropdownMenuItem>
            )}
            {index < totalInColumn - 1 && (
              <DropdownMenuItem onClick={() => onMove(task.columnId ?? '', index + 2)}>
                <ArrowDown className="mr-2 size-3.5" /> 下移
              </DropdownMenuItem>
            )}
            {columns.length > 1 && (
              <DropdownMenuSub>
                <DropdownMenuSubTrigger>移动到…</DropdownMenuSubTrigger>
                <DropdownMenuSubContent>
                  {columns
                    .filter((c) => c.id !== task.columnId)
                    .map((c) => (
                      <DropdownMenuItem key={c.id} onClick={() => onMove(c.id, Number.MAX_SAFE_INTEGER)}>
                        {c.name}
                      </DropdownMenuItem>
                    ))}
                </DropdownMenuSubContent>
              </DropdownMenuSub>
            )}
            <DropdownMenuSeparator />
            <DropdownMenuItem className="text-destructive" onClick={() => deleteTask.mutate(task.id)}>
              <Trash2 className="mr-2 size-3.5" /> 删除
            </DropdownMenuItem>
          </DropdownMenuContent>
        </DropdownMenu>
      </div>

      {/* Badges */}
      {(deadlineStr || task.tags.length > 0) && (
        <div className="flex flex-wrap items-center gap-1 pl-6">
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
        <span className={`inline-block size-2 rounded-full ${PRIORITY_DOT[task.priority]}`} />
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

// --- Task Edit Dialog --------------------------------------------------------

const PRIORITIES: Priority[] = ['high', 'medium', 'low']

function TaskEditDialog(props: { task: WorkbenchTask; onClose: () => void }): React.JSX.Element {
  const { task, onClose } = props
  const updateTask = useUpdateTask()
  const [title, setTitle] = useState(task.title)
  const [notes, setNotes] = useState(task.notes)
  const [priority, setPriority] = useState<Priority>(task.priority)
  const [deadline, setDeadline] = useState(task.deadline ?? '')
  const [tagsText, setTagsText] = useState(task.tags.join(' '))

  const save = (): void => {
    updateTask.mutate({
      id: task.id,
      patch: {
        title: title.trim() || task.title,
        notes,
        priority,
        deadline: deadline || null,
        tags: tagsText.split(/\s+/).filter(Boolean),
      },
    })
    onClose()
  }

  // Parse live preview of the title line (like the quick-capture)
  const preview = useQuery({
    queryKey: ['workbench', 'preview', title],
    queryFn: () => parseInput(title),
    staleTime: 0,
  }).data

  return (
    <Dialog
      onOpenChange={(open) => {
        if (!open) onClose()
      }}
      open
    >
      <DialogContent className="max-w-md">
        <DialogHeader>
          <DialogTitle>编辑任务</DialogTitle>
        </DialogHeader>
        <div className="flex flex-col gap-3 py-2">
          <div>
            <span className="mb-1 block text-muted-foreground text-xs">标题</span>
            <Input
              onChange={(e) => setTitle(e.target.value)}
              placeholder="标题 (可含 !高 #标签 明天 18:00)"
              value={title}
            />
            {preview && (preview.tags.length > 0 || preview.deadline) && (
              <div className="mt-1.5 flex flex-wrap gap-1">
                {preview.deadline && (
                  <Badge variant="outline">
                    <CalendarClock className="mr-1 size-3" />
                    {formatDeadline(preview.deadline)}
                  </Badge>
                )}
                {preview.tags.map((t) => (
                  <Badge key={t} variant="secondary">
                    #{t}
                  </Badge>
                ))}
                {preview.priority !== 'medium' && <Badge variant="ghost">{PRIORITY_LABEL[preview.priority]}</Badge>}
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
                    className={`flex-1 rounded-md border px-2 py-1.5 text-sm transition-colors ${
                      priority === p
                        ? 'border-primary bg-primary/10 text-primary'
                        : 'border-border text-muted-foreground hover:bg-muted'
                    }`}
                    key={p}
                    onClick={() => setPriority(p)}
                    type="button"
                  >
                    {PRIORITY_LABEL[p]}
                  </button>
                ))}
              </div>
            </div>
            <div className="flex-1">
              <span className="mb-1 block text-muted-foreground text-xs">截止时间</span>
              <Input
                onChange={(e) => setDeadline(e.target.value)}
                placeholder="ISO 或留空"
                type="datetime-local"
                value={deadline ? new Date(deadline).toISOString().slice(0, 16) : ''}
              />
            </div>
          </div>
          <div>
            <span className="mb-1 block text-muted-foreground text-xs">标签 (空格分隔)</span>
            <Input onChange={(e) => setTagsText(e.target.value)} placeholder="工作 学习 个人" value={tagsText} />
          </div>
        </div>
        <div className="flex justify-end gap-2">
          <Button onClick={onClose} variant="outline">
            取消
          </Button>
          <Button onClick={save}>保存</Button>
        </div>
      </DialogContent>
    </Dialog>
  )
}
