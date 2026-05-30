# Multi-Session Chat UI Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Refactor the renderer into a chat UI (session list left, conversation thread center, input at bottom) backed by real multi-session support with per-session conversation continuity and SQLite persistence.

**Architecture:** The backend already has a `sessions → tasks` SQLite store. We (1) extend the store with a session title, an agent-message snapshot, and task-history persistence; (2) make the session-manager seed each turn's runner from the snapshot and write it back, serialized per session; (3) thread `sessionId` through all events and expose `listSessions`/`getSessionTasks` over HTTP→IPC; (4) rebuild the renderer as a chat app that buckets events by `sessionId` and replays history from the store on switch.

**Tech Stack:** Electron, TypeScript, Vitest, React, TanStack Router/Query, Zustand, shadcn/ui, better-sqlite3, `@earendil-works/pi-agent-core`.

**Test command:** `pnpm test` (alias for `cross-env ELECTRON_RUN_AS_NODE=1 electron node_modules/vitest/vitest.mjs run`). Run a single file with `pnpm test <path>`. Typecheck with `pnpm typecheck`.

---

## File Structure

**Phase 1 — store, types, events (backend foundation)**
- Modify: `src/shared/types/ui.ts` — add `sessionId` to task events; add `session.created`/`session.updated`; add `SessionSummary`; extend `SwarmBridge`.
- Modify: `src/service/conversation-store.ts` — `title` + `agent_snapshot` columns; `listSessions`, `setSessionTitle`, `saveAgentSnapshot`, `getAgentSnapshot`, `saveTaskHistory`.
- Test: `src/service/conversation-store.test.ts`.

**Phase 2 — agent continuity + session-manager**
- Modify: `src/service/agent-runner.ts` — accept `initialMessages`, return `messages`.
- Modify: `src/service/session-manager.ts` — per-session message cache + serial queue, snapshot write, history accumulation, `sessionId` on emits, `listSessions`/`getSessionTasks`, rehydration.
- Test: `src/service/session-manager.test.ts`, `src/service/agent-runner.test.ts`.

**Phase 3 — HTTP + IPC + preload**
- Modify: `src/service/server.ts` — `GET /sessions`, `GET /sessions/:id/tasks`.
- Modify: `src/main/service-client.ts` — `listSessions`, `getSessionTasks`.
- Modify: `src/main/ipc/swarm-ipc.ts` — multi-session handlers.
- Modify: `src/preload/index.ts` — `window.swarm.sessions.*`, session-scoped `submitGoal`/`decidePermission`.
- Test: `src/service/server.test.ts`.

**Phase 4 — renderer chat UI**
- Create: `src/renderer/src/stores/sessions.ts` — Zustand session store.
- Create: `src/renderer/src/lib/replay.ts` — stored `Task[]` → `TaskRecord[]`.
- Create: `src/renderer/src/components/session-list.tsx`.
- Create: `src/renderer/src/components/conversation-thread.tsx`.
- Create: `src/renderer/src/components/chat-input.tsx`.
- Modify: `src/renderer/src/lib/apply-event.ts` — `sessionId` on `TaskRecord`.
- Modify: `src/renderer/src/stores/permission.ts` — `sessionId` on prompt.
- Modify: `src/renderer/src/hooks/use-tasks.ts`, `use-events-subscription.ts`.
- Modify: `src/renderer/src/components/app-sidebar.tsx`, `components/views/tasks-view.tsx`, `components/permission-drawer.tsx`.
- Test: `src/renderer/src/lib/apply-event.test.ts`, `src/renderer/src/lib/replay.test.ts`.

---

## Phase 1 — Store, Types, Events

### Task 1: Add `sessionId` and session events to the UIEvent union

**Files:**
- Modify: `src/shared/types/ui.ts`

- [ ] **Step 1: Add `sessionId` to every `task.*` event, add session events + `SessionSummary`**

In `src/shared/types/ui.ts`, replace the entire `export type UIEvent = ...` union with:

```typescript
export type UIEvent =
  | { kind: 'task.created'; sessionId: string; taskId: string; goal: string; ts: number }
  | { kind: 'task.dispatched'; sessionId: string; taskId: string; workerId: string; ts: number }
  | { kind: 'task.progress'; sessionId: string; taskId: string; event: TaskEvent; ts: number }
  | {
      kind: 'task.tool_call'
      sessionId: string
      taskId: string
      workerId: string
      tool: string
      args: unknown
      ts: number
    }
  | {
      kind: 'task.permission_request'
      sessionId: string
      taskId: string
      workerId: string
      actionId: string
      risk: Risk
      summary: string
      payload: unknown
      ts: number
    }
  | { kind: 'task.complete'; sessionId: string; taskId: string; summary: string; ts: number }
  | { kind: 'task.error'; sessionId: string; taskId: string; error: unknown; ts: number }
  | { kind: 'task.handoff.spawned'; sessionId: string; parentTaskId: string; childTaskId: string; ts: number }
  | {
      kind: 'task.handoff.completed'
      sessionId: string
      parentTaskId: string
      childTaskId: string
      childSummary: string
      ts: number
    }
  | { kind: 'session.created'; sessionId: string; title: string | null; ts: number }
  | { kind: 'session.updated'; sessionId: string; title: string | null; lastActiveAt: number; ts: number }
```

Then, directly after the `UIEvent` union, add:

```typescript
export type SessionSummary = {
  id: string
  title: string | null
  status: 'active' | 'interrupted' | 'ended'
  lastActiveAt: number
  taskCount: number
}
```

- [ ] **Step 2: Typecheck to surface every call site that must change**

Run: `pnpm typecheck`
Expected: FAIL — errors in `apply-event.ts`, `use-events-subscription.ts`, `task-timeline.tsx`, `swarm-ipc.ts` referencing events without `sessionId`. This is expected; later tasks fix them. Note the list, do not fix yet.

- [ ] **Step 3: Commit**

```bash
git add src/shared/types/ui.ts
git commit -m "feat(types): add sessionId to UIEvents + SessionSummary"
```

---

### Task 2: Add `title` + `agent_snapshot` columns and accessors to the store

**Files:**
- Modify: `src/service/conversation-store.ts`
- Test: `src/service/conversation-store.test.ts`

- [ ] **Step 1: Write failing tests for title + snapshot round-trip**

Append to `src/service/conversation-store.test.ts` (inside the `describe('ConversationStore', …)` block):

```typescript
  it('stores and updates a session title', () => {
    const store = createConversationStore(dbPath)
    const provider = { id: 'anthropic' as const, model: 'claude-sonnet-4-5', apiKey: 'k' }
    store.createSession('ses-t', provider)
    expect(store.getSession('ses-t')?.title).toBeNull()
    store.setSessionTitle('ses-t', 'Tidy the desktop')
    expect(store.getSession('ses-t')?.title).toBe('Tidy the desktop')
    store.close()
  })

  it('round-trips an agent message snapshot', () => {
    const store = createConversationStore(dbPath)
    const provider = { id: 'anthropic' as const, model: 'claude-sonnet-4-5', apiKey: 'k' }
    store.createSession('ses-s', provider)
    expect(store.getAgentSnapshot('ses-s')).toEqual([])
    const messages = [{ role: 'user', content: 'hi' }] as unknown as Parameters<typeof store.saveAgentSnapshot>[1]
    store.saveAgentSnapshot('ses-s', messages)
    expect(store.getAgentSnapshot('ses-s')).toEqual(messages)
    store.close()
  })

  it('lists non-ended sessions newest-first with task counts', () => {
    const store = createConversationStore(dbPath)
    const provider = { id: 'anthropic' as const, model: 'claude-sonnet-4-5', apiKey: 'k' }
    store.createSession('ses-a', provider)
    store.updateSessionLastActive('ses-a')
    store.createSession('ses-b', provider)
    store.updateSessionLastActive('ses-b')
    store.createSession('ses-gone', provider)
    store.updateSessionStatus('ses-gone', 'ended')

    const now = Date.now()
    store.saveTask(
      {
        id: '01HRX0000000000000000000A1', parentId: null, agentDefId: 'default', goal: 'g',
        status: 'completed', assignedWorkerId: null, toolAllowlist: [],
        budget: { tokens: 0, calls: 0, wallMs: 0, usdCents: 0 },
        used: { tokens: 0, calls: 0, wallMs: 0, usdCents: 0 },
        history: [], result: null, createdAt: now, startedAt: null, endedAt: null,
      },
      'ses-b',
    )

    const list = store.listSessions()
    const ids = list.map((s) => s.id)
    expect(ids).not.toContain('ses-gone')
    expect(ids).toContain('ses-a')
    expect(ids).toContain('ses-b')
    expect(list.find((s) => s.id === 'ses-b')?.taskCount).toBe(1)
    expect(list.find((s) => s.id === 'ses-a')?.taskCount).toBe(0)
    store.close()
  })

  it('persists and reloads task history', () => {
    const store = createConversationStore(dbPath)
    const provider = { id: 'anthropic' as const, model: 'claude-sonnet-4-5', apiKey: 'k' }
    store.createSession('ses-h', provider)
    const now = Date.now()
    store.saveTask(
      {
        id: '01HRX0000000000000000000H1', parentId: null, agentDefId: 'default', goal: 'g',
        status: 'running', assignedWorkerId: null, toolAllowlist: [],
        budget: { tokens: 0, calls: 0, wallMs: 0, usdCents: 0 },
        used: { tokens: 0, calls: 0, wallMs: 0, usdCents: 0 },
        history: [], result: null, createdAt: now, startedAt: null, endedAt: null,
      },
      'ses-h',
    )
    store.saveTaskHistory('01HRX0000000000000000000H1', [
      { kind: 'llm.message', role: 'assistant', content: 'done', ts: now },
    ])
    const tasks = store.getSessionTasks('ses-h')
    expect(tasks[0].history).toEqual([{ kind: 'llm.message', role: 'assistant', content: 'done', ts: now }])
    store.close()
  })
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `pnpm test src/service/conversation-store.test.ts`
Expected: FAIL — `setSessionTitle`, `getAgentSnapshot`, `saveAgentSnapshot`, `listSessions`, `saveTaskHistory` are not functions; `title` undefined.

- [ ] **Step 3: Add the `title`/`agent_snapshot` columns and the new accessors**

In `src/service/conversation-store.ts`:

(a) Add the import at the top, after the existing imports:

```typescript
import type { AgentMessage } from '@earendil-works/pi-agent-core'
```

(b) Add to the `StoredSession` type (after `providerSnapshot`):

```typescript
  title: string | null
  agentSnapshot: AgentMessage[]
