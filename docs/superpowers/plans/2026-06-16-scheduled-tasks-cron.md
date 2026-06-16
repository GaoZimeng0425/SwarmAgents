# Scheduled Tasks (cron) + Agent Tool Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Let the agent schedule goals to run later on a recurring cron schedule; fired jobs submit their goal to the originating session like a normal task.

**Architecture:** A `CronScheduler` service holds live `cron` `CronJob` instances and fires `SessionManager.submitGoal` on tick. Jobs persist in a new `cron_jobs` SQLite table and reload on startup. The agent manages jobs through a new `cron` builtin tool group, which reads the current session id from `ToolRunContext`.

**Tech Stack:** TypeScript, `cron` 4.4.0, `better-sqlite3`, Vitest (run via Electron node).

**Test command:** `npm test -- <path>` (runs Vitest under `ELECTRON_RUN_AS_NODE`). Typecheck: `npm run typecheck:node`.

---

## File Structure

- Create: `src/service/cron-scheduler.ts` — the scheduler (live jobs + lifecycle).
- Create: `src/service/cron-scheduler.test.ts` — scheduler tests.
- Create: `src/service/tools/cron.ts` — the `cron` builtin tool group.
- Create: `src/service/tools/cron.test.ts` — tool tests.
- Modify: `src/service/conversation-store.ts` — `cron_jobs` table + CRUD methods.
- Modify: `src/service/conversation-store.test.ts` — cron_jobs CRUD + cascade tests.
- Modify: `src/service/tools/registry.ts` — add `sessionId` to `ToolRunContext`.
- Modify: `src/service/agent-runner.ts:255-263` — set `sessionId` on `runCtx`.
- Modify: 7 tool test fixtures — add `sessionId` to their `ToolRunContext` literal.
- Modify: `src/service/tools/builtins.ts` — register `cronSpecs` when a scheduler is injected.
- Modify: `src/service/tools/builtins.test.ts` — assert cron tools register with a scheduler.
- Modify: `src/service/index.ts` — construct/start/dispose the scheduler, pass it to builtins.

---

## Task 1: Add `sessionId` to `ToolRunContext`

**Files:**
- Modify: `src/service/tools/registry.ts:9-30`
- Modify: `src/service/agent-runner.ts:255-263`
- Modify: `src/service/tools/{memory,fs,plan,shell,registry,web,builtins}.test.ts`

- [ ] **Step 1: Add the field to the interface**

In `src/service/tools/registry.ts`, add `sessionId` as the first field of `ToolRunContext` (right above `taskId`):

```ts
export interface ToolRunContext {
  /** The session this task runs in. Tools that create session-scoped state (e.g. cron) bind to it. */
  sessionId: string
  taskId: string
```

- [ ] **Step 2: Set it where `runCtx` is built**

In `src/service/agent-runner.ts`, the `runCtx` literal (currently starting at line 255 with `taskId: task.id,`) — add `sessionId` as the first property. `sessionId` is already destructured from `deps` at the top of `run()`:

```ts
        const runCtx: ToolRunContext = {
          sessionId,
          taskId: task.id,
          spawnChild: (goal, suggestedTools, providerKey) => spawnChild(task.id, goal, suggestedTools, providerKey),
```

- [ ] **Step 3: Run typecheck to see the test fixtures break**

Run: `npm run typecheck:node`
Expected: FAIL — each `const ctx: ToolRunContext = { taskId: 't', ... }` literal in the 7 tool test files now errors with "Property 'sessionId' is missing".

- [ ] **Step 4: Add `sessionId` to each test fixture**

In each of these files, add `sessionId: 's',` immediately before the `taskId: 't',` line of the `ToolRunContext` literal:
- `src/service/tools/memory.test.ts:10-11`
- `src/service/tools/fs.test.ts:9-10`
- `src/service/tools/plan.test.ts:6-7`
- `src/service/tools/shell.test.ts:6-7`
- `src/service/tools/registry.test.ts:23-24`
- `src/service/tools/web.test.ts:6-7`
- `src/service/tools/builtins.test.ts:15-16`

Each becomes:

