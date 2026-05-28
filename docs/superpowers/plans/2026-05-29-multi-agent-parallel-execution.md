# Multi-Agent Parallel Execution Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Fix three gaps that prevent parallel sub-agent execution from working: empty child result propagation, unused concurrency semaphore, and no runtime-selectable provider at spawn time.

**Architecture:** `AgentRunner.run()` is updated to return `{ status, summary }` instead of a bare string. The session manager uses this to propagate the child agent's actual output back through `spawnChild`. A semaphore enforces `maxConcurrent`, and `spawnChild` accepts an optional `providerKey` looked up from a registry populated at session-creation time.

**Tech Stack:** TypeScript, Vitest, Node.js (no new dependencies)

---

## File Map

| File | Change |
|---|---|
| `src/service/agent-runner.ts` | Return `{ status, summary }` from `run()`; add `providerKey` to `spawn_sub_agent` params and `AgentRunnerDeps.spawnChild` type |
| `src/service/agent-runner.test.ts` | Assert return shape on error path; add `providerKey` to `spawnChild` mock type |
| `src/service/session-manager.ts` | Add semaphore; fix spawnChild result; add `getProvider` to config; add `providerKey` to `spawnChild` |
| `src/service/session-manager.test.ts` | Mock `createAgentRunner`; add semaphore test; add summary-propagation test; add providerKey test; update existing tests to pass `getProvider` |
| `src/service/server.ts` | Accept `registerProvider` callback in config; call it on `POST /sessions` |
| `src/service/index.ts` | Maintain `providerRegistry` Map; pass `getProvider` + `registerProvider` to session manager and server |

---

## Task 1: Fix `AgentRunner.run()` return type

**Files:**
- Modify: `src/service/agent-runner.ts`
- Modify: `src/service/agent-runner.test.ts`

---

- [ ] **Step 1: Add return-shape assertion to the existing test**

Open `src/service/agent-runner.test.ts`. The existing test already passes `apiKey: ''` which triggers an early return. Add a return-value assertion after `await runner.run()`:

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

describe('AgentRunner', () => {
  it('emits task.error and returns { status: failed, summary: "" } when apiKey is empty', async () => {
    const emitted: Array<{ event: string; data: unknown }> = []
    const runner = createAgentRunner({
      task: mkTask('t-1'),
      provider: { id: 'anthropic', model: 'claude-haiku-4-5-20251001', apiKey: '' },
      agentDefinition: { id: 'default', name: 'Default', systemPrompt: '', toolScope: 'all', maxIterations: 1 },
      emit: (event, data) => emitted.push({ event, data }),
      permissionRegistry: { request: vi.fn(), resolve: vi.fn() },
      spawnChild: vi.fn(),
      sessionId: 'ses-1',
    })
    const result = await runner.run()
    expect(result.status).toBe('failed')
    expect(result.summary).toBe('')
    const errEvent = emitted.find((e) => e.event === 'task.error')
    expect(errEvent).toBeDefined()
    const errData = errEvent!.data as { taskId: string; error: { code: string } }
    expect(errData.taskId).toBe('t-1')
    expect(errData.error.code).toBeTruthy()
  })
})
```

- [ ] **Step 2: Run the test — verify it fails**

```bash
pnpm vitest run src/service/agent-runner.test.ts
```

Expected: FAIL — `result.status` is `undefined` because `run()` currently returns `void`.

- [ ] **Step 3: Update the `AgentRunner` type and `run()` return signature**

In `src/service/agent-runner.ts`, change lines 78–80:

```typescript
// Before:
export type AgentRunner = {
  run(): Promise<'completed' | 'failed'>
}

