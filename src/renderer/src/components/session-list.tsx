import { useMemo, useState } from 'react'
import { closestCenter, DndContext, type DragEndEvent, PointerSensor, useSensor, useSensors } from '@dnd-kit/core'
import { restrictToVerticalAxis } from '@dnd-kit/modifiers'
import { SortableContext, useSortable, verticalListSortingStrategy } from '@dnd-kit/sortable'
import { CSS } from '@dnd-kit/utilities'
import type { SessionSummary } from '@shared/types/ui'
import { useNavigate } from '@tanstack/react-router'
import {
  CalendarClock,
  ChevronRight,
  Folder,
  Loader2,
  Pencil,
  Pin,
  PinOff,
  Search,
  SquarePen,
  Trash2,
} from 'lucide-react'
import { toast } from 'sonner'

import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from '@/components/ui/alert-dialog'
import {
  ContextMenu,
  ContextMenuContent,
  ContextMenuItem,
  ContextMenuSeparator,
  ContextMenuTrigger,
} from '@/components/ui/context-menu'
import { Input } from '@/components/ui/input'
import { ScrollArea } from '@/components/ui/scroll-area'
import { useTasks } from '@/hooks/use-tasks'
import { swarmApi } from '@/lib/api'
import { formatTokens } from '@/lib/format-usage'
import { type DirectoryGroup, flattenForReorder, groupSessionsByDirectory, UNGROUPED } from '@/lib/session-grouping'
import { pickNextSession } from '@/lib/session-nav'
import { cn } from '@/lib/utils'
import { useSearchDialog } from '@/stores/search-dialog'
import { type SessionViewMode, useSessionView } from '@/stores/session-view'
import { useSessionsStore } from '@/stores/sessions'

type LiveStatus = 'running' | 'awaiting' | 'idle'

function SortableSessionRow({ id, children }: { id: string; children: React.ReactNode }): React.JSX.Element {
  const { attributes, listeners, setNodeRef, transform, transition, isDragging } = useSortable({ id })
  return (
    <div
      className="w-full min-w-0"
      ref={setNodeRef}
      style={{ transform: CSS.Transform.toString(transform), transition, opacity: isDragging ? 0.5 : 1 }}
      {...attributes}
      {...listeners}
    >
      {children}
    </div>
  )
}

// A collapsible, draggable directory header with its session children nested
// underneath. The header doubles as the drag handle and the collapse toggle —
// the pointer sensor's distance threshold keeps a click from starting a drag.
function SortableDirectoryGroup({
  dir,
  label,
  count,
  collapsed,
  draggable,
  onToggle,
  children,
}: {
  dir: string
  label: string
  count: number
  collapsed: boolean
  draggable: boolean
  onToggle: () => void
  children: React.ReactNode
}): React.JSX.Element {
  const { attributes, listeners, setNodeRef, transform, transition, isDragging } = useSortable({
    id: dir,
    disabled: !draggable,
  })
  return (
    <div
      className="min-w-0"
      ref={setNodeRef}
      style={{ transform: CSS.Transform.toString(transform), transition, opacity: isDragging ? 0.5 : 1 }}
    >
      <button
        className="flex w-full min-w-0 items-center gap-1.5 rounded-md px-2 py-1.5 text-left font-medium text-muted-foreground text-xs transition-colors hover:bg-muted/30 hover:text-foreground"
        onClick={onToggle}
        title={dir === UNGROUPED ? '无目录' : dir}
        type="button"
        {...attributes}
        {...listeners}
      >
        <ChevronRight className={cn('size-3.5 shrink-0 transition-transform', !collapsed && 'rotate-90')} />
        <Folder className="size-3.5 shrink-0" />
        <span className="flex-1 truncate">{label}</span>
        <span className="shrink-0 text-muted-foreground/50 tabular-nums">{count}</span>
      </button>
      {!collapsed && <div className="mt-1 ml-2 flex flex-col gap-1 border-border/30 border-l pl-2">{children}</div>}
    </div>
  )
}