```ts
const ctx: ToolRunContext = {
  sessionId: 's',
  taskId: 't',
  spawnChild: async () => ({ childTaskId: 'c', result: { summary: '', artifacts: [] } }),
```

(`agent-runner.test.ts` builds `AgentRunnerDeps`, not a `ToolRunContext` literal, and already passes `sessionId` — leave it unchanged.)

- [ ] **Step 5: Run typecheck + the affected tests to verify green**

Run: `npm run typecheck:node && npm test -- src/service/tools`
Expected: PASS, no missing-property errors.

- [ ] **Step 6: Commit**

```bash
git add src/service/tools/registry.ts src/service/agent-runner.ts src/service/tools/*.test.ts
git commit -m "feat(tools): expose sessionId on ToolRunContext"
```

---

## Task 2: `cron_jobs` table + store methods

**Files:**
- Modify: `src/service/conversation-store.ts`
- Test: `src/service/conversation-store.test.ts`

- [ ] **Step 1: Write the failing test**

Add to `src/service/conversation-store.test.ts` inside the `describe('ConversationStore', ...)` block:

```ts
  it('saves, lists, touches, and deletes cron jobs', () => {
    const store = createConversationStore(dbPath)
    const provider = { id: 'anthropic' as const, model: 'm', apiKey: 'k' }
    store.createSession('ses-1', provider)

    store.saveCronJob({
      id: 'job-1',
      sessionId: 'ses-1',
      name: 'morning',
      cron: '0 9 * * *',
      goal: 'summarize inbox',
      createdAt: 1000,
      lastRunAt: null,
    })

    expect(store.listCronJobs().length).toBe(1)
    expect(store.listCronJobsForSession('ses-1')[0].goal).toBe('summarize inbox')

    store.touchCronJob('job-1', 2000)
    expect(store.listCronJobs()[0].lastRunAt).toBe(2000)

    store.deleteCronJob('job-1')
    expect(store.listCronJobs().length).toBe(0)
    store.close()
  })

  it('cascades cron job deletion when its session is deleted', () => {
    const store = createConversationStore(dbPath)
    const provider = { id: 'anthropic' as const, model: 'm', apiKey: 'k' }
    store.createSession('ses-1', provider)
    store.saveCronJob({
      id: 'job-1', sessionId: 'ses-1', name: null, cron: '* * * * *',
      goal: 'g', createdAt: 1000, lastRunAt: null,
    })
    store.deleteSession('ses-1')
    expect(store.listCronJobs().length).toBe(0)
    store.close()
  })
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npm test -- src/service/conversation-store.test.ts`
Expected: FAIL — `store.saveCronJob is not a function`.

- [ ] **Step 3: Add the type, table, statements, methods, and cascade**

In `src/service/conversation-store.ts`:

(a) Add the exported type below `StoredSession`:

```ts
export type StoredCronJob = {
  id: string
  sessionId: string
  name: string | null
  cron: string
  goal: string
  createdAt: number
  lastRunAt: number | null
}
```

(b) Add the methods to the `ConversationStore` type (next to `getToolState`):

```ts
  saveCronJob(job: StoredCronJob): void
  listCronJobs(): StoredCronJob[]
  listCronJobsForSession(sessionId: string): StoredCronJob[]
  deleteCronJob(id: string): void
  touchCronJob(id: string, lastRunAt: number): void
```

(c) Add the table to the `db.exec(\`...\`)` schema block (after `tool_state_snapshots`):

```sql
    CREATE TABLE IF NOT EXISTS cron_jobs (
      id           TEXT PRIMARY KEY,
      session_id   TEXT NOT NULL REFERENCES sessions(id),
      name         TEXT,
      cron         TEXT NOT NULL,
      goal         TEXT NOT NULL,
      created_at   INTEGER NOT NULL,
      last_run_at  INTEGER
    );
    CREATE INDEX IF NOT EXISTS idx_cron_jobs_session ON cron_jobs(session_id);
```

(d) Add a row mapper and prepared statements (near the other `stmt*` declarations):

