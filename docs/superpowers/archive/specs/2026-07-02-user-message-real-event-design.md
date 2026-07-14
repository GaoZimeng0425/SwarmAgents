# Message / Task Separation — Phase 2: User Message as a Real Event

- **Date:** 2026-07-02
- **Status:** Design (pending review)
- **Branch:** `worktree-runner-task-decouple`
- **Scope:** `apps/desktop/src/service/session/manager.ts` (`submitGoal`), `apps/desktop/src/renderer/src/lib/task-segments.ts`, plus targeted renderer/test updates.
- **Predecessor:** Phase 1 (`2026-07-02-runner-task-decoupling-design.md`) — `AgentRunner` no longer depends on `Task`. Landed on this branch.

## 1. Background

The broader redesign separates **conversation messages** from **tasks** (a user
message is a first-class message, not a task's `goal`) across four phases.
Phase 1 decoupled the runner from `Task`. This spec covers **Phase 2**: make the
user's message a real, seq'd event so it renders in true causal position, fixing
the "first user message renders last" bug **structurally**.

### The bug, fully traced

`submitGoal` has two paths:

- **New task** (`manager.ts:864-883`): `store.saveTask` + `broadcaster.broadcast('task.created', { goal })`.
  The user message exists **only** as `task.goal`. No `llm.message` event is emitted.
- **Continuation** (`manager.ts:854-863`): emits a real
  `task.progress` event `{ kind: 'llm.message', role: 'user', content: goal }`
  via `makeEmit`, which assigns it a monotonic seq from `seqCounter` (1, 2, 3, …)
  and persists it to `task.history`.

The renderer synthesizes the first user bubble from `task.goal`
(`task-segments.ts:40-52`):

```ts
{ kind: 'user', text: task.goal, seq: task.events[0]?.seq ?? task.startedAt, … }
```

For a brand-new task, `task.events` is empty at first render, so the bubble's seq
falls back to `task.startedAt` — a wall-clock millisecond timestamp (~1.7e12).
`buildTimelineItems` sorts all segments by `seq` ascending
(`build-timeline-items.ts:78`); real events have seqs 1, 2, 3, …, so the
~1.7e12 goal bubble sorts **last**. Continuation messages already carry a real
seq, which is why they render correctly — and why "make the user message a real
event" is the structural fix.

## 2. Goal

Make the user's message a **real seq'd event emitted at submit time** for *both*
the new-task and continuation paths, and stop deriving the first chat bubble
from `task.goal`. The first user message then carries the smallest seq and
renders first, in true causal order. This is the structural fix the redesign was
triggered by.

## 3. Scope decision (why this is the right Phase 2)

The recorded phase-2 description has three clauses: (1) session as conversation
carrier; (2) CEO turn runs the runner without a persisted task; (3) user message
= real event (the bug fix). This spec delivers **(3) fully** and the data-model
seed of (1). It **defers (2)** to Phase 3.

Rationale: clause (2) — removing the persisted Task for conversation turns — is
a natural consequence of Phase 3's `create_task` tool (Task becomes
agent-authored data; a conversation turn then has no Task). Doing (2) now would
pre-empt Phase 3 and collide with Phase 4's rendering split. Clause (3) is the
documented trigger for the whole redesign, it is small, and it is the entire
structural fix. Phase 1 was deliberately a tight, test-locked refactor; Phase 2
follows the same philosophy. The "not a conversation-task record" end state is
reached *across* phases; this is its first step, not a contradiction of it.

The Task row remains the anchor for the turn queue / cancel / interrupt / usage /
plan / verify machinery. `task.goal` remains a field (the runner still needs it
as objective text — see §5; the minimap, task list, and calendar still read it).

## 4. Non-goals

- Do **not** remove the persisted Task for conversation turns (Phase 3).
- Do **not** introduce session-owned conversation storage / a new events table
  (Phase 3/4). The user-message event continues to live on `task.history`.
- Do **not** change the LLM message buffer (`session.messages`) or how the runner
  seeds the first LLM turn (still `agent.prompt(goal)` — see §5).
