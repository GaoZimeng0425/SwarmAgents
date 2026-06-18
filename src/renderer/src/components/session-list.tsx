import { useMemo, useState } from 'react'
import { closestCenter, DndContext, type DragEndEvent, PointerSensor, useSensor, useSensors } from '@dnd-kit/core'
import { restrictToVerticalAxis } from '@dnd-kit/modifiers'
import { SortableContext, useSortable, verticalListSortingStrategy } from '@dnd-kit/sortable'
import { CSS } from '@dnd-kit/utilities'
import type { SessionSummary } from '@shared/types/ui'
import { useNavigate } from '@tanstack/react-router'
import { Loader2, Pencil, Pin, PinOff, Search, SquarePen, Trash2 } from 'lucide-react'
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
import { pickNextSession } from '@/lib/session-nav'
import { cn } from '@/lib/utils'
import { useSessionsStore } from '@/stores/sessions'

type LiveStatus = 'running' | 'awaiting' | 'idle'

function SortableSessionRow({ id, children }: { id: string; children: React.ReactNode }): React.JSX.Element {
  const { attributes, listeners, setNodeRef, transform, transition, isDragging } = useSortable({ id })
  return (
    <div
      ref={setNodeRef}
      style={{ transform: CSS.Transform.toString(transform), transition, opacity: isDragging ? 0.5 : 1 }}
      {...attributes}
      {...listeners}
    >
      {children}
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

  const [renamingId, setRenamingId] = useState<string | null>(null)
  const [renameValue, setRenameValue] = useState('')
  const [pendingDelete, setPendingDelete] = useState<SessionSummary | null>(null)
  const [searching, setSearching] = useState(false)
  const [query, setQuery] = useState('')

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

  // Live title filter for the Search row.
  const visibleSessions = useMemo(() => {
    const q = query.trim().toLowerCase()
    if (!q) return sessions
    return sessions.filter((s) => (s.title ?? 'Untitled chat').toLowerCase().includes(q))
  }, [sessions, query])

  const sensors = useSensors(useSensor(PointerSensor, { activationConstraint: { distance: 6 } }))

  const onDragEnd = (e: DragEndEvent): void => {
    const { active, over } = e
    if (!over || active.id === over.id) return
    const ids = visibleSessions.map((s) => s.id)
    const from = ids.indexOf(active.id as string)
    const to = ids.indexOf(over.id as string)
    if (from < 0 || to < 0) return
    const next = [...ids]
    next.splice(to, 0, next.splice(from, 1)[0])
    reorder(next) // optimistic
    void swarmApi.reorderSessions(next).catch((err) => {
      console.error(err)
      toast.error('Could not save the new order.')
    })
  }

  const closeSearch = (): void => {
    setSearching(false)
    setQuery('')
  }

  const onNew = async (): Promise<void> => {
    try {
      const { sessionId } = await swarmApi.createSession()
      void navigate({ to: '/session/$sessionId', params: { sessionId } })
    } catch (err) {
      toast.error('Could not start a new chat. Configure an API key in Settings.')
      console.error(err)
    }
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

  // Shared row renderer used in both the plain (search) and sortable list paths.
  const renderRow = (s: SessionSummary): React.JSX.Element => {
    const status = statusBySession.get(s.id) ?? 'idle'
    const title = s.title ?? 'Untitled chat'

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
                'group relative flex items-center gap-2.5 rounded-lg px-3 py-2 text-left text-sidebar-foreground/70 text-sm transition-all hover:bg-sidebar-accent hover:text-sidebar-foreground',
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
      {searching ? (
        <div className="flex h-10 shrink-0 items-center px-1">
          <Input
            autoFocus
            className="h-8 rounded-lg border-none bg-muted/30 text-sm shadow-none placeholder:text-muted-foreground/50 focus-visible:ring-1 focus-visible:ring-primary/20"
            onBlur={() => {
              if (!query.trim()) closeSearch()
            }}
            onChange={(e) => setQuery(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Escape') closeSearch()
            }}
            placeholder="Search chats…"
            value={query}
          />
        </div>
      ) : (
        <button
          className="flex h-10 shrink-0 items-center gap-2.5 rounded-lg px-3.5 text-left font-medium text-muted-foreground text-xs uppercase tracking-tight transition-colors hover:bg-muted/30 hover:text-foreground"
          onClick={() => setSearching(true)}
          type="button"
        >
          <Search className="size-3.5 shrink-0" />
          Search
        </button>
      )}
      <ScrollArea className="mt-2 flex-1">
        {query.trim() ? (
          // Search active: render plain list without drag (reorder during filter is out of scope).
          <div className="flex flex-col gap-1">
            {visibleSessions.map((s) => renderRow(s))}
            {visibleSessions.length === 0 && (
              <p className="px-3 py-2 text-muted-foreground text-xs">No matching chats.</p>
            )}
          </div>
        ) : (
          // No search: wrap in DndContext for drag-to-reorder.
          <DndContext
            collisionDetection={closestCenter}
            modifiers={[restrictToVerticalAxis]}
            onDragEnd={onDragEnd}
            sensors={sensors}
          >
            <SortableContext items={visibleSessions.map((s) => s.id)} strategy={verticalListSortingStrategy}>
              <div className="flex flex-col gap-1">
                {visibleSessions.map((s) => {
                  const row = renderRow(s)
                  // Rename input: don't wrap in SortableSessionRow (no drag while editing)
                  if (renamingId === s.id) return row
                  return (
                    <SortableSessionRow id={s.id} key={s.id}>
                      {row}
                    </SortableSessionRow>
                  )
                })}
                {visibleSessions.length === 0 && (
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
              “{pendingDelete?.title ?? 'Untitled chat'}” and its history will be permanently removed. This cannot be
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
