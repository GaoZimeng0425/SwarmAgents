# Conversation / Task Separation — Phase 4a: Unified Runs (Task as Data, Not Execution Unit)

- **Date:** 2026-07-03
- **Status:** Design (pending review)
- **Branch:** worktree `phase4a-unified-runs` off `develop` (this worktree; develop at `34249ad` after Phase 3b).
- **Scope:** service (`manager.ts`, `conversation/store.ts`, `agent-runner.ts` emit wiring), protocol (`UIEvent` gains `parentRunId`; `Task` loses `history`, gains `runId`), renderer (`replay.ts`, `use-tasks.ts`, `apply-event.ts`, `build-timeline-items.ts`, `task-segments.ts`, `TaskRecord`→`RunRecord` rename). Adds the `run_events` table (renamed/extended `conversation_events`).
- **Predecessors:** Phases 1 (runner decoupled from `Task`), 2 (user message = real event), 3a (conversation off Task), 3b (agent-driven verify) — all on `develop`.
- **Hard guardrail (user-stated):** "task is agent-authored data, not an execution unit; the transcript is conversation-only + work artifacts." This spec takes work/delegation OFF the `Task` execution/persistence anchor: a single session run-event stream (keyed by `runId`) becomes the spine for ALL runs (conversation, work, delegation), and `Task` rows become optional agent-authored manifests that no longer own events.

## 1. Background & goal

After 3a/3b, conversation turns are single-shot runs with no `Task` row, while work (`create_task`) and delegation (`spawn_sub_agent`) runs still create `Task` rows that anchor persistence (`task_events`), status, cancel, and UI. There are TWO event streams (`task_events` keyed by Task, `conversation_events` keyed by turn) and the renderer bridges them with a `conversationTurnsToRecords` adapter that forces conversation into a `TaskRecord` shape (with an `isConversation` marker hack). The runner is already decoupled from `Task` (Phase 1: `correlationId`), so the remaining "Task-as-execution-unit" is purely a persistence/UI anchoring.

