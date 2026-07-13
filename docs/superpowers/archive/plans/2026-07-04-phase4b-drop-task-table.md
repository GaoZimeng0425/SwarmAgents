# Phase 4b — Drop the `Task` Table (Implementation Plan)

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Remove `tasks`, `task_events`, `conversation_events`, and the `Task` protocol type — every run's lifecycle + usage lives in `run_events` alone; the 4a dual-write tee is gone; `makeEmit`/`makeRunEmit` converge.

**Architecture:** Layered, app stays green at each commit. (1) Add an in-memory terminal registry + move the terminal listener from `updateTaskStatus` to the emit path (additive — both fire during transition). (2) Switch `wait_for_task` + cron `reconcile` to the registry. (3) Re-point `listSessions`/`getUsageStats` at `run_events.task.usage` (+ add `model` to the event). (4) Drop the dead `conversation_events`. (5) Manager stops creating `Task` rows / calling task store methods (runs become run-events-only). (6) Drop `tasks`/`task_events` + `Task` type + dead store/IPC. (7) Unify `makeEmit`/`makeRunEmit`.

**Tech Stack:** TypeScript, `vitest`, `better-sqlite3`, Electron (test runner), `@swarm/protocol`.

## Global Constraints

- **Spec:** `docs/superpowers/specs/2026-07-04-phase4b-drop-task-table-design.md` (authoritative).
- **Run tests via `npm test`** (Electron node runner). NEVER bare `npx vitest`, NEVER `pnpm rebuild better-sqlite3`. Single-file: `npm --prefix apps/desktop test -- <filter>`.
- **Behavior green at every commit** (full suite, modulo the known pre-existing `gmail.test` htmlBody failure).
- **Typecheck clean at every commit**; delete stale `**/*.tsbuildinfo` before trusting `npx tsc -b`.
- **Comments and commit messages in English.**
- **Scoped formatting:** `npx biome check --write <file>`.
- **Precise `git add <paths>`**, NEVER `git add -A` (turbo typecheck can emit untracked `.js`/`.d.ts` next to sources — `tsc --noEmit` is used here, but stay disciplined).
- **One commit per task**, on `worktree-phase4b-drop-task-table`. Integrate to `develop` via `git rebase develop` + `git merge --ff-only`.
- **History disposable:** no migration of old `tasks`/`task_events`/`conversation_events` rows. Old work history simply won't appear post-4b (accepted per user).

## File Structure

- **Create** `apps/desktop/src/service/session/terminal-registry.ts` — in-memory `Map<runId, TerminalStatus>` + listener; loaded from `run_events` at boot.
- **Modify** `apps/desktop/src/service/conversation/store.ts` — add `getTerminalRunStatuses()`; rewrite `listSessions`/`getUsageStats` over `run_events`; then drop `tasks`/`task_events`/`conversation_events` tables + the `Task`-row API.
- **Modify** `apps/desktop/src/service/session/manager.ts` — own the registry; emit path marks terminal; drop `Task`-row creation in `runWorkTask`/`spawnChild`/`spawnResident`/`pump`/`runTaskTurn`; unify emits.
- **Modify** `apps/desktop/src/service/loop/task-waiters.ts` — `register`/`start` query the registry instead of `getTask`.
- **Modify** `apps/desktop/src/service/cron/scheduler.ts` — `reconcile` queries the registry.
- **Modify** `apps/desktop/src/service/index.ts` — re-wire the terminal listener to the manager (off the store).
- **Modify** `apps/desktop/src/service/session/agent-runner.ts` — add `model` to both `task.usage` emits.
- **Modify** `packages/protocol/src/types/{task,ui}.ts` + `service-client.ts` + `types/service-ipc.ts` — drop `Task` type + `getConversationEvents`/`getSessionTasks` wire; add `model?` to `task.usage`.
- **Modify IPC:** `main/ipc/swarm-ipc.ts`, `preload/index.ts`, `renderer/src/lib/api.ts` — drop `swarm:getSessionTasks`/`swarm:getConversationEvents`.
- **Adapt tests:** `store.test.ts`, `manager.test.ts`, `task-waiters`/`loop` tests, cron tests, `agent-runner.test.ts`, e2e.

---

### Task 1: Terminal registry + emit-path listener (additive)

**Files:**
- Create: `apps/desktop/src/service/session/terminal-registry.ts`.
- Modify: `apps/desktop/src/service/conversation/store.ts` (add `getTerminalRunStatuses()` interface ~`:132` + impl near `getRunEvents`).
- Modify: `apps/desktop/src/service/session/manager.ts` (own the registry; `makeEmit`/`makeRunEmit` mark terminal).
- Test: `apps/desktop/src/service/session/terminal-registry.test.ts`.

**Interfaces:**
- Produces: `createTerminalRegistry(initial)` → `{ isTerminal(runId), getStatus(runId), markTerminal(runId, status), onTerminal(cb) }`; `ConversationStore.getTerminalRunStatuses(): Array<{ runId: string; status: 'completed'|'failed'|'cancelled' }>`; the manager-owned registry is updated by the emit path on every terminal event.

- [ ] **Step 1: Write the failing registry test**

In `terminal-registry.test.ts`:

```ts
import { describe, expect, it, vi } from 'vitest'
import { createTerminalRegistry } from './terminal-registry'

describe('terminal registry', () => {
  it('marks terminal once (idempotent) and fires the listener', () => {
    const cb = vi.fn()
    const reg = createTerminalRegistry([])
    reg.onTerminal(cb)
    reg.markTerminal('r1', 'completed')
    reg.markTerminal('r1', 'failed') // second mark is a no-op (first terminal wins)
    expect(reg.isTerminal('r1')).toBe(true)
    expect(reg.getStatus('r1')).toBe('completed')
    expect(cb).toHaveBeenCalledTimes(1)
    expect(cb).toHaveBeenCalledWith('r1', 'completed')
  })

  it('loads initial statuses from run_events at construction', () => {
    const reg = createTerminalRegistry([
      { runId: 'r1', status: 'completed' },
      { runId: 'r2', status: 'failed' },
    ])
    expect(reg.isTerminal('r1')).toBe(true)
    expect(reg.isTerminal('r2')).toBe(true)
    expect(reg.isTerminal('r3')).toBe(false)
  })
})
```