export function SessionList(): React.JSX.Element {
  const sessions = useSessionsStore((s) => s.sessions)
  const selected = useSessionsStore((s) => s.selectedSessionId)
  const unread = useSessionsStore((s) => s.unread)
  const upsert = useSessionsStore((s) => s.upsert)
  const removeFromStore = useSessionsStore((s) => s.remove)
  const reorder = useSessionsStore((s) => s.reorder)
  const navigate = useNavigate()
  const tasks = useTasks()
  const openSearch = useSearchDialog((s) => s.openSearch)

  const mode = useSessionView((s) => s.mode)
  const setMode = useSessionView((s) => s.setMode)
  const directoryOrder = useSessionView((s) => s.directoryOrder)
  const setDirectoryOrder = useSessionView((s) => s.setDirectoryOrder)
  const collapsed = useSessionView((s) => s.collapsed)
  const toggleCollapsed = useSessionView((s) => s.toggleCollapsed)

  const [renamingId, setRenamingId] = useState<string | null>(null)
  const [renameValue, setRenameValue] = useState('')
  const [pendingDelete, setPendingDelete] = useState<SessionSummary | null>(null)

  // Derive a live run-status per session so parallel work is visible while you
  // view another conversation (events for every session stream into the cache).
  const statusBySession = useMemo(() => {
    const m = new Map<string, LiveStatus>()
    for (const t of tasks) {
      const cur = m.get(t.sessionId)
      if (cur === 'awaiting') continue
      if (t.status === 'awaiting_user') m.set(t.sessionId, 'awaiting')
      else if (t.status === 'running' || t.status === 'pending') m.set(t.sessionId, 'running')
      else if (!cur) m.set(t.sessionId, 'idle')
    }
    return m
  }, [tasks])

  const sensors = useSensors(useSensor(PointerSensor, { activationConstraint: { distance: 6 } }))

  const systemSession = sessions.find((s) => s.isSystem)
  const userVisibleSessions = useMemo(() => sessions.filter((s) => !s.isSystem), [sessions])
  const byId = useMemo(() => new Map(sessions.map((s) => [s.id, s])), [sessions])
  const groups = useMemo(() => groupSessionsByDirectory(sessions, directoryOrder), [sessions, directoryOrder])

  // Persist a new global session order to the backend (optimistic locally).
  const persistOrder = (orderedIds: string[]): void => {
    reorder(orderedIds)
    void swarmApi.reorderSessions(orderedIds).catch((err) => {
      console.error(err)
      toast.error('Could not save the new order.')
    })
  }

  // Flat mode: reorder the whole (non-system) list, same as before.
  const onFlatDragEnd = (e: DragEndEvent): void => {
    const { active, over } = e
    if (!over || active.id === over.id) return
    const ids = userVisibleSessions.map((s) => s.id)
    const from = ids.indexOf(active.id as string)
    const to = ids.indexOf(over.id as string)
    if (from < 0 || to < 0) return
    const next = [...ids]
    next.splice(to, 0, next.splice(from, 1)[0])
    persistOrder(next)
  }

  // Directory mode: reorder the directory groups themselves (localStorage only).
  const onDirDragEnd = (e: DragEndEvent): void => {
    const { active, over } = e
    if (!over || active.id === over.id) return
    if (active.id === UNGROUPED || over.id === UNGROUPED) return
    const dirs = groups.map((g) => g.dir).filter((d) => d !== UNGROUPED)
    const from = dirs.indexOf(active.id as string)
    const to = dirs.indexOf(over.id as string)
    if (from < 0 || to < 0) return
    const next = [...dirs]
    next.splice(to, 0, next.splice(from, 1)[0])
    setDirectoryOrder(next)
  }

  // Directory mode: reorder sessions within a single group, then persist the
  // full flattened order so backend sortOrder matches the visible order.
  const onSessionDragEnd = (group: DirectoryGroup, e: DragEndEvent): void => {
    const { active, over } = e
    if (!over || active.id === over.id) return
    const ids = group.sessions.map((s) => s.id)
    const from = ids.indexOf(active.id as string)
    const to = ids.indexOf(over.id as string)
    if (from < 0 || to < 0) return // over belongs to a different group — ignore
    const nextIds = [...ids]
    nextIds.splice(to, 0, nextIds.splice(from, 1)[0])
    const nextGroups = groups.map((g) =>
      g.dir === group.dir
        ? { ...g, sessions: nextIds.map((id) => byId.get(id)).filter((s): s is SessionSummary => Boolean(s)) }
        : g
    )
    persistOrder(flattenForReorder(nextGroups))
  }

  // Don't create a session here — that left empty sessions behind. Route to the
  // landing composer at `/`; the session is created lazily on the first message.
  const onNew = (): void => {
    void navigate({ to: '/' })
  }

  const onSelect = (id: string): void => {
    void navigate({ to: '/session/$sessionId', params: { sessionId: id } })
  }

  const togglePin = async (s: SessionSummary): Promise<void> => {
    upsert({ ...s, pinned: !s.pinned })
    await swarmApi.setSessionPinned(s.id, !s.pinned)
  }

  const startRename = (s: SessionSummary): void => {
    setRenameValue(s.title ?? '')
    setRenamingId(s.id)
  }

  const commitRename = async (s: SessionSummary): Promise<void> => {
    const title = renameValue.trim()
    setRenamingId(null)
    if (!title || title === s.title) return
    upsert({ ...s, title })
    await swarmApi.renameSession(s.id, title)
  }

  const confirmDelete = async (): Promise<void> => {
    if (!pendingDelete) return
    const { id } = pendingDelete
    const wasCurrent = id === selected
    setPendingDelete(null)
    const next = pickNextSession(sessions, id)
    removeFromStore(id)
    await swarmApi.deleteSession(id)
    // Only redirect if we were viewing the deleted session.
    if (wasCurrent) {
      if (next) void navigate({ to: '/session/$sessionId', params: { sessionId: next } })
      else void navigate({ to: '/' })
    }
  }

  // Row renderer for the sortable session list.
  const renderRow = (s: SessionSummary): React.JSX.Element => {
    const status = statusBySession.get(s.id) ?? 'idle'
    const title = s.title ?? 'Untitled chat'
    // Cumulative session usage (persisted, so it shows without opening the
    // session). Prefer cost; fall back to tokens for free-model sessions.
    const cents = s.usdCents ?? 0
    const tokens = s.tokensUsed ?? 0
    const usageLabel = cents > 0 ? `$${(cents / 100).toFixed(2)}` : tokens > 0 ? formatTokens(tokens) : null
    const usageTitle = `${formatTokens(tokens)} tokens · $${(cents / 100).toFixed(2)}`

    if (renamingId === s.id) {
      return (
        <Input
          autoFocus
          className="h-8 rounded-md border-primary/30 bg-muted/50 px-2 py-1 text-sm"
          key={s.id}
          onBlur={() => void commitRename(s)}
          onChange={(e) => setRenameValue(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Enter') void commitRename(s)
            else if (e.key === 'Escape') setRenamingId(null)
          }}
          value={renameValue}
        />
      )
    }

    return (
      <ContextMenu key={s.id}>
        <ContextMenuTrigger
          render={
            <button
              aria-current={selected === s.id ? 'true' : undefined}
              className={cn(
                'group relative flex w-full min-w-0 items-center gap-2.5 rounded-lg px-3 py-2 text-left text-sidebar-foreground/70 text-sm transition-all hover:bg-sidebar-accent hover:text-sidebar-foreground',
                selected === s.id && 'bg-sidebar-accent font-medium text-sidebar-foreground shadow-sm'
              )}
              onClick={() => onSelect(s.id)}
              title={title}
              type="button"
            >
              {selected === s.id && <div className="absolute top-2 bottom-2 left-0 w-1 rounded-full bg-primary" />}
              {selected !== s.id && unread[s.id] && (
                <span
                  aria-label="Unread activity"
                  className="absolute top-1 left-1 size-1.5 rounded-full bg-primary"
                  role="img"
                />
              )}
              {s.pinned && <Pin className="size-3 shrink-0 rotate-45 text-primary/70" />}
              <span className="flex-1 truncate leading-tight">{title}</span>
              {usageLabel && status === 'idle' && (
                <span className="shrink-0 text-[11px] text-muted-foreground/50 tabular-nums" title={usageTitle}>
                  {usageLabel}
                </span>
              )}
              {status === 'running' && (
                <Loader2 aria-label="Running" className="size-3 shrink-0 animate-spin text-primary" />
              )}
              {status === 'awaiting' && (
                <span
                  aria-label="Awaiting input"
                  className="size-1.5 shrink-0 rounded-full bg-amber-500 shadow-[0_0_8px_rgba(245,158,11,0.5)]"
                  role="img"
                />
              )}
            </button>
          }
        />
        <ContextMenuContent className="min-w-40 rounded-xl shadow-xl">
          <ContextMenuItem onClick={() => void togglePin(s)}>
            {s.pinned ? <PinOff className="size-4" /> : <Pin className="size-4" />}
            {s.pinned ? 'Unpin' : 'Pin'}
          </ContextMenuItem>
          <ContextMenuItem onClick={() => startRename(s)}>
            <Pencil className="size-4" />
            Rename
          </ContextMenuItem>
          <ContextMenuSeparator />
          <ContextMenuItem
            className="text-destructive data-[highlighted]:text-destructive"
            onClick={() => setPendingDelete(s)}
          >
            <Trash2 className="size-4" />
            Delete
          </ContextMenuItem>
        </ContextMenuContent>
      </ContextMenu>
    )
  }

  // The dedicated system session ("定时任务") is rendered as a fixed row pinned
  // above the normal list — not draggable, not renamable/deletable. Opening it
  // shows the transcripts of every scheduled run.
  const renderSystemRow = (s: SessionSummary): React.JSX.Element => {
    const status = statusBySession.get(s.id) ?? 'idle'
    return (
      <ContextMenu key={s.id}>
        <ContextMenuTrigger
          render={
            <button
              aria-current={selected === s.id ? 'true' : undefined}
              className={cn(
                'group relative flex w-full min-w-0 items-center gap-2.5 rounded-lg px-3 py-2 text-left text-sidebar-foreground/80 text-sm transition-all hover:bg-sidebar-accent hover:text-sidebar-foreground',
                selected === s.id && 'bg-sidebar-accent font-medium text-sidebar-foreground shadow-sm'
              )}
              onClick={() => onSelect(s.id)}
              title="定时任务"
              type="button"
            >
              {selected === s.id && <div className="absolute top-2 bottom-2 left-0 w-1 rounded-full bg-primary" />}
              <CalendarClock className="size-4 shrink-0 text-primary/80" />
              <span className="flex-1 truncate font-medium leading-tight">定时任务</span>
              {status === 'running' && (
                <Loader2 aria-label="Running" className="size-3 shrink-0 animate-spin text-primary" />
              )}
            </button>
          }
        />
        <ContextMenuContent className="min-w-40 rounded-xl shadow-xl">
          <ContextMenuItem onClick={() => void togglePin(s)}>
            {s.pinned ? <PinOff className="size-4" /> : <Pin className="size-4" />}
            {s.pinned ? 'Unpin' : 'Pin'}
          </ContextMenuItem>
        </ContextMenuContent>
      </ContextMenu>
    )
  }

  // Wrap a session row in a sortable shell unless it's being renamed inline.
  const renderSortableRow = (s: SessionSummary): React.JSX.Element => {
    const row = renderRow(s)
    if (renamingId === s.id) return row
    return (
      <SortableSessionRow id={s.id} key={s.id}>
        {row}
      </SortableSessionRow>
    )
  }

  const segments: { value: SessionViewMode; label: string }[] = [
    { value: 'flat', label: '默认' },
    { value: 'directory', label: '按目录' },
  ]

  return (
    // The sidebar header (toggle + nav arrows) already clears the traffic
    // lights, so the action rows start with only a small top gap.
    <div className="flex h-full flex-col gap-1 px-3 pt-2 pb-2">
      <button
        className="flex h-10 shrink-0 items-center gap-2.5 rounded-xl bg-primary/10 px-4 text-left font-semibold text-primary text-sm transition-all hover:bg-primary/15 active:scale-[0.98]"
        onClick={() => void onNew()}
        type="button"
      >
        <SquarePen className="size-4 shrink-0 stroke-[2.5px]" />
        New chat
      </button>
      <button
        className="flex h-10 shrink-0 items-center gap-2.5 rounded-lg px-3.5 text-left font-medium text-muted-foreground text-xs uppercase tracking-tight transition-colors hover:bg-muted/30 hover:text-foreground"
        onClick={() => openSearch()}
        type="button"
      >
        <Search className="size-3.5 shrink-0" />
        Search
        <kbd className="ml-auto font-sans text-[10px] text-muted-foreground/60 normal-case tracking-normal">⌘K</kbd>
      </button>

      {/* Segmented control: flat list vs. directory grouping. Persisted. */}
      <div className="mt-2 flex shrink-0 rounded-lg bg-muted/40 p-0.5 text-xs">
        {segments.map((seg) => (
          <button
            className={cn(
              'flex-1 rounded-md px-2 py-1 font-medium transition-colors',
              mode === seg.value
                ? 'bg-background text-foreground shadow-sm'
                : 'text-muted-foreground hover:text-foreground'
            )}
            key={seg.value}
            onClick={() => setMode(seg.value)}
            type="button"
          >
            {seg.label}
          </button>
        ))}
      </div>

      <ScrollArea className="mt-2 min-h-0 flex-1">
        {systemSession && (
          <div className="mb-1 flex flex-col gap-1 border-border/30 border-b pb-1">
            {renderSystemRow(systemSession)}
          </div>
        )}

        {mode === 'flat' ? (
          <DndContext
            collisionDetection={closestCenter}
            modifiers={[restrictToVerticalAxis]}
            onDragEnd={onFlatDragEnd}
            sensors={sensors}
          >
            <SortableContext items={userVisibleSessions.map((s) => s.id)} strategy={verticalListSortingStrategy}>
              <div className="flex flex-col gap-1">
                {userVisibleSessions.map((s) => renderSortableRow(s))}
                {userVisibleSessions.length === 0 && (
                  <p className="px-3 py-2 text-muted-foreground text-xs">
                    No chats yet. Click &quot;New chat&quot; above.
                  </p>
                )}
              </div>
            </SortableContext>
          </DndContext>
        ) : (
          <DndContext
            collisionDetection={closestCenter}
            modifiers={[restrictToVerticalAxis]}
            onDragEnd={onDirDragEnd}
            sensors={sensors}
          >
            <SortableContext items={groups.map((g) => g.dir)} strategy={verticalListSortingStrategy}>
              <div className="flex flex-col gap-1">
                {groups.map((group) => (
                  <SortableDirectoryGroup
                    collapsed={Boolean(collapsed[group.dir])}
                    count={group.sessions.length}
                    dir={group.dir}
                    draggable={group.dir !== UNGROUPED}
                    key={group.dir}
                    label={group.label}
                    onToggle={() => toggleCollapsed(group.dir)}
                  >
                    <DndContext
                      collisionDetection={closestCenter}
                      modifiers={[restrictToVerticalAxis]}
                      onDragEnd={(e) => onSessionDragEnd(group, e)}
                      sensors={sensors}
                    >
                      <SortableContext items={group.sessions.map((s) => s.id)} strategy={verticalListSortingStrategy}>
                        {group.sessions.map((s) => renderSortableRow(s))}
                      </SortableContext>
                    </DndContext>
                  </SortableDirectoryGroup>
                ))}
                {groups.length === 0 && (
                  <p className="px-3 py-2 text-muted-foreground text-xs">
                    No chats yet. Click &quot;New chat&quot; above.
                  </p>
                )}
              </div>
            </SortableContext>
          </DndContext>
        )}
      </ScrollArea>

      <AlertDialog onOpenChange={(open) => !open && setPendingDelete(null)} open={pendingDelete !== null}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Delete chat?</AlertDialogTitle>
            <AlertDialogDescription>
              "{pendingDelete?.title ?? 'Untitled chat'}" and its history will be permanently removed. This cannot be
              undone.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>Cancel</AlertDialogCancel>
            <AlertDialogAction
              className="bg-destructive text-destructive-foreground hover:bg-destructive/90"
              onClick={() => void confirmDelete()}
            >
              Delete
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </div>
  )
}