```

(c) Add to the `ConversationStore` type (after `getInterruptedSessions`):

```typescript
  listSessions(): import('@shared/types/ui').SessionSummary[]
  setSessionTitle(id: string, title: string): void
  saveAgentSnapshot(sessionId: string, messages: AgentMessage[]): void
  getAgentSnapshot(sessionId: string): AgentMessage[]
  saveTaskHistory(taskId: string, history: import('@shared/types/task').TaskEvent[]): void
```

(d) In the `CREATE TABLE IF NOT EXISTS sessions (...)` block, add two columns before the closing `)`:

```sql
      title             TEXT,
      agent_snapshot    TEXT NOT NULL DEFAULT '[]'
```

(e) After the `db.exec(...)` schema block, add idempotent migration for pre-existing DBs:

```typescript
  for (const stmt of [
    `ALTER TABLE sessions ADD COLUMN title TEXT`,
    `ALTER TABLE sessions ADD COLUMN agent_snapshot TEXT NOT NULL DEFAULT '[]'`,
  ]) {
    try {
      db.exec(stmt)
    } catch {
      // Column already exists — fresh DBs get it from CREATE TABLE above.
    }
  }
```

(f) In `rowToSession`, add the two fields to the returned object:

```typescript
    title: (row.title as string | null) ?? null,
    agentSnapshot: JSON.parse((row.agent_snapshot as string) ?? '[]') as AgentMessage[],
```

(g) Update `stmtInsertSession` to set defaults — replace the existing `stmtInsertSession` definition with:

```typescript
  const stmtInsertSession = db.prepare(
    `INSERT INTO sessions (id, created_at, last_active_at, status, provider_snapshot, title, agent_snapshot)
     VALUES (?, ?, ?, 'active', ?, NULL, '[]')`,
  )
```

(h) Update the `createSession` returned object to include the new fields:

```typescript
    createSession(id, provider) {
      const now = Date.now()
      stmtInsertSession.run(id, now, now, JSON.stringify(provider))
      return {
        id, createdAt: now, lastActiveAt: now, status: 'active',
        providerSnapshot: provider, title: null, agentSnapshot: [],
      }
    },
```

(i) Add prepared statements next to the other `stmt*` declarations:

```typescript
  const stmtSetTitle = db.prepare(`UPDATE sessions SET title = ? WHERE id = ?`)
  const stmtSetSnapshot = db.prepare(`UPDATE sessions SET agent_snapshot = ? WHERE id = ?`)
  const stmtGetSnapshot = db.prepare(`SELECT agent_snapshot FROM sessions WHERE id = ?`)
  const stmtSetTaskHistory = db.prepare(`UPDATE tasks SET history = ? WHERE id = ?`)
  const stmtListSessions = db.prepare(
    `SELECT s.id, s.title, s.status, s.last_active_at AS lastActiveAt,
            (SELECT COUNT(*) FROM tasks t WHERE t.session_id = s.id) AS taskCount
     FROM sessions s
     WHERE s.status != 'ended'
     ORDER BY s.last_active_at DESC`,
  )
```

(j) Add the implementations to the returned object (after `getInterruptedSessions`):

```typescript
    listSessions() {
      return (stmtListSessions.all() as Record<string, unknown>[]).map((r) => ({
        id: r.id as string,
        title: (r.title as string | null) ?? null,
        status: r.status as 'active' | 'interrupted' | 'ended',
        lastActiveAt: r.lastActiveAt as number,
        taskCount: r.taskCount as number,
      }))
    },
    setSessionTitle(id, title) {
      stmtSetTitle.run(title, id)
    },
    saveAgentSnapshot(sessionId, messages) {
      stmtSetSnapshot.run(JSON.stringify(messages), sessionId)
    },
    getAgentSnapshot(sessionId) {
      const row = stmtGetSnapshot.get(sessionId) as { agent_snapshot: string } | undefined
      return row ? (JSON.parse(row.agent_snapshot) as AgentMessage[]) : []
    },
    saveTaskHistory(taskId, history) {
      stmtSetTaskHistory.run(JSON.stringify(history), taskId)
    },
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `pnpm test src/service/conversation-store.test.ts`
Expected: PASS (all, including the four new tests).

- [ ] **Step 5: Commit**

```bash
git add src/service/conversation-store.ts src/service/conversation-store.test.ts
git commit -m "feat(store): session title, agent snapshot, listSessions, task-history persistence"
```

---

## Phase 2 — Agent Continuity + Session Manager

### Task 3: Make the agent-runner accept seed messages and return final messages

**Files:**
- Modify: `src/service/agent-runner.ts`
- Test: `src/service/agent-runner.test.ts`

- [ ] **Step 1: Write a failing test that seed messages are passed to the Agent and final messages returned**

Open `src/service/agent-runner.test.ts` and inspect how it mocks `@earendil-works/pi-agent-core` `Agent`. Add a test that asserts: (a) the `Agent` constructor receives `initialState.messages` equal to the provided `initialMessages`, and (b) `run()` resolves with `messages` taken from `agent.state.messages`. Use the file's existing mock style. Concretely, ensure the mock `Agent` exposes a `state` getter returning `{ messages: [{ role: 'assistant', content: 'reply' }] }` and capture the constructor argument:

```typescript
  it('seeds the agent with initialMessages and returns final messages', async () => {
    const seed = [{ role: 'user', content: 'earlier turn' }] as unknown as never[]
    let capturedInitial: unknown
    // Configure the existing Agent mock so the constructor captures initialState
    // and the instance exposes `state.messages` + a resolving `prompt`.
    // (Adapt these lines to the mock helper already used in this file.)
    MockAgent.mockImplementation((opts: { initialState?: { messages?: unknown } }) => {
      capturedInitial = opts.initialState?.messages
      return {
        subscribe: () => undefined,
        prompt: async () => undefined,
        get state() {
          return { messages: [{ role: 'assistant', content: 'reply' }] }
        },
      }
    })

    const runner = createAgentRunner({
      task: makeTask('do it'),
      provider: { id: 'anthropic', model: 'claude-haiku-4-5-20251001', apiKey: 'k' },
      agentDefinition: { id: 'default', name: 'd', systemPrompt: '', toolScope: 'all', maxIterations: 25 },
      sessionId: 'ses-1',
      emit: () => undefined,
      permissionRegistry: { request: async () => 'grant', resolve: () => undefined } as never,
      spawnChild: async () => ({ childTaskId: 'c', result: { summary: '', artifacts: [] } }),
      initialMessages: seed,
    })

    const out = await runner.run()
    expect(capturedInitial).toEqual(seed)
    expect(out.messages).toEqual([{ role: 'assistant', content: 'reply' }])
  })
```

> If `agent-runner.test.ts` has no `MockAgent`/`makeTask` helpers, add them: mock `@earendil-works/pi-agent-core` with `vi.mock` exporting `Agent: vi.fn()` and `Type`/`getModel`/`getModels` as needed (mirror what `agent-runner.ts` imports), and write a local `makeTask(goal)` returning a valid `Task`.

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm test src/service/agent-runner.test.ts`
Expected: FAIL — `initialMessages` not in deps type / `out.messages` undefined.

- [ ] **Step 3: Thread `initialMessages` in and return `agent.state.messages`**

In `src/service/agent-runner.ts`:

(a) Add to the top imports:

```typescript
import type { AgentMessage } from '@earendil-works/pi-agent-core'
```

(b) In `AgentRunnerDeps`, add a field (after `permissionRegistry`):

```typescript
  initialMessages: AgentMessage[]
```

(c) Change the `AgentRunner` return type:

```typescript
export type AgentRunner = {
  run(): Promise<{ status: 'completed' | 'failed'; summary: string; messages: AgentMessage[] }>
}
```

(d) Inside `run()`, destructure `initialMessages`:

```typescript
      const { task, provider, agentDefinition, sessionId, emit, permissionRegistry, spawnChild, initialMessages } = deps