- [ ] **Step 2: Run to verify it fails**

Run: `npm --prefix apps/desktop test -- terminal-registry`
Expected: FAIL — module `./terminal-registry` not found.

- [ ] **Step 3: Create the registry module**

`apps/desktop/src/service/session/terminal-registry.ts`:

```ts
export type TerminalStatus = 'completed' | 'failed' | 'cancelled'

export type TerminalRun = { runId: string; status: TerminalStatus }

export type TerminalRegistry = {
  isTerminal(runId: string): boolean
  getStatus(runId: string): TerminalStatus | undefined
  /** Record a terminal status. Idempotent — the FIRST terminal status wins and
   *  fires the listener exactly once per runId (so dual-firing during the
   *  updateTaskStatus→emit-path transition can't double-wake a waiter). */
  markTerminal(runId: string, status: TerminalStatus): void
  onTerminal(cb: (runId: string, status: TerminalStatus) => void): void
}

export function createTerminalRegistry(initial: Iterable<TerminalRun>): TerminalRegistry {
  const terminal = new Map<string, TerminalStatus>()
  for (const { runId, status } of initial) terminal.set(runId, status)
  let listener: ((runId: string, status: TerminalStatus) => void) | null = null
  return {
    isTerminal: (runId) => terminal.has(runId),
    getStatus: (runId) => terminal.get(runId),
    markTerminal: (runId, status) => {
      if (terminal.has(runId)) return
      terminal.set(runId, status)
      listener?.(runId, status)
    },
    onTerminal: (cb) => {
      listener = cb
    },
  }
}
```

- [ ] **Step 4: Add the store loader `getTerminalRunStatuses`**

In `store.ts` interface (after `getRunEvents`, ~`:97`):

```ts
/** The last terminal status per runId across ALL sessions (for registry boot). */
getTerminalRunStatuses(): Array<{ runId: string; status: 'completed' | 'failed' | 'cancelled' }>
```

Impl (near `getRunEvents`):

```ts
getTerminalRunStatuses() {
  return (
    db
      .prepare(
        `SELECT run_id AS runId,
           CASE
             WHEN json_extract(event, '$.kind') = 'task.complete' THEN 'completed'
             WHEN json_extract(event, '$.error.code') = 'cancelled' THEN 'cancelled'
             ELSE 'failed'
           END AS status
         FROM run_events
         WHERE json_extract(event, '$.kind') IN ('task.complete', 'task.error')
         GROUP BY run_id
         HAVING id = MAX(id)`
      )
      .all() as Array<{ runId: string; status: 'completed' | 'failed' | 'cancelled' }>
  )
},
```

- [ ] **Step 5: Wire the registry into the manager + emit path**

In `manager.ts`, construct the registry near `seqCounter` (~`:251`):

```ts
const terminalRegistry = createTerminalRegistry(store.getTerminalRunStatuses())
```

Add a terminal-status helper above `makeEmit`:

```ts
// Map a terminal emit's (event, obj) to a TerminalStatus (mirrors applyEvent).
const terminalStatusFor = (
  event: string,
  obj: Record<string, unknown> | undefined
): import('./terminal-registry').TerminalStatus | undefined => {
  if (event === 'task.complete') return 'completed'
  if (event === 'task.error') {
    const code = typeof obj?.error === 'object' && obj.error && 'code' in obj.error
      ? (obj.error as { code: unknown }).code
      : undefined
    return code === 'cancelled' ? 'cancelled' : 'failed'
  }
  return undefined
}
```

In `makeEmit` (after the run_events tee block, before `broadcaster.broadcast`):

```ts
const term = terminalStatusFor(event, obj)
if (taskId && term) terminalRegistry.markTerminal(taskId, term)
```

In `makeRunEmit` (after `store.appendRunEvent(...)`, before `broadcaster.broadcast`):

```ts
const term = terminalStatusFor(event, obj)
if (term) terminalRegistry.markTerminal(runId, term)
```

Expose a registration hook on the returned manager object (near `getRunEvents`):

```ts
/** Register the terminal-status listener (fires once per runId). */
registerTerminalListener(fn: (runId: string, status: import('./terminal-registry').TerminalStatus) => void): void
```

Impl:

```ts
registerTerminalListener(fn) {
  terminalRegistry.onTerminal(fn)
},
```

Add it to the `SessionManager` type too.

- [ ] **Step 6: Run tests + typecheck + format + commit**

```bash
find . -name "*.tsbuildinfo" -delete
npm --prefix apps/desktop test -- terminal-registry manager.test
npm --prefix apps/desktop run typecheck
npx biome check --write apps/desktop/src/service/session/terminal-registry.ts apps/desktop/src/service/session/manager.ts apps/desktop/src/service/conversation/store.ts apps/desktop/src/service/session/terminal-registry.test.ts
git add apps/desktop/src/service/session/terminal-registry.ts apps/desktop/src/service/session/terminal-registry.test.ts apps/desktop/src/service/session/manager.ts apps/desktop/src/service/conversation/store.ts
git commit -m "feat(session): terminal registry loaded from run_events; emit path marks terminal"
```

---

### Task 2: `wait_for_task` + cron `reconcile` use the registry

**Files:**
- Modify: `apps/desktop/src/service/loop/task-waiters.ts` (`register` ~`:48`, `start` ~`:76`).
- Modify: `apps/desktop/src/service/cron/scheduler.ts` (`reconcile` ~`:108`).
- Modify: `apps/desktop/src/service/index.ts` (re-wire the listener off the store ~`:111`).
- Test: `apps/desktop/src/service/loop/task-waiters.integration.test.ts`, `apps/desktop/src/service/tools/wait-for-task.test.ts`, `apps/desktop/src/service/tools/cron.test.ts`.

**Interfaces:**
- Consumes: `TerminalRegistry` (from Task 1) — `isTerminal(runId)` + `getStatus(runId)`.
- Produces: `TaskWaiterDeps` gains `terminalRegistry: TerminalRegistry`; `CronScheduler` deps gain `isRunTerminal: (runId) => boolean` + `runTerminalStatus: (runId) => string | undefined`.

- [ ] **Step 1: Write the failing waiter test (register against the registry, not getTask)**

