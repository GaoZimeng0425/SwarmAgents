# Error Persistence — Design

**Date:** 2026-06-16
**Status:** Approved, ready for implementation plan

## Problem

When a task fails (or is cancelled), the error message item shows in the live
transcript but **disappears after reload** (app restart / switching away and
back). The error text is not persisted anywhere.

Root cause:

- Errors are emitted as **top-level `task.error` events** (`agent-runner.ts`
  lines 239, 277, 454, 469, 491), all with the same payload shape
  `{ code, message, tier }`.
- In `session-manager.ts`'s `makeEmit`, only `task.progress` events are buffered
  into the in-memory `historyByTask` map. A `task.error` is **not** a
  `task.progress`, so it never enters the buffer — and `saveTaskHistory` (which
  fires on `task.complete`/`task.error`) persists a buffer that lacks the error.
- On reload, `replay.ts`'s `tasksToRecords` rebuilds events only from persisted
  `history` (+ a synthetic `task.complete` if there's a result). It never
  reconstructs a `task.error`. So the error segment vanishes.
- Worse path: if `runner.run()` **throws** (uncaught), the `runTurn` catch block
  (`session-manager.ts:306`) only calls `updateTaskStatus('failed')` — no
  `saveTaskHistory` at all, so the entire task's transcript since start is lost.

Note: `TaskEventSchema` already has a `kind: 'error'` variant
(`{ error: { code, message, tier }, ts }`) and the renderer already knows how to
render it (`task-segments.ts:103-104`), but `agent-runner` never emits it — it
only uses the top-level `task.error`. That persistable channel is unused.

## Scope

In scope: persist task errors (including user cancellation) into task history so
they reappear on reload, covering both failure paths (emitted `task.error` and
uncaught throw in `runTurn`).

Decisions:

- **Cancellation is persisted too.** `cancelled` is delivered as a `task.error`
  with `code: 'cancelled'`; the renderer labels it "stopped". Persisting it keeps
  reload identical to live. (Approved.)

Out of scope: error UI styling changes, retry/re-run, transcript recovery beyond
errors (the general "history flushes only at task end" behavior is unchanged
except that the catch path now flushes too).

## Design (Approach A — centralize in `session-manager`)

Turn errors into persistable `kind: 'error'` `TaskEvent`s at the single point
where history is buffered/flushed. No `agent-runner` change. No `replay.ts`
change — reload reconstruction already renders a persisted `kind: 'error'` event.

### 1. Write path — `src/service/session-manager.ts`

Add a small closure inside `createSessionManager` (where `historyByTask` lives):

```ts
const appendError = (taskId: string, error: unknown): void => {
  const buf = historyByTask.get(taskId) ?? []
  buf.push({ kind: 'error', error: error as Extract<TaskEvent, { kind: 'error' }>['error'], ts: Date.now() })
  historyByTask.set(taskId, buf)
}
```

**a) Emitted errors — in `makeEmit`:** when `event === 'task.error' && taskId &&
obj?.error`, call `appendError(taskId, obj.error)` *before* the existing
`task.complete`/`task.error` → `saveTaskHistory` flush runs. The error then sits
in the buffer that gets persisted. (The synthesized event is buffered only, not
broadcast — live UI still renders via the original top-level `task.error`, so no
double render.)

**b) Uncaught throws — in the `runTurn` catch block** (`session-manager.ts:306`):
before marking the task failed, persist what ran plus a synthesized error:

```ts
} catch (err) {
  log.error({ msg: 'runTurn failed', taskId, err: err instanceof Error ? err.message : String(err) })
  appendError(taskId, { code: 'run_failed', message: err instanceof Error ? err.message : String(err), tier: 'fatal' })
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
} finally { ... }
```

### 2. Read path — no change

Once an error is a `kind: 'error'` `TaskEvent` in `tasks.history`,
`replay.tasksToRecords` replays it as a `task.progress`, and `task-segments.ts`
(lines 103-104) renders it as an `error` segment. Reload == live.

## Data flow

```
task fails / cancelled
  → agent-runner emits task.error {taskId, error:{code,message,tier}}   (live, unchanged)
  → session-manager makeEmit: appendError(taskId, error)  → buffer
  → existing flush: saveTaskHistory(taskId, buffer incl. error)         → tasks.history

uncaught throw in runTurn
  → catch: appendError + saveTaskHistory + updateTaskStatus('failed')

--- reload ---

getSessionTasks → rowToTask → replay.tasksToRecords replays kind:'error' as task.progress
  → task-segments renders an `error`/`stopped` segment
```

## Testing

- `task-segments` test (the key reload guarantee): a `task.progress` wrapping a
  `{ kind: 'error', error: { code, message, tier } }` `TaskEvent` produces an
  `error` segment with the right `detail` (and a `cancelled` code → `stopped`
  label). This proves persisted errors render after reload. The existing
  live-`task.error` test stays green.
- Existing `conversation-store` history round-trip already covers persistence of
  `TaskEvent[]` (no new store test needed; `kind: 'error'` is just another
  `TaskEvent`).
- Write path in `makeEmit` / `catch` is a private, non-injectable seam (no
  existing `session-manager` test harness), same situation as prior tasks.
  Verified by typecheck + lint + reusing the already-tested `saveTaskHistory`.
  No fabricated fake-runner harness.

## Risks

- **Double render concern** — avoided: the synthesized error is buffered only,
  never broadcast; reload uses the persisted progress event, live uses the
  top-level `task.error`. The two never coexist in one render pass.
- **Error payload shape** — all five `task.error` emit sites use
  `{ code, message, tier }`, matching the `TaskEventSchema` error variant, so the
  synthesized `TaskEvent` validates.
