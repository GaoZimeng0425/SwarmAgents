# Session List 目录分组过滤器 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 给侧边栏 session 列表加一个「默认 / 按目录」分段过滤器；目录模式下按 `cwd` 分组成可折叠一级节点、session 为二级子项，支持目录间与组内 session 拖拽排序，过滤器选择/目录顺序/折叠状态持久化。

**Architecture:** 新增一个 zustand `persist` store（localStorage）保存视图偏好（mode / directoryOrder / collapsed）；新增一个纯函数模块把 sessions 按 cwd 分组并算出显示顺序，以及把分组拍平回 `reorderSessions` 用的 id 列表；`session-list.tsx` 按 mode 分支渲染——默认模式零改动，目录模式用嵌套 DndContext（外层排目录、每组内层排 session）。

**Tech Stack:** React 19 + TypeScript、zustand（+persist 中间件）、@dnd-kit/core + @dnd-kit/sortable + @dnd-kit/modifiers、Vitest（经 Electron node 跑）、Tailwind、lucide-react。

## Global Constraints

- 回复用中文；**代码注释与 commit message 一律英文**。
- 结构化日志规范本任务不涉及后端业务路径（纯前端视图 + 复用既有 `reorderSessions` IPC），无需新增 pino 日志。
- 跑测试用 `npm test`（经 Electron node），**不要** `pnpm rebuild better-sqlite3`。
- biome 格式化要 scoped：`npx biome check --write <file>`，不要跑 `npm run check`（它会重排整个仓库）。
- 在独立 git worktree 上开发（见执行交接说明），不要直接在 develop 上改。
- 默认模式（flat）行为零变更；不改 `cwd` 语义；不支持跨目录拖 session；目录顺序不进后端。

---

## File Structure

- Create: `src/renderer/src/stores/session-view.ts` — 视图偏好 store（persist 到 localStorage `swarm:session-view`）。
- Create: `src/renderer/src/stores/session-view.test.ts` — store 单测。
- Create: `src/renderer/src/lib/session-grouping.ts` — 纯函数：`groupSessionsByDirectory`、`flattenForReorder`、`UNGROUPED` 哨兵、`DirectoryGroup` 类型。
- Create: `src/renderer/src/lib/session-grouping.test.ts` — 纯函数单测。
- Modify: `src/renderer/src/components/session-list.tsx` — 加分段控件、按 mode 分支、目录模式渲染与两层拖拽。

---

## Task 1: 视图偏好 store（session-view）

**Files:**
- Create: `src/renderer/src/stores/session-view.ts`
- Test: `src/renderer/src/stores/session-view.test.ts`

**Interfaces:**
- Consumes: 无（仅 zustand + persist）。
- Produces:
  - `type SessionViewMode = 'flat' | 'directory'`
  - `useSessionView` zustand store，state: `mode: SessionViewMode`、`directoryOrder: string[]`、`collapsed: Record<string, true>`；actions: `setMode(mode: SessionViewMode): void`、`setDirectoryOrder(order: string[]): void`、`toggleCollapsed(dir: string): void`。

- [ ] **Step 1: Write the failing test**

Create `src/renderer/src/stores/session-view.test.ts`:

```ts
import { beforeEach, describe, expect, it } from 'vitest'

import { useSessionView } from './session-view'

describe('session-view store', () => {
  beforeEach(() => {
    useSessionView.setState({ mode: 'flat', directoryOrder: [], collapsed: {} })
  })

  it('defaults to flat mode with no order and nothing collapsed', () => {
    const s = useSessionView.getState()
    expect(s.mode).toBe('flat')
    expect(s.directoryOrder).toEqual([])
    expect(s.collapsed).toEqual({})
  })

  it('setMode switches the view mode', () => {
    useSessionView.getState().setMode('directory')
    expect(useSessionView.getState().mode).toBe('directory')
  })

  it('setDirectoryOrder replaces the order', () => {
    useSessionView.getState().setDirectoryOrder(['/a', '/b'])
    expect(useSessionView.getState().directoryOrder).toEqual(['/a', '/b'])
  })

  it('toggleCollapsed flips a directory on and off', () => {
    const { toggleCollapsed } = useSessionView.getState()
    toggleCollapsed('/a')
    expect(useSessionView.getState().collapsed).toEqual({ '/a': true })
    toggleCollapsed('/a')
    expect(useSessionView.getState().collapsed).toEqual({})
  })
})
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npm test -- src/renderer/src/stores/session-view.test.ts`
Expected: FAIL — cannot find module `./session-view`.

