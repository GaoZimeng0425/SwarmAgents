# Conversation / Task Separation — Phase 4a: Unified Run Rendering (Core)

- **Date:** 2026-07-03
- **Status:** Design (revised to the split: 4a = unified rendering core, `Task` table retained; 4b = drop `Task` table + migrate cron/waiters + tool merge + 3c). The earlier "fully-derived in 4a" framing was rescoped after planning found the `Task` table is also consumed by the cron scheduler, `wait_for_task`, and the terminal listener — migrating those is deferred to 4b.
- **Branch:** worktree `phase4a-unified-runs` off `develop` (`34249ad`).
- **Scope:** service (`manager.ts` emit wiring — `makeRunEmit` for all main runs), store (`conversation/store.ts` — rename `conversation_events` → `run_events` + `parent_run_id`; add run-events API alongside the retained `tasks`/`task_events` API), IPC (`getConversationEvents` → `getRunEvents`), renderer (`replay.ts`, `use-tasks.ts`, `apply-event.ts`, `build-timeline-items.ts`, `task-segments.ts`; `TaskRecord`→`RunRecord`; drop the `conversationTurnsToRecords` adapter + `isConversation`).
- **Predecessors:** Phases 1–3b on `develop`.
- **Hard guardrail (user-stated):** first-principles, best practice, no lazy compat shims for OLD data (history disposable). 4a makes `run_events` the single RENDERING source (every main run — conversation / `create_task` / spawn — emits its full lifecycle there) and drops the adapter that forced conversation into `TaskRecord` shape. The `Task`/`task_events` tables are RETAINED in 4a (still written by work/spawn for `wait_for_task` + the terminal listener + cron's internal tracking; no longer read by the renderer). Removing them is 4b.

## 1. Background & goal

After 3a/3b there are two event streams (`task_events` for work/delegation, `conversation_events` for conversation) and the renderer bridges them with a `conversationTurnsToRecords` adapter that forces conversation into a `TaskRecord` shape (with an `isConversation` marker hack). 3a's `makeConversationEmit` also persists only `task.progress`, so replayed conversation turns never reach a terminal status (the adapter hardcodes `status: 'running'`).

**Phase 4a unifies the RENDERING onto one session run-event stream.** Every main run — conversation turn, `create_task` work, spawned sub-agent — emits its **full lifecycle** to `run_events` (renamed from `conversation_events` + `parent_run_id`), keyed by `runId` (the runner's `correlationId`); spawned children carry `parent_run_id` (reusing the existing `UIEvent.task.created.parentTaskId` — no new wire field). The renderer reads `run_events` exclusively and derives `RunRecord` (renamed from `TaskRecord`) — live via `applyEvent`, replay via `runEventsToRecords`. The adapter and `isConversation` marker are gone. Replayed runs reach terminal status (the full lifecycle now persists).

The `Task` and `task_events` tables STAY in 4a: work/spawn runs **dual-write** (their existing `task_events` rows for `wait_for_task` + the terminal listener + cron's bookkeeping, AND new `run_events` rows for rendering). Conversation turns write only `run_events`. The dual-write is a temporary scaffold — 4b migrates `wait_for_task`/listener/cron off the `Task` table and removes it.

This delivers the user's core goal — a unified, derived, first-principles run model for rendering — without the orthogonal cron/waiter surgery bloating 4a.

## 2. Removal path

| Stage | Rendering source | `Task` / `task_events` tables |
|---|---|---|
| today (after 3b) | adapter (`conversationTurnsToRecords`) + `tasksToRecords` (two streams) | present; anchor work/delegation |
| **after 4a (this spec)** | `run_events` ONLY — `RunRecord` derived; adapter gone | RETAINED — dual-written by work/spawn; consumed by `wait_for_task`/listener/cron; NOT read by renderer |
| after 4b | (unchanged) | DROPPED — cron/waiters/listener migrated to runId; main paths stop dual-writing; `Task` type removed; `create_task`/`spawn` merge; `goal`→`initialMessages` |

## 3. Non-goals

- **Dropping the `Task`/`task_events` tables + `Task` type** (4b) — they stay in 4a.
- **Migrating cron scheduler / `wait_for_task` / terminal listener off `Task`** (4b).
- **`create_task` / `spawn_sub_agent` merge + 3c** (`goal`→`initialMessages`) — 4b.
- **Old history migration** — disposable (no dual-read for old `task_events`; old work history simply won't appear in the new `run_events`-based renderer — acceptable per user).
- **Multi-client wire rename** — `UIEvent.taskId` and `task.created.parentTaskId` are reused as the run correlation id / parent-run link. No new wire field.

## 4. Data model

### 4.1 `run_events` (renamed + extended `conversation_events`)

```sql
ALTER TABLE conversation_events RENAME TO run_events;
ALTER TABLE run_events ADD COLUMN parent_run_id TEXT;
-- columns: id, session_id, run_id (was turn_id), parent_run_id, seq, ts, event
CREATE INDEX IF NOT EXISTS idx_run_events_session ON run_events(session_id, id);
```

`run_id` is the run's correlation id (the runner's `correlationId`; for conversation it is the `turnId`). `parent_run_id` is NULL for top-level runs (conversation, `create_task` work) and set for spawned children. `event` is the JSON `UIEvent` payload.

### 4.2 `tasks` / `task_events` retained (unchanged schema)

Both tables stay exactly as today. Work/spawn runs continue to write `task_events` (via the existing `makeEmit`/`appendTaskEvent` path) AND broadcast `task.created`/lifecycle as today — so `wait_for_task`, the terminal listener, cron's `attachCronRunTask`, and `getTask` keep working unchanged. The renderer simply stops reading these tables. (4b removes them.)

### 4.3 `UIEvent` (no wire change)

`task.created` already carries `parentTaskId` (used today for sub-agent linking). 4a reuses it as the parent-run link in `run_events` (stored as `parent_run_id`). No new `UIEvent` field. The run correlation id remains `taskId` on the wire (for conversation it is the `turnId`).

## 5. Changes

### 5.1 Service — every main run emits its full lifecycle to `run_events`

- **`makeRunEmit(sessionId, runId, parentRunId?)`** (renamed from `makeConversationEmit`) persists the **full run lifecycle** to `run_events` — every event kind (`task.created`, `task.progress`, `task.complete`, `task.error`, `task.dispatched`, `task.usage`, `task.plan`, `task.permission_request`, `task.delegation_plan`), each row stamped with `run_id` + `parent_run_id`. (3a's `makeConversationEmit` persisted only `task.progress`; 4a fixes that so replayed runs reach terminal status.)
- **Conversation (`submitGoal`)**: emit `task.created { runId, goal, agentDefId, attachments }` at turn submit (so the run-record is created with the goal/agentDefId, not synthesized), then run with `correlationId = runId`, `emit = makeRunEmit(sessionId, turnId)`. Writes only `run_events`.
- **Work (`runWorkTask`)** and **spawn (`spawnChild`)**: keep their existing `makeEmit` (writes `task_events` + broadcasts, unchanged) AND additionally pipe every emitted event through `makeRunEmit` so the same lifecycle lands in `run_events` (`run_id = task.id`, `parent_run_id = parentTaskId ?? null`). This is the dual-write scaffold. (A single combined emit that tees to both is the cleanest wiring — see plan.)
- **Cron-fired runs / resident / gmail analyze**: these continue using `makeEmit` (Task-based) as today. In 4a they are NOT required to emit `run_events` (cron runs render via their existing Task path... — see §5.4 note: the renderer reads only `run_events`, so cron-fired runs WILL need to emit `run_events` to render. This is a 4a task: tee cron/resident/gmail emits into `run_events` too, exactly like work/spawn.) The terminal listener + `wait_for_task` keep using the Task table (unchanged).

### 5.2 Store — `run_events` API alongside the retained Task API

- Add `appendRunEvent(sessionId, runId, parentRunId, event)` and `getRunEvents(sessionId): RunEventRow[]` (`{ runId, parentRunId, seq, ts, event }`, ordered by id). Rename the existing `appendConversationEvent`/`getConversationEvents` to these (the `turnId` param becomes `runId`; add `parentRunId`).
- KEEP `appendTaskEvent`, `saveTask`, `getSessionTasks`, `getTask`, `updateTaskStatus`, `markTaskRunning`, `saveTaskPlan`, `saveTaskUsage`, `saveTaskDelegationPlan`, `getUsageStats` exactly as today (still used by work/spawn writes + cron/waiters/listener).
- Session delete cascade: the existing `run_events` cleanup (renamed from `conversation_events`) covers the new stream.

### 5.3 IPC

`swarm:getConversationEvents` → `swarm:getRunEvents` (preload `getConversationEvents` → `getRunEvents`; `swarmApi.getConversationEvents` → `swarmApi.getRunEvents`; service-client + dispatcher method renamed). `swarm:getSessionTasks` STAYS (still used elsewhere — e.g. tests, future 4b). The renderer calls `getRunEvents`.

### 5.4 Renderer — `RunRecord` derived wholly from `run_events`

- **`replay.ts`**: replace `conversationTurnsToRecords` + `tasksToRecords` with ONE `runEventsToRecords(sessionId, rows): RunRecord[]` — groups `run_events` by `runId`, derives `goal` (from the `task.created` event), `status` (from the terminal event), `agentDefId`/`plan`/`used` (from the relevant events), `parentRunId` (from `task.created.parentTaskId`). Drop `STORED_TO_UI_STATUS` (status derives from events). No `isConversation` marker.
- **`apply-event.ts`**: `applyEvent` already keys by `taskId` (= runId) and handles the full lifecycle — keep its logic; rename `TaskRecord` → `RunRecord`; the `parentTaskId` field becomes the renderer's parent-run link (rename to `parentRunId` for clarity, or keep — see plan). Drop the `isConversation` field.
- **`use-tasks.ts` `hydrateSession`**: reads `swarmApi.getRunEvents` → `runEventsToRecords` → cache (renamed `RUNS_KEY`, was `TASKS_KEY`). `TaskRecord` → `RunRecord` across the hook.
- **`build-timeline-items.ts`**: sub-agent blocks keyed off `parentRunId` (was `parentTaskId`). Seq interleave + day dividers unchanged.
- **`tasks-view.tsx`**: `planGroups` derived from `RunRecord`s (runs with `task.plan` events). The right-hand plan panel keeps working (plans are in `run_events`).
- **Cron-fired runs render too**: because cron runs now tee into `run_events` (§5.1), they appear in the transcript via the same `runEventsToRecords` path.

### 5.5 Protocol

No `UIEvent` change (§4.3). The `Task` type stays (4b removes it). `ConversationEvent` type → `RunEvent` (`turnId` → `runId`, add `parentRunId`).

## 6. Data flow (`create_task` work run, post-4a)

1. Conversation run calls `create_task(goal)`.
2. `runWorkTask`: mints `runId = task.id`; `saveTask` + `task.created` broadcast (unchanged — for `wait_for_task`/listener/cron); runs the runner with a **teed emit** that writes `task_events` (existing) AND `run_events` (new, `run_id = runId`, `parent_run_id = null`).
3. The runner's full lifecycle (`task.created`→`task.progress`→...→`task.complete`/`task.error`, `task.usage`, `task.plan`) lands in BOTH `task_events` and `run_events`.
4. Renderer (live): `applyEvent` builds/updates the `RunRecord` for `runId` from each `run_events`-sourced event (it already does this for the broadcast events; the teed `run_events` write is the replay source). The work run renders inline in the transcript; its plan appears in the plan panel.
5. Renderer (replay): `hydrateSession` reads `getRunEvents` → `runEventsToRecords` → the same `RunRecord`, reaching the same terminal status (because the full lifecycle persisted).
6. `wait_for_task` / terminal listener / cron continue reading the `Task` table — unaffected.

## 7. Invariants

- **`run_events` is the only RENDERING source.** The renderer reads no other table for run activity. Conversation/work/spawn/cron all render from `run_events`.
- **Full lifecycle persists to `run_events`.** Replay reaches the same terminal status as live (fixes 3a's conversation-replay gap).
- **`Task`/`task_events` retained, dual-written by work/spawn/cron.** They serve `wait_for_task`/listener/cron internals; the renderer ignores them. The dual-write is temporary (4b removes it).
- **No wire change.** `UIEvent.taskId` + `task.created.parentTaskId` are reused.
- **Old work history** (in `task_events`, never written to `run_events`) does not render. Acceptable (disposable).

## 8. Cancel / status / usage

- Cancel/interrupt: unchanged (keyed by the run/task id; `oneShotHandles`).
- Status: the renderer derives from `run_events` events (live + replay). The `Task` row's persisted status still exists (used by `wait_for_task`/listener) — it is NOT the renderer's source.
- Usage: `task.usage` events in `run_events` drive the renderer's usage display; `getUsageStats` still reads the `Task` table (4b migrates it).

## 9. Behavior changes

- **Intended:** one unified transcript (conversation + work + delegation + cron all from `run_events`); no adapter, no `isConversation`; replayed runs reach correct terminal status. `TaskRecord` → `RunRecord`.
- **`Task`/`task_events` tables retained** (dual-written; not rendered). `wait_for_task`/listener/cron unaffected.
- **Old sessions:** conversation history renders (renamed into `run_events`); old work history (only in `task_events`) does NOT render in the new pipeline (disposable).
- **Side benefit:** 3a's "replayed conversation turn always shows running" is fixed.

## 10. Test strategy

- **store** — `appendRunEvent`/`getRunEvents` round-trip; `parent_run_id` persistence; rename preserves conversation data; the `tasks`/`task_events` API is unchanged (existing tests still pass).
- **manager** — conversation: emits `task.created` + full lifecycle to `run_events`, no `task_events`. work/spawn: dual-write (`task_events` AND `run_events`). cron-fired/resident/gmail: tee into `run_events`. cancel unchanged.
- **renderer** — `runEventsToRecords`: groups by runId, derives goal/status/agentDefId/plan/used, sets parentRunId. `applyEvent` keys by runId. `buildTimelineItems` nests sub-agent blocks by parentRunId. `TaskRecord`→`RunRecord` across callers. `planGroups` from RunRecords.
- **IPC** — `getRunEvents` returns the stream; `getSessionTasks` still works.
- **e2e** — a `create_task` work run renders inline + plan panel (from `run_events`) and reaches completed on replay; a `spawn_sub_agent` child renders as a sub-agent block via parentRunId; a conversation turn replays to completed; `wait_for_task` still resolves (Task table intact).

## 11. Verification

- `npm test` green (Electron node runner; never bare `npx vitest`; never `pnpm rebuild better-sqlite3`). Pre-existing: `gmail.test` (htmlBody) + `host.test` (EADDRINUSE :47777).
- `npx tsc -b` clean; delete stale `**/*.tsbuildinfo`. The `TaskRecord`→`RunRecord` rename touches ~59 callers — a clean typecheck is a key gate.
- `npx biome check --write <file>` per touched file.
- Manual smoke (needs configured provider + no single-instance lock): a `create_task` work run renders inline + plan panel and completes; CEO delegation renders single-shot sub-agent blocks; a conversation turn replays to completed on session switch; a cron-fired run renders in the transcript.

## 12. Rollback

4a lands as a series of commits on this worktree, integrated via `git rebase develop` + `git merge --ff-only`. The schema change is additive (rename + new column; `tasks`/`task_events` retained). A revert restores `makeConversationEmit`/the adapter; `run_events` renames back to `conversation_events`. No data loss on revert (the dual-write preserved `task_events` throughout).

## 13. Forward pointers (what 4a does NOT do — all 4b)

- **Drop the `Task`/`task_events` tables + `Task` type:** migrate `wait_for_task`, the terminal listener, cron's `attachCronRunTask`/`getTask` usage, and `getUsageStats` to runId-keyed reads off `run_events`; stop the work/spawn/cron dual-write; then drop the tables + type.
- **`create_task` / `spawn_sub_agent` merge** (both are runs now).
- **3c:** `goal` folds into `initialMessages`.
- **Optional wire rename:** `task.created` → `run.started`; `parentTaskId` → `parentRunId`.