**Phase 4a unifies the two streams into one session run-event stream.** Every run — conversation turn, `create_task` work task, spawned sub-agent — emits events to `run_events`, keyed by `runId` (the runner's existing `correlationId`); spawned children carry `parentRunId`. `Task` rows become **agent-authored manifests**: created only by `create_task` (the "tracked work" label), linked to a `runId`, no longer owning events or anchoring execution. Conversation turns and spawned sub-agents are runs WITHOUT `Task` manifests.

This drops the `conversationTurnsToRecords` adapter (conversation renders from the same stream as work), removes the `isConversation` marker, and renames the renderer's run-view type `TaskRecord` → `RunRecord`.

## 2. Removal path

| Stage | Conversation | Work / delegation | Rendering |
|---|---|---|---|
| today (after 3b) | `conversation_events`, no Task row | `task_events` + Task row (execution anchor) | adapter (pseudo-`TaskRecord` via `conversationTurnsToRecords`) + `tasksToRecords` |
| **after 4a (this spec)** | `run_events` (runId) | `run_events` (runId/parentRunId) + Task manifest (no events) | ONE run-view from `run_events`; adapter gone; `TaskRecord`→`RunRecord` |
| after 4b | (unchanged) | (unchanged) | `create_task`/`spawn_sub_agent` merge decision; `goal` folds into `initialMessages` (3c) |

## 3. Non-goals

- **`create_task` / `spawn_sub_agent` merge** (4b) — both tools stay distinct in 4a.
- **`goal` → `initialMessages`** (3c, folded into 4b).
- **Removing the `tasks` table** — it stays (slimmed to manifests). Task rows are not deleted, just demoted.
- **Resident actor path** (`spawnResident`), cron, gmail sidecar — unaffected (they already run single-shot or don't use the conversation/work path).
- **A wire rename of `UIEvent.taskId`** — kept as the run correlation id (conservative; the rename blast radius spans extension/mobile clients). Only `task.created` gains `parentRunId` (additive).
- **Migration of old sessions** — no backfill. Old work/delegation history (in `task_events`) is read via a bounded dual-read shim until those sessions age out.

## 4. Data model

### 4.1 `run_events` (renamed + extended `conversation_events`)

```sql
ALTER TABLE conversation_events RENAME TO run_events;
ALTER TABLE run_events ADD COLUMN parent_run_id TEXT;
-- columns: id, session_id, run_id (was turn_id), parent_run_id, seq, ts, event
CREATE INDEX IF NOT EXISTS idx_run_events_session ON run_events(session_id, id);
```

`run_id` is the run's correlation id (the runner's `correlationId`; for conversation it is the `turnId`). `parent_run_id` is NULL for top-level runs (conversation, `create_task` work) and set for spawned sub-agents. `event` is the JSON `UIEvent` payload.

### 4.2 `tasks` slimmed to a manifest

```sql
ALTER TABLE tasks ADD COLUMN run_id TEXT;
-- history column (task_events) is no longer the source of truth for new runs;
-- it is retained (revert-safe + legacy read) but not written for new runs.
```

The `Task` type loses `history` and gains `runId` (and keeps `parentId` for compatibility, always NULL for manifests since spawns no longer create Task rows):

```ts
Task = { id, runId, sessionId, parentId: null, goal, status, agentDefId,
         plan, used, contextWindow, cwd, permissionMode, executionMode,
         createdAt, startedAt, endedAt, ... }   // NO history
```

A Task manifest is created ONLY by `create_task`. Its events live in `run_events` (queried by `runId`); the manifest carries goal/status/agentDefId/plan/usage for the panel.

### 4.3 `UIEvent` wire (additive)

`task.created` gains `parentRunId?: string` (NULL for top-level runs, the parent run id for spawned children), and is now emitted for EVERY run start (conversation, work, spawn) — semantically "run started". The name `task.created` is kept to avoid cross-client wire churn (extension/mobile consume `UIEvent`); a rename to `run.started` is a 4b-or-later fast-follow. All other `UIEvent` variants keep `taskId` (the run correlation id — for conversation it is the `turnId`). No other wire change.

## 5. Changes

### 5.1 Service — one run stream, `makeRunEmit`

- **Rename `makeConversationEmit` → `makeRunEmit(sessionId, runId, parentRunId?)`** and have it persist the **full run lifecycle** to `run_events` — not just `task.progress` (the 3a limitation). It persists every event kind the runner/translators emit: `task.progress`, `task.complete`, `task.error`, `task.dispatched`, `task.usage`, `task.plan`, `task.permission_request`. (3a's `makeConversationEmit` persisted only `task.progress`, so replayed conversation turns never reached a terminal status — 4a fixes that as a side effect: replayed runs now show completed/failed.) Each persisted event row carries `run_id` and `parent_run_id`.
- **`submitGoal`** (conversation): runs the runner with `correlationId = turnId`, `emit = makeRunEmit(sessionId, turnId)`. No `Task` manifest (unchanged from 3a).
- **`runWorkTask`** (the `create_task` path): mints a `runId`, creates a `Task` manifest `{ id, runId, sessionId, parentId: null, goal, status: 'pending', agentDefId, ... }`, broadcasts `task.created` (now carrying `runId`, no `parentRunId`), then runs the runner with `correlationId = runId`, `emit = makeRunEmit(sessionId, runId)`. On terminal status the manifest is updated (completed/failed).
- **`spawnChild`**: mints a `runId` + `parentRunId = <calling run's correlationId>`. **No `Task` manifest** (spawns are pure runs). Broadcasts `task.created` with `runId` + `parentRunId` so the renderer creates a child run-record. Runs the runner with `correlationId = runId`, `emit = makeRunEmit(sessionId, runId, parentRunId)`.
- **`task_events` write path retired** for new runs; `appendTaskEvent` is no longer called by `makeRunEmit`/`makeEmit`. (Legacy reads remain — §5.4.)
- **Cancel/status/usage** key off `runId` via `oneShotHandles` (already keyed by an opaque string id — naturally compatible). `markTaskRunning`/`updateTaskStatus` now address the manifest by `runId` (or the manifest is updated at terminal only — see §8).

### 5.2 `store` — `run_events` API + dual-read

- Rename/extend: `appendRunEvent(sessionId, runId, parentRunId, event)`, `getRunEvents(sessionId): RunEventRow[]` (ordered by id; each `{ runId, parentRunId, seq, ts, event }`).
- `getSessionTasks(sessionId)` returns manifest-only `Task[]` (no `history`).
- **Dual-read lives in the store (not the renderer):** `getRunEvents(sessionId)` returns `run_events` ∪ legacy `task_events` — the legacy rows are shaped as run-events (`runId = taskId`, `parentRunId = parentId`, events from the Task's `history`). The renderer calls ONE read and sees a unified stream. This shim is bounded (legacy only) and dropped once those sessions age out.

### 5.3 Renderer — one run-view from `run_events`

- **`replay.ts`**: replace `conversationTurnsToRecords` + `tasksToRecords` with `runEventsToRecords(sessionId, rows): RunRecord[]` — groups `run_events` by `runId` into `RunRecord`s (events, derived status from the terminal event, `parentRunId`, first user message as `goal`). No `isConversation` marker. Drop the `STORED_TO_UI_STATUS` / `tasksToRecords` path (or fold its status mapping into `runEventsToRecords`).
- **`use-tasks.ts` `hydrateSession`**: reads `getRunEvents` (via the dual-read shim) → `runEventsToRecords` → `TASKS_KEY` cache (renamed `RUNS_KEY`). `TaskRecord` → `RunRecord` throughout.
- **`apply-event.ts`**: `applyEvent` keys by `runId` (the `taskId` on the wire is the run id — rename the local handling). `task.created` with `parentRunId` creates a child run-record. Drop the `isConversation` field. Rename `TaskRecord` → `RunRecord`, `TaskStatus` unchanged.
- **`build-timeline-items.ts`**: sub-agent blocks keyed off `parentRunId` (was `parentTaskId`). Everything else (seq interleave, day dividers) unchanged.
- **`task-segments.ts`**: operates on `RunRecord` (same logic — it already works off `events`).

### 5.4 Legacy dual-read (bounded)

New runs (4a+) write only to `run_events`. Old sessions' work/delegation events live in `task_events` (and old conversation events are in `run_events` after the rename — preserved). The renderer reads `run_events` ∪ (legacy `task_events` shaped as run-events). No backfill, no data loss. The shim is removed when no legacy sessions remain (a fast-follow, not in 4a).

## 6. Data flow (`create_task` work task, post-4a)

1. Conversation turn calls `create_task(goal)`.
2. Manager `runWorkTask`: mints `runId = ulid()`; creates Task manifest `{ id, runId, sessionId, parentId: null, goal, status: 'pending', agentDefId }`; broadcasts `task.created { runId, goal, ... }`; marks dispatched.
3. Runs the runner (`correlationId = runId`, `emit = makeRunEmit(sessionId, runId)`). The agent does the work, self-verifies (3b), streams events.
4. Each event persists to `run_events` (`run_id = runId`); terminal `task.complete`/`task.error` also persists → the run reaches terminal status in the stream.
5. On terminal, the manifest is updated to completed/failed (for the panel).
6. Renderer: live events + replay both read `run_events` → `runEventsToRecords` → one `RunRecord` per run; the work run's segments render inline in the transcript; its manifest appears in the plan/panel views.

## 7. Invariants

- **One run stream.** Every run (conversation / work / delegation) emits its full lifecycle to `run_events`, keyed by `runId` (+ `parentRunId` for spawns). There is no second stream for new runs.
- **Task manifests are optional labels.** Only `create_task` creates a Task manifest. Conversation turns and spawned sub-agents are runs without manifests.
- **Replay reaches terminal status.** Because the full lifecycle (incl. `task.complete`/`task.error`) persists to `run_events`, a replayed run shows the same terminal status as live (fixing 3a's conversation-replay gap).
- **Wire compatibility.** `UIEvent.taskId` stays (it is the run id); only `task.created` adds `parentRunId`. Extension/mobile clients are unaffected.

## 8. Cancel / status / usage

- Cancel: `cancelTask(sessionId, runId)` aborts via `oneShotHandles.get(runId)` (opaque id — works for conversation turnId, work runId, spawn runId alike).
- Status: live status derives from the run's last event in `run_events` (the renderer's `RunRecord`). The Task manifest's `status` is updated at terminal (completed/failed) for the panel; the manifest is NOT updated on every progress event (minimal writes). Intermediate running state is read from the stream.
- Usage: `task.usage` events persist to `run_events` (keyed by runId). Per-run usage rolls up to the session/work-task as today. The manifest's `used` is a terminal snapshot.

## 9. Behavior changes

- **Intended:** one unified transcript (conversation + work + delegation all from `run_events`); no adapter, no `isConversation` marker. Conversation/work/delegation replay all reach correct terminal status. Sub-agent blocks link via `parentRunId`.
- **`create_task`** still authors a Task manifest (panel entry); **`spawn_sub_agent`** no longer creates a Task row (the child is a pure run; its block renders from `run_events` + `parentRunId`).
- **Old sessions:** conversation renders from `run_events` (renamed); work/delegation renders via the dual-read shim over `task_events`. No data loss.
- **Side benefit:** 3a's "replayed conversation turn always shows running" is fixed (terminal events now persist).

## 10. Test strategy

- **store** — `appendRunEvent`/`getRunEvents` round-trip; `parent_run_id` persistence; the rename migration (`conversation_events` → `run_events` preserves data); the dual-read shim (legacy `task_events` shaped as run-events).
- **manager** — `submitGoal` (conversation): events to `run_events`, no manifest. `runWorkTask`: Task manifest created with `runId`, run emits to `run_events`, terminal updates manifest. `spawnChild`: no manifest, `task.created` carries `parentRunId`, run emits to `run_events`. cancel by runId.
- **renderer** — `runEventsToRecords`: groups by runId, derives terminal status, sets `parentRunId` on children. `applyEvent` keys by runId. `buildTimelineItems` nests sub-agent blocks by `parentRunId`. Drop `isConversation`.
- **e2e** — a `create_task` work task: Task manifest + run events in `run_events`, renders inline + in panel, reaches completed. A `spawn_sub_agent` child: no Task row, renders as a sub-agent block via `parentRunId`. A conversation turn: replays to terminal status (not stuck running). An OLD session: work history renders via the dual-read shim.
- **rename** — `TaskRecord`→`RunRecord` typecheck across the 59 callers.

## 11. Verification

- `npm test` green (full suite, Electron node runner; never bare `npx vitest`; never `pnpm rebuild better-sqlite3`). Pre-existing failures: `gmail.test` (htmlBody fixture) + `host.test` (EADDRINUSE :47777) — unchanged.
- `npx biome check --write <file>` per touched file (scoped).
- `npx tsc -b` clean; delete stale `**/*.tsbuildinfo` before trusting it (composite cache).
- Manual smoke (needs configured provider + no single-instance lock): a `create_task` work task renders inline + in the panel and completes; a CEO delegation renders single-shot sub-agent blocks; a conversation turn replays to completed on session switch.

## 12. Rollback

4a lands as a series of commits on this worktree branch, integrated via `git rebase develop` + `git merge --ff-only`. The schema changes are additive (rename + new columns; old columns/tables retained). A revert restores `makeConversationEmit`/`makeEmit` split and the adapter; the `run_events` table can be renamed back. No data loss on revert (events are additive).

## 13. Forward pointers (what 4a does NOT do)

- **4b:** decide whether `create_task` and `spawn_sub_agent` merge (now that both are "runs" and Task is just a manifest label); fold `goal` into `initialMessages` (3c).
- **Dual-read shim removal:** drop the legacy `task_events` read once no old sessions remain (a fast-follow after 4a/4b, not blocking).
