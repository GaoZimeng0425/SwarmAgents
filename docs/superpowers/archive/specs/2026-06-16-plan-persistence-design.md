# Plan Persistence — Design

**Date:** 2026-06-16
**Status:** Approved, ready for implementation plan

## Problem

When a task is interrupted (app quit/crash mid-run), its plan disappears. After
restart the PlanPanel is empty even though the task had a live checklist.

Root cause is two compounding gaps:

- **Gap A — history saved only at task end.** In `session-manager.ts`'s
  `makeEmit`, task events are buffered in an in-memory `historyByTask` map and
  flushed to the store via `saveTaskHistory` only on `task.complete` /
  `task.error`. A mid-run interrupt loses everything since the task started.
- **Gap B — plan not reconstructed on reload.** `update_plan` (`tools/plan.ts`)
  is stateless; the plan only lives inside a `tool.result` payload in history.
  On reload, `replay.ts`'s `tasksToRecords` replays history as generic
  `task.progress` events, and `apply-event.ts` only fills the `plan` field from
  a `task.plan` event — which is never produced from history.

The live plan event is emitted at `agent-runner.ts:179`:
`emit('task.plan', { taskId, todos, ts })`. `makeEmit` receives it but does not
persist it.

## Scope

In scope (chosen): **display + state recovery only.** Make the plan a
first-class persisted Task field, written the moment `update_plan` runs, and
rehydrated into the PlanPanel on reload. The per-step status
(pending/in_progress/completed) of the last plan snapshot is restored verbatim.

Explicitly out of scope this round:

- **Transcript recovery for interrupted tasks.** Non-plan history still flushes
  only at task end (Gap A in general). Surviving the full transcript across an
  interrupt is a separate change.
- **Auto re-running / continuing the agent.** No interrupted task is
  re-dispatched. Recovery is display-only.
- **Memory changes.** Memory being empty is working-as-designed: it only fills
  when the agent calls `remember`, which it rarely does. Confirmed the storage
  path (`userData/agent-memory.json`), the `memory.changed` → query
  invalidation, and the namespace-less `listMemory()` are all correct. No change
  this round.

## Design

Promote `plan` from an ephemeral event-derived value to a first-class persisted
field on `Task`, saved eagerly on every `update_plan` and rehydrated on reload.

### 1. Data model — `src/shared/types/task.ts`

Add `plan` to `TaskSchema`, reusing the existing `PlanTodoSchema`:

```ts
plan: z.array(PlanTodoSchema).default([]),
```

### 2. Storage — `src/service/conversation-store.ts`

- Add column to the `tasks` CREATE TABLE: `plan TEXT NOT NULL DEFAULT '[]'`.
- Add a migration line to the existing `ALTER TABLE` loop so old DBs gain the
  column: `ALTER TABLE tasks ADD COLUMN plan TEXT NOT NULL DEFAULT '[]'`.
- `rowToTask`: parse `plan` as `JSON.parse((row.plan as string) ?? '[]')`.
- `saveTask`: include `JSON.stringify(task.plan ?? [])` in the insert.
- New method on `ConversationStore`:
  `saveTaskPlan(taskId: string, plan: PlanTodo[]): void` →
  `UPDATE tasks SET plan = ? WHERE id = ?`. Mirrors the shape and naming of the
  existing `saveTaskHistory` / `saveTaskUsage`.

### 3. Write path (save at generation time) — `src/service/session-manager.ts`

In `makeEmit`, add a branch alongside the existing event handling: when
`event === 'task.plan'` and a `taskId` is present, call
`store.saveTaskPlan(taskId, todos)` immediately. This persists the plan the
moment `update_plan` runs — not at task end — so it survives an interrupt.

Per CLAUDE.md §5, log it: `log.debug({ msg: 'plan persisted', taskId, steps: todos.length })`.

### 4. Read path (rehydrate on reload) — `src/renderer/src/lib/replay.ts`

In `tasksToRecords`, set the persisted plan directly on the rebuilt record:

```ts
plan: t.plan.length ? t.plan : undefined,
```

`tasks-view.tsx:58` already reads `t.plan`, so PlanPanel renders the restored
snapshot with no further wiring.

## Data flow

```
update_plan tool runs
  → agent-runner emits task.plan {taskId, todos}
  → session-manager makeEmit: store.saveTaskPlan(taskId, todos)   [eager, every call]
  → conversation-store: UPDATE tasks SET plan = ?

--- restart ---

hydrateSession → getSessionTasks → rowToTask (plan parsed)
  → replay.tasksToRecords: record.plan = t.plan
  → tasks-view → PlanPanel renders last snapshot
```

## Testing

- `conversation-store` test: `saveTaskPlan` persists; `getSessionTasks` returns
  the plan; round-trips through `saveTask`. Migration adds the column to a
  pre-existing DB without the column.
- `replay` test: a persisted task with a non-empty `plan` produces a record with
  `plan` set; an empty plan yields `undefined`.
- Existing `apply-event` / `plan.ts` tests stay green (live path unchanged).

## Risks

- **Schema migration on existing DBs.** The `ALTER TABLE` is wrapped in the
  existing try/catch loop that no-ops when the column already exists; fresh DBs
  get it from CREATE TABLE. Low risk, matches the established pattern.
- **`task.plan` shape.** `todos` from the event is already validated by the
  `update_plan` tool against the same status enum as `PlanTodoSchema`, so the
  persisted value is well-formed.
