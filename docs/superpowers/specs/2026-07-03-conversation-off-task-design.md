# Conversation / Task Separation — Phase 3a: Conversation Off Task (Full)

- **Date:** 2026-07-03
- **Status:** Design (pending review)
- **Branch:** new worktree `worktree-conversation-off-task` off `develop` (this worktree, `worktree-runner-task-decouple`, has merged Phase 1+2 to `develop` and can be retired).
- **Scope:** `apps/desktop/src/service/conversation/store.ts`; `apps/desktop/src/service/session/manager.ts`; `apps/desktop/src/service/session/agent-runner.ts` (emit wiring only); a new `create_task` tool; the renderer transcript load path (`replay.ts` + live event subscription).
- **Predecessors:** Phase 1 (runner decoupled from `Task`), Phase 2 (user message is a real seq'd event) — both on `develop`.
- **Hard guardrail (user-stated):** Phase 4 must be able to remove the entire existing task + verify execution flow, with the agent making autonomous judgments. This spec is the first cut of that removal: it takes **conversation off the Task execution unit** so Phase 4 can later remove Task-as-execution-unit and the system verify loop without disturbing conversation.

## 1. Background & goal

Today every submitted message becomes a persisted `Task` that runs the system
verify loop (`define → execute → verify → rework`, up to 3 rounds). So "你好"
creates a task card and runs a full multi-round verification. This is the
message/task conflation the 4-phase redesign unmakes.

Phase 2 made the user message a real seq'd event (fixed the first-message-orders-
last bug) but kept the conflation. **Phase 3a removes conversation from the Task
execution unit**: a conversation turn is no longer a `Task`; it is a single-shot
agent run whose events live on a session-level conversation stream. Real work
becomes agent-authored: the agent calls a new `create_task` tool, which creates a
work `Task` (still running the existing verify loop — agent-driven verify is 3b).

This is "Full A" from the brainstorm: conversation storage is session-level from
3a onward (not a `Task` row), and the transcript is fed through an adapter so the
existing `taskSegments`/`buildTimelineItems` pipeline is unchanged.

## 2. How the guardrail is satisfied (removal path)

| Stage | Conversation | Work | System task + verify flow |
|---|---|---|---|
| today | Task + verify loop | Task + verify loop | fully present |
| **after 3a (this spec)** | session-level events, single-shot, **no Task, no verify** | agent calls `create_task` → Task + verify loop | removed from conversation; still on work |
| after 3b | (unchanged) | work tasks single-shot; verify is **agent-driven** (verify tool / reviewer subagent) | verify flow fully removed |
| after Phase 4 | (unchanged) | "task" is agent-authored data, not an execution unit; transcript is conversation-only + work artifacts | Task-as-execution-unit, `verify.ts`, `runGoalVerifyLoop`, `defaultVerifyCompletion` all deleted |

Because conversation is independent of the Task flow from 3a, Phase 4 removes the
Task/verify execution machinery without touching conversation rendering or
storage.

## 3. Non-goals

- **Agent-driven verify** (3b) — `create_task` work tasks still run the current
  system verify loop in 3a.
- **Removing the Task execution unit** (Phase 4) — work tasks still execute as
  Task-anchored runner runs in 3a.
- **`goal` folds into `initialMessages`** (3c) — deferred.
- **Resident actor path** (`spawnResident`) — unchanged; still creates its
  residency Task. Out of scope.
- **Migration of old sessions** — old sessions' tasks still render as
  `TaskRecord`s (their events live in `tasks.history`). New conversation turns
  use the session-conversation stream. The two share one seq space and interleave
  in the transcript. No data migration.

## 4. Data model

### 4.1 New session-conversation event storage

A new table, session-scoped, mirroring `task_events` but keyed by session + turn:

```sql
CREATE TABLE IF NOT EXISTS conversation_events (
  id        INTEGER PRIMARY KEY AUTOINCREMENT,
  session_id TEXT NOT NULL,
  turn_id    TEXT NOT NULL,        -- the conversation turn's correlationId (ULID)
  seq        INTEGER NOT NULL,     -- session-scoped monotonic (shared with task events)
  ts         INTEGER NOT NULL,
  event      TEXT NOT NULL          -- JSON-encoded UIEvent payload (same shape as task_events.event)
);
CREATE INDEX IF NOT EXISTS idx_conversation_events_session
  ON conversation_events(session_id, id);
```

