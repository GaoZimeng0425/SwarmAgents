# Error Persistence Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Persist task errors (including user cancellation) into task history so the error message reappears on reload, instead of vanishing.

**Architecture:** Errors are emitted as ephemeral top-level `task.error` events that never enter persisted history. We centralize a fix in `session-manager`: synthesize a persistable `kind:'error'` `TaskEvent` into the history buffer on every `task.error` and on uncaught `runTurn` throws. A small `task-segments` tweak makes a persisted error render identically to the live one. No `agent-runner` or `replay.ts` change.

**Tech Stack:** TypeScript, Vitest (run via `npm test`), better-sqlite3 (service store), React (renderer transcript).

Spec: `docs/superpowers/specs/2026-06-16-error-persistence-design.md`

---

## File Structure

- `src/renderer/src/lib/task-segments.ts` — unify the `ev.kind === 'error'` render branch with the live `task.error` branch (read path).
- `src/renderer/src/lib/task-segments.test.ts` — failing-first test for the persisted-error render.
- `src/service/session-manager.ts` — `appendError` closure; persist error in `makeEmit` on `task.error` and in the `runTurn` catch (write path).

Test runner for every `Run:` step: `npm test -- <test-file>`
(`npm test` = `cross-env ELECTRON_RUN_AS_NODE=1 electron node_modules/vitest/vitest.mjs run`. Never bare `npx vitest`.)

Do Task 1 before Task 2: Task 1 establishes that a persisted `kind:'error'` event renders correctly; Task 2 produces those persisted events.

---

## Task 1: Render a persisted error like the live one

**Files:**
- Modify: `src/renderer/src/lib/task-segments.ts` (the `ev.kind === 'error'` branch, ~lines 103-104)
- Test: `src/renderer/src/lib/task-segments.test.ts`

**Background:** A task's transcript is built by `taskSegments(task)`. Live errors arrive as a top-level `task.error` event and render as a `{ kind: 'error', label: 'error' | 'stopped', detail }` segment (cancelled → `stopped`). After reload, the same error is replayed as a `task.progress` wrapping a `{ kind: 'error', error: { code, message, tier } }` `TaskEvent` — but the current `ev.kind === 'error'` branch renders it as a generic `{ kind: 'event', label: 'error' }` segment and ignores `cancelled`. This task makes the two paths identical.

The test file already has helpers near the top: `rec(events)` builds a `TaskRecord`, and `prog(event)` wraps a `TaskEvent` as a `task.progress` UIEvent.

- [ ] **Step 1: Write the failing test**

In `src/renderer/src/lib/task-segments.test.ts`, add this test inside the `describe('taskSegments', ...)` block, right after the existing `'labels a cancelled task.error as "stopped", others as "error"'` test:

```ts
  it('renders a persisted kind:error progress event like a live task.error', () => {
    const failed = taskSegments(
      rec([prog({ kind: 'error', error: { code: 'boom', message: 'nope', tier: 'fatal' }, ts: 1 })])
    )
    expect(failed.find((s) => s.kind === 'error')).toMatchObject({ label: 'error', detail: 'nope' })

    const stopped = taskSegments(
      rec([prog({ kind: 'error', error: { code: 'cancelled', message: 'Stopped by user.', tier: 'gave_up' }, ts: 1 })])
    )
    expect(stopped.find((s) => s.kind === 'error')).toMatchObject({ label: 'stopped', detail: 'Stopped by user.' })
  })
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `npm test -- src/renderer/src/lib/task-segments.test.ts`
Expected: FAIL — `expect(...).toMatchObject` gets `undefined` because the current branch emits a `kind: 'event'` segment, so `.find(s => s.kind === 'error')` returns nothing.

- [ ] **Step 3: Update the render branch**

In `src/renderer/src/lib/task-segments.ts`, find the `ev.kind === 'error'` branch (currently):

```ts
      } else if (ev.kind === 'error') {
        out.push({ kind: 'event', label: 'error', detail: ev.error.message ?? 'error', key, taskId: task.id })
```

Replace it with (mirroring the live `task.error` branch's label logic):

```ts
      } else if (ev.kind === 'error') {
        const label = ev.error.code === 'cancelled' ? 'stopped' : 'error'
        out.push({ kind: 'error', label, detail: ev.error.message ?? 'error', key, taskId: task.id })
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `npm test -- src/renderer/src/lib/task-segments.test.ts`
Expected: PASS (the new test plus all existing `taskSegments` tests, including the live-`task.error` one).

- [ ] **Step 5: Commit**

```bash
git add src/renderer/src/lib/task-segments.ts src/renderer/src/lib/task-segments.test.ts
git commit -m "fix(renderer): render persisted error events like live task.error"
```

---

## Task 2: Persist errors into task history

**Files:**
- Modify: `src/service/session-manager.ts` (add `appendError`; branch in `makeEmit`; flush in `runTurn` catch)

**Note on testing:** Both edits live in private, non-injectable seams — `makeEmit` is a closure fired only during a live agent run, and the `runTurn` catch only triggers on a thrown run; `session-manager` has no unit-test harness and `createAgentRunner` is not injectable. There is no cheap, non-brittle unit test here (same situation as prior session-manager work). Persistence of a `kind:'error'` `TaskEvent` is already covered by the existing `conversation-store` history round-trip test, and rendering is covered by Task 1. Verify this task by typecheck + lint + the existing service suite. Do NOT fabricate a fake-runner harness.

`TaskEvent` is already imported in this file (`import type { Task, TaskEvent, TaskResult } from '@shared/types/task'`). `historyByTask` is a `Map<string, TaskEvent[]>` defined inside `createSessionManager`.

- [ ] **Step 1: Add the `appendError` closure**

In `src/service/session-manager.ts`, immediately after the `const historyByTask = new Map<string, TaskEvent[]>()` line, add:

```ts
  const appendError = (taskId: string, error: unknown): void => {
    const buf = historyByTask.get(taskId) ?? []
    buf.push({ kind: 'error', error: error as Extract<TaskEvent, { kind: 'error' }>['error'], ts: Date.now() })
    historyByTask.set(taskId, buf)
  }
```

Define it before `makeEmit` so it's in scope at call time.

- [ ] **Step 2: Persist emitted errors in `makeEmit`**

In `makeEmit`, insert a new branch between the `task.progress` buffering branch and the `task.complete`/`task.error` flush branch, so it reads:

```ts
      if (event === 'task.progress' && taskId && obj?.event) {
        const buf = historyByTask.get(taskId) ?? []
        buf.push(obj.event as TaskEvent)
        historyByTask.set(taskId, buf)
      }
      if (event === 'task.error' && taskId && obj?.error) {
        appendError(taskId, obj.error)
      }
      if ((event === 'task.complete' || event === 'task.error') && taskId) {
        store.saveTaskHistory(taskId, historyByTask.get(taskId) ?? [])
        historyByTask.delete(taskId)
      }
```

Order matters: the error must be appended to the buffer *before* the flush branch runs, so `saveTaskHistory` persists it. The synthesized event is buffered only (not broadcast), so the live UI still renders via the original top-level `task.error` — no double render.

- [ ] **Step 3: Persist history on uncaught throws in the `runTurn` catch**

In the `runTurn` function's `catch (err)` block (currently it logs then only calls `updateTaskStatus(taskId, 'failed')`), change it to append a synthesized error and flush the buffer first:

```ts
        } catch (err) {
          log.error({ msg: 'runTurn failed', taskId, err: err instanceof Error ? err.message : String(err) })
          appendError(taskId, {
            code: 'run_failed',
            message: err instanceof Error ? err.message : String(err),
            tier: 'fatal',
          })
          try {
            store.saveTaskHistory(taskId, historyByTask.get(taskId) ?? [])
            historyByTask.delete(taskId)
          } catch (histErr) {
            log.error({ msg: 'failed to persist history on failure', taskId, err: String(histErr) })
          }
          try {
            store.updateTaskStatus(taskId, 'failed')
          } catch (statusErr) {
            log.error({ msg: 'failed to mark task failed', taskId, err: String(statusErr) })
          }
        } finally {
```

(This path only runs when `run()` throws — in that case `makeEmit` never saw a `task.complete`/`task.error`, so the buffer was never flushed. When `run()` instead returns after emitting `task.error`, `makeEmit` already persisted; this catch does not run, so there is no double save.)

- [ ] **Step 4: Verify typecheck passes**

Run: `npm run typecheck:node`
Expected: no errors.

- [ ] **Step 5: Verify lint passes (scoped to the file)**

Run: `npx biome check --write src/service/session-manager.ts`
Expected: no errors (file untouched or only auto-formatted). Do NOT run `npm run check` / bare `biome check` — those reformat the whole repo.

- [ ] **Step 6: Run the service suite for regressions**

Run: `npm test -- src/service/`
Expected: PASS (existing dispatcher/store/tool tests stay green).

- [ ] **Step 7: Commit**

```bash
git add src/service/session-manager.ts
git commit -m "feat(session-manager): persist task errors into history"
```

---

## Final verification

- [ ] **Run the full suite**

Run: `npm test`
Expected: PASS across service + renderer suites.

- [ ] **Manual smoke check (optional, via run-desktop skill)**

Launch the app, submit a goal that fails (e.g. clear the provider API key, or cancel a running task), confirm the error/stopped item appears in the transcript, quit the app, relaunch, reopen the session, and confirm the error/stopped item is still shown.
