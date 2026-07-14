# Autonomous Loop Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add a `wait_for_task` capability so an agent can pause its loop until another task finishes and then wake itself to continue, plus a loop-aware prompt section that steers agents to drive autonomy with the tools that already exist.

**Architecture:** Reuse the existing runtime (native agent loop, `schedule_task`, `messaging`, resident actor + cross-dormancy state, runner budget/`maxTurns`). The only new mechanism is a durable task-completion watcher: the `ConversationStore` fires a listener at the single point a task goes terminal (`updateTaskStatus`); a `TaskWaiterService` looks up waiters for that task and delivers a wake message to the waiting agent's actor address via the manager. A new `wait_for_task` tool registers waiters; a prompt section documents the loop conventions.

**Tech Stack:** TypeScript, Electron, `@earendil-works/pi-agent-core` (`AgentTool`, `Type`), better-sqlite3 (`ConversationStore`), Vitest (run under Electron node), Biome.

## Global Constraints

- **Test runner:** `npm test -- <path>` (runs `cross-env ELECTRON_RUN_AS_NODE=1 electron node_modules/vitest/vitest.mjs run`). Never run bare `npx vitest`. Never `pnpm rebuild better-sqlite3`.
- **Logging (CLAUDE.md §5):** every module gets `const log = createLogger({ process: 'service' }).child({ component: '<module>' })`. Log business entry/outcome at `info`, every `catch` at `error` with `{ msg, err }`. Use structured first arg, never string interpolation.
- **Comments & commits in English.** Conversational replies in Chinese.
- **Surgical changes (CLAUDE.md §3):** touch only what each task requires; match surrounding style.
- **Formatting:** `npx biome check --write <file>` on changed files only (never `pnpm check`, which reformats the whole repo).
- **Terminal task statuses** are exactly: `completed`, `failed`, `cancelled`, `interrupted` (matches `ConversationStore.updateTaskStatus` and the cron reconcile set).

---

### Task 1: Store — `task_waiters` persistence + terminal listener

**Files:**
- Modify: `src/service/conversation/store.ts`
- Test: `src/service/conversation/store.test.ts`

**Interfaces:**
- Consumes: existing `createConversationStore(dbPath)`, `updateTaskStatus(taskId, status, result?)`, `getTask(taskId)`, `saveTask(task, sessionId)`.
- Produces (added to the store object and its TS interface):
  - `type StoredTaskWaiter = { id: string; sessionId: string; waiterAddress: string; taskId: string; goal: string | null; createdAt: number }`
  - `saveTaskWaiter(w: StoredTaskWaiter): void`
  - `listTaskWaitersForTask(taskId: string): StoredTaskWaiter[]`
  - `listAllTaskWaiters(): StoredTaskWaiter[]`
  - `deleteTaskWaiter(id: string): void`
  - `setTaskTerminalListener(fn: (taskId: string, status: string) => void): void`

- [ ] **Step 1: Write the failing tests**

Add to `src/service/conversation/store.test.ts` (the file already imports `createConversationStore`, `tmpDb`, vitest). Add a `Task` import at the top if not present: `import type { Task } from '@shared/types/task'`.

