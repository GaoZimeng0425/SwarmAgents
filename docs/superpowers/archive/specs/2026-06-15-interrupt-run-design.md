# Interrupt the current run (Stop button) — Design

**Date:** 2026-06-15
**Status:** Approved, pending implementation

## Problem

A user has no way to interrupt an in-progress agent run from the UI. While a
run is active, the composer's Send button is merely disabled
(`chat-input.tsx`), so the only way to stop a misbehaving or unwanted run is to
wait for it to finish or delete the session.

## Key finding: the backend is already complete

The cancellation chain exists end-to-end and is **not** part of this change:

- Renderer `swarmApi.cancelTask(sessionId, taskId)` → preload
  (`swarm:cancelTask`) → main IPC → `service-client.cancelTask` → dispatcher
  (`cancelTask`) → `session-manager.cancelTask`, which calls
  `runHandles.get(taskId)?.abort()`.
- `agent-runner` observes the aborted `signal`, sets `stopCause = 'cancelled'`,
  emits `task.error { error: { code: 'cancelled', message: 'Stopped by user.',
  tier: 'gave_up' } }`, and returns `status: 'cancelled'`.

The work is therefore **purely renderer-side**: surface a control that triggers
the existing `cancelTask`, and render a stopped run honestly instead of as a
failure.

## Interaction model

Chosen: **Send button morphs into Stop** (standard ChatGPT/Claude pattern).

- While a run is active, the trailing composer button shows a Stop (square)
  icon and cancels the active run on click.
- The composer input stays enabled during a run so the user can type their next
  message.
- Submitting a *new* goal mid-run is **out of scope** (no send-to-interrupt).

## Components

### 1. `useCancelTask` hook — `src/renderer/src/hooks/use-tasks.ts`

A React Query mutation mirroring the existing `useDecidePermission` shape:

```ts
export function useCancelTask() {
  return useMutation({
    mutationFn: ({ sessionId, taskId }: { sessionId: string; taskId: string }) =>
      swarmApi.cancelTask(sessionId, taskId),
  })
}
```

`swarmApi.cancelTask` already exists in `lib/api.ts`.

### 2. Active-task wiring — `src/renderer/src/components/views/tasks-view.tsx`

Compute the active run for the selected session — the most recent
`sessionTasks` entry whose status is `running` or `pending`. Runs are sequential
per session (`session.queue`), so at most one is active.

Pass to `ChatInput`:

- `running={!!activeTask}`
- `onStop={() => activeTask && cancelTask.mutate({ sessionId: selectedSessionId, taskId: activeTask.id })}`

Change `disabled` to drop `submitGoal.isPending` and key only off `!ready`, so
the composer stays usable while a run is in flight.

### 3. Send → Stop toggle — `src/renderer/src/components/chat-input.tsx`

Add props:

```ts
type Props = {
  onSubmit: (goal: string) => void | Promise<void>
  disabled?: boolean
  running?: boolean
  onStop?: () => void
}
```

- When `running`, the trailing button renders a `Square` (lucide) stop icon, is
  always enabled, and calls `onStop` instead of `submit`. Otherwise it renders
  the existing `ArrowUp` Send button with its current disabled/scale logic.
- Enter-to-send is suppressed while `running` (the user may type, but Enter does
  not submit a new goal mid-run).

### 4. Honest "stopped" status

**`src/renderer/src/lib/apply-event.ts`**

- Add `'cancelled'` to the `TaskStatus` union.
- In the `task.error` case, inspect the error code: if
  `error.code === 'cancelled'`, set status `'cancelled'`; otherwise keep
  `'failed'`.

**`src/renderer/src/lib/replay.ts`**

- Map stored task status `cancelled` → `'cancelled'` (currently `'failed'`), so
  a reloaded session shows a stopped run consistently. `interrupted` stays
  mapped to `'failed'` (unchanged; it is a separate restart-time concept).

The existing error bubble already surfaces the "Stopped by user." message, and
`conversation-thread.tsx`'s `busy` check (`running || pending`) already excludes
`cancelled`, so the spinner clears correctly. No further conversation-thread
changes are required.

## Data flow

```
User clicks Stop
  → ChatInput.onStop()
  → tasks-view: cancelTask.mutate({ sessionId, taskId })
  → swarmApi.cancelTask → … → session-manager.cancelTask → AbortController.abort()
  → agent-runner: emit task.error{code:'cancelled'}, return status 'cancelled'
  → renderer event stream → apply-event: task.error(code='cancelled') → status 'cancelled'
  → conversation-thread: spinner clears, "Stopped by user." bubble shown
```

## Testing

- **Unit (`apply-event.test.ts`)**: a `task.error` with `error.code === 'cancelled'`
  yields status `'cancelled'`; a `task.error` with any other code still yields
  `'failed'` (existing test preserved).
- **Existing suite**: `npm test` stays green.
- **Manual**: start a run, confirm Send becomes a Stop button, click Stop,
  confirm the run halts and the thread shows "Stopped by user." rather than a
  failure, and the composer is usable for the next message.

## Out of scope

- Send-to-interrupt (typing a new message auto-cancelling the current run).
- Pausing/resuming a run.
- Cancelling queued-but-not-started tasks beyond the single active one.