- [ ] **Step 3: Write minimal implementation**

Create `src/renderer/src/stores/session-view.ts`:

```ts
import { create } from 'zustand'
import { persist } from 'zustand/middleware'

export type SessionViewMode = 'flat' | 'directory'

type SessionViewStore = {
  // Which way the sidebar session list is organized.
  mode: SessionViewMode
  // Manual order of directory groups (cwd values); recorded dirs come first.
  directoryOrder: string[]
  // Set of collapsed directory keys (cwd values), kept as a presence map.
  collapsed: Record<string, true>
  setMode: (mode: SessionViewMode) => void
  setDirectoryOrder: (order: string[]) => void
  toggleCollapsed: (dir: string) => void
}

// View preference for the session list. Persisted to localStorage so the
// chosen filter, directory order, and collapse state survive app restarts —
// mirrors the recent-dirs store pattern.
export const useSessionView = create<SessionViewStore>()(
  persist(
    (set) => ({
      mode: 'flat',
      directoryOrder: [],
      collapsed: {},
      setMode: (mode) => set({ mode }),
      setDirectoryOrder: (directoryOrder) => set({ directoryOrder }),
      toggleCollapsed: (dir) =>
        set((state) => {
          const collapsed = { ...state.collapsed }
          if (collapsed[dir]) delete collapsed[dir]
          else collapsed[dir] = true
          return { collapsed }
        }),
    }),
    { name: 'swarm:session-view' }
  )
)
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npm test -- src/renderer/src/stores/session-view.test.ts`
Expected: PASS (4 tests).

- [ ] **Step 5: Format and commit**

```bash
npx biome check --write src/renderer/src/stores/session-view.ts src/renderer/src/stores/session-view.test.ts
git add src/renderer/src/stores/session-view.ts src/renderer/src/stores/session-view.test.ts
git commit -m "feat(renderer): add session-view store for list filter prefs"
```

---

## Task 2: 分组纯函数（session-grouping）

**Files:**
- Create: `src/renderer/src/lib/session-grouping.ts`
- Test: `src/renderer/src/lib/session-grouping.test.ts`

**Interfaces:**
- Consumes: `SessionSummary` from `@shared/types/ui`（字段用到 `id`、`cwd?`、`isSystem`、`pinned`、`sortOrder`、`lastActiveAt`）。
- Produces:
  - `const UNGROUPED: string` — 无 cwd 会话的哨兵 key。
  - `type DirectoryGroup = { dir: string; label: string; sessions: SessionSummary[] }`
  - `groupSessionsByDirectory(sessions: SessionSummary[], directoryOrder: string[]): DirectoryGroup[]`
  - `flattenForReorder(groups: DirectoryGroup[]): string[]`

- [ ] **Step 1: Write the failing test**

Create `src/renderer/src/lib/session-grouping.test.ts`:

```ts
import type { SessionSummary } from '@shared/types/ui'
import { describe, expect, it } from 'vitest'

import { flattenForReorder, groupSessionsByDirectory, UNGROUPED } from './session-grouping'

const mk = (over: Partial<SessionSummary> & { id: string }): SessionSummary => ({
  id: over.id,
  title: over.title ?? over.id,
  status: 'active',
  lastActiveAt: over.lastActiveAt ?? 0,
  taskCount: 0,
  pinned: over.pinned ?? false,
  sortOrder: over.sortOrder ?? 0,
  isSystem: over.isSystem ?? false,
  cwd: over.cwd,
})

describe('groupSessionsByDirectory', () => {
  it('groups by cwd and puts the ungrouped bucket last', () => {
    const groups = groupSessionsByDirectory(
      [
        mk({ id: 'a', cwd: '/home/proj' }),
        mk({ id: 'b' }), // no cwd
        mk({ id: 'c', cwd: '/home/proj' }),
      ],
      []
    )
    expect(groups.map((g) => g.dir)).toEqual(['/home/proj', UNGROUPED])
    expect(groups[0].sessions.map((s) => s.id)).toEqual(['a', 'c'])
    expect(groups[1].sessions.map((s) => s.id)).toEqual(['b'])
    expect(groups[1].label).toBe('无目录')
  })

  it('excludes system sessions entirely', () => {
    const groups = groupSessionsByDirectory([mk({ id: 'sys', isSystem: true, cwd: '/x' })], [])
    expect(groups).toEqual([])
  })

  it('derives the label from the directory basename', () => {
    const groups = groupSessionsByDirectory([mk({ id: 'a', cwd: '/Users/me/Code/swarm/' })], [])
    expect(groups[0].label).toBe('swarm')
  })

  it('honors directoryOrder for known dirs, then appends unknown by recency desc', () => {
    const groups = groupSessionsByDirectory(
      [
        mk({ id: 'a', cwd: '/a', lastActiveAt: 1 }),
        mk({ id: 'b', cwd: '/b', lastActiveAt: 5 }),
        mk({ id: 'c', cwd: '/c', lastActiveAt: 9 }),
      ],
      ['/b'] // only /b is recorded
    )
    // /b first (recorded); then /c and /a unknown, by lastActiveAt desc
    expect(groups.map((g) => g.dir)).toEqual(['/b', '/c', '/a'])
  })

  it('orders sessions within a group pinned-first then sortOrder', () => {
    const groups = groupSessionsByDirectory(
      [
        mk({ id: 'a', cwd: '/p', pinned: false, sortOrder: 1 }),
        mk({ id: 'b', cwd: '/p', pinned: true, sortOrder: 5 }),
        mk({ id: 'c', cwd: '/p', pinned: false, sortOrder: 0 }),
      ],
      []
    )
    expect(groups[0].sessions.map((s) => s.id)).toEqual(['b', 'c', 'a'])
  })
})

describe('flattenForReorder', () => {
  it('flattens groups into a single id list in display order', () => {
    const groups = groupSessionsByDirectory(
      [mk({ id: 'a', cwd: '/p' }), mk({ id: 'z' }), mk({ id: 'b', cwd: '/p', sortOrder: 1 })],
      []
    )
    expect(flattenForReorder(groups)).toEqual(['a', 'b', 'z'])
  })
})
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npm test -- src/renderer/src/lib/session-grouping.test.ts`
Expected: FAIL — cannot find module `./session-grouping`.

- [ ] **Step 3: Write minimal implementation**

Create `src/renderer/src/lib/session-grouping.ts`:

