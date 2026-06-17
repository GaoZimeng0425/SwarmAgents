# Unified Durable Event Log — Design

**Date:** 2026-06-16
**Status:** Approved, ready for implementation plan

## Problem

Task state is not durably persisted as it happens. Two in-memory-until-the-end
stores lose data on a mid-run process death, and the "persist some events out of
band" patches (plan, error) are per-event band-aids over a missing single source
of truth:

- **Display log (`history`)** — `session-manager.ts`'s `makeEmit` buffers
  `task.progress` events into an in-memory `historyByTask` map and flushes the
  whole array via `saveTaskHistory` (`UPDATE tasks SET history = ?`) only on
  `task.complete`/`task.error` (and the `runTurn` catch). A process kill mid-run
  loses the buffer; every flush rewrites the entire JSON array (O(n) per write).
- **Model context (`agent_snapshot`)** — `session.messages` (`AgentMessage[]`,
  used to resume the conversation) is saved via `saveAgentSnapshot` only after
  `runner.run()` returns. A mid-run kill loses the whole turn's context.
- The recent plan- and error-persistence fixes added eager writes for those two
  event kinds specifically — useful, but they are special cases of "an emitted
  event that never reached durable storage." The clean fix is to make **every**
  emitted event durable at emit time through one sink.

This is the gap behind the earlier "error message disappears on reload" bug:
events were broadcast (push) but not persisted (pull), because the persisted log
was a delayed, end-of-task snapshot rather than an append-only log.

## Goal

Make the task event log and the agent message context **durably persisted as
they happen**, from a single sink, so push (live broadcast) and pull
(`getSessionTasks`) derive from the same continuously-appended source. A process
kill loses at most the current in-flight turn's tail.

## Scope

In scope: append-only event log + per-turn agent-context/usage persistence +
collapsing `makeEmit` into one sink. Covers both the display log and the model
context (the chosen "log + agent context" scope).

Out of scope: renderer rendering changes (the external contract is unchanged);
auto re-running an interrupted agent; memory changes.

## Design

### A. Event log → append-only `task_events` table

**Storage** (`src/service/conversation-store.ts`):

```sql
CREATE TABLE IF NOT EXISTS task_events (
  id       INTEGER PRIMARY KEY,            -- rowid = monotonic insertion order
  task_id  TEXT NOT NULL REFERENCES tasks(id),
  event    TEXT NOT NULL,                  -- JSON of one TaskEvent
  ts       INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_task_events_task ON task_events(task_id, id);
```

- New method `appendTaskEvent(taskId: string, event: TaskEvent): void` → one
  `INSERT INTO task_events (task_id, event, ts) VALUES (?, ?, ?)`.
- `getSessionTasks` reconstructs each task's `history` from
  `SELECT event FROM task_events WHERE task_id = ? ORDER BY id` (a prepared
  statement run per task), replacing the parse of the `tasks.history` column.
- Remove `saveTaskHistory` and its prepared statement.
- `saveTask` stops writing the `history` column (it keeps its `DEFAULT '[]'`);
  the column stays in the schema only as the backfill source.

**Migration / backfill** — in `createConversationStore`, after creating the
`task_events` table, run an idempotent backfill inside a transaction: for each
task whose `history` column holds a non-empty JSON array **and** which has zero
rows in `task_events`, insert each element as a `task_events` row (in array
order). This carries forward existing persisted transcripts. New rows never
populate the `history` column, so the guard (`zero task_events rows`) makes
re-runs no-ops.

The `task_events.task_id → tasks(id)` foreign key means `deleteSession` must
delete `task_events` for the session's tasks before deleting the tasks (extend
the existing `deleteSessionTx`).

### B. Agent context + usage → persisted every turn

**`src/service/agent-runner.ts`:**

- Add `saveSnapshot?(messages: AgentMessage[], used: ResourceBudget): void` to
  `AgentRunnerDeps`.
- In the `agent.subscribe` handler's `turn_end` branch (where usage is already
  computed), after updating `used`, call
  `deps.saveSnapshot?.(agent.state.messages, snapshotUsed())`. This persists the
  latest full message array and usage at every model-turn boundary.

**`src/service/session-manager.ts`:**

- Wire `saveSnapshot` for the top-level task runner:
  ```ts
  saveSnapshot: (messages, used) => {
    session.messages = messages
    store.saveAgentSnapshot(sessionId, messages)
    store.saveTaskUsage(taskId, used)
  }
  ```
- Remove the now-redundant end-of-run saves in `runTurn`: the
  `if (messages) { session.messages = messages; store.saveAgentSnapshot(...) }`
  and `if (used) store.saveTaskUsage(...)` blocks. The end path keeps only
  `store.updateTaskStatus(taskId, status)`.
- `saveSnapshot` is optional; `spawnChild`'s child runner omits it (children are
  one-shot sub-agents, not resumed conversations). Children still append their
  transcript events via the sink (they emit through `makeEmit(sessionId)`).