In `task-waiters.integration.test.ts` (or a new `task-waiters.test.ts` mirroring its fixtures), add a case where the target run has NO Task row but the registry says it's terminal:

```ts
it('register fires immediately when the registry says the run is terminal (no Task row)', () => {
  const delivered: Array<{ address: string; goal: string }> = []
  const registry = createTerminalRegistry([{ runId: 'r-done', status: 'completed' }])
  const svc = createTaskWaiterService({
    store,
    deliver: (_sid, address, goal) => delivered.push({ address, goal }),
    terminalRegistry: registry,
  })
  const out = svc.register({ sessionId: 's', waiterAddress: 'addr', taskId: 'r-done', goal: null })
  expect(out.firedImmediately).toBe(true)
  expect(delivered).toHaveLength(1)
})
```

(If the existing `task-waiters.integration.test.ts` constructs `store` with real Task rows, add a parallel unit test file `task-waiters.test.ts` that uses an in-memory store + the registry. Adapt the fixture to the file's existing pattern.)

- [ ] **Step 2: Run to verify it fails**

Run: `npm --prefix apps/desktop test -- task-waiters`
Expected: FAIL — `createTaskWaiterService` does not accept `terminalRegistry`.

- [ ] **Step 3: Switch `task-waiters.ts` to the registry**

Change `TaskWaiterDeps`:

```ts
import type { TerminalRegistry } from '../session/terminal-registry'

export type TaskWaiterDeps = {
  store: ConversationStore
  deliver: (sessionId: string, address: string, goal: string) => void
  terminalRegistry: TerminalRegistry
}
```

`register` — replace the `store.getTask(taskId)` check with the registry:

```ts
register({ sessionId, waiterAddress, taskId, goal }) {
  const { terminalRegistry } = deps
  if (terminalRegistry.isTerminal(taskId)) {
    const status = terminalRegistry.getStatus(taskId) ?? 'completed'
    log.info({ msg: 'wait_for_task on already-terminal run; firing immediately', taskId, status })
    safeDeliver(sessionId, waiterAddress, goal ?? completionGoal(taskId, status))
    return { id: null, firedImmediately: true }
  }
  const id = ulid()
  store.saveTaskWaiter({ id, sessionId, waiterAddress, taskId, goal, createdAt: Date.now() })
  log.info({ msg: 'waiter registered', id, taskId, waiterAddress })
  return { id, firedImmediately: false }
},
```

(The "task not found" branch is gone — a runId with no terminal status and no live run simply waits, same as a pending run. This is correct post-4b: there's no Task row to be "missing.") Drop the `notFoundGoal` helper.

`start` — same swap:

```ts
start() {
  const { terminalRegistry } = deps
  for (const w of store.listAllTaskWaiters()) {
    if (terminalRegistry.isTerminal(w.taskId)) {
      const status = terminalRegistry.getStatus(w.taskId) ?? 'completed'
      log.info({ msg: 're-arm: waiter target already resolved; firing', id: w.id, taskId: w.taskId })
      safeDeliver(w.sessionId, w.waiterAddress, w.goal ?? completionGoal(w.taskId, status))
      store.deleteTaskWaiter(w.id)
    }
  }
},
```

- [ ] **Step 4: Switch cron `reconcile` to the registry**

`createCronScheduler` deps gain:

```ts
export function createCronScheduler(deps: {
  store: ConversationStore
  fire: (sessionId: string, goal: string, onComplete: (status: string, error?: string) => void) => { taskId: string }
  resolveJobSession?: (fromSessionId: string) => string
  isRunTerminal: (runId: string) => boolean
  runTerminalStatus: (runId: string) => string | undefined
}): CronScheduler {
```

`reconcile` (replace the `store.getTask(run.taskId)` read):

```ts
const reconcile = (): void => {
  for (const run of store.listRunningCronRuns()) {
    if (run.taskId && deps.isRunTerminal(run.taskId)) {
      const status = deps.runTerminalStatus(run.taskId) ?? 'completed'
      store.finishCronRun(run.id, { status, error: null, endedAt: Date.now() })
      log.warn({ msg: 'cron run reconciled', runId: run.id, jobId: run.jobId, status })
    } else {
      store.finishCronRun(run.id, { status: 'interrupted', error: null, endedAt: Date.now() })
      log.warn({ msg: 'cron run reconciled', runId: run.id, jobId: run.jobId, status: 'interrupted' })
    }
  }
}
```

- [ ] **Step 5: Re-wire `service/index.ts` off the store listener**

In `service/index.ts`, change the waiter construction + the listener registration (~`:107-112`):

```ts
const taskWaiters = createTaskWaiterService({
  store,
  deliver: (sessionId, address, goal) => manager.deliverToActor(sessionId, address, goal),
  terminalRegistry: manager.terminalRegistry,
})
manager.registerTerminalListener((runId, status) => taskWaiters.onTaskTerminal(runId, status))
taskWaiters.start()
```

(The manager must expose `terminalRegistry` on its returned object — add it in Task 1's manager return, or expose via a getter. If you didn't expose it in Task 1, add `terminalRegistry` as a public field on the returned manager here.)

And the cron scheduler construction (~`:95`):

```ts
const scheduler = createCronScheduler({
  store,
  fire: (sessionId, goal, onComplete) => manager.submitGoal(sessionId, goal, [], undefined, onComplete),
  resolveJobSession: (fromSessionId) => manager.ensureSystemSession(fromSessionId),
  isRunTerminal: (runId) => manager.terminalRegistry.isTerminal(runId),
  runTerminalStatus: (runId) => manager.terminalRegistry.getStatus(runId) ?? undefined,
})
```

Delete the line `store.setTaskTerminalListener(...)`.

- [ ] **Step 6: Run tests + typecheck + format + commit**

```bash
find . -name "*.tsbuildinfo" -delete
npm --prefix apps/desktop test -- task-waiters wait-for-task cron
npm --prefix apps/desktop run typecheck
npx biome check --write apps/desktop/src/service/loop/task-waiters.ts apps/desktop/src/service/cron/scheduler.ts apps/desktop/src/service/index.ts
git add apps/desktop/src/service/loop/task-waiters.ts apps/desktop/src/service/cron/scheduler.ts apps/desktop/src/service/index.ts
# add any adapted test files too
git commit -m "refactor: wait_for_task + cron reconcile use the terminal registry (off getTask)"
```

---

### Task 3: Usage aggregation from `run_events` + `model` on `task.usage`

**Files:**
- Modify: `apps/desktop/src/service/session/agent-runner.ts` (`:699`, `:925` — add `model`).
- Modify: `packages/protocol/src/types/ui.ts` (`task.usage` variant — add `model?`).
- Modify: `apps/desktop/src/service/conversation/store.ts` (`listSessions` SQL `:676-692`; `getUsageStats` `:926-1000` — rewrite over `run_events`).
- Test: `apps/desktop/src/service/conversation/store.test.ts`, `apps/desktop/src/service/session/agent-runner.test.ts`.

**Interfaces:**
- Produces: `UIEvent.task.usage` gains `model?: string`; `listSessions`/`getUsageStats` derive usage from `run_events` (work + conversation unified — the `convTotals`/`convMessages` split collapses).

- [ ] **Step 1: Add `model?` to the `task.usage` UIEvent variant**

In `packages/protocol/src/types/ui.ts`, the `task.usage` variant (~`:105-115`):

```ts
  | {
      kind: 'task.usage'
      sessionId: string
      taskId: string
      used: ConsumedResources
      contextTokens?: number
      contextWindow?: number
      /** Resolved run model id, for per-model usage attribution (replaces the
       *  pre-4b session-snapshot join). */
      model?: string
      ts: number
      seq?: number
    }
```

- [ ] **Step 2: Emit `model` from the runner**

In `agent-runner.ts` `:699`:

```ts
emit('task.usage', { taskId: task.id, used: snapshotUsed(), contextWindow: model.contextWindow, model: model.id, ts: Date.now() })
```

And `:925-931`:

```ts
emit('task.usage', {
  taskId: task.id,
  used: snapshotUsed(),
  contextTokens: usage ? contextTokens : undefined,
  contextWindow: model.contextWindow,
  model: model.id,
  ts: Date.now(),
})
```

- [ ] **Step 3: Rewrite `listSessions` SQL over `run_events`**

The per-session usage = sum of the LATEST `task.usage` per runId in that session (each run emits usage at every turn boundary; the last is the final snapshot), plus `session_used`. In `store.ts`, replace `stmtListSessions` (`:676-692`):

```ts
const stmtListSessions = db.prepare(
  `SELECT s.id, s.title, s.status, s.pinned, s.sort_order AS sortOrder, s.last_active_at AS lastActiveAt,
          s.cwd, s.permission_mode AS permissionMode, s.execution_mode AS executionMode,
          s.agent_type AS agentType,
          (SELECT COUNT(DISTINCT run_id) FROM run_events re WHERE re.session_id = s.id) AS taskCount,
          ((SELECT COALESCE(SUM(json_extract(re.event, '$.used.tokens')), 0)
              FROM run_events re
              WHERE re.session_id = s.id AND json_extract(re.event, '$.kind') = 'task.usage'
                AND re.id IN (SELECT MAX(id) FROM run_events WHERE session_id = s.id
                              AND json_extract(event, '$.kind') = 'task.usage' GROUP BY run_id))
            + COALESCE(json_extract(s.session_used, '$.tokens'), 0)) AS tokensUsed,
          ((SELECT COALESCE(SUM(json_extract(re.event, '$.used.usdCents')), 0)
              FROM run_events re
              WHERE re.session_id = s.id AND json_extract(re.event, '$.kind') = 'task.usage'
                AND re.id IN (SELECT MAX(id) FROM run_events WHERE session_id = s.id
                              AND json_extract(event, '$.kind') = 'task.usage' GROUP BY run_id))
            + COALESCE(json_extract(s.session_used, '$.usdCents'), 0)) AS usdCents
   FROM sessions s
   WHERE s.status != 'ended'
   ORDER BY s.pinned DESC, s.sort_order ASC`
)
```

(`taskCount` is now "distinct run_id in run_events" — conversation turns + work runs both count, which matches the post-4a world where every turn is a run.)

- [ ] **Step 4: Rewrite `getUsageStats` over `run_events`**

Replace the `totalsRow`/`messagesRow`/`convTotals`/`convMessages`/`modelRows` blocks (`:935-1000`) with run-events queries. Work + conversation are unified in `run_events`, so the conversation-specific splits collapse:

```ts
// Latest task.usage per runId in the range (each run's final snapshot).
const latestUsageIn = (cutoffMs: number) => `
  SELECT json_extract(re.event, '$.used.tokens')    AS tokens,
         json_extract(re.event, '$.used.cacheRead') AS cacheRead,
         json_extract(re.event, '$.used.usdCents') AS usdCents,
         json_extract(re.event, '$.model')          AS model,
         re.session_id                               AS sessionId
  FROM run_events re
  WHERE json_extract(re.event, '$.kind') = 'task.usage'
    AND re.ts >= ?
    AND re.id IN (SELECT MAX(id) FROM run_events WHERE json_extract(event, '$.kind') = 'task.usage' GROUP BY run_id)`

const usageRows = db.prepare(latestUsageIn(cutoff)).all(cutoff) as Array<{
  tokens: number; cacheRead: number; usdCents: number; model: string | null; sessionId: string
}>

// Conversation usage (session_used) still folds into the range totals.
const convTotals = db.prepare(
  `SELECT COALESCE(SUM(json_extract(session_used, '$.tokens')), 0)    AS tokens,
          COALESCE(SUM(json_extract(session_used, '$.cacheRead')), 0) AS cacheRead,
          COALESCE(SUM(json_extract(session_used, '$.usdCents')), 0)  AS usdCents
   FROM sessions WHERE session_used IS NOT NULL AND last_active_at >= ?`
).get(cutoff) as { tokens: number; cacheRead: number; usdCents: number }

// All messages (work + conversation) live in run_events as task.progress with
// an llm.message inner event — one unified count.
const messagesRow = db.prepare(
  `SELECT COUNT(*) AS n FROM run_events
   WHERE ts >= ? AND json_extract(event, '$.kind') = 'task.progress'
     AND json_extract(event, '$.event.kind') = 'llm.message'`
).get(cutoff) as { n: number }

const totals = {
  tokens: usageRows.reduce((s, r) => s + (r.tokens ?? 0), 0) + convTotals.tokens,
  cacheRead: usageRows.reduce((s, r) => s + (r.cacheRead ?? 0), 0) + convTotals.cacheRead,
  usdCents: usageRows.reduce((s, r) => s + (r.usdCents ?? 0), 0) + convTotals.usdCents,
  sessions: new Set(usageRows.map((r) => r.sessionId)).size,
  activeDays: 0, // see below — derived from run_events ts
}
```

Derive `activeDays` + `daily` + `heatmap` + `dailyByModel` + `byModel` from `run_events` rows by their `ts` (the existing `rangeCutoffMs`/`HEATMAP_DAYS` helpers stay). `byModel` groups `usageRows` by `r.model` (fallback `'unknown'`). Keep the existing return shape (`stats.totals`, `stats.byModel`, `stats.daily`, `stats.heatmap`, `stats.dailyByModel`) so callers/renderers are unchanged.

- [ ] **Step 5: Rewrite the store usage tests**

In `store.test.ts`, the fixtures that seed `Task` rows with `used` to assert `listSessions`/`getUsageStats` totals (e.g. `'aggregates per-session token + cost usage in listSessions'`, `'aggregates usage stats over the range'`) now seed `run_events` `task.usage` rows instead:

```ts
// Helper: emit a final task.usage for a run.
const usageEvent = (runId: string, sessionId: string, used: Record<string, number>, model: string, ts: number) => ({
  runId,
  parentRunId: null,
  seq: 1,
  ts,
  event: { kind: 'task.usage', sessionId, taskId: runId, used, model, ts } as never,
})
store.appendRunEvent('ses-u', 'r1', null, usageEvent('r1', 'ses-u', { tokens: 5000, calls: 1, wallMs: 0, usdCents: 6, cacheRead: 0, cacheWrite: 0 }, 'claude-haiku-4-5-20251001', 1) as never)
```

Update the asserted totals to match (they should equal the sum of the latest `task.usage` per run + `session_used`). Drop the sub-agent-zeroed-usage case (sub-agents now emit their own `task.usage`; if a test asserts they don't double-count, keep it by emitting zero usage for the child).

- [ ] **Step 6: Add a runner test asserting `model` is emitted**

In `agent-runner.test.ts` (the existing `'emits task.usage on turn_end'` cases ~`:442`), assert the emitted event carries `model`:

```ts
const usage = emitted.find((e) => e.event === 'task.usage')
expect(usage?.data).toMatchObject({ model: expect.any(String) })
```

- [ ] **Step 7: Run tests + typecheck + format + commit**

```bash
find . -name "*.tsbuildinfo" -delete
npm --prefix apps/desktop test -- store.test agent-runner
npm --prefix apps/desktop run typecheck
npx biome check --write apps/desktop/src/service/session/agent-runner.ts apps/desktop/src/service/conversation/store.ts packages/protocol/src/types/ui.ts apps/desktop/src/service/conversation/store.test.ts apps/desktop/src/service/session/agent-runner.test.ts
git add apps/desktop/src/service/session/agent-runner.ts packages/protocol/src/types/ui.ts apps/desktop/src/service/conversation/store.ts apps/desktop/src/service/conversation/store.test.ts apps/desktop/src/service/session/agent-runner.test.ts
git commit -m "feat(usage): aggregate from run_events task.usage; add model to task.usage"
```

---

### Task 4: Drop `conversation_events` (dead since 4a)

**Files:**
- Modify: `apps/desktop/src/service/conversation/store.ts` (drop schema + `appendConversationEvent`/`getConversationEvents` + the `deleteSession` cascade row).
- Modify: `apps/desktop/src/service/session/manager.ts` (drop the public `getConversationEvents` method + its type).
- Modify: `apps/desktop/src/service/session/seq-counter.ts` (drop the `getConversationEvents` source).
- Modify: `packages/protocol/src/types/{service-ipc,ui}.ts`, `packages/protocol/src/service-client.ts`, `apps/desktop/src/service/ipc/dispatcher.ts`, `apps/desktop/src/main/ipc/swarm-ipc.ts`, `apps/desktop/src/preload/index.ts`, `apps/desktop/src/renderer/src/lib/api.ts` (drop `getConversationEvents` wire end-to-end).
- Test: `apps/desktop/src/service/conversation/store.test.ts` (drop the `conversation events` describe block).

**Interfaces:**
- Produces: `conversation_events` table + its API + IPC are gone; `seq-counter` reads only `getSessionTasks` (for now) + `getRunEvents`.

- [ ] **Step 1: Drop the store table, API, cascade row**

In `store.ts`:
- Delete the `CREATE TABLE IF NOT EXISTS conversation_events ...` block + `idx_conversation_events_session` index.
- Delete `stmtInsertConversationEvent` + `stmtGetConversationEvents`.
- Delete `appendConversationEvent` + `getConversationEvents` from the interface and the returned object.
- In `deleteSessionTx`, delete the row: `db.prepare('DELETE FROM conversation_events WHERE session_id = ?').run(id)`.

- [ ] **Step 2: Drop `getConversationEvents` from manager + seq-counter**

In `manager.ts`, delete the public `getConversationEvents(sessionId)` method + its type entry. In `seq-counter.ts`, drop the `getConversationEvents` param (keep `getSessionTasks` + `getRunEvents`):

```ts
export function createSeqCounter(
  getSessionTasks: (sessionId: string) => Task[],
  getRunEvents: (sessionId: string) => ConversationEventRow[] = () => []
): SeqCounter {
```

Drop the `initMax` loop over `getConversationEvents`. Update the manager's `createSeqCounter` call to pass only `(getSessionTasks, getRunEvents)`.

- [ ] **Step 3: Drop the wire (`getConversationEvents` end-to-end)**

Reverse of 4a Task 4 — delete, in order:
- `packages/protocol/src/types/service-ipc.ts`: `| 'getConversationEvents'` from `ServiceMethod`.
- `packages/protocol/src/types/ui.ts`: `getConversationEvents(...)` from `SwarmBridge.sessions`.
- `packages/protocol/src/service-client.ts`: the type entry + the impl.
- `apps/desktop/src/service/ipc/dispatcher.ts`: the `case 'getConversationEvents'`.
- `apps/desktop/src/main/ipc/swarm-ipc.ts`: the handler + `ipcMain.handle('swarm:getConversationEvents', ...)` + the `removeHandler`.
- `apps/desktop/src/preload/index.ts`: the `getConversationEvents:` entry.
- `apps/desktop/src/renderer/src/lib/api.ts`: the `getConversationEvents:` entry.

- [ ] **Step 4: Drop the `conversation events` describe block in `store.test.ts`**

Delete the three tests (`appendConversationEvent persists...`, `survives a reopen`, `deletes conversation_events when its session is deleted`).

- [ ] **Step 5: Run tests + typecheck + format + commit**

```bash
find . -name "*.tsbuildinfo" -delete
npm --prefix apps/desktop test
npm --prefix apps/desktop run typecheck
npx biome check --write $(grep -rln "appendConversationEvent\|getConversationEvents\|conversation_events" apps/desktop/src packages/protocol/src)
git add $(grep -rln "appendConversationEvent\|getConversationEvents\|conversation_events" apps/desktop/src packages/protocol/src) || true
git add -u apps/desktop/src packages/protocol/src
git commit -m "refactor(store): drop conversation_events table + API + IPC (dead since 4a)"
```

---

### Task 5: Manager stops creating `Task` rows (runs are run-events-only)

**Files:**
- Modify: `apps/desktop/src/service/session/manager.ts` — `runWorkTask` (~`:828`), `spawnChild` (~`:545`), `spawnResident` (~`:343`), `pump` (~`:223`), `runTaskTurn` (~`:738`).
- Test: `apps/desktop/src/service/session/manager.test.ts`, e2e.

**Interfaces:**
- Produces: no `Task` rows are created; `store.saveTask`/`updateTaskStatus`/`markTaskRunning`/`saveTaskUsage`/`saveTaskPlan`/`saveTaskDelegationPlan` are no longer called by the manager (their store methods still exist until Task 6). Runs are surfaced entirely via `run_events` emits (`task.created`/`task.dispatched`/`task.complete`/...).

- [ ] **Step 1: Write the failing test (a work run no longer leaves a Task row)**

In `manager.test.ts`:

```ts
it('a work run reaches terminal in run_events and leaves NO Task row', async () => {
  mockCreate.mockImplementation((deps) =>
    runner(async () => {
      deps.emit('task.complete', { taskId: deps.correlationId, result: { summary: 'built', artifacts: [] }, ts: 1 })
      return runnerReturn('completed', 'built')
    })
  )
  const store = createConversationStore(dbPath)
  const manager = createSessionManager({ store, broadcaster: createBroadcaster(), maxConcurrent: 2, getProvider: () => undefined })
  const { sessionId } = manager.createSession(providerA)
  const out = await (manager as unknown as { __runWorkTaskForTest: (s: string, g: string) => Promise<{ taskId: string }> }).__runWorkTaskForTest(sessionId, 'build it')
  await new Promise((r) => setTimeout(r, 0))
  // Run reached terminal in run_events...
  expect(store.getRunEvents(sessionId).some((r) => r.runId === out.taskId && (r.event as { kind?: string }).kind === 'task.complete')).toBe(true)
  // ...and left no Task row.
  expect(store.getSessionTasks(sessionId)).toHaveLength(0)
  store.close()
})
```

- [ ] **Step 2: Run to verify it fails**

Run: `npm --prefix apps/desktop test -- manager.test`
Expected: FAIL — `getSessionTasks` still returns the work Task row.

- [ ] **Step 3: Strip `Task`-row creation from `runWorkTask`**

In `runWorkTask` (~`:828-874`), delete the `const task: Task = { ... }; store.saveTask(task, sessionId)` block. Keep the `agentDef`/`toolAllowlist`/`budgets`/`attachments` resolution. Replace the explicit `task.created`/`task.dispatched` emits (already routed via `makeEmit` from 4a Task 3) — keep them, but they no longer follow a `saveTask`. The runner is driven by `runId = ulid()` (was `task.id`):

```ts
const runWorkTask = async (sessionId, goal, attachments = [], options = {}, agentDefOverride?) => {
  const session = getOrRehydrate(sessionId)
  if (!session) throw new Error(`session ${sessionId} not found`)
  const resolvedByType = options.agentType ? cfg.agentStore?.get(options.agentType) : undefined
  if (options.agentType && !resolvedByType) log.warn({ msg: 'agentType not found, falling back to default', agentType: options.agentType })
  const agentDef = agentDefOverride ?? resolvedByType ?? DEFAULT_AGENT_DEF
  const toolAllowlist = options.executionMode === 'plan' ? PLAN_READONLY_ALLOWLIST : allowlistForAgent(agentDef)
  const runId = ulid()
  makeEmit(sessionId)('task.created', { taskId: runId, goal, attachments, agentDefId: agentDef.id })
  makeEmit(sessionId)('task.dispatched', { taskId: runId, workerId: '', ts: Date.now() })
  log.info({ msg: 'work run created', sessionId, runId, agentDefId: agentDef.id, goalLen: goal.length })
  const result = await runTaskTurn({ sessionId, runId, agentDef, toolAllowlist, messageSource: 'isolated' })
  return { taskId: runId, result }
}
```

- [ ] **Step 4: Strip `Task`-row creation from `spawnChild` + `spawnResident`**

`spawnChild`: delete the `const childTask: Task = {...}; store.saveTask(childTask, sessionId)`. Emit `task.created` via `makeEmit` with `taskId: childRunId` (a fresh `ulid()` — was `childTask.id`). Keep `parentTaskId`. The runner is driven by `runTaskTurn({ ..., runId: childRunId, ... })`.

`spawnResident`: delete the `const task: Task = {...}; store.saveTask(task, sessionId); store.upsertActor({ ..., lastTaskId: taskId })`. The actor's `lastTaskId` becomes the residency `runId` (still emitted via `makeEmit`'s `task.created`). Keep `runResident(deps, ...)` — its `correlationId` is the runId.

- [ ] **Step 5: Strip `markTaskRunning`/`updateTaskStatus` from `pump` + `runTaskTurn`**

`pump` (~`:223`): delete `store.markTaskRunning(next.taskId)`. The `task.dispatched` emit already makes the renderer mark the turn running (`applyEvent` maps `task.dispatched` → `running`).

`runTaskTurn` (~`:738-818`): delete `store.updateTaskStatus(task.id, status)` (the post-`runner.run()` status update). The runner's translator emits `task.complete`/`task.error` (→ run_events + the terminal registry from Task 1), so status is derived. Update `runTaskTurn`'s signature to take `runId` (not `task: Task`) — it was already heading there (the runner uses `correlationId`); finish the job. Where `runTaskTurn` read fields off `task` (cwd, goal, budget, toolAllowlist, attachments, permissionMode, executionMode), take them as explicit args from the callers (runWorkTask/spawnChild already resolve them).

Also drop `saveSnapshot`'s `store.saveTaskUsage(...)` path — the runner's `task.usage` emit (now carrying `model`, post-Task 3) replaces it. Keep `store.saveAgentSnapshot`/`saveSessionUsage` (those are session-level, not Task-level).

- [ ] **Step 6: Adapt the manager + e2e tests**

Update any test that asserted on Task rows for work/spawn runs (e.g. `conversation-off-task.e2e.test.ts` line `expect(store.getSessionTasks(...).find(...))`) — post-4b there's no Task row; assert via `getRunEvents` instead. The `unified-runs.e2e.test.ts` from 4a already asserts via run_events; relax its `getSessionTasks` dual-write assertion (drop the last `expect(store.getSessionTasks(...))` line — it's no longer dual-written).

- [ ] **Step 7: Run tests + typecheck + format + commit**

```bash
find . -name "*.tsbuildinfo" -delete
npm --prefix apps/desktop test
npm --prefix apps/desktop run typecheck
npx biome check --write apps/desktop/src/service/session/manager.ts apps/desktop/src/service/session/manager.test.ts apps/desktop/src/service/e2e/conversation-off-task.e2e.test.ts apps/desktop/src/service/e2e/unified-runs.e2e.test.ts
git add apps/desktop/src/service/session/manager.ts apps/desktop/src/service/session/manager.test.ts apps/desktop/src/service/e2e/conversation-off-task.e2e.test.ts apps/desktop/src/service/e2e/unified-runs.e2e.test.ts
git commit -m "refactor(session): manager stops creating Task rows; runs live in run_events only"
```

---

### Task 6: Drop `tasks`/`task_events` + the `Task` type + dead store/IPC

**Files:**
- Modify: `apps/desktop/src/service/conversation/store.ts` (drop `tasks`/`task_events` schema + `getTask`/`getSessionTasks`/`saveTask`/`updateTaskStatus`/`markTaskRunning`/`saveTaskUsage`/`saveTaskPlan`/`saveTaskDelegationPlan`/`appendTaskEvent` + the history-backfill migration + cascade rows).
- Modify: `packages/protocol/src/types/task.ts` (drop `Task`, `TaskEvent` if unused — keep if `run_events` references it; see Step 2), `service-client.ts`, `types/service-ipc.ts`, `types/ui.ts`.
- Modify: `apps/desktop/src/service/ipc/dispatcher.ts`, `main/ipc/swarm-ipc.ts`, `preload/index.ts`, `renderer/src/lib/api.ts` (drop `swarm:getSessionTasks`).
- Test: `apps/desktop/src/service/conversation/store.test.ts` (drop Task-fixture tests).

**Interfaces:**
- Produces: the `tasks`/`task_events` tables + `Task` protocol type + all Task-row store methods + `swarm:getSessionTasks` IPC are gone. `task_events`-keyed tests are deleted.

- [ ] **Step 1: Confirm nothing reads `tasks`/`task_events`/`getTask`/`Task`**

```bash
grep -rn "store.getTask\|store.saveTask\|store.updateTaskStatus\|store.markTaskRunning\|store.saveTaskUsage\|store.saveTaskPlan\|store.saveTaskDelegationPlan\|store.appendTaskEvent\|store.getSessionTasks\|: Task\b\|<Task>" apps/desktop/src
```

Expected: only the store's own definitions + tests remain (everything in the manager/cron/waiters migrated in Tasks 1-5). If any caller remains, migrate it first.

- [ ] **Step 2: Drop the `tasks`/`task_events` schema + store methods**

In `store.ts`:
- Delete the `CREATE TABLE IF NOT EXISTS tasks (...)` + `idx_tasks_session` + `CREATE TABLE IF NOT EXISTS task_events (...)` + `idx_task_events_task` blocks.
- Delete every `ALTER TABLE tasks ...` migration + the `history`-backfill block.
- Delete `stmtInsertTask`, `stmtGetTask`, `stmtGetTasks`, `stmtGetTaskEvents`, `stmtCountTaskEvents`, `stmtSetTaskPlan`, `stmtSetTaskDelegationPlan`, `stmtInsertTaskEvent`, `stmtUpdateTaskStatus`, `stmtMarkTaskRunning`, `stmtSetTaskUsage`.
- Delete from the interface + impl: `appendTaskEvent`, `saveTaskPlan`, `saveTaskDelegationPlan`, `saveTask`, `updateTaskStatus`, `markTaskRunning`, `saveTaskUsage`, `getSessionTasks`, `getTask`.
- In `deleteSessionTx`, delete the `tasks` + `task_events` cascade rows.
- Drop `Task`/`TaskEvent`/`TaskStatus`/`TaskResult` imports that are now unused (keep `TaskEvent` ONLY if `run_events`/`UIEvent` still reference it — it does: `task.progress.event: TaskEvent`).

- [ ] **Step 3: Drop `swarm:getSessionTasks` wire end-to-end**

- `types/service-ipc.ts`: `| 'getSessionTasks'`.
- `types/ui.ts`: `SwarmBridge.sessions.getTasks`.
- `service-client.ts`: type + impl.
- `dispatcher.ts`: `case 'getSessionTasks'`.
- `main/ipc/swarm-ipc.ts`: handler + register + dispose.
- `preload/index.ts`: `getTasks:`.
- `renderer/src/lib/api.ts`: `getSessionTasks:`.

- [ ] **Step 4: Drop the `Task` protocol type**

In `packages/protocol/src/types/task.ts`, delete `TaskSchema` + `export type Task = z.infer<...>`. Search for remaining `Task` references (the manager's `getTask`/`runWorkTask`/etc. used `Task` — those were rewritten in Task 5; verify none remain). `SubmitGoalResult`/`TaskResult`/`TaskOptions` are unrelated — keep them.

- [ ] **Step 5: Drop the Task-fixture tests**

In `store.test.ts`, delete every test that builds a `Task` via `taskLiteral`/`mkTask`/inline and asserts via `getSessionTasks`/`getTask` (e.g. `saves and retrieves tasks`, `markTaskRunning`, `interrupts non-terminal tasks`, `closes orphan tool calls`, `backfills legacy tasks.history`, `deletes task_events when its session is deleted`, `round-trips task attachments`, `persists and reloads a task plan`, `saveTaskUsage`, `getTask returns a saved task`). Keep the session/cron/actor/waiter/usage/run-events tests.

- [ ] **Step 6: Run tests + typecheck + format + commit**

```bash
find . -name "*.tsbuildinfo" -delete
npm --prefix apps/desktop test
npm --prefix apps/desktop run typecheck
npx biome check --write apps/desktop/src/service/conversation/store.ts apps/desktop/src/service/conversation/store.test.ts packages/protocol/src/types/task.ts packages/protocol/src/types/service-ipc.ts packages/protocol/src/types/ui.ts packages/protocol/src/service-client.ts apps/desktop/src/service/ipc/dispatcher.ts apps/desktop/src/main/ipc/swarm-ipc.ts apps/desktop/src/preload/index.ts apps/desktop/src/renderer/src/lib/api.ts
git add -u apps/desktop/src packages/protocol/src
git commit -m "refactor: drop tasks/task_events tables + Task type + dead store/IPC"
```

---

### Task 7: (Optional) Unify `makeEmit` / `makeRunEmit`

**Files:**
- Modify: `apps/desktop/src/service/session/manager.ts`.

**Interfaces:**
- Produces: one emit factory `makeRunEmit(sessionId, runId, parentRunId?)`; the `makeEmit(sessionId)` name is gone.

- [ ] **Step 1: Collapse the two factories**

After Task 6, `makeEmit` no longer writes `task_events` — it only broadcasts + writes `run_events` (the 4a tee) + marks terminal. That is identical to `makeRunEmit`. Replace both with one factory keyed by `(sessionId, runId, parentRunId = null)` and update every call site (`runWorkTask`/`spawnChild`/`spawnResident`/`pump`/`runTaskTurn`/`submitGoal`/`createPermissionRegistry`) to pass the runId explicitly. The conversation path already calls `makeRunEmit(sessionId, turnId)`; work/spawn now pass their `runId`.

- [ ] **Step 2: Run tests + typecheck + format + commit**

```bash
find . -name "*.tsbuildinfo" -delete
npm --prefix apps/desktop test
npm --prefix apps/desktop run typecheck
npx biome check --write apps/desktop/src/service/session/manager.ts
git add apps/desktop/src/service/session/manager.ts
git commit -m "refactor(session): unify makeEmit/makeRunEmit into one run-emit factory"
```

---

## Self-Review

**Spec coverage:**
- §2.1 terminal registry + emit-path listener → Task 1. ✓
- §2.1 wait_for_task/cron off `getTask` → Task 2. ✓
- §2.2 usage aggregation from `run_events` + `model` → Task 3. ✓
- §2.3 `conversation_events` drop → Task 4. ✓
- §2.4 `tasks`/`task_events` + `Task` type drop + dead store/IPC → Tasks 5 (behavior: stop creating rows) + 6 (mechanical: drop tables/type/wire). ✓
- §2.5 `makeEmit` dual-write tee removed + unify → Tasks 6 (tee dies with `task_events`) + 7 (unify). ✓
- §3 migration ordering → task order 1→7 (additive consumers first, then drops). ✓
- §4 crash recovery (registry rebuilds from `run_events`; cron reconcile via registry) → Tasks 1 (`getTerminalRunStatuses` boot load) + 2 (reconcile). ✓
- §5 testing (registry unit, waiter/cron off-Task, usage from run_events, table-drop verification, e2e) → each task's test step. ✓
- §6 risks (usage SQL complexity, Task-type sweep, resident Task row, markTaskRunning) → Task 3 (SQL), Task 6 (sweep), Task 5 (resident + markTaskRunning). ✓
- §7 forward pointers (4c: create_task/spawn merge + 3c) — explicitly out of scope; no task touches them. ✓

**Placeholder scan:** No "TBD"/"implement later". Deletion steps name exact symbols; replacement code (registry, manager runId path, usage SQL) is shown in full. The grep-driven sweeps (Tasks 4/6) give the authoritative grep + target names. Task 3's `getUsageStats` rewrite is shown as a representative skeleton (totals/byModel/messages); the `daily`/`heatmap` derivations reuse the existing `rangeCutoffMs`/`HEATMAP_DAYS` helpers — the implementer reduces `run_events` rows by `ts` exactly as today.

**Type consistency:** `TerminalStatus` (Task 1) is used in `task-waiters.ts` + `cron/scheduler.ts` (Task 2). `terminalRegistry` (manager-owned, Task 1) is consumed by `service/index.ts` (Task 2). `runId` (Task 5) replaces `task.id` consistently across `runWorkTask`/`spawnChild`/`spawnResident`/`runTaskTurn`. `task.usage.model` (Task 3) is read by the `byModel` aggregation. `getTerminalRunStatuses()` return shape matches `createTerminalRegistry`'s `initial` arg.

**Green-at-each-commit check:** Task 1 additive (new registry + emit path fires alongside `updateTaskStatus`). Task 2 swaps consumers to the registry (idempotent — `markTerminal` fires once). Task 3 re-points usage SQL (tests rewritten). Task 4 drops a dead table. Task 5 stops creating Task rows (consumers already off the table in 1-3). Task 6 drops the now-unused tables/type/wire. Task 7 is a pure refactor. Each commit leaves the suite green (modulo the known `gmail.test`).

**One risk noted:** Task 3's "latest `task.usage` per runId" SQL uses a correlated `MAX(id) ... GROUP BY run_id` subquery. On a very long history this could be slow; the plan flags the materialized-read-model fallback in the spec (§2.2/§6). Profile on a long-history DB during Task 3 before committing.
