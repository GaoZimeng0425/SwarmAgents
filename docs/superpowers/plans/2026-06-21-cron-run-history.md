# Cron Run History Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Persist one run record per cron firing, linked to the produced `taskId`, with the final outcome back-filled when the asynchronous task completes — so an operator can tell from storage and logs alone whether a scheduled job ran and how it ended.

**Architecture:** A new `cron_runs` SQLite table records each tick (status `running`, `task_id` null). `submitGoal` gains an optional `onComplete` callback invoked when its task turn ends; the scheduler threads a per-run callback through `fire` to finalize the matching run row. On startup, orphaned `running` rows are reconciled from their task's persisted status (or marked `interrupted`).

**Tech Stack:** TypeScript, `better-sqlite3` (synchronous prepared statements), `cron` (CronJob), `ulid`, `pino` logging, Vitest (run via `npm test`).

## Global Constraints

- Reply to the user in Chinese; **code comments and commit messages in English**.
- Logging via `pino` per CLAUDE.md §5: structured first arg, one `log.child` per correlation scope, `error` level in every `catch`, never swallow.
- Run tests with `npm test` — **never** bare `npx vitest`, never `pnpm rebuild better-sqlite3`.
- Surgical changes only: touch what the task requires; do not refactor adjacent code.
- Retention cap: keep at most **100 runs per `job_id`**.
- Run history survives individual job cancellation; only **session deletion** cascades to `cron_runs`.

---

### Task 1: `cron_runs` store layer

**Files:**
- Modify: `src/service/conversation-store.ts`
- Test: `src/service/conversation-store.test.ts`

**Interfaces:**
- Consumes: existing `rowToTask`, `stmtGetTasks` patterns; `Task` type from `@shared/types/task`.
- Produces (relied on by Tasks 2 & 3):
  - `type StoredCronRun = { id: string; jobId: string; sessionId: string; taskId: string | null; status: string; triggeredAt: number; endedAt: number | null; error: string | null }`
  - `saveCronRun(run: StoredCronRun): void` — inserts, then prunes to the latest 100 per `jobId`.
  - `attachCronRunTask(runId: string, taskId: string): void`
  - `finishCronRun(runId: string, outcome: { status: string; error: string | null; endedAt: number }): void`
  - `listCronRunsForJob(jobId: string): StoredCronRun[]` — newest first.
  - `listRunningCronRuns(): StoredCronRun[]` — every row with `status = 'running'`.
  - `getTask(taskId: string): Task | undefined`

- [ ] **Step 1: Write the failing tests**

Append to `src/service/conversation-store.test.ts` (inside the top-level `describe`):

