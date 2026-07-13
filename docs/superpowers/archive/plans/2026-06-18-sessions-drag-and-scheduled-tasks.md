# Session Drag-Reorder & Scheduled-Tasks Views Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add drag-to-reorder for the session list, a right-panel scheduled-tasks tab for the current session, and a left-sidebar month-calendar of all scheduled tasks across sessions.

**Architecture:** Two independent lines. **Line A** adds a persisted `sort_order` to sessions and wires `@dnd-kit` into the existing `SessionList`. **Line B** exposes the existing cron backend to the renderer through three new IPC methods, then renders it in two places — a right-panel tab (current session, cancellable) and a `/scheduled` route showing a month grid (all sessions). Cron occurrence expansion happens client-side with the `cron` package so month navigation needs no extra IPC.

**Tech Stack:** Electron + React + TanStack Router + Zustand + React Query + better-sqlite3, `@dnd-kit/*` (installed), `cron` v4 + `date-fns` v4 (installed), `pino` logging.

## Global Constraints

- Reply to the user in Chinese; **code comments and commit messages in English** (CLAUDE.md §0).
- Log every business path: service-method entry/outcome at `info`, every `catch` at `error`, branch surprises at `warn` (CLAUDE.md §5). Use `createLogger({ process }).child({ component })`.
- Tests run via `npm test` (Electron's node ABI) — never bare `npx vitest`, never `pnpm rebuild better-sqlite3`.
- Scoped Biome formatting only: `npx biome check --write <file>` (never `pnpm check`).
- Surgical changes; match existing style; new IPC methods follow the exact `setSessionPinned` chain.

---

## Line A — Session drag-to-reorder

### Task 1: `sort_order` column, ordering, and `reorderSessions` in conversation-store

**Files:**
- Modify: `src/service/conversation-store.ts`
- Test: `src/service/conversation-store.test.ts`

**Interfaces:**
- Produces: `ConversationStore.reorderSessions(orderedIds: string[]): void`; `listSessions()` rows now include `sortOrder: number`; `StoredSession` unchanged (sort_order is list-only).

- [ ] **Step 1: Write failing tests**

Add to `src/service/conversation-store.test.ts`:

```ts
test('new sessions get descending sort_order so newest is first', () => {
  const store = createConversationStore(':memory:')
  store.createSession('ses-a', injection)
  store.createSession('ses-b', injection)
  const ids = store.listSessions().map((s) => s.id)
  expect(ids).toEqual(['ses-b', 'ses-a']) // newest first by sort_order
  store.close()
})

test('reorderSessions persists an explicit order', () => {
  const store = createConversationStore(':memory:')
  store.createSession('ses-a', injection)
  store.createSession('ses-b', injection)
  store.createSession('ses-c', injection)
  store.reorderSessions(['ses-a', 'ses-c', 'ses-b'])
  expect(store.listSessions().map((s) => s.id)).toEqual(['ses-a', 'ses-c', 'ses-b'])
  store.close()
})

test('pinned sessions float above unpinned regardless of sort_order', () => {
  const store = createConversationStore(':memory:')
  store.createSession('ses-a', injection)
  store.createSession('ses-b', injection)
  store.reorderSessions(['ses-a', 'ses-b'])
  store.setSessionPinned('ses-b', true)
  expect(store.listSessions().map((s) => s.id)).toEqual(['ses-b', 'ses-a'])
  store.close()
})
```

`injection` already exists in this test file (used by other tests). If not in scope of these tests, reuse the same provider object the file's existing `createSession` calls pass.

- [ ] **Step 2: Run tests, verify they fail**

Run: `npm test -- src/service/conversation-store.test.ts`
Expected: FAIL (`reorderSessions is not a function`, ordering mismatch).

- [ ] **Step 3: Add the column + migration**

In the `db.exec(\`CREATE TABLE IF NOT EXISTS sessions ...\`)` block, add to the sessions table definition (after `pinned`):

```sql
      pinned            INTEGER NOT NULL DEFAULT 0,
      sort_order        INTEGER NOT NULL DEFAULT 0
```

Add to the migration `for` loop array:

```ts
    'ALTER TABLE sessions ADD COLUMN sort_order INTEGER NOT NULL DEFAULT 0',
```

After that `for` loop, backfill existing rows so order matches current recency once:

```ts
  // One-time backfill: give pre-existing rows a sort_order matching the old
  // recency order (newest = smallest). Rows already migrated keep their value.
  try {
    const needsBackfill = db.prepare('SELECT COUNT(*) AS n FROM sessions WHERE sort_order = 0').get() as { n: number }
    if (needsBackfill.n > 1) {
      const rows = db.prepare('SELECT id FROM sessions ORDER BY last_active_at DESC').all() as { id: string }[]
      const tx = db.transaction(() => {
        rows.forEach((r, i) => db.prepare('UPDATE sessions SET sort_order = ? WHERE id = ?').run(i, r.id))
      })
      tx()
    }
  } catch (err) {
    log.error({ msg: 'sort_order backfill failed', err: err instanceof Error ? err.message : String(err) })
  }
```

- [ ] **Step 4: Update insert, ordering, listSessions, and add reorderSessions**

Change `stmtInsertSession` to set `sort_order` to one below the current minimum (newest at top):

```ts
  const stmtInsertSession = db.prepare(
    `INSERT INTO sessions (id, created_at, last_active_at, status, provider_snapshot, title, agent_snapshot, sort_order)
     VALUES (?, ?, ?, 'active', ?, NULL, '[]',
       COALESCE((SELECT MIN(sort_order) FROM sessions), 0) - 1)`
  )
```

Change `stmtListSessions` SELECT + ORDER BY to include `sort_order` and order by it:

```ts
  const stmtListSessions = db.prepare(
    `SELECT s.id, s.title, s.status, s.pinned, s.sort_order AS sortOrder, s.last_active_at AS lastActiveAt,
            (SELECT COUNT(*) FROM tasks t WHERE t.session_id = s.id) AS taskCount
     FROM sessions s
     WHERE s.status != 'ended'
     ORDER BY s.pinned DESC, s.sort_order ASC`
  )
```

Add a reorder statement near the other `stmt*` declarations:

```ts
  const stmtSetSortOrder = db.prepare('UPDATE sessions SET sort_order = ? WHERE id = ?')
```

In `listSessions()` map, add `sortOrder`:

```ts
    listSessions() {
      return (stmtListSessions.all() as Record<string, unknown>[]).map((r) => ({
        id: r.id as string,
        title: (r.title as string | null) ?? null,
        status: r.status as 'active' | 'interrupted' | 'ended',
        lastActiveAt: r.lastActiveAt as number,
        taskCount: r.taskCount as number,
        pinned: Boolean(r.pinned),
        sortOrder: r.sortOrder as number,
      }))
    },
```

Add the method to the returned object (next to `setSessionPinned`):

```ts
    reorderSessions(orderedIds) {
      const tx = db.transaction((ids: string[]) => {
        ids.forEach((id, i) => stmtSetSortOrder.run(i, id))
      })
      tx(orderedIds)
    },
```

Add to the `ConversationStore` type (next to `setSessionPinned`):

```ts
  reorderSessions(orderedIds: string[]): void
```

- [ ] **Step 5: Run tests, verify pass**

Run: `npm test -- src/service/conversation-store.test.ts`
Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add src/service/conversation-store.ts src/service/conversation-store.test.ts
git commit -m "feat(store): persist session sort_order and add reorderSessions"
```

---

### Task 2: `reorderSessions` IPC chain + `SessionSummary.sortOrder`

**Files:**
- Modify: `src/shared/types/ui.ts`, `src/shared/types/service-ipc.ts`, `src/service/dispatcher.ts`, `src/service/session-manager.ts`, `src/main/service-client.ts`, `src/main/ipc/swarm-ipc.ts`, `src/preload/index.ts`, `src/renderer/src/lib/api.ts`

**Interfaces:**
- Consumes: `store.reorderSessions` (Task 1).
- Produces: `swarmApi.reorderSessions(orderedIds: string[]): Promise<void>`; `SessionSummary` gains `sortOrder: number`.

- [ ] **Step 1: Add `sortOrder` to `SessionSummary` and `reorderSessions` to `SwarmBridge`**

In `src/shared/types/ui.ts`, the `SessionSummary` type:

```ts
export type SessionSummary = {
  id: string
  title: string | null
  status: 'active' | 'interrupted' | 'ended'
  lastActiveAt: number
  taskCount: number
  pinned: boolean
  sortOrder: number
}
```

In the same file, `SwarmBridge.sessions`:

```ts
  sessions: {
    list(): Promise<SessionSummary[]>
    create(): Promise<{ sessionId: string }>
    getTasks(sessionId: string): Promise<import('./task').Task[]>
    delete(sessionId: string): Promise<void>
    rename(sessionId: string, title: string): Promise<void>
    setPinned(sessionId: string, pinned: boolean): Promise<void>
    reorder(orderedIds: string[]): Promise<void>
  }
```

- [ ] **Step 2: Add the service-ipc method + dispatcher case + session-manager method**

`src/shared/types/service-ipc.ts` — add to the `ServiceMethod` union after `setSessionPinned`:

```ts
  | 'reorderSessions'
```

`src/service/session-manager.ts` — add to the `SessionManager` type (near `setSessionPinned(...)`):

```ts
  reorderSessions(orderedIds: string[]): void
```

and to the returned object (next to `setSessionPinned`):

```ts
    reorderSessions(orderedIds) {
      store.reorderSessions(orderedIds)
    },
```

`src/service/dispatcher.ts` — add a case after `setSessionPinned`:

```ts
      case 'reorderSessions': {
        const [orderedIds] = args as [string[]]
        manager.reorderSessions(orderedIds)
        return { ok: true }
      }
```

- [ ] **Step 3: Add service-client + main IPC handler + preload + renderer api**

`src/main/service-client.ts` — add to the `ServiceClient` type (near `setSessionPinned`):

```ts
  reorderSessions(orderedIds: string[]): Promise<void>
```

and to the returned object:

```ts
    async reorderSessions(orderedIds) {
      await call('reorderSessions', [orderedIds])
    },
```

`src/main/ipc/swarm-ipc.ts` — add a handler fn near `setSessionPinned`:

```ts
  const reorderSessions = (_e: Electron.IpcMainInvokeEvent, orderedIds: string[]) =>
    serviceClient.reorderSessions(orderedIds)
```

register it (next to `swarm:setSessionPinned`):

```ts
  ipcMain.handle('swarm:reorderSessions', reorderSessions)
```

and remove it in the cleanup block (next to `swarm:setSessionPinned`):

```ts
      ipcMain.removeHandler('swarm:reorderSessions')
```

`src/preload/index.ts` — in the `sessions` object, after `setPinned`:

```ts
    reorder: (orderedIds: string[]) =>
      ipcRenderer.invoke('swarm:reorderSessions', orderedIds) as Promise<void>,
```

`src/renderer/src/lib/api.ts` — add to `swarmApi`:

```ts
  reorderSessions: (orderedIds: string[]): Promise<void> => window.swarm.sessions.reorder(orderedIds),
```

- [ ] **Step 4: Typecheck**

Run: `npm run typecheck`
Expected: PASS (no type errors; every consumer of `SessionSummary` now supplies `sortOrder` — the store comes from the service, tests may need it; if a test constructs a literal `SessionSummary`, add `sortOrder: 0`).

- [ ] **Step 5: Commit**

```bash
git add src/shared/types/ui.ts src/shared/types/service-ipc.ts src/service/dispatcher.ts src/service/session-manager.ts src/main/service-client.ts src/main/ipc/swarm-ipc.ts src/preload/index.ts src/renderer/src/lib/api.ts
git commit -m "feat(ipc): add reorderSessions and SessionSummary.sortOrder"
```

---

### Task 3: sessions store ordering + reorder action

**Files:**
- Modify: `src/renderer/src/stores/sessions.ts`
- Test: `src/renderer/src/stores/sessions.test.ts`

**Interfaces:**
- Consumes: `SessionSummary.sortOrder`.
- Produces: `useSessionsStore` action `reorder(orderedIds: string[]): void` (optimistic local reorder).

- [ ] **Step 1: Write failing tests**

Add to `src/renderer/src/stores/sessions.test.ts`:

```ts
test('setSessions orders by pinned then sortOrder', () => {
  const s = (id: string, sortOrder: number, pinned = false): SessionSummary => ({
    id, title: id, status: 'active', lastActiveAt: 0, taskCount: 0, pinned, sortOrder,
  })
  useSessionsStore.getState().setSessions([s('a', 2), s('b', 0), s('c', 1, true)])
  expect(useSessionsStore.getState().sessions.map((x) => x.id)).toEqual(['c', 'b', 'a'])
})

test('reorder reassigns sortOrder by index', () => {
  const s = (id: string, sortOrder: number): SessionSummary => ({
    id, title: id, status: 'active', lastActiveAt: 0, taskCount: 0, pinned: false, sortOrder,
  })
  useSessionsStore.getState().setSessions([s('a', 0), s('b', 1), s('c', 2)])
  useSessionsStore.getState().reorder(['c', 'a', 'b'])
  expect(useSessionsStore.getState().sessions.map((x) => x.id)).toEqual(['c', 'a', 'b'])
})
```

Ensure `SessionSummary` is imported at the top of the test file (it already imports from `@shared/types/ui` for other tests; add the type if missing).

- [ ] **Step 2: Run tests, verify fail**

Run: `npm test -- src/renderer/src/stores/sessions.test.ts`
Expected: FAIL.

- [ ] **Step 3: Update comparator + add reorder action**

Replace `byPinnedThenRecent` with a sort-order comparator:

```ts
// Pinned sessions float to the top; within each group, manual sort_order ascending.
const byPinnedThenSortOrder = (a: SessionSummary, b: SessionSummary): number =>
  Number(b.pinned) - Number(a.pinned) || a.sortOrder - b.sortOrder
```

Update both `.sort(byPinnedThenRecent)` call sites in `setSessions` and `upsert` to `.sort(byPinnedThenSortOrder)`.

Add `reorder` to the store type:

```ts
  reorder: (orderedIds: string[]) => void
```

Add the implementation in the store body:

```ts
  reorder: (orderedIds) =>
    set((state) => {
      const pos = new Map(orderedIds.map((id, i) => [id, i]))
      const sessions = state.sessions
        .map((s) => (pos.has(s.id) ? { ...s, sortOrder: pos.get(s.id) as number } : s))
        .sort(byPinnedThenSortOrder)
      return { sessions }
    }),
```

- [ ] **Step 4: Run tests, verify pass**

Run: `npm test -- src/renderer/src/stores/sessions.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/renderer/src/stores/sessions.ts src/renderer/src/stores/sessions.test.ts
git commit -m "feat(store): order sessions by sortOrder and add reorder action"
```

---

### Task 4: drag-to-reorder UI in SessionList

**Files:**
- Modify: `src/renderer/src/components/session-list.tsx`

**Interfaces:**
- Consumes: `useSessionsStore().reorder`, `swarmApi.reorderSessions`.

- [ ] **Step 1: Add dnd-kit imports**

At the top of `session-list.tsx`:

```ts
import {
  DndContext,
  type DragEndEvent,
  PointerSensor,
  closestCenter,
  useSensor,
  useSensors,
} from '@dnd-kit/core'
import { restrictToVerticalAxis } from '@dnd-kit/modifiers'
import { SortableContext, useSortable, verticalListSortingStrategy } from '@dnd-kit/sortable'
import { CSS } from '@dnd-kit/utilities'
```

- [ ] **Step 2: Extract the row into a sortable component**

Inside `session-list.tsx`, factor the per-session `<ContextMenu>…</ContextMenu>` block (lines rendering one session) into a local component `SortableSessionRow` that wraps it. The component calls `useSortable({ id: s.id })` and applies the drag transform to an outer wrapper. Render the existing button/menu unchanged inside. Use a small drag handle: spread `attributes`/`listeners` onto the wrapper but disable dragging while renaming.

```tsx
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
```

- [ ] **Step 3: Wrap the list in DndContext + SortableContext**

In `SessionList`, add sensors + a drag-end handler before the return:

```tsx
  const reorder = useSessionsStore((s) => s.reorder)
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
```

Wrap the mapped rows (inside the existing `<ScrollArea>`'s `<div className="flex flex-col gap-1">`) so each `<ContextMenu key={s.id}>…</ContextMenu>` is wrapped by `<SortableSessionRow id={s.id}>`, and the whole `flex-col` div is wrapped by:

```tsx
<DndContext sensors={sensors} collisionDetection={closestCenter} modifiers={[restrictToVerticalAxis]} onDragEnd={onDragEnd}>
  <SortableContext items={visibleSessions.map((s) => s.id)} strategy={verticalListSortingStrategy}>
    {/* existing flex-col list of SortableSessionRow-wrapped rows */}
  </SortableContext>
</DndContext>
```

Disable drag while searching (manual order while filtering is ambiguous): when `query.trim()` is non-empty, render the plain list without `DndContext` (reorder during a filtered view is out of scope). The `onClick={() => onSelect(s.id)}` still works because `PointerSensor` has a 6px activation distance.

- [ ] **Step 4: Typecheck + format + manual verify**

Run: `npm run typecheck`
Expected: PASS.
Run: `npx biome check --write src/renderer/src/components/session-list.tsx`
Then verify in the app (see run-desktop skill): dragging a session reorders it and the order survives reload.

- [ ] **Step 5: Commit**

```bash
git add src/renderer/src/components/session-list.tsx
git commit -m "feat(sessions): drag-to-reorder the session list"
```

---

## Line B — Scheduled tasks (shared backend + two UIs)

### Task 5: `listAll()` on the cron scheduler

**Files:**
- Modify: `src/service/cron-scheduler.ts`
- Test: `src/service/cron-scheduler.test.ts`

**Interfaces:**
- Produces: `CronScheduler.listAll(): Array<StoredCronJob & { nextRun: number | null }>`.

- [ ] **Step 1: Write failing test**

Add to `src/service/cron-scheduler.test.ts` (reuse the existing fake `store`/`jobs` setup in that file):

```ts
test('listAll returns every job with a nextRun', () => {
  // arrange: add two jobs in different sessions via scheduler.add (existing helper)
  scheduler.add({ sessionId: 'ses-1', cron: '0 9 * * *', goal: 'a' })
  scheduler.add({ sessionId: 'ses-2', cron: '0 10 * * *', goal: 'b' })
  const all = scheduler.listAll()
  expect(all).toHaveLength(2)
  expect(all.every((j) => typeof j.nextRun === 'number')).toBe(true)
})
```

Match the test file's existing construction of `scheduler` (it builds one with a fake store + fire). If the fake store lacks `listCronJobs`, add it to the fake (`listCronJobs: () => [...jobs.values()]`).

- [ ] **Step 2: Run test, verify fail**

Run: `npm test -- src/service/cron-scheduler.test.ts`
Expected: FAIL (`listAll is not a function`).

- [ ] **Step 3: Implement listAll**

In `cron-scheduler.ts`, add to the `CronScheduler` type:

```ts
  listAll(): Array<StoredCronJob & { nextRun: number | null }>
```

and to the returned object (next to `listForSession`):

```ts
    listAll() {
      return store.listCronJobs().map((j) => ({
        ...j,
        nextRun: live.get(j.id)?.nextDate().toMillis() ?? null,
      }))
    },
```

- [ ] **Step 4: Run test, verify pass**

Run: `npm test -- src/service/cron-scheduler.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/service/cron-scheduler.ts src/service/cron-scheduler.test.ts
git commit -m "feat(cron): add listAll to the scheduler"
```

---

### Task 6: cron IPC chain (`listCronJobsForSession`, `listAllCronJobs`, `cancelCronJob`)

**Files:**
- Modify: `src/shared/types/ui.ts`, `src/shared/types/service-ipc.ts`, `src/service/dispatcher.ts`, `src/service/index.ts`, `src/main/service-client.ts`, `src/main/ipc/swarm-ipc.ts`, `src/preload/index.ts`, `src/renderer/src/lib/api.ts`

**Interfaces:**
- Consumes: `scheduler.listForSession`, `scheduler.listAll`, `scheduler.remove`, `store.listSessions` (Task 5).
- Produces shared types and `swarmApi`:
  - `CronJobSummary = { id, sessionId, name: string|null, cron, goal, createdAt, lastRunAt: number|null, nextRun: number|null }`
  - `ScheduledTask = CronJobSummary & { sessionTitle: string | null }`
  - `swarmApi.listCronJobsForSession(sessionId): Promise<CronJobSummary[]>`
  - `swarmApi.listAllCronJobs(): Promise<ScheduledTask[]>`
  - `swarmApi.cancelCronJob(id): Promise<void>`

- [ ] **Step 1: Add shared types + bridge surface**

`src/shared/types/ui.ts` — add near `SessionSummary`:

```ts
export type CronJobSummary = {
  id: string
  sessionId: string
  name: string | null
  cron: string
  goal: string
  createdAt: number
  lastRunAt: number | null
  nextRun: number | null
}

export type ScheduledTask = CronJobSummary & { sessionTitle: string | null }
```

Add a `cron` namespace to `SwarmBridge`:

```ts
  cron: {
    listForSession(sessionId: string): Promise<CronJobSummary[]>
    listAll(): Promise<ScheduledTask[]>
    cancel(id: string): Promise<void>
  }
```

- [ ] **Step 2: service-ipc union + dispatcher cases + index.ts wiring**

`src/shared/types/service-ipc.ts` — add to `ServiceMethod`:

```ts
  | 'listCronJobsForSession'
  | 'listAllCronJobs'
  | 'cancelCronJob'
```

`src/service/dispatcher.ts` — add to `DispatcherConfig`:

```ts
  listCronJobsForSession(sessionId: string): import('@shared/types/ui').CronJobSummary[]
  listAllCronJobs(): import('@shared/types/ui').ScheduledTask[]
  cancelCronJob(id: string): void
```

destructure them in `createDispatcher` and add cases:

```ts
      case 'listCronJobsForSession': {
        const [sessionId] = args as [string]
        return cfg.listCronJobsForSession(sessionId)
      }
      case 'listAllCronJobs':
        return cfg.listAllCronJobs()
      case 'cancelCronJob': {
        const [id] = args as [string]
        cfg.cancelCronJob(id)
        return { ok: true }
      }
```

`src/service/index.ts` — in the `createDispatcher({ ... })` config, add (scheduler + store are already in scope):

```ts
  listCronJobsForSession: (sessionId) => scheduler.listForSession(sessionId),
  listAllCronJobs: () => {
    const titleById = new Map(store.listSessions().map((s) => [s.id, s.title]))
    return scheduler.listAll().map((j) => ({ ...j, sessionTitle: titleById.get(j.sessionId) ?? null }))
  },
  cancelCronJob: (id) => {
    scheduler.remove(id)
  },
```

- [ ] **Step 3: service-client + main handlers + preload + renderer api**

`src/main/service-client.ts` — add to `ServiceClient` type + impl:

```ts
  // type:
  listCronJobsForSession(sessionId: string): Promise<import('@shared/types/ui').CronJobSummary[]>
  listAllCronJobs(): Promise<import('@shared/types/ui').ScheduledTask[]>
  cancelCronJob(id: string): Promise<void>
```

```ts
  // impl:
    listCronJobsForSession(sessionId) {
      return call('listCronJobsForSession', [sessionId])
    },
    listAllCronJobs() {
      return call('listAllCronJobs', [])
    },
    async cancelCronJob(id) {
      await call('cancelCronJob', [id])
    },
```

`src/main/ipc/swarm-ipc.ts` — add handler fns:

```ts
  const listCronJobsForSession = (_e: Electron.IpcMainInvokeEvent, sessionId: string) =>
    serviceClient.listCronJobsForSession(sessionId)
  const listAllCronJobs = () => serviceClient.listAllCronJobs()
  const cancelCronJob = (_e: Electron.IpcMainInvokeEvent, id: string) => serviceClient.cancelCronJob(id)
```

register:

```ts
  ipcMain.handle('swarm:listCronJobsForSession', listCronJobsForSession)
  ipcMain.handle('swarm:listAllCronJobs', () => listAllCronJobs())
  ipcMain.handle('swarm:cancelCronJob', cancelCronJob)
```

cleanup:

```ts
      ipcMain.removeHandler('swarm:listCronJobsForSession')
      ipcMain.removeHandler('swarm:listAllCronJobs')
      ipcMain.removeHandler('swarm:cancelCronJob')
```

`src/preload/index.ts` — add a `cron` object to the bridge (next to `sessions`):

```ts
  cron: {
    listForSession: (sessionId: string) =>
      ipcRenderer.invoke('swarm:listCronJobsForSession', sessionId) as Promise<
        import('../shared/types/ui').CronJobSummary[]
      >,
    listAll: () =>
      ipcRenderer.invoke('swarm:listAllCronJobs') as Promise<import('../shared/types/ui').ScheduledTask[]>,
    cancel: (id: string) => ipcRenderer.invoke('swarm:cancelCronJob', id) as Promise<void>,
  },
```

`src/renderer/src/lib/api.ts` — add to `swarmApi` and import the types:

```ts
import type { CronJobSummary, PermissionDecision, ScheduledTask, SessionSummary, SubmitGoalResult, UIEvent } from '@shared/types/ui'
```

```ts
  listCronJobsForSession: (sessionId: string): Promise<CronJobSummary[]> =>
    window.swarm.cron.listForSession(sessionId),
  listAllCronJobs: (): Promise<ScheduledTask[]> => window.swarm.cron.listAll(),
  cancelCronJob: (id: string): Promise<void> => window.swarm.cron.cancel(id),
```

- [ ] **Step 4: Typecheck**

Run: `npm run typecheck`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/shared/types/ui.ts src/shared/types/service-ipc.ts src/service/dispatcher.ts src/service/index.ts src/main/service-client.ts src/main/ipc/swarm-ipc.ts src/preload/index.ts src/renderer/src/lib/api.ts
git commit -m "feat(ipc): expose cron jobs to the renderer (list/listAll/cancel)"
```

---

### Task 7: cron occurrence-expansion helper

**Files:**
- Create: `src/renderer/src/lib/cron-occurrences.ts`
- Test: `src/renderer/src/lib/cron-occurrences.test.ts`

**Interfaces:**
- Produces: `occurrencesInRange(cronExpr: string, from: Date, to: Date): Date[]` — every run time in `[from, to]` (inclusive), `[]` for an invalid expression.

- [ ] **Step 1: Write failing tests**

Create `src/renderer/src/lib/cron-occurrences.test.ts`:

```ts
import { describe, expect, test } from 'vitest'
import { occurrencesInRange } from './cron-occurrences'

describe('occurrencesInRange', () => {
  test('daily 9am expands to one run per day', () => {
    const from = new Date('2026-06-01T00:00:00')
    const to = new Date('2026-06-07T23:59:59')
    const runs = occurrencesInRange('0 9 * * *', from, to)
    expect(runs).toHaveLength(7)
    expect(runs[0].getHours()).toBe(9)
  })

  test('invalid expression returns empty array', () => {
    expect(occurrencesInRange('not a cron', new Date(), new Date())).toEqual([])
  })

  test('empty range returns empty array', () => {
    const d = new Date('2026-06-01T00:00:00')
    expect(occurrencesInRange('0 9 * * *', new Date('2026-06-01T10:00:00'), d)).toEqual([])
  })
})
```

- [ ] **Step 2: Run tests, verify fail**

Run: `npm test -- src/renderer/src/lib/cron-occurrences.test.ts`
Expected: FAIL (module not found).

- [ ] **Step 3: Implement**

Create `src/renderer/src/lib/cron-occurrences.ts`:

```ts
import { CronTime } from 'cron'

// Expand a cron expression into every run time within [from, to] (inclusive).
// Pure + client-side so the calendar can re-expand on month navigation with no
// IPC. Returns [] for an invalid expression (callers render nothing for it).
const MAX_OCCURRENCES = 5000 // safety cap: ~one run/minute for ~3.5 days

export function occurrencesInRange(cronExpr: string, from: Date, to: Date): Date[] {
  if (!CronTime.validateCronExpression(cronExpr).valid) return []
  const out: Date[] = []
  try {
    const ct = new CronTime(cronExpr)
    let cursor = new Date(from.getTime() - 1000) // so a run exactly at `from` is included
    for (let i = 0; i < MAX_OCCURRENCES; i++) {
      const next = ct.getNextDateFrom(cursor).toJSDate()
      if (next > to) break
      out.push(next)
      cursor = new Date(next.getTime() + 1000)
    }
  } catch {
    return []
  }
  return out
}
```

- [ ] **Step 4: Run tests, verify pass**

Run: `npm test -- src/renderer/src/lib/cron-occurrences.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/renderer/src/lib/cron-occurrences.ts src/renderer/src/lib/cron-occurrences.test.ts
git commit -m "feat(cron): client-side cron occurrence expansion helper"
```

---

### Task 8: `use-cron` React Query hooks

**Files:**
- Create: `src/renderer/src/hooks/use-cron.ts`

**Interfaces:**
- Consumes: `swarmApi.listCronJobsForSession`, `swarmApi.listAllCronJobs`, `swarmApi.cancelCronJob`.
- Produces:
  - `useSessionCronJobs(sessionId: string | null, enabled: boolean)` → React Query result of `CronJobSummary[]`.
  - `useAllCronJobs()` → React Query result of `ScheduledTask[]`.
  - `useCancelCronJob()` → mutation invalidating both query keys.

- [ ] **Step 1: Implement the hooks**

Create `src/renderer/src/hooks/use-cron.ts`:

```ts
import type { CronJobSummary, ScheduledTask } from '@shared/types/ui'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'

import { swarmApi } from '@/lib/api'

export const CRON_SESSION_KEY = (sessionId: string): unknown[] => ['cron', 'session', sessionId]
export const CRON_ALL_KEY: unknown[] = ['cron', 'all']

// Refetch while the panel is visible so jobs the agent creates/fires via tools
// surface without a dedicated event channel.
const REFETCH_MS = 20_000

export function useSessionCronJobs(sessionId: string | null, enabled: boolean) {
  return useQuery<CronJobSummary[]>({
    queryKey: CRON_SESSION_KEY(sessionId ?? ''),
    queryFn: () => swarmApi.listCronJobsForSession(sessionId as string),
    enabled: enabled && !!sessionId,
    refetchInterval: enabled ? REFETCH_MS : false,
  })
}

export function useAllCronJobs() {
  return useQuery<ScheduledTask[]>({
    queryKey: CRON_ALL_KEY,
    queryFn: () => swarmApi.listAllCronJobs(),
    refetchInterval: REFETCH_MS,
  })
}

export function useCancelCronJob() {
  const qc = useQueryClient()
  return useMutation({
    mutationFn: (id: string) => swarmApi.cancelCronJob(id),
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: ['cron'] })
    },
  })
}
```

- [ ] **Step 2: Typecheck**

Run: `npm run typecheck`
Expected: PASS.

- [ ] **Step 3: Commit**

```bash
git add src/renderer/src/hooks/use-cron.ts
git commit -m "feat(cron): React Query hooks for scheduled tasks"
```

---

### Task 9: right-panel "Scheduled" tab + CronPanel

**Files:**
- Create: `src/renderer/src/components/cron-panel.tsx`
- Modify: `src/renderer/src/components/right-panel.tsx`

**Interfaces:**
- Consumes: `useSessionCronJobs`, `useCancelCronJob`, `CronJobSummary`.

- [ ] **Step 1: Build CronPanel**

Create `src/renderer/src/components/cron-panel.tsx`:

```tsx
import type { CronJobSummary } from '@shared/types/ui'
import { formatDistanceToNow } from 'date-fns'
import { Trash2 } from 'lucide-react'

import { Button } from '@/components/ui/button'
import { ScrollArea } from '@/components/ui/scroll-area'
import { useCancelCronJob } from '@/hooks/use-cron'

type Props = { jobs: CronJobSummary[]; isLoading: boolean }

export function CronPanel({ jobs, isLoading }: Props): React.JSX.Element {
  const cancel = useCancelCronJob()
  if (!isLoading && jobs.length === 0) {
    return <p className="px-4 py-6 text-muted-foreground text-sm">No scheduled tasks in this chat.</p>
  }
  return (
    <ScrollArea className="min-h-0 flex-1">
      <div className="flex flex-col gap-2 p-3">
        {jobs.map((j) => (
          <div className="rounded-lg border bg-background/50 p-3 text-sm" key={j.id}>
            <div className="flex items-start justify-between gap-2">
              <span className="font-medium">{j.name ?? '(unnamed task)'}</span>
              <Button
                aria-label="Cancel task"
                className="size-7 shrink-0 text-muted-foreground hover:text-destructive"
                onClick={() => cancel.mutate(j.id)}
                size="icon"
                variant="ghost"
              >
                <Trash2 className="size-4" />
              </Button>
            </div>
            <p className="mt-1 font-mono text-muted-foreground text-xs">{j.cron}</p>
            <p className="mt-1 text-muted-foreground text-xs">
              Next: {j.nextRun ? formatDistanceToNow(j.nextRun, { addSuffix: true }) : 'n/a'}
            </p>
            <p className="mt-2 line-clamp-2 text-foreground/80 text-xs">{j.goal}</p>
          </div>
        ))}
      </div>
    </ScrollArea>
  )
}
```

- [ ] **Step 2: Add the third tab to RightPanel**

In `right-panel.tsx`:
- Import: `import { CalendarClock } from 'lucide-react'`, `import { CronPanel } from '@/components/cron-panel'`, `import { useSessionCronJobs } from '@/hooks/use-cron'`, `import { useSessionsStore } from '@/stores/sessions'`.
- Change tab state type to `'plan' | 'memory' | 'scheduled'` (both `useState` and the `onValueChange` cast).
- Read the current session + jobs:

```tsx
  const sessionId = useSessionsStore((s) => s.selectedSessionId)
  const { data: cronJobs = [], isLoading: cronLoading } = useSessionCronJobs(sessionId, !collapsed && tab === 'scheduled')
```

- In the collapsed rail, add a third button after the memory button:

```tsx
        <button
          aria-label="Open scheduled tasks"
          className="flex flex-col items-center gap-1"
          onClick={() => {
            setTab('scheduled')
            setCollapsed(false)
          }}
          type="button"
        >
          <CalendarClock className="size-5 text-primary/60" />
        </button>
```

- In the expanded `TabsList`, add `<TabsTrigger value="scheduled">Scheduled</TabsTrigger>`.
- Add the tab content after the memory `TabsContent`:

```tsx
        <TabsContent className="flex min-h-0 flex-1 flex-col" value="scheduled">
          <CronPanel isLoading={cronLoading} jobs={cronJobs} />
        </TabsContent>
```

- [ ] **Step 3: Typecheck + format + manual verify**

Run: `npm run typecheck`
Run: `npx biome check --write src/renderer/src/components/cron-panel.tsx src/renderer/src/components/right-panel.tsx`
Manually: open a session with a scheduled task (ask the agent to schedule one), open the Scheduled tab, confirm it lists and cancels.

- [ ] **Step 4: Commit**

```bash
git add src/renderer/src/components/cron-panel.tsx src/renderer/src/components/right-panel.tsx
git commit -m "feat(cron): right-panel scheduled-tasks tab for the current session"
```

---

### Task 10: `/scheduled` calendar route + sidebar entry

**Files:**
- Create: `src/renderer/src/routes/scheduled.tsx`
- Create: `src/renderer/src/components/views/scheduled-calendar-view.tsx`
- Modify: `src/renderer/src/components/app-sidebar.tsx`

**Interfaces:**
- Consumes: `useAllCronJobs`, `useCancelCronJob`, `occurrencesInRange`, `ScheduledTask`.

- [ ] **Step 1: Add the route**

Create `src/renderer/src/routes/scheduled.tsx`:

```tsx
import { createFileRoute } from '@tanstack/react-router'

import { ScheduledCalendarView } from '@/components/views/scheduled-calendar-view'

export const Route = createFileRoute('/scheduled')({ component: ScheduledCalendarView })
```

- [ ] **Step 2: Build the month-grid view**

Create `src/renderer/src/components/views/scheduled-calendar-view.tsx`. Use `date-fns` for the grid and `occurrencesInRange` to expand each job within the visible month. Monday-first grid; each day cell shows up to 3 run dots with time+name, overflow as "+N"; clicking a day opens an agenda panel listing that day's runs with session title, goal, a "jump to session" link, and a cancel button.

```tsx
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
import { CalendarClock, ChevronLeft, ChevronRight, Trash2 } from 'lucide-react'
import { useMemo, useState } from 'react'

import { Button } from '@/components/ui/button'
import { ScrollArea } from '@/components/ui/scroll-area'
import { useAllCronJobs, useCancelCronJob } from '@/hooks/use-cron'
import { occurrencesInRange } from '@/lib/cron-occurrences'
import { cn } from '@/lib/utils'

type Run = { at: Date; task: ScheduledTask }

const WEEK_OPTS = { weekStartsOn: 1 } as const // Monday-first

export function ScheduledCalendarView(): React.JSX.Element {
  const navigate = useNavigate()
  const { data: tasks = [] } = useAllCronJobs()
  const cancel = useCancelCronJob()
  const [month, setMonth] = useState(() => startOfMonth(new Date()))
  const [selected, setSelected] = useState<Date | null>(null)

  const gridStart = startOfWeek(startOfMonth(month), WEEK_OPTS)
  const gridEnd = endOfWeek(endOfMonth(month), WEEK_OPTS)
  const days = useMemo(() => eachDayOfInterval({ start: gridStart, end: gridEnd }), [gridStart, gridEnd])

  // Expand all jobs across the visible grid once, bucketed per ISO day.
  const runsByDay = useMemo(() => {
    const map = new Map<string, Run[]>()
    for (const task of tasks) {
      for (const at of occurrencesInRange(task.cron, gridStart, gridEnd)) {
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

  return (
    <div className="flex h-full">
      <div className="flex min-w-0 flex-1 flex-col p-4">
        <header className="mb-3 flex items-center gap-2">
          <CalendarClock className="size-5 text-primary" />
          <h1 className="font-semibold text-lg">{format(month, 'yyyy 年 M 月')}</h1>
          <div className="ml-auto flex items-center gap-1">
            <Button onClick={() => setMonth(startOfMonth(new Date()))} size="sm" variant="ghost">
              今天
            </Button>
            <Button aria-label="Previous month" onClick={() => setMonth((m) => addMonths(m, -1))} size="icon-sm" variant="ghost">
              <ChevronLeft />
            </Button>
            <Button aria-label="Next month" onClick={() => setMonth((m) => addMonths(m, 1))} size="icon-sm" variant="ghost">
              <ChevronRight />
            </Button>
          </div>
        </header>
        <div className="grid grid-cols-7 gap-px border-b text-center text-muted-foreground text-xs">
          {['一', '二', '三', '四', '五', '六', '日'].map((d) => (
            <div className="py-1" key={d}>{d}</div>
          ))}
        </div>
        <div className="grid min-h-0 flex-1 grid-cols-7 gap-px">
          {days.map((day) => {
            const runs = runsFor(day)
            const isToday = isSameDay(day, new Date())
            return (
              <button
                className={cn(
                  'flex flex-col items-start overflow-hidden border p-1 text-left text-xs hover:bg-muted/40',
                  !isSameMonth(day, month) && 'text-muted-foreground/40',
                  selected && isSameDay(day, selected) && 'ring-1 ring-primary'
                )}
                key={day.toISOString()}
                onClick={() => setSelected(day)}
                type="button"
              >
                <span className={cn('mb-0.5 font-medium', isToday && 'text-primary')}>{format(day, 'd')}</span>
                {runs.slice(0, 3).map((r, i) => (
                  <span className="w-full truncate text-[10px] text-primary/80" key={i}>
                    ● {format(r.at, 'HH:mm')} {r.task.name ?? r.task.goal}
                  </span>
                ))}
                {runs.length > 3 && <span className="text-[10px] text-muted-foreground">+{runs.length - 3}</span>}
              </button>
            )
          })}
        </div>
      </div>
      {selected && (
        <aside className="flex w-80 shrink-0 flex-col border-l bg-sidebar/50">
          <div className="flex h-11 items-center border-b px-3 font-medium text-sm">
            {format(selected, 'yyyy-MM-dd')} · {selectedRuns.length} 个运行
          </div>
          <ScrollArea className="min-h-0 flex-1">
            <div className="flex flex-col gap-2 p-3">
              {selectedRuns.length === 0 && <p className="text-muted-foreground text-sm">当天无定时任务。</p>}
              {selectedRuns.map((r, i) => (
                <div className="rounded-lg border bg-background/50 p-3 text-sm" key={`${r.task.id}-${i}`}>
                  <div className="flex items-start justify-between gap-2">
                    <span className="font-medium">{format(r.at, 'HH:mm')} · {r.task.name ?? '(unnamed)'}</span>
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
                  <p className="mt-1 text-muted-foreground text-xs">{r.task.sessionTitle ?? 'Untitled chat'}</p>
                  <p className="mt-2 line-clamp-3 text-foreground/80 text-xs">{r.task.goal}</p>
                  <button
                    className="mt-2 text-primary text-xs hover:underline"
                    onClick={() => void navigate({ to: '/session/$sessionId', params: { sessionId: r.task.sessionId } })}
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
```

- [ ] **Step 3: Add the sidebar nav entry**

In `app-sidebar.tsx`, add `CalendarClock` to the `lucide-react` import, and add a `SidebarMenuItem` before the Usage item:

```tsx
          <SidebarMenuItem>
            <SidebarMenuButton
              render={
                <Link
                  // biome-ignore lint/suspicious/noExplicitAny: TanStack Router activeProps generic over route tree
                  activeProps={{ 'data-active': 'true' } as any}
                  className="flex items-center gap-2"
                  // biome-ignore lint/suspicious/noExplicitAny: `to` constrained by Router's typed registry, widened over route const
                  to={'/scheduled' as any}
                >
                  <CalendarClock />
                  <span>定时任务</span>
                </Link>
              }
              tooltip="定时任务"
            />
          </SidebarMenuItem>
```

- [ ] **Step 4: Typecheck + format + manual verify**

Run: `npm run typecheck`
Run: `npx biome check --write src/renderer/src/routes/scheduled.tsx src/renderer/src/components/views/scheduled-calendar-view.tsx src/renderer/src/components/app-sidebar.tsx`
Manually: schedule a daily task via the agent, open 定时任务 from the sidebar, confirm dots appear on each day, day click shows the agenda, cancel + jump-to-session work, month navigation is instant.

- [ ] **Step 5: Commit**

```bash
git add src/renderer/src/routes/scheduled.tsx src/renderer/src/components/views/scheduled-calendar-view.tsx src/renderer/src/components/app-sidebar.tsx
git commit -m "feat(cron): all-sessions scheduled-tasks calendar with sidebar entry"
```

---

## Final verification

- [ ] Run the full suite: `npm test` — all green.
- [ ] `npm run typecheck` — clean.
- [ ] Launch the app (run-desktop skill) and exercise: drag-reorder persists across reload; right-panel Scheduled tab lists/cancels current-session jobs; `/scheduled` calendar shows all jobs, day agenda + cancel + jump work, month nav is instant.

## Notes on test infra

- Renderer store/lib tests (`sessions.test.ts`, `cron-occurrences.test.ts`) run under the existing vitest setup via `npm test`.
- `conversation-store.test.ts` and `cron-scheduler.test.ts` already exist and use `:memory:`/fake stores — extend them, don't create new harnesses.
- The TanStack Router route tree is generated; after adding `scheduled.tsx`, `npm run dev`/`typecheck` regenerates `routeTree.gen.ts`. If typecheck complains about an unknown route, run `npm run dev` once to regenerate, or check how `usage`/`skills` routes are registered.