```ts
const mkTask = (id: string, status: Task['status']): Task => ({
  id,
  parentId: null,
  agentDefId: 'default',
  goal: 'g',
  status,
  assignedWorkerId: null,
  toolAllowlist: [],
  budget: { tokens: 0, calls: 0, wallMs: 0, usdCents: 0 },
  used: { tokens: 0, calls: 0, wallMs: 0, usdCents: 0 },
  history: [],
  result: null,
  createdAt: Date.now(),
})

describe('task waiters', () => {
  it('saves, lists by task, and deletes a waiter', () => {
    const store = createConversationStore(tmpDb())
    store.saveTaskWaiter({
      id: 'w1',
      sessionId: 'ses-1',
      waiterAddress: 'addr-A',
      taskId: 'task-X',
      goal: 'continue',
      createdAt: 1,
    })
    expect(store.listTaskWaitersForTask('task-X').map((w) => w.id)).toEqual(['w1'])
    expect(store.listAllTaskWaiters()).toHaveLength(1)
    store.deleteTaskWaiter('w1')
    expect(store.listTaskWaitersForTask('task-X')).toEqual([])
    store.close()
  })

  it('fires the terminal listener only on terminal status', () => {
    const store = createConversationStore(tmpDb())
    store.createSession('ses-1', { id: 'anthropic' as const, model: 'm', apiKey: 'k' })
    store.saveTask(mkTask('task-X', 'running'), 'ses-1')
    const fired: Array<[string, string]> = []
    store.setTaskTerminalListener((taskId, status) => fired.push([taskId, status]))

    store.updateTaskStatus('task-X', 'running')
    expect(fired).toEqual([])

    store.updateTaskStatus('task-X', 'completed')
    expect(fired).toEqual([['task-X', 'completed']])
    store.close()
  })

  it('persists waiters across reopen', () => {
    const path = tmpDb()
    const s1 = createConversationStore(path)
    s1.saveTaskWaiter({ id: 'w1', sessionId: 's', waiterAddress: 'a', taskId: 'task-X', goal: null, createdAt: 1 })
    s1.close()
    const s2 = createConversationStore(path)
    expect(s2.listAllTaskWaiters().map((w) => w.id)).toEqual(['w1'])
    s2.close()
  })
})
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `npm test -- src/service/conversation/store.test.ts`
Expected: FAIL — `store.saveTaskWaiter is not a function` (and the listener test fails).

- [ ] **Step 3: Add the table to schema init**

In `src/service/conversation/store.ts`, next to the other `CREATE TABLE IF NOT EXISTS` statements (the block around the `sessions`/`tasks`/`cron_*` table definitions), add:

```ts
db.exec(`
  CREATE TABLE IF NOT EXISTS task_waiters (
    id             TEXT PRIMARY KEY,
    session_id     TEXT NOT NULL,
    waiter_address TEXT NOT NULL,
    task_id        TEXT NOT NULL,
    goal           TEXT,
    created_at     INTEGER NOT NULL
  );
  CREATE INDEX IF NOT EXISTS task_waiters_task_idx ON task_waiters (task_id);
`)
```

- [ ] **Step 4: Add the `StoredTaskWaiter` type and the interface members**

Near `StoredCronJob`/`StoredCronRun` type declarations add:

```ts
export type StoredTaskWaiter = {
  id: string
  sessionId: string
  waiterAddress: string
  taskId: string
  goal: string | null
  createdAt: number
}
```

In the `ConversationStore` interface (alongside the cron method signatures) add:

```ts
  saveTaskWaiter(w: StoredTaskWaiter): void
  listTaskWaitersForTask(taskId: string): StoredTaskWaiter[]
  listAllTaskWaiters(): StoredTaskWaiter[]
  deleteTaskWaiter(id: string): void
  setTaskTerminalListener(fn: (taskId: string, status: string) => void): void
```

- [ ] **Step 5: Implement statements, row mapper, listener, and methods**

Inside `createConversationStore`, near the other prepared statements add:

```ts
const stmtInsertTaskWaiter = db.prepare(
  `INSERT INTO task_waiters (id, session_id, waiter_address, task_id, goal, created_at)
   VALUES (?, ?, ?, ?, ?, ?)`
)
const stmtListWaitersForTask = db.prepare('SELECT * FROM task_waiters WHERE task_id = ? ORDER BY created_at ASC')
const stmtListAllWaiters = db.prepare('SELECT * FROM task_waiters ORDER BY created_at ASC')
const stmtDeleteWaiter = db.prepare('DELETE FROM task_waiters WHERE id = ?')

const rowToTaskWaiter = (row: Record<string, unknown>): StoredTaskWaiter => ({
  id: row.id as string,
  sessionId: row.session_id as string,
  waiterAddress: row.waiter_address as string,
  taskId: row.task_id as string,
  goal: (row.goal as string | null) ?? null,
  createdAt: row.created_at as number,
})

let taskTerminalListener: ((taskId: string, status: string) => void) | null = null
```

In the returned object add the methods:

```ts
    saveTaskWaiter(w) {
      stmtInsertTaskWaiter.run(w.id, w.sessionId, w.waiterAddress, w.taskId, w.goal ?? null, w.createdAt)
    },
    listTaskWaitersForTask(taskId) {
      return (stmtListWaitersForTask.all(taskId) as Record<string, unknown>[]).map(rowToTaskWaiter)
    },
    listAllTaskWaiters() {
      return (stmtListAllWaiters.all() as Record<string, unknown>[]).map(rowToTaskWaiter)
    },
    deleteTaskWaiter(id) {
      stmtDeleteWaiter.run(id)
    },
    setTaskTerminalListener(fn) {
      taskTerminalListener = fn
    },
```

Modify `updateTaskStatus` to fire the listener on terminal status:

```ts
    updateTaskStatus(taskId, status, result) {
      const terminalStatuses = new Set(['completed', 'failed', 'interrupted', 'cancelled'])
      const endedAt = terminalStatuses.has(status) ? Date.now() : null
      stmtUpdateTask.run(status, result ? JSON.stringify(result) : null, endedAt, taskId)
      if (terminalStatuses.has(status)) taskTerminalListener?.(taskId, status)
    },
