# Conversation / Task Separation — Phase 4a: Unified Runs (Fully Derived, Task Table Removed)

- **Date:** 2026-07-03
- **Status:** Design (pending review) — revises the earlier Option-1 (manifest) sketch; the user chose **fully derived** (no Task table) on first-principles grounds.
- **Branch:** worktree `phase4a-unified-runs` off `develop` (`34249ad`).
- **Scope (large — bigger than 3b):** service (`manager.ts`, `conversation/store.ts`, `agent-runner.ts` emit wiring, resident/cron/gmail run paths), protocol (`UIEvent` gains `parentRunId`; the `Task` type is removed), IPC (`getSessionTasks` → `getRunEvents`), renderer (`replay.ts`, `use-tasks.ts`, `apply-event.ts`, `build-timeline-items.ts`, `task-segments.ts`, `TaskRecord`→`RunRecord`, `tasksToRecords` removed). Schema: rename `conversation_events` → `run_events` (+ `parent_run_id`); **drop the `tasks` and `task_events` tables**.
- **Predecessors:** Phases 1–3b on `develop`.
- **Hard guardrail (user-stated, first-principles):** "task is agent-authored data, not an execution unit; the transcript is conversation-only + work artifacts. No historical migration — old history is disposable. Best practice, don't be lazy." This spec removes the `Task` persistence entity entirely: a single session run-event stream (`run_events`) is the only source of truth, and every run view is derived from it. No denormalized manifest table, no compat shim.

## 1. Background & goal

After 3a/3b there are two event streams (`task_events` for work/delegation, `conversation_events` for conversation) and `Task` rows that anchor persistence, status, cancel, and UI for work/delegation. The runner is already decoupled from `Task` (Phase 1). The remaining "Task-as-execution-unit" is pure persistence/UI anchoring — and the `Task` row itself is a denormalized projection of data already in the events (goal/status/agentDefId/plan/used are all derivable from `task.created`/`task.plan`/`task.usage`/terminal events).

**Phase 4a goes first-principles: ONE session run-event stream, no Task table.** Every run — conversation turn, `create_task` work, spawned sub-agent, cron-fired run, resident actor — emits its full lifecycle to `run_events`, keyed by `runId` (+ `parentRunId` for spawns). The `tasks` and `task_events` tables are **dropped**. The renderer's `RunRecord` (renamed from `TaskRecord`) is **derived entirely from `run_events`** (live via `applyEvent`, replay via `runEventsToRecords`). Run configuration (budget, cwd, permissionMode, executionMode, toolAllowlist) is **in-memory only** — constructed at submit time from session settings + composer options; single-shot runs do not persist it. `create_task` becomes "start a tracked work run" (mints a `runId`, emits `task.created`); `spawn_sub_agent` is a child run (`parentRunId`); a conversation turn is a run. There is no `Task` concept in the persistence layer — only runs and events.

Old `task_events`/`tasks` data is **disposable** (dropped — no dual-read, no backfill). Conversation history is preserved (the `conversation_events` table is renamed to `run_events`, carrying its data over).

This is the largest phase of the redesign. It removes the `Task` type and every `tasks`-table consumer.

## 2. Removal path

| Stage | Persistence | Rendering |
|---|---|---|
| today (after 3b) | `task_events` (work) + `conversation_events` (conv) + `tasks` (manifest) | adapter (`conversationTurnsToRecords`) + `tasksToRecords` |
| **after 4a (this spec)** | `run_events` ONLY (`tasks` + `task_events` dropped; conversation carried over via rename) | `RunRecord` derived wholly from `run_events`; adapter gone |
| after 4b | (unchanged) | `create_task`/`spawn_sub_agent` merge; `goal` folds into `initialMessages` (3c) |

## 3. Non-goals

- **`create_task` / `spawn_sub_agent` merge** + **3c** (`goal`→`initialMessages`) — 4b.
- **Old history migration** — disposable (the user authorized deleting it). No dual-read, no backfill.
- **Multi-client wire rename** — `UIEvent.taskId` stays (it is the run id); only `task.created` adds `parentRunId`. Extension/mobile unaffected.
- **Run-config persistence** — single-shot runs do not persist budget/cwd/permissionMode per-run (session-level settings remain on the session row).