```ts
import type { SessionSummary } from '@shared/types/ui'

// Sentinel key for sessions without a cwd. Their group always renders last.
export const UNGROUPED = ' ungrouped'

export type DirectoryGroup = {
  // The cwd value, or the UNGROUPED sentinel.
  dir: string
  // Display label: directory basename, or '无目录' for the ungrouped bucket.
  label: string
  sessions: SessionSummary[]
}

// Within a group: pinned sessions first, then ascending manual sortOrder.
const byPinnedThenSortOrder = (a: SessionSummary, b: SessionSummary): number =>
  Number(b.pinned) - Number(a.pinned) || a.sortOrder - b.sortOrder

// Last path segment, tolerating trailing slashes and either separator.
function basename(p: string): string {
  const trimmed = p.replace(/[/\\]+$/, '')
  const idx = Math.max(trimmed.lastIndexOf('/'), trimmed.lastIndexOf('\\'))
  return idx >= 0 ? trimmed.slice(idx + 1) : trimmed
}

// Group non-system sessions by cwd into display-ordered directory groups:
// recorded dirs (per directoryOrder) first, then unrecorded dirs by most-recent
// session activity descending, and the ungrouped bucket always last.
export function groupSessionsByDirectory(
  sessions: SessionSummary[],
  directoryOrder: string[]
): DirectoryGroup[] {
  const buckets = new Map<string, SessionSummary[]>()
  for (const s of sessions) {
    if (s.isSystem) continue
    const key = s.cwd && s.cwd.trim() ? s.cwd : UNGROUPED
    const arr = buckets.get(key)
    if (arr) arr.push(s)
    else buckets.set(key, [s])
  }
  for (const arr of buckets.values()) arr.sort(byPinnedThenSortOrder)

  const known = directoryOrder.filter((d) => d !== UNGROUPED && buckets.has(d))
  const knownSet = new Set(known)
  const unknown = [...buckets.keys()].filter((d) => d !== UNGROUPED && !knownSet.has(d))
  const recencyOf = (d: string): number =>
    (buckets.get(d) ?? []).reduce((max, s) => Math.max(max, s.lastActiveAt), 0)
  unknown.sort((a, b) => recencyOf(b) - recencyOf(a))

  const groups: DirectoryGroup[] = [...known, ...unknown].map((dir) => ({
    dir,
    label: basename(dir),
    sessions: buckets.get(dir) as SessionSummary[],
  }))
  if (buckets.has(UNGROUPED)) {
    groups.push({ dir: UNGROUPED, label: '无目录', sessions: buckets.get(UNGROUPED) as SessionSummary[] })
  }
  return groups
}

// Flatten directory groups into a single ordered id list for reorderSessions,
// preserving the visible (group × within-group) order.
export function flattenForReorder(groups: DirectoryGroup[]): string[] {
  return groups.flatMap((g) => g.sessions.map((s) => s.id))
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npm test -- src/renderer/src/lib/session-grouping.test.ts`
Expected: PASS (6 tests).

- [ ] **Step 5: Format and commit**

```bash
npx biome check --write src/renderer/src/lib/session-grouping.ts src/renderer/src/lib/session-grouping.test.ts
git add src/renderer/src/lib/session-grouping.ts src/renderer/src/lib/session-grouping.test.ts
git commit -m "feat(renderer): add session directory-grouping helpers"
```

---

## Task 3: SessionList 分段控件 + 目录模式渲染与两层拖拽

**Files:**
- Modify: `src/renderer/src/components/session-list.tsx`（整文件替换为下方内容）

**Interfaces:**
- Consumes: Task 1 的 `useSessionView` / `SessionViewMode`；Task 2 的 `groupSessionsByDirectory`、`flattenForReorder`、`UNGROUPED`、`DirectoryGroup`；既有 `useSessionsStore`、`swarmApi.reorderSessions`、`SortableSessionRow`。
- Produces: 无对外接口（终端 UI 组件）。

本任务是 UI 集成，没有可单测的新纯逻辑（逻辑都在 Task 1/2 已测）。验证靠 typecheck + 手动跑应用。

- [ ] **Step 1: 整文件替换 `src/renderer/src/components/session-list.tsx`**

用以下完整内容替换该文件：

