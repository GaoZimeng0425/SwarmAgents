# Autonomous Loop — Design

Date: 2026-06-27
Status: Approved design, pre-implementation
Topic: Hook-driven autonomous agent loops

## 1. Purpose

Let an agent run autonomously across turns and across time, woken by different
trigger conditions ("hooks"), and keep working toward a goal until it is done
or a deterministic backstop stops it.

The guiding constraint from the design discussion: **do not rebuild what the
runtime already provides.** Most of "autonomous loop via hooks" is already
achievable with primitives in the codebase. This feature adds only the one
capability that is genuinely missing, plus a prompt/convention layer that makes
the agent use the existing primitives correctly.

## 2. What Already Exists (reused, zero new code)

| Capability | Existing primitive |
|---|---|
| Keep working within a turn (multi-step agentic loop) | Native pi / Claude SDK agent loop inside one `session.promptOnce` |
| Schedule a deferred / recurring self-wake | `schedule_task` tool (`src/service/tools/cron.ts` → `cron/scheduler.ts`) |
| Active relay (A finishes, then wakes B) | `messaging` tools (`src/service/tools/messaging.ts`, actor `send`/`rpc`) |
| Durable resume across sleep / crash | Resident actor (`runResident` in `agent-runner.ts`) + `actor/state.ts` cross-dormancy state |
| Runaway backstop | `agent-runner.ts`: cumulative budget per residency (`usdCents` / `calls` / `wallMs`) + `maxTurns` (default 25) + `stopCause` abort |

Implications:

- `continue_loop({ nextWakeAt })` would duplicate `schedule_task` — not built.
- `finish()` would duplicate "agent ends its turn" — not built.
- A `LoopController` backstop would duplicate the runner's cumulative budget +
  `maxTurns` — not built.
- A generic `Trigger` registry / cron refactor is a nice-to-have, not required
  to ship autonomous loops — deferred (YAGNI).

## 3. The One New Capability: `wait_for_task`

The only thing not cleanly expressible today is a **decoupled wait**: an agent
that pauses until *another* task reaches a terminal state, without anyone having
to actively message it back. Today this can only be approximated by polling via
`schedule_task`.

`wait_for_task` is structurally identical to the cron tool — the trigger
condition is "a task reached terminal state" instead of "a cron time elapsed."

### 3.1 Tool

Registered in the tool registry alongside the cron tools.

```ts
wait_for_task({
  taskId: string,   // the task whose completion we wait on
  goal?: string,    // goal to run when it completes; omitted → default continuation prompt
})
```

Semantics:

- Registers a durable watcher bound to the **calling agent's own actor
  address** and `taskId`.
- The current turn then ends normally; the resident loop drains empty and
  sleeps.
- When `taskId` reaches a terminal status, the watcher delivers `goal` (or a
  default continuation message naming the task and its terminal status) to the
  agent's address, which re-activates the resident loop (state replayed) and
  continues.

Terminal statuses follow the existing set used by the cron scheduler's
reconcile: `completed`, `failed`, `cancelled`, `interrupted`.

### 3.2 Watcher mechanism (event-driven, not polling)

At the point where a task transitions to a terminal state (the same lifecycle
point the cron scheduler observes via its `onComplete` callback / task terminal
status), check for waiters registered on that `taskId`; for each match, deliver
and remove the waiter.

No polling loop. The watcher is passive until a task terminal event occurs.

### 3.3 Persistence

Stored with the cron jobs in `ConversationStore` so waiters survive restart.

```ts
type StoredTaskWaiter = {
  id: string            // ulid
  waiterAddress: string // actor address to wake
  taskId: string        // task being awaited
  goal: string | null   // goal to deliver on completion; null → default prompt
  createdAt: number
}
// Store methods:
//   saveTaskWaiter(w)
//   listTaskWaitersForTask(taskId)
//   deleteTaskWaiter(id)
//   listAllTaskWaiters()   // startup re-arm
```

Startup re-arm: iterate all persisted waiters; if `taskId` is already terminal,
fire immediately; otherwise keep watching.

### 3.4 Edge cases

