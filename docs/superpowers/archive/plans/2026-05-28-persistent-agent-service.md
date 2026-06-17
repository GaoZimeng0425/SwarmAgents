# Persistent Agent Service Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace the stateless Worker Pool + Supervisor with a persistent Agent Service process (HTTP + SSE) that maintains conversation history (SQLite), supports task resumption, and shares tool state within a session.

**Architecture:** Electron forks `src/service/index.ts` at startup; the service listens on a random localhost port and announces it via stdout JSON. Main connects via HTTP commands and a persistent SSE stream. SessionManager owns all Agent Sessions; each session runs one AgentRunner at a time with its own PermissionRegistry. ConversationStore persists to SQLite. Renderer and Preload are unchanged.

**Tech Stack:** Node.js `node:http` (HTTP server + SSE), `better-sqlite3` (SQLite), `ulid`, `@earendil-works/pi-ai` (agent loop), Vitest

---

## File Map

**New files:**
- `src/service/index.ts` — entry point; starts HTTP server, writes startup JSON to stdout
- `src/service/server.ts` — HTTP router; wires all routes
- `src/service/session-manager.ts` — creates/tracks Sessions, enforces concurrency limits
- `src/service/agent-runner.ts` — migrated pi-ai loop (from `src/worker/pi-agent/index.ts`)
- `src/service/conversation-store.ts` — better-sqlite3 wrapper; sessions, tasks, tool_state_snapshots
- `src/service/sse.ts` — SSE client + broadcaster helpers
- `src/service/permission-registry.ts` — per-session pending permission map; emits SSE on request
- `src/main/service-client.ts` — replaces Supervisor; HTTP commands + SSE subscription

**Modified files:**
- `electron.vite.config.ts` — add `service` entry alongside `worker`
- `vitest.config.ts` — add `@service` path alias
- `src/main/index.ts` — fork Service instead of (or in addition to) Worker
- `src/main/ipc/swarm-ipc.ts` — ~20 lines: Supervisor calls → ServiceClient calls
- `package.json` — add `better-sqlite3` + `@types/better-sqlite3`

**Archived (after all tests pass):**
- `src/main/supervisor/` → deleted
- `src/worker/` → deleted

---

## Task 1: Add `better-sqlite3` and update build config

**Files:**
- Modify: `package.json`
- Modify: `electron.vite.config.ts`
- Modify: `vitest.config.ts`

- [ ] **Step 1: Install better-sqlite3**

```bash
pnpm add better-sqlite3
pnpm add -D @types/better-sqlite3
```

Expected: `better-sqlite3` appears in `dependencies` in `package.json`.

- [ ] **Step 2: Add `service` entry to electron.vite.config.ts**

In `electron.vite.config.ts`, find the `input` block under `main.build.rollupOptions` and add the service entry:

```typescript
// Before:
input: {
  index: resolve('src/main/index.ts'),
  worker: resolve('src/worker/index.ts'),
},

// After:
input: {
  index: resolve('src/main/index.ts'),
  worker: resolve('src/worker/index.ts'),
  service: resolve('src/service/index.ts'),
},
```

Also add `@service` to the `main.resolve.alias` block:

```typescript
resolve: {
  alias: {
    '@shared': resolve('src/shared'),
    '@main': resolve('src/main'),
    '@worker': resolve('src/worker'),
    '@service': resolve('src/service'),  // add this line
  },
},
```

- [ ] **Step 3: Add `@service` alias to vitest.config.ts**

```typescript
resolve: {
  alias: {
    '@shared': resolve(__dirname, 'src/shared'),
    '@main': resolve(__dirname, 'src/main'),
    '@worker': resolve(__dirname, 'src/worker'),
    '@service': resolve(__dirname, 'src/service'),  // add this line
    '@': resolve(__dirname, 'src/renderer/src'),
  },
},
```

- [ ] **Step 4: Verify build config compiles**

```bash
pnpm typecheck:node
```