```

(e) In the `new Agent({ … initialState: { … messages: [] } })`, replace `messages: []` with:

```typescript
          messages: initialMessages,
```

(f) Update the three `return` statements in `run()`:

- The missing-API-key early return → `return { status: 'failed', summary: '', messages: initialMessages }`
- The setup-`catch` return → `return { status: 'failed', summary: '', messages: initialMessages }`
- The success return after `agent.prompt` →

```typescript
        return { status: 'completed', summary: translator.getFinalSummary(), messages: agent.state.messages }
```

- The `agent.prompt` `catch` return → `return { status: 'failed', summary: '', messages: agent.state.messages }`

- [ ] **Step 4: Run tests to verify they pass**

Run: `pnpm test src/service/agent-runner.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/service/agent-runner.ts src/service/agent-runner.test.ts
git commit -m "feat(agent-runner): seed initialMessages, return final messages"
```

---

### Task 4: Session-scoped emit (sessionId injection + history accumulation)

**Files:**
- Modify: `src/service/session-manager.ts`
- Test: `src/service/session-manager.test.ts`

- [ ] **Step 1: Write a failing test that broadcast events carry sessionId and history persists**

Append to `src/service/session-manager.test.ts`:

```typescript
  it('injects sessionId into broadcasts and persists task history on completion', async () => {
    const events: Array<{ name: string; data: Record<string, unknown> }> = []
    const broadcaster = {
      broadcast: (name: string, data: unknown) => events.push({ name, data: data as Record<string, unknown> }),
      addClient: () => undefined,
      removeClient: () => undefined,
    } as never

    // Mock runner: emit one progress event then complete, returning messages.
    mockCreate.mockImplementation((deps: { task: { id: string }; emit: (n: string, d: unknown) => void; sessionId: string }) => ({
      run: async () => {
        deps.emit('task.progress', {
          taskId: deps.task.id,
          event: { kind: 'llm.message', role: 'assistant', content: 'hi', ts: 1 },
          ts: 1,
        })
        deps.emit('task.complete', { taskId: deps.task.id, result: { summary: 'hi', artifacts: [] }, ts: 2 })
        return { status: 'completed' as const, summary: 'hi', messages: [] }
      },
    }))

    const store = createConversationStore(dbPath)
    const manager = createSessionManager({ store, broadcaster, maxConcurrent: 2, getProvider: () => undefined })
    const { sessionId } = manager.createSession({ id: 'anthropic', model: 'claude-haiku-4-5-20251001', apiKey: 'k' })
    const { taskId } = manager.submitGoal(sessionId, 'say hi')

    // Let the queued turn run to completion.
    await new Promise((r) => setTimeout(r, 0))
    await new Promise((r) => setTimeout(r, 0))

    expect(events.every((e) => typeof e.data.sessionId === 'string')).toBe(true)
    expect(events.find((e) => e.name === 'task.created')?.data.sessionId).toBe(sessionId)
    const history = store.getSessionTasks(sessionId).find((t) => t.id === taskId)?.history
    expect(history).toEqual([{ kind: 'llm.message', role: 'assistant', content: 'hi', ts: 1 }])
    store.close()
  })
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm test src/service/session-manager.test.ts`
Expected: FAIL — broadcasts lack `sessionId`; history is `[]`.

- [ ] **Step 3: Add a session-scoped emit factory with history accumulation**

In `src/service/session-manager.ts`:

(a) Add imports at the top:

```typescript
import type { AgentMessage } from '@earendil-works/pi-agent-core'
import type { TaskEvent } from '@shared/types/task'
```

(b) Replace the module-level `const emit = (event, data) => broadcaster.broadcast(event, data)` (line ~69) with a history map and a factory:

```typescript
  const historyByTask = new Map<string, TaskEvent[]>()

  const makeEmit = (sessionId: string) => (event: string, data: unknown): void => {
    const obj = data && typeof data === 'object' ? (data as Record<string, unknown>) : undefined
    const payload = obj ? { sessionId, ...obj } : data

    const taskId = obj?.taskId as string | undefined
    if (event === 'task.progress' && taskId && obj?.event) {
      const buf = historyByTask.get(taskId) ?? []
      buf.push(obj.event as TaskEvent)
      historyByTask.set(taskId, buf)
    }
    if ((event === 'task.complete' || event === 'task.error') && taskId) {
      store.saveTaskHistory(taskId, historyByTask.get(taskId) ?? [])
      historyByTask.delete(taskId)
    }
    broadcaster.broadcast(event, payload)
  }
```

(c) In `spawnChild`, replace the two `emit` usages: the `broadcaster.broadcast('task.handoff.spawned', { parentTaskId, childTaskId, ts: now })` stays but add `sessionId`:

```typescript
    broadcaster.broadcast('task.handoff.spawned', { sessionId, parentTaskId, childTaskId, ts: now })
```

and in the child `createAgentRunner({ … emit, … })`, replace `emit,` with `emit: makeEmit(sessionId),` and add `initialMessages: [],` (children start fresh).

- [ ] **Step 4: Run test (will still fail on submitGoal wiring — that's Task 5)**

Run: `pnpm test src/service/session-manager.test.ts`
Expected: still FAIL on the new test (submitGoal not yet using makeEmit / serial queue / snapshot). Proceed to Task 5; do not commit a broken state — Tasks 4+5 land together. Skip the commit here.

> Implementation note: Tasks 4 and 5 modify the same function region and share one test. Treat them as one commit at the end of Task 5.

---

### Task 5: Per-session message cache, serial queue, snapshot, title, rehydration, list/getTasks

**Files:**
- Modify: `src/service/session-manager.ts`
- Test: `src/service/session-manager.test.ts`

- [ ] **Step 1: Write failing tests for continuity, serialization, list, and getTasks**

Append to `src/service/session-manager.test.ts`:

```typescript
  it('seeds each turn from the previous turn messages (continuity) and serializes per session', async () => {
    const seeds: unknown[] = []
    let resolveFirst: (() => void) | null = null
    let firstStarted = false
    mockCreate.mockImplementation((deps: { initialMessages: unknown }) => ({
      run: async () => {
        seeds.push(deps.initialMessages)
        if (!firstStarted) {
          firstStarted = true
          await new Promise<void>((r) => { resolveFirst = r })
          return { status: 'completed' as const, summary: 'a', messages: [{ role: 'assistant', content: 'a' }] as never }
        }
        return { status: 'completed' as const, summary: 'b', messages: [{ role: 'assistant', content: 'b' }] as never }
      },
    }))

    const store = createConversationStore(dbPath)
    const broadcaster = createSseBroadcaster()
    const manager = createSessionManager({ store, broadcaster, maxConcurrent: 4, getProvider: () => undefined })
    const { sessionId } = manager.createSession({ id: 'anthropic', model: 'claude-haiku-4-5-20251001', apiKey: 'k' })

    manager.submitGoal(sessionId, 'first')
    manager.submitGoal(sessionId, 'second')
    await new Promise((r) => setTimeout(r, 0))

    // Second turn must not have started while the first is in flight (serial).
    expect(seeds).toHaveLength(1)
    expect(seeds[0]).toEqual([])

    resolveFirst!()
    await new Promise((r) => setTimeout(r, 0))
    await new Promise((r) => setTimeout(r, 0))

    expect(seeds).toHaveLength(2)
    expect(seeds[1]).toEqual([{ role: 'assistant', content: 'a' }])
    expect(store.getAgentSnapshot(sessionId)).toEqual([{ role: 'assistant', content: 'b' }])
    store.close()
  })

  it('sets the session title from the first goal', async () => {
    mockCreate.mockImplementation(() => ({
      run: async () => ({ status: 'completed' as const, summary: '', messages: [] }),
    }))
    const store = createConversationStore(dbPath)
    const broadcaster = createSseBroadcaster()
    const manager = createSessionManager({ store, broadcaster, maxConcurrent: 4, getProvider: () => undefined })
    const { sessionId } = manager.createSession({ id: 'anthropic', model: 'claude-haiku-4-5-20251001', apiKey: 'k' })
    manager.submitGoal(sessionId, 'Organize my downloads folder')
    expect(store.getSession(sessionId)?.title).toBe('Organize my downloads folder')
    store.close()
  })

  it('lists sessions and returns a session tasks via the manager', () => {
    mockCreate.mockImplementation(() => ({ run: async () => ({ status: 'completed' as const, summary: '', messages: [] }) }))
    const store = createConversationStore(dbPath)
    const broadcaster = createSseBroadcaster()
    const manager = createSessionManager({ store, broadcaster, maxConcurrent: 4, getProvider: () => undefined })
    const { sessionId } = manager.createSession({ id: 'anthropic', model: 'claude-haiku-4-5-20251001', apiKey: 'k' })
    manager.submitGoal(sessionId, 'g')
    expect(manager.listSessions().map((s) => s.id)).toContain(sessionId)
    expect(manager.getSessionTasks(sessionId).length).toBeGreaterThanOrEqual(1)
    store.close()
  })
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `pnpm test src/service/session-manager.test.ts`
Expected: FAIL — `manager.listSessions`/`getSessionTasks` not functions; continuity/title not implemented.

