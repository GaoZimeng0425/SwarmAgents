# Persistent Agent Service — Design Spec

**Date:** 2026-05-28  
**Status:** Approved

## Problem

The current architecture uses a stateless Worker Pool: when a task completes, the worker resets to idle and all state is lost. This means:

- No conversation history across tasks
- No task resumption after crash or restart
- No shared browser session / auth tokens between tasks in the same conversation

## Solution

Replace the Worker Pool and Supervisor with a single persistent **Agent Service** process. Electron forks this process at startup; it runs for the lifetime of the app. The Service owns all Agent Sessions, conversation history (SQLite), and tool state.

## Architecture Overview

Three processes remain, but Main is simplified and a new Service process replaces the Worker Pool:

```
Renderer (React)  ←—Electron IPC—→  Main (Electron)  ←—HTTP+SSE—→  Agent Service (Node.js)
   unchanged                         ~20 lines changed                  all new
```

### What does not change

- `src/renderer/` — all React components, hooks, UIEvent subscriptions
- `src/preload/` — contextBridge API surface
- `src/shared/types/` — Task, ProviderInjection, UIEvent, etc.
- EventBus → Renderer broadcast logic in `wireSwarmIpc`

### What changes

| Area | Change |
|---|---|
| `src/main/supervisor/` | Replaced by ServiceClient; directory archived |
| `src/main/ipc/swarm-ipc.ts` | ~20 lines: Supervisor calls → ServiceClient calls |
| `src/worker/` | Logic migrated to `src/service/`; directory removed |
| `src/service/` | New directory — all Service code |

## Agent Service (`src/service/`)

### Startup & Port Negotiation

Main forks `src/service/index.ts`. The Service picks a random available port, starts listening, then writes to stdout:

```json
{"type":"service-started","port":51234}
```

Main parses this and stores `baseUrl = "http://127.0.0.1:51234"`. If the Service exits, Main detects the SSE disconnect, re-forks, and reconnects transparently.

### Components

**HTTP Server** — Express (or Node built-in `http`) listening on localhost only.

**SessionManager** — Creates and tracks Session objects, one per conversation. Enforces `maxConcurrentSessions` (configurable, default 4). Persists session state to SQLite on every change.

**AgentRunner** — Migration of `src/worker/pi-agent/index.ts`. Runs the pi-ai agent loop as an async function within the Service process. One AgentRunner active per Session at a time. Streams progress via SSE.

**ConversationStore** — better-sqlite3 wrapper. Synchronous writes (safe for single-process use). Stores sessions, messages, tasks, artifacts.

**ToolStateManager** — Manages Playwright BrowserContext per session (lazy init). Stores auth tokens and cookies in `tool_state_snapshots` table. Cleans up handles on session end.

### Sub-task Handoff

Child tasks run as nested AgentRunners within the **same Session**, so they share browser context and history. SessionManager enforces `MAX_SPAWN_DEPTH = 3` internally. No cross-process IPC needed for handoff — the result is a direct return value.

### Crash Recovery

On Service startup, any session with `status = 'running'` in SQLite is marked `interrupted`. Renderer shows these tasks as interrupted; user can resubmit. Browser context cannot be recovered (in-memory), but full text history is preserved.

## HTTP API

### Commands — Main → Service

| Method | Path | Body | Purpose |
|---|---|---|---|
| POST | `/sessions` | `{ provider }` | Create session, returns `{ sessionId }` |
| POST | `/sessions/:id/goal` | `{ goal, provider }` | Submit goal, returns `{ taskId }` |
| POST | `/sessions/:id/permission` | `{ actionId, decision }` | Deliver permission decision |
| POST | `/sessions/:id/cancel` | `{ taskId }` | Cancel in-flight task |
| GET | `/sessions/:id/history` | — | Returns message array |
| DELETE | `/sessions/:id` | — | End session and cleanup |

### Events — Service → Main (SSE)

```
GET /events
```

Server-Sent Events stream. Each event mirrors the existing `UIEvent` union type:

```
event: task.created
event: task.progress
event: task.complete
event: task.error
event: permission.request
event: tool.call
event: task.handoff.spawned
event: task.handoff.completed
```

Reusing `UIEvent` types means zero changes to the Renderer.

## ServiceClient (in Main)

Replaces `Supervisor`. Wraps all HTTP calls and the SSE subscription:

```typescript
type ServiceClient = {
  createSession(provider: ProviderInjection): Promise<{ sessionId: string }>
  submitGoal(sessionId: string, goal: string): Promise<{ taskId: string }>
  decidePermission(sessionId: string, actionId: string, decision: PermissionDecision): Promise<void>
  cancelTask(sessionId: string, taskId: string): Promise<void>
  getHistory(sessionId: string): Promise<Message[]>
}
```

On SSE disconnect, ServiceClient attempts reconnect with exponential backoff (max 30s). Queued goals during disconnect are held in memory and re-submitted on reconnect.

## SQLite Schema

```sql
CREATE TABLE sessions (
  id              TEXT PRIMARY KEY,
  created_at      INTEGER NOT NULL,
  last_active_at  INTEGER NOT NULL,
  status          TEXT NOT NULL,        -- 'active' | 'interrupted' | 'ended'
  provider_snapshot TEXT NOT NULL       -- JSON snapshot of ProviderInjection
);

CREATE TABLE messages (
  id          TEXT PRIMARY KEY,
  session_id  TEXT NOT NULL REFERENCES sessions(id),
  role        TEXT NOT NULL,            -- 'user' | 'assistant' | 'tool'
  content     TEXT NOT NULL,            -- JSON
  created_at  INTEGER NOT NULL
);

CREATE TABLE tasks (
  id          TEXT PRIMARY KEY,
  session_id  TEXT NOT NULL REFERENCES sessions(id),
  parent_id   TEXT,
  goal        TEXT NOT NULL,
  status      TEXT NOT NULL,            -- 'pending' | 'running' | 'completed' | 'failed' | 'interrupted'
  result      TEXT,                     -- JSON TaskResult, nullable
  budget      TEXT NOT NULL,            -- JSON ResourceBudget
  used        TEXT NOT NULL,            -- JSON ResourceBudget
  created_at  INTEGER NOT NULL,
  started_at  INTEGER,
  ended_at    INTEGER
);

CREATE TABLE tool_state_snapshots (
  session_id  TEXT NOT NULL REFERENCES sessions(id),
  key         TEXT NOT NULL,            -- e.g. 'cookies', 'auth_tokens'
  value       TEXT NOT NULL,            -- JSON
  updated_at  INTEGER NOT NULL,
  PRIMARY KEY (session_id, key)
);
```

## Session Lifecycle

1. User starts a new conversation → `POST /sessions` → `sessionId` returned
2. User types goal → `POST /sessions/:id/goal` → AgentRunner starts
3. Agent runs LLM loop, streams progress via SSE
4. Permission requests → SSE `permission.request` → user decides → `POST /sessions/:id/permission`
5. Task completes → SQLite written → SSE `task.complete`
6. Session stays alive, ready for next goal in the same conversation
7. App restarts → Service reads SQLite, rebuilds Session objects

## Concurrency

- One AgentRunner active per Session (same constraint as current one-task-per-worker)
- Multiple Sessions run in parallel, capped at `maxConcurrentSessions` (default 4)
- Child tasks (Handoff) run sequentially within the parent session's AgentRunner
- No shared mutable state between Sessions

## Out of Scope

- Multi-device sync (pure local)
- Multi-user access
- Remote deployment of Agent Service
- Authentication between Main and Service (localhost only, no auth needed)