```

- [ ] **Step 6: Run the tests to verify they pass**

Run: `npm test -- src/service/conversation/store.test.ts`
Expected: PASS (all task-waiter tests plus the pre-existing store tests).

- [ ] **Step 7: Format and commit**

```bash
npx biome check --write src/service/conversation/store.ts src/service/conversation/store.test.ts
git add src/service/conversation/store.ts src/service/conversation/store.test.ts
git commit -m "feat(loop): persist task waiters and fire a task-terminal listener"
```

---

### Task 2: `TaskWaiterService`

**Files:**
- Create: `src/service/loop/task-waiters.ts`
- Test: `src/service/loop/task-waiters.test.ts`

**Interfaces:**
- Consumes: `ConversationStore` (`getTask`, `saveTaskWaiter`, `listTaskWaitersForTask`, `listAllTaskWaiters`, `deleteTaskWaiter`), `StoredTaskWaiter` (Task 1).
- Produces:
  - `type TaskWaiterDeps = { store: ConversationStore; deliver: (sessionId: string, address: string, goal: string) => void }`
  - `type TaskWaiterService = { register(input: { sessionId: string; waiterAddress: string; taskId: string; goal: string | null }): { id: string | null; firedImmediately: boolean }; onTaskTerminal(taskId: string, status: string): void; start(): void }`
  - `function createTaskWaiterService(deps: TaskWaiterDeps): TaskWaiterService`

- [ ] **Step 1: Write the failing tests**

Create `src/service/loop/task-waiters.test.ts`:

```ts
import { describe, expect, it, vi } from 'vitest'

import type { ConversationStore, StoredTaskWaiter } from '../conversation/store'
import { createTaskWaiterService } from './task-waiters'

// Minimal in-memory fake of the store surface the service uses.
function fakeStore(tasks: Record<string, { status: string } | undefined>) {
  const waiters: StoredTaskWaiter[] = []
  return {
    getTask: vi.fn((id: string) => (tasks[id] ? ({ status: tasks[id]!.status } as never) : undefined)),
    saveTaskWaiter: vi.fn((w: StoredTaskWaiter) => void waiters.push(w)),
    listTaskWaitersForTask: vi.fn((taskId: string) => waiters.filter((w) => w.taskId === taskId)),
    listAllTaskWaiters: vi.fn(() => [...waiters]),
    deleteTaskWaiter: vi.fn((id: string) => {
      const i = waiters.findIndex((w) => w.id === id)
      if (i >= 0) waiters.splice(i, 1)
    }),
    _waiters: waiters,
  } as unknown as ConversationStore & { _waiters: StoredTaskWaiter[] }
}

describe('TaskWaiterService', () => {
  it('persists a waiter when the awaited task is still pending', () => {
    const store = fakeStore({ 'task-X': { status: 'running' } })
    const deliver = vi.fn()
    const svc = createTaskWaiterService({ store, deliver })
    const res = svc.register({ sessionId: 's', waiterAddress: 'a', taskId: 'task-X', goal: null })
    expect(res.firedImmediately).toBe(false)
    expect(deliver).not.toHaveBeenCalled()
    expect(store.listTaskWaitersForTask('task-X')).toHaveLength(1)
  })

  it('fires immediately when the awaited task is already terminal', () => {
    const store = fakeStore({ 'task-X': { status: 'completed' } })
    const deliver = vi.fn()
    const svc = createTaskWaiterService({ store, deliver })
    const res = svc.register({ sessionId: 's', waiterAddress: 'a', taskId: 'task-X', goal: null })
    expect(res.firedImmediately).toBe(true)
    expect(deliver).toHaveBeenCalledWith('s', 'a', expect.stringContaining('completed'))
    expect((store as unknown as { _waiters: unknown[] })._waiters).toHaveLength(0)
  })

  it('fires immediately with a not-found message when the task is missing', () => {
    const store = fakeStore({})
    const deliver = vi.fn()
    const svc = createTaskWaiterService({ store, deliver })
    svc.register({ sessionId: 's', waiterAddress: 'a', taskId: 'gone', goal: null })
    expect(deliver).toHaveBeenCalledWith('s', 'a', expect.stringContaining('could not be found'))
  })

  it('uses the agent-supplied goal verbatim when provided', () => {
    const store = fakeStore({ 'task-X': { status: 'completed' } })
    const deliver = vi.fn()
    const svc = createTaskWaiterService({ store, deliver })
    svc.register({ sessionId: 's', waiterAddress: 'a', taskId: 'task-X', goal: 'do the next thing' })
    expect(deliver).toHaveBeenCalledWith('s', 'a', 'do the next thing')
  })

  it('delivers to all waiters and deletes them on terminal', () => {
    const store = fakeStore({ 'task-X': { status: 'running' } })
    const deliver = vi.fn()
    const svc = createTaskWaiterService({ store, deliver })
    svc.register({ sessionId: 's', waiterAddress: 'a', taskId: 'task-X', goal: null })
    svc.onTaskTerminal('task-X', 'failed')
    expect(deliver).toHaveBeenCalledWith('s', 'a', expect.stringContaining('failed'))
    expect(store.listTaskWaitersForTask('task-X')).toEqual([])
  })

  it('re-arms on start: fires for already-terminal tasks, keeps pending ones', () => {
    const store = fakeStore({ 'done-task': { status: 'completed' }, 'live-task': { status: 'running' } })
    // Seed two persisted waiters directly.
    store.saveTaskWaiter({ id: 'w1', sessionId: 's', waiterAddress: 'a', taskId: 'done-task', goal: null, createdAt: 1 })
    store.saveTaskWaiter({ id: 'w2', sessionId: 's', waiterAddress: 'b', taskId: 'live-task', goal: null, createdAt: 2 })
    const deliver = vi.fn()
    const svc = createTaskWaiterService({ store, deliver })
    svc.start()
    expect(deliver).toHaveBeenCalledTimes(1)
    expect(deliver).toHaveBeenCalledWith('s', 'a', expect.stringContaining('completed'))
    expect(store.listTaskWaitersForTask('live-task')).toHaveLength(1)
  })
})
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `npm test -- src/service/loop/task-waiters.test.ts`
Expected: FAIL — cannot find module `./task-waiters`.