- [ ] **Step 3: Rewrite `Session`, `SessionManager`, `createSession`, `submitGoal`; add `listSessions`/`getSessionTasks`/rehydration**

In `src/service/session-manager.ts`:

(a) Replace the `Session` type with:

```typescript
type Session = {
  id: string
  provider: ProviderInjection
  permissionRegistry: PermissionRegistry
  messages: AgentMessage[]
  queue: Promise<void>
}
```

(b) Extend the `SessionManager` type (add after `submitGoal`):

```typescript
  listSessions(): import('@shared/types/ui').SessionSummary[]
  getSessionTasks(sessionId: string): Task[]
```

(c) Replace `createSession`:

```typescript
    createSession(provider) {
      const sessionId = ulid()
      store.createSession(sessionId, provider)
      const permissionRegistry = createPermissionRegistry(makeEmit(sessionId))
      sessions.set(sessionId, {
        id: sessionId, provider, permissionRegistry, messages: [], queue: Promise.resolve(),
      })
      broadcaster.broadcast('session.created', { sessionId, title: null, ts: Date.now() })
      return { sessionId }
    },
```

(d) Add a rehydration helper just above the `return {` of the factory:

```typescript
  const getOrRehydrate = (sessionId: string): Session | undefined => {
    const live = sessions.get(sessionId)
    if (live) return live
    const stored = store.getSession(sessionId)
    if (!stored) return undefined
    const rehydrated: Session = {
      id: sessionId,
      provider: stored.providerSnapshot,
      permissionRegistry: createPermissionRegistry(makeEmit(sessionId)),
      messages: store.getAgentSnapshot(sessionId),
      queue: Promise.resolve(),
    }
    store.updateSessionStatus(sessionId, 'active')
    sessions.set(sessionId, rehydrated)
    return rehydrated
  }
```

(e) Replace `submitGoal` entirely:

```typescript
    submitGoal(sessionId, goal, agentDef = DEFAULT_AGENT_DEF) {
      const session = getOrRehydrate(sessionId)
      if (!session) throw new Error(`session ${sessionId} not found`)

      const taskId = ulid()
      const now = Date.now()
      const isFirst = store.getSessionTasks(sessionId).length === 0
      const task: Task = {
        id: taskId, parentId: null, agentDefId: agentDef.id,
        goal, status: 'pending', assignedWorkerId: null,
        toolAllowlist: ['peekaboo.*', 'web.*', 'fs.*'],
        budget: { tokens: 100_000, calls: 50, wallMs: 600_000, usdCents: 200 },
        used: { tokens: 0, calls: 0, wallMs: 0, usdCents: 0 },
        history: [], result: null, createdAt: now, startedAt: null, endedAt: null,
      }
      store.saveTask(task, sessionId)
      broadcaster.broadcast('task.created', { sessionId, taskId, goal, ts: now })
      store.updateSessionLastActive(sessionId)

      if (isFirst) {
        const title = goal.slice(0, 60)
        store.setSessionTitle(sessionId, title)
        broadcaster.broadcast('session.updated', { sessionId, title, lastActiveAt: now, ts: now })
      }

      const runTurn = async (): Promise<void> => {
        await acquireSlot()
        const runner = createAgentRunner({
          task, provider: session.provider, agentDefinition: agentDef,
          sessionId, emit: makeEmit(sessionId), permissionRegistry: session.permissionRegistry,
          initialMessages: session.messages,
          spawnChild: (pt, ng, st, pk) => spawnChild(sessionId, pt, ng, st, pk),
        })
        try {
          const { status, messages } = await runner.run()
          session.messages = messages
          store.saveAgentSnapshot(sessionId, messages)
          store.updateTaskStatus(taskId, status === 'completed' ? 'completed' : 'failed')
        } finally {
          releaseSlot()
        }
      }

      // Serialize turns within this session; failures must not break the chain.
      session.queue = session.queue.then(runTurn, runTurn)
      return { taskId }
    },
```

(f) Add the two new methods to the returned object (after `endSession`):

```typescript
    listSessions() {
      return store.listSessions()
    },
    getSessionTasks(sessionId) {
      return store.getSessionTasks(sessionId)
    },
```

- [ ] **Step 4: Run the full service test suite**

Run: `pnpm test src/service`
Expected: PASS — all session-manager tests (old + new from Tasks 4 & 5), plus conversation-store and agent-runner.

- [ ] **Step 5: Commit (Tasks 4 + 5 together)**

```bash
git add src/service/session-manager.ts src/service/session-manager.test.ts
git commit -m "feat(session-manager): per-session continuity, serial queue, snapshot, title, list/getTasks"
```

---

## Phase 3 — HTTP + IPC + Preload

### Task 6: Expose `GET /sessions` and `GET /sessions/:id/tasks`

**Files:**
- Modify: `src/service/server.ts`
- Test: `src/service/server.test.ts`

- [ ] **Step 1: Write failing tests for the two GET routes**

Open `src/service/server.test.ts` to confirm how it boots the server and makes requests (it uses `createServer` + a real `manager`). Add tests mirroring that style:

```typescript
  it('GET /sessions returns the session list', async () => {
    // create a session via POST /sessions first, then list
    await post('/sessions', { provider: { id: 'anthropic', model: 'claude-haiku-4-5-20251001', apiKey: 'k' } })
    const res = await get('/sessions')
    expect(res.status).toBe(200)
    expect(Array.isArray(res.body)).toBe(true)
    expect(res.body.length).toBeGreaterThanOrEqual(1)
    expect(typeof res.body[0].id).toBe('string')
  })

  it('GET /sessions/:id/tasks returns tasks for the session', async () => {
    const created = await post('/sessions', { provider: { id: 'anthropic', model: 'claude-haiku-4-5-20251001', apiKey: 'k' } })
    const sessionId = created.body.sessionId
    const res = await get(`/sessions/${sessionId}/tasks`)
    expect(res.status).toBe(200)
    expect(Array.isArray(res.body)).toBe(true)
  })
```

> If `server.test.ts` lacks `get`/`post` helpers, add thin ones using `node:http` against `server.listen(0)`'s assigned port (mirror the existing request helper in the file).

- [ ] **Step 2: Run tests to verify they fail**

Run: `pnpm test src/service/server.test.ts`
Expected: FAIL — both GETs return 404.

- [ ] **Step 3: Add the routes in `createServer`**

In `src/service/server.ts`, add before the final `json(res, 404, …)`:

```typescript
      if (method === 'GET' && url === '/sessions') {
        json(res, 200, manager.listSessions())
        return
      }

      const tasksMatch = /^\/sessions\/([^/]+)\/tasks$/.exec(url)
      if (method === 'GET' && tasksMatch) {
        json(res, 200, manager.getSessionTasks(tasksMatch[1]))
        return
      }
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `pnpm test src/service/server.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/service/server.ts src/service/server.test.ts
git commit -m "feat(service): GET /sessions and GET /sessions/:id/tasks"
```

---

### Task 7: Service-client methods for list/getTasks

**Files:**
- Modify: `src/main/service-client.ts`

- [ ] **Step 1: Add a `get<T>` helper and the two methods**

In `src/main/service-client.ts`:

(a) Add a `get` helper next to `post`:

```typescript
function get<T>(port: number, path: string): Promise<T> {
  return new Promise((resolve, reject) => {
    const req = httpRequest({ hostname: '127.0.0.1', port, path, method: 'GET' }, (res) => {
      const chunks: Buffer[] = []
      res.on('data', (c: Buffer) => chunks.push(c))
      res.on('end', () => {
        try { resolve(JSON.parse(Buffer.concat(chunks).toString()) as T) }
        catch (e) { reject(e) }
      })
    })
    req.on('error', reject)
    req.end()
  })
}
```

(b) Add to the `ServiceClient` type (after `submitGoal`):

```typescript
  listSessions(): Promise<import('@shared/types/ui').SessionSummary[]>
  getSessionTasks(sessionId: string): Promise<import('@shared/types/task').Task[]>
```

(c) Add the implementations inside the returned object (after `submitGoal`):

```typescript
    listSessions() {
      return get(port, '/sessions')
    },
    getSessionTasks(sessionId) {
      return get(port, `/sessions/${sessionId}/tasks`)
    },
```

- [ ] **Step 2: Typecheck**

Run: `pnpm typecheck:node`
Expected: No new errors from `service-client.ts`.

- [ ] **Step 3: Commit**

```bash
git add src/main/service-client.ts
git commit -m "feat(service-client): listSessions + getSessionTasks"
```

---

### Task 8: Multi-session IPC + preload bridge

**Files:**
- Modify: `src/main/ipc/swarm-ipc.ts`
- Modify: `src/preload/index.ts`
- Modify: `src/shared/types/ui.ts` (`SwarmBridge`)

- [ ] **Step 1: Extend `SwarmBridge` and `SubmitGoalResult` usage**

In `src/shared/types/ui.ts`, replace the `submitGoal`/`cancelTask`/`decidePermission` lines of `SwarmBridge` and add a `sessions` group:

```typescript
  submitGoal(sessionId: string, goal: string): Promise<SubmitGoalResult>
  cancelTask(sessionId: string, taskId: string): Promise<void>
  decidePermission(sessionId: string, actionId: string, decision: PermissionDecision): Promise<void>
  sessions: {
    list(): Promise<SessionSummary[]>
    create(): Promise<{ sessionId: string }>
    getTasks(sessionId: string): Promise<import('./task').Task[]>
  }