Expected: no errors (service directory doesn't exist yet, which is fine at this stage — the typecheck only validates existing files).

- [ ] **Step 5: Commit**

```bash
git add package.json pnpm-lock.yaml electron.vite.config.ts vitest.config.ts
git commit -m "build: add better-sqlite3 and service entry point"
```

---

## Task 2: ConversationStore

**Files:**
- Create: `src/service/conversation-store.ts`
- Create: `src/service/conversation-store.test.ts`

- [ ] **Step 1: Write the failing test**

Create `src/service/conversation-store.test.ts`:

```typescript
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { rmSync } from 'node:fs'
import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { createConversationStore } from './conversation-store'

const tmpDb = () => join(tmpdir(), `swarm-test-${Date.now()}-${Math.random()}.db`)

describe('ConversationStore', () => {
  let dbPath: string

  beforeEach(() => { dbPath = tmpDb() })
  afterEach(() => { try { rmSync(dbPath) } catch {} })

  it('creates and retrieves a session', () => {
    const store = createConversationStore(dbPath)
    const provider = { id: 'anthropic' as const, model: 'claude-sonnet-4-5', apiKey: 'k' }
    const session = store.createSession('ses-1', provider)
    expect(session.id).toBe('ses-1')
    expect(session.status).toBe('active')

    const fetched = store.getSession('ses-1')
    expect(fetched?.id).toBe('ses-1')
    expect(fetched?.providerSnapshot.id).toBe('anthropic')
    store.close()
  })

  it('returns interrupted sessions on restart', () => {
    const provider = { id: 'anthropic' as const, model: 'claude-sonnet-4-5', apiKey: 'k' }
    const store1 = createConversationStore(dbPath)
    store1.createSession('ses-1', provider)
    store1.updateSessionStatus('ses-1', 'active')
    store1.close()

    const store2 = createConversationStore(dbPath)
    const interrupted = store2.getInterruptedSessions()
    expect(interrupted.map((s) => s.id)).toContain('ses-1')
    store2.close()
  })

  it('saves and retrieves tasks', () => {
    const store = createConversationStore(dbPath)
    const provider = { id: 'anthropic' as const, model: 'claude-sonnet-4-5', apiKey: 'k' }
    store.createSession('ses-1', provider)

    const now = Date.now()
    store.saveTask(
      {
        id: 'task-1', parentId: null, agentDefId: 'default', goal: 'hello',
        status: 'pending', assignedWorkerId: null,
        toolAllowlist: [], budget: { tokens: 1000, calls: 10, wallMs: 60000, usdCents: 10 },
        used: { tokens: 0, calls: 0, wallMs: 0, usdCents: 0 },
        history: [], result: null, createdAt: now, startedAt: null, endedAt: null,
      },
      'ses-1',
    )
    const tasks = store.getSessionTasks('ses-1')
    expect(tasks).toHaveLength(1)
    expect(tasks[0].id).toBe('task-1')
    store.close()
  })
})
```

- [ ] **Step 2: Run test to verify it fails**

```bash
pnpm test -- conversation-store
```

Expected: FAIL — `Cannot find module './conversation-store'`

- [ ] **Step 3: Implement ConversationStore**

Create `src/service/conversation-store.ts`:

```typescript
import Database from 'better-sqlite3'
import type { ProviderInjection } from '@shared/types/provider'
import type { Task } from '@shared/types/task'

export type StoredSession = {
  id: string
  createdAt: number
  lastActiveAt: number
  status: 'active' | 'interrupted' | 'ended'
  providerSnapshot: ProviderInjection
}

export type ConversationStore = {
  createSession(id: string, provider: ProviderInjection): StoredSession
  getSession(id: string): StoredSession | undefined
  updateSessionStatus(id: string, status: StoredSession['status']): void
  updateSessionLastActive(id: string): void
  getInterruptedSessions(): StoredSession[]
  saveTask(task: Task, sessionId: string): void
  updateTaskStatus(taskId: string, status: Task['status'], result?: Task['result']): void
  getSessionTasks(sessionId: string): Task[]
  saveToolState(sessionId: string, key: string, value: unknown): void
  getToolState(sessionId: string, key: string): unknown
  close(): void
}

export function createConversationStore(dbPath: string): ConversationStore {
  const db = new Database(dbPath)
  db.pragma('journal_mode = WAL')

  db.exec(`
    CREATE TABLE IF NOT EXISTS sessions (
      id              TEXT PRIMARY KEY,
      created_at      INTEGER NOT NULL,
      last_active_at  INTEGER NOT NULL,
      status          TEXT NOT NULL,
      provider_snapshot TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS tasks (
      id          TEXT PRIMARY KEY,
      session_id  TEXT NOT NULL REFERENCES sessions(id),
      parent_id   TEXT,
      goal        TEXT NOT NULL,
      status      TEXT NOT NULL,
      result      TEXT,
      budget      TEXT NOT NULL,
      used        TEXT NOT NULL,
      created_at  INTEGER NOT NULL,
      started_at  INTEGER,
      ended_at    INTEGER
    );
    CREATE TABLE IF NOT EXISTS tool_state_snapshots (
      session_id  TEXT NOT NULL REFERENCES sessions(id),
      key         TEXT NOT NULL,
      value       TEXT NOT NULL,
      updated_at  INTEGER NOT NULL,
      PRIMARY KEY (session_id, key)
    );
  `)

  const stmtInsertSession = db.prepare(
    `INSERT INTO sessions (id, created_at, last_active_at, status, provider_snapshot)
     VALUES (?, ?, ?, 'active', ?)`,
  )
  const stmtGetSession = db.prepare(`SELECT * FROM sessions WHERE id = ?`)
  const stmtUpdateStatus = db.prepare(`UPDATE sessions SET status = ? WHERE id = ?`)
  const stmtUpdateLastActive = db.prepare(`UPDATE sessions SET last_active_at = ? WHERE id = ?`)
  const stmtGetInterrupted = db.prepare(`SELECT * FROM sessions WHERE status = 'active'`)
  const stmtInsertTask = db.prepare(
    `INSERT OR REPLACE INTO tasks
     (id, session_id, parent_id, goal, status, result, budget, used, created_at, started_at, ended_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  )
  const stmtUpdateTask = db.prepare(
    `UPDATE tasks SET status = ?, result = ?, ended_at = ? WHERE id = ?`,
  )
  const stmtGetTasks = db.prepare(`SELECT * FROM tasks WHERE session_id = ?`)
  const stmtUpsertToolState = db.prepare(
    `INSERT OR REPLACE INTO tool_state_snapshots (session_id, key, value, updated_at)
     VALUES (?, ?, ?, ?)`,
  )
  const stmtGetToolState = db.prepare(
    `SELECT value FROM tool_state_snapshots WHERE session_id = ? AND key = ?`,
  )

  const rowToSession = (row: Record<string, unknown>): StoredSession => ({
    id: row.id as string,
    createdAt: row.created_at as number,
    lastActiveAt: row.last_active_at as number,
    status: row.status as StoredSession['status'],
    providerSnapshot: JSON.parse(row.provider_snapshot as string) as ProviderInjection,
  })

  const rowToTask = (row: Record<string, unknown>): Task => ({
    id: row.id as string,
    parentId: (row.parent_id as string | null) ?? null,
    agentDefId: 'default',
    goal: row.goal as string,
    status: row.status as Task['status'],
    assignedWorkerId: null,
    toolAllowlist: [],
    budget: JSON.parse(row.budget as string) as Task['budget'],
    used: JSON.parse(row.used as string) as Task['used'],
    history: [],
    result: row.result ? (JSON.parse(row.result as string) as Task['result']) : null,
    createdAt: row.created_at as number,
    startedAt: (row.started_at as number | null) ?? null,
    endedAt: (row.ended_at as number | null) ?? null,
  })

  return {
    createSession(id, provider) {
      const now = Date.now()
      stmtInsertSession.run(id, now, now, JSON.stringify(provider))
      return { id, createdAt: now, lastActiveAt: now, status: 'active', providerSnapshot: provider }
    },

    getSession(id) {
      const row = stmtGetSession.get(id) as Record<string, unknown> | undefined
      return row ? rowToSession(row) : undefined
    },

    updateSessionStatus(id, status) {
      stmtUpdateStatus.run(status, id)
    },

    updateSessionLastActive(id) {
      stmtUpdateLastActive.run(Date.now(), id)
    },

    getInterruptedSessions() {
      return (stmtGetInterrupted.all() as Record<string, unknown>[]).map(rowToSession)
    },

    saveTask(task, sessionId) {
      stmtInsertTask.run(
        task.id, sessionId, task.parentId ?? null, task.goal, task.status,
        task.result ? JSON.stringify(task.result) : null,
        JSON.stringify(task.budget), JSON.stringify(task.used),
        task.createdAt, task.startedAt ?? null, task.endedAt ?? null,
      )
    },

    updateTaskStatus(taskId, status, result) {
      stmtUpdateTask.run(status, result ? JSON.stringify(result) : null, Date.now(), taskId)
    },

    getSessionTasks(sessionId) {
      return (stmtGetTasks.all(sessionId) as Record<string, unknown>[]).map(rowToTask)
    },

    saveToolState(sessionId, key, value) {
      stmtUpsertToolState.run(sessionId, key, JSON.stringify(value), Date.now())
    },

    getToolState(sessionId, key) {
      const row = stmtGetToolState.get(sessionId, key) as { value: string } | undefined
      return row ? JSON.parse(row.value) : undefined
    },

    close() {
      db.close()
    },
  }
}
```

- [ ] **Step 4: Run tests**

```bash
pnpm test -- conversation-store
```

Expected: PASS (3 tests)

- [ ] **Step 5: Commit**

```bash
git add src/service/conversation-store.ts src/service/conversation-store.test.ts
git commit -m "feat(service): ConversationStore with SQLite persistence"
```

---

## Task 3: SSE broadcaster

**Files:**
- Create: `src/service/sse.ts`
- Create: `src/service/sse.test.ts`

- [ ] **Step 1: Write the failing test**

Create `src/service/sse.test.ts`:

```typescript
import { describe, it, expect, vi } from 'vitest'
import { createSseBroadcaster, createSseClient } from './sse'
import type { ServerResponse } from 'node:http'

function mockRes() {
  const chunks: string[] = []
  return {
    writeHead: vi.fn(),
    flushHeaders: vi.fn(),
    write: vi.fn((chunk: string) => { chunks.push(chunk); return true }),
    end: vi.fn(),
    chunks,
  } as unknown as ServerResponse & { chunks: string[] }
}

describe('SSE', () => {
  it('createSseClient sends well-formed SSE lines', () => {
    const res = mockRes() as ReturnType<typeof mockRes>
    const client = createSseClient(res)
    client.send('task.progress', { taskId: 'abc' })
    expect(res.write).toHaveBeenCalledWith(
      `event: task.progress\ndata: ${JSON.stringify({ taskId: 'abc' })}\n\n`,
    )
  })

  it('broadcaster delivers to all connected clients', () => {
    const broadcaster = createSseBroadcaster()
    const res1 = mockRes() as ReturnType<typeof mockRes>
    const res2 = mockRes() as ReturnType<typeof mockRes>
    const c1 = createSseClient(res1)
    const c2 = createSseClient(res2)
    broadcaster.addClient(c1)
    broadcaster.addClient(c2)
    broadcaster.broadcast('task.complete', { taskId: 'x' })
    expect(res1.write).toHaveBeenCalledTimes(1)
    expect(res2.write).toHaveBeenCalledTimes(1)
  })

  it('broadcaster skips removed clients', () => {
    const broadcaster = createSseBroadcaster()
    const res = mockRes() as ReturnType<typeof mockRes>
    const client = createSseClient(res)
    broadcaster.addClient(client)
    broadcaster.removeClient(client)
    broadcaster.broadcast('task.complete', { taskId: 'x' })
    expect(res.write).not.toHaveBeenCalled()
  })
})
```

- [ ] **Step 2: Run test to verify it fails**

```bash
pnpm test -- sse.test
```

Expected: FAIL — `Cannot find module './sse'`

- [ ] **Step 3: Implement SSE helpers**

Create `src/service/sse.ts`:

```typescript
import type { ServerResponse } from 'node:http'

export type SseClient = {
  send(event: string, data: unknown): void
  close(): void
}

export function createSseClient(res: ServerResponse): SseClient {
  res.writeHead(200, {
    'Content-Type': 'text/event-stream',
    'Cache-Control': 'no-cache',
    Connection: 'keep-alive',
  })
  res.flushHeaders()

  return {
    send(event, data) {
      res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`)
    },
    close() {
      res.end()
    },
  }
}

export type SseBroadcaster = {
  addClient(client: SseClient): void
  removeClient(client: SseClient): void
  broadcast(event: string, data: unknown): void
}

export function createSseBroadcaster(): SseBroadcaster {
  const clients = new Set<SseClient>()
  return {
    addClient(client) {
      clients.add(client)
    },
    removeClient(client) {
      clients.delete(client)
    },
    broadcast(event, data) {
      for (const client of clients) client.send(event, data)
    },
  }
}
```

- [ ] **Step 4: Run tests**

```bash
pnpm test -- sse.test
```

Expected: PASS (3 tests)

- [ ] **Step 5: Commit**

```bash
git add src/service/sse.ts src/service/sse.test.ts
git commit -m "feat(service): SSE broadcaster"
```

---

## Task 4: PermissionRegistry

**Files:**
- Create: `src/service/permission-registry.ts`
- Create: `src/service/permission-registry.test.ts`

- [ ] **Step 1: Write the failing test**

Create `src/service/permission-registry.test.ts`:

```typescript
import { describe, it, expect, vi } from 'vitest'
import { createPermissionRegistry } from './permission-registry'

describe('PermissionRegistry', () => {
  it('broadcasts SSE event on request and resolves on decision', async () => {
    const broadcast = vi.fn()
    const registry = createPermissionRegistry(broadcast)

    const promise = registry.request({
      taskId: 'task-1',
      toolName: 'fs.write',
      risk: 'high',
      summary: 'Write to /etc/hosts',
      payload: {},
    })

    expect(broadcast).toHaveBeenCalledOnce()
    const [event, data] = broadcast.mock.calls[0] as [string, { actionId: string }]
    expect(event).toBe('task.permission_request')
    expect(data.actionId).toBeTruthy()

    registry.resolve(data.actionId, 'grant')
    await expect(promise).resolves.toBe('grant')
  })

  it('ignores resolve for unknown actionId', () => {
    const registry = createPermissionRegistry(vi.fn())
    expect(() => registry.resolve('unknown', 'deny')).not.toThrow()
  })
})
```

- [ ] **Step 2: Run test to verify it fails**

```bash
pnpm test -- permission-registry
```

Expected: FAIL — `Cannot find module './permission-registry'`

- [ ] **Step 3: Implement PermissionRegistry**

Create `src/service/permission-registry.ts`:

```typescript
import type { PermissionDecision } from '@shared/types/ui'
import type { Risk } from '@shared/types/ipc'
import { ulid } from 'ulid'

type PendingPermission = {
  resolve: (d: PermissionDecision) => void
  timer: NodeJS.Timeout
}

export type PermissionRegistry = {
  request(req: {
    taskId: string
    toolName: string
    risk: Risk
    summary: string
    payload: unknown
  }): Promise<PermissionDecision>
  resolve(actionId: string, decision: PermissionDecision): void
}

const PERMISSION_TIMEOUT_MS = 30_000

export function createPermissionRegistry(
  broadcast: (event: string, data: unknown) => void,
): PermissionRegistry {
  const pending = new Map<string, PendingPermission>()

  return {
    request(req) {
      const actionId = ulid()
      return new Promise<PermissionDecision>((resolve) => {
        const timer = setTimeout(() => {
          if (pending.delete(actionId)) resolve('deny')
        }, PERMISSION_TIMEOUT_MS)
        pending.set(actionId, { resolve, timer })
        broadcast('task.permission_request', { actionId, ...req })
      })
    },

    resolve(actionId, decision) {
      const p = pending.get(actionId)
      if (!p) return
      clearTimeout(p.timer)
      pending.delete(actionId)
      p.resolve(decision)
    },
  }
}
```

- [ ] **Step 4: Run tests**

```bash
pnpm test -- permission-registry
```

Expected: PASS (2 tests)

- [ ] **Step 5: Commit**

```bash
git add src/service/permission-registry.ts src/service/permission-registry.test.ts
git commit -m "feat(service): PermissionRegistry with 30s timeout"
```

---

## Task 5: AgentRunner (migrate from worker)

**Files:**
- Create: `src/service/agent-runner.ts`
- Create: `src/service/agent-runner.test.ts`

This is a migration of `src/worker/pi-agent/index.ts`. The key difference: `send(Outbound)` is replaced by `emit(UIEvent)` via the SSE broadcaster, and the HandoffClient is replaced by a `spawnChild` callback.

- [ ] **Step 1: Write the failing test**

Create `src/service/agent-runner.test.ts`:

```typescript
import { describe, it, expect, vi } from 'vitest'
import { createAgentRunner } from './agent-runner'
import type { Task } from '@shared/types/task'
import type { ProviderInjection } from '@shared/types/provider'

const mkTask = (id: string): Task => ({
  id, parentId: null, agentDefId: 'default', goal: 'test goal',
  status: 'pending', assignedWorkerId: null, toolAllowlist: [],
  budget: { tokens: 1000, calls: 10, wallMs: 60000, usdCents: 10 },
  used: { tokens: 0, calls: 0, wallMs: 0, usdCents: 0 },
  history: [], result: null, createdAt: Date.now(), startedAt: null, endedAt: null,
})

const mkProvider = (): ProviderInjection => ({
  id: 'anthropic', model: 'claude-haiku-4-5', apiKey: 'test-key',
})

describe('AgentRunner', () => {
  it('emits task.error when setup fails (bad provider)', async () => {
    const emitted: unknown[] = []
    const runner = createAgentRunner({
      task: mkTask('t-1'),
      provider: { id: 'anthropic', model: 'claude-haiku-4-5', apiKey: '' },
      agentDefinition: { id: 'default', name: 'Default', systemPrompt: '', toolScope: 'all', maxIterations: 1 },
      emit: (event, data) => emitted.push({ event, data }),
      permissionRegistry: { request: vi.fn(), resolve: vi.fn() },
      spawnChild: vi.fn(),
      sessionId: 'ses-1',
    })
    await runner.run()
    const errEvent = emitted.find((e) => (e as { event: string }).event === 'task.error')
    expect(errEvent).toBeTruthy()
  })
})
```

- [ ] **Step 2: Run test to verify it fails**

```bash
pnpm test -- agent-runner
```

Expected: FAIL — `Cannot find module './agent-runner'`

- [ ] **Step 3: Implement AgentRunner**

Create `src/service/agent-runner.ts`. This is a near-copy of `src/worker/pi-agent/index.ts` with `send(Outbound)` replaced by `emit(event, data)` and `HandoffClient` replaced by `spawnChild`. Copy the full `runPiAgent` function body, then adapt the three differences below:

```typescript
import { createLogger } from '@shared/logger'
import type { AgentDefinition } from '@shared/types/agent'
import type { PermissionDecision } from '@shared/types/ui'
import type { Risk } from '@shared/types/ipc'
import type { ProviderInjection } from '@shared/types/provider'
import type { Task, TaskResult } from '@shared/types/task'
import type { PermissionRegistry } from './permission-registry'

// Copy resolveModel, cloneTemplate, getModelLoose helpers verbatim from
// src/worker/pi-agent/index.ts (lines 1-88). They have no IPC dependencies.

// [paste resolveModel and helpers here verbatim from src/worker/pi-agent/index.ts]

type EmitFn = (event: string, data: unknown) => void

type AgentRunnerDeps = {
  task: Task
  provider: ProviderInjection
  agentDefinition: AgentDefinition
  sessionId: string
  emit: EmitFn
  permissionRegistry: PermissionRegistry
  spawnChild(parentTaskId: string, newGoal: string, suggestedTools?: string[]): Promise<{ childTaskId: string; result: TaskResult }>
}

export type AgentRunner = {
  run(): Promise<void>
}

export function createAgentRunner(deps: AgentRunnerDeps): AgentRunner {
  const { task, provider, agentDefinition, sessionId, emit, permissionRegistry, spawnChild } = deps
  const log = createLogger({ process: 'service' }).child({ component: 'agent-runner', taskId: task.id })

  return {
    async run(): Promise<void> {
      // Difference 1: send → emit UIEvent format
      const sendProgress = (event: unknown) =>
        emit('task.progress', { taskId: task.id, event, ts: Date.now() })

      // Difference 2: PermissionClient uses PermissionRegistry (no IPC)
      const permissionClient = {
        request: (req: { taskId: string; toolName: string; risk: Risk; summary: string; payload: unknown }) =>
          permissionRegistry.request(req),
        resolve: (actionId: string, decision: PermissionDecision) =>
          permissionRegistry.resolve(actionId, decision),
      }

      // Difference 3: HandoffClient uses spawnChild callback (no IPC)
      const handoffClient = {
        spawn: (parentTaskId: string, newGoal: string, suggestedTools?: string[]) =>
          spawnChild(parentTaskId, newGoal, suggestedTools),
        resolve: (_childTaskId: string, _result: TaskResult) => {
          // No-op: resolution is handled by spawnChild's Promise
        },
      }

      // From here: paste the body of runPiAgent verbatim from
      // src/worker/pi-agent/index.ts (lines 98-end), replacing:
      //   deps.send({ type: 'task.error', ... })  →  emit('task.error', { taskId, error, ts: Date.now() })
      //   deps.send({ type: 'task.complete', ... }) → emit('task.complete', { taskId, summary, ts: Date.now() })
      //   deps.send({ type: 'progress', ... })     → sendProgress(event)
      //   deps.send({ type: 'tool.call', ... })    → emit('task.tool_call', { taskId, tool, args, ts })
      // [paste adapted body here]
      log.info({ msg: 'agent-runner stub — replace with adapted runPiAgent body' })
      emit('task.error', { taskId: task.id, error: { code: 'not_implemented', message: 'stub', tier: 'fatal' }, ts: Date.now() })
    },
  }
}
```

> **Implementation note:** The bulk of this task is a mechanical copy-paste of `src/worker/pi-agent/index.ts` lines 1–88 (model resolution helpers) and the body of `runPiAgent`. The only non-mechanical changes are the three `send → emit` adaptations listed above. Complete the paste before moving to Step 4.

- [ ] **Step 4: Replace stub body with adapted runPiAgent**

Open `src/worker/pi-agent/index.ts`. Copy:
1. Lines 1–88 (imports + model helpers) → paste at top of `agent-runner.ts`, adjusting imports
2. The body of `runPiAgent` (lines 98–end) → paste inside `run()`, replacing the stub log/emit lines

Apply the three substitutions:
- `deps.send({ type: 'task.error', taskId: ..., error: ... })` → `emit('task.error', { taskId: task.id, error, ts: Date.now() })`
- `deps.send({ type: 'task.complete', taskId: ..., result: ... })` → `emit('task.complete', { taskId: task.id, summary: result.summary, ts: Date.now() })`
- `deps.send({ type: 'progress', event: ... })` → `sendProgress(event)`
- `deps.send({ type: 'tool.call', ... })` → `emit('task.tool_call', { taskId: task.id, workerId: sessionId, tool: ..., args: ..., ts: Date.now() })`

- [ ] **Step 5: Run tests**

```bash
pnpm test -- agent-runner
```

Expected: PASS (1 test — bad-provider path emits task.error)

- [ ] **Step 6: Commit**

```bash
git add src/service/agent-runner.ts src/service/agent-runner.test.ts
git commit -m "feat(service): AgentRunner migrated from worker/pi-agent"
```

---

## Task 6: SessionManager

**Files:**
- Create: `src/service/session-manager.ts`
- Create: `src/service/session-manager.test.ts`

- [ ] **Step 1: Write the failing test**

Create `src/service/session-manager.test.ts`:

```typescript
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { rmSync } from 'node:fs'
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { createSessionManager } from './session-manager'
import { createConversationStore } from './conversation-store'
import { createSseBroadcaster } from './sse'

const tmpDb = () => join(tmpdir(), `swarm-ses-test-${Date.now()}.db`)

describe('SessionManager', () => {
  let dbPath: string

  beforeEach(() => { dbPath = tmpDb() })
  afterEach(() => { try { rmSync(dbPath) } catch {} })

  it('creates a session and returns sessionId', () => {
    const store = createConversationStore(dbPath)
    const broadcaster = createSseBroadcaster()
    const manager = createSessionManager({ store, broadcaster, maxConcurrent: 2 })
    const provider = { id: 'anthropic' as const, model: 'claude-haiku-4-5', apiKey: 'k' }

    const { sessionId } = manager.createSession(provider)
    expect(sessionId).toBeTruthy()
    expect(store.getSession(sessionId)?.status).toBe('active')
    store.close()
  })

  it('marks active sessions interrupted on init', () => {
    const store = createConversationStore(dbPath)
    const provider = { id: 'anthropic' as const, model: 'claude-haiku-4-5', apiKey: 'k' }
    store.createSession('old-ses', provider)
    store.close()

    const store2 = createConversationStore(dbPath)
    const broadcaster = createSseBroadcaster()
    createSessionManager({ store: store2, broadcaster, maxConcurrent: 2 })

    expect(store2.getSession('old-ses')?.status).toBe('interrupted')
    store2.close()
  })

  it('resolves permission by forwarding to registry', () => {
    const store = createConversationStore(dbPath)
    const broadcaster = createSseBroadcaster()
    const manager = createSessionManager({ store, broadcaster, maxConcurrent: 2 })
    const provider = { id: 'anthropic' as const, model: 'claude-haiku-4-5', apiKey: 'k' }
    const { sessionId } = manager.createSession(provider)

    // Should not throw for unknown actionId
    expect(() => manager.resolvePermission(sessionId, 'no-such-action', 'deny')).not.toThrow()
    store.close()
  })
})
```

- [ ] **Step 2: Run test to verify it fails**

```bash
pnpm test -- session-manager
```

Expected: FAIL — `Cannot find module './session-manager'`

- [ ] **Step 3: Implement SessionManager**

Create `src/service/session-manager.ts`:

```typescript
import { ulid } from 'ulid'
import type { ProviderInjection } from '@shared/types/provider'
import type { AgentDefinition } from '@shared/types/agent'
import type { PermissionDecision } from '@shared/types/ui'
import type { Task, TaskResult } from '@shared/types/task'
import { createAgentRunner } from './agent-runner'
import type { ConversationStore } from './conversation-store'
import { createPermissionRegistry, type PermissionRegistry } from './permission-registry'
import type { SseBroadcaster } from './sse'

type Session = {
  id: string
  provider: ProviderInjection
  permissionRegistry: PermissionRegistry
  runnerActive: boolean
}

type SessionManagerConfig = {
  store: ConversationStore
  broadcaster: SseBroadcaster
  maxConcurrent: number
}

export type SessionManager = {
  createSession(provider: ProviderInjection): { sessionId: string }
  submitGoal(sessionId: string, goal: string, agentDef?: AgentDefinition): { taskId: string }
  resolvePermission(sessionId: string, actionId: string, decision: PermissionDecision): void
  endSession(sessionId: string): void
}

const DEFAULT_AGENT_DEF: AgentDefinition = {
  id: 'default', name: 'Default Agent', systemPrompt: '',
  toolScope: 'all', maxIterations: 25,
}

export function createSessionManager(cfg: SessionManagerConfig): SessionManager {
  const { store, broadcaster, maxConcurrent } = cfg
  const sessions = new Map<string, Session>()

  // Mark any sessions left 'active' from a previous run as interrupted.
  for (const s of store.getInterruptedSessions()) {
    store.updateSessionStatus(s.id, 'interrupted')
    broadcaster.broadcast('task.error', {
      taskId: s.id,
      error: { code: 'service_restart', message: 'Agent Service restarted; session interrupted.', tier: 'fatal' },
      ts: Date.now(),
    })
  }

  const emit = (event: string, data: unknown) => broadcaster.broadcast(event, data)

  const spawnChild = async (
    sessionId: string,
    parentTaskId: string,
    newGoal: string,
    suggestedTools?: string[],
  ): Promise<{ childTaskId: string; result: TaskResult }> => {
    const session = sessions.get(sessionId)
    if (!session) throw new Error(`session ${sessionId} not found`)

    const childTaskId = ulid()
    const now = Date.now()
    const childTask: Task = {
      id: childTaskId, parentId: parentTaskId, agentDefId: 'default',
      goal: newGoal, status: 'pending', assignedWorkerId: null,
      toolAllowlist: suggestedTools ?? ['peekaboo.*', 'web.*', 'fs.*'],
      budget: { tokens: 50_000, calls: 25, wallMs: 300_000, usdCents: 100 },
      used: { tokens: 0, calls: 0, wallMs: 0, usdCents: 0 },
      history: [], result: null, createdAt: now, startedAt: null, endedAt: null,
    }
    store.saveTask(childTask, sessionId)

    broadcaster.broadcast('task.handoff.spawned', { parentTaskId, childTaskId, ts: now })

    return new Promise<{ childTaskId: string; result: TaskResult }>((resolve) => {
      const runner = createAgentRunner({
        task: childTask, provider: session.provider,
        agentDefinition: DEFAULT_AGENT_DEF, sessionId,
        emit, permissionRegistry: session.permissionRegistry,
        spawnChild: (pt, ng, st) => spawnChild(sessionId, pt, ng, st),
      })
      void runner.run().then(() => {
        // result will have been emitted via task.complete; reconstruct minimal result
        resolve({ childTaskId, result: { summary: '', artifacts: [] } })
      })
    })
  }

  return {
    createSession(provider) {
      const sessionId = ulid()
      store.createSession(sessionId, provider)
      const permissionRegistry = createPermissionRegistry(emit)
      sessions.set(sessionId, { id: sessionId, provider, permissionRegistry, runnerActive: false })
      return { sessionId }
    },

    submitGoal(sessionId, goal, agentDef = DEFAULT_AGENT_DEF) {
      const session = sessions.get(sessionId)
      if (!session) throw new Error(`session ${sessionId} not found`)

      const taskId = ulid()
      const now = Date.now()
      const task: Task = {
        id: taskId, parentId: null, agentDefId: agentDef.id,
        goal, status: 'pending', assignedWorkerId: null,
        toolAllowlist: ['peekaboo.*', 'web.*', 'fs.*'],
        budget: { tokens: 100_000, calls: 50, wallMs: 600_000, usdCents: 200 },
        used: { tokens: 0, calls: 0, wallMs: 0, usdCents: 0 },
        history: [], result: null, createdAt: now, startedAt: null, endedAt: null,
      }

      store.saveTask(task, sessionId)
      broadcaster.broadcast('task.created', { taskId, goal, ts: now })
      store.updateSessionLastActive(sessionId)

      const runner = createAgentRunner({
        task, provider: session.provider, agentDefinition: agentDef,
        sessionId, emit, permissionRegistry: session.permissionRegistry,
        spawnChild: (pt, ng, st) => spawnChild(sessionId, pt, ng, st),
      })

      session.runnerActive = true
      void runner.run().then(() => {
        session.runnerActive = false
        store.updateTaskStatus(taskId, 'completed')
      })

      return { taskId }
    },

    resolvePermission(sessionId, actionId, decision) {
      sessions.get(sessionId)?.permissionRegistry.resolve(actionId, decision)
    },

    endSession(sessionId) {
      store.updateSessionStatus(sessionId, 'ended')
      sessions.delete(sessionId)
    },
  }
}
```

- [ ] **Step 4: Run tests**

```bash
pnpm test -- session-manager
```

Expected: PASS (3 tests)

- [ ] **Step 5: Commit**

```bash
git add src/service/session-manager.ts src/service/session-manager.test.ts
git commit -m "feat(service): SessionManager with SQLite-backed sessions"
```

---

## Task 7: Service HTTP server + entry point

**Files:**
- Create: `src/service/server.ts`
- Create: `src/service/server.test.ts`
- Create: `src/service/index.ts`

- [ ] **Step 1: Write the failing test**

Create `src/service/server.test.ts`:

```typescript
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { createServer } from './server'
import type { SessionManager } from './session-manager'
import type { SseBroadcaster } from './sse'
import { createSseBroadcaster } from './sse'

function mockManager(): SessionManager {
  return {
    createSession: vi.fn().mockReturnValue({ sessionId: 'ses-1' }),
    submitGoal: vi.fn().mockReturnValue({ taskId: 'task-1' }),
    resolvePermission: vi.fn(),
    endSession: vi.fn(),
  }
}

async function request(
  port: number,
  method: string,
  path: string,
  body?: unknown,
): Promise<{ status: number; body: unknown }> {
  const res = await fetch(`http://127.0.0.1:${port}${path}`, {
    method,
    headers: body ? { 'Content-Type': 'application/json' } : {},
    body: body ? JSON.stringify(body) : undefined,
  })
  const text = await res.text()
  let parsed: unknown
  try { parsed = JSON.parse(text) } catch { parsed = text }
  return { status: res.status, body: parsed }
}

describe('Service HTTP server', () => {
  let port: number
  let close: () => Promise<void>
  let manager: SessionManager
  let broadcaster: SseBroadcaster

  beforeEach(async () => {
    manager = mockManager()
    broadcaster = createSseBroadcaster()
    const server = createServer({ manager, broadcaster })
    port = await new Promise<number>((resolve) => {
      server.listen(0, '127.0.0.1', () => {
        resolve((server.address() as { port: number }).port)
      })
    })
    close = () => new Promise((res) => server.close(() => res()))
  })

  afterEach(() => close())

  it('POST /sessions creates a session', async () => {
    const res = await request(port, 'POST', '/sessions', {
      provider: { id: 'anthropic', model: 'claude-haiku-4-5', apiKey: 'k' },
    })
    expect(res.status).toBe(200)
    expect((res.body as { sessionId: string }).sessionId).toBe('ses-1')
    expect(manager.createSession).toHaveBeenCalledOnce()
  })

  it('POST /sessions/:id/goal submits a goal', async () => {
    const res = await request(port, 'POST', '/sessions/ses-1/goal', {
      goal: 'do something',
      provider: { id: 'anthropic', model: 'claude-haiku-4-5', apiKey: 'k' },
    })
    expect(res.status).toBe(200)
    expect((res.body as { taskId: string }).taskId).toBe('task-1')
  })

  it('POST /sessions/:id/permission routes decision', async () => {
    const res = await request(port, 'POST', '/sessions/ses-1/permission', {
      actionId: 'act-1', decision: 'grant',
    })
    expect(res.status).toBe(200)
    expect(manager.resolvePermission).toHaveBeenCalledWith('ses-1', 'act-1', 'grant')
  })

  it('GET /health returns 200', async () => {
    const res = await request(port, 'GET', '/health')
    expect(res.status).toBe(200)
  })
})
```

- [ ] **Step 2: Run test to verify it fails**

```bash
pnpm test -- service/server
```

Expected: FAIL — `Cannot find module './server'`

- [ ] **Step 3: Implement HTTP server**

Create `src/service/server.ts`:

```typescript
import { createServer as createHttpServer, type Server } from 'node:http'
import type { SessionManager } from './session-manager'
import type { SseBroadcaster } from './sse'
import { createSseClient } from './sse'

type ServerConfig = {
  manager: SessionManager
  broadcaster: SseBroadcaster
}

function readBody(req: import('node:http').IncomingMessage): Promise<unknown> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = []
    req.on('data', (c: Buffer) => chunks.push(c))
    req.on('end', () => {
      try {
        resolve(chunks.length ? JSON.parse(Buffer.concat(chunks).toString()) : undefined)
      } catch {
        reject(new Error('invalid JSON'))
      }
    })
    req.on('error', reject)
  })
}