```typescript
  it('records, attaches, and finishes a cron run', () => {
    const store = createConversationStore(dbPath)
    const provider = { id: 'anthropic' as const, model: 'claude-sonnet-4-5', apiKey: 'k' }
    store.createSession('ses-1', provider)

    store.saveCronRun({
      id: 'run-1',
      jobId: 'job-1',
      sessionId: 'ses-1',
      taskId: null,
      status: 'running',
      triggeredAt: 100,
      endedAt: null,
      error: null,
    })
    store.attachCronRunTask('run-1', 'task-1')
    store.finishCronRun('run-1', { status: 'completed', error: null, endedAt: 200 })

    const runs = store.listCronRunsForJob('job-1')
    expect(runs).toHaveLength(1)
    expect(runs[0]).toMatchObject({
      id: 'run-1',
      taskId: 'task-1',
      status: 'completed',
      endedAt: 200,
    })
    store.close()
  })

  it('lists running cron runs only', () => {
    const store = createConversationStore(dbPath)
    const provider = { id: 'anthropic' as const, model: 'claude-sonnet-4-5', apiKey: 'k' }
    store.createSession('ses-1', provider)
    store.saveCronRun({ id: 'r-run', jobId: 'j', sessionId: 'ses-1', taskId: 't', status: 'running', triggeredAt: 1, endedAt: null, error: null })
    store.saveCronRun({ id: 'r-done', jobId: 'j', sessionId: 'ses-1', taskId: 't2', status: 'completed', triggeredAt: 2, endedAt: 3, error: null })

    const running = store.listRunningCronRuns()
    expect(running.map((r) => r.id)).toEqual(['r-run'])
    store.close()
  })

  it('keeps only the latest 100 runs per job', () => {
    const store = createConversationStore(dbPath)
    const provider = { id: 'anthropic' as const, model: 'claude-sonnet-4-5', apiKey: 'k' }
    store.createSession('ses-1', provider)
    for (let i = 0; i < 105; i++) {
      store.saveCronRun({ id: `run-${i}`, jobId: 'job-1', sessionId: 'ses-1', taskId: null, status: 'running', triggeredAt: i, endedAt: null, error: null })
    }
    const runs = store.listCronRunsForJob('job-1')
    expect(runs).toHaveLength(100)
    // newest first; oldest five (triggeredAt 0..4) pruned
    expect(runs[0].triggeredAt).toBe(104)
    expect(runs.at(-1)?.triggeredAt).toBe(5)
    store.close()
  })

  it('cascades cron_runs on session delete but keeps them after job removal', () => {
    const store = createConversationStore(dbPath)
    const provider = { id: 'anthropic' as const, model: 'claude-sonnet-4-5', apiKey: 'k' }
    store.createSession('ses-1', provider)
    store.saveCronJob({ id: 'job-1', sessionId: 'ses-1', name: null, cron: '0 0 * * *', goal: 'g', createdAt: 1, lastRunAt: null })
    store.saveCronRun({ id: 'run-1', jobId: 'job-1', sessionId: 'ses-1', taskId: null, status: 'running', triggeredAt: 1, endedAt: null, error: null })

    store.deleteCronJob('job-1')
    expect(store.listCronRunsForJob('job-1')).toHaveLength(1) // job removal keeps history

    store.deleteSession('ses-1')
    expect(store.listCronRunsForJob('job-1')).toHaveLength(0) // session delete cascades
    store.close()
  })

  it('getTask returns a saved task or undefined', () => {
    const store = createConversationStore(dbPath)
    const provider = { id: 'anthropic' as const, model: 'claude-sonnet-4-5', apiKey: 'k' }
    store.createSession('ses-1', provider)
    const now = Date.now()
    store.saveTask(
      {
        id: 'task-1', parentId: null, agentDefId: 'a', goal: 'g', status: 'pending',
        assignedWorkerId: null, toolAllowlist: [], budget: { tokens: 0, calls: 0, wallMs: 0, usdCents: 0 },
        used: { tokens: 0, calls: 0, wallMs: 0, usdCents: 0 }, history: [], attachments: [],
        result: null, createdAt: now, startedAt: null, endedAt: null,
      },
      'ses-1'
    )
    expect(store.getTask('task-1')?.goal).toBe('g')
    expect(store.getTask('missing')).toBeUndefined()
    store.close()
  })
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npm test -- src/service/conversation-store.test.ts`
Expected: FAIL — `store.saveCronRun is not a function` (and the other new methods undefined).

- [ ] **Step 3: Add the schema, type, statements, and methods**

In `src/service/conversation-store.ts`:

(a) After the `cron_jobs` index (the `CREATE INDEX IF NOT EXISTS idx_cron_jobs_session ...` line, ~124), inside the same `db.exec(\`...\`)` block, add:

```sql
    CREATE TABLE IF NOT EXISTS cron_runs (
      id           TEXT PRIMARY KEY,
      job_id       TEXT NOT NULL,
      session_id   TEXT NOT NULL,
      task_id      TEXT,
      status       TEXT NOT NULL,
      triggered_at INTEGER NOT NULL,
      ended_at     INTEGER,
      error        TEXT
    );
    CREATE INDEX IF NOT EXISTS idx_cron_runs_job ON cron_runs(job_id);
```