- [ ] **Step 3: Implement the service**

Create `src/service/loop/task-waiters.ts`:

```ts
import { createLogger } from '@shared/logger'
import { ulid } from 'ulid'

import type { ConversationStore } from '../conversation/store'

const log = createLogger({ process: 'service' }).child({ component: 'task-waiters' })

const TERMINAL = new Set(['completed', 'failed', 'cancelled', 'interrupted'])

const completionGoal = (taskId: string, status: string) =>
  `The task you were waiting on (${taskId}) finished with status "${status}". Continue your work toward your goal.`
const notFoundGoal = (taskId: string) =>
  `The task you were waiting on (${taskId}) could not be found (it may have been removed). Decide how to proceed toward your goal.`

export type TaskWaiterDeps = {
  store: ConversationStore
  /** Wake the waiting agent's resident actor by delivering a goal to its address. */
  deliver: (sessionId: string, address: string, goal: string) => void
}

export type TaskWaiterService = {
  register(input: {
    sessionId: string
    waiterAddress: string
    taskId: string
    goal: string | null
  }): { id: string | null; firedImmediately: boolean }
  onTaskTerminal(taskId: string, status: string): void
  start(): void
}

export function createTaskWaiterService(deps: TaskWaiterDeps): TaskWaiterService {
  const { store, deliver } = deps

  // Deliver without letting one bad target abort the rest of the sweep.
  const safeDeliver = (sessionId: string, address: string, goal: string) => {
    try {
      deliver(sessionId, address, goal)
    } catch (err) {
      log.error({ msg: 'waiter deliver failed', address, err: err instanceof Error ? err.message : String(err) })
    }
  }

  return {
    register({ sessionId, waiterAddress, taskId, goal }) {
      const task = store.getTask(taskId)
      if (!task) {
        log.warn({ msg: 'wait_for_task on missing task; firing immediately', taskId, waiterAddress })
        safeDeliver(sessionId, waiterAddress, goal ?? notFoundGoal(taskId))
        return { id: null, firedImmediately: true }
      }
      if (TERMINAL.has(task.status)) {
        log.info({ msg: 'wait_for_task on already-terminal task; firing immediately', taskId, status: task.status })
        safeDeliver(sessionId, waiterAddress, goal ?? completionGoal(taskId, task.status))
        return { id: null, firedImmediately: true }
      }
      const id = ulid()
      store.saveTaskWaiter({ id, sessionId, waiterAddress, taskId, goal, createdAt: Date.now() })
      log.info({ msg: 'waiter registered', id, taskId, waiterAddress })
      return { id, firedImmediately: false }
    },

    onTaskTerminal(taskId, status) {
      const waiters = store.listTaskWaitersForTask(taskId)
      if (waiters.length === 0) return
      log.info({ msg: 'task terminal; waking waiters', taskId, status, count: waiters.length })
      for (const w of waiters) {
        safeDeliver(w.sessionId, w.waiterAddress, w.goal ?? completionGoal(taskId, status))
        store.deleteTaskWaiter(w.id)
      }
    },

    start() {
      const all = store.listAllTaskWaiters()
      for (const w of all) {
        const task = store.getTask(w.taskId)
        if (!task || TERMINAL.has(task.status)) {
          const goal = w.goal ?? (task ? completionGoal(w.taskId, task.status) : notFoundGoal(w.taskId))
          log.info({ msg: 're-arm: waiter target already resolved; firing', id: w.id, taskId: w.taskId })
          safeDeliver(w.sessionId, w.waiterAddress, goal)
          store.deleteTaskWaiter(w.id)
        }
      }
    },
  }
}
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `npm test -- src/service/loop/task-waiters.test.ts`
Expected: PASS (all six tests).

- [ ] **Step 5: Format and commit**

```bash
npx biome check --write src/service/loop/task-waiters.ts src/service/loop/task-waiters.test.ts
git add src/service/loop/task-waiters.ts src/service/loop/task-waiters.test.ts
git commit -m "feat(loop): add TaskWaiterService (register, terminal wake, re-arm)"
```

---

### Task 3: `wait_for_task` tool + builtin registration

**Files:**
- Create: `src/service/tools/wait-for-task.ts`
- Test: `src/service/tools/wait-for-task.test.ts`
- Modify: `src/service/tools/builtins.ts`

**Interfaces:**
- Consumes: `TaskWaiterService` (Task 2), `ToolRunContext` (`sessionId`, `selfAddress`), `ToolSpec`.
- Produces: `function waitForTaskSpecs(service: TaskWaiterService): ToolSpec[]`

- [ ] **Step 1: Write the failing tests**

Create `src/service/tools/wait-for-task.test.ts`:

```ts
import { describe, expect, it, vi } from 'vitest'

