# Plan Persistence Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Persist each task's plan the moment `update_plan` runs so the PlanPanel survives an app interrupt/restart.

**Architecture:** Promote `plan` from an ephemeral event-derived value to a first-class persisted column on the `tasks` table. The service writes it eagerly on every `task.plan` event (not at task end), and the renderer rehydrates it directly when rebuilding task records on session load. No agent re-run; display + per-step status recovery only.

**Tech Stack:** TypeScript, Zod (shared schema), better-sqlite3 (service store), Vitest (run via `npm test`), React/Zustand (renderer).

Spec: `docs/superpowers/specs/2026-06-16-plan-persistence-design.md`

---

## File Structure

- `src/shared/types/task.ts` — add `plan` to `TaskSchema` (shared source of truth).
- `src/service/conversation-store.ts` — `plan` column, migration, `rowToTask`/`saveTask` wiring, new `saveTaskPlan` method.
- `src/service/conversation-store.test.ts` — round-trip tests for the new column + method.
- `src/service/session-manager.ts` — eager persist branch in `makeEmit`.
- `src/renderer/src/lib/replay.ts` — set `plan` on rebuilt `TaskRecord`.
- `src/renderer/src/lib/replay.test.ts` — rehydration tests.

Test runner for every `Run:` step below:
```bash
npm test -- <test-file-path>
```
(`npm test` = `cross-env ELECTRON_RUN_AS_NODE=1 electron node_modules/vitest/vitest.mjs run`. Never use bare `npx vitest`.)

---

## Task 1: Persist plan in the conversation store

**Files:**
- Modify: `src/shared/types/task.ts:87-103` (`TaskSchema`)
- Modify: `src/service/conversation-store.ts` (CREATE TABLE, ALTER loop, `rowToTask`, `stmtInsertTask`, `saveTask`, new `saveTaskPlan` + interface entry)
- Test: `src/service/conversation-store.test.ts`

- [ ] **Step 1: Add `plan` to the shared Task schema**

In `src/shared/types/task.ts`, inside `TaskSchema` (after the `attachments` line at :98), add:

```ts
  attachments: z.array(AttachmentSchema).default([]),
  plan: z.array(PlanTodoSchema).default([]),
  result: TaskResultSchema.nullable(),
```

`PlanTodoSchema` already exists in this file (:30). No new import.

- [ ] **Step 2: Write the failing store test**

In `src/service/conversation-store.test.ts`, add this test after the existing `'persists and reloads task history'` test (around :189):

```ts
  it('persists and reloads a task plan', () => {
    const store = createConversationStore(dbPath)
    const provider = { id: 'anthropic' as const, model: 'claude-sonnet-4-5', apiKey: 'k' }
    store.createSession('ses-p', provider)
    const now = Date.now()
    store.saveTask(
      {
        id: '01HRX0000000000000000000P1',
        parentId: null,
        agentDefId: 'default',
        goal: 'g',
        status: 'running',
        assignedWorkerId: null,
        toolAllowlist: [],
        budget: { tokens: 0, calls: 0, wallMs: 0, usdCents: 0 },
        used: { tokens: 0, calls: 0, wallMs: 0, usdCents: 0 },
        history: [],
        plan: [],
        result: null,
        createdAt: now,
        startedAt: null,
        endedAt: null,
      },
      'ses-p'
    )
    expect(store.getSessionTasks('ses-p')[0].plan).toEqual([])

    store.saveTaskPlan('01HRX0000000000000000000P1', [
      { content: 'step one', status: 'in_progress' },
      { content: 'step two', status: 'pending' },
    ])
    const tasks = store.getSessionTasks('ses-p')
    expect(tasks[0].plan).toEqual([
      { content: 'step one', status: 'in_progress' },
      { content: 'step two', status: 'pending' },
    ])
    store.close()
  })
```

- [ ] **Step 3: Run the test to verify it fails**

Run: `npm test -- src/service/conversation-store.test.ts`
Expected: FAIL — `store.saveTaskPlan is not a function` (and/or `plan` is `undefined`).

- [ ] **Step 4: Add the `plan` column to the tasks table**

