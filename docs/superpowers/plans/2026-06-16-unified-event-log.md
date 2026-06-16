# Unified Durable Event Log Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Persist every task event to an append-only log at emit time and persist the agent message context every turn, so push (live) and pull (reload) derive from one durable source and a process kill loses at most the current turn's tail.

**Architecture:** Replace the in-memory `historyByTask` buffer + end-of-task `saveTaskHistory` flush with a `task_events` append-only table written on each emit; reconstruct `history` from it on read; backfill the legacy `tasks.history` column once. Collapse `makeEmit` into a single sink (append + broadcast). Add a `saveSnapshot` callback the runner calls on each `turn_end` to persist `agent.state.messages` + usage incrementally.

**Tech Stack:** TypeScript, better-sqlite3 (WAL), Vitest (run via `npm test`), Electron utilityProcess (service), pi-agent-core (`Agent`).

Spec: `docs/superpowers/specs/2026-06-16-unified-event-log-design.md`

---

## File Structure

- `src/service/conversation-store.ts` — `task_events` table, `appendTaskEvent`, history reconstruction, backfill, delete-FK; transitional `saveTaskHistory` shim (removed in Task 2).
- `src/service/conversation-store.test.ts` — tests for append/reconstruct, backfill, delete-FK.
- `src/service/session-manager.ts` — single `makeEmit` sink; `saveSnapshot` wiring; remove buffer + redundant end-of-run saves.
- `src/service/agent-runner.ts` — `saveSnapshot` dep called on `turn_end`.

Test runner for every `Run:` step: `npm test -- <test-file>`
(`npm test` = `cross-env ELECTRON_RUN_AS_NODE=1 electron node_modules/vitest/vitest.mjs run`. Never bare `npx vitest` — better-sqlite3 needs the Electron ABI.)

**Sequencing (each task leaves the build green):** Task 1 adds the table + `appendTaskEvent` + read-from-events + backfill, and re-implements `saveTaskHistory` as a shim onto `task_events` so its only caller (session-manager) keeps working. Task 2 switches session-manager to `appendTaskEvent` and deletes the now-dead shim. Task 3 adds per-turn context persistence.

---

## Task 1: `task_events` append-only store + backfill

**Files:**
- Modify: `src/service/conversation-store.ts`
- Test: `src/service/conversation-store.test.ts`

`TaskEvent` is not imported in this file; use the inline `import('@shared/types/task').TaskEvent` form (the existing `saveTaskHistory` type already does this). `rowToTask` is an arrow defined before the prepared statements but only *called* from `getSessionTasks` at runtime, so it may reference statements declared later.

`saveTask` is left unchanged — it keeps writing the `history` column. For new tasks that column is always `'[]'` (runtime history starts empty and is never re-saved through `saveTask`), so reads ignore it; it serves only as the backfill source for legacy rows, and keeping the write lets the backfill test seed a legacy row via `saveTask`. (The spec mentions "stops writing the column"; keeping the harmless write avoids re-editing the placeholder-sensitive 17-column INSERT and is functionally equivalent.)

- [ ] **Step 1: Write failing tests**

In `src/service/conversation-store.test.ts`, add these three tests inside the top-level `describe('ConversationStore', ...)` block (after the existing `'persists and reloads task history'` test). They use full task literals like the existing tests:

```ts
  const taskLiteral = (id: string, history: import('@shared/types/task').TaskEvent[] = []) => ({
    id,
    parentId: null,
    agentDefId: 'default',
    goal: 'g',
    status: 'running' as const,
    assignedWorkerId: null,
    toolAllowlist: [] as string[],
    budget: { tokens: 0, calls: 0, wallMs: 0, usdCents: 0 },
    used: { tokens: 0, calls: 0, wallMs: 0, usdCents: 0 },
    history,
    plan: [],
    result: null,
    createdAt: 1,
    startedAt: null,
    endedAt: null,
  })

  it('appends events and reconstructs history in insertion order', () => {
    const store = createConversationStore(dbPath)
    const provider = { id: 'anthropic' as const, model: 'claude-sonnet-4-5', apiKey: 'k' }
    store.createSession('ses-e', provider)
    store.saveTask(taskLiteral('01HRX0000000000000000000E1'), 'ses-e')
    store.appendTaskEvent('01HRX0000000000000000000E1', { kind: 'reasoning', content: 'a', ts: 1 })
    store.appendTaskEvent('01HRX0000000000000000000E1', { kind: 'llm.message', role: 'assistant', content: 'b', ts: 2 })
    expect(store.getSessionTasks('ses-e')[0].history).toEqual([
      { kind: 'reasoning', content: 'a', ts: 1 },
      { kind: 'llm.message', role: 'assistant', content: 'b', ts: 2 },
    ])
    store.close()
  })

  it('backfills legacy tasks.history into task_events on open, without duplicating', () => {
    const provider = { id: 'anthropic' as const, model: 'claude-sonnet-4-5', apiKey: 'k' }
    const legacy: import('@shared/types/task').TaskEvent[] = [
      { kind: 'reasoning', content: 'x', ts: 1 },
      { kind: 'error', error: { code: 'boom', message: 'nope', tier: 'fatal' }, ts: 2 },
    ]
    const store1 = createConversationStore(dbPath)
    store1.createSession('ses-b', provider)
    store1.saveTask(taskLiteral('01HRX0000000000000000000B1', legacy), 'ses-b') // writes the history column
    store1.close()

    const store2 = createConversationStore(dbPath) // backfill runs on open
    expect(store2.getSessionTasks('ses-b')[0].history).toEqual(legacy)
    store2.close()

    const store3 = createConversationStore(dbPath) // re-open must not duplicate
    expect(store3.getSessionTasks('ses-b')[0].history).toHaveLength(2)
    store3.close()
  })

  it('deletes task_events when its session is deleted', () => {
    const store = createConversationStore(dbPath)
    const provider = { id: 'anthropic' as const, model: 'claude-sonnet-4-5', apiKey: 'k' }
    store.createSession('ses-d', provider)
    store.saveTask(taskLiteral('01HRX0000000000000000000D1'), 'ses-d')
    store.appendTaskEvent('01HRX0000000000000000000D1', { kind: 'reasoning', content: 'a', ts: 1 })
    store.deleteSession('ses-d') // must not throw on the task_events FK
    expect(store.getSessionTasks('ses-d')).toEqual([])
    store.close()
  })
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npm test -- src/service/conversation-store.test.ts`
Expected: FAIL — `store.appendTaskEvent is not a function`.

- [ ] **Step 3: Create the `task_events` table**

In the `db.exec(\`...\`)` schema block, after the `CREATE INDEX IF NOT EXISTS idx_tasks_session ...` line, add:

```sql
    CREATE TABLE IF NOT EXISTS task_events (
      id       INTEGER PRIMARY KEY,
      task_id  TEXT NOT NULL REFERENCES tasks(id),
      event    TEXT NOT NULL,
      ts       INTEGER NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_task_events_task ON task_events(task_id, id);
```

- [ ] **Step 4: Add prepared statements**

Next to `const stmtSetTaskHistory = ...` add:

```ts
  const stmtInsertTaskEvent = db.prepare('INSERT INTO task_events (task_id, event, ts) VALUES (?, ?, ?)')
  const stmtGetTaskEvents = db.prepare('SELECT event FROM task_events WHERE task_id = ? ORDER BY id')
  const stmtCountTaskEvents = db.prepare('SELECT COUNT(*) AS n FROM task_events WHERE task_id = ?')
  const stmtDeleteTaskEvents = db.prepare('DELETE FROM task_events WHERE task_id = ?')
```

Then DELETE the now-unused `const stmtSetTaskHistory = db.prepare('UPDATE tasks SET history = ? WHERE id = ?')` line (the shim in Step 8 replaces its use).

- [ ] **Step 5: Reconstruct `history` from `task_events` in `rowToTask`**

In `rowToTask`, replace the line:

```ts
    history: JSON.parse((row.history as string) ?? '[]') as Task['history'],
```

with:

```ts
    history: (stmtGetTaskEvents.all(row.id as string) as { event: string }[]).map((r) => JSON.parse(r.event)) as Task['history'],
```

- [ ] **Step 6: Add `task_events` cleanup to `deleteSessionTx`**

In `deleteSessionTx`, add a line before the `DELETE FROM tasks` line:

```ts
    db.prepare('DELETE FROM task_events WHERE task_id IN (SELECT id FROM tasks WHERE session_id = ?)').run(id)
    db.prepare('DELETE FROM tasks WHERE session_id = ?').run(id)
```

- [ ] **Step 7: Add the idempotent backfill**

Immediately before the `return {` of `createConversationStore` (after all prepared statements and `deleteSessionTx` are defined), add:

```ts
  // One-time migration: carry forward transcripts persisted in the legacy
  // tasks.history column into task_events. Idempotent — skips any task that
  // already has events. New tasks never populate the column, so they're skipped.
  const backfillTaskEvents = db.transaction(() => {
    const rows = db
      .prepare("SELECT id, history FROM tasks WHERE history IS NOT NULL AND history != '[]'")
      .all() as { id: string; history: string }[]
    for (const r of rows) {
      if ((stmtCountTaskEvents.get(r.id) as { n: number }).n > 0) continue
      let events: unknown
      try {
        events = JSON.parse(r.history)
      } catch {
        continue
      }
      if (!Array.isArray(events)) continue
      for (const ev of events) {
        const ts = (ev as { ts?: number }).ts ?? 0
        stmtInsertTaskEvent.run(r.id, JSON.stringify(ev), ts)
      }
    }
  })
  backfillTaskEvents()
```

- [ ] **Step 8: Add `appendTaskEvent`; re-implement `saveTaskHistory` as a transitional shim**

In the `ConversationStore` type, after the `saveTaskHistory(...)` line, add:

```ts
  saveTaskHistory(taskId: string, history: import('@shared/types/task').TaskEvent[]): void
  appendTaskEvent(taskId: string, event: import('@shared/types/task').TaskEvent): void
```

In the returned object, replace the existing `saveTaskHistory` method:

```ts
    saveTaskHistory(taskId, history) {
      stmtSetTaskHistory.run(JSON.stringify(history), taskId)
    },
```

with the shim plus the new method:

```ts
    saveTaskHistory(taskId, history) {
      // Transitional: route the legacy whole-array save through task_events so
      // the existing caller keeps working until it switches to appendTaskEvent.
      const replace = db.transaction(() => {
        stmtDeleteTaskEvents.run(taskId)
        for (const ev of history) stmtInsertTaskEvent.run(taskId, JSON.stringify(ev), ev.ts)
      })
      replace()
    },
    appendTaskEvent(taskId, event) {
      stmtInsertTaskEvent.run(taskId, JSON.stringify(event), event.ts)
    },
```

- [ ] **Step 9: Run tests to verify they pass**

Run: `npm test -- src/service/conversation-store.test.ts`
Expected: PASS (the three new tests and all existing ones, including `'persists and reloads task history'`, which now round-trips through the shim).

- [ ] **Step 10: Verify typecheck**

Run: `npm run typecheck:node`
Expected: no errors.

- [ ] **Step 11: Commit**

```bash
git add src/service/conversation-store.ts src/service/conversation-store.test.ts
git commit -m "feat(store): add append-only task_events log with backfill"
```

---

## Task 2: Collapse `makeEmit` into one append-on-emit sink

**Files:**
- Modify: `src/service/session-manager.ts`
- Modify: `src/service/conversation-store.ts` (remove the now-dead `saveTaskHistory` shim)
- Modify: `src/service/conversation-store.test.ts` (drop the test that used `saveTaskHistory`)

**Note on testing:** `makeEmit` and the `runTurn` catch are private, non-injectable seams (no `session-manager` test harness; `createAgentRunner` is not injectable). The durable behavior is covered by Task 1's store tests. Verify by typecheck + lint + the service suite. Do NOT fabricate a fake-runner harness.