import type { TaskWaiterService } from '../loop/task-waiters'
import type { ToolRunContext } from './registry'
import { waitForTaskSpecs } from './wait-for-task'

const baseCtx: ToolRunContext = {
  sessionId: 'ses-1',
  taskId: 't',
  selfAddress: 'addr-A',
  spawnChild: async () => ({ childTaskId: 'c', result: { summary: '', artifacts: [] } }),
  send: () => undefined,
  requestPermission: async () => 'grant',
  sendMessage: async () => undefined,
  sendAndWait: async () => '',
  findPeers: () => [],
}

function fakeService(firedImmediately = false): TaskWaiterService {
  return {
    register: vi.fn(() => ({ id: 'w1', firedImmediately })),
    onTaskTerminal: vi.fn(),
    start: vi.fn(),
  }
}

const buildTool = (svc: TaskWaiterService, ctx: ToolRunContext) => {
  const spec = waitForTaskSpecs(svc)[0]
  return spec.build(ctx)
}

describe('wait_for_task tool', () => {
  it('registers a waiter for the calling agent address', async () => {
    const svc = fakeService(false)
    const tool = buildTool(svc, baseCtx)
    const res = (await tool.execute('1', { taskId: 'task-X' })) as { content: [{ text: string }] }
    expect(svc.register).toHaveBeenCalledWith({
      sessionId: 'ses-1',
      waiterAddress: 'addr-A',
      taskId: 'task-X',
      goal: null,
    })
    expect(res.content[0].text).toContain('waiting for task task-X')
  })

  it('passes an agent-supplied goal through', async () => {
    const svc = fakeService(false)
    const tool = buildTool(svc, baseCtx)
    await tool.execute('1', { taskId: 'task-X', goal: 'then do Y' })
    expect(svc.register).toHaveBeenCalledWith({
      sessionId: 'ses-1',
      waiterAddress: 'addr-A',
      taskId: 'task-X',
      goal: 'then do Y',
    })
  })

  it('errors when taskId is missing', async () => {
    const svc = fakeService()
    const tool = buildTool(svc, baseCtx)
    const res = (await tool.execute('1', {})) as { content: [{ text: string }] }
    expect(res.content[0].text).toContain('error')
    expect(svc.register).not.toHaveBeenCalled()
  })

  it('errors when the agent is not addressable', async () => {
    const svc = fakeService()
    const tool = buildTool(svc, { ...baseCtx, selfAddress: undefined })
    const res = (await tool.execute('1', { taskId: 'task-X' })) as { content: [{ text: string }] }
    expect(res.content[0].text).toContain('not addressable')
    expect(svc.register).not.toHaveBeenCalled()
  })
})
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `npm test -- src/service/tools/wait-for-task.test.ts`
Expected: FAIL — cannot find module `./wait-for-task`.

- [ ] **Step 3: Implement the tool**

Create `src/service/tools/wait-for-task.ts`:

```ts
import type { AgentTool } from '@earendil-works/pi-agent-core'
import { Type } from '@earendil-works/pi-ai'

import type { TaskWaiterService } from '../loop/task-waiters'
import type { ToolRunContext, ToolSpec } from './registry'

type Result = { content: [{ type: 'text'; text: string }]; details?: Record<string, unknown> }
const ok = (text: string, details: Record<string, unknown> = {}): Result => ({
  content: [{ type: 'text', text }],
  details,
})
const err = (message: string): Result => ok(`error: ${message}`, { error: message })

const WaitParams = Type.Object({
  taskId: Type.String({ description: 'Id of the task to wait for (e.g. a child task you spawned, or a peer\'s task).' }),
  goal: Type.Optional(
    Type.String({
      description:
        'Optional goal to run when the awaited task finishes. Omit to receive a default "continue your work" wake.',
    })
  ),
})

function waitForTaskTool(service: TaskWaiterService, ctx: ToolRunContext): AgentTool {
  return {
    name: 'wait_for_task',
    label: 'Wait for task',
    description:
      'Pause until another task reaches a terminal state, then wake yourself to continue. Your current turn ends after calling this; you will be re-activated when the awaited task finishes (or immediately if it has already finished). Use this to wait on a child task or a peer agent before continuing your loop.',
    parameters: WaitParams,
    execute: async (_id: string, params: unknown) => {
      const p = params as { taskId?: string; goal?: string }
      if (!p.taskId) return err('taskId is required')
      if (!ctx.selfAddress)
        return err('this agent is not addressable, so it cannot be woken later; wait_for_task is unavailable')
      const { firedImmediately } = service.register({
        sessionId: ctx.sessionId,
        waiterAddress: ctx.selfAddress,
        taskId: p.taskId,
        goal: p.goal ?? null,
      })
      return ok(
        firedImmediately
          ? `task ${p.taskId} has already finished; you will be woken immediately`
          : `waiting for task ${p.taskId}; you will be woken when it finishes`,
        { taskId: p.taskId, firedImmediately }
      )
    },
  }
}

// wait_for_task arms an autonomous continuation (a future self-wake), so it is
// medium risk like schedule_task / send_message.
export function waitForTaskSpecs(service: TaskWaiterService): ToolSpec[] {
  return [
    {
      group: 'loop',
      name: 'wait_for_task',
      risk: 'medium' as const,
      source: 'builtin' as const,
      build: (ctx) => waitForTaskTool(service, ctx),
    },
  ]
}
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `npm test -- src/service/tools/wait-for-task.test.ts`
Expected: PASS.

- [ ] **Step 5: Register the tool in builtins**

In `src/service/tools/builtins.ts`:

1. Add the import near the other tool-spec imports:

```ts
import { waitForTaskSpecs } from './wait-for-task'
```

2. Add `TaskWaiterService` to the imports and to the `deps` parameter type of `registerBuiltinTools` (mirroring how `scheduler?: CronScheduler` is declared):

```ts
import type { TaskWaiterService } from '../loop/task-waiters'
// ...in the deps object type:
    taskWaiters?: TaskWaiterService
```

3. In the body, beside the cron registration block, add:

```ts
  // wait_for_task needs the waiter service; registered only when one is injected.
  if (deps?.taskWaiters) for (const spec of waitForTaskSpecs(deps.taskWaiters)) registry.register(spec)
```

- [ ] **Step 6: Add a registration test to builtins.test.ts**

In `src/service/tools/builtins.test.ts`, add a test that mirrors the existing builtin-registration assertions:

```ts
it('registers wait_for_task when a taskWaiters service is provided', () => {
  const registry = createToolRegistry()
  registerBuiltinTools(registry, {
    taskWaiters: { register: () => ({ id: null, firedImmediately: false }), onTaskTerminal: () => {}, start: () => {} },
  })
  expect(registry.list().some((s) => s.name === 'wait_for_task')).toBe(true)
})

it('omits wait_for_task when no taskWaiters service is provided', () => {
  const registry = createToolRegistry()
  registerBuiltinTools(registry)
  expect(registry.list().some((s) => s.name === 'wait_for_task')).toBe(false)
})
```

If `createToolRegistry` / `registerBuiltinTools` are not already imported in that test file, add them to the existing import from `./builtins` and `./registry` (match the file's current imports).

- [ ] **Step 7: Run the builtins test to verify it passes**

Run: `npm test -- src/service/tools/builtins.test.ts`
Expected: PASS.

- [ ] **Step 8: Format and commit**

```bash
npx biome check --write src/service/tools/wait-for-task.ts src/service/tools/wait-for-task.test.ts src/service/tools/builtins.ts src/service/tools/builtins.test.ts
git add src/service/tools/wait-for-task.ts src/service/tools/wait-for-task.test.ts src/service/tools/builtins.ts src/service/tools/builtins.test.ts
git commit -m "feat(loop): add wait_for_task tool and register it in builtins"
```

---

### Task 4: `manager.deliverToActor` public method

**Files:**
- Modify: `src/service/session/manager.ts`
- Test: `src/service/session/manager.messaging.test.ts`

**Interfaces:**
- Consumes: existing internal `sendMessage(sessionId, from, to, payload, kind)` in `manager.ts`.
- Produces (on the `AgentManager` returned object and its interface): `deliverToActor(sessionId: string, address: string, goal: string): void`

- [ ] **Step 1: Write the failing test**

Add this test to the existing `describe('sendMessage', ...)` block in `src/service/session/manager.messaging.test.ts`. It reuses the file's existing harness (`makeManager`, `fakeProvider`, `__ensureActorForTest`, `__sendMessageForTest`, `store.nextUnconsumedFor`) and the module-level `agent-runner` mock already at the top of the file. A trailing rpc acts as a FIFO barrier: because the mailbox is single-waiter FIFO, when the rpc reply returns the earlier `send` has already been drained — making the assertion deterministic, not timing-dependent.

```ts
it('deliverToActor wakes an addressable actor (delivered and consumed)', async () => {
  const { store, mgr } = makeManager()
  const { sessionId } = mgr.createSession(fakeProvider)
  const target = (mgr as any).__ensureActorForTest(sessionId, 'default', 'b')

  mgr.deliverToActor(sessionId, target.address, 'do the next step')

  // FIFO barrier: the rpc is processed after the earlier 'send', so once its
  // reply returns, both messages have been drained.
  const res = await (mgr as any).__sendMessageForTest(sessionId, null, target.address, 'ping', 'rpc')
  expect(res.reply).toBe('ran:ping')
  expect(store.nextUnconsumedFor(target.address)).toBeUndefined()
})
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `npm test -- src/service/session/manager.messaging.test.ts`
Expected: FAIL — `manager.deliverToActor is not a function`.