## 4. Data model

### 4.1 `run_events` (renamed + extended `conversation_events`)

```sql
ALTER TABLE conversation_events RENAME TO run_events;
ALTER TABLE run_events ADD COLUMN parent_run_id TEXT;
-- columns: id, session_id, run_id (was turn_id), parent_run_id, seq, ts, event
CREATE INDEX IF NOT EXISTS idx_run_events_session ON run_events(session_id, id);
```

`run_id` is the run's correlation id (the runner's `correlationId`; for conversation it is the `turnId`). `parent_run_id` is NULL for top-level runs and set for spawned children. `event` is the JSON `UIEvent` payload.

### 4.2 `tasks` and `task_events` dropped

```sql
DROP TABLE task_events;   -- old work/delegation event store; data disposable
DROP TABLE tasks;         -- the manifest/execution-anchor table; fully derived now
```

There is no `Task` persistence entity. Everything that lived on the `Task` row is either derived from `run_events` (goal, status, agentDefId, plan, used, parentRunId) or held in-memory (budget, cwd, permissionMode, executionMode, toolAllowlist). The protocol `Task` type is removed; the renderer's run view is `RunRecord`.

### 4.3 `UIEvent` (additive + semantics)

`task.created` is now emitted for EVERY run start (conversation, work, spawn, cron, resident) and gains `parentRunId?: string`. Semantically it is "run started"; the name is kept (cross-client wire compat; a `run.started` rename is a 4b-or-later fast-follow). `task.created` carries `runId` (as `taskId`), `goal`, `agentDefId`, `attachments`, and `parentRunId`. All other `UIEvent` variants keep `taskId` (= the run id).

## 5. Changes

### 5.1 Service — every run emits to `run_events`; no Task rows