```ts
  const rowToCronJob = (row: Record<string, unknown>): StoredCronJob => ({
    id: row.id as string,
    sessionId: row.session_id as string,
    name: (row.name as string | null) ?? null,
    cron: row.cron as string,
    goal: row.goal as string,
    createdAt: row.created_at as number,
    lastRunAt: (row.last_run_at as number | null) ?? null,
  })

  const stmtInsertCronJob = db.prepare(
    `INSERT OR REPLACE INTO cron_jobs (id, session_id, name, cron, goal, created_at, last_run_at)
     VALUES (?, ?, ?, ?, ?, ?, ?)`
  )
  const stmtListCronJobs = db.prepare('SELECT * FROM cron_jobs')
  const stmtListCronJobsForSession = db.prepare('SELECT * FROM cron_jobs WHERE session_id = ?')
  const stmtDeleteCronJob = db.prepare('DELETE FROM cron_jobs WHERE id = ?')
  const stmtTouchCronJob = db.prepare('UPDATE cron_jobs SET last_run_at = ? WHERE id = ?')
```

(e) Add cron_jobs deletion to `deleteSessionTx` (the FK forbids orphans) — add as the first statement inside the transaction:

```ts
  const deleteSessionTx = db.transaction((id: string) => {
    db.prepare('DELETE FROM cron_jobs WHERE session_id = ?').run(id)
    db.prepare('DELETE FROM tool_state_snapshots WHERE session_id = ?').run(id)
    db.prepare('DELETE FROM tasks WHERE session_id = ?').run(id)
    db.prepare('DELETE FROM sessions WHERE id = ?').run(id)
  })
```

(f) Add the method implementations to the returned object (next to `getToolState`):

```ts
    saveCronJob(job) {
      stmtInsertCronJob.run(
        job.id, job.sessionId, job.name ?? null, job.cron, job.goal, job.createdAt, job.lastRunAt ?? null
      )
    },
    listCronJobs() {
      return (stmtListCronJobs.all() as Record<string, unknown>[]).map(rowToCronJob)
    },
    listCronJobsForSession(sessionId) {
      return (stmtListCronJobsForSession.all(sessionId) as Record<string, unknown>[]).map(rowToCronJob)
    },
    deleteCronJob(id) {
      stmtDeleteCronJob.run(id)
    },
    touchCronJob(id, lastRunAt) {
      stmtTouchCronJob.run(lastRunAt, id)
    },
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npm test -- src/service/conversation-store.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/service/conversation-store.ts src/service/conversation-store.test.ts
git commit -m "feat(store): persist cron jobs with session cascade"
```

---

## Task 3: `CronScheduler` service

**Files:**
- Create: `src/service/cron-scheduler.ts`
- Test: `src/service/cron-scheduler.test.ts`

The scheduler is testable without real timers: tests inject a fake store and a
spy `fire`, then assert that `add` persists + starts a job and that a job whose
session is gone is cleaned up. To exercise the tick deterministically without
waiting on wall-clock, the scheduler exposes the tick logic as the persisted
`CronJob`'s `onTick`; tests drive it by calling the scheduler's `runJobNow(id)`
test seam (a thin wrapper that runs the same onTick body).

- [ ] **Step 1: Write the failing test**

Create `src/service/cron-scheduler.test.ts`:

```ts
import { describe, expect, it, vi } from 'vitest'

import type { ConversationStore, StoredCronJob } from './conversation-store'
import { createCronScheduler } from './cron-scheduler'

function fakeStore(initial: StoredCronJob[] = []) {
  const jobs = new Map(initial.map((j) => [j.id, j]))
  const sessions = new Set(initial.map((j) => j.sessionId))
  return {
    sessions,
    store: {
      saveCronJob: (j: StoredCronJob) => { jobs.set(j.id, j) },
      listCronJobs: () => [...jobs.values()],
      listCronJobsForSession: (sid: string) => [...jobs.values()].filter((j) => j.sessionId === sid),
      deleteCronJob: (id: string) => { jobs.delete(id) },
      touchCronJob: (id: string, ts: number) => { const j = jobs.get(id); if (j) j.lastRunAt = ts },
      getSession: (id: string) => (sessions.has(id) ? ({ id }) : undefined),
    } as unknown as ConversationStore,
    jobs,
  }
}

describe('createCronScheduler', () => {
  it('add persists a job and returns its next run', () => {
    const { store, jobs, sessions } = fakeStore()
    sessions.add('ses-1')
    const fire = vi.fn()
    const sched = createCronScheduler({ store, fire })

    const { id, nextRun } = sched.add({ sessionId: 'ses-1', cron: '0 0 * * *', goal: 'g', name: 'nightly' })
    expect(jobs.get(id)?.goal).toBe('g')
    expect(nextRun).toBeGreaterThan(0)
    sched.dispose()
  })

  it('rejects an invalid cron expression', () => {
    const { store, sessions } = fakeStore()
    sessions.add('ses-1')
    const sched = createCronScheduler({ store, fire: vi.fn() })
    expect(() => sched.add({ sessionId: 'ses-1', cron: 'not-a-cron', goal: 'g' })).toThrow()
    sched.dispose()
  })

  it('fires the goal when the session still exists', () => {
    const { store, sessions } = fakeStore()
    sessions.add('ses-1')
    const fire = vi.fn()
    const sched = createCronScheduler({ store, fire })
    const { id } = sched.add({ sessionId: 'ses-1', cron: '0 0 * * *', goal: 'do it' })
    sched.runJobNow(id)
    expect(fire).toHaveBeenCalledWith('ses-1', 'do it')
    sched.dispose()
  })

  it('cleans up instead of firing when the session is gone', () => {
    const { store, sessions, jobs } = fakeStore()
    sessions.add('ses-1')
    const fire = vi.fn()
    const sched = createCronScheduler({ store, fire })
    const { id } = sched.add({ sessionId: 'ses-1', cron: '0 0 * * *', goal: 'g' })
    sessions.delete('ses-1')
    sched.runJobNow(id)
    expect(fire).not.toHaveBeenCalled()
    expect(jobs.has(id)).toBe(false)
    sched.dispose()
  })

  it('start re-schedules persisted jobs', () => {
    const persisted: StoredCronJob = {
      id: 'job-1', sessionId: 'ses-1', name: null, cron: '0 0 * * *',
      goal: 'reload me', createdAt: 1, lastRunAt: null,
    }
    const { store, sessions } = fakeStore([persisted])
    sessions.add('ses-1')
    const fire = vi.fn()
    const sched = createCronScheduler({ store, fire })
    sched.start()
    expect(sched.listForSession('ses-1').map((j) => j.id)).toContain('job-1')
    sched.runJobNow('job-1')
    expect(fire).toHaveBeenCalledWith('ses-1', 'reload me')
    sched.dispose()
  })
})
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npm test -- src/service/cron-scheduler.test.ts`
Expected: FAIL — cannot find module `./cron-scheduler`.

- [ ] **Step 3: Implement the scheduler**

Create `src/service/cron-scheduler.ts`:

```ts
import { createLogger } from '@shared/logger'
import { CronJob } from 'cron'
import { ulid } from 'ulid'

import type { ConversationStore, StoredCronJob } from './conversation-store'

const log = createLogger({ process: 'service' }).child({ component: 'cron-scheduler' })

export type CronScheduler = {
  /** Create + persist + start a job. Throws on an invalid cron expression. */
  add(input: { sessionId: string; cron: string; goal: string; name?: string }): { id: string; nextRun: number }
  remove(id: string): boolean
  listForSession(sessionId: string): Array<StoredCronJob & { nextRun: number | null }>
  /** Re-schedule every persisted job. Call once on startup. */
  start(): void
  /** Test seam: run a scheduled job's tick body immediately. */
  runJobNow(id: string): void
  dispose(): void
}

export function createCronScheduler(deps: {
  store: ConversationStore
  fire: (sessionId: string, goal: string) => void
}): CronScheduler {
  const { store, fire } = deps
  const live = new Map<string, CronJob>()

  // The body that runs each time a job ticks. Lazy-cleans jobs whose session
  // was deleted; otherwise records the run and fires the goal.
  const tick = (job: StoredCronJob): void => {
    try {
      if (!store.getSession(job.sessionId)) {
        remove(job.id)
        return
      }
      store.touchCronJob(job.id, Date.now())
      fire(job.sessionId, job.goal)
    } catch (err) {
      log.error({ msg: 'cron tick failed', id: job.id, err: err instanceof Error ? err.message : String(err) })
    }
  }

  // Construct + start a CronJob for an already-persisted record. Throws on a
  // bad expression (CronJob validates the cronTime in its constructor).
  const schedule = (job: StoredCronJob): CronJob => {
    const cj = CronJob.from({
      cronTime: job.cron,
      onTick: () => tick(job),
      start: true,
      waitForCompletion: true,
    })
    live.set(job.id, cj)
    return cj
  }

  function remove(id: string): boolean {
    const cj = live.get(id)
    if (cj) {
      void cj.stop()
      live.delete(id)
    }
    store.deleteCronJob(id)
    return !!cj
  }

  return {
    add({ sessionId, cron, goal, name }) {
      const job: StoredCronJob = {
        id: ulid(),
        sessionId,
        name: name ?? null,
        cron,
        goal,
        createdAt: Date.now(),
        lastRunAt: null,
      }
      // Validate + start BEFORE persisting so a bad expression never lands a row.
      const cj = schedule(job)
      store.saveCronJob(job)
      return { id: job.id, nextRun: cj.nextDate().toMillis() }
    },
    remove,
    listForSession(sessionId) {
      return store.listCronJobsForSession(sessionId).map((j) => ({
        ...j,
        nextRun: live.get(j.id)?.nextDate().toMillis() ?? null,
      }))
    },
    start() {
      for (const job of store.listCronJobs()) {
        try {
          schedule(job)
        } catch (err) {
          log.error({ msg: 'failed to reschedule cron job', id: job.id, err: String(err) })
        }
      }
    },
    runJobNow(id) {
      const stored = store.listCronJobs().find((j) => j.id === id)
      if (stored) tick(stored)
    },
    dispose() {
      for (const cj of live.values()) void cj.stop()
      live.clear()
    },
  }
}
```

Note: `add` calls `schedule(job)` (which throws on a bad expression) **before** `store.saveCronJob`, so an invalid expression never persists a row.

- [ ] **Step 4: Run test to verify it passes**

Run: `npm test -- src/service/cron-scheduler.test.ts`
Expected: PASS (5 tests).

- [ ] **Step 5: Commit**

```bash
git add src/service/cron-scheduler.ts src/service/cron-scheduler.test.ts
git commit -m "feat(service): add CronScheduler"
```

---

## Task 4: `cron` builtin tool group

**Files:**
- Create: `src/service/tools/cron.ts`
- Test: `src/service/tools/cron.test.ts`

- [ ] **Step 1: Write the failing test**

Create `src/service/tools/cron.test.ts`:

```ts
import { describe, expect, it, vi } from 'vitest'

import type { CronScheduler } from '../cron-scheduler'
import { cronSpecs } from './cron'
import type { ToolRunContext } from './registry'

const ctx: ToolRunContext = {
  sessionId: 'ses-1',
  taskId: 't',
  spawnChild: async () => ({ childTaskId: 'c', result: { summary: '', artifacts: [] } }),
  send: () => undefined,
  requestPermission: async () => 'grant',
  askUser: async () => '',
}

function fakeScheduler(): CronScheduler {
  return {
    add: vi.fn(() => ({ id: 'job-1', nextRun: 1_000_000 })),
    remove: vi.fn(() => true),
    listForSession: vi.fn(() => [
      { id: 'job-1', sessionId: 'ses-1', name: 'nightly', cron: '0 0 * * *', goal: 'g', createdAt: 1, lastRunAt: null, nextRun: 1_000_000 },
    ]),
    start: vi.fn(),
    runJobNow: vi.fn(),
    dispose: vi.fn(),
  }
}

const text = (r: { content: { type: string; text: string }[] }) => r.content.map((c) => c.text).join('')

describe('cronSpecs', () => {
  it('exposes schedule/list/cancel under the cron group with expected risk', () => {
    const specs = cronSpecs(fakeScheduler())
    expect(specs.map((s) => `${s.group}.${s.name}`).sort()).toEqual([
      'cron.cancel_scheduled_task',
      'cron.list_scheduled_tasks',
      'cron.schedule_task',
    ])
    const risk = (n: string) => specs.find((s) => s.name === n)!.risk
    expect(risk('schedule_task')).toBe('medium')
    expect(risk('list_scheduled_tasks')).toBe('low')
    expect(risk('cancel_scheduled_task')).toBe('low')
  })

  it('schedule_task binds to ctx.sessionId and returns the job id', async () => {
    const sched = fakeScheduler()
    const tool = cronSpecs(sched).find((s) => s.name === 'schedule_task')!.build(ctx)
    const res = await tool.execute('id', { cron: '0 9 * * *', goal: 'summarize inbox', name: 'am' })
    expect(sched.add).toHaveBeenCalledWith({ sessionId: 'ses-1', cron: '0 9 * * *', goal: 'summarize inbox', name: 'am' })
    expect(text(res as never)).toContain('job-1')
  })

  it('schedule_task returns an error result on an invalid expression', async () => {
    const sched = fakeScheduler()
    ;(sched.add as ReturnType<typeof vi.fn>).mockImplementation(() => { throw new Error('bad cron') })
    const tool = cronSpecs(sched).find((s) => s.name === 'schedule_task')!.build(ctx)
    const res = await tool.execute('id', { cron: 'nope', goal: 'g' })
    expect(text(res as never)).toContain('error')
  })

  it('list_scheduled_tasks lists jobs for the session', async () => {
    const sched = fakeScheduler()
    const tool = cronSpecs(sched).find((s) => s.name === 'list_scheduled_tasks')!.build(ctx)
    const res = await tool.execute('id', {})
    expect(sched.listForSession).toHaveBeenCalledWith('ses-1')
    expect(text(res as never)).toContain('nightly')
  })

  it('cancel_scheduled_task removes by id', async () => {
    const sched = fakeScheduler()
    const tool = cronSpecs(sched).find((s) => s.name === 'cancel_scheduled_task')!.build(ctx)
    const res = await tool.execute('id', { id: 'job-1' })
    expect(sched.remove).toHaveBeenCalledWith('job-1')
    expect(text(res as never)).toContain('cancelled')
  })
})
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npm test -- src/service/tools/cron.test.ts`
Expected: FAIL — cannot find module `./cron`.

- [ ] **Step 3: Implement the tool group**

Create `src/service/tools/cron.ts`:

```ts
import type { AgentTool } from '@earendil-works/pi-agent-core'
import { Type } from '@earendil-works/pi-ai'

import type { CronScheduler } from '../cron-scheduler'
import type { ToolRunContext, ToolSpec } from './registry'

type Result = { content: [{ type: 'text'; text: string }]; details: Record<string, unknown> }
const ok = (text: string, details: Record<string, unknown> = {}): Result => ({
  content: [{ type: 'text', text }],
  details,
})
const err = (message: string): Result => ok(`error: ${message}`, { error: message })

const ScheduleParams = Type.Object({
  cron: Type.String({
    description: 'Standard 5- or 6-field cron expression, e.g. "0 9 * * *" for 9am daily.',
  }),
  goal: Type.String({ description: 'The goal to run on each fire, as if typed into this session.' }),
  name: Type.Optional(Type.String({ description: 'Optional human-readable label for the job.' })),
})

const CancelParams = Type.Object({
  id: Type.String({ description: 'Id of the scheduled task to cancel (from list_scheduled_tasks).' }),
})

function scheduleTool(scheduler: CronScheduler, ctx: ToolRunContext): AgentTool {
  return {
    name: 'schedule_task',
    label: 'Schedule task',
    description:
      'Schedule a goal to run automatically on a recurring cron schedule in this session. Returns the job id and next run time. Use list_scheduled_tasks/cancel_scheduled_task to manage jobs.',
    parameters: ScheduleParams,
    execute: async (_id: string, params: unknown) => {
      const p = params as { cron: string; goal: string; name?: string }
      if (!p.cron) return err('cron is required')
      if (!p.goal) return err('goal is required')
      try {
        const { id, nextRun } = scheduler.add({
          sessionId: ctx.sessionId,
          cron: p.cron,
          goal: p.goal,
          name: p.name,
        })
        return ok(`scheduled "${p.name ?? p.goal.slice(0, 40)}" (id ${id}); next run ${new Date(nextRun).toISOString()}`, {
          id,
          nextRun,
        })
      } catch (e) {
        return err(`invalid cron expression "${p.cron}": ${e instanceof Error ? e.message : String(e)}`)
      }
    },
  }
}

function listTool(scheduler: CronScheduler, ctx: ToolRunContext): AgentTool {
  return {
    name: 'list_scheduled_tasks',
    label: 'List scheduled tasks',
    description: 'List the scheduled (cron) tasks for this session.',
    parameters: Type.Object({}),
    execute: async () => {
      const jobs = scheduler.listForSession(ctx.sessionId)
      if (jobs.length === 0) return ok('no scheduled tasks', { count: 0 })
      const lines = jobs.map(
        (j) =>
          `- [${j.id}] ${j.name ?? '(unnamed)'} | ${j.cron} | next ${j.nextRun ? new Date(j.nextRun).toISOString() : 'n/a'} | ${j.goal}`
      )
      return ok(lines.join('\n'), { count: jobs.length })
    },
  }
}

function cancelTool(scheduler: CronScheduler): AgentTool {
  return {
    name: 'cancel_scheduled_task',
    label: 'Cancel scheduled task',
    description: 'Cancel and remove a scheduled task by its id.',
    parameters: CancelParams,
    execute: async (_id: string, params: unknown) => {
      const p = params as { id: string }
      if (!p.id) return err('id is required')
      const existed = scheduler.remove(p.id)
      return ok(existed ? `cancelled ${p.id}` : `no scheduled task ${p.id}`, { removed: existed, id: p.id })
    },
  }
}

// schedule_task is medium risk: it arms future autonomous agent runs, so it
// goes through the central permission prompt (cf. spawn_sub_agent). list and
// cancel are low risk — read/cleanup of internal bookkeeping.
export function cronSpecs(scheduler: CronScheduler): ToolSpec[] {
  return [
    {
      group: 'cron',
      name: 'schedule_task',
      risk: 'medium' as const,
      source: 'builtin' as const,
      build: (ctx) => scheduleTool(scheduler, ctx),
    },
    {
      group: 'cron',
      name: 'list_scheduled_tasks',
      risk: 'low' as const,
      source: 'builtin' as const,
      build: (ctx) => listTool(scheduler, ctx),
    },
    {
      group: 'cron',
      name: 'cancel_scheduled_task',
      risk: 'low' as const,
      source: 'builtin' as const,
      build: () => cancelTool(scheduler),
    },
  ]
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npm test -- src/service/tools/cron.test.ts`
Expected: PASS (5 tests).

- [ ] **Step 5: Commit**

```bash
git add src/service/tools/cron.ts src/service/tools/cron.test.ts
git commit -m "feat(tools): add cron tool group (schedule/list/cancel)"
```

---

## Task 5: Wire the scheduler into builtins + service entry

**Files:**
- Modify: `src/service/tools/builtins.ts`
- Modify: `src/service/tools/builtins.test.ts`
- Modify: `src/service/index.ts`

- [ ] **Step 1: Write the failing test**

Add to `src/service/tools/builtins.test.ts`:

```ts
import type { CronScheduler } from '../cron-scheduler'

const fakeScheduler = {
  add: () => ({ id: 'x', nextRun: 0 }),
  remove: () => true,
  listForSession: () => [],
  start: () => undefined,
  runJobNow: () => undefined,
  dispose: () => undefined,
} as CronScheduler

describe('registerBuiltinTools with a scheduler', () => {
  it('registers the cron tools when a scheduler is injected', () => {
    const r = createToolRegistry()
    registerBuiltinTools(r, { scheduler: fakeScheduler })
    const ids = r.list().map((s) => `${s.group}.${s.name}`)
    expect(ids).toContain('cron.schedule_task')
    expect(ids).toContain('cron.list_scheduled_tasks')
    expect(ids).toContain('cron.cancel_scheduled_task')
  })

  it('omits the cron tools when no scheduler is injected', () => {
    const r = createToolRegistry()
    registerBuiltinTools(r)
    expect(r.list().some((s) => s.group === 'cron')).toBe(false)
  })
})
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npm test -- src/service/tools/builtins.test.ts`
Expected: FAIL — `registerBuiltinTools` does not accept `scheduler` / cron tools not registered.