- [ ] **Step 1: Rewrite `makeEmit` and remove the buffer**

In `src/service/session-manager.ts`, delete the `const historyByTask = new Map<string, TaskEvent[]>()` line and the `const appendError = (taskId, error) => { ... }` closure. Replace the entire `makeEmit` definition with:

```ts
  const makeEmit =
    (sessionId: string) =>
    (event: string, data: unknown): void => {
      const obj = data && typeof data === 'object' ? (data as Record<string, unknown>) : undefined
      const payload = obj ? { sessionId, ...obj } : data
      const taskId = obj?.taskId as string | undefined

      if (event === 'task.progress' && taskId && obj?.event) {
        store.appendTaskEvent(taskId, obj.event as TaskEvent)
      }
      if (event === 'task.error' && taskId && obj?.error) {
        store.appendTaskEvent(taskId, {
          kind: 'error',
          error: obj.error as Extract<TaskEvent, { kind: 'error' }>['error'],
          ts: Date.now(),
        })
      }
      if (event === 'task.plan' && taskId && Array.isArray(obj?.todos)) {
        const todos = obj.todos as import('@shared/types/task').PlanTodo[]
        store.saveTaskPlan(taskId, todos)
        log.debug({ msg: 'plan persisted', taskId, steps: todos.length })
      }
      broadcaster.broadcast(event, payload)
    }
```

- [ ] **Step 2: Simplify the `runTurn` catch block**

Replace the `catch (err)` block in `runTurn` (which currently calls `appendError` + `saveTaskHistory` + `updateTaskStatus`) with:

```ts
        } catch (err) {
          log.error({ msg: 'runTurn failed', taskId, err: err instanceof Error ? err.message : String(err) })
          try {
            store.appendTaskEvent(taskId, {
              kind: 'error',
              error: { code: 'run_failed', message: err instanceof Error ? err.message : String(err), tier: 'fatal' },
              ts: Date.now(),
            })
          } catch (appendErr) {
            log.error({ msg: 'failed to persist error event', taskId, err: String(appendErr) })
          }
          try {
            store.updateTaskStatus(taskId, 'failed')
          } catch (statusErr) {
            log.error({ msg: 'failed to mark task failed', taskId, err: String(statusErr) })
          }
        } finally {
```

- [ ] **Step 3: Remove the now-unused `TaskEvent` buffer import if dangling**

`TaskEvent` is still used (the casts in `makeEmit`), so keep the import `import type { Task, TaskEvent, TaskResult } from '@shared/types/task'`. Confirm no remaining reference to `historyByTask` or `appendError`:

Run: `grep -n "historyByTask\|appendError" src/service/session-manager.ts`
Expected: no output.

- [ ] **Step 4: Remove the dead `saveTaskHistory` shim from the store**

In `src/service/conversation-store.ts`, delete the `saveTaskHistory(taskId: string, ...): void` line from the `ConversationStore` type, delete the `saveTaskHistory(taskId, history) { ... }` method (the shim) from the returned object, and delete the now-unused `stmtDeleteTaskEvents` statement ONLY IF it is no longer referenced (it is used solely by the shim — remove it too).

Run: `grep -n "saveTaskHistory\|stmtDeleteTaskEvents" src/service/conversation-store.ts`
Expected: no output.

- [ ] **Step 5: Drop the store test that used `saveTaskHistory`**

In `src/service/conversation-store.test.ts`, delete the `it('persists and reloads task history', ...)` test (its behavior is now covered by `'appends events and reconstructs history in insertion order'`).

Run: `grep -n "saveTaskHistory" src/service/conversation-store.test.ts`
Expected: no output.

- [ ] **Step 6: Verify typecheck + lint**

Run: `npm run typecheck:node`
Expected: no errors.

Run: `npx biome check --write src/service/session-manager.ts src/service/conversation-store.ts`
Expected: no errors (files untouched or only auto-formatted). Do NOT run `npm run check` / bare `biome check`.