- **`makeRunEmit(sessionId, runId, parentRunId?)`** (renamed from `makeConversationEmit`) persists the **full run lifecycle** to `run_events` — every event kind (`task.created`, `task.progress`, `task.complete`, `task.error`, `task.dispatched`, `task.usage`, `task.plan`, `task.permission_request`, `task.delegation_plan`), each row stamped with `run_id` + `parent_run_id`. (3a's `makeConversationEmit` persisted only `task.progress`; 4a fixes that so replayed runs reach terminal status.)
- **`submitGoal`** (conversation): mints `turnId = runId`, emits `task.created { runId, goal, attachments, agentDefId }`, then runs the runner (`correlationId = runId`, `emit = makeRunEmit`). No Task row.
- **`runWorkTask`** (the `create_task` path): mints `runId`, emits `task.created { runId, goal, agentDefId }` (the work-run marker), then runs the runner. No Task row, no Task id.
- **`spawnChild`**: mints `runId` + `parentRunId = <calling run's correlationId>`, emits `task.created { runId, parentRunId, goal, agentDefId }`, runs the runner. No Task row.
- **`task_events` writes retired** — nothing calls `appendTaskEvent`. **`saveTask`/`updateTaskStatus`/`markTaskRunning`/`saveTaskPlan`/`saveTaskUsage`/`saveTaskDelegationPlan` retired** — no Task rows to update. Status/plan/usage live in `run_events` events.
- **Cancel/status/usage by `runId`**: `oneShotHandles` (already keyed by an opaque string id) aborts runs; the pump/queue key off `runId`. Live status derives from the run's last event; the renderer's `RunRecord` reflects it.
- **Resident actors + cron-fired runs + gmail analyze** (the other `createAgentRunner` callers): each must emit to `run_events` via `makeRunEmit` and stop creating Task rows. `spawnResident` (which today creates a residency Task) is migrated to a run, or — if the actor-model path is confirmed dormant (see [[project_actor_model_direction]]) — left flagged. This is verified per-consumer during impl (each is a named task in the plan).

### 5.2 Store — `run_events` API only

- `appendRunEvent(sessionId, runId, parentRunId, event)`, `getRunEvents(sessionId): RunEventRow[]` (`{ runId, parentRunId, seq, ts, event }`, ordered by id).
- **Delete** the Task API: `saveTask`, `getSessionTasks`, `getTask`, `updateTaskStatus`, `markTaskRunning`, `saveTaskPlan`, `saveTaskUsage`, `saveTaskDelegationPlan`, `appendTaskEvent`, and the `tasks`/`task_events` prepared statements + schema (per §4.2).
- `getUsageStats`: aggregate `task.usage` events from `run_events` (was: from Task rows).
- Session delete cascade: drop the `task_events` cleanup; ensure `run_events` cleanup runs.

### 5.3 IPC

`getSessionTasks` → `getRunEvents` (returns `RunEventRow[]`). `swarmApi.getSessionTasks` → `swarmApi.getRunEvents`. `hydrateSession` calls the new IPC.

### 5.4 Renderer — `RunRecord` fully derived

- **`replay.ts`**: replace `conversationTurnsToRecords` + `tasksToRecords` with ONE `runEventsToRecords(sessionId, rows): RunRecord[]` — groups `run_events` by `runId`, derives `goal` (from `task.created`/first user message), `status` (from the terminal event), `agentDefId`/`plan`/`used` (from the relevant events), `parentRunId`. No `isConversation` marker. Drop `STORED_TO_UI_STATUS` (status derives from events).
- **`apply-event.ts`**: `applyEvent` keys by `runId`; `task.created` (with `parentRunId`) creates a run-record; the full event lifecycle drives status. Rename `TaskRecord` → `RunRecord`. Drop `isConversation`.
- **`use-tasks.ts` `hydrateSession`**: reads `getRunEvents` → `runEventsToRecords` → `RUNS_KEY` cache (renamed from `TASKS_KEY`). `TaskRecord` → `RunRecord` everywhere.
- **`build-timeline-items.ts`**: sub-agent blocks keyed off `parentRunId` (was `parentTaskId`). Seq interleave + day dividers unchanged.
- **`tasks-view.tsx`**: `planGroups` derived from `RunRecord`s (runs with `task.plan` events). No Task records.

### 5.5 Protocol

Remove the `Task` type (and `TaskSchema`). `UIEvent.task.created` gains `parentRunId?: string`. (The `tasks`/`task_events`-only fields like `acceptanceCriteria`/`verifications` are already gone from 3b.)

## 6. Data flow (`create_task` work run, post-4a, fully derived)

1. Conversation run calls `create_task(goal)`.
2. Manager `runWorkTask`: mints `runId = ulid()`; emits `task.created { runId, goal, agentDefId }` via `makeRunEmit` (→ `run_events`); constructs the runner in-memory (`correlationId = runId`, budget/cwd/permissionMode from session settings, `emit = makeRunEmit`).
3. Runner runs single-shot (3b); the agent does the work and self-verifies; events stream to `run_events` (`run_id = runId`), including terminal `task.complete`/`task.error` and `task.usage`.
4. Renderer (live): `applyEvent` builds/updates the `RunRecord` for `runId` from each event; the work run's segments render inline in the transcript; its plan (if any) appears in the plan panel (derived from its `task.plan` events).
5. Renderer (replay on session switch): `hydrateSession` reads `getRunEvents` → `runEventsToRecords` → the same `RunRecord`, reaching the same terminal status.
6. No `Task` row, no `task_events`, no manifest. The run IS its events.

## 7. Invariants

- **One stream, single source of truth.** `run_events` is the only persistence for run activity. No `tasks`/`task_events` table, no Task manifest.
- **Everything derived.** `RunRecord` (goal/status/agentDefId/plan/used/parentRunId) is derived from `run_events` — live and replay identically.
- **Replay reaches terminal status.** The full lifecycle (incl. `task.complete`/`task.error`) persists, so a replayed run shows the same status as live (fixes 3a's conversation-replay gap).
- **Run config is in-memory.** Budget/cwd/permissionMode/executionMode/toolAllowlist are constructed at submit time; not persisted per-run.
- **Wire compat.** `UIEvent.taskId` stays; only `task.created` adds `parentRunId`.

## 8. Cancel / status / usage

- Cancel: `cancelTask(sessionId, runId)` aborts via `oneShotHandles.get(runId)`; `interruptWith` promotes a queued run by `runId`. Both already key off an opaque string id.
- Status: live + replay derive from the run's last event in `run_events`. No persisted status field.
- Usage: `task.usage` events in `run_events`; `getUsageStats` aggregates them. Session-level usage stays on the session row (3a).

## 9. Behavior changes

- **Intended:** one unified transcript (conversation + work + delegation + cron all from `run_events`); no adapter, no `isConversation`, no `tasks`/`task_events` tables, no `Task` type. Replayed runs reach correct terminal status.
- **`create_task`** starts a tracked work run (no Task row); **`spawn_sub_agent`** is a child run (no Task row); conversation is a run. Sub-agent blocks link via `parentRunId`.
- **Old sessions:** conversation history renders (carried via the `conversation_events` → `run_events` rename); old work/delegation history (was in `task_events`) is gone (disposable, per user). No data migration.
- **Side benefit:** 3a's "replayed conversation turn always shows running" is fixed.

## 10. Test strategy

- **store** — `appendRunEvent`/`getRunEvents` round-trip; `parent_run_id` persistence; rename migration preserves conversation data; `getUsageStats` from `task.usage` events; the `tasks`/`task_events` API is gone (compile-clean).
- **manager** — `submitGoal`/`runWorkTask`/`spawnChild`: each emits `task.created` + full lifecycle to `run_events`, no `saveTask`. cancel by runId. resident/cron/gmail paths emit to `run_events` (one test each, or a verified no-op if dormant).
- **renderer** — `runEventsToRecords`: groups by runId, derives goal/status/agentDefId/plan/used, sets `parentRunId`. `applyEvent` keys by runId, full lifecycle → terminal status. `buildTimelineItems` nests sub-agent blocks by `parentRunId`. `planGroups` from RunRecords. `TaskRecord`→`RunRecord` across all callers.
- **e2e** — a `create_task` work run: no Task row, events in `run_events`, renders inline + plan panel, reaches completed. A `spawn_sub_agent` child: no Task row, sub-agent block via `parentRunId`. A conversation turn: replays to completed. An OLD session: conversation renders (renamed), work history absent (acceptable).
- **protocol** — `Task` type removal typechecks clean across consumers.

## 11. Verification

- `npm test` green (Electron node runner; never bare `npx vitest`; never `pnpm rebuild better-sqlite3`). Pre-existing: `gmail.test` (htmlBody) + `host.test` (EADDRINUSE :47777).
- `npx tsc -b` clean; delete stale `**/*.tsbuildinfo`. The `Task`-type + `tasks`-table removal is the widest surface yet — a clean typecheck is the key gate.
- `npx biome check --write <file>` per touched file.
- Manual smoke (needs configured provider + no single-instance lock): a `create_task` work run renders inline + plan panel and completes; CEO delegation renders single-shot sub-agent blocks; a conversation turn replays to completed on session switch; an old session's conversation still shows.

## 12. Rollback

4a lands as a series of commits on this worktree, integrated via `git rebase develop` + `git merge --ff-only`. The schema changes (rename + `DROP TABLE tasks`/`task_events`) are **one-way** — old work history is gone (authorized). A revert restores the tables/types from git history; the dropped `task_events`/`tasks` data is not recoverable (acceptable per the user's "history disposable" directive). The `run_events` rename is reversible (`ALTER TABLE run_events RENAME TO conversation_events`).

## 13. Forward pointers (what 4a does NOT do)

- **4b:** `create_task` / `spawn_sub_agent` merge (both are now "runs"; the distinction is only the work-marker + delegation lineage); fold `goal` into `initialMessages` (3c); optionally rename `task.created` → `run.started` on the wire.
- **Resident actor model:** if `spawnResident` is reactivated ([[project_actor_model_direction]]), it lives on `run_events` like every other run (no Task row) — its mailbox/state stays in the actor store.
