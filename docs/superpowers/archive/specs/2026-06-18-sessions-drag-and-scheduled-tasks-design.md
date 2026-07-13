# Session 拖拽排序 & 定时任务展示 — Design

Date: 2026-06-18
Status: Approved (pending spec review)

## Overview

Three user-facing features that share one new cron IPC surface:

1. **Drag-to-reorder sessions** in the left session list (manual ordering).
2. **Scheduled-tasks panel** in the right-hand panel, scoped to the current
   session, with cancel.
3. **Scheduled-tasks calendar** opened from the left sidebar, showing *all*
   cron jobs across every session in a month-grid calendar.

The cron backend already exists (`src/service/cron-scheduler.ts`,
`src/service/tools/cron.ts`) but is reachable only by the agent via tools.
Features 2 and 3 expose it to the renderer through new IPC methods; they share
one renderer-facing type and one set of service/IPC plumbing.

Work splits into two independent lines:

- **Line A — drag reorder** (Part 1): self-contained, touches sessions storage
  + one new IPC + the session list UI.
- **Line B — scheduled tasks** (Parts 2 & 3): one shared cron IPC surface feeding
  two UI entry points.

## Part 1 — Session drag-to-reorder

### Data model

`sessions` table gains a `sort_order INTEGER` column via an additive
`ALTER TABLE` migration (same try/catch pattern as the existing
`pinned`/`title` migrations in `conversation-store.ts`).

- Session ordering changes from `ORDER BY pinned DESC, last_active_at DESC`
  to `ORDER BY pinned DESC, sort_order ASC`.
- Migration backfill: assign incrementing `sort_order` by current
  `last_active_at DESC`, so order looks identical until the first manual drag.
- New sessions take `min(sort_order) - 1` so a "New chat" appears at the top.
- Pinned sessions remain a separate group floating to the top; within each
  group rows order by `sort_order ASC`.

### Tradeoff (accepted)

Once manual order exists, the previous behavior of a background session
auto-bubbling to the top on new activity is gone — order is whatever the user
dragged. Background activity is still surfaced by the unread dot and the
running indicator, not by position.

### Renderer behavior

- Use the already-installed `@dnd-kit` packages: `DndContext` +
  `SortableContext` with `verticalListSortingStrategy`, restricted to the
  vertical axis via `restrictToVerticalAxis` modifier.
- Each `SessionList` row becomes a sortable item (`useSortable`).
- On drag end: optimistically reorder the store, then persist via the new
  `reorderSessions(orderedIds)` IPC.
- The store's `setSessions`/`upsert` sort comparator changes from
  `byPinnedThenRecent` to `byPinnedThenSortOrder`. `SessionSummary` gains a
  `sortOrder: number` field.

### New IPC: `reorderSessions`

Full chain, mirroring `setSessionPinned`:
`ui.ts` type → `preload/index.ts` → `main/ipc/swarm-ipc.ts` →
`main/service-client.ts` → `service-ipc.ts` method union →
`service/dispatcher.ts` case → `service/session-manager.ts` →
`conversation-store.ts` (writes `sort_order` for the given id sequence).

`conversation-store` gains `reorderSessions(orderedIds: string[]): void` that
writes `sort_order = index` for each id in a single transaction.

## Part 2 & 3 — Shared cron backend

### Shared renderer type

Add to `src/shared/types/ui.ts` (so the renderer never imports service types):

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
```

For the global list, extend with `sessionTitle: string | null`.

### New IPC methods (shared by both UIs)

- `listCronJobsForSession(sessionId): CronJobSummary[]` — Part 2.
- `listAllCronJobs(): Array<CronJobSummary & { sessionTitle: string | null }>` — Part 3.
- `cancelCronJob(id): void` — both.

`cron-scheduler.ts` already has `listForSession` and `remove`; add
`listAll(): Array<StoredCronJob & { nextRun: number | null }>` that maps over
`store.listCronJobs()` joining the live `nextDate()`. `session-manager.ts`
holds the scheduler reference and proxies these three methods. The dispatcher
joins `sessionTitle` from `store.listSessions()` for the global list.

Each new service method logs entry/outcome at `info` and every `catch` at
`error` per CLAUDE.md §5.

## Part 2 — Right-panel scheduled-tasks tab (current session)

- `right-panel.tsx` gains a third tab **"Scheduled"** alongside Plan and Memory
  (`CalendarClock` icon); the collapsed rail gains a matching third icon.
- New `CronPanel` component lists the current session's jobs: name, cron
  expression, next run (relative time), last run, goal, and a delete button
  (calls `cancelCronJob`, then invalidates the query).
- New `use-cron.ts` React Query hook keyed by session id; while the Scheduled
  tab is visible it uses `refetchInterval` ≈ 20s so jobs the agent
  creates/fires via tools surface without a dedicated event channel.

## Part 3 — Left-sidebar all-tasks calendar (month grid)

### Entry point

`AppSidebar` footer gains a **"Scheduled"** nav item (`CalendarClock` icon,
same pattern as Usage/Settings) routing to a new `/scheduled` route.

### View

New `scheduled.tsx` route + `ScheduledCalendarView` component:

- Month-grid calendar, Monday-first, laid out with `date-fns`
  (`startOfMonth`, `eachDayOfInterval`, week padding).
- **Occurrence expansion happens in the renderer**: fetch raw jobs once via
  `listAllCronJobs()`, then for the visible month expand each job's run times
  using the `cron` package's `CronTime` (iterate `getNextDateFrom` from the
  month's first day until past the month's last day). This keeps month
  navigation instant with no per-flip IPC.
- Each day cell shows that day's run points (dot + time/name); overflow folds
  into a "+N" indicator.
- Clicking a day opens an agenda (popover or side detail) listing that day's
  runs: time, task name, owning session title, goal — with actions to jump to
  the session and to cancel the job.
- Month prev/next navigation + a "Today" button.

### Defensive expansion

A malformed cron expression or a job with no computable next date is skipped
with a `warn` log; one bad job must never break the whole month render.

## Error handling, logging, testing

- New service methods: `info` on entry/outcome, `error` in every `catch`
  before returning/rethrowing (CLAUDE.md §5).
- Tests:
  - `conversation-store`: `sort_order` migration + reorder + new ordering.
  - `cron-scheduler`: `listAll` returns jobs with `nextRun`.
  - Occurrence expansion: a pure function `(cronExpr, monthStart, monthEnd) =>
    Date[]` unit-tested across daily/weekly/monthly expressions and an invalid
    expression (returns `[]`).
  - Session store reorder comparator logic.

## Out of scope

- Creating/editing cron jobs from the UI (only the agent creates them; UI is
  view + cancel).
- Real-time push events for cron changes (polling covers it).
- Reordering across the pinned/unpinned boundary changing pin state.
