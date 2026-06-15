# Interrupt the Current Run (Stop Button) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Let a user interrupt an in-progress agent run from the UI by turning the composer's Send button into a Stop button, and render a stopped run honestly instead of as a failure.

**Architecture:** Purely renderer-side. The backend cancel chain (`swarmApi.cancelTask` → IPC → `session-manager.cancelTask` → `AbortController.abort()` → `agent-runner` emits `task.error{code:'cancelled'}` and returns `'cancelled'`) already exists and is untouched. We add a `useCancelTask` hook, wire the active task into `ChatInput`, toggle Send↔Stop, and map the `cancelled` error code / stored status to a new renderer `'cancelled'` status.

**Tech Stack:** React, TanStack Query, Zustand, Vitest (run via Electron-as-node), lucide-react icons, Biome.

**Commands:**
- Single test file: `npm test -- <path>`
- Full suite: `npm test`
- Typecheck: `npm run typecheck`
- Format a single file: `npx biome check --write <file>` (project-wide `npm run check` reformats the whole repo — avoid)

---

### Task 1: Map the `cancelled` error code to a `'cancelled'` status in `applyEvent`

**Files:**
- Modify: `src/renderer/src/lib/apply-event.ts:4` (TaskStatus union) and `:66-68` (task.error case)
- Test: `src/renderer/src/lib/apply-event.test.ts`

- [ ] **Step 1: Write the failing tests**

Add these two tests to `src/renderer/src/lib/apply-event.test.ts`, immediately after the existing `it('flips to failed on task.error', …)` block (after line 69):

```ts
  it('flips to cancelled on task.error with code "cancelled"', () => {
    const seed: TaskRecord[] = [
      {
        id: 't1',
        sessionId: 'ses-1',
        goal: 'g',
        status: 'running',
        workerId: 'w1',
        summary: null,
        startedAt: 1,
        events: [],
      },
    ]
    const next = applyEvent(seed, {
      kind: 'task.error',
      ...baseEvent,
      error: { code: 'cancelled', message: 'Stopped by user.', tier: 'gave_up' },
    })
    expect(next[0].status).toBe('cancelled')
  })

  it('stays failed on task.error with a non-cancelled code', () => {
    const seed: TaskRecord[] = [
      {
        id: 't1',
        sessionId: 'ses-1',
        goal: 'g',
        status: 'running',
        workerId: 'w1',
        summary: null,
        startedAt: 1,
        events: [],
      },
    ]
    const next = applyEvent(seed, {
      kind: 'task.error',
      ...baseEvent,
      error: { code: 'budget_exhausted', message: 'm', tier: 'gave_up' },
    })
    expect(next[0].status).toBe('failed')
  })
```

- [ ] **Step 2: Run the tests to verify the first one fails**

Run: `npm test -- src/renderer/src/lib/apply-event.test.ts`
Expected: the new `flips to cancelled` test FAILS (`expected 'failed' to be 'cancelled'`). The `stays failed` test PASSES (current behavior already returns `'failed'`). All other tests pass.

- [ ] **Step 3: Add `'cancelled'` to the `TaskStatus` union**

In `src/renderer/src/lib/apply-event.ts`, change line 4 from:

```ts
export type TaskStatus = 'pending' | 'running' | 'completed' | 'failed' | 'awaiting_user'
```

to:

```ts
export type TaskStatus = 'pending' | 'running' | 'completed' | 'failed' | 'awaiting_user' | 'cancelled'
```

- [ ] **Step 4: Branch on the error code in the `task.error` case**

In the same file, replace the `task.error` case (lines 66-68):

```ts
    case 'task.error':
      updated = setStatus(updated, 'failed')
      break
```

with:

```ts
    case 'task.error': {
      const code =
        typeof e.error === 'object' && e.error && 'code' in e.error
          ? (e.error as { code: unknown }).code
          : undefined
      updated = setStatus(updated, code === 'cancelled' ? 'cancelled' : 'failed')
      break
    }
```

- [ ] **Step 5: Run the tests to verify they pass**

Run: `npm test -- src/renderer/src/lib/apply-event.test.ts`
Expected: all tests PASS, including both new ones.

- [ ] **Step 6: Commit**

```bash
npx biome check --write src/renderer/src/lib/apply-event.ts src/renderer/src/lib/apply-event.test.ts
git add src/renderer/src/lib/apply-event.ts src/renderer/src/lib/apply-event.test.ts
git commit -m "feat(ui): map cancelled error code to a cancelled task status"
```

---

### Task 2: Map the stored `cancelled` status to `'cancelled'` on replay

**Files:**
- Modify: `src/renderer/src/lib/replay.ts:16`

**Context:** When a stopped session is reloaded, `tasksToRecords` rebuilds records from the persisted `Task['status']`. The session-manager persists `'cancelled'` for a stopped run, but `replay.ts` currently downgrades it to `'failed'`. This task aligns replay with Task 1 so a reloaded stopped run shows consistently. `interrupted` stays mapped to `'failed'` (it is a separate restart-time concept, out of scope).

This file has no dedicated test; verify via typecheck (the literal must be a member of the `TaskStatus` union added in Task 1).

