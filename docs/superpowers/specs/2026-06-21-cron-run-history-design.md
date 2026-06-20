# Cron Run History — Design Spec

**Date:** 2026-06-21
**Status:** Approved for planning
**Scope:** Backend persistence + structured logging only. No UI changes.

## Problem

Scheduled tasks (cron jobs) currently leave almost no trace of their executions.
On each tick, `cron-scheduler.ts` calls `store.touchCronJob(id, now)` (records only
`lastRunAt`) and then `fire()` → `manager.submitGoal()`, **discarding the returned
`taskId`**. There is no persisted link between "this cron firing" and "the task it
produced" or "whether that task succeeded". An operator cannot answer, from storage
or logs alone, whether a scheduled job ran and how it ended.

`submitGoal` already creates a `Task` (with `status`, `result`, `endedAt`) that is
persisted independently — so the missing piece is not the result body, but a **run
history** that ties each cron firing ↔ produced task ↔ final outcome.

## Goal

Persist one **run record** per cron firing, linked to the produced `taskId`, with the
final outcome back-filled when the (asynchronous) task completes. Records are for
audit / traceability ("留痕"). The result body stays in the `Task`; it is reachable by
`taskId`, not duplicated.

Non-goals for this iteration:
- No UI surfacing (Scheduled view / cron-panel untouched).
- No new IPC methods or renderer changes.

## Architecture

### 1. Data model — new `cron_runs` table

```sql
CREATE TABLE IF NOT EXISTS cron_runs (
  id           TEXT PRIMARY KEY,   -- runId (ulid)
  job_id       TEXT NOT NULL,      -- references cron_jobs.id (no FK; jobs may be cancelled while history is kept)
  session_id   TEXT NOT NULL,
  task_id      TEXT,               -- produced by submitGoal; null when dispatch failed before a task existed
  status       TEXT NOT NULL,      -- see status lifecycle below
  triggered_at INTEGER NOT NULL,
  ended_at     INTEGER,            -- set when finalized
  error        TEXT                -- failure summary (dispatch error or task error message)
);
CREATE INDEX IF NOT EXISTS idx_cron_runs_job ON cron_runs(job_id);
```

**`status` lifecycle:**
- `running` — written at tick time, task dispatched, outcome pending.
- A terminal task status (`completed` / `failed` / `cancelled` / `interrupted` / etc.,
  whatever `runTurn` observed) — back-filled when the task completes.
- `error` — dispatch itself threw (e.g. `submitGoal` failed); no task was created.
- `interrupted` — reconciled on startup when a `running` row's task cannot be confirmed
  (see §4).

**Retention / cleanup:**
- Keep at most **100 runs per `job_id`**; on insert, prune the oldest rows beyond that
  cap. Prevents unbounded growth for high-frequency crons (a minutely job = 1440 rows/day).
- **Cascade-delete with the session** (mirrors `cron_jobs`, which are deleted via
  `DELETE FROM cron_jobs WHERE session_id = ?`). Add a matching
  `DELETE FROM cron_runs WHERE session_id = ?` to the session-delete path.
- **Do NOT delete on individual job cancellation** — keeping a cancelled job's history is
  the point of "留痕". (`scheduler.remove()` → `store.deleteCronJob()` leaves `cron_runs`
  intact.)

### 2. Store API (`conversation-store.ts`)

New methods on `ConversationStore`:
- `saveCronRun(run: StoredCronRun): void` — insert; prune to last 100 per `job_id`.
- `attachCronRunTask(runId: string, taskId: string): void` — set `task_id` after dispatch.
- `finishCronRun(runId: string, outcome: { status: string; error: string | null; endedAt: number }): void`
- `listCronRunsForJob(jobId: string): StoredCronRun[]` — newest first (read/reconcile/tests).
- `getTask(taskId: string): Task | undefined` — single-task lookup for reconcile (there is
  currently only `getSessionTasks(sessionId)`).
- Extend the session-delete path to also clear `cron_runs` for that session.

New type:
```ts
export type StoredCronRun = {
  id: string
  jobId: string
  sessionId: string
  taskId: string | null
  status: string
  triggeredAt: number
  endedAt: number | null
  error: string | null
}
```
Add a `rowToCronRun` mapper alongside `rowToCronJob`.