(b) Add the exported type near `StoredCronJob` (after its definition, ~line 31):

```typescript
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

(c) Add the methods to the `ConversationStore` type (after `touchCronJob`, ~line 59):

```typescript
  saveCronRun(run: StoredCronRun): void
  attachCronRunTask(runId: string, taskId: string): void
  finishCronRun(runId: string, outcome: { status: string; error: string | null; endedAt: number }): void
  listCronRunsForJob(jobId: string): StoredCronRun[]
  listRunningCronRuns(): StoredCronRun[]
  getTask(taskId: string): Task | undefined
```

(d) Add a `rowToCronRun` mapper next to `rowToCronJob` (~line 200):

```typescript
  const rowToCronRun = (row: Record<string, unknown>): StoredCronRun => ({
    id: row.id as string,
    jobId: row.job_id as string,
    sessionId: row.session_id as string,
    taskId: (row.task_id as string | null) ?? null,
    status: row.status as string,
    triggeredAt: row.triggered_at as number,
    endedAt: (row.ended_at as number | null) ?? null,
    error: (row.error as string | null) ?? null,
  })
```

(e) Add prepared statements next to the cron-job statements (~line 209):

```typescript
  const stmtInsertCronRun = db.prepare(
    `INSERT INTO cron_runs (id, job_id, session_id, task_id, status, triggered_at, ended_at, error)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?)`
  )
  const stmtPruneCronRuns = db.prepare(
    `DELETE FROM cron_runs WHERE job_id = ? AND id NOT IN (
       SELECT id FROM cron_runs WHERE job_id = ? ORDER BY triggered_at DESC LIMIT 100
     )`
  )
  const stmtAttachCronRunTask = db.prepare('UPDATE cron_runs SET task_id = ? WHERE id = ?')
  const stmtFinishCronRun = db.prepare('UPDATE cron_runs SET status = ?, error = ?, ended_at = ? WHERE id = ?')
  const stmtListCronRunsForJob = db.prepare('SELECT * FROM cron_runs WHERE job_id = ? ORDER BY triggered_at DESC')
  const stmtListRunningCronRuns = db.prepare("SELECT * FROM cron_runs WHERE status = 'running'")
  const stmtGetTask = db.prepare('SELECT * FROM tasks WHERE id = ?')
```

(f) In the `deleteSessionTx` transaction (~line 265), add a `cron_runs` delete alongside the existing `cron_jobs` delete:

```typescript
    db.prepare('DELETE FROM cron_runs WHERE session_id = ?').run(id)
```

(g) Add the method implementations next to `touchCronJob` in the returned object (~line 539):

```typescript
    saveCronRun(run) {
      stmtInsertCronRun.run(
        run.id, run.jobId, run.sessionId, run.taskId ?? null,
        run.status, run.triggeredAt, run.endedAt ?? null, run.error ?? null
      )
      stmtPruneCronRuns.run(run.jobId, run.jobId)
    },
    attachCronRunTask(runId, taskId) {
      stmtAttachCronRunTask.run(taskId, runId)
    },
    finishCronRun(runId, outcome) {
      stmtFinishCronRun.run(outcome.status, outcome.error ?? null, outcome.endedAt, runId)
    },
    listCronRunsForJob(jobId) {
      return (stmtListCronRunsForJob.all(jobId) as Record<string, unknown>[]).map(rowToCronRun)
    },
    listRunningCronRuns() {
      return (stmtListRunningCronRuns.all() as Record<string, unknown>[]).map(rowToCronRun)
    },
    getTask(taskId) {
      const row = stmtGetTask.get(taskId) as Record<string, unknown> | undefined
      return row ? rowToTask(row) : undefined
    },
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `npm test -- src/service/conversation-store.test.ts`
Expected: PASS (all new tests green, existing tests still green).