```

> Add `import type { Task } from './task'` is unnecessary — `./task` re-export already exists at the bottom of the file via `export type { TaskEvent, TaskResult }`; use the inline `import('./task').Task` form shown above to avoid a new top-level import.

- [ ] **Step 2: Rewrite the IPC handlers**

In `src/main/ipc/swarm-ipc.ts`, replace the single-global-session block. Remove `currentSessionId`/`sessionCreationPromise`. Replace `submitGoal`, `cancelTask`, `decidePermission` and register new channels:

```typescript
  const createSession = async (): Promise<{ sessionId: string }> => {
    const injection = providers.getInjection()
    if (!injection) throw new Error('Configure an API key in Settings before starting a chat.')
    const { sessionId } = await serviceClient.createSession(injection)
    log.info({ msg: 'session created', sessionId, provider: injection.id })
    return { sessionId }
  }

  const listSessions = (): Promise<import('@shared/types/ui').SessionSummary[]> => serviceClient.listSessions()

  const getSessionTasks = (_e: Electron.IpcMainInvokeEvent, sessionId: string) =>
    serviceClient.getSessionTasks(sessionId)

  const submitGoal = async (
    _e: Electron.IpcMainInvokeEvent,
    sessionId: string,
    goal: string,
  ): Promise<{ taskId: string }> => {
    if (typeof goal !== 'string' || goal.trim().length === 0) {
      throw new Error('goal must be a non-empty string')
    }
    const trimmedGoal = goal.trim()
    const { taskId } = await serviceClient.submitGoal(sessionId, trimmedGoal)
    log.info({ msg: 'task submitted', sessionId, taskId })
    return { taskId }
  }

  const cancelTask = async (_e: Electron.IpcMainInvokeEvent, sessionId: string, taskId: string): Promise<void> => {
    await serviceClient.cancelTask(sessionId, taskId)
    log.info({ msg: 'cancelTask requested', sessionId, taskId })
  }

  const decidePermission = (
    _e: Electron.IpcMainInvokeEvent,
    sessionId: string,
    actionId: string,
    decision: string,
  ): void => {
    void serviceClient
      .decidePermission(sessionId, actionId, decision as import('@shared/types/ui').PermissionDecision)
      .catch((err: unknown) => log.warn({ msg: 'decidePermission failed', err: String(err) }))
    log.info({ msg: 'permission decided', sessionId, actionId, decision })
  }

  ipcMain.handle('swarm:createSession', () => createSession())
  ipcMain.handle('swarm:listSessions', () => listSessions())
  ipcMain.handle('swarm:getSessionTasks', getSessionTasks)
  ipcMain.handle('swarm:submitGoal', submitGoal)
  ipcMain.handle('swarm:cancelTask', cancelTask)
  ipcMain.handle('swarm:decidePermission', decidePermission)
```

In the `dispose()` block, add removals:

```typescript
      ipcMain.removeHandler('swarm:createSession')
      ipcMain.removeHandler('swarm:listSessions')
      ipcMain.removeHandler('swarm:getSessionTasks')
```

> The old "no provider → synthesize task.error events" path is removed: with an explicit `+ New chat` flow, `createSession` rejects cleanly and the renderer surfaces the error. Keep the existing `no-provider-banner` as the primary guard.

- [ ] **Step 3: Update preload bridge**

In `src/preload/index.ts`, update the `swarm` object's three methods and add `sessions`:

```typescript
  submitGoal: (sessionId, goal) => ipcRenderer.invoke('swarm:submitGoal', sessionId, goal) as Promise<SubmitGoalResult>,
  cancelTask: (sessionId, taskId) => ipcRenderer.invoke('swarm:cancelTask', sessionId, taskId) as Promise<void>,
  decidePermission: (sessionId, actionId, decision: PermissionDecision) =>
    ipcRenderer.invoke('swarm:decidePermission', sessionId, actionId, decision) as Promise<void>,
```

and add (alongside `providers,`):

```typescript
  sessions: {
    list: () => ipcRenderer.invoke('swarm:listSessions') as Promise<import('../shared/types/ui').SessionSummary[]>,
    create: () => ipcRenderer.invoke('swarm:createSession') as Promise<{ sessionId: string }>,
    getTasks: (sessionId: string) =>
      ipcRenderer.invoke('swarm:getSessionTasks', sessionId) as Promise<import('../shared/types/task').Task[]>,
  },
```

- [ ] **Step 4: Typecheck (renderer call sites will still error — fixed in Phase 4)**

Run: `pnpm typecheck:node`
Expected: PASS for node side (`swarm-ipc.ts`, `preload`). `typecheck:web` still fails on renderer call sites (`use-tasks.ts`, etc.) — fixed in Phase 4.

- [ ] **Step 5: Commit**

```bash
git add src/shared/types/ui.ts src/main/ipc/swarm-ipc.ts src/preload/index.ts
git commit -m "feat(ipc): multi-session create/list/getTasks + session-scoped goal/permission"
```

---

## Phase 4 — Renderer Chat UI

### Task 9: `sessionId` on `TaskRecord`; bucket events by session

**Files:**
- Modify: `src/renderer/src/lib/apply-event.ts`
- Test: `src/renderer/src/lib/apply-event.test.ts`

- [ ] **Step 1: Write a failing test that records carry sessionId and unknown-session events are ignored-safe**

Open `src/renderer/src/lib/apply-event.test.ts`; existing tests pass events without `sessionId`. Update them to include `sessionId` and add:

```typescript
  it('stamps sessionId onto the created record', () => {
    const out = applyEvent([], {
      kind: 'task.created', sessionId: 'ses-1', taskId: 't1', goal: 'g', ts: 1,
    })
    expect(out[0].sessionId).toBe('ses-1')
  })
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm test src/renderer/src/lib/apply-event.test.ts`
Expected: FAIL — `sessionId` missing on `TaskRecord`.

- [ ] **Step 3: Add `sessionId` to `TaskRecord` and stamp it on creation**

In `src/renderer/src/lib/apply-event.ts`:

(a) Add to `TaskRecord` (after `id`):

```typescript
  sessionId: string
```

(b) In the `task.created` branch, set it on the `created` object:

```typescript
    const created: TaskRecord = {
      id: e.taskId,
      sessionId: e.sessionId,
      goal: e.goal,
      status: 'pending',
      workerId: null,
      summary: null,
      startedAt: e.ts,
      events: [e],
    }
```

(c) In the stub branch (`idx === -1`), add `sessionId: 'sessionId' in e ? (e.sessionId as string) : ''` after `id: taskId,`.

- [ ] **Step 4: Run test to verify it passes**

Run: `pnpm test src/renderer/src/lib/apply-event.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/renderer/src/lib/apply-event.ts src/renderer/src/lib/apply-event.test.ts
git commit -m "feat(renderer): sessionId on TaskRecord"
```

---

### Task 10: Sessions Zustand store

**Files:**
- Create: `src/renderer/src/stores/sessions.ts`
- Test: `src/renderer/src/stores/sessions.test.ts`

- [ ] **Step 1: Write failing tests**

Create `src/renderer/src/stores/sessions.test.ts`:

```typescript
import { describe, it, expect, beforeEach } from 'vitest'
import { useSessionsStore } from './sessions'

describe('sessions store', () => {
  beforeEach(() => {
    useSessionsStore.setState({ sessions: [], selectedSessionId: null })
  })

  it('sets the session list', () => {
    useSessionsStore.getState().setSessions([
      { id: 'a', title: 'A', status: 'active', lastActiveAt: 2, taskCount: 1 },
      { id: 'b', title: null, status: 'active', lastActiveAt: 1, taskCount: 0 },
    ])
    expect(useSessionsStore.getState().sessions.map((s) => s.id)).toEqual(['a', 'b'])
  })

  it('upserts a session newest-first and updates title', () => {
    const { upsert } = useSessionsStore.getState()
    upsert({ id: 'a', title: null, status: 'active', lastActiveAt: 1, taskCount: 0 })
    upsert({ id: 'a', title: 'Renamed', status: 'active', lastActiveAt: 5, taskCount: 0 })
    const list = useSessionsStore.getState().sessions
    expect(list).toHaveLength(1)
    expect(list[0].title).toBe('Renamed')
  })

  it('selects a session', () => {
    useSessionsStore.getState().select('x')
    expect(useSessionsStore.getState().selectedSessionId).toBe('x')
  })
})
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm test src/renderer/src/stores/sessions.test.ts`
Expected: FAIL — module not found.

- [ ] **Step 3: Implement the store**

Create `src/renderer/src/stores/sessions.ts`:

```typescript
import type { SessionSummary } from '@shared/types/ui'
import { create } from 'zustand'

type SessionsStore = {
  sessions: SessionSummary[]
  selectedSessionId: string | null
  setSessions: (sessions: SessionSummary[]) => void
  upsert: (session: SessionSummary) => void
  select: (id: string | null) => void
}