- [ ] **Step 3: Wire the scheduler into builtins**

In `src/service/tools/builtins.ts`:

(a) Add imports:

```ts
import type { CronScheduler } from '../cron-scheduler'
import { cronSpecs } from './cron'
```

(b) Extend the `deps` parameter type and register cron specs (mirroring the `skillStore` branch):

```ts
export function registerBuiltinTools(
  registry: ToolRegistry,
  deps?: { memoryStore?: MemoryStore; skillStore?: SkillStore; scheduler?: CronScheduler }
): void {
  for (const spec of peekabooSpecs()) registry.register(spec)
  registry.register(spawnAgentSpec())
  registry.register(updatePlanSpec())
  registry.register(askUserSpec())
  registry.register(shellSpec())
  registry.register(webFetchSpec())
  for (const spec of fsSpecs()) registry.register(spec)
  if (deps?.memoryStore) for (const spec of memorySpecs(deps.memoryStore)) registry.register(spec)
  if (deps?.skillStore) registry.register(useSkillSpec(deps.skillStore))
  // Cron tools need the scheduler; registered only when one is injected.
  if (deps?.scheduler) for (const spec of cronSpecs(deps.scheduler)) registry.register(spec)
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npm test -- src/service/tools/builtins.test.ts`
Expected: PASS (existing tests + 2 new ones).

- [ ] **Step 5: Wire into the service entry point**

The scheduler needs `manager` (to call `submitGoal`), but `registerBuiltinTools`
is currently called at line 42 — before `manager` is constructed at lines 46-53.
The tool registry is only *consumed* lazily by `manager` at task-resolution time,
so it is safe to move the `registerBuiltinTools` call to after `manager` and the
scheduler exist. Make these three edits to `src/service/index.ts`:

(a) Add the import (next to the other `./` service imports):

```ts
import { createCronScheduler } from './cron-scheduler'
```

(b) Remove the existing registration call at line 42:

```ts
registerBuiltinTools(toolRegistry, { memoryStore, skillStore })
```

Keep `const toolRegistry = createToolRegistry()` on line 41. Then, immediately
after the `const manager = createSessionManager({...})` block (line 53), insert:

```ts
const scheduler = createCronScheduler({
  store,
  fire: (sessionId, goal) => {
    manager.submitGoal(sessionId, goal)
  },
})
registerBuiltinTools(toolRegistry, { memoryStore, skillStore, scheduler })
scheduler.start()
```

Resulting order: `toolRegistry` created → `store`/`memoryStore`/`skillStore`
created → `manager` created → `scheduler` created → `registerBuiltinTools(... { memoryStore, skillStore, scheduler })`
→ `scheduler.start()`. `mcpManager` (created after) still receives the same
`toolRegistry`.

(c) Add disposal to the existing `process.on('exit', ...)` handler:

```ts
process.on('exit', () => {
  scheduler.dispose()
  void mcpManager.dispose()
  store.close()
})
```

- [ ] **Step 6: Typecheck and run the full service suite**

Run: `npm run typecheck:node && npm test -- src/service`
Expected: PASS.

- [ ] **Step 7: Commit**

```bash
git add src/service/tools/builtins.ts src/service/tools/builtins.test.ts src/service/index.ts
git commit -m "feat(service): wire CronScheduler into builtins and service entry"
```

---

## Final verification

- [ ] **Run the whole test suite + typecheck**

Run: `npm run typecheck:node && npm test`
Expected: all green.

- [ ] **Manual smoke (optional, via run-desktop skill):** Launch the app, ask the
  agent "schedule a task to run every minute that says hello", confirm the
  permission prompt fires (medium risk), then `list_scheduled_tasks`, then cancel
  it. Verify a `cron_jobs` row appears and disappears in the service DB.