// After:
export type AgentRunner = {
  run(): Promise<{ status: 'completed' | 'failed'; summary: string }>
}
```

- [ ] **Step 4: Update the implementation signature of `run()`**

Change line 168:

```typescript
// Before:
async run(): Promise<void> {

// After:
async run(): Promise<{ status: 'completed' | 'failed'; summary: string }> {
```

- [ ] **Step 5: Fix the early-return paths (missing API key and setup error)**

There are two early return paths before `agent.prompt()`. Update both:

Path 1 — missing API key (around line 182–194). Change the `return 'failed'` at the end of that block:
```typescript
      return { status: 'failed', summary: '' }
```

Path 2 — setup threw (around line 235–250). Change the `return 'failed'` at the end of that catch block:
```typescript
      return { status: 'failed', summary: '' }
```

- [ ] **Step 6: Fix the success and exception returns in the `agent.prompt()` try/catch**

Around lines 327–346:

```typescript
      try {
        await agent.prompt(task.goal)
        taskLog.info({ msg: 'agent.prompt resolved', durationMs: Date.now() - t0 })
        return { status: 'completed', summary: translator.getFinalSummary() }
      } catch (err) {
        taskLog.error({
          msg: 'agent.prompt threw',
          durationMs: Date.now() - t0,
          err: err instanceof Error ? { name: err.name, message: err.message, stack: err.stack } : String(err),
        })
        emit('task.error', {
          taskId: task.id,
          error: {
            code: 'agent_exception',
            message: err instanceof Error ? err.message : String(err),
            tier: 'fatal',
          },
          ts: Date.now(),
        })
        return { status: 'failed', summary: '' }
      }
```

- [ ] **Step 7: Run the test — verify it passes**

```bash
pnpm vitest run src/service/agent-runner.test.ts
```

Expected: PASS

- [ ] **Step 8: Commit**

```bash
git add src/service/agent-runner.ts src/service/agent-runner.test.ts
git commit -m "fix(agent-runner): run() returns { status, summary } instead of bare string"
```

---

## Task 2: Fix spawnChild summary propagation + enforce maxConcurrent semaphore

**Files:**
- Modify: `src/service/session-manager.ts`
- Modify: `src/service/session-manager.test.ts`

---

- [ ] **Step 1: Add `vi.mock` for agent-runner and write a semaphore test**

Replace the full content of `src/service/session-manager.test.ts`:

```typescript
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { rmSync } from 'node:fs'
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { createSessionManager } from './session-manager'
import { createConversationStore } from './conversation-store'
import { createSseBroadcaster } from './sse'

vi.mock('./agent-runner', () => ({
  createAgentRunner: vi.fn(),
}))

import { createAgentRunner } from './agent-runner'
const mockCreate = vi.mocked(createAgentRunner)

const tmpDb = () => join(tmpdir(), `swarm-ses-test-${Date.now()}.db`)

describe('SessionManager', () => {
  let dbPath: string

  beforeEach(() => {
    dbPath = tmpDb()
    mockCreate.mockReset()
  })
  afterEach(() => { try { rmSync(dbPath) } catch {} })

  it('creates a session and returns sessionId', () => {
    const store = createConversationStore(dbPath)
    const broadcaster = createSseBroadcaster()
    const manager = createSessionManager({ store, broadcaster, maxConcurrent: 2, getProvider: () => undefined })
    const provider = { id: 'anthropic' as const, model: 'claude-haiku-4-5-20251001', apiKey: 'k' }

    const { sessionId } = manager.createSession(provider)
    expect(sessionId).toBeTruthy()
    expect(store.getSession(sessionId)?.status).toBe('active')
    store.close()
  })

  it('marks active sessions interrupted on init', () => {
    const store = createConversationStore(dbPath)
    const provider = { id: 'anthropic' as const, model: 'claude-haiku-4-5-20251001', apiKey: 'k' }
    store.createSession('old-ses', provider)
    store.close()

    const store2 = createConversationStore(dbPath)
    const broadcaster = createSseBroadcaster()
    createSessionManager({ store: store2, broadcaster, maxConcurrent: 2, getProvider: () => undefined })

    expect(store2.getSession('old-ses')?.status).toBe('interrupted')
    store2.close()
  })

  it('resolves permission by forwarding to registry', () => {
    const store = createConversationStore(dbPath)
    const broadcaster = createSseBroadcaster()
    const manager = createSessionManager({ store, broadcaster, maxConcurrent: 2, getProvider: () => undefined })
    const provider = { id: 'anthropic' as const, model: 'claude-haiku-4-5-20251001', apiKey: 'k' }
    const { sessionId } = manager.createSession(provider)

    expect(() => manager.resolvePermission(sessionId, 'no-such-action', 'deny')).not.toThrow()
    store.close()
  })

  it('limits concurrent runners to maxConcurrent', async () => {
    const resolvers: Array<(v: { status: 'completed' | 'failed'; summary: string }) => void> = []
    mockCreate.mockImplementation(() => ({
      run: () => new Promise<{ status: 'completed' | 'failed'; summary: string }>(
        (resolve) => { resolvers.push(resolve) }
      ),
    }))

    const store = createConversationStore(dbPath)
    const broadcaster = createSseBroadcaster()
    const manager = createSessionManager({ store, broadcaster, maxConcurrent: 2, getProvider: () => undefined })
    const provider = { id: 'anthropic' as const, model: 'claude-haiku-4-5-20251001', apiKey: 'k' }
    const { sessionId } = manager.createSession(provider)

    manager.submitGoal(sessionId, 'goal 1')
    manager.submitGoal(sessionId, 'goal 2')
    manager.submitGoal(sessionId, 'goal 3')

    // Flush promise queue: two slots fill immediately
    await Promise.resolve()
    await Promise.resolve()
    expect(resolvers).toHaveLength(2)

    // Release one slot — the queued runner should start
    resolvers[0]({ status: 'completed', summary: '' })
    await Promise.resolve()
    await Promise.resolve()
    await Promise.resolve()
    expect(resolvers).toHaveLength(3)

    resolvers[1]({ status: 'completed', summary: '' })
    resolvers[2]({ status: 'completed', summary: '' })
    store.close()
  })

  it('propagates child runner summary through spawnChild', async () => {
    let callCount = 0
    let capturedSpawnChild: ((...args: unknown[]) => Promise<{ childTaskId: string; result: { summary: string; artifacts: unknown[] } }>) | null = null

    mockCreate.mockImplementation((deps) => {
      callCount++
      if (callCount === 1) {
        // Parent runner: capture spawnChild dep, then resolve
        capturedSpawnChild = deps.spawnChild as typeof capturedSpawnChild
        return { run: vi.fn().mockResolvedValue({ status: 'completed', summary: 'parent done' }) }
      }
      // Child runner: resolves with a non-empty summary
      return { run: vi.fn().mockResolvedValue({ status: 'completed', summary: 'child result text' }) }
    })

    const store = createConversationStore(dbPath)
    const broadcaster = createSseBroadcaster()
    const manager = createSessionManager({ store, broadcaster, maxConcurrent: 4, getProvider: () => undefined })
    const provider = { id: 'anthropic' as const, model: 'claude-haiku-4-5-20251001', apiKey: 'k' }
    const { sessionId } = manager.createSession(provider)

    const { taskId: parentTaskId } = manager.submitGoal(sessionId, 'parent goal')

    // Wait for the async startRunner to reach createAgentRunner
    await new Promise(resolve => setTimeout(resolve, 0))

    expect(capturedSpawnChild).not.toBeNull()
    const childResult = await capturedSpawnChild!(parentTaskId, 'child goal')
    expect(childResult.result.summary).toBe('child result text')

    store.close()
  })
})
```

- [ ] **Step 2: Run the new tests — verify they fail**

```bash
pnpm vitest run src/service/session-manager.test.ts
```

Expected: `limits concurrent runners` FAIL (semaphore not implemented). `propagates child runner summary` FAIL (summary is `''`). Existing 3 tests may fail on the `getProvider` missing field — that's expected.

- [ ] **Step 3: Add `getProvider` to `SessionManagerConfig` type in session-manager.ts**

Change the `SessionManagerConfig` type (lines 18–22):

```typescript
type SessionManagerConfig = {
  store: ConversationStore
  broadcaster: SseBroadcaster
  maxConcurrent: number
  getProvider(key: string): ProviderInjection | undefined
}
```

- [ ] **Step 4: Add the semaphore at the top of `createSessionManager`**

After the opening `{` of `createSessionManager`, before the `sessions` Map declaration, insert:

```typescript
  let activeRunners = 0
  const waitQueue: Array<() => void> = []

  async function acquireSlot(): Promise<void> {
    if (activeRunners < cfg.maxConcurrent) { activeRunners++; return }
    await new Promise<void>(resolve => waitQueue.push(resolve))
    activeRunners++
  }

  function releaseSlot(): void {
    activeRunners--
    waitQueue.shift()?.()
  }
```

- [ ] **Step 5: Wrap `submitGoal`'s runner execution with the semaphore**

Replace the runner start block in `submitGoal` (the `session.runnerActive = true; void runner.run()...` lines) with:

```typescript
      const startRunner = async (): Promise<void> => {
        await acquireSlot()
        const runner = createAgentRunner({
          task, provider: session.provider, agentDefinition: agentDef,
          sessionId, emit, permissionRegistry: session.permissionRegistry,
          spawnChild: (pt, ng, st) => spawnChild(sessionId, pt, ng, st),
        })
        session.runnerActive = true
        try {
          const { status } = await runner.run()
          session.runnerActive = false
          store.updateTaskStatus(taskId, status === 'completed' ? 'completed' : 'failed')
        } finally {
          releaseSlot()
        }
      }
      void startRunner()
```

- [ ] **Step 6: Fix `spawnChild` to use the actual runner summary**

In `spawnChild`, replace the `return new Promise(...)` block with:

```typescript
    return new Promise<{ childTaskId: string; result: TaskResult }>((resolve) => {
      const startChild = async (): Promise<void> => {
        await acquireSlot()
        const runner = createAgentRunner({
          task: childTask, provider: session.provider,
          agentDefinition: DEFAULT_AGENT_DEF, sessionId,
          emit, permissionRegistry: session.permissionRegistry,
          spawnChild: (pt, ng, st) => spawnChild(sessionId, pt, ng, st),
        })
        try {
          const { summary } = await runner.run()
          resolve({ childTaskId, result: { summary, artifacts: [] } })
        } finally {
          releaseSlot()
        }
      }
      void startChild()
    })
```

- [ ] **Step 7: Run the tests — verify they all pass**

```bash
pnpm vitest run src/service/session-manager.test.ts
```

Expected: all 5 tests PASS.

- [ ] **Step 8: Run the full test suite to check for regressions**

```bash
pnpm vitest run
```

Expected: all tests pass (agent-runner.test.ts may fail if TypeScript complains about session-manager calling `runner.run()` — it should be fine since we already fixed the return type in Task 1).

- [ ] **Step 9: Commit**

```bash
git add src/service/session-manager.ts src/service/session-manager.test.ts
git commit -m "fix(session-manager): propagate child summary + enforce maxConcurrent semaphore"
```

---

## Task 3: Add `providerKey` support end-to-end

**Files:**
- Modify: `src/service/agent-runner.ts` — `AgentRunnerDeps.spawnChild` type + `spawn_sub_agent` params
- Modify: `src/service/agent-runner.test.ts` — update `spawnChild` mock type
- Modify: `src/service/session-manager.ts` — `spawnChild` signature + provider lookup
- Modify: `src/service/session-manager.test.ts` — add `providerKey` test
- Modify: `src/service/server.ts` — accept `registerProvider` callback
- Modify: `src/service/index.ts` — maintain `providerRegistry`, wire everything

---

- [ ] **Step 1: Write a failing test for providerKey lookup in session-manager.test.ts**

Add two new `it()` blocks inside the `describe('SessionManager')` block in `src/service/session-manager.test.ts`:

```typescript
  it('uses session provider when providerKey is not given', async () => {
    const sessionProvider = { id: 'anthropic' as const, model: 'claude-haiku-4-5-20251001', apiKey: 'session-key' }
    let usedProvider: typeof sessionProvider | null = null

    mockCreate.mockImplementation((deps) => {
      // Capture the provider used by the child runner (second call)
      if (mockCreate.mock.calls.length === 2) {
        usedProvider = deps.provider as typeof sessionProvider
      }
      return { run: vi.fn().mockResolvedValue({ status: 'completed', summary: '' }) }
    })

    let capturedSpawnChild: ((...args: unknown[]) => Promise<unknown>) | null = null
    mockCreate.mockImplementationOnce((deps) => {
      capturedSpawnChild = deps.spawnChild as typeof capturedSpawnChild
      return { run: vi.fn().mockResolvedValue({ status: 'completed', summary: '' }) }
    })

    const store = createConversationStore(dbPath)
    const broadcaster = createSseBroadcaster()
    const altProvider = { id: 'openai' as const, model: 'gpt-4o', apiKey: 'alt-key' }
    const manager = createSessionManager({
      store, broadcaster, maxConcurrent: 4,
      getProvider: (key) => key === 'openai' ? altProvider : undefined,
    })

    const { sessionId } = manager.createSession(sessionProvider)
    manager.submitGoal(sessionId, 'parent goal')
    await new Promise(resolve => setTimeout(resolve, 0))

    // spawnChild without providerKey — should use session provider
    await capturedSpawnChild!(/* parentTaskId */ 'any', 'child goal', undefined, undefined)
    expect(usedProvider?.apiKey).toBe('session-key')
    store.close()
  })

  it('uses the looked-up provider when providerKey matches', async () => {
    const sessionProvider = { id: 'anthropic' as const, model: 'claude-haiku-4-5-20251001', apiKey: 'session-key' }
    const altProvider = { id: 'openai' as const, model: 'gpt-4o', apiKey: 'alt-key' }
    let childProvider: typeof sessionProvider | null = null

    let firstCall = true
    let capturedSpawnChild: ((...args: unknown[]) => Promise<unknown>) | null = null

    mockCreate.mockImplementation((deps) => {
      if (firstCall) {
        firstCall = false
        capturedSpawnChild = deps.spawnChild as typeof capturedSpawnChild
      } else {
        childProvider = deps.provider as typeof sessionProvider
      }
      return { run: vi.fn().mockResolvedValue({ status: 'completed', summary: '' }) }
    })

    const store = createConversationStore(dbPath)
    const broadcaster = createSseBroadcaster()
    const manager = createSessionManager({
      store, broadcaster, maxConcurrent: 4,
      getProvider: (key) => key === 'openai' ? altProvider : undefined,
    })

    const { sessionId } = manager.createSession(sessionProvider)
    manager.submitGoal(sessionId, 'parent goal')
    await new Promise(resolve => setTimeout(resolve, 0))

    // spawnChild with providerKey 'openai' — should use altProvider
    await capturedSpawnChild!(/* parentTaskId */ 'any', 'child goal', undefined, 'openai')
    expect(childProvider?.apiKey).toBe('alt-key')
    store.close()
  })
```

- [ ] **Step 2: Run — verify these tests fail**

```bash
pnpm vitest run src/service/session-manager.test.ts
```

Expected: the two new tests FAIL because `spawnChild` doesn't accept a 4th `providerKey` arg yet.

- [ ] **Step 3: Update `spawnChild` in session-manager.ts to accept `providerKey`**

Change the `spawnChild` function signature and add provider resolution:

```typescript
  const spawnChild = async (
    sessionId: string,
    parentTaskId: string,
    newGoal: string,
    suggestedTools?: string[],
    providerKey?: string,
  ): Promise<{ childTaskId: string; result: TaskResult }> => {
    const session = sessions.get(sessionId)
    if (!session) throw new Error(`session ${sessionId} not found`)

    const resolvedProvider = (providerKey ? cfg.getProvider(providerKey) : undefined) ?? session.provider
    if (providerKey && !cfg.getProvider(providerKey)) {
      log.warn({ msg: 'providerKey not found, falling back to session provider', providerKey })
    }

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
      const startChild = async (): Promise<void> => {
        await acquireSlot()
        const runner = createAgentRunner({
          task: childTask, provider: resolvedProvider,
          agentDefinition: DEFAULT_AGENT_DEF, sessionId,
          emit, permissionRegistry: session.permissionRegistry,
          spawnChild: (pt, ng, st, pk) => spawnChild(sessionId, pt, ng, st, pk),
        })
        try {
          const { summary } = await runner.run()
          resolve({ childTaskId, result: { summary, artifacts: [] } })
        } finally {
          releaseSlot()
        }
      }
      void startChild()
    })
  }
```

Also update the recursive `spawnChild` call inside `submitGoal`'s `startRunner`:

```typescript
          spawnChild: (pt, ng, st, pk) => spawnChild(sessionId, pt, ng, st, pk),
```

- [ ] **Step 4: Run session-manager tests — verify all pass**

```bash
pnpm vitest run src/service/session-manager.test.ts
```

Expected: all 7 tests PASS.

- [ ] **Step 5: Update `AgentRunnerDeps.spawnChild` type in agent-runner.ts**

Change the `spawnChild` field inside `AgentRunnerDeps` (around line 75):

```typescript
export type AgentRunnerDeps = {
  task: Task
  provider: ProviderInjection
  agentDefinition: AgentDefinition
  sessionId: string
  emit: EmitFn
  permissionRegistry: PermissionRegistry
  spawnChild(
    parentTaskId: string,
    newGoal: string,
    suggestedTools?: string[],
    providerKey?: string,
  ): Promise<{ childTaskId: string; result: TaskResult }>
}
```

- [ ] **Step 6: Add `providerKey` to the `spawn_sub_agent` tool params and its `execute` call**

In `createAgentRunner`, find the `SpawnParams` definition (around line 209) and the `execute` body. Replace both:

```typescript
        const SpawnParams = Type.Object({
          goal: Type.String({ description: 'The goal for the sub-agent to accomplish.' }),
          suggestedTools: Type.Optional(
            Type.Array(Type.String(), { description: 'Tool scopes to make available (e.g. ["peekaboo"]).' })
          ),
          providerKey: Type.Optional(
            Type.String({ description: 'Key of a configured provider to use for this sub-agent. Defaults to current session provider.' })
          ),
        })
```

And the `execute` function inside the spawn tool:

```typescript
            execute: async (_toolCallId: string, params: unknown) => {
              const p = params as { goal: string; suggestedTools?: string[]; providerKey?: string }
              const { childTaskId, result } = await spawnChild(task.id, p.goal, p.suggestedTools, p.providerKey)
              return {
                content: [{ type: 'text', text: result.summary }],
                details: { childTaskId, summary: result.summary },
              }
            },
```

- [ ] **Step 7: Update the agent-runner test to include `providerKey` in the spawnChild mock type**

The existing test passes `spawnChild: vi.fn()` — this still compiles fine since `vi.fn()` is `any`. No code change needed; TypeScript will validate the updated `AgentRunnerDeps` type automatically.

- [ ] **Step 8: Run the agent-runner tests**

```bash
pnpm vitest run src/service/agent-runner.test.ts
```

Expected: PASS (no behavioral change, only type additions).

- [ ] **Step 9: Update `server.ts` to accept and call `registerProvider`**

Change `ServerConfig` and the `POST /sessions` handler in `src/service/server.ts`:

```typescript
type ServerConfig = {
  manager: SessionManager
  broadcaster: SseBroadcaster
  registerProvider(provider: import('@shared/types/provider').ProviderInjection): void
}
```

In the `POST /sessions` block, after `manager.createSession(body.provider)`:

```typescript
      if (method === 'POST' && url === '/sessions') {
        const body = (await readBody(req)) as { provider: import('@shared/types/provider').ProviderInjection }
        cfg.registerProvider(body.provider)
        const result = manager.createSession(body.provider)
        json(res, 200, result)
        return
      }
```

- [ ] **Step 10: Update `src/service/index.ts` to wire the provider registry**

Replace the full file:

```typescript
import { createLogger } from '@shared/logger'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { ProviderInjection } from '@shared/types/provider'
import { createConversationStore } from './conversation-store'
import { createSseBroadcaster } from './sse'
import { createSessionManager } from './session-manager'
import { createServer } from './server'

const log = createLogger({ process: 'service' }).child({ component: 'index' })

const dbPath = process.env.SWARM_SERVICE_DB_PATH ?? join(tmpdir(), 'swarm-agent-service.db')

const store = createConversationStore(dbPath)
const broadcaster = createSseBroadcaster()

const providerRegistry = new Map<string, ProviderInjection>()

const manager = createSessionManager({
  store,
  broadcaster,
  maxConcurrent: 4,
  getProvider: (key) => providerRegistry.get(key),
})

const server = createServer({
  manager,
  broadcaster,
  registerProvider: (provider) => { providerRegistry.set(provider.id, provider) },
})

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

- [ ] **Step 11: Update the server test to pass `registerProvider`**

Check `src/service/server.test.ts` for any `createServer({ manager, broadcaster })` calls and add `registerProvider: vi.fn()` to each.

- [ ] **Step 12: Run the full test suite**

```bash
pnpm vitest run
```

Expected: all tests pass.

- [ ] **Step 13: Commit**

```bash
git add src/service/agent-runner.ts src/service/agent-runner.test.ts \
        src/service/session-manager.ts src/service/session-manager.test.ts \
        src/service/server.ts src/service/index.ts
git commit -m "feat(multi-agent): providerKey selection for child agents + wire registry in service"
```

---

## Self-Review

**Spec coverage check:**

| Spec requirement | Task |
|---|---|
| `AgentRunner.run()` returns `{ status, summary }` | Task 1 ✅ |
| `spawnChild` uses actual child summary | Task 2 ✅ |
| `maxConcurrent` semaphore enforced | Task 2 ✅ |
| `SessionManagerConfig.getProvider` | Task 3 ✅ |
| `spawnChild` accepts `providerKey` | Task 3 ✅ |
| `AgentRunnerDeps.spawnChild` type updated | Task 3 ✅ |
| `spawn_sub_agent` tool params include `providerKey` | Task 3 ✅ |
| Provider fallback with warn log | Task 3 ✅ |
| `server.ts` registers provider on session create | Task 3 ✅ |
| Error: child task `failed` resolves (not rejects) spawnChild | Task 2 ✅ (spawnChild resolves from runner.run()) |

**Placeholder scan:** No TBD, TODO, or vague steps found.

**Type consistency check:**
- `spawnChild` signature in `session-manager.ts`: `(sessionId, parentTaskId, newGoal, suggestedTools?, providerKey?)`
- `spawnChild` in `AgentRunnerDeps`: `(parentTaskId, newGoal, suggestedTools?, providerKey?)` — no `sessionId` (the closure captures it) ✅
- `AgentRunner.run()` returns `{ status: 'completed' | 'failed'; summary: string }` — consistent across Task 1 definition, Task 2 destructuring, Task 3 type ✅
- `getProvider(key: string): ProviderInjection | undefined` — consistent across `SessionManagerConfig`, `createSessionManager` usage, and `index.ts` wiring ✅