export const useSessionsStore = create<SessionsStore>((set) => ({
  sessions: [],
  selectedSessionId: null,
  setSessions: (sessions) => set({ sessions }),
  upsert: (session) =>
    set((state) => {
      const rest = state.sessions.filter((s) => s.id !== session.id)
      const merged = [session, ...rest]
      merged.sort((a, b) => b.lastActiveAt - a.lastActiveAt)
      return { sessions: merged }
    }),
  select: (id) => set({ selectedSessionId: id }),
}))
```

- [ ] **Step 4: Run test to verify it passes**

Run: `pnpm test src/renderer/src/stores/sessions.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/renderer/src/stores/sessions.ts src/renderer/src/stores/sessions.test.ts
git commit -m "feat(renderer): sessions store"
```

---

### Task 11: Replay — convert stored `Task[]` to `TaskRecord[]`

**Files:**
- Create: `src/renderer/src/lib/replay.ts`
- Test: `src/renderer/src/lib/replay.test.ts`

- [ ] **Step 1: Write failing tests**

Create `src/renderer/src/lib/replay.test.ts`:

```typescript
import { describe, it, expect } from 'vitest'
import type { Task } from '@shared/types/task'
import { tasksToRecords } from './replay'

const baseTask = (over: Partial<Task>): Task => ({
  id: '01HRX0000000000000000000R1', parentId: null, agentDefId: 'default', goal: 'g',
  status: 'completed', assignedWorkerId: null, toolAllowlist: [],
  budget: { tokens: 0, calls: 0, wallMs: 0, usdCents: 0 },
  used: { tokens: 0, calls: 0, wallMs: 0, usdCents: 0 },
  history: [], result: null, createdAt: 1, startedAt: null, endedAt: null,
  ...over,
})

describe('tasksToRecords', () => {
  it('builds a record per task with goal + history as progress events', () => {
    const records = tasksToRecords('ses-1', [
      baseTask({
        goal: 'tidy',
        history: [{ kind: 'llm.message', role: 'assistant', content: 'done', ts: 2 }],
        result: { summary: 'all tidy', artifacts: [] },
      }),
    ])
    expect(records).toHaveLength(1)
    expect(records[0].sessionId).toBe('ses-1')
    expect(records[0].goal).toBe('tidy')
    expect(records[0].summary).toBe('all tidy')
    // created + one progress event reconstructed
    expect(records[0].events[0].kind).toBe('task.created')
    expect(records[0].events.some((e) => e.kind === 'task.progress')).toBe(true)
  })

  it('orders records newest createdAt first', () => {
    const records = tasksToRecords('ses-1', [
      baseTask({ id: '01HRX0000000000000000000R1', createdAt: 1 }),
      baseTask({ id: '01HRX0000000000000000000R2', createdAt: 5 }),
    ])
    expect(records[0].id).toBe('01HRX0000000000000000000R2')
  })
})
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm test src/renderer/src/lib/replay.test.ts`
Expected: FAIL — module not found.

- [ ] **Step 3: Implement `tasksToRecords`**

Create `src/renderer/src/lib/replay.ts`:

```typescript
import type { Task } from '@shared/types/task'
import type { UIEvent } from '@shared/types/ui'
import type { TaskRecord, TaskStatus } from './apply-event'

const STORED_TO_UI_STATUS: Record<string, TaskStatus> = {
  pending: 'pending',
  planning: 'running',
  dispatched: 'running',
  running: 'running',
  awaiting_user: 'awaiting_user',
  paused: 'running',
  completed: 'completed',
  failed: 'failed',
  cancelled: 'failed',
  interrupted: 'failed',
}

