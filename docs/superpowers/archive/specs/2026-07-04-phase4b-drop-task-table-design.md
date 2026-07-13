# Conversation / Task Separation — Phase 4b: Drop the `Task` Table (Core)

- **Date:** 2026-07-04
- **Status:** Design (awaiting user review).
- **Branch:** worktree `phase4b-drop-task-table` off `develop` (`04ee903`, post-4a).
- **Scope:** service (`session/manager.ts` — terminal-signal wiring + `makeEmit` dual-write removal; `loop/task-waiters.ts`; `cron/scheduler.ts`; `service/index.ts`), store (`conversation/store.ts` — drop `tasks`/`task_events`/`conversation_events` + `Task`-row API; usage aggregation from `run_events`), IPC (drop `swarm:getSessionTasks`/`swarm:getConversationEvents`), protocol (drop `Task` type; add `model` to `task.usage`), renderer (drop dead `getSessionTasks`/`getConversationEvents` api).
- **Predecessors:** Phase 4a on `develop` (`04ee903`) — `run_events` is the renderer's only source; work/spawn dual-write `task_events` + `run_events`; conversation writes only `run_events`.
- **Hard guardrail (user-stated, inherited from 4a):** first-principles, best practice, no lazy compat shims for OLD data (history disposable). Old `task_events`/`tasks` rows are NOT migrated — pre-4b work history simply won't appear (acceptable per user).

## 1. Background & goal

Phase 4a made `run_events` the renderer's single source and kept `tasks`/`task_events` as a dual-write scaffold for three non-rendering consumers (the terminal listener, `wait_for_task`, and cron's reconcile). **Phase 4b removes that scaffold** by migrating every remaining consumer off the `Task` row, then dropping the tables and the `Task` type.