In `src/service/conversation-store.ts`, in the `CREATE TABLE IF NOT EXISTS tasks` block, add the column after `attachments` (currently :82):

```sql
      history             TEXT NOT NULL DEFAULT '[]',
      attachments         TEXT NOT NULL DEFAULT '[]',
      plan                TEXT NOT NULL DEFAULT '[]',
      created_at          INTEGER NOT NULL,
```

- [ ] **Step 5: Add the migration for existing DBs**

In the same file, in the `for (const stmt of [...])` ALTER loop (currently :107-112), add a line:

```ts
    `ALTER TABLE tasks ADD COLUMN attachments TEXT NOT NULL DEFAULT '[]'`,
    `ALTER TABLE tasks ADD COLUMN plan TEXT NOT NULL DEFAULT '[]'`,
  ]) {
```

The surrounding `try/catch` already no-ops when the column exists.

- [ ] **Step 6: Parse `plan` in `rowToTask`**

In `rowToTask` (currently :130-146), add after the `attachments` line (:141):

```ts
    attachments: JSON.parse((row.attachments as string) ?? '[]') as Task['attachments'],
    plan: JSON.parse((row.plan as string) ?? '[]') as Task['plan'],
    result: row.result ? (JSON.parse(row.result as string) as Task['result']) : null,
```

- [ ] **Step 7: Persist `plan` in `saveTask`**

Update `stmtInsertTask` (currently :181-187) to include the `plan` column and one more `?`:

```ts
  const stmtInsertTask = db.prepare(
    `INSERT OR REPLACE INTO tasks
     (id, session_id, parent_id, goal, status, result, budget, used,
      agent_def_id, assigned_worker_id, tool_allowlist, history, attachments, plan,
      created_at, started_at, ended_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
  )
```

Then in the `saveTask` method body (currently :275-294), add the `plan` arg right after the `attachments` arg:

```ts
        JSON.stringify(task.attachments ?? []),
        JSON.stringify(task.plan ?? []),
        task.createdAt,
```

(`?? []` keeps older callers/tests that omit `plan` working.)

- [ ] **Step 8: Add the `saveTaskPlan` prepared statement, interface entry, and method**

Add the prepared statement next to `stmtSetTaskHistory` (currently :201):

```ts
  const stmtSetTaskHistory = db.prepare('UPDATE tasks SET history = ? WHERE id = ?')
  const stmtSetTaskPlan = db.prepare('UPDATE tasks SET plan = ? WHERE id = ?')
```

Add to the `ConversationStore` type, right after the `saveTaskHistory` line (:38):

```ts
  saveTaskHistory(taskId: string, history: import('@shared/types/task').TaskEvent[]): void
  saveTaskPlan(taskId: string, plan: Task['plan']): void
```

Add the method in the returned object, right after `saveTaskHistory` (:272-274):

```ts
    saveTaskHistory(taskId, history) {
      stmtSetTaskHistory.run(JSON.stringify(history), taskId)
    },
    saveTaskPlan(taskId, plan) {
      stmtSetTaskPlan.run(JSON.stringify(plan), taskId)
    },
```

- [ ] **Step 9: Run the test to verify it passes**

Run: `npm test -- src/service/conversation-store.test.ts`
Expected: PASS (all tests in the file, including the new one and the existing history/task tests).

- [ ] **Step 10: Commit**

```bash
git add src/shared/types/task.ts src/service/conversation-store.ts src/service/conversation-store.test.ts
git commit -m "feat(store): persist task plan as a first-class column"
```

---

## Task 2: Save the plan eagerly on every `task.plan` event

**Files:**
- Modify: `src/service/session-manager.ts:116-133` (`makeEmit`)

**Note on testing:** `makeEmit` is a private closure fired only during a live agent run; `session-manager` has no unit-test harness and `createAgentRunner` is not injectable, so there is no cheap, non-brittle unit test for this seam. This branch is a 3-line mirror of the adjacent `saveTaskHistory` branch (verified by Task 1's store test) and is verified here by typecheck + lint. Do not fabricate a fake-runner harness for it.

- [ ] **Step 1: Add the eager-persist branch in `makeEmit`**

In `src/service/session-manager.ts`, inside `makeEmit`, add a branch after the existing `task.complete`/`task.error` block (currently ending :131), before `broadcaster.broadcast(...)`:

```ts
      if ((event === 'task.complete' || event === 'task.error') && taskId) {
        store.saveTaskHistory(taskId, historyByTask.get(taskId) ?? [])
        historyByTask.delete(taskId)
      }
      if (event === 'task.plan' && taskId && Array.isArray(obj?.todos)) {
        const todos = obj.todos as import('@shared/types/task').PlanTodo[]
        store.saveTaskPlan(taskId, todos)
        log.debug({ msg: 'plan persisted', taskId, steps: todos.length })
      }
      broadcaster.broadcast(event, payload)