New `ConversationStore` methods (symmetry with `appendTaskEvent`/`getSessionTasks`):

```ts
appendConversationEvent(sessionId: string, turnId: string, event: TaskEvent): void
getConversationEvents(sessionId: string): ConversationEventRow[]   // ordered by id
```

`appendConversationEvent` is the persistence hook the runner's `emit` calls for
conversation turns (replacing `appendTaskEvent` for those turns).

### 4.2 Shared seq counter

The existing `createSeqCounter(getSessionTasks)` initializes the per-session seq
from `Task.history` max seq. Extend the initializer to also scan
`conversation_events` so a resumed session continues past both streams with no
collision:

```ts
createSeqCounter((sid) => {
  const taskSeqs = getSessionTasks(sid).flatMap((t) => t.history.map((e) => e.seq ?? 0))
  const convSeqs = getConversationEvents(sid).map((r) => r.seq)
  return Math.max(0, ...taskSeqs, ...convSeqs)
})
```

`makeEmit` already assigns seq from this counter; conversation turns reuse the
same `makeEmit`, so their events get seqs from the shared space automatically.

### 4.3 Conversation turn vs Task

- A **conversation turn** has a `turnId` (ULID), no `Task` row, events in
  `conversation_events`. The user message (Phase 2) is its first event.
- A **work task** (created via `create_task`) has a `Task` row (parentId `null`),
  events in `tasks.history`/`task_events`, runs the verify loop, appears in the
  task panel.

## 5. Changes

### 5.1 `submitGoal` → conversation turn (no Task)

`manager.ts:submitGoal`:
- **No `saveTask`** for the conversation path. No `task.created` broadcast.
- Generate `turnId = ulid()`. Emit the user-message event (Phase 2) to the
  **session-conversation** stream via a new emit wrapper `makeConversationEmit`
  (analogous to `makeEmit`, persisting to `appendConversationEvent` and tagging
  events with `turnId`).
- Enqueue a turn that runs the runner **single-shot**: `maxVerifyRounds: 0`
  (skips the verify loop), `correlationId: turnId`, `goal: <user message>`,
  `budget: budgets().sub`, provider = session provider, agent = session agent.
  The runner's `emit` for this run is `makeConversationEmit(sessionId, turnId)`.
- **Continuation** (idle session, prior conversation): same path — a new turnId,
  a new user-message event on the session-conversation stream, a new single-shot
  run. The LLM context continuity comes from `session.messages` (the LLM buffer,
  unaffected — see §7).
- The pump/queue/cancel machinery keys off `turnId` where it previously keyed off
  `taskId` for these one-shot runs (`oneShotHandles`, `session.running`,
  `session.pending`). The `QueuedTurn` already carries a string id; it becomes
  the turnId for conversation turns.

### 5.2 `create_task` tool + `runWorkTask`

Extract the "create a top-level Task and run the verify loop" logic from today's
`submitGoal` new-task path into a reusable manager method:

```ts
async function runWorkTask(sessionId: string, goal: string, criteria?: AcceptanceCriterion[]): Promise<{ taskId: string; result: TaskResult }>
```

- Creates a `Task` (parentId `null`, `agentDefId` = session agent), saves it,
  broadcasts `task.created`, and runs the existing verify-capable runner
  (`maxVerifyRounds: MAX_VERIFY_ROUNDS`).
- Acquires a concurrency slot (same semaphore) but runs as a **child run** of the
  calling conversation turn (it must not deadlock the session's one-at-a-time
  turn pump — see §8).
- Returns `{ taskId, result }`.

New tool `create_task` (registered in the tool registry, scoped to the
conversation agent):

```ts
// input schema
{ goal: string, criteria?: AcceptanceCriterion[] }
// output
{ taskId: string, summary: string, artifacts: Artifact[] }
```

Wired into the conversation turn's runner via a new `AgentRunnerDeps` callback
(so the tool can reach the manager):

```ts
createTask?(goal: string, criteria?: AcceptanceCriterion[]): Promise<{ taskId: string; result: TaskResult }>
```

`create_task` is distinct from `spawn_sub_agent`: `spawn_sub_agent` delegates to
a sub-agent (child of a Task); `create_task` spawns a top-level work Task from a
conversation turn (no agent delegation — same session agent runs it). No new
TaskExecutor abstraction (the runner is the executor).