- [ ] **Step 3: Implement the method**

In `src/service/session/manager.ts`:

1. Add to the `AgentManager` interface (near `submitGoal` / `startCompany`):

```ts
  /** Wake an addressable actor by delivering a goal to it (fire-and-forget, system sender). */
  deliverToActor(sessionId: string, address: string, goal: string): void
```

2. In the returned object, add the method (it wraps the existing internal `sendMessage`, using a system sender and the non-rpc `send` kind):

```ts
    deliverToActor(sessionId, address, goal) {
      void sendMessage(sessionId, 'system', address, goal, 'send')
    },
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `npm test -- src/service/session/manager.messaging.test.ts`
Expected: PASS.

- [ ] **Step 5: Format and commit**

```bash
npx biome check --write src/service/session/manager.ts src/service/session/manager.messaging.test.ts
git add src/service/session/manager.ts src/service/session/manager.messaging.test.ts
git commit -m "feat(loop): add manager.deliverToActor to wake an actor by address"
```

---

### Task 5: Wire the watcher into the service bootstrap + end-to-end integration test

**Files:**
- Modify: `src/service/index.ts`
- Test: `src/service/loop/task-waiters.integration.test.ts`

**Interfaces:**
- Consumes: `createConversationStore`, `createTaskWaiterService` (Task 2), `store.setTaskTerminalListener` (Task 1), `manager.deliverToActor` (Task 4), `registerBuiltinTools` deps (Task 3).
- Produces: a wired `taskWaiters` service available to the tool registry; store→service→deliver chain active at runtime.

- [ ] **Step 1: Write the failing integration test**

This test exercises the real store + real service joined exactly as the bootstrap joins them, with a spy `deliver` standing in for `manager.deliverToActor`.

Create `src/service/loop/task-waiters.integration.test.ts`:

```ts
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it, vi } from 'vitest'
import type { Task } from '@shared/types/task'

import { createConversationStore } from '../conversation/store'
import { createTaskWaiterService } from './task-waiters'

const tmpDb = () => join(tmpdir(), `swarm-test-${Date.now()}-${Math.random()}.db`)

const mkTask = (id: string, status: Task['status']): Task => ({
  id,
  parentId: null,
  agentDefId: 'default',
  goal: 'g',
  status,
  assignedWorkerId: null,
  toolAllowlist: [],
  budget: { tokens: 0, calls: 0, wallMs: 0, usdCents: 0 },
  used: { tokens: 0, calls: 0, wallMs: 0, usdCents: 0 },
  history: [],
  result: null,
  createdAt: Date.now(),
})

describe('task waiter integration (store ↔ service ↔ deliver)', () => {
  it('a registered waiter is woken when its awaited task goes terminal', () => {
    const store = createConversationStore(tmpDb())
    store.createSession('ses-1', { id: 'anthropic' as const, model: 'm', apiKey: 'k' })
    store.saveTask(mkTask('task-X', 'running'), 'ses-1')

    const deliver = vi.fn()
    const svc = createTaskWaiterService({ store, deliver })
    // Wire exactly as the bootstrap does:
    store.setTaskTerminalListener((taskId, status) => svc.onTaskTerminal(taskId, status))

    svc.register({ sessionId: 'ses-1', waiterAddress: 'addr-A', taskId: 'task-X', goal: null })
    expect(deliver).not.toHaveBeenCalled()

    store.updateTaskStatus('task-X', 'completed')

    expect(deliver).toHaveBeenCalledWith('ses-1', 'addr-A', expect.stringContaining('completed'))
    expect(store.listTaskWaitersForTask('task-X')).toEqual([])
    store.close()
  })
})
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `npm test -- src/service/loop/task-waiters.integration.test.ts`
Expected: PASS for the assertions only if wiring existed — but since this test wires store↔service directly it will already PASS. To make this a meaningful Task-5 gate, FIRST confirm it passes, THEN do the bootstrap wiring (Step 3) which is verified by the full suite + manual boot. (This test locks the contract that the bootstrap must reproduce.)