/** Rebuild renderer TaskRecords from persisted tasks (for session replay on switch). */
export function tasksToRecords(sessionId: string, tasks: Task[]): TaskRecord[] {
  const records = tasks.map((t): TaskRecord => {
    const events: UIEvent[] = [{ kind: 'task.created', sessionId, taskId: t.id, goal: t.goal, ts: t.createdAt }]
    for (const ev of t.history) {
      events.push({ kind: 'task.progress', sessionId, taskId: t.id, event: ev, ts: ev.ts })
    }
    if (t.result) {
      events.push({ kind: 'task.complete', sessionId, taskId: t.id, summary: t.result.summary, ts: t.endedAt ?? t.createdAt })
    }
    return {
      id: t.id,
      sessionId,
      goal: t.goal,
      status: STORED_TO_UI_STATUS[t.status] ?? 'completed',
      workerId: t.assignedWorkerId,
      summary: t.result?.summary ?? null,
      startedAt: t.createdAt,
      events,
    }
  })
  records.sort((a, b) => b.startedAt - a.startedAt)
  return records
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `pnpm test src/renderer/src/lib/replay.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/renderer/src/lib/replay.ts src/renderer/src/lib/replay.test.ts
git commit -m "feat(renderer): replay stored tasks into TaskRecords"
```

---

### Task 12: API + hooks — session-scoped goal, list, replay; events update session store

**Files:**
- Modify: `src/renderer/src/lib/api.ts`
- Modify: `src/renderer/src/hooks/use-tasks.ts`
- Modify: `src/renderer/src/hooks/use-events-subscription.ts`
- Modify: `src/renderer/src/stores/permission.ts`

- [ ] **Step 1: Extend the api wrapper**

In `src/renderer/src/lib/api.ts`, replace the `swarmApi` object with:

```typescript
import type { PermissionDecision, SessionSummary, SubmitGoalResult, UIEvent } from '@shared/types/ui'
import type { Task } from '@shared/types/task'

export const swarmApi = {
  submitGoal: (sessionId: string, goal: string): Promise<SubmitGoalResult> =>
    window.swarm.submitGoal(sessionId, goal),
  cancelTask: (sessionId: string, taskId: string): Promise<void> => window.swarm.cancelTask(sessionId, taskId),
  decidePermission: (sessionId: string, actionId: string, decision: PermissionDecision): Promise<void> =>
    window.swarm.decidePermission(sessionId, actionId, decision),
  subscribeEvents: (cb: (e: UIEvent) => void): (() => void) => window.swarm.subscribeEvents(cb),
  listSessions: (): Promise<SessionSummary[]> => window.swarm.sessions.list(),
  createSession: (): Promise<{ sessionId: string }> => window.swarm.sessions.create(),
  getSessionTasks: (sessionId: string): Promise<Task[]> => window.swarm.sessions.getTasks(sessionId),
}
```

- [ ] **Step 2: Add `sessionId` to permission prompts**

In `src/renderer/src/stores/permission.ts`, add `sessionId: string` to the `PermissionPrompt` type (after `actionId`). (The store keeps prompts in a queue; the field flows in from the event.)

- [ ] **Step 3: Update the events subscription to drive both stores and replay**

In `src/renderer/src/hooks/use-events-subscription.ts`:

(a) Update `buildPrompt` to include `sessionId: e.sessionId,`.

(b) Update `handleHighRisk`'s `decidePermission` call to `await window.swarm.decidePermission(e.sessionId, e.actionId, role)`.

(c) Inside the `useEffect` subscribe callback, after `qc.setQueryData(...applyEvent...)`, handle session events by updating the sessions store:

```typescript
      if (e.kind === 'session.created' || e.kind === 'session.updated') {
        useSessionsStore.getState().upsert({
          id: e.sessionId,
          title: e.title,
          status: 'active',
          lastActiveAt: 'lastActiveAt' in e ? e.lastActiveAt : e.ts,
          taskCount: 0,
        })
      }
```

Add `import { useSessionsStore } from '@/stores/sessions'` at the top.

- [ ] **Step 4: Rework `use-tasks.ts`**

Replace `src/renderer/src/hooks/use-tasks.ts` with:

```typescript
import type { PermissionDecision } from '@shared/types/ui'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'

import { swarmApi } from '@/lib/api'
import type { TaskRecord } from '@/lib/apply-event'
import { tasksToRecords } from '@/lib/replay'
import { usePermissionStore } from '@/stores/permission'
import { useSessionsStore } from '@/stores/sessions'

export const TASKS_KEY = ['tasks'] as const

export function useTasks(): TaskRecord[] {
  const { data } = useQuery<TaskRecord[]>({
    queryKey: TASKS_KEY,
    queryFn: () => [],
    staleTime: Number.POSITIVE_INFINITY,
  })
  return data ?? []
}

/** Submit a goal to the currently-selected session, creating one if needed. */
export function useSubmitGoal() {
  return useMutation({
    mutationFn: async (goal: string) => {
      let sessionId = useSessionsStore.getState().selectedSessionId
      if (!sessionId) {
        const created = await swarmApi.createSession()
        sessionId = created.sessionId
        useSessionsStore.getState().select(sessionId)
      }
      return swarmApi.submitGoal(sessionId, goal)
    },
  })
}

/** Load the session list on mount and select the newest. */
export function useLoadSessions() {
  const qc = useQueryClient()
  return useMutation({
    mutationFn: async () => {
      const sessions = await swarmApi.listSessions()
      useSessionsStore.getState().setSessions(sessions)
      return sessions
    },
    onSuccess: (sessions) => {
      const current = useSessionsStore.getState().selectedSessionId
      if (!current && sessions[0]) {
        useSessionsStore.getState().select(sessions[0].id)
        void hydrateSession(qc, sessions[0].id)
      }
    },
  })
}

/** Replay a session's stored tasks into the tasks cache (idempotent merge by id). */
export async function hydrateSession(
  qc: ReturnType<typeof useQueryClient>,
  sessionId: string,
): Promise<void> {
  const tasks = await swarmApi.getSessionTasks(sessionId)
  const records = tasksToRecords(sessionId, tasks)
  qc.setQueryData<TaskRecord[]>(TASKS_KEY, (prev = []) => {
    const known = new Set(prev.map((t) => t.id))
    const fresh = records.filter((r) => !known.has(r.id))
    return [...fresh, ...prev]
  })
}

export function useDecidePermission() {
  const remove = usePermissionStore((s) => s.remove)
  return useMutation({
    mutationFn: ({
      sessionId,
      actionId,
      decision,
    }: {
      sessionId: string
      actionId: string
      decision: PermissionDecision
    }) => swarmApi.decidePermission(sessionId, actionId, decision),
    onSuccess: (_, { actionId }) => remove(actionId),
  })
}
```

- [ ] **Step 5: Run the renderer hook tests**

Run: `pnpm test src/renderer/src/hooks/use-tasks.test.tsx`
Expected: This existing test calls `useSubmitGoal` with the old single-arg shape; update it to stub `window.swarm.sessions.create` and assert `submitGoal` is called with `(sessionId, goal)`. Adjust the test to the new flow, then it should PASS.

- [ ] **Step 6: Commit**

```bash
git add src/renderer/src/lib/api.ts src/renderer/src/hooks/use-tasks.ts src/renderer/src/hooks/use-events-subscription.ts src/renderer/src/stores/permission.ts src/renderer/src/hooks/use-tasks.test.tsx
git commit -m "feat(renderer): session-scoped api/hooks + session-store wiring + replay"
```

---

### Task 13: SessionList component

**Files:**
- Create: `src/renderer/src/components/session-list.tsx`

- [ ] **Step 1: Implement the list (no test — pure presentational; covered by store/hook tests)**

Create `src/renderer/src/components/session-list.tsx`:

```tsx
import { Plus } from 'lucide-react'
import { useQueryClient } from '@tanstack/react-query'

import { Button } from '@/components/ui/button'
import { ScrollArea } from '@/components/ui/scroll-area'
import { cn } from '@/lib/utils'
import { hydrateSession } from '@/hooks/use-tasks'
import { swarmApi } from '@/lib/api'
import { useSessionsStore } from '@/stores/sessions'

export function SessionList(): React.JSX.Element {
  const qc = useQueryClient()
  const sessions = useSessionsStore((s) => s.sessions)
  const selected = useSessionsStore((s) => s.selectedSessionId)
  const select = useSessionsStore((s) => s.select)

  const onNew = async (): Promise<void> => {
    const { sessionId } = await swarmApi.createSession()
    select(sessionId)
  }

  const onSelect = (id: string): void => {
    select(id)
    void hydrateSession(qc, id)
  }

  return (
    <div className="flex h-full flex-col gap-2 p-2">
      <Button className="w-full justify-start gap-2" onClick={() => void onNew()} variant="outline">
        <Plus className="size-4" />
        New chat
      </Button>
      <ScrollArea className="flex-1">
        <div className="flex flex-col gap-1">
          {sessions.map((s) => (
            <button
              className={cn(
                'truncate rounded px-3 py-2 text-left text-sm hover:bg-accent',
                selected === s.id && 'bg-accent font-medium',
              )}
              key={s.id}
              onClick={() => onSelect(s.id)}
              title={s.title ?? 'Untitled chat'}
              type="button"
            >
              {s.title ?? 'Untitled chat'}
            </button>
          ))}
          {sessions.length === 0 && (
            <p className="px-3 py-2 text-muted-foreground text-xs">No chats yet. Start one below.</p>
          )}
        </div>
      </ScrollArea>
    </div>
  )
}
```

- [ ] **Step 2: Typecheck**

Run: `pnpm typecheck:web`
Expected: No errors from `session-list.tsx` (other renderer files may still error until Task 15).

- [ ] **Step 3: Commit**

```bash
git add src/renderer/src/components/session-list.tsx
git commit -m "feat(renderer): SessionList component"
```

---

### Task 14: ConversationThread (chat bubbles + collapsible events) and ChatInput

**Files:**
- Create: `src/renderer/src/components/conversation-thread.tsx`
- Create: `src/renderer/src/components/chat-input.tsx`

- [ ] **Step 1: Implement ConversationThread**

Create `src/renderer/src/components/conversation-thread.tsx`:

```tsx
import type { UIEvent } from '@shared/types/ui'
import type { TaskEvent } from '@shared/types/task'

import { Badge } from '@/components/ui/badge'
import { ScrollArea } from '@/components/ui/scroll-area'
import { cn } from '@/lib/utils'
import type { TaskRecord } from '@/lib/apply-event'

type Bubble =
  | { kind: 'user'; text: string; key: string }
  | { kind: 'assistant'; text: string; key: string }
  | { kind: 'event'; label: string; detail: string; key: string }

function toolDetail(ev: Extract<TaskEvent, { kind: 'tool.result' }>): string {
  const p = ev.payload as { text?: string } | undefined
  return typeof p?.text === 'string' ? p.text : JSON.stringify(ev.payload ?? {}, null, 2)
}

/** Flatten a task's UIEvents into ordered chat bubbles. */
function bubblesFor(task: TaskRecord): Bubble[] {
  const out: Bubble[] = [{ kind: 'user', text: task.goal, key: `${task.id}-goal` }]
  task.events.forEach((e: UIEvent, i) => {
    const key = `${task.id}-${i}`
    if (e.kind === 'task.progress') {
      const ev = e.event
      if (ev.kind === 'llm.message' && ev.role === 'assistant') {
        out.push({ kind: 'assistant', text: typeof ev.content === 'string' ? ev.content : JSON.stringify(ev.content), key })
      } else if (ev.kind === 'tool.call') {
        out.push({ kind: 'event', label: `tool · ${ev.tool}`, detail: JSON.stringify(ev.args ?? {}, null, 2), key })
      } else if (ev.kind === 'tool.result') {
        out.push({ kind: 'event', label: ev.ok ? 'tool result' : 'tool error', detail: toolDetail(ev), key })
      }
    } else if (e.kind === 'task.permission_request') {
      out.push({ kind: 'event', label: `permission (${e.risk})`, detail: e.summary, key })
    } else if (e.kind === 'task.error') {
      const msg = typeof e.error === 'object' && e.error && 'message' in e.error ? String((e.error as { message: unknown }).message) : 'error'
      out.push({ kind: 'event', label: 'error', detail: msg, key })
    }
  })
  return out
}

type Props = { tasks: TaskRecord[] }

export function ConversationThread({ tasks }: Props): React.JSX.Element {
  if (tasks.length === 0) {
    return (
      <div className="flex h-full items-center justify-center text-muted-foreground text-sm">
        Send a message to start the conversation.
      </div>
    )
  }

  // Oldest first within the thread (tasks come newest-first from the cache).
  const ordered = [...tasks].sort((a, b) => a.startedAt - b.startedAt)

  return (
    <ScrollArea className="h-full">
      <div className="mx-auto flex max-w-3xl flex-col gap-3 p-4">
        {ordered.flatMap((t) =>
          bubblesFor(t).map((b) => {
            if (b.kind === 'user') {
              return (
                <div className="flex justify-end" key={b.key}>
                  <div className="max-w-[80%] rounded-2xl rounded-br-sm bg-primary px-4 py-2 text-primary-foreground text-sm">
                    {b.text}
                  </div>
                </div>
              )
            }
            if (b.kind === 'assistant') {
              return (
                <div className="flex justify-start" key={b.key}>
                  <div className="max-w-[80%] whitespace-pre-wrap rounded-2xl rounded-bl-sm bg-muted px-4 py-2 text-sm">
                    {b.text}
                  </div>
                </div>
              )
            }
            return (
              <details className={cn('rounded-lg border bg-background/50 px-3 py-1.5 text-xs')} key={b.key}>
                <summary className="cursor-pointer select-none text-muted-foreground">{b.label}</summary>
                <pre className="mt-1 max-h-60 overflow-auto whitespace-pre-wrap break-all text-[11px] leading-relaxed">
                  {b.detail}
                </pre>
              </details>
            )
          }),
        )}
        <div className="flex justify-center pt-1">
          <Badge variant="outline">{ordered[ordered.length - 1].status}</Badge>
        </div>
      </div>
    </ScrollArea>
  )
}
```

- [ ] **Step 2: Implement ChatInput (reworked from TaskInput, model selector kept)**

Create `src/renderer/src/components/chat-input.tsx`:

```tsx
import { useEffect, useMemo, useRef, useState } from 'react'
import type { ProviderId, ProvidersStateView } from '@shared/types/provider'

import { Button } from '@/components/ui/button'
import { Textarea } from '@/components/ui/textarea'
import { useProviders } from '@/hooks/use-providers'

type Props = {
  onSubmit: (goal: string) => void | Promise<void>
  disabled?: boolean
}

type ModelOption = { providerId: ProviderId; modelId: string; key: string }

const PROVIDER_IDS: readonly ProviderId[] = ['anthropic', 'openai', 'custom'] as const

function buildModelOptions(state: ProvidersStateView): ModelOption[] {
  const out: ModelOption[] = []
  for (const id of PROVIDER_IDS) {
    const row = state.providers[id]
    if (!row?.hasKey) continue
    const seen = new Set<string>()
    for (const m of [row.model, ...(row.customModels ?? [])]) {
      if (seen.has(m)) continue
      seen.add(m)
      out.push({ providerId: id, modelId: m, key: `${id}::${m}` })
    }
  }
  return out
}

export function ChatInput({ onSubmit, disabled }: Props): React.JSX.Element {
  const [value, setValue] = useState('')
  const ref = useRef<HTMLTextAreaElement>(null)
  const { state } = useProviders()

  const options = useMemo(() => buildModelOptions(state), [state])
  const currentKey =
    state.active && state.providers[state.active] ? `${state.active}::${state.providers[state.active]!.model}` : ''

  useEffect(() => {
    ref.current?.focus()
  }, [])

  const submit = async (): Promise<void> => {
    const goal = value.trim()
    if (!goal) return
    await onSubmit(goal)
    setValue('')
  }

  const onPickModel = async (e: React.ChangeEvent<HTMLSelectElement>): Promise<void> => {
    const opt = options.find((o) => o.key === e.target.value)
    if (!opt) return
    if (state.active !== opt.providerId) await window.swarm.providers.setActive(opt.providerId)
    if (state.providers[opt.providerId]?.model !== opt.modelId) {
      await window.swarm.providers.setModel(opt.providerId, opt.modelId)
    }
  }

  return (
    <div className="shrink-0 border-t p-3">
      <div className="mx-auto flex max-w-3xl items-end gap-2">
        {options.length > 0 && (
          <select
            className="h-9 rounded border border-input bg-background px-2 text-sm"
            onChange={(e) => void onPickModel(e)}
            title="Active model"
            value={currentKey}
          >
            {options.map((o) => (
              <option key={o.key} value={o.key}>
                {o.modelId}
              </option>
            ))}
          </select>
        )}
        <Textarea
          className="max-h-40 min-h-9 flex-1 resize-none"
          disabled={disabled}
          onChange={(e) => setValue(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Enter' && !e.shiftKey) {
              e.preventDefault()
              void submit()
            }
          }}
          placeholder="Message the swarm — Enter to send, Shift+Enter for newline"
          ref={ref}
          rows={1}
          value={value}
        />
        <Button disabled={disabled || value.trim().length === 0} onClick={() => void submit()}>
          Send
        </Button>
      </div>
    </div>
  )
}
```

- [ ] **Step 3: Typecheck**

Run: `pnpm typecheck:web`
Expected: No errors from the two new files (`tasks-view.tsx` still errors until Task 15).

- [ ] **Step 4: Commit**

```bash
git add src/renderer/src/components/conversation-thread.tsx src/renderer/src/components/chat-input.tsx
git commit -m "feat(renderer): ConversationThread bubbles + ChatInput"
```

---

### Task 15: Assemble the chat layout (sidebar + thread + bottom input)

**Files:**
- Modify: `src/renderer/src/components/app-sidebar.tsx`
- Modify: `src/renderer/src/components/views/tasks-view.tsx`
- Modify: `src/renderer/src/components/permission-drawer.tsx`

- [ ] **Step 1: Put the session list in the sidebar, nav in the footer**

Replace `src/renderer/src/components/app-sidebar.tsx` with:

```tsx
import { Link } from '@tanstack/react-router'
import { Settings, Sparkles } from 'lucide-react'

import { SessionList } from '@/components/session-list'
import { ThemeToggle } from '@/components/theme-toggle'
import {
  Sidebar,
  SidebarContent,
  SidebarFooter,
  SidebarMenu,
  SidebarMenuButton,
  SidebarMenuItem,
} from '@/components/ui/sidebar'

export function AppSidebar(): React.JSX.Element {
  return (
    <Sidebar>
      <SidebarContent>
        <SessionList />
      </SidebarContent>
      <SidebarFooter>
        <SidebarMenu>
          <SidebarMenuItem>
            <SidebarMenuButton
              render={
                <Link className="flex items-center gap-2" to="/skills">
                  <Sparkles />
                  <span>Skills</span>
                </Link>
              }
              tooltip="Skills"
            />
          </SidebarMenuItem>
          <SidebarMenuItem>
            <SidebarMenuButton onClick={() => void window.swarm.openSettings()} tooltip="Settings">
              <Settings />
              <span>Settings</span>
            </SidebarMenuButton>
          </SidebarMenuItem>
        </SidebarMenu>
        <ThemeToggle />
      </SidebarFooter>
    </Sidebar>
  )
}
```

> Note: the `collapsible="icon"` mode is dropped because the rail now hosts a text session list. If `to="/skills"` typing complains, reuse the `activeProps={... as any}` + `to={... as any}` widening pattern from the original file.

- [ ] **Step 2: Rebuild TasksView as the chat surface**

Replace `src/renderer/src/components/views/tasks-view.tsx` with:

```tsx
import { useEffect } from 'react'

import { ChatInput } from '@/components/chat-input'
import { ConversationThread } from '@/components/conversation-thread'
import { PermissionDrawer } from '@/components/permission-drawer'
import { useProviders } from '@/hooks/use-providers'
import { useDecidePermission, useLoadSessions, useSubmitGoal, useTasks } from '@/hooks/use-tasks'
import { usePermissionStore } from '@/stores/permission'
import { useSessionsStore } from '@/stores/sessions'

export function TasksView(): React.JSX.Element {
  const tasks = useTasks()
  const queue = usePermissionStore((s) => s.queue)
  const selectedSessionId = useSessionsStore((s) => s.selectedSessionId)
  const submitGoal = useSubmitGoal()
  const decide = useDecidePermission()
  const loadSessions = useLoadSessions()
  const { ready } = useProviders()

  // Load the session list once on mount.
  useEffect(() => {
    loadSessions.mutate()
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  const sessionTasks = tasks.filter((t) => t.sessionId === selectedSessionId)
  const currentPrompt = queue.find((p) => p.sessionId === selectedSessionId) ?? null

  return (
    <div className="flex h-full flex-col">
      <ConversationThread tasks={sessionTasks} />
      <PermissionDrawer
        onDecide={(actionId, decision) => {
          if (!currentPrompt) return
          decide.mutate({ sessionId: currentPrompt.sessionId, actionId, decision })
        }}
        prompt={currentPrompt}
      />
      <ChatInput
        disabled={submitGoal.isPending || !ready}
        onSubmit={async (g) => {
          if (!ready) return
          await submitGoal.mutateAsync(g)
        }}
      />
    </div>
  )
}
```

- [ ] **Step 3: Verify PermissionDrawer accepts the prompt shape**

Open `src/renderer/src/components/permission-drawer.tsx`. Its `prompt` prop is `PermissionPrompt | null` (from the permission store). Since Task 12 added `sessionId` to `PermissionPrompt`, no change is needed unless the drawer destructures a fixed field set — if so, leave rendering as-is. Confirm it still compiles.

- [ ] **Step 4: Typecheck the whole renderer + run all renderer tests**

Run: `pnpm typecheck:web && pnpm test src/renderer`
Expected: PASS. Fix any residual references to the removed top input or `selectedTaskId` (the old `useUiStore` is no longer used by TasksView; leave the store file in place if other code imports it, otherwise it is dead code — note it, do not delete unless unused).

- [ ] **Step 5: Commit**

```bash
git add src/renderer/src/components/app-sidebar.tsx src/renderer/src/components/views/tasks-view.tsx src/renderer/src/components/permission-drawer.tsx
git commit -m "feat(renderer): chat layout — session sidebar, thread, bottom input"
```

---

### Task 16: Full verification pass

**Files:** none (verification only)

- [ ] **Step 1: Typecheck everything**

Run: `pnpm typecheck`
Expected: PASS (node + web).

- [ ] **Step 2: Lint**

Run: `pnpm lint`
Expected: No new errors. Fix formatting/lint issues introduced by new files.

- [ ] **Step 3: Full test suite**

Run: `pnpm test`
Expected: PASS across service, main, shared, renderer.

- [ ] **Step 4: Manual smoke (document result in the commit/PR)**

Run the app (`pnpm dev`). Verify: `+ New chat` creates a session in the left list; a message appears as a right bubble and the assistant reply as a left bubble; tool rows are collapsible; sending a second message in the same chat shows the agent retains context; switching chats replays history; restarting the app repopulates the session list and reopening a chat shows its prior conversation.

- [ ] **Step 5: Commit any lint/format fixes**

```bash
git add -A
git commit -m "chore: lint/format pass for multi-session chat"
```

---

## Notes / Known Limitations (intentional, per spec)

- **Provider key freshness on rehydration:** a session reopened after restart uses the provider snapshot persisted at creation. If keys were rotated in Settings, reopen behavior uses the stored snapshot. Acceptable for this scope.
- **No rename/delete/search** of sessions (YAGNI). Titles auto-derive from the first goal (60-char slice).
- **`useUiStore` (`selectedTaskId`)** may become unused after Task 15. Check imports; if nothing references it, it is dead code — flag it in the PR rather than deleting silently.