- [ ] **Step 1: Change the `cancelled` mapping**

In `src/renderer/src/lib/replay.ts`, change line 16 from:

```ts
  cancelled: 'failed',
```

to:

```ts
  cancelled: 'cancelled',
```

Leave line 17 (`interrupted: 'failed',`) unchanged.

- [ ] **Step 2: Typecheck**

Run: `npm run typecheck`
Expected: PASS (no errors). Confirms `'cancelled'` is a valid `TaskStatus`.

- [ ] **Step 3: Commit**

```bash
git add src/renderer/src/lib/replay.ts
git commit -m "feat(ui): replay stopped runs as cancelled, not failed"
```

---

### Task 3: Add the `useCancelTask` hook

**Files:**
- Modify: `src/renderer/src/hooks/use-tasks.ts` (add a new exported hook near `useDecidePermission`)

**Context:** `swarmApi.cancelTask(sessionId, taskId)` already exists in `src/renderer/src/lib/api.ts`. This hook wraps it as a React Query mutation, mirroring the existing `useDecidePermission` shape (which already imports `useMutation` and `swarmApi`).

This hook has no dedicated test (consistent with the existing hooks in this file); verify via typecheck.

- [ ] **Step 1: Add the hook**

In `src/renderer/src/hooks/use-tasks.ts`, add this exported function immediately after the `useDecidePermission` function:

```ts
/** Cancel an in-flight task (aborts the agent run server-side). */
export function useCancelTask() {
  return useMutation({
    mutationFn: ({ sessionId, taskId }: { sessionId: string; taskId: string }) =>
      swarmApi.cancelTask(sessionId, taskId),
  })
}
```

(`useMutation` and `swarmApi` are already imported at the top of the file.)

- [ ] **Step 2: Typecheck**

Run: `npm run typecheck`
Expected: PASS.

- [ ] **Step 3: Commit**

```bash
git add src/renderer/src/hooks/use-tasks.ts
git commit -m "feat(ui): add useCancelTask mutation hook"
```

---

### Task 4: Toggle the composer Send button to a Stop button while running

**Files:**
- Modify: `src/renderer/src/components/chat-input.tsx` (Props type at :11-14, imports at :3, submit/keydown logic, the trailing Button at :83-94)

**Context:** When `running` is true, the trailing button must show a Stop (square) icon, stay enabled, and call `onStop` instead of submitting. The input stays usable so the user can type their next message, but Enter must not submit a new goal mid-run. No component test exists for this file; verify via typecheck and manual run.

- [ ] **Step 1: Import the `Square` icon**

In `src/renderer/src/components/chat-input.tsx`, change the lucide import on line 3 from:

```ts
import { ArrowUp } from 'lucide-react'
```

to:

```ts
import { ArrowUp, Square } from 'lucide-react'
```

- [ ] **Step 2: Add `running` and `onStop` to Props**

Replace the `Props` type (lines 11-14):

```ts
type Props = {
  onSubmit: (goal: string) => void | Promise<void>
  disabled?: boolean
}
```

with:

```ts
type Props = {
  onSubmit: (goal: string) => void | Promise<void>
  disabled?: boolean
  /** A run is in flight for the active session. Send becomes Stop. */
  running?: boolean
  /** Called when the user clicks Stop while a run is in flight. */
  onStop?: () => void
}
```

- [ ] **Step 3: Destructure the new props**

Change the component signature (line 35) from:

```ts
export function ChatInput({ onSubmit, disabled }: Props): React.JSX.Element {
```

to:

```ts
export function ChatInput({ onSubmit, disabled, running, onStop }: Props): React.JSX.Element {
```

- [ ] **Step 4: Suppress Enter-to-send while running**

In the `Textarea`'s `onKeyDown` handler (lines 72-77), change the guard so Enter is ignored during a run. Replace:

```tsx
            onKeyDown={(e) => {
              if (e.key === 'Enter' && !e.shiftKey && !e.nativeEvent.isComposing) {
                e.preventDefault()
                void submit()
              }
            }}
```

with:

```tsx
            onKeyDown={(e) => {
              if (e.key === 'Enter' && !e.shiftKey && !e.nativeEvent.isComposing) {
                e.preventDefault()
                if (!running) void submit()
              }
            }}
```

- [ ] **Step 5: Render Stop or Send based on `running`**

Replace the trailing `<Button>` block (lines 83-94):

```tsx
          <Button
            aria-label="Send"
            className={cn(
              "size-9 shrink-0 rounded-full transition-all duration-300",
              value.trim().length > 0 ? "scale-100 opacity-100" : "scale-90 opacity-40 grayscale"
            )}
            disabled={disabled || value.trim().length === 0}
            onClick={() => void submit()}
            size="icon"
          >
            <ArrowUp className="size-5 stroke-[2.5px]" />
          </Button>
```

with:

```tsx
          {running ? (
            <Button
              aria-label="Stop"
              className="size-9 shrink-0 rounded-full transition-all duration-300 scale-100 opacity-100"
              onClick={() => onStop?.()}
              size="icon"
              variant="destructive"
            >
              <Square className="size-4 fill-current" />
            </Button>
          ) : (
            <Button
              aria-label="Send"
              className={cn(
                "size-9 shrink-0 rounded-full transition-all duration-300",
                value.trim().length > 0 ? "scale-100 opacity-100" : "scale-90 opacity-40 grayscale"
              )}
              disabled={disabled || value.trim().length === 0}
              onClick={() => void submit()}
              size="icon"
            >
              <ArrowUp className="size-5 stroke-[2.5px]" />
            </Button>
          )}
```

- [ ] **Step 6: Typecheck**

Run: `npm run typecheck`
Expected: PASS.

- [ ] **Step 7: Commit**

```bash
npx biome check --write src/renderer/src/components/chat-input.tsx
git add src/renderer/src/components/chat-input.tsx
git commit -m "feat(ui): toggle composer Send to Stop while a run is in flight"
```

---

### Task 5: Wire the active run into `ChatInput` from `TasksView`

**Files:**
- Modify: `src/renderer/src/components/views/tasks-view.tsx` (imports at :8, body, the `ChatInput` usage at :45-51)

**Context:** `TasksView` already has `sessionTasks` (filtered by `selectedSessionId`) and `selectedSessionId`. Runs are sequential per session, so the active run is the most recent task whose status is `running` or `pending`. We pass `running` and `onStop` to `ChatInput`, and relax `disabled` so the composer stays usable while a run is in flight (drop `submitGoal.isPending`, keep `!ready`).

No component test exists for this file; verify via typecheck and manual run.

- [ ] **Step 1: Import `useCancelTask`**

In `src/renderer/src/components/views/tasks-view.tsx`, change the hook import on line 8 from:

```ts
import { useDecidePermission, useLoadSessions, useSubmitGoal, useTasks } from '@/hooks/use-tasks'
```

to:

```ts
import { useCancelTask, useDecidePermission, useLoadSessions, useSubmitGoal, useTasks } from '@/hooks/use-tasks'
```

- [ ] **Step 2: Instantiate the hook and compute the active task**

After the existing `const submitGoal = useSubmitGoal()` line (line 16), add:

```ts
  const cancelTask = useCancelTask()
```

Then, after the `sessionTasks` declaration (line 27), add:

```ts
  // Runs are sequential per session, so at most one task is in flight. Pick the
  // most recent running/pending task as the cancel target.
  const activeTask = [...sessionTasks]
    .sort((a, b) => b.startedAt - a.startedAt)
    .find((t) => t.status === 'running' || t.status === 'pending')
```

- [ ] **Step 3: Pass `running` and `onStop` to `ChatInput` and relax `disabled`**

Replace the `<ChatInput …>` block (lines 45-51):

```tsx
        <ChatInput
          disabled={submitGoal.isPending || !ready}
          onSubmit={async (g) => {
            if (!ready) return
            await submitGoal.mutateAsync(g)
          }}
        />
```

with:

```tsx
        <ChatInput
          disabled={!ready}
          onStop={() => {
            if (activeTask) cancelTask.mutate({ sessionId: activeTask.sessionId, taskId: activeTask.id })
          }}
          onSubmit={async (g) => {
            if (!ready) return
            await submitGoal.mutateAsync(g)
          }}
          running={!!activeTask}
        />
```

- [ ] **Step 4: Typecheck**

Run: `npm run typecheck`
Expected: PASS.

- [ ] **Step 5: Run the full test suite**

Run: `npm test`
Expected: all tests PASS (no regressions).

- [ ] **Step 6: Commit**

```bash
npx biome check --write src/renderer/src/components/views/tasks-view.tsx
git add src/renderer/src/components/views/tasks-view.tsx
git commit -m "feat(ui): wire Stop button to cancel the active run"
```

---

### Task 6: Manual verification

**Files:** none (verification only).

**Context:** The renderer has no component/E2E tests for this flow, so confirm the end-to-end behavior by running the app. Use the `run-desktop` skill (or `run`) to launch it.

- [ ] **Step 1: Build to confirm no type/bundler errors**

Run: `npm run build`
Expected: typecheck passes and `electron-vite build` completes without errors.

- [ ] **Step 2: Launch the app and exercise the flow**

Launch the desktop app (via the `run-desktop` skill). Then:
- Submit a goal that runs for a few seconds.
- Confirm the trailing composer button changes from the up-arrow Send to a red square Stop while the run is in flight, and the input stays editable.
- Click Stop.
- Confirm: the "Swarm is thinking…" spinner clears, the thread shows a "Stopped by user." message, and the run is rendered as stopped — **not** as a failure.
- Confirm a new message can be submitted afterward and runs normally.

- [ ] **Step 3: Confirm replay consistency**

Switch to another session and back (or reload). Confirm the stopped task still renders as stopped (status `cancelled`), not failed.

---

## Notes

- The backend (`session-manager`, `agent-runner`, dispatcher, IPC, preload, `swarmApi.cancelTask`) is unchanged — do not modify it.
- `conversation-thread.tsx` needs no change: its `busy` check is `status === 'running' || 'pending'`, which already excludes `'cancelled'`, and the "Stopped by user." text is surfaced by the existing `task.error` bubble.