- [ ] **Step 7: Run the service suite**

Run: `npm test -- src/service/`
Expected: PASS (store tests + dispatcher/tool tests green).

- [ ] **Step 8: Commit**

```bash
git add src/service/session-manager.ts src/service/conversation-store.ts src/service/conversation-store.test.ts
git commit -m "refactor(session-manager): append events on emit, drop history buffer"
```

---

## Task 3: Persist agent context + usage every turn

**Files:**
- Modify: `src/service/agent-runner.ts` (`AgentRunnerDeps` + `turn_end` handler)
- Modify: `src/service/session-manager.ts` (wire `saveSnapshot`; drop redundant end-of-run saves)

**Note on testing:** the `turn_end` callback and its wiring are private, non-injectable seams (a live `Agent` is required to fire `turn_end`). Verify by typecheck + lint + the service suite. `AgentMessage` and `ResourceBudget` are already imported in both files.

- [ ] **Step 1: Add `saveSnapshot` to `AgentRunnerDeps`**

In `src/service/agent-runner.ts`, in the `AgentRunnerDeps` type, add (after the `signal?: AbortSignal` line):

```ts
  /** Persist the conversation + usage at each turn boundary so they survive an interrupt. */
  saveSnapshot?(messages: AgentMessage[], used: ResourceBudget): void
```

- [ ] **Step 2: Call `saveSnapshot` on `turn_end`**

In the `agent.subscribe((e) => { ... })` handler, inside the `if (e.type === 'turn_end') {` block, after the `emit('task.usage', { ... })` call, add:

```ts
        deps.saveSnapshot?.(agent.state.messages, snapshotUsed())
```

(`deps`, `agent`, and `snapshotUsed` are all in scope in the run closure.)

- [ ] **Step 3: Wire `saveSnapshot` in session-manager and drop redundant end-of-run saves**

In `src/service/session-manager.ts`, in the top-level task runner created inside `submitGoal`'s `runTurn`, add the `saveSnapshot` dep to the `createAgentRunner({ ... })` call (e.g. after the `initialMessages: session.messages,` line):

```ts
          saveSnapshot: (messages, used) => {
            session.messages = messages
            store.saveAgentSnapshot(sessionId, messages)
            store.saveTaskUsage(taskId, used)
          },
```

Then replace the post-`run()` block:

```ts
        try {
          const { status, messages, used } = await runner.run()
          if (messages) {
            session.messages = messages
            store.saveAgentSnapshot(sessionId, messages)
          }
          if (used) store.saveTaskUsage(taskId, used)
          store.updateTaskStatus(taskId, status)
        } catch (err) {
```

with (the per-turn `saveSnapshot` now owns context + usage persistence; the end path only finalizes status):

```ts
        try {
          const { status } = await runner.run()
          store.updateTaskStatus(taskId, status)
        } catch (err) {
```

Leave `spawnChild`'s `createAgentRunner` call unchanged — child runners omit `saveSnapshot` (one-shot sub-agents are not resumed; their transcript events still persist via the sink).

- [ ] **Step 4: Verify typecheck + lint**

Run: `npm run typecheck:node`
Expected: no errors.

Run: `npx biome check --write src/service/agent-runner.ts src/service/session-manager.ts`
Expected: no errors (files untouched or only auto-formatted).

- [ ] **Step 5: Run the service suite**

Run: `npm test -- src/service/`
Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add src/service/agent-runner.ts src/service/session-manager.ts
git commit -m "feat(agent): persist conversation + usage on each turn"
```

---

## Final verification

- [ ] **Run the full suite + full typecheck**

Run: `npm test`
Expected: PASS across service + renderer suites.

Run: `npm run typecheck`
Expected: clean (node + web).

- [ ] **Manual smoke check (optional, via run-desktop skill)**

Launch the app, run a multi-step goal so several events stream in, **force-quit mid-run**, relaunch, reopen the session: confirm the transcript up to the last completed turn (assistant text, tool calls, any error) is present — not just what existed at the previous task's end.