```

`log` is the module logger already defined at the top of this file (`createLogger(...).child({ component: 'session-manager' })`, :21). The `task.plan` event shape (`{ taskId, todos, ts }`) is emitted at `agent-runner.ts:179`.

- [ ] **Step 2: Verify typecheck and lint pass**

Run: `npm run typecheck:node`
Expected: no errors.

Run: `npx biome check --write src/service/session-manager.ts`
Expected: no errors; file untouched or only formatted.

- [ ] **Step 3: Run the service test suite to confirm no regressions**

Run: `npm test -- src/service/`
Expected: PASS (existing dispatcher/store/tool tests stay green).

- [ ] **Step 4: Commit**

```bash
git add src/service/session-manager.ts
git commit -m "feat(session-manager): persist plan eagerly on task.plan event"
```

---

## Task 3: Rehydrate the plan when rebuilding task records on reload

**Files:**
- Modify: `src/renderer/src/lib/replay.ts:39-49` (`tasksToRecords` return object)
- Test: `src/renderer/src/lib/replay.test.ts`

- [ ] **Step 1: Write the failing rehydration test**

In `src/renderer/src/lib/replay.test.ts`, add inside the `describe('tasksToRecords', ...)` block:

```ts
  it('rehydrates a persisted plan onto the record', () => {
    const records = tasksToRecords('ses-1', [
      baseTask({
        plan: [
          { content: 'step one', status: 'completed' },
          { content: 'step two', status: 'in_progress' },
        ],
      }),
    ])
    expect(records[0].plan).toEqual([
      { content: 'step one', status: 'completed' },
      { content: 'step two', status: 'in_progress' },
    ])
  })

  it('leaves plan undefined when the persisted plan is empty', () => {
    const records = tasksToRecords('ses-1', [baseTask({ plan: [] })])
    expect(records[0].plan).toBeUndefined()
  })
```

`baseTask` (test helper at the top of the file) spreads `...over`, so passing `plan` works once the schema field from Task 1 exists. The helper's base object does not list `plan`; add `plan: [],` to it (after `history: [],` at :17) so it satisfies the `Task` type:

```ts
  history: [],
  plan: [],
  attachments: [],
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `npm test -- src/renderer/src/lib/replay.test.ts`
Expected: FAIL — `records[0].plan` is `undefined` for the populated case (no plan wiring yet).

- [ ] **Step 3: Set `plan` on the rebuilt record**

In `src/renderer/src/lib/replay.ts`, in the object returned by `tasksToRecords` (currently :39-49), add `plan` after `attachments` (:47):

```ts
      startedAt: t.createdAt,
      attachments: t.attachments,
      plan: t.plan.length ? t.plan : undefined,
      events,
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `npm test -- src/renderer/src/lib/replay.test.ts`
Expected: PASS (both new tests and the existing `tasksToRecords` tests).

- [ ] **Step 5: Commit**

```bash
git add src/renderer/src/lib/replay.ts src/renderer/src/lib/replay.test.ts
git commit -m "feat(renderer): rehydrate persisted plan into task records on reload"
```

---

## Final verification

- [ ] **Run the full test suite**

Run: `npm test`
Expected: PASS across service + renderer suites.

- [ ] **Manual smoke check (optional, via run-desktop skill)**

Launch the app, give the agent a multi-step goal so it calls `update_plan`, confirm the PlanPanel populates, quit the app mid-task, relaunch, reopen the session, and confirm the PlanPanel shows the last plan snapshot with per-step statuses intact.
