# Multi-Session Chat UI Design

**Date:** 2026-05-30
**Scope:** Frontend refactor into a chat-style UI (session list left, conversation thread center, input at bottom) backed by real multi-session support with per-session conversation continuity and persistence.
**Status:** Approved

## Background

The app is an Electron agent-orchestration framework. The backend already models
sessions (`sessions` table → many `tasks`, persisted in SQLite via
`conversation-store.ts`), but the **frontend has zero session awareness** and the
plumbing between them is single-session:

- `UIEvent`s (`shared/types/ui.ts`) are keyed only by `taskId` and carry **no
  `sessionId`**.
- `swarm-ipc.ts` hardcodes **one global session** (`currentSessionId`), created
  lazily on the first goal.
- Each `submitGoal` (`session-manager.ts`) creates a **fresh task with
  `history: []`** and a brand-new `Agent` seeded with `messages: []` — so there is
  **no conversation continuity** between goals. A session is currently just a
  container sharing a provider + permission registry.
- `TaskEvent`s emitted by the agent runner are streamed over SSE but **never
  persisted** into `tasks.history` (the column stays `[]`), so past conversations
  cannot be reconstructed from the store today.

Current UI layout (`tasks-view.tsx`): input at **top**, a horizontal split of
`TaskList | TaskTimeline` in the middle, `PermissionDrawer` at bottom. The left
rail (`app-sidebar.tsx`) is icon-only nav (Tasks / Skills / Settings).

## Goals

- **Layout:** chat-style — session list on the left (with `+ New chat` and
  Skills/Settings collapsed into the footer), conversation thread in the center
  rendered as **chat bubbles with collapsible event rows**, and the message input
  **at the bottom**.
- **Multi-session:** list sessions, create new sessions, click to switch.
- **Conversation continuity:** follow-up messages in a session continue the **same
  agent context** (the agent remembers prior turns).
- **Persistence:** sessions and their conversations survive app restart, restored
  from SQLite.

## Non-Goals (YAGNI — out of scope this round)

- Renaming sessions (title is auto-derived from the first goal, truncated).
- Deleting sessions, search, drag-to-reorder.
- Multi-window session sync.
- Streaming/rich rendering beyond what `TaskEvent` already provides.

## Key Architectural Decision: conversation continuity

**Chosen: message-reseed continuity — the store's `agent_snapshot` is the single
source of truth, reseeded into the runner each turn.**

The agent-runner already owns the pi `Agent` lifecycle (it constructs a fresh
`Agent` per `run()`). Rather than hoisting a long-lived `Agent` up to the session
(a sizable refactor for no behavior gain), each turn:

1. session-manager reads the session's current `AgentMessage[]` (in-memory cache,
   loaded from `agent_snapshot` if cold) and passes it to the runner as
   `initialMessages`.
2. the runner constructs the `Agent` with `initialState.messages = initialMessages`,
   calls `agent.prompt(goal)`, and returns the post-turn `agent.state.messages`.
3. session-manager writes those messages back to the session cache **and**
   `store.saveAgentSnapshot(sessionId, messages)`.

A **per-session serial queue** guarantees one turn at a time per session, so the
snapshot never races; cross-session parallelism is unchanged.

This delivers identical user-facing behavior to a live-Agent cache (follow-ups see
prior turns; context survives restart) while keeping the `Agent` inside the runner —
simpler and unit-testable by mocking the runner's returned messages.

Verified API support (`@earendil-works/pi-agent-core` root exports):
`agent.state.messages` is readable (assigning copies the array), `initialState.messages`
is writable, and `AgentMessage`/`AgentState` are exported from the package root.

Rejected alternatives:
- **Live `Agent` per session** — reuse one `Agent` instance across turns. Requires
  moving `Agent` ownership out of the runner; identical behavior, more lifecycle
  code, harder to unit-test. Not worth it.
- **In-memory only, no context persistence** — context lost on restart. Rejected
  because persistence was required and it would desync agent context from the
  replayed UI thread.

## Architecture

### Data model — `conversation-store.ts`

- `sessions` table: add `title TEXT` (null until first goal; then first goal
  truncated) and `agent_snapshot TEXT` (JSON of pi `AgentMessage[]` — the context
  source of truth).
- **History persistence path (new):** accumulate the `TaskEvent`s the runner emits
  into `tasks.history` and write on task termination, so the UI thread can be
  rebuilt from the store. (Today `history` stays `[]`.)