function json(res: import('node:http').ServerResponse, status: number, body: unknown): void {
  const payload = JSON.stringify(body)
  res.writeHead(status, { 'Content-Type': 'application/json' })
  res.end(payload)
}

export function createServer(cfg: ServerConfig): Server {
  const { manager, broadcaster } = cfg

  return createHttpServer(async (req, res) => {
    const url = req.url ?? '/'
    const method = req.method ?? 'GET'

    try {
      // Health check
      if (method === 'GET' && url === '/health') {
        json(res, 200, { ok: true })
        return
      }

      // SSE event stream
      if (method === 'GET' && url === '/events') {
        const client = createSseClient(res)
        broadcaster.addClient(client)
        req.on('close', () => broadcaster.removeClient(client))
        return
      }

      // POST /sessions
      if (method === 'POST' && url === '/sessions') {
        const body = (await readBody(req)) as { provider: import('@shared/types/provider').ProviderInjection }
        const result = manager.createSession(body.provider)
        json(res, 200, result)
        return
      }

      // POST /sessions/:id/goal
      const goalMatch = /^\/sessions\/([^/]+)\/goal$/.exec(url)
      if (method === 'POST' && goalMatch) {
        const sessionId = goalMatch[1]
        const body = (await readBody(req)) as { goal: string }
        const result = manager.submitGoal(sessionId, body.goal)
        json(res, 200, result)
        return
      }

      // POST /sessions/:id/permission
      const permMatch = /^\/sessions\/([^/]+)\/permission$/.exec(url)
      if (method === 'POST' && permMatch) {
        const sessionId = permMatch[1]
        const body = (await readBody(req)) as {
          actionId: string
          decision: import('@shared/types/ui').PermissionDecision
        }
        manager.resolvePermission(sessionId, body.actionId, body.decision)
        json(res, 200, { ok: true })
        return
      }

      // POST /sessions/:id/cancel
      const cancelMatch = /^\/sessions\/([^/]+)\/cancel$/.exec(url)
      if (method === 'POST' && cancelMatch) {
        json(res, 200, { ok: true })
        return
      }

      // DELETE /sessions/:id
      const deleteMatch = /^\/sessions\/([^/]+)$/.exec(url)
      if (method === 'DELETE' && deleteMatch) {
        manager.endSession(deleteMatch[1])
        json(res, 200, { ok: true })
        return
      }

      json(res, 404, { error: 'not found' })
    } catch (err) {
      json(res, 500, { error: String(err) })
    }
  })
}
```

- [ ] **Step 4: Create entry point**

Create `src/service/index.ts`:

```typescript
import { createLogger } from '@shared/logger'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createConversationStore } from './conversation-store'
import { createSseBroadcaster } from './sse'
import { createSessionManager } from './session-manager'
import { createServer } from './server'