- [ ] **Step 5: Commit**

```bash
git add src/service/conversation-store.ts src/service/conversation-store.test.ts
git commit -m "feat(store): add cron_runs table and run-history methods"
```

---

### Task 2: `submitGoal` completion callback

**Files:**
- Modify: `src/service/session-manager.ts`
- Test: `src/service/session-manager.test.ts`

**Interfaces:**
- Consumes: existing `submitGoal(sessionId, goal, attachments?, agentDef?)` returning `{ taskId }`; `runner.run()` returning `{ status }`.
- Produces (relied on by Task 3): `submitGoal(sessionId, goal, attachments?, agentDef?, onComplete?: (status: TaskStatus, error?: string) => void): { taskId }`. `onComplete` fires exactly once when the task turn ends — with the observed status on success, or `('failed', message)` on a thrown run.

- [ ] **Step 1: Write the failing tests**

Add to `src/service/session-manager.test.ts`. (Match the file's existing harness for constructing a manager and a fake provider/runner. The two behaviors to assert:)

```typescript
  it('invokes onComplete with the final status when the task turn ends', async () => {
    // Arrange a manager whose runner resolves to { status: 'completed' } (use the file's existing fake-runner setup).
    const onComplete = vi.fn()
    const { taskId } = manager.submitGoal('ses-1', 'do it', [], undefined, onComplete)
    expect(taskId).toBeTruthy()
    await flushQueue() // await the session queue so runTurn completes (use the file's existing await helper)
    expect(onComplete).toHaveBeenCalledTimes(1)
    expect(onComplete).toHaveBeenCalledWith('completed')
  })

  it('invokes onComplete with failed + message when the run throws', async () => {
    // Arrange the fake runner to reject with new Error('boom').
    const onComplete = vi.fn()
    manager.submitGoal('ses-1', 'do it', [], undefined, onComplete)
    await flushQueue()
    expect(onComplete).toHaveBeenCalledWith('failed', 'boom')
  })
```

Note for the implementer: reuse the existing manager-construction and runner-mocking helpers already present in `session-manager.test.ts` rather than introducing new ones — read the file's top-of-suite setup and mirror it. If the suite stubs `createAgentRunner`, configure its `run()` per test (resolve vs reject).

- [ ] **Step 2: Run tests to verify they fail**

Run: `npm test -- src/service/session-manager.test.ts`
Expected: FAIL — `onComplete` is never called (current `submitGoal` ignores the 5th arg).

- [ ] **Step 3: Thread `onComplete` through `submitGoal`/`runTurn`**

In `src/service/session-manager.ts`:

(a) Update the `submitGoal` signature in the `SessionManager` type (near line 47) to add the optional last parameter:

```typescript
  submitGoal(
    sessionId: string,
    goal: string,
    attachments?: Attachment[],
    agentDef?: AgentDefinition,
    onComplete?: (status: TaskStatus, error?: string) => void
  ): { taskId: string }
```

Ensure `TaskStatus` is imported from `@shared/types/task` (add to the existing import if absent).

(b) Update the implementation signature (line 296):

```typescript
    submitGoal(sessionId, goal, attachments = [], agentDef = DEFAULT_AGENT_DEF, onComplete) {
```

(c) In `runTurn`, the success path currently is:

```typescript
          const { status } = await runner.run()
          store.updateTaskStatus(taskId, status)
```

Add the callback right after:

```typescript
          const { status } = await runner.run()
          store.updateTaskStatus(taskId, status)
          onComplete?.(status)
```

(d) In the `catch (err)` block, after the existing `store.updateTaskStatus(taskId, 'failed')` (the inner try at ~line 367), add the failure callback. Capture the message already computed for the error event:

```typescript
        } catch (err) {
          const message = err instanceof Error ? err.message : String(err)
          log.error({ msg: 'runTurn failed', taskId, err: message })
          // ... existing appendTaskEvent + updateTaskStatus('failed') unchanged,
          // reusing `message` instead of recomputing ...
          onComplete?.('failed', message)
        } finally {
```

Implementer note: the block already derives the message inline twice (for the log and the error event). Replace those inline `err instanceof Error ? ...` expressions with the single `message` const and pass it to `onComplete`. Do not change the `finally` block. Keep the existing nested try/catch around `appendTaskEvent` and `updateTaskStatus`.

- [ ] **Step 4: Run tests to verify they pass**

Run: `npm test -- src/service/session-manager.test.ts`
Expected: PASS. Existing `submitGoal` tests still green (callers passing no `onComplete` are unaffected).

- [ ] **Step 5: Commit**

```bash
git add src/service/session-manager.ts src/service/session-manager.test.ts
git commit -m "feat(session): add onComplete callback to submitGoal"
```

---

### Task 3: Scheduler run recording, reconcile, and wiring

**Files:**
- Modify: `src/service/cron-scheduler.ts`
- Modify: `src/service/index.ts` (the `fire` wiring, ~line 77)
- Test: `src/service/cron-scheduler.test.ts`

**Interfaces:**
- Consumes: `store.saveCronRun / attachCronRunTask / finishCronRun / listRunningCronRuns / getTask` (Task 1); `manager.submitGoal(..., onComplete)` returning `{ taskId }` (Task 2).
- Produces: `createCronScheduler({ store, fire })` where `fire: (sessionId: string, goal: string, onComplete: (status: string, error?: string) => void) => { taskId: string }`.

- [ ] **Step 1: Update the existing tests and add new ones**

In `src/service/cron-scheduler.test.ts`:

(a) Extend `fakeStore` to record runs and back tasks. Add inside the returned `store` object:

```typescript
      saveCronRun: (r: StoredCronRun) => { runs.set(r.id, r) },
      attachCronRunTask: (runId: string, taskId: string) => {
        const r = runs.get(runId); if (r) r.taskId = taskId
      },
      finishCronRun: (runId: string, o: { status: string; error: string | null; endedAt: number }) => {
        const r = runs.get(runId); if (r) Object.assign(r, o)
      },
      listCronRunsForJob: (jobId: string) =>
        [...runs.values()].filter((r) => r.jobId === jobId).sort((a, b) => b.triggeredAt - a.triggeredAt),
      listRunningCronRuns: () => [...runs.values()].filter((r) => r.status === 'running'),
      getTask: (id: string) => tasks.get(id),
```

At the top of `fakeStore`, add the backing maps and import:

```typescript
import type { ConversationStore, StoredCronJob, StoredCronRun } from './conversation-store'
import type { Task } from '@shared/types/task'
// ...inside fakeStore:
  const runs = new Map<string, StoredCronRun>()
  const tasks = new Map<string, Task>()
```
Expose `runs` and `tasks` on the returned object alongside `jobs` so tests can assert/seed them.

(b) Update the **default `fire` mock** everywhere it's used to return a taskId, and fix the two `toHaveBeenCalledWith` assertions to allow the callback arg:

```typescript
const fire = vi.fn().mockReturnValue({ taskId: 'task-x' })
// ...
expect(fire).toHaveBeenCalledWith('ses-1', 'do it', expect.any(Function))   // was ('ses-1', 'do it')
// ...
expect(fire).toHaveBeenCalledWith('ses-1', 'reload me', expect.any(Function)) // was ('ses-1', 'reload me')
```

(c) Add new behavior tests:

```typescript
  it('records a run and back-fills its outcome via onComplete', () => {
    const { store, sessions, runs } = fakeStore()
    sessions.add('ses-1')
    let captured: ((status: string, error?: string) => void) | undefined
    const fire = vi.fn((_sid: string, _goal: string, onComplete: (s: string, e?: string) => void) => {
      captured = onComplete
      return { taskId: 'task-1' }
    })
    const sched = createCronScheduler({ store, fire })
    const { id } = sched.add({ sessionId: 'ses-1', cron: '0 0 * * *', goal: 'g' })
    sched.runJobNow(id)

    const run = [...runs.values()][0]
    expect(run.status).toBe('running')
    expect(run.taskId).toBe('task-1')

    captured?.('completed')
    expect([...runs.values()][0].status).toBe('completed')
    sched.dispose()
  })

  it('marks the run as error when dispatch throws', () => {
    const { store, sessions, runs } = fakeStore()
    sessions.add('ses-1')
    const fire = vi.fn(() => { throw new Error('dispatch boom') })
    const sched = createCronScheduler({ store, fire })
    const { id } = sched.add({ sessionId: 'ses-1', cron: '0 0 * * *', goal: 'g' })
    sched.runJobNow(id)

    const run = [...runs.values()][0]
    expect(run.status).toBe('error')
    expect(run.error).toBe('dispatch boom')
    expect(run.taskId).toBeNull()
    sched.dispose()
  })

  it('reconciles orphaned running runs on start', () => {
    const { store, sessions, runs, tasks } = fakeStore()
    sessions.add('ses-1')
    // a leftover running run whose task actually completed
    runs.set('run-done', { id: 'run-done', jobId: 'job-1', sessionId: 'ses-1', taskId: 'task-1', status: 'running', triggeredAt: 1, endedAt: null, error: null })
    tasks.set('task-1', { id: 'task-1', status: 'completed', endedAt: 5 } as Task)
    // a leftover running run whose task is gone
    runs.set('run-lost', { id: 'run-lost', jobId: 'job-1', sessionId: 'ses-1', taskId: 'task-gone', status: 'running', triggeredAt: 2, endedAt: null, error: null })

    const sched = createCronScheduler({ store, fire: vi.fn().mockReturnValue({ taskId: 't' }) })
    sched.start()

    expect(runs.get('run-done')?.status).toBe('completed')
    expect(runs.get('run-lost')?.status).toBe('interrupted')
    sched.dispose()
  })
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npm test -- src/service/cron-scheduler.test.ts`
Expected: FAIL — `fire` still called with 2 args / no run rows written / no reconcile.

- [ ] **Step 3: Implement scheduler changes**

In `src/service/cron-scheduler.ts`:

(a) Update the `fire` type in `createCronScheduler`'s `deps` (line 24):

```typescript
  fire: (sessionId: string, goal: string, onComplete: (status: string, error?: string) => void) => { taskId: string }
```

(b) Replace the `tick` body (lines 31-42) with run recording:

```typescript
  const tick = (job: StoredCronJob): void => {
    if (!store.getSession(job.sessionId)) {
      remove(job.id)
      return
    }
    const runId = ulid()
    const triggeredAt = Date.now()
    const runLog = log.child({ jobId: job.id, runId })
    store.touchCronJob(job.id, triggeredAt)
    store.saveCronRun({
      id: runId,
      jobId: job.id,
      sessionId: job.sessionId,
      taskId: null,
      status: 'running',
      triggeredAt,
      endedAt: null,
      error: null,
    })
    runLog.info({ msg: 'cron run started', sessionId: job.sessionId })
    try {
      const { taskId } = fire(job.sessionId, job.goal, (status, error) => {
        store.finishCronRun(runId, { status, error: error ?? null, endedAt: Date.now() })
        runLog.info({
          msg: 'cron run finished',
          taskId,
          status,
          durationMs: Date.now() - triggeredAt,
          ...(error ? { error } : {}),
        })
      })
      store.attachCronRunTask(runId, taskId)
      runLog.info({ msg: 'cron run dispatched', taskId })
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err)
      store.finishCronRun(runId, { status: 'error', error: message, endedAt: Date.now() })
      runLog.error({ msg: 'cron run dispatch failed', err: message })
    }
  }
```

(c) Add a `reconcile` helper and call it from `start()`. Insert the helper above the returned object (after `remove`):

```typescript
  // Finalize runs left 'running' by a crash/restart: their in-memory onComplete
  // is gone, so derive the outcome from the task's persisted status, or mark
  // 'interrupted' when the task can't be confirmed.
  const reconcile = (): void => {
    const terminal = new Set(['completed', 'failed', 'cancelled', 'interrupted'])
    for (const run of store.listRunningCronRuns()) {
      const task = run.taskId ? store.getTask(run.taskId) : undefined
      if (task && terminal.has(task.status)) {
        store.finishCronRun(run.id, { status: task.status, error: null, endedAt: task.endedAt ?? Date.now() })
        log.warn({ msg: 'cron run reconciled', runId: run.id, jobId: run.jobId, status: task.status })
      } else {
        store.finishCronRun(run.id, { status: 'interrupted', error: null, endedAt: Date.now() })
        log.warn({ msg: 'cron run reconciled', runId: run.id, jobId: run.jobId, status: 'interrupted' })
      }
    }
  }
```

In `start()`, call `reconcile()` after the reschedule loop:

```typescript
    start() {
      for (const job of store.listCronJobs()) {
        try {
          schedule(job)
        } catch (err) {
          log.error({ msg: 'failed to reschedule cron job', id: job.id, err: String(err) })
        }
      }
      reconcile()
    },
```

- [ ] **Step 4: Wire `fire` in `index.ts`**

In `src/service/index.ts`, update the scheduler construction (~line 77):

```typescript
const scheduler = createCronScheduler({
  store,
  fire: (sessionId, goal, onComplete) => manager.submitGoal(sessionId, goal, [], undefined, onComplete),
})
```

- [ ] **Step 5: Run tests to verify they pass**

Run: `npm test -- src/service/cron-scheduler.test.ts`
Expected: PASS (new + updated tests green).

- [ ] **Step 6: Full service suite + typecheck**

Run: `npm test -- src/service` and `npx tsc --noEmit` (or the project's typecheck script).
Expected: PASS / no type errors. The `index.ts` and scheduler `fire` signatures line up with `submitGoal`.

- [ ] **Step 7: Commit**

```bash
git add src/service/cron-scheduler.ts src/service/cron-scheduler.test.ts src/service/index.ts
git commit -m "feat(cron): record run history with outcome back-fill and startup reconcile"
```

---

## Self-Review

**Spec coverage:**
- §1 `cron_runs` table + retention + cascade → Task 1 (schema, prune, deleteSessionTx, tests for all three).
- §2 Store API (`saveCronRun`/`attachCronRunTask`/`finishCronRun`/`listCronRunsForJob`/`getTask`) → Task 1. Added `listRunningCronRuns` for reconcile (noted as an implementation refinement of §5).
- §3 `submitGoal` `onComplete` → Task 2.
- §4 Scheduler tick rewrite + `fire` contract → Task 3 (steps 3, 4).
- §5 Startup reconcile → Task 3 (step 3c).
- §6 Logging at every path → Task 3 tick/reconcile logs; Task 2 keeps existing error log.

**Placeholder scan:** No TBD/TODO; all code steps show full code. The only "reuse existing helper" note (Task 2 test harness) is unavoidable — it points the implementer at the file's own setup rather than inventing a parallel one, and the assertions are concrete.

**Type consistency:** `StoredCronRun` field names (`jobId`, `taskId`, `triggeredAt`, `endedAt`) are identical across Tasks 1 & 3. `finishCronRun(runId, { status, error, endedAt })` shape matches in store, fake, and caller. `fire` signature `(sessionId, goal, onComplete) => { taskId }` matches `submitGoal`'s new `onComplete` param and return. Reconcile terminal-status set matches `updateTaskStatus`'s `terminalStatuses`.
