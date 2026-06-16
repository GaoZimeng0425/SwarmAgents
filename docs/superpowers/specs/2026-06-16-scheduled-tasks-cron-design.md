# Scheduled Tasks (cron) + Agent Tool — Design

**Date:** 2026-06-16
**Status:** Approved design, pending spec review

## Goal

Let the agent schedule goals to run later on a recurring cron schedule. When a
job fires, its stored goal is submitted to the **originating session** as a new
task — the same path a user-typed goal takes — so results appear in that
conversation and the agent keeps continuity across runs.

Surface area is **agent-tool-only**: no renderer UI, no new dispatcher RPC.

## Decisions

- **Fire target:** the session that created the job (`submitGoal` on it). A job
  whose session no longer exists is cleaned up lazily on its next fire.
- **Recurrence model:** raw standard cron expressions only (what `cron` 4.4.0
  takes directly). No one-shot dates, no timezone config (system tz).
- **Persistence:** new `cron_jobs` table in the existing SQLite store, FK to
  `sessions(id)`. Jobs reload and re-schedule on service startup.

## Components

### 1. `cron_jobs` table (`src/service/conversation-store.ts`)

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

New `ConversationStore` methods:
- `saveCronJob(job: StoredCronJob): void` (INSERT OR REPLACE)
- `listCronJobs(): StoredCronJob[]` (all jobs, for startup reload)
- `listCronJobsForSession(sessionId: string): StoredCronJob[]`
- `deleteCronJob(id: string): void`
- `touchCronJob(id: string, lastRunAt: number): void`

`deleteSessionTx` also deletes the session's `cron_jobs` rows (FK requires it).

`StoredCronJob = { id, sessionId, name, cron, goal, createdAt, lastRunAt }`,
defined in `conversation-store.ts` next to `StoredSession`.

### 2. `CronScheduler` (`src/service/cron-scheduler.ts`)

```ts
type CronScheduler = {
  /** Create + persist + start a job. Throws on an invalid cron expression. */
  add(input: { sessionId: string; cron: string; goal: string; name?: string }):
    { id: string; nextRun: number }
  remove(id: string): boolean
  listForSession(sessionId: string): Array<StoredCronJob & { nextRun: number | null }>
  /** Re-schedule all persisted jobs. Called once on startup. */
  start(): void
  dispose(): void
}

createCronScheduler(deps: {
  store: ConversationStore
  fire(sessionId: string, goal: string): void   // wraps manager.submitGoal
}): CronScheduler
```

- Holds `Map<jobId, CronJob>`.
- `add`: validate by constructing the `CronJob` (throws on bad expression →
  surfaced to the tool); persist via `store.saveCronJob`; start it.
- onTick (the fired callback): if the session no longer exists in the store →
  `remove(id)` and return (lazy cleanup); else `store.touchCronJob(id, now)` and
  `fire(sessionId, goal)`.
- Built with `waitForCompletion: true` so a slow `submitGoal` enqueue cannot
  overlap its own next tick. `fire` itself returns immediately (submitGoal
  queues), so this is cheap insurance.
- `nextRun` from `job.nextDate().toMillis()`.

### 3. `cron` builtin tool group (`src/service/tools/cron.ts`)

Three tools, registered like `memory`/`skill` (closure over the scheduler at
registration; `build()` reads `ctx.sessionId`):

| Tool | Params | Risk | Behavior |
|---|---|---|---|
| `schedule_task` | `cron` (string), `goal` (string), `name?` (string) | `medium` | Validates + creates the job for `ctx.sessionId`. Returns id + next run ISO time. Invalid cron → `error: ...` result, no throw. |
| `list_scheduled_tasks` | — | `low` | Lists jobs for `ctx.sessionId` (id, name, cron, goal, next run). |
| `cancel_scheduled_task` | `id` (string) | `low` | Removes the job; reports whether it existed. |

`schedule_task` is `medium` because it arms future autonomous agent runs, so it
goes through the central permission prompt — consistent with `spawn_sub_agent`.

### 4. `ToolRunContext.sessionId` (`src/service/tools/registry.ts`, `agent-runner.ts`)

Add `sessionId: string` to `ToolRunContext`. `agent-runner.ts` already has
`sessionId` in `deps`; set it when building `runCtx`. The cron tool reads it to
know which session to bind a job to. No other tool is affected.

### 5. Wiring (`src/service/index.ts`)

- `const scheduler = createCronScheduler({ store, fire: (sid, goal) => manager.submitGoal(sid, goal) })`
- Pass `scheduler` into `registerBuiltinTools(toolRegistry, { memoryStore, skillStore, scheduler })`
  → `builtins.ts` registers `cronSpecs(scheduler)` when `deps.scheduler` is present.
- `scheduler.start()` after the manager is constructed (re-schedules persisted jobs).
- `scheduler.dispose()` in the `process.on('exit')` handler.

`createSessionManager`'s `buildDefaultRegistry` (test/script fallback) does not
get a scheduler, so the cron tools are simply absent there — matching how
`memoryStore`/`skillStore` are optional.

## Data flow (a fire)

```
CronJob tick
  → scheduler onTick(jobId)
      session still exists? ── no ──→ remove(jobId)   (lazy cleanup)
              │ yes
      store.touchCronJob(jobId, now)
      fire(sessionId, goal)  ──→  manager.submitGoal(sessionId, goal)
              → enqueues on session.queue → normal agent run → events broadcast
```

## Error handling

- Invalid cron expression: caught in `schedule_task`, returned as an `error:`
  tool result (the agent can correct it). Never throws out of the tool.
- Deleted session: lazy cleanup on next fire; also removed eagerly via
  `deleteSessionTx`.
- `submitGoal` throwing inside onTick: caught and logged in the scheduler so one
  bad fire can't kill the timer.

## Testing

- `cron-scheduler.test.ts`: add → persisted + `fire` invoked on tick (drive with
  a near-future expression or by invoking the stored onTick directly with a fake
  store + spy `fire`); remove stops it; startup reload schedules persisted jobs;
  deleted-session fire triggers cleanup instead of firing.
- `cron.test.ts` (tools): `schedule_task` validates and calls `scheduler.add`
  with `ctx.sessionId`; invalid expression returns an error result; `list` and
  `cancel` delegate correctly. Mirrors `memory.test.ts` structure.
- `conversation-store.test.ts`: cron_jobs CRUD + cascade delete with the session.

## Non-goals

- No renderer UI for viewing/managing jobs.
- No one-shot/at-date scheduling, no per-job timezone, no pause/resume.
- No new dispatcher RPC method.

## Known limitations (accepted for this scope)

- **Unattended medium/high tools.** When a job fires while no renderer is
  connected, any `medium`/`high`-risk tool the fired goal invokes broadcasts a
  permission request to nobody and defaults to `deny` after the 30s timeout. So
  unattended scheduled goals reliably run only `low`-risk tools. (Consistent
  with the existing permission gate; revisit if autonomous runs need it.)
- **No missed-tick catch-up.** `CronJob` schedules forward only — a job that was
  due while the app was closed does not fire on `scheduler.start()`. Expected for
  raw cron semantics.