- Do **not** split the conversation thread from the task panel (Phase 4).
- Do **not** migrate existing sessions (pre-existing tasks keep rendering via the
  preserved synthetic-bubble fallback in §6).
- Do **not** rename the `taskId` field on the emitted event wire format.

## 5. Two independent channels (the key invariant)

Phase 2 touches only the **UI event stream**, not the **LLM message buffer**.
These are separate and must not be confused:

- **UI event stream** — `task.progress` events on `task.history`, each carrying a
  monotonic `seq` (assigned by `makeEmit` via `seqCounter`), consumed by the
  renderer. **The user message enters here.**
- **LLM message buffer** — `session.messages: AgentMessage[]` (pi-agent-core
  format), seeded to the runner via `initialMessages` and advanced by
  `agent.prompt(goal)` (`agent-runner.ts:1079`). This is how the model receives
  the user's objective. **Unchanged by Phase 2.**

Because the user message reaches the LLM through `agent.prompt(goal)` and the UI
through a `task.progress` event, emitting the event does **not** double-feed the
model. `saveSnapshot` continues to persist `session.messages` (the LLM buffer)
in parallel; the two representations coexist as they do today.

## 6. Changes

### 6.1 `manager.ts` `submitGoal` — emit the user-message event on the new-task path

Today only the continuation path emits the user-message event
(`manager.ts:858-861`). Add the same emission to the **new-task** path, inside
the `else` branch, immediately after the `task.created` broadcast (after
`manager.ts:866`) and before the `isFirst` title block:

```ts
// The user's message is a first-class event with a real seq, so it renders in
// true causal position (fixes first-message-renders-last). Symmetric with the
// continuation path above.
makeEmit(sessionId)('task.progress', {
  taskId,
  event: { kind: 'llm.message', role: 'user', content: goal, ts: now },
})
```

`makeEmit` assigns the next session seq and persists the event to `task.history`
via `appendTaskEvent`, so `task.events[0]` becomes this user event (smallest
seq). The event is emitted synchronously before `pump`/`runTurn` (which await a
slot), so it precedes any runner output.

Ordering invariant: `task.created` is broadcast first (so the renderer has the
task card), then the user-message event — matching the continuation path, which
also emits onto an already-existing task. The renderer's reducer already handles
`task.progress` for a just-created task (the continuation path relies on it).

### 6.2 `renderer/src/lib/task-segments.ts` — stop synthesizing the goal bubble for top-level turns