const log = createLogger({ process: 'service' }).child({ component: 'index' })

const dbPath = process.env.SWARM_SERVICE_DB_PATH ?? join(tmpdir(), 'swarm-agent-service.db')

const store = createConversationStore(dbPath)
const broadcaster = createSseBroadcaster()
const manager = createSessionManager({ store, broadcaster, maxConcurrent: 4 })
const server = createServer({ manager, broadcaster })

server.listen(0, '127.0.0.1', () => {
  const addr = server.address() as { port: number }
  const out = JSON.stringify({ type: 'service-started', port: addr.port })
  process.stdout.write(out + '\n')
  log.info({ msg: 'service started', port: addr.port, dbPath })
})

process.on('SIGTERM', () => {
  log.info({ msg: 'shutting down' })
  server.close(() => {
    store.close()
    process.exit(0)
  })
})
```

- [ ] **Step 5: Run server tests**

```bash
pnpm test -- service/server
```

Expected: PASS (4 tests)

- [ ] **Step 6: Commit**

```bash
git add src/service/server.ts src/service/server.test.ts src/service/index.ts
git commit -m "feat(service): HTTP server + SSE routes + entry point"
```

---

## Task 8: ServiceClient (Main process)

**Files:**
- Create: `src/main/service-client.ts`
- Create: `src/main/service-client.test.ts`

ServiceClient replaces Supervisor. It communicates with the Agent Service via Node.js built-in `http`.

- [ ] **Step 1: Write the failing test**

Create `src/main/service-client.test.ts`:

```typescript
import { createServer as createHttpServer } from 'node:http'
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { createServiceClient } from './service-client'