Planning surfaced a **fourth consumer the 4a spec under-counted**: usage aggregation. `listSessions` derives `taskCount`/`tokensUsed`/`usdCents` and `getUsageStats` derives per-range / per-model totals from SQL over the `tasks` table (`store.ts:684-688`, `:940`). The `task.usage` UIEvent already lands in `run_events` (the runner emits it at `agent-runner.ts:699/925`, and 4a's tee persists it), so the data exists — 4b re-points aggregation at it.

**Goal:** after 4b, `tasks`, `task_events`, `conversation_events`, and the `Task` protocol type are gone; every run's lifecycle and usage live in `run_events` alone; the dual-write tee is removed; `makeEmit` and `makeRunEmit` collapse to one persist path.

**Non-goals (deferred to 4c):**
- `create_task` / `spawn_sub_agent` tool merge.
- `goal` → `initialMessages` (the "3c" message-seeding change).
- Multi-client wire rename beyond the `task.usage.model` addition.

## 2. Architecture

### 2.1 Terminal signal moves to the emit path + an in-memory registry

Today the terminal listener fires inside `store.updateTaskStatus` (registered at `service/index.ts:111` → `taskWaiters.onTaskTerminal`). `wait_for_task.register/start` and cron's `reconcile` read `store.getTask(id).status` to decide "already terminal?".

4b moves the trigger to the **emit path**: when `makeEmit`/`makeRunEmit` process a terminal UIEvent (`task.complete` / `task.error`) for a `runId`, they (a) record the terminal status in an **in-memory terminal registry** and (b) fire the registered listener (`taskWaiters.onTaskTerminal(runId, status)`). The registry is a `Map<runId, 'completed'|'failed'|'cancelled'>` that:

- **Loads at startup** by scanning `run_events` across all sessions for the last terminal event per `runId` (bounded: one table scan at boot).
- **Updates live** on each terminal emit.
- **Replaces** every `getTask(...).status` check: `wait_for_task.register` and `wait_for_task.start` query it for "already terminal?"; cron's `reconcile` queries it for crash-recovered runs.

The `task_waiters` table **stays** — it stores waiter registrations keyed by `taskId` (= `runId`), with no `tasks`-table FK. `setTaskTerminalListener` moves from the store (fired by `updateTaskStatus`) to the session-manager emit path.

### 2.2 Usage aggregation re-points to `run_events`

`listSessions` and `getUsageStats` aggregate over `run_events.task.usage` rows instead of `tasks`. The `task.usage` UIEvent gains a **`model`** field (the resolved run model) so per-model aggregation works without a Task row. The runner emits `model` alongside `used`/`contextWindow` (it already resolves the model for the request).

Aggregation keeps the current semantics — **latest `task.usage` per run** (each run emits usage at every turn boundary; the last is the final snapshot) — via a SQL subquery (`max(id)` per `taskId` in the session) + `json_extract(event, '$.used.tokens')` etc., plus the `session_used` column for conversation-level usage (unchanged). `getUsageStats.byModel` reads `json_extract(event, '$.model')`.

**Decision — on-demand scan, no projection table:** single-user desktop volume keeps `run_events` per session small; the SQL is indexable on `(session_id, id)` and these are not hot paths (session list + a stats page). If profiling later shows otherwise, a materialized `runs` read-model can be added — but YAGNI for now, and it would reintroduce a second structure to keep in sync.

### 2.3 `conversation_events` dropped (dead since 4a)

After 4a nothing writes `conversation_events` (conversation turns use `makeRunEmit` → `run_events`). 4b removes: the table, `appendConversationEvent`/`getConversationEvents` store API, the manager's public `getConversationEvents`, the `swarm:getConversationEvents` IPC + preload + renderer api + `SwarmBridge.sessions.getConversationEvents`, and the `getConversationEvents` source in `seq-counter` (it already reads `getRunEvents` as the third source from 4a).

### 2.4 `tasks` / `task_events` dropped; `Task` type removed

Once §2.1–§2.2 land, no consumer reads `tasks`/`task_events`. 4b removes:

- **Tables:** `tasks`, `task_events` (+ their schema, prepared statements, the `history`-backfill migration, and the `deleteSession` cascade rows).
- **Store API:** `getTask`, `getSessionTasks`, `saveTask`, `updateTaskStatus`, `markTaskRunning`, `saveTaskUsage`, `saveTaskPlan`, `saveTaskDelegationPlan`, `appendTaskEvent`.
- **Protocol:** the `Task` type and its schema (the runner already uses `correlationId`, not `Task`; the manager returns `{ taskId }`, not `Task`).
- **IPC:** `swarm:getSessionTasks` + preload `getTasks` + renderer `swarmApi.getSessionTasks` + `SwarmBridge.sessions.getTasks`. Post-4a the renderer reads `getRunEvents`, so these are dead in the renderer (only tests + the old adapter used them).
- **Manager call-sites:** `runWorkTask`/`spawnChild`/`spawnResident` stop creating a `Task` row; `pump`/`runTaskTurn` stop calling `markTaskRunning`/`updateTaskStatus` (status is derived from `run_events` via `applyEvent`); the resident `task: Task` construction becomes a run-record header emitted via `makeEmit`.

`plan` / `delegationPlan` are no longer persisted separately — they live as `task.plan` / `task.delegation_plan` UIEvents in `run_events`, and the renderer's `applyEvent` already reduces them.

### 2.5 `makeEmit` dual-write tee removed; `makeEmit`/`makeRunEmit` unify

4a's Task 3 added a `run_events` tee at the top of `makeEmit` (persisting every event with a `taskId`) while keeping the `task_events` writes (`appendTaskEvent`/`saveTaskPlan`/…). With `task_events` gone, those writes go away and **the tee becomes `makeEmit`'s sole persistence path** — identical to `makeRunEmit` (persist a UIEvent to `run_events`, keyed by `runId`, plus broadcast). The two collapse into one emit factory (the only real difference was `makeRunEmit`'s closure `runId` vs `makeEmit` reading `obj.taskId`; post-4b every emit carries `taskId`, so they converge).

## 3. Migration ordering (green at every commit)

1. **Terminal registry + emit-path listener (additive):** add the registry; wire `makeEmit`/`makeRunEmit` to update it + fire the listener on terminal events. `updateTaskStatus` still fires the listener too (idempotent — both paths fire, no double-notify because the waiter is deleted on first wake). → verify tests.
2. **`wait_for_task` + cron `reconcile`** switch from `getTask().status` to the registry. → verify `task-waiters.integration.test` + cron tests.
3. **Usage aggregation** migrates to `run_events` (`listSessions`/`getUsageStats`); runner emits `model` on `task.usage`. → verify store + usage tests (update fixtures that assert SQL-over-tasks shapes).
4. **`conversation_events` dropped** (table + API + IPC + seq-counter source). → verify.
5. **`tasks`/`task_events` dropped + `Task` type + dead store/IPC/manager calls** (§2.4). `makeEmit` loses its `task_events` writes. → verify full suite.
6. **(Optional) Unify `makeEmit`/`makeRunEmit`** into one factory. → verify.

Each step is a commit. Steps 1–3 are additive/parallel-safe; step 5 is the big sweep (mechanical, like the `TaskRecord`→`RunRecord` rename).

## 4. Error handling & crash recovery

- **Terminal registry rebuilds from `run_events` at boot** — a service crash mid-run loses only the in-memory state, which is reconstructable from the persisted terminal events. A run whose terminal event never persisted (crash between last emit and terminal) stays non-terminal in the registry → `wait_for_task.start` / cron `reconcile` treat it as interrupted (matching today's `getTask` → missing/interrupted behavior).
- **cron `reconcile`** queries the registry (populated before `start()` runs) instead of `getTask`; a run with no terminal event is marked `interrupted` (unchanged outcome).
- **`deleteSession` cascade** drops `run_events` for the session (already does) and `task_waiters` (already does); the `tasks`/`task_events`/`conversation_events` cascade rows are deleted with their tables.

## 5. Testing

- **Terminal registry:** new unit tests — loads terminal runIds from `run_events` at init; live emit updates it; `wait_for_task.register` fires immediately for already-terminal runs, registers otherwise.
- **wait_for_task / cron:** existing `task-waiters.integration.test`, `loop/task-waiters`, and cron tests updated to assert off the registry / `run_events` (no `Task` row).
- **Usage aggregation:** `store.test` `listSessions`/`getUsageStats` fixtures rewritten to seed `run_events.task.usage` rows (with `model`) instead of `Task` rows; assert same totals.
- **Table-drop verification:** a test that asserts the store no longer exposes `getTask`/`getSessionTasks`/`appendTaskEvent`/… (type-level + behavioral).
- **e2e:** the 4a `unified-runs.e2e.test` still passes (work + conversation reach terminal in `run_events`); add an assertion that `wait_for_task` resolves against a `run_events`-only world.

## 6. Risks

- **Usage SQL complexity:** "latest `task.usage` per run" needs a correlated subquery or window function. If it proves slow on large histories, fall back to a materialized `runs` read-model (§2.2). Mitigation: profile on a long-history DB before committing step 3.
- **`Task`-type sweep breadth:** `Task` is referenced across store/manager/IPC/tests/renderer-api. Step 5 is a mechanical sweep like the `TaskRecord`→`RunRecord` rename (Task 5 of 4a) — same risk profile, manageable with grep + typecheck gates.
- **Resident actor `Task` row:** `spawnResident` currently creates a `Task` per residency. Step 5 replaces it with a `task.created` emit (the residency is a run on `run_events`). The resident loop's terminal handling (`updateTaskStatus`) becomes a terminal emit. Verify the resident tests.
- **`markTaskRunning` removal:** `pump`/`runTaskTurn` currently stamp `started_at` + `running` so a crash before the first event replays as running. Post-4b, `task.dispatched` on `run_events` serves the same purpose (the renderer's `applyEvent` maps `task.dispatched` → `running`). Verify the "interrupted on restart" path.

## 7. Forward pointers (4c)

- `create_task` / `spawn_sub_agent` merge (the two agent tools converge once the `Task` row is gone).
- `goal` → `initialMessages` (the "3c" message-seeding change).
- These are tool-semantics changes, independent of the table drop; they get their own spec.