- **`taskId` already terminal at call time** → fire immediately (do not wait
  forever).
- **`taskId` does not exist** → fire immediately, and include "task not found"
  in the delivered goal so the agent decides what to do. Never silently swallow.
- **`taskId` never completes** → v1 sets no timeout (YAGNI; a human is present
  and can stop the loop manually). **Known limitation:** a dangling waiter
  leaves the loop asleep indefinitely. A timeout / liveness sweep is deferred to
  a future unattended-operation milestone.

## 4. Prompt + Task Shaping (the feature's main body, convention layer)

This is where most of the user-visible behavior comes from, and it is almost
entirely prompt/convention rather than code.

### 4.1 Loop-aware system prompt

Add a section to the agent system prompt (in `agents/default-prompt.ts` or the
agent definition) instructing the agent how to use the existing primitives:

- You are running autonomously toward the task goal.
- To pause and resume later at a chosen time, use `schedule_task` to schedule
  your own next wake.
- To wait until another task finishes, use `wait_for_task`.
- To hand work to another agent, use the `messaging` tools.
- When the goal's success criteria are met, simply end your turn — do **not**
  schedule another wake. Ending the turn is "done."
- Each turn, check your progress against the task's success criteria.
- Your budget is a finite cumulative envelope; spend it deliberately.

### 4.2 Task shape

The goal/task carries:

- **Verifiable success criteria** — so the agent and any reviewer can tell when
  it is done, instead of looping on vibes.
- **Budget envelope** — reuse the existing `task.budget` (`usdCents` / `calls` /
  `wallMs`); no new task fields. Express everything with the current structure;
  do not modify task schema.

## 5. Components Summary

| Component | Type | Location |
|---|---|---|
| `wait_for_task` tool | New | `src/service/tools/` (beside cron tools) |
| Task-completion watcher | New (small) | hook at task terminal transition; logic beside scheduler |
| `StoredTaskWaiter` + store methods | New | `ConversationStore` (with cron job storage) |
| Loop-aware system prompt section | New (prompt) | `agents/default-prompt.ts` or agent definition |
| Task success-criteria + budget convention | Convention | reuse existing `task.budget` |

Boundaries: the watcher depends only on the store + `deliver`; the tool only
writes a waiter row and ends the turn; the prompt section is static text. No new
runtime, no `LoopController`, no trigger registry.

## 6. Error Handling

- Tool input validation: `taskId` required; reject empty.
- Watcher delivery failure (e.g., target address gone): log at `error`, keep or
  drop the waiter per the existing deliver/redrain contract; never crash the
  task-completion path for other waiters.
- Startup re-arm of a waiter whose task is missing: treat as "already terminal /
  not found" → fire immediately with the not-found goal.
- Follow the project logging contract (CLAUDE.md §5): structured logs at waiter
  registration (`info`), delivery (`info` with `taskId`, `waiterAddress`),
  and every `catch` (`error`).

## 7. Testing Strategy

- **Tool**: `wait_for_task` registers a waiter row and the turn ends normally
  (unit).
- **Watcher fire**: task → terminal delivers `goal` to the waiter address (unit,
  mock store + deliver).
- **Edge: already terminal / not found** → fires immediately (boundary unit).
- **Restart re-arm**: persisted waiters are rebuilt on startup; already-terminal
  ones fire immediately (unit).
- **Prompt shaping**: snapshot test that the default prompt contains the
  loop-aware section.

## 8. Explicitly Out of Scope (v1)

- `continue_loop` / `finish` tools (redundant with `schedule_task` + native loop).
- `LoopController` and a separate backstop (redundant with runner budget +
  `maxTurns`).
- Generic `Trigger` registry and cron refactor (YAGNI; cron stays as-is).
- Webhook and file-change triggers (no inbound network surface on a desktop
  app; deferred until a concrete external-wake need exists).
- Cross-sleep cumulative budget cap (the runner's budget envelope resets when a
  residency re-spawns from sleep; an aggregate-across-wakes ceiling is deferred).
- `wait_for_task` timeout / dangling-waiter liveness sweep (deferred to an
  unattended-operation milestone).