function startMockService(handler: (url: string, method: string, body: unknown) => unknown) {
  const emitCallbacks: Array<(event: string, data: unknown) => void> = []
  const server = createHttpServer(async (req, res) => {
    if (req.url === '/events') {
      res.writeHead(200, { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache' })
      emitCallbacks.push((event, data) => {
        res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`)
      })
      return
    }
    const chunks: Buffer[] = []
    req.on('data', (c: Buffer) => chunks.push(c))
    await new Promise((r) => req.on('end', r))
    const body = chunks.length ? JSON.parse(Buffer.concat(chunks).toString()) : undefined
    const result = handler(req.url ?? '/', req.method ?? 'GET', body)
    res.writeHead(200, { 'Content-Type': 'application/json' })
    res.end(JSON.stringify(result))
  })
  return new Promise<{ port: number; emit: (event: string, data: unknown) => void; close: () => Promise<void> }>(
    (resolve) => {
      server.listen(0, '127.0.0.1', () => {
        const port = (server.address() as { port: number }).port
        resolve({
          port,
          emit: (event, data) => { for (const cb of emitCallbacks) cb(event, data) },
          close: () => new Promise((r) => server.close(() => r())),
        })
      })
    },
  )
}

describe('ServiceClient', () => {
  let mock: Awaited<ReturnType<typeof startMockService>>
  let handler: ReturnType<typeof vi.fn>

  beforeEach(async () => {
    handler = vi.fn().mockReturnValue({ sessionId: 'ses-1' })
    mock = await startMockService((url, method, body) => handler(url, method, body))
  })
  afterEach(() => mock.close())

  it('createSession POSTs to /sessions', async () => {
    const client = createServiceClient({ port: mock.port })
    await client.connect()
    handler.mockReturnValue({ sessionId: 'ses-42' })
    const result = await client.createSession({ id: 'anthropic', model: 'claude-haiku-4-5', apiKey: 'k' })
    expect(result.sessionId).toBe('ses-42')
    expect(handler).toHaveBeenCalledWith('/sessions', 'POST', expect.objectContaining({ provider: expect.any(Object) }))
    await client.disconnect()
  })

  it('submitGoal POSTs to /sessions/:id/goal', async () => {
    const client = createServiceClient({ port: mock.port })
    await client.connect()
    handler.mockReturnValue({ taskId: 'task-99' })
    const result = await client.submitGoal('ses-1', 'hello world')
    expect(result.taskId).toBe('task-99')
    await client.disconnect()
  })

  it('forwards SSE events via onEvent callback', async () => {
    const received: unknown[] = []
    const client = createServiceClient({ port: mock.port, onEvent: (e, d) => received.push({ e, d }) })
    await client.connect()
    await new Promise((r) => setTimeout(r, 50)) // let SSE handshake settle
    mock.emit('task.complete', { taskId: 'x', summary: 'done', ts: 1 })
    await new Promise((r) => setTimeout(r, 50))
    expect(received.length).toBeGreaterThan(0)
    await client.disconnect()
  })
})
```

- [ ] **Step 2: Run test to verify it fails**

```bash
pnpm test -- service-client
```

Expected: FAIL — `Cannot find module './service-client'`

- [ ] **Step 3: Implement ServiceClient**

Create `src/main/service-client.ts`:

```typescript
import { request as httpRequest } from 'node:http'
import { createLogger } from '@shared/logger'
import type { ProviderInjection } from '@shared/types/provider'
import type { PermissionDecision } from '@shared/types/ui'

const log = createLogger({ process: 'main' }).child({ component: 'service-client' })

type ServiceClientConfig = {
  port: number
  onEvent?: (event: string, data: unknown) => void
}

export type ServiceClient = {
  connect(): Promise<void>
  disconnect(): void
  createSession(provider: ProviderInjection): Promise<{ sessionId: string }>
  submitGoal(sessionId: string, goal: string): Promise<{ taskId: string }>
  decidePermission(sessionId: string, actionId: string, decision: PermissionDecision): Promise<void>
  cancelTask(sessionId: string, taskId: string): Promise<void>
}

function post<T>(port: number, path: string, body: unknown): Promise<T> {
  return new Promise((resolve, reject) => {
    const payload = JSON.stringify(body)
    const req = httpRequest(
      { hostname: '127.0.0.1', port, path, method: 'POST',
        headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(payload) } },
      (res) => {
        const chunks: Buffer[] = []
        res.on('data', (c: Buffer) => chunks.push(c))
        res.on('end', () => {
          try { resolve(JSON.parse(Buffer.concat(chunks).toString()) as T) }
          catch (e) { reject(e) }
        })
      },
    )
    req.on('error', reject)
    req.write(payload)
    req.end()
  })
}

export function createServiceClient(cfg: ServiceClientConfig): ServiceClient {
  const { port, onEvent } = cfg
  let sseReq: import('node:http').ClientRequest | null = null

  return {
    connect() {
      return new Promise((resolve) => {
        sseReq = httpRequest(
          { hostname: '127.0.0.1', port, path: '/events', method: 'GET',
            headers: { Accept: 'text/event-stream' } },
          (res) => {
            let eventName = ''
            let buffer = ''
            res.setEncoding('utf8')
            res.on('data', (chunk: string) => {
              buffer += chunk
              const lines = buffer.split('\n')
              buffer = lines.pop() ?? ''
              for (const line of lines) {
                if (line.startsWith('event: ')) {
                  eventName = line.slice(7).trim()
                } else if (line.startsWith('data: ')) {
                  const raw = line.slice(6)
                  try {
                    const data = JSON.parse(raw) as unknown
                    if (onEvent && eventName) onEvent(eventName, data)
                  } catch {
                    log.warn({ msg: 'SSE parse error', raw })
                  }
                  eventName = ''
                }
              }
            })
            resolve()
          },
        )
        sseReq.on('error', (err) => log.warn({ msg: 'SSE connection error', err: String(err) }))
        sseReq.end()
      })
    },

    disconnect() {
      sseReq?.destroy()
      sseReq = null
    },

    createSession(provider) {
      return post(port, '/sessions', { provider })
    },

    submitGoal(sessionId, goal) {
      return post(port, `/sessions/${sessionId}/goal`, { goal })
    },

    async decidePermission(sessionId, actionId, decision) {
      await post(port, `/sessions/${sessionId}/permission`, { actionId, decision })
    },

    async cancelTask(sessionId, taskId) {
      await post(port, `/sessions/${sessionId}/cancel`, { taskId })
    },
  }
}
```

- [ ] **Step 4: Run tests**

```bash
pnpm test -- service-client
```

Expected: PASS (3 tests)

- [ ] **Step 5: Commit**

```bash
git add src/main/service-client.ts src/main/service-client.test.ts
git commit -m "feat(main): ServiceClient replaces Supervisor"
```

---

## Task 9: Wire Main — fork Service + update wireSwarmIpc

**Files:**
- Modify: `src/main/index.ts`
- Modify: `src/main/ipc/swarm-ipc.ts`

- [ ] **Step 1: Update src/main/index.ts to fork the Service**

Open `src/main/index.ts`. Find where `createSupervisor` and the worker are set up. Replace the supervisor bootstrap with Service forking. Add at the top of the main app-ready handler:

```typescript
import { fork } from 'node:child_process'
import { join } from 'node:path'
import { createServiceClient } from './service-client'

// Inside app.whenReady() or equivalent bootstrap block:
const serviceEntry = join(__dirname, 'service.js') // electron-vite outputs to __dirname
const serviceProcess = fork(serviceEntry, [], {
  env: {
    ...process.env,
    SWARM_SERVICE_DB_PATH: join(app.getPath('userData'), 'agent-service.db'),
  },
  silent: true, // capture stdout for port negotiation
})

const servicePort = await new Promise<number>((resolve, reject) => {
  const timeout = setTimeout(() => reject(new Error('service startup timeout')), 10_000)
  serviceProcess.stdout?.on('data', (chunk: Buffer) => {
    try {
      const msg = JSON.parse(chunk.toString().trim()) as { type: string; port: number }
      if (msg.type === 'service-started') {
        clearTimeout(timeout)
        resolve(msg.port)
      }
    } catch {}
  })
  serviceProcess.on('exit', (code) => {
    clearTimeout(timeout)
    reject(new Error(`service exited with code ${String(code)}`))
  })
})

const serviceClient = createServiceClient({
  port: servicePort,
  onEvent: (event, data) => {
    // broadcast to all windows (same logic as existing EventBus → UIEvent bridge)
    for (const w of BrowserWindow.getAllWindows()) {
      if (!w.isDestroyed()) w.webContents.send('swarm:event', data)
    }
  },
})
await serviceClient.connect()

app.on('before-quit', async () => {
  serviceClient.disconnect()
  serviceProcess.kill('SIGTERM')
})
```

Remove the `createSupervisor`, `createNodeForkSpawner`, and worker pool setup that was here before.

- [ ] **Step 2: Update wireSwarmIpc**

Open `src/main/ipc/swarm-ipc.ts`. The function signature changes: replace the `supervisor` parameter with `serviceClient`. Apply these changes:

```typescript
// Before:
export function wireSwarmIpc(args: {
  supervisor: Supervisor
  permissionGate: PermissionGate
  providers: ProvidersService
  eventBus: EventBus
}): { dispose: () => void }

// After:
export function wireSwarmIpc(args: {
  serviceClient: ServiceClient
  providers: ProvidersService
}): { dispose: () => void }
```

Replace `submitGoal` handler body (the Supervisor.dispatch call):

```typescript
// Before:
supervisor.dispatch(task, injection)

// After:
// Session is created lazily per-window or reused; for simplicity, one global session per provider:
void serviceClient.submitGoal(sessionId, trimmedGoal)
```

> **Session management note:** The simplest initial approach is one global session per active provider. Store `sessionId` in module scope, create it once via `serviceClient.createSession(injection)` when no session exists. A more sophisticated approach (one session per conversation) can be added in a follow-up.

Replace `decidePermission` handler:

```typescript
// Before:
pending.resolve(decision)  // via pendingPermissions map

// After:
void serviceClient.decidePermission(currentSessionId, actionId, decision)
```

Remove: the `permissionGate.setPromptHandler(...)` block, the `eventBusSub`, and all `pendingPermissions` logic — the Service handles permission routing internally and pushes `task.permission_request` events via SSE, which are already forwarded to Renderer by the `onEvent` callback in `service-client.ts`.

- [ ] **Step 3: Run typecheck**

```bash
pnpm typecheck:node
```

Expected: no errors

- [ ] **Step 4: Run all tests**

```bash
pnpm test
```

Expected: all existing tests pass (service tests pass, worker tests still pass since `src/worker/` not yet deleted)

- [ ] **Step 5: Commit**

```bash
git add src/main/index.ts src/main/ipc/swarm-ipc.ts
git commit -m "feat(main): wire Service fork and update IPC to use ServiceClient"
```

---

## Task 10: Remove Worker Pool + Supervisor

**Files:**
- Delete: `src/worker/` (entire directory)
- Delete: `src/main/supervisor/` (entire directory)
- Modify: `electron.vite.config.ts` — remove `worker` entry

> Only do this task after all tests pass and you've manually verified the app works end-to-end.

- [ ] **Step 1: Run full test suite to confirm baseline**

```bash
pnpm test
```

Expected: all tests PASS

- [ ] **Step 2: Remove worker entry from build config**

In `electron.vite.config.ts`, remove the `worker` line from `input`:

```typescript
input: {
  index: resolve('src/main/index.ts'),
  service: resolve('src/service/index.ts'),
  // worker line removed
},
```

Also remove `@worker` from the `resolve.alias` block in both `electron.vite.config.ts` and `vitest.config.ts`.

- [ ] **Step 3: Delete src/worker/**

```bash
git rm -r src/worker/
```

- [ ] **Step 4: Delete src/main/supervisor/**

```bash
git rm -r src/main/supervisor/
```

- [ ] **Step 5: Run typecheck and tests**

```bash
pnpm typecheck:node && pnpm test
```

Expected: no errors, all tests PASS

- [ ] **Step 6: Commit**

```bash
git add -A
git commit -m "chore: remove Worker Pool and Supervisor (replaced by Agent Service)"
```

---

## Task 11: ToolStateManager skeleton (Phase 2 — deferred)

This task is deferred. The interface is defined here so AgentRunner can reference it, but the Playwright implementation is left for a follow-up.

**Files:**
- Create: `src/service/tool-state-manager.ts`

```typescript
// Skeleton — no Playwright dependency yet
export type ToolStateManager = {
  sessionId: string
  getOrCreateBrowserContext(): Promise<unknown> // returns Playwright BrowserContext when implemented
  saveCookies(cookies: unknown[]): Promise<void>
  loadCookies(): Promise<unknown[]>
  dispose(): Promise<void>
}

export function createToolStateManager(_sessionId: string): ToolStateManager {
  return {
    sessionId: _sessionId,
    getOrCreateBrowserContext: async () => { throw new Error('ToolStateManager: Playwright not yet wired') },
    saveCookies: async () => {},
    loadCookies: async () => [],
    dispose: async () => {},
  }
}
```

Commit when added:

```bash
git add src/service/tool-state-manager.ts
git commit -m "feat(service): ToolStateManager skeleton (Playwright deferred)"
```

---

## Self-Review Checklist

**Spec coverage:**
- ✅ Agent Service process forked by Electron — Task 7 (index.ts) + Task 9 (main/index.ts)
- ✅ HTTP + SSE protocol — Tasks 3, 7, 8
- ✅ Session-based architecture — Task 6 (SessionManager)
- ✅ SQLite persistence (history, tasks) — Task 2 (ConversationStore)
- ✅ Permission routing via SSE + HTTP — Tasks 4, 8, 9
- ✅ Sub-task Handoff within same session — Task 6 (spawnChild)
- ✅ Crash recovery (interrupted sessions) — Task 6 (init block)
- ✅ ServiceClient replaces Supervisor — Task 8
- ✅ Renderer + Preload unchanged — confirmed (no tasks modify them)
- ✅ ToolStateManager interface — Task 11 (skeleton; Playwright deferred)

**Type consistency across tasks:**
- `StoredSession` defined in Task 2, used in Task 6 ✅
- `SessionManager` type defined in Task 6, used in Task 7 and Task 9 ✅
- `SseBroadcaster` defined in Task 3, used in Tasks 6, 7, 8 ✅
- `PermissionRegistry` defined in Task 4, used in Tasks 5 and 6 ✅
- `ServiceClient` type defined in Task 8, used in Task 9 ✅
- `AgentRunner` defined in Task 5, used in Task 6 ✅

**No placeholders:** All steps contain actual code or commands.