### 5.3 Runner: emit wiring only

`agent-runner.ts` is **unchanged** in logic. Phase 1 already decoupled it from
`Task`. For a conversation turn, the manager simply constructs `AgentRunnerDeps`
with `maxVerifyRounds: 0` (single-shot) and an `emit` that persists to
`appendConversationEvent`. The runner's single-shot path
(`agent-runner.ts` ~1411: `executionMode === 'plan' || maxVerifyRounds === 0`)
already does exactly `session.promptOnce(goal)` with no verify. No runner code
edits required.

### 5.4 Transcript adapter (renderer)

The transcript pipeline (`taskSegments`, `groupSegments`, `buildTimelineItems`)
operates on `TaskRecord[]` and is **unchanged**. The change is at the **load
layer**: produce a `TaskRecord[]` that includes conversation turns.

- `tasksToRecords` (replay) and the live event subscription are extended to also
  load/apply session-conversation events.
- Group conversation events by `turnId` into **pseudo-`TaskRecord`s**:

```ts
{
  id: turnId,
  sessionId,
  goal: <first user-message event content>,   // for anything that still reads .goal
  status: <derived from events: running/completed/cancelled>,
  workerId: null,
  summary: null,
  startedAt: <first event ts>,
  attachments: <first user event's attachments>,
  events: <the turn's UIEvents, including a synthetic task.created-like entry at index 0 if needed for ordering>,
  // no parentTaskId → treated as a top-level turn by buildTimelineItems
}
```

- Merge with real work-task `TaskRecord`s and sort by the existing seq key
  (`buildTimelineItems` already sorts globally by seq; conversation turn events
  carry seqs from the shared counter, so they interleave correctly).
- The `['tasks']` react-query cache (or a sibling `['conversation']` cache) is
  populated from both sources; `useTasks()` returns the merged list.

Phase 2 already ensured conversation user messages are real seq'd events, so the
adapter's first user segment renders in the correct position with no synthesis.

### 5.5 Task panel filter

The right-hand task panel (`RightPanel`/plan + verify groups in `tasks-view.tsx`)
already keys off `Task` records with plans/criteria. Conversation turns are not
`Task` rows, so they naturally do not appear there. No filter change needed —
only real work tasks (which have plans/criteria from the verify loop) populate
the panel. (Confirm during impl; if the pseudo-TaskRecords leak into planGroups,
exclude them by a `kind` discriminator on the adapter output, e.g. an
`isConversation` flag the planGroups filter checks.)

## 6. Data flow (new "你好" turn)

1. User sends "你好" → IPC `submitGoal(sessionId, "你好")`.
2. Manager: `turnId = ulid()`; `makeConversationEmit` emits the user-message
   event → `appendConversationEvent` → broadcast `task.progress`-equivalent with
   `turnId` + shared seq.
3. Enqueue single-shot turn; pump runs it: `createAgentRunner({ correlationId:
   turnId, goal: "你好", maxVerifyRounds: 0, emit: makeConversationEmit(...),
   ... })`.
4. Runner: single-shot path → `agent.prompt("你好")` → streams assistant reply
   → emits `llm.message role:assistant` (and any tool) events to
   `conversation_events`.
5. Renderer live subscription applies each event to the conversation-turn pseudo-
   TaskRecord; transcript renders the user message then the reply, ordered by
   seq.
6. No `Task` row, no verify loop, no task-panel entry. ("你好" is just a chat
   reply.)

## 7. Two-channel invariant (carried from Phase 2)

- **UI event stream** — conversation events on `conversation_events` (new) +
  task events on `task_events`; rendered by the transcript.
- **LLM message buffer** — `session.messages: AgentMessage[]`, seeded via
  `initialMessages`, advanced by `agent.prompt(goal)`, persisted by
  `saveSnapshot`.

Conversation turns feed the model via `agent.prompt(goal)` and the UI via the
conversation event stream. The two are independent; 3a adds the session-level UI
channel but does not change the LLM buffer. No double-feeding.

## 8. Concurrency & deadlock

- The session turn pump is one-at-a-time per session. A conversation turn that
  calls `create_task` would deadlock if `runWorkTask` awaited another pump slot
  in the same session.