- New `listSessions()`: all non-`ended` sessions, ordered by `lastActiveAt` desc,
  returning `{ id, title, status, lastActiveAt, taskCount }`.

### Service (HTTP) + `session-manager.ts`

- `GET /sessions` → session list (id, title, status, lastActiveAt, taskCount).
- `GET /sessions/:id/tasks` → that session's tasks each with their `history`
  (for replay on switch/restart).
- `session-manager`:
  - Each session caches its `AgentMessage[]` in memory (loaded from `agent_snapshot`
    when cold).
  - **Per-session serial queue:** within one session only one turn runs at a time;
    cross-session parallelism is preserved via the existing `maxConcurrent` semaphore.
  - Each turn passes the cached messages to the runner as `initialMessages`; the
    runner returns post-turn `agent.state.messages`.
  - After each turn → update the cache and write `store.saveAgentSnapshot`.

### Event protocol — `shared/types/ui.ts`

- Add a `sessionId` field to all `task.*` `UIEvent`s (the renderer buckets by it).
- Add `session.created` and `session.updated` (title / lastActive change) events.

### Main-process IPC — `swarm-ipc.ts` + preload

- Remove the single global session. Expose:
  - `createSession()`
  - `listSessions()`
  - `getSessionTasks(sessionId)`
  - `submitGoal(sessionId, goal)` (now session-scoped)
  - session switching is **pure frontend state** — no IPC needed.
- preload surfaces these as `window.swarm.sessions.*`.

### Frontend

- `useSessionsStore` (zustand): `sessions`, `selectedSessionId`, `select`, `create`.
- Layout (`tasks-view.tsx` + `app-sidebar.tsx`):
  - **Left rail:** `+ New chat`, the session list (click to switch), Skills/Settings
    in the footer.
  - **Center:** `ConversationThread` — rewrite of `TaskTimeline` as bubbles. User
    goals right-aligned; assistant `llm.message`/summary left-aligned;
    `tool.call`/`tool.result`/`permission_request` collapsed into expandable rows.
  - **Bottom:** `ChatInput` — `TaskInput` reworked (model selector + textbox +
    send), submits to `selectedSessionId`.
- Events are bucketed by `sessionId`. Switching to a session with no live data calls
  `getSessionTasks` to replay the stored conversation.
- `PermissionDrawer` retained, filtered by `sessionId` to the current session.

## Data Flow

```
User types in ChatInput (selectedSessionId)
  → window.swarm.submitGoal(sessionId, goal)
  → IPC → service POST /sessions/:id/goal
  → session-manager: enqueue on session's serial queue
      → live Agent (seeded from agent_snapshot if cold) → agent.prompt(goal)
      → emits task.* events (now carrying sessionId) over SSE
      → on turn end: persist tasks.history + agent_snapshot
  → renderer buckets events by sessionId → ConversationThread renders bubbles

Switch session (click in list)
  → useSessionsStore.select(id)
  → if no live events for id: window.swarm.sessions.getSessionTasks(id)
      → service GET /sessions/:id/tasks → rebuild thread from stored history

App start
  → window.swarm.sessions.listSessions() → populate left rail
  → first goal to a session rehydrates its Agent from agent_snapshot
```

## Testing

- `conversation-store`: `title`/`agent_snapshot` round-trip; `listSessions` ordering
  and filtering; `tasks.history` now persists emitted events.
- `session-manager`: two goals in one session share context (second turn's seeded
  messages include the first); per-session serial queue (same-session goals don't
  overlap) while cross-session goals run concurrently up to `maxConcurrent`;
  snapshot written after each turn; cold session rehydrates from snapshot.
- `shared/types`: events carry `sessionId`; `session.created`/`session.updated`
  shapes.
- Frontend: `apply-event` buckets by `sessionId`; switching replays from
  `getSessionTasks`; `ConversationThread` renders bubbles + collapsible rows;
  `PermissionDrawer` filters by current session.

## Implementation Phases (for the plan)

1. **Backend store/events:** `title` + `agent_snapshot` columns, `listSessions`,
   `tasks.history` persistence, `sessionId` on events + session events. (+ tests)
2. **Backend continuity:** live `Agent` per session, per-session serial queue,
   snapshot write/seed. (+ tests)
3. **IPC/preload:** multi-session surface (`createSession`, `listSessions`,
   `getSessionTasks`, session-scoped `submitGoal`).
4. **Frontend:** `useSessionsStore`, layout refactor (left session rail + bottom
   input), `ConversationThread` bubbles, replay on switch.