```tsx
import { useMemo, useState } from 'react'
import { closestCenter, DndContext, type DragEndEvent, PointerSensor, useSensor, useSensors } from '@dnd-kit/core'
import { restrictToVerticalAxis } from '@dnd-kit/modifiers'
import { SortableContext, useSortable, verticalListSortingStrategy } from '@dnd-kit/sortable'
import { CSS } from '@dnd-kit/utilities'
import type { SessionSummary } from '@shared/types/ui'
import { useNavigate } from '@tanstack/react-router'
import { CalendarClock, ChevronRight, Folder, Loader2, Pencil, Pin, PinOff, Search, SquarePen, Trash2 } from 'lucide-react'
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
import { pickNextSession } from '@/lib/session-nav'
import { type DirectoryGroup, flattenForReorder, groupSessionsByDirectory, UNGROUPED } from '@/lib/session-grouping'
import { cn } from '@/lib/utils'
import { useSearchDialog } from '@/stores/search-dialog'
import { useSessionsStore } from '@/stores/sessions'
import { type SessionViewMode, useSessionView } from '@/stores/session-view'

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
                      <SortableContext
                        items={group.sessions.map((s) => s.id)}
                        strategy={verticalListSortingStrategy}
                      >
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
```

- [ ] **Step 2: Typecheck**

Run: `npm run typecheck`
Expected: PASS（无类型错误）。若报 `renderSortableRow`/import 相关错误，对照 Task 1/2 导出名修正。

- [ ] **Step 3: Run the full unit suite (regression)**

Run: `npm test`
Expected: 全绿，含 Task 1/2 新增用例，且既有 `sessions.test.ts` 不受影响。

- [ ] **Step 4: Format**

```bash
npx biome check --write src/renderer/src/components/session-list.tsx
```

- [ ] **Step 5: Manual verification（用 run-desktop skill 启动应用）**

启动应用并核对：
1. 侧边栏 New chat / Search 下方出现 `默认 | 按目录` 分段控件；默认选中「默认」，列表与改动前一致，拖拽排序仍可用。
2. 点「按目录」→ 列表变成目录分组：每个目录是带 chevron + 文件夹图标 + 计数的可折叠头，hover 头部显示完整路径 tooltip；无 cwd 的会话归入底部「无目录」分组。
3. 点目录头可折叠/展开；折叠后其下 session 隐藏。
4. 拖拽两个目录头可改变目录顺序；在同一目录内拖拽两个 session 可改变其顺序（跨目录拖拽无效果，符合预期）。
5. 「定时任务」系统会话在两种模式都固定置顶。
6. 切到「按目录」、折叠某目录、调整目录顺序后**重启应用**：过滤器停在「按目录」、折叠状态与目录顺序都保留。

- [ ] **Step 6: Commit**

```bash
git add src/renderer/src/components/session-list.tsx
git commit -m "feat(renderer): directory-grouping filter for session list"
```

---

## Self-Review

**Spec coverage:**
- 过滤器 + 分段控件 → Task 3 分段控件。
- 目录一级 / session 二级 + 可折叠 → Task 3 `SortableDirectoryGroup` + `collapsed`。
- 无目录置底 → Task 2 `UNGROUPED` 末尾 + `groupSessionsByDirectory` 测试。
- 目录间拖拽 → Task 3 `onDirDragEnd` + `setDirectoryOrder`。
- 组内 session 拖拽 → Task 3 `onSessionDragEnd` + `flattenForReorder` + `reorderSessions`。
- 持久化过滤器选择/目录顺序/折叠 → Task 1 persist store；重启恢复在 Task 3 Step 5#6 验证。
- 默认模式零变更 → Task 3 flat 分支为原逻辑搬运。

**Placeholder scan:** 无 TBD/TODO；所有步骤含完整代码与命令。

**Type consistency:** `useSessionView`/`SessionViewMode`（Task 1）、`groupSessionsByDirectory`/`flattenForReorder`/`UNGROUPED`/`DirectoryGroup`（Task 2）在 Task 3 import 处名称一致；`DirectoryGroup.sessions` 元素为 `SessionSummary`，`flattenForReorder` 取 `s.id` 与 `reorderSessions(orderedIds: string[])` 签名一致。