- **Resolution:** `runWorkTask` runs the work task's runner directly (not through
  the session's `QueuedTurn` pump) while the parent conversation turn `await`s
  it. The work task is a nested run under the same acquired slot (the
  conversation turn already holds the slot). This mirrors how `spawnChild`
  already nests today (`spawnChild` is called from inside a running turn and
  awaits a child run). Concurrency is bounded by the existing semaphore only at
  the top-level pump; nested runs do not re-acquire.

## 9. Cancel / interrupt

- `cancelTask(sessionId, id)` already aborts via `oneShotHandles.get(id)`. For
  conversation turns the handle is keyed by `turnId`; for work tasks by
  `taskId`. Both flow through the same map (the id is opaque to the cancel
  path). No rename of the IPC method required.
- `interruptWith` promotes a queued turn/task; works identically with turnIds.

## 10. Usage / budget

- Conversation turn usage: the runner's `saveSnapshot` already writes
  `session.messages` + usage. With no `Task`, usage is accumulated at the
  session level (the runner reports `used`; the manager persists it to the
  session, not a task). Add a `saveSessionUsage(sessionId, used)` store method
  (or fold into `saveAgentSnapshot`). Detail for the plan.

## 11. Behavior changes

- **Intended:** "你好" produces a single chat reply; no task card, no verify
  loop, no task-panel entry. The agent can call `create_task` to do real work,
  which creates a work task (panel + verify). Fixes the user's complaint.
- **Old sessions:** unchanged rendering (their tasks are `TaskRecord`s;
  conversation-events table is empty for them).
- **Resident actors, cron, gmail sidecar, etc.:** unaffected — they don't use
  `submitGoal`'s conversation path.

## 12. Test strategy

- **store** — `appendConversationEvent`/`getConversationEvents` round-trip; seq
  persistence; shared-counter init across both tables.
- **manager** —
  - `submitGoal` conversation path: no `Task` saved; a conversation event is
    appended with a real seq; the runner is constructed `maxVerifyRounds: 0`.
  - `runWorkTask`/`create_task`: a `Task` is saved with `parentId null`; it runs
    the verify runner; result returned to the caller.
  - cancel/interrupt keyed by turnId still aborts the conversation turn.
- **runner** — unchanged (covered by existing suite); add a test that
  `maxVerifyRounds: 0` with a conversation-style emit does single-shot and emits
  to the provided emit fn (already implicitly covered).
- **renderer adapter** — group `conversation_events` by turnId into a pseudo-
  `TaskRecord`; merge with work tasks; assert seq ordering interleaves a
  conversation turn before a work task whose spawn came later.
- **e2e** — submit "你好": assert no `Task` row exists, no `task.verification`
  event, assistant reply present in `conversation_events`. Then have the agent
  call `create_task`: assert a `Task` row exists, appears in the task panel, ran
  verify.
- **seq counter** — a session with both conversation events and task events
  resumes with `nextSeq` strictly greater than both maxes.

## 13. Verification

- `npm test` green (full suite, Electron node runner; never bare `npx vitest`;
  never `pnpm rebuild better-sqlite3`).
- `npx biome check --write <file>` per touched file (scoped).
- Manual smoke: "你好" → chat reply, no task card, no panel entry, no verify
  spinner; a real-work goal that triggers `create_task` → work task appears in
  the panel with a plan; cancel mid-turn aborts.

## 14. Rollback

3a lands as a series of commits on a dedicated worktree branch off `develop`,
integrated via `git rebase develop` + `git merge --ff-only`. Schema addition (new
table) is additive — a revert leaves an unused table, no data loss. Old sessions
unaffected.

## 15. Forward pointers (what 3a does NOT do)

- **3b:** remove the system verify loop from `create_task` work tasks →
  agent-driven verify (verify tool / reviewer subagent). Deletes
  `runGoalVerifyLoop`, `defaultVerifyCompletion`, Phase A criteria derivation,
  the `verifyCompletion` dep.
- **3c:** `goal` folds into `initialMessages` (conversation isn't a task; the
  runner's `goal` param becomes redundant for conversation).
- **Phase 4:** delete Task-as-execution-unit; migrate work to agent-authored
  data; give conversation its own first-class rendering (drop the adapter).
  Delete `verify.ts`. The agent autonomously decides when to work and how to
  judge completeness.