A task that fails during setup (e.g. missing API key) emits `task.error` before
any `turn_end`, so no snapshot is saved — correct, since no messages progressed.

### C. `makeEmit` collapses into one sink

Remove `historyByTask`, the old buffer-based `appendError`, the
`task.complete`/`task.error` flush, and the `runTurn` catch flush. New
`makeEmit` body:

```ts
const makeEmit = (sessionId: string) => (event: string, data: unknown): void => {
  const obj = data && typeof data === 'object' ? (data as Record<string, unknown>) : undefined
  const payload = obj ? { sessionId, ...obj } : data
  const taskId = obj?.taskId as string | undefined

  if (event === 'task.progress' && taskId && obj?.event) {
    store.appendTaskEvent(taskId, obj.event as TaskEvent)
  }
  if (event === 'task.error' && taskId && obj?.error) {
    store.appendTaskEvent(taskId, {
      kind: 'error',
      error: obj.error as Extract<TaskEvent, { kind: 'error' }>['error'],
      ts: Date.now(),
    })
  }
  if (event === 'task.plan' && taskId && Array.isArray(obj?.todos)) {
    store.saveTaskPlan(taskId, obj.todos as PlanTodo[])
  }
  broadcaster.broadcast(event, payload)
}
```

`runTurn` catch becomes:

```ts
} catch (err) {
  log.error({ msg: 'runTurn failed', taskId, err: err instanceof Error ? err.message : String(err) })
  store.appendTaskEvent(taskId, {
    kind: 'error',
    error: { code: 'run_failed', message: err instanceof Error ? err.message : String(err), tier: 'fatal' },
    ts: Date.now(),
  })
  try {
    store.updateTaskStatus(taskId, 'failed')
  } catch (statusErr) {
    log.error({ msg: 'failed to mark task failed', taskId, err: String(statusErr) })
  }
} finally { ... }
```

`task.plan` keeps writing the denormalized `tasks.plan` projection (the latest
plan snapshot the renderer reads directly) — that stays as-is.

## Data flow

```
event emitted (agent-runner)
  → makeEmit sink: store.appendTaskEvent(taskId, taskEvent)   [durable, immediate]
                 + broadcaster.broadcast(event)               [live push]
turn_end (agent-runner)
  → deps.saveSnapshot(agent.state.messages, used)
  → session.messages = messages; saveAgentSnapshot; saveTaskUsage   [durable, per turn]

--- reload ---

getSessionTasks → history = SELECT event FROM task_events WHERE task_id=? ORDER BY id
  → tasksToRecords → task-segments (unchanged)
```

## Components & boundaries

- `conversation-store` — owns the `task_events` table, `appendTaskEvent`, history
  reconstruction, and the backfill. Fully unit-testable.
- `session-manager` — owns the single `makeEmit` sink and the `saveSnapshot`
  wiring. Private, non-injectable seams (no existing harness).
- `agent-runner` — calls `deps.saveSnapshot` on `turn_end`. Private seam.
- Renderer — unchanged; `getSessionTasks` returns the same `Task` shape with
  `history` populated, and live broadcasts are unchanged.

## Testing

- `conversation-store` (the testable core):
  - `appendTaskEvent` appends; `getSessionTasks` returns events in insertion
    order as `history`.
  - Round-trip across reconnect (close + reopen the DB, events persist).
  - Backfill: a DB whose `tasks.history` column holds a JSON array and no
    `task_events` rows → after reopen, `getSessionTasks` returns that history
    from `task_events`; running the backfill again does not duplicate rows.
  - `deleteSession` removes `task_events` for the session's tasks (no FK error).
- `session-manager` / `agent-runner` sink + `turn_end` snapshot are private,
  non-injectable seams (no harness, `createAgentRunner` not injectable). Verified
  by typecheck + lint + the existing service suite; the durable behavior they
  rely on (`appendTaskEvent`, `saveAgentSnapshot`, `saveTaskUsage`) is covered at
  the store level. No fabricated fake-runner harness.
- Existing `replay` / `task-segments` tests stay green (renderer contract
  unchanged).

## Risks

- **Migration on existing DBs** — the backfill is idempotent (guarded by
  "zero `task_events` rows for this task") and runs in a transaction; the
  `CREATE TABLE`/`CREATE INDEX` use `IF NOT EXISTS`. Fresh DBs skip the backfill
  (no legacy `history` rows).
- **FK on delete** — `task_events` references `tasks(id)`; `deleteSessionTx` must
  delete `task_events` first. Covered by a test.
- **Per-event INSERT cost** — better-sqlite3 is synchronous with WAL; the
  highest-frequency event (`llm.message`) is already batched to ~200-char chunks
  (not per token), so append volume is modest.
- **Snapshot write frequency** — `saveAgentSnapshot` rewrites the full
  `AgentMessage[]` per turn (turns are coarse, not per token), which matches the
  existing once-at-end cost amortized over a handful of turns. Acceptable.