### 3. Async outcome back-fill (`session-manager.ts`)

Add an optional last parameter to `submitGoal`:
```ts
submitGoal(sessionId, goal, attachments = [], agentDef = DEFAULT_AGENT_DEF,
           onComplete?: (status: TaskStatus, error?: string) => void)
```
Invoke `onComplete` exactly once when `runTurn` finishes:
- Success path: after `store.updateTaskStatus(taskId, status)` → `onComplete(status)`.
- Catch path: after marking the task `failed` → `onComplete('failed', message)`.

This is the only clean hook for the "outcome known later" signal. Existing callers
(dispatcher, tests) pass nothing and are unaffected.

### 4. Scheduler changes (`cron-scheduler.ts`)

Change the `fire` dependency contract so it returns the `taskId` and forwards the
completion callback:
```ts
fire: (sessionId: string, goal: string,
       onComplete: (status: string, error?: string) => void) => { taskId: string }
```
`index.ts` wiring:
```ts
fire: (sessionId, goal, onComplete) =>
  manager.submitGoal(sessionId, goal, [], undefined, onComplete),
```

`tick(job)` becomes:
```
if (!store.getSession(job.sessionId)) { remove(job.id); return }   // unchanged lazy-clean
const runId = ulid(); const triggeredAt = Date.now()
const runLog = log.child({ jobId: job.id, runId })
store.touchCronJob(job.id, triggeredAt)
store.saveCronRun({ id: runId, jobId: job.id, sessionId: job.sessionId,
                    taskId: null, status: 'running', triggeredAt, endedAt: null, error: null })
runLog.info({ msg: 'cron run started', sessionId: job.sessionId })
try {
  const { taskId } = fire(job.sessionId, job.goal, (status, error) => {
    store.finishCronRun(runId, { status, error: error ?? null, endedAt: Date.now() })
    runLog.info({ msg: 'cron run finished', taskId, status,
                  durationMs: Date.now() - triggeredAt, ...(error ? { error } : {}) })
  })
  store.attachCronRunTask(runId, taskId)
  runLog.info({ msg: 'cron run dispatched', taskId })
} catch (err) {
  const message = err instanceof Error ? err.message : String(err)
  store.finishCronRun(runId, { status: 'error', error: message, endedAt: Date.now() })
  runLog.error({ msg: 'cron run dispatch failed', err: message })
}
```
Note: the `onComplete` callback fires asynchronously, after the task's turn ends — it is
not bounded by the cron `onTick`. Overlapping runs each get their own `runId`.

### 5. Startup reconcile (`scheduler.start()`)

After (re)scheduling jobs, reconcile orphaned `running` rows whose in-memory
`onComplete` was lost to a crash/restart:
```
for each cron_run with status 'running':
  task = store.getTask(run.taskId)            // null if taskId null or task gone
  if (task && task is in a terminal state):
    finishCronRun(run.id, { status: task.status, error: task-derived, endedAt: task.endedAt ?? now })
  else:
    finishCronRun(run.id, { status: 'interrupted', error: null, endedAt: now })
  runLog.warn({ msg: 'cron run reconciled', runId, status })
```

### 6. Logging (CLAUDE.md §5)

All run logging goes through `log.child({ jobId, runId })`:
- tick start → `info`
- dispatched (taskId known) → `info`
- finished (status, durationMs) → `info`
- dispatch failed → `error`
- reconcile → `warn`

## Testing

`cron-scheduler.test.ts`:
- Tick writes a `running` run row.
- `onComplete` back-fills the terminal status + `endedAt`.
- Dispatch throwing records `status='error'` with the message, `task_id` null.
- `start()` reconcile: a leftover `running` row whose task is terminal is finalized from
  the task; one whose task is missing becomes `interrupted`.

Store-level (`conversation-store` tests):
- `cron_runs` insert / attach / finish / list (newest first).
- Retention: inserting >100 runs for one job keeps only the latest 100.
- Session delete cascades to `cron_runs`; job cancel leaves them intact.
- `getTask(taskId)` returns the task or `undefined`.

## Open defaults (changeable)

- Retention cap = **100 runs per job**.
- Run history **survives job cancellation**; only session deletion cascades.