Run and expect: PASS.

- [ ] **Step 3: Wire it in `src/service/index.ts`**

`src/service/index.ts` already creates the `store`, `manager`, and `scheduler` (see the `createCronScheduler({ fire: ... })` block). Add, after both `store` and `manager` exist:

```ts
import { createTaskWaiterService } from './loop/task-waiters'

// ...after manager + store are constructed:
const taskWaiters = createTaskWaiterService({
  store,
  deliver: (sessionId, address, goal) => manager.deliverToActor(sessionId, address, goal),
})
store.setTaskTerminalListener((taskId, status) => taskWaiters.onTaskTerminal(taskId, status))
taskWaiters.start()
```

Then thread `taskWaiters` into the existing `registerBuiltinTools(registry, { ... })` call by adding `taskWaiters` to that deps object (alongside `scheduler`).

- [ ] **Step 4: Verify the whole suite still passes**

Run: `npm test`
Expected: PASS (full Vitest suite, no regressions).

- [ ] **Step 5: Typecheck**

Run: `npm run typecheck`
Expected: no errors.

- [ ] **Step 6: Format and commit**

```bash
npx biome check --write src/service/index.ts src/service/loop/task-waiters.integration.test.ts
git add src/service/index.ts src/service/loop/task-waiters.integration.test.ts
git commit -m "feat(loop): wire task waiter service into service bootstrap"
```

---

### Task 6: Loop-aware system prompt section

**Files:**
- Modify: `src/shared/agents/default-prompt.ts`
- Test: `src/shared/agents/default-prompt.test.ts`

**Interfaces:**
- Consumes: existing `DEFAULT_SYSTEM_PROMPT` export.
- Produces: the same export, with an "Autonomous operation" section appended.

- [ ] **Step 1: Write the failing test**

Create `src/shared/agents/default-prompt.test.ts`:

```ts
import { describe, expect, it } from 'vitest'

import { DEFAULT_SYSTEM_PROMPT } from './default-prompt'

describe('DEFAULT_SYSTEM_PROMPT loop-aware section', () => {
  it('documents the autonomous-operation conventions', () => {
    expect(DEFAULT_SYSTEM_PROMPT).toContain('Autonomous operation')
    expect(DEFAULT_SYSTEM_PROMPT).toContain('schedule_task')
    expect(DEFAULT_SYSTEM_PROMPT).toContain('wait_for_task')
    // Ending the turn is "done" — no busy-loop instruction.
    expect(DEFAULT_SYSTEM_PROMPT).toContain('end your turn')
  })
})
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `npm test -- src/shared/agents/default-prompt.test.ts`
Expected: FAIL — string `Autonomous operation` not found.

- [ ] **Step 3: Add the section to the prompt**

In `src/shared/agents/default-prompt.ts`, append this block to the `DEFAULT_SYSTEM_PROMPT` template string, immediately before the closing backtick (after the existing `Workflow:` list):

```
\n\nAutonomous operation:
  - You run toward your goal across turns. To keep working without a user message, you have these levers:
    - schedule_task: schedule your own next wake at a time or recurring interval (e.g. "come back in an hour and check progress").
    - wait_for_task: pause until another task (a child you spawned, or a peer's task) finishes, then you are woken to continue.
    - send_message / send_and_wait: hand work to, or get a result from, another agent.
  - When your goal's success criteria are met, simply end your turn. Do NOT schedule another wake or call wait_for_task — ending the turn is "done".
  - Each turn, check your progress against the goal's success criteria before deciding to continue.
  - Your budget is a finite cumulative envelope across the whole run; spend it deliberately and stop when the goal is met.
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `npm test -- src/shared/agents/default-prompt.test.ts`
Expected: PASS.

- [ ] **Step 5: Format and commit**

```bash
npx biome check --write src/shared/agents/default-prompt.ts src/shared/agents/default-prompt.test.ts
git add src/shared/agents/default-prompt.ts src/shared/agents/default-prompt.test.ts
git commit -m "feat(loop): add loop-aware autonomous-operation section to default prompt"
```

---

## Final Verification

- [ ] Run the full suite: `npm test` → PASS
- [ ] Typecheck: `npm run typecheck` → no errors
- [ ] Lint changed files: `npm run lint` → clean (or `npx biome check --write` already applied)

## Notes / Known Limitations (from the spec)

- No timeout on `wait_for_task`: a task that never reaches a terminal state leaves the waiter asleep indefinitely. Acceptable for attended/desktop use; a timeout + liveness sweep is deferred to a future unattended-operation milestone.
- The runner's budget envelope resets when a residency re-spawns from sleep, so a loop that self-schedules across sleeps has no aggregate cross-wake budget cap. Deferred.
- Webhook / file-change triggers and a generic Trigger registry are out of scope (YAGNI; cron stays as-is).