The synthetic goal bubble (`task-segments.ts:40-52`) is the bug source. It must
be **kept for tasks with no human user-message event** (sub-agent / resident
tasks, whose objective is an agent goal, not a human message — and
`SubagentBlock` does *not* render `task.goal`, so the bubble is the only place
the sub-agent's objective appears), and **dropped for tasks that have a real
user-message event** (top-level conversation turns).

Replace the unconditional prepend with a conditional one:

```ts
export function taskSegments(task: TaskRecord): Segment[] {
  const out: Segment[] = []

  // A top-level conversation turn emits its user message as a real seq'd event
  // (manager.submitGoal), rendered by the loop below — no synthetic bubble. A
  // sub-agent / resident task has no human user event; its objective is shown
  // via the synthetic goal bubble below (SubagentBlock does not render goal).
  const hasUserMessage = task.events.some(
    (e) =>
      e.kind === 'task.progress' &&
      e.event.kind === 'llm.message' &&
      e.event.role === 'user',
  )
  if (!hasUserMessage) {
    out.push({
      kind: 'user',
      text: task.goal,
      attachments: task.attachments ?? [],
      key: `${task.id}-goal`,
      taskId: task.id,
      ts: task.startedAt,
      seq: task.events[0]?.seq ?? task.startedAt,
    })
  }

  const pushAssistant = …  // unchanged
  // …the existing event loop is unchanged. Its `llm.message role:'user'` branch
  // (lines ~84-95) already renders a user bubble from the real event; with the
  // synthetic prepend gone for top-level turns, that branch now also supplies
  // the FIRST message. The comment at lines ~85-86 ("the task.goal user bubble
  // above is the original request") is updated to reflect that the original
  // request is now itself a real event.
}
```

The event loop's `llm.message role:'user'` branch already pushes a user segment
with `seq = e.seq ?? e.ts` (`task-segments.ts:84-95`); since `makeEmit` stamps
`event.seq`, this is the real small seq. No other loop change.

Effect: top-level turns render the user message from the real event (correct
seq, correct position); sub-agent / resident tasks are byte-for-byte unchanged.

### 6.3 `build-timeline-items.ts` — no logic change

The sort keys (`build-timeline-items.ts:40`, `:61`) remain
`t.events[0]?.seq ?? t.startedAt`. After §6.1, `events[0]` is the real
user-message event for top-level turns, so the fallback rarely engages. It is
retained as a defensive default for tasks with no events yet (freshly spawned
sub-agents, transient states) — unchanged.

## 7. Behavior changes

- **Intended fix:** the first user message now carries the smallest seq in its
  task and renders at the top of the transcript (true causal order), no longer
  last.
- **No other user-visible change:** runner, verify loop, queue, cancel,
  interrupt, usage, sub-agent blocks, resident actors, minimap, task list, and
  calendar all behave as before. `task.goal` remains a field used by the runner
  (objective text) and those surfaces.
- **Old sessions (no migration):** a pre-existing top-level task whose user
  message was never emitted as an event has `hasUserMessage === false`, so it
  keeps the synthetic bubble — i.e. it renders exactly as it did before this
  change. New turns from this point on use the real-event path.

## 8. Test strategy

- **`manager.test.ts`** — add/extend: a new-task `submitGoal` emits exactly one
  `task.progress` event with `event.kind === 'llm.message'` and
  `event.role === 'user'`, carrying a real seq (the counter's first value), and
  it is persisted to the task's history. Assert the seq is finite and smaller
  than a subsequently emitted assistant event's seq.
- **`task-segments.test.ts`** — add a fixture whose `TaskRecord` includes a real
  user-message event; assert (a) no synthetic goal bubble is prepended, (b) the
  user segment's `seq` equals the event's seq (not `startedAt`), (c) it is the
  first segment. Keep a second fixture (no user event, e.g. a sub-agent) and
  assert the synthetic bubble is still prepended (regression guard for
  sub-agents).
- **`build-timeline-items.test.ts`** — extend/add a case where a top-level task
  with a real user event sorts its user message before the assistant's reply
  (seq ordering). The existing `expect(items.map((i) => i.seq))` assertion shape
  (`build-timeline-items.test.ts:70`) is reused.
- **No new runner tests** — the runner is untouched.

## 9. Verification

- `npm test` green (full suite, via the Electron node runner — never bare
  `npx vitest`; never `pnpm rebuild better-sqlite3`).
- `npx biome check --write <file>` for each touched file (scoped; the repo
  `pnpm check`/`format` rewrites the whole tree).
- Manual smoke: in a fresh session, submit a goal; confirm the user's message
  renders at the **top** of the transcript, ahead of the assistant's reply and
  tool blocks. Then send a follow-up (continuation); confirm it renders at its
  true position. Trigger a sub-agent (`spawn_sub_agent`); confirm the sub-agent
  block still shows its objective.

## 10. Rollback

Phase 2 lands as a single commit on `worktree-runner-task-decouple`, integrated
to `develop` via `git rebase develop` + `git merge --ff-only` (linear history).
No schema or data migration, so a revert is clean. Old sessions are unaffected
(§7).

## 11. Phase 2 does NOT do (forward pointers)

- **Phase 3:** `create_task` tool; work tasks executed as executor runs;
  **system-driven verify removed**, replaced by agent-driven verify; `goal`
  folds into `initialMessages`; the persisted Task for conversation turns is
  removed (clause (2) of the original phase-2 description lands here, as a
  natural consequence of Task becoming agent-authored).
- **Phase 4:** rendering split — conversation thread + task panel.
