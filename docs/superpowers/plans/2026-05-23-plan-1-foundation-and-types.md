# SwarmAgents Plan 1 — Foundation & Core Types

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Establish the multi-process substrate — shared types, IPC protocol skeleton, worker spawn/lifecycle, logging, and a permission-gate skeleton — verified by an integration test that spawns a worker, dispatches a fake task, and observes a `task.complete` IPC message.

**Architecture:** Three source areas — `src/main/` (Electron host), `src/worker/` (Node `utilityProcess` entry), `src/shared/` (cross-process contracts). Supervisor is decoupled from Electron via a `WorkerSpawner` interface so it can be unit-tested under plain Node `child_process.fork`. No LLM, no MCP, no UI changes yet.

**Tech Stack:** TypeScript 6, Electron 42, electron-vite, Vitest 1.x, Zod 3, pino 9, ulid.

**Spec reference:** [`docs/superpowers/specs/2026-05-23-swarm-agents-design.md`](../specs/2026-05-23-swarm-agents-design.md) — §2 (architecture / IPC), §3.1 (Task type), §7 (error tiers), §8 (logging).

---

### Task 1: Add dev/runtime dependencies and Vitest config

**Files:**
- Modify: `package.json`
- Create: `vitest.config.ts`

- [ ] **Step 1: Install runtime deps**

```bash
pnpm add zod pino pino-pretty ulid
```

- [ ] **Step 2: Install dev deps**

```bash
pnpm add -D vitest @types/node
```

(`@types/node` is already a devDep but pin it to the matching Node version used by Electron 42 — Node 22.)

- [ ] **Step 3: Add test scripts to `package.json`**

Edit the `scripts` block, add:

```json
"test": "vitest run",
"test:watch": "vitest"
```

Place between `check` and `typecheck:node`.

- [ ] **Step 4: Create `vitest.config.ts`**

```ts
import { defineConfig } from 'vitest/config'
import { resolve } from 'node:path'

export default defineConfig({
  test: {
    include: ['src/**/*.test.ts'],
    environment: 'node',
    testTimeout: 10_000,
    pool: 'forks', // each test file in its own subprocess — needed for worker-spawn tests
  },
  resolve: {
    alias: {
      '@shared': resolve(__dirname, 'src/shared'),
      '@main': resolve(__dirname, 'src/main'),
      '@worker': resolve(__dirname, 'src/worker'),
    },
  },
})
```

- [ ] **Step 5: Verify Vitest runs (empty pass)**

Run: `pnpm test`
Expected: "No test files found, exiting with code 0" or similar non-failing exit. If it errors, fix the config before continuing.

- [ ] **Step 6: Commit**

```bash
git add package.json pnpm-lock.yaml vitest.config.ts
git commit -m "build: add vitest, zod, pino, ulid; configure test runner"
```

---

### Task 2: Define shared `Task` and `Budget` types

**Files:**
- Create: `src/shared/types/task.ts`
- Create: `src/shared/types/task.test.ts`

- [ ] **Step 1: Write the failing test**

`src/shared/types/task.test.ts`:

```ts
import { describe, expect, it } from 'vitest'
import { TaskSchema, emptyBudget, taskStatusValues } from './task'

describe('Task types', () => {
  it('exposes the full status enum', () => {
    expect(taskStatusValues).toEqual([
      'pending', 'planning', 'dispatched', 'running',
      'awaiting_user', 'paused', 'completed', 'failed',
      'cancelled', 'interrupted',
    ])
  })

  it('emptyBudget returns zeroed counters', () => {
    expect(emptyBudget()).toEqual({ tokens: 0, calls: 0, wallMs: 0, usdCents: 0 })
  })

  it('TaskSchema accepts a minimal valid task', () => {
    const t = {
      id: '01HX0000000000000000000000',
      parentId: null,
      goal: 'do a thing',
      status: 'pending' as const,
      assignedWorkerId: null,
      toolAllowlist: ['peekaboo.*'],
      budget: { tokens: 100_000, calls: 50, wallMs: 600_000, usdCents: 200 },
      used: emptyBudget(),
      history: [],
      result: null,
      createdAt: 1700000000000,
      startedAt: null,
      endedAt: null,
    }
    expect(() => TaskSchema.parse(t)).not.toThrow()
  })

  it('TaskSchema rejects an unknown status', () => {
    const bad = { status: 'whatever' }
    expect(() => TaskSchema.parse(bad)).toThrow()
  })
})
```

- [ ] **Step 2: Run the test — expect failure**

Run: `pnpm test src/shared/types/task.test.ts`
Expected: FAIL — module `./task` does not exist.

- [ ] **Step 3: Implement `src/shared/types/task.ts`**

```ts
import { z } from 'zod'

export const taskStatusValues = [
  'pending',
  'planning',
  'dispatched',
  'running',
  'awaiting_user',
  'paused',
  'completed',
  'failed',
  'cancelled',
  'interrupted',
] as const

export const TaskStatusSchema = z.enum(taskStatusValues)
export type TaskStatus = z.infer<typeof TaskStatusSchema>

export const ResourceBudgetSchema = z.object({
  tokens: z.number().int().nonnegative(),
  calls: z.number().int().nonnegative(),
  wallMs: z.number().int().nonnegative(),
  usdCents: z.number().int().nonnegative(),
})
export type ResourceBudget = z.infer<typeof ResourceBudgetSchema>

export const emptyBudget = (): ResourceBudget => ({ tokens: 0, calls: 0, wallMs: 0, usdCents: 0 })

export const TaskEventSchema = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('llm.message'), role: z.enum(['assistant', 'user', 'tool']), content: z.unknown(), ts: z.number() }),
  z.object({ kind: z.literal('tool.call'), server: z.string(), tool: z.string(), args: z.unknown(), ts: z.number() }),
  z.object({ kind: z.literal('tool.result'), ok: z.boolean(), payload: z.unknown(), ts: z.number() }),
  z.object({ kind: z.literal('permission'), actionId: z.string(), decision: z.enum(['grant', 'deny', 'skip']), ts: z.number() }),
  z.object({ kind: z.literal('handoff'), childTaskId: z.string(), ts: z.number() }),
  z.object({ kind: z.literal('error'), error: z.object({ code: z.string(), message: z.string(), tier: z.enum(['transient', 'recoverable', 'fatal', 'gave_up']) }), ts: z.number() }),
])
export type TaskEvent = z.infer<typeof TaskEventSchema>

export const ArtifactSchema = z.object({
  kind: z.enum(['file', 'note', 'image']),
  path: z.string().optional(),
  text: z.string().optional(),
  meta: z.record(z.string(), z.unknown()).optional(),
})
export type Artifact = z.infer<typeof ArtifactSchema>

export const TaskResultSchema = z.object({
  summary: z.string(),
  artifacts: z.array(ArtifactSchema),
})
export type TaskResult = z.infer<typeof TaskResultSchema>

export const TaskSchema = z.object({
  id: z.string().length(26),
  parentId: z.string().nullable(),
  goal: z.string(),
  status: TaskStatusSchema,
  assignedWorkerId: z.string().nullable(),
  toolAllowlist: z.array(z.string()),
  budget: ResourceBudgetSchema,
  used: ResourceBudgetSchema,
  history: z.array(TaskEventSchema),
  result: TaskResultSchema.nullable(),
  createdAt: z.number(),
  startedAt: z.number().nullable(),
  endedAt: z.number().nullable(),
})
export type Task = z.infer<typeof TaskSchema>
```

- [ ] **Step 4: Run the test — expect pass**

Run: `pnpm test src/shared/types/task.test.ts`
Expected: PASS, 4 tests.

- [ ] **Step 5: Commit**

```bash
git add src/shared/types/task.ts src/shared/types/task.test.ts
git commit -m "feat(shared): add Task and ResourceBudget types with Zod schemas"
```

---

### Task 3: Define IPC protocol with Zod schemas

**Files:**
- Create: `src/shared/types/ipc.ts`
- Create: `src/shared/types/ipc.test.ts`

- [ ] **Step 1: Write the failing test**

`src/shared/types/ipc.test.ts`:

```ts
import { describe, expect, it } from 'vitest'
import { InboundSchema, OutboundSchema } from './ipc'

describe('IPC schemas', () => {
  it('accepts a task.assign message', () => {
    const msg = {
      type: 'task.assign',
      task: {
        id: '01HX0000000000000000000000',
        parentId: null,
        goal: 'g',
        status: 'dispatched',
        assignedWorkerId: 'w1',
        toolAllowlist: [],
        budget: { tokens: 0, calls: 0, wallMs: 0, usdCents: 0 },
        used: { tokens: 0, calls: 0, wallMs: 0, usdCents: 0 },
        history: [],
        result: null,
        createdAt: 1,
        startedAt: null,
        endedAt: null,
      },
      promptContext: 'hello',
    }
    expect(() => InboundSchema.parse(msg)).not.toThrow()
  })

  it('accepts a tool.call outbound', () => {
    const msg = {
      type: 'tool.call',
      callId: 'c1',
      server: 'peekaboo',
      tool: 'see',
      args: { id: 'X' },
    }
    expect(() => OutboundSchema.parse(msg)).not.toThrow()
  })

  it('accepts a heartbeat', () => {
    expect(() => OutboundSchema.parse({ type: 'heartbeat', ts: 123 })).not.toThrow()
  })

  it('accepts a task.complete', () => {
    const msg = {
      type: 'task.complete',
      taskId: '01HX0000000000000000000000',
      result: { summary: 'done', artifacts: [] },
    }
    expect(() => OutboundSchema.parse(msg)).not.toThrow()
  })

  it('rejects an unknown outbound type', () => {
    expect(() => OutboundSchema.parse({ type: 'bogus' })).toThrow()
  })
})
```

- [ ] **Step 2: Run the test — expect failure**

Run: `pnpm test src/shared/types/ipc.test.ts`
Expected: FAIL — module `./ipc` not found.

- [ ] **Step 3: Implement `src/shared/types/ipc.ts`**

```ts
import { z } from 'zod'
import { TaskEventSchema, TaskResultSchema, TaskSchema } from './task'

export const RiskSchema = z.enum(['low', 'medium', 'high'])
export type Risk = z.infer<typeof RiskSchema>

const ToolResultPayloadSchema = z.union([
  z.object({ kind: z.literal('json'), value: z.unknown() }),
  z.object({ kind: z.literal('image'), path: z.string(), w: z.number(), h: z.number(), sha: z.string() }),
  z.object({ kind: z.literal('text'), text: z.string() }),
])

const ToolResultSchema = z.union([
  z.object({ ok: z.literal(true), payload: ToolResultPayloadSchema }),
  z.object({ ok: z.literal(false), error: z.object({ code: z.string(), message: z.string() }) }),
])

const ErrorRecordSchema = z.object({
  code: z.string(),
  message: z.string(),
  tier: z.enum(['transient', 'recoverable', 'fatal', 'gave_up']),
  stack: z.string().optional(),
})

export const InboundSchema = z.discriminatedUnion('type', [
  z.object({ type: z.literal('task.assign'), task: TaskSchema, promptContext: z.string() }),
  z.object({ type: z.literal('task.cancel'), taskId: z.string() }),
  z.object({ type: z.literal('tool.result'), callId: z.string(), result: ToolResultSchema }),
  z.object({ type: z.literal('permission.decision'), actionId: z.string(), decision: z.enum(['grant', 'deny', 'skip']) }),
  z.object({ type: z.literal('shutdown') }),
])
export type Inbound = z.infer<typeof InboundSchema>

export const OutboundSchema = z.discriminatedUnion('type', [
  z.object({ type: z.literal('tool.call'), callId: z.string(), server: z.string(), tool: z.string(), args: z.unknown() }),
  z.object({
    type: z.literal('permission.request'),
    actionId: z.string(),
    risk: RiskSchema,
    summary: z.string(),
    payload: z.unknown(),
  }),
  z.object({ type: z.literal('progress'), event: TaskEventSchema }),
  z.object({ type: z.literal('task.complete'), taskId: z.string(), result: TaskResultSchema }),
  z.object({
    type: z.literal('task.handoff'),
    parentTaskId: z.string(),
    newGoal: z.string(),
    suggestedTools: z.array(z.string()).optional(),
  }),
  z.object({ type: z.literal('task.error'), taskId: z.string(), error: ErrorRecordSchema }),
  z.object({ type: z.literal('heartbeat'), ts: z.number() }),
])
export type Outbound = z.infer<typeof OutboundSchema>
```

- [ ] **Step 4: Run the test — expect pass**

Run: `pnpm test src/shared/types/ipc.test.ts`
Expected: PASS, 5 tests.

- [ ] **Step 5: Commit**

```bash
git add src/shared/types/ipc.ts src/shared/types/ipc.test.ts
git commit -m "feat(shared): add IPC protocol schemas (Inbound/Outbound)"
```

---

### Task 4: Add structured logger (pino)

**Files:**
- Create: `src/shared/logger.ts`
- Create: `src/shared/logger.test.ts`

- [ ] **Step 1: Write the failing test**

`src/shared/logger.test.ts`:

```ts
import { describe, expect, it } from 'vitest'
import { createLogger } from './logger'

describe('createLogger', () => {
  it('produces a logger that exposes info/warn/error/debug', () => {
    const log = createLogger({ process: 'test' })
    expect(typeof log.info).toBe('function')
    expect(typeof log.warn).toBe('function')
    expect(typeof log.error).toBe('function')
    expect(typeof log.debug).toBe('function')
  })

  it('returns a child logger with merged bindings', () => {
    const log = createLogger({ process: 'main' })
    const child = log.child({ workerId: 'w1' })
    expect(child.bindings()).toMatchObject({ process: 'main', workerId: 'w1' })
  })
})
```

- [ ] **Step 2: Run the test — expect failure**

Run: `pnpm test src/shared/logger.test.ts`
Expected: FAIL — module not found.

- [ ] **Step 3: Implement `src/shared/logger.ts`**

```ts
import pino, { type Logger } from 'pino'

export type LoggerBindings = {
  process: 'main' | 'worker' | 'test'
  workerId?: string
  taskId?: string
}

const isDev = process.env.NODE_ENV !== 'production'

export function createLogger(bindings: LoggerBindings): Logger {
  return pino({
    level: process.env.LOG_LEVEL ?? (isDev ? 'debug' : 'info'),
    base: bindings,
    transport: isDev
      ? { target: 'pino-pretty', options: { colorize: true, translateTime: 'HH:MM:ss.l' } }
      : undefined,
  })
}
```

- [ ] **Step 4: Run the test — expect pass**

Run: `pnpm test src/shared/logger.test.ts`
Expected: PASS, 2 tests.

- [ ] **Step 5: Commit**

```bash
git add src/shared/logger.ts src/shared/logger.test.ts
git commit -m "feat(shared): add pino-based structured logger"
```

---

### Task 5: Configure electron-vite to bundle worker entry

**Files:**
- Modify: `electron.vite.config.ts`

- [ ] **Step 1: Read current config**

Open `electron.vite.config.ts`. Current state has `main: {}` etc.

- [ ] **Step 2: Update config to add worker entry**

Replace contents with:

```ts
import { resolve } from 'path'
import { defineConfig, externalizeDepsPlugin } from 'electron-vite'
import react from '@vitejs/plugin-react'
import tailwindcss from '@tailwindcss/vite'

export default defineConfig({
  main: {
    plugins: [externalizeDepsPlugin()],
    build: {
      rollupOptions: {
        input: {
          index: resolve('src/main/index.ts'),
          worker: resolve('src/worker/index.ts'),
        },
      },
    },
    resolve: {
      alias: {
        '@shared': resolve('src/shared'),
        '@main': resolve('src/main'),
        '@worker': resolve('src/worker'),
      },
    },
  },
  preload: {
    plugins: [externalizeDepsPlugin()],
  },
  renderer: {
    resolve: {
      alias: {
        '@renderer': resolve('src/renderer/src'),
        '@shared': resolve('src/shared'),
      },
    },
    plugins: [react(), tailwindcss()],
  },
})
```

- [ ] **Step 3: Create placeholder worker file so build won't error**

Create `src/worker/index.ts`:

```ts
// Placeholder worker entry — implemented in Task 6.
console.log('[worker] boot')
```

- [ ] **Step 4: Run the build**

Run: `pnpm build`
Expected: Build completes; `out/main/index.js` and `out/main/worker.js` both exist. Verify with `ls out/main`.

- [ ] **Step 5: Commit**

```bash
git add electron.vite.config.ts src/worker/index.ts
git commit -m "build: configure electron-vite worker entry"
```

---

### Task 6: Implement worker entry — echo handler

**Files:**
- Modify: `src/worker/index.ts`
- Create: `src/worker/handler.ts`
- Create: `src/worker/handler.test.ts`

- [ ] **Step 1: Write the failing test**

`src/worker/handler.test.ts`:

```ts
import { describe, expect, it, vi } from 'vitest'
import { handleInbound } from './handler'
import type { Inbound, Outbound } from '@shared/types/ipc'

describe('worker handler (echo behavior for foundation)', () => {
  it('emits task.complete when assigned a task', () => {
    const sent: Outbound[] = []
    const send = vi.fn((m: Outbound) => sent.push(m))

    const msg: Inbound = {
      type: 'task.assign',
      task: {
        id: '01HX0000000000000000000000',
        parentId: null,
        goal: 'echo',
        status: 'dispatched',
        assignedWorkerId: 'w1',
        toolAllowlist: [],
        budget: { tokens: 0, calls: 0, wallMs: 0, usdCents: 0 },
        used: { tokens: 0, calls: 0, wallMs: 0, usdCents: 0 },
        history: [],
        result: null,
        createdAt: 1,
        startedAt: null,
        endedAt: null,
      },
      promptContext: '',
    }

    handleInbound(msg, send)
    expect(send).toHaveBeenCalled()
    const completion = sent.find((m) => m.type === 'task.complete')
    expect(completion).toBeDefined()
    if (completion?.type === 'task.complete') {
      expect(completion.taskId).toBe('01HX0000000000000000000000')
      expect(completion.result.summary).toContain('echo')
    }
  })

  it('responds to shutdown by sending no outbound', () => {
    const send = vi.fn()
    handleInbound({ type: 'shutdown' }, send)
    expect(send).not.toHaveBeenCalled()
  })
})
```

- [ ] **Step 2: Run the test — expect failure**

Run: `pnpm test src/worker/handler.test.ts`
Expected: FAIL — module `./handler` not found.

- [ ] **Step 3: Implement `src/worker/handler.ts`**

```ts
import type { Inbound, Outbound } from '@shared/types/ipc'

export type SendFn = (msg: Outbound) => void

/**
 * Foundation-plan worker handler. Echoes assigned tasks straight back as completions
 * so the supervisor + IPC layer can be verified end-to-end. Real agent loop arrives
 * in Plan 3.
 */
export function handleInbound(msg: Inbound, send: SendFn): void {
  switch (msg.type) {
    case 'task.assign':
      send({
        type: 'task.complete',
        taskId: msg.task.id,
        result: { summary: `echo: ${msg.task.goal}`, artifacts: [] },
      })
      return
    case 'task.cancel':
    case 'tool.result':
    case 'permission.decision':
    case 'shutdown':
      return
  }
}
```

- [ ] **Step 4: Run the test — expect pass**

Run: `pnpm test src/worker/handler.test.ts`
Expected: PASS, 2 tests.

- [ ] **Step 5: Wire handler into the worker entry**

Replace `src/worker/index.ts` with a transport-agnostic boot that picks Electron `MessageChannelMain` or Node `child_process` IPC at runtime. A single mutable `activePort` reference lets `send` work for both:

```ts
import { InboundSchema, type Outbound } from '@shared/types/ipc'
import { createLogger } from '@shared/logger'
import { handleInbound } from './handler'

const log = createLogger({ process: 'worker', workerId: process.env.SWARM_WORKER_ID ?? 'unknown' })

type WorkerPort = {
  postMessage: (m: unknown) => void
  start?: () => void
  addEventListener?: (e: 'message', cb: (e: MessageEvent) => void) => void
}

let activePort: WorkerPort | null = null

const send = (m: Outbound): void => {
  if (activePort) {
    activePort.postMessage(m)
    return
  }
  if (typeof process.send === 'function') {
    process.send(m)
    return
  }
  log.warn({ msg: 'no transport available to send outbound', payload: m })
}

const onMessage = (raw: unknown): void => {
  const parsed = InboundSchema.safeParse(raw)
  if (!parsed.success) {
    log.warn({ msg: 'invalid inbound message', issues: parsed.error.issues })
    return
  }
  handleInbound(parsed.data, send)
}

type ParentPort = {
  on: (e: 'message', cb: (m: { data: unknown; ports?: WorkerPort[] }) => void) => void
}
const parentPort: ParentPort | undefined =
  (process as unknown as { parentPort?: ParentPort }).parentPort

if (parentPort) {
  // Electron utilityProcess: the Electron spawner (Task 8) sends a port handoff as
  // the first message. After that, all IPC flows through that MessagePort.
  parentPort.on('message', (e) => {
    if (!activePort && e.ports?.[0]) {
      const p = e.ports[0]
      activePort = p
      p.addEventListener?.('message', (evt: MessageEvent) => onMessage(evt.data))
      p.start?.()
      return
    }
    onMessage(e.data)
  })
} else if (typeof process.on === 'function') {
  // Node-fork adapter (used by Vitest): plain `process.on('message', ...)`.
  process.on('message', onMessage)
}

// Heartbeat every 5s — Supervisor declares dead after 30s of silence.
setInterval(() => send({ type: 'heartbeat', ts: Date.now() }), 5_000).unref()

log.info('worker ready')
```

- [ ] **Step 6: Typecheck**

Run: `pnpm typecheck`
Expected: PASS.

- [ ] **Step 7: Commit**

```bash
git add src/worker/index.ts src/worker/handler.ts src/worker/handler.test.ts
git commit -m "feat(worker): echo handler + IPC wiring (parentPort + process.send)"
```

---

### Task 7: Define `WorkerSpawner` abstraction with Node-fork adapter

**Files:**
- Create: `src/main/supervisor/spawner.ts`
- Create: `src/main/supervisor/node-fork-spawner.ts`
- Create: `src/main/supervisor/node-fork-spawner.test.ts`

- [ ] **Step 1: Write the failing test**

`src/main/supervisor/node-fork-spawner.test.ts`:

```ts
import { describe, expect, it } from 'vitest'
import { resolve } from 'node:path'
import { mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { createNodeForkSpawner } from './node-fork-spawner'

describe('NodeForkSpawner', () => {
  it('spawns a process and round-trips a message', async () => {
    // Tiny fixture worker: echoes whatever it receives, exits on 'bye'.
    const dir = mkdtempSync(`${tmpdir()}/swarm-test-`)
    const fixture = resolve(dir, 'echo-worker.cjs')
    writeFileSync(
      fixture,
      `process.on('message', (m) => { if (m === 'bye') process.exit(0); process.send({ echoed: m }); });`,
    )

    const spawner = createNodeForkSpawner()
    const handle = spawner.spawn({ entry: fixture, workerId: 'w-test' })

    const received: unknown[] = []
    handle.onMessage((m) => received.push(m))

    handle.send('hello')
    await new Promise((r) => setTimeout(r, 100))

    expect(received).toEqual([{ echoed: 'hello' }])

    handle.send('bye')
    const exitCode = await handle.exited
    expect(exitCode).toBe(0)
  })
})
```

- [ ] **Step 2: Run the test — expect failure**

Run: `pnpm test src/main/supervisor/node-fork-spawner.test.ts`
Expected: FAIL — module not found.

- [ ] **Step 3: Implement `src/main/supervisor/spawner.ts`**

```ts
export type SpawnOptions = {
  entry: string         // absolute path to worker entry file
  workerId: string
  env?: Record<string, string>
}

export type WorkerHandle = {
  workerId: string
  send: (msg: unknown) => void
  onMessage: (cb: (msg: unknown) => void) => void
  onExit: (cb: (code: number | null) => void) => void
  kill: () => void
  exited: Promise<number | null>
}

export type WorkerSpawner = {
  spawn(opts: SpawnOptions): WorkerHandle
}
```

- [ ] **Step 4: Implement `src/main/supervisor/node-fork-spawner.ts`**

```ts
import { fork } from 'node:child_process'
import type { SpawnOptions, WorkerHandle, WorkerSpawner } from './spawner'

export function createNodeForkSpawner(): WorkerSpawner {
  return {
    spawn(opts: SpawnOptions): WorkerHandle {
      const child = fork(opts.entry, [], {
        env: { ...process.env, SWARM_WORKER_ID: opts.workerId, ...opts.env },
        serialization: 'advanced',
        silent: false,
      })
      const messageCbs: Array<(m: unknown) => void> = []
      const exitCbs: Array<(code: number | null) => void> = []
      child.on('message', (m) => {
        for (const cb of messageCbs) cb(m)
      })
      const exited = new Promise<number | null>((resolve) => {
        child.on('exit', (code) => {
          for (const cb of exitCbs) cb(code)
          resolve(code)
        })
      })
      return {
        workerId: opts.workerId,
        send: (m) => child.send(m),
        onMessage: (cb) => {
          messageCbs.push(cb)
        },
        onExit: (cb) => {
          exitCbs.push(cb)
        },
        kill: () => {
          child.kill('SIGTERM')
        },
        exited,
      }
    },
  }
}
```

- [ ] **Step 5: Run the test — expect pass**

Run: `pnpm test src/main/supervisor/node-fork-spawner.test.ts`
Expected: PASS, 1 test.

- [ ] **Step 6: Commit**

```bash
git add src/main/supervisor/spawner.ts src/main/supervisor/node-fork-spawner.ts src/main/supervisor/node-fork-spawner.test.ts
git commit -m "feat(supervisor): WorkerSpawner abstraction + Node-fork adapter"
```

---

### Task 8: Implement Electron `utilityProcess` spawner adapter

**Files:**
- Create: `src/main/supervisor/electron-spawner.ts`

(No unit test — `utilityProcess` requires an Electron runtime, exercised in dev/manual verification.)

- [ ] **Step 1: Implement `src/main/supervisor/electron-spawner.ts`**

```ts
import { utilityProcess, MessageChannelMain } from 'electron'
import type { SpawnOptions, WorkerHandle, WorkerSpawner } from './spawner'

export function createElectronSpawner(): WorkerSpawner {
  return {
    spawn(opts: SpawnOptions): WorkerHandle {
      const { port1, port2 } = new MessageChannelMain()
      const child = utilityProcess.fork(opts.entry, [], {
        serviceName: opts.workerId,
        env: { ...process.env, SWARM_WORKER_ID: opts.workerId, ...opts.env },
      })

      // Hand port2 to the child as its IPC transport.
      child.postMessage('init-port', [port2])

      const messageCbs: Array<(m: unknown) => void> = []
      const exitCbs: Array<(code: number | null) => void> = []
      port1.on('message', (e) => {
        for (const cb of messageCbs) cb(e.data)
      })
      port1.start()

      const exited = new Promise<number | null>((resolve) => {
        child.on('exit', (code) => {
          for (const cb of exitCbs) cb(code)
          resolve(code)
        })
      })

      return {
        workerId: opts.workerId,
        send: (m) => port1.postMessage(m),
        onMessage: (cb) => {
          messageCbs.push(cb)
        },
        onExit: (cb) => {
          exitCbs.push(cb)
        },
        kill: () => {
          child.kill()
        },
        exited,
      }
    },
  }
}
```

- [ ] **Step 2: Verify the worker entry already supports the Electron transport**

The worker entry written in Task 6 Step 5 already detects `process.parentPort` and consumes the MessageChannelMain port handoff. No changes needed here — re-read `src/worker/index.ts` to confirm the `if (parentPort)` branch is in place.

- [ ] **Step 3: Typecheck**

Run: `pnpm typecheck`
Expected: PASS.

- [ ] **Step 4: Smoke check the build**

Run: `pnpm build`
Expected: Build completes; `out/main/worker.js` updated.

- [ ] **Step 5: Commit**

```bash
git add src/main/supervisor/electron-spawner.ts
git commit -m "feat(supervisor): Electron utilityProcess spawner"
```

---

### Task 9: Implement `WorkerSupervisor` (pool, lifecycle, message routing)

**Files:**
- Create: `src/main/supervisor/index.ts`
- Create: `src/main/supervisor/index.test.ts`

- [ ] **Step 1: Write the failing test**

`src/main/supervisor/index.test.ts`:

```ts
import { describe, expect, it } from 'vitest'
import { resolve } from 'node:path'
import { mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { createNodeForkSpawner } from './node-fork-spawner'
import { createSupervisor } from './index'
import type { Task } from '@shared/types/task'

function buildEchoFixture(): string {
  const dir = mkdtempSync(`${tmpdir()}/swarm-supervisor-`)
  const fixture = resolve(dir, 'echo-worker.cjs')
  writeFileSync(
    fixture,
    `
process.on('message', (m) => {
  if (m && m.type === 'task.assign') {
    process.send({ type: 'task.complete', taskId: m.task.id, result: { summary: 'echo:' + m.task.goal, artifacts: [] } });
  }
  if (m && m.type === 'shutdown') process.exit(0);
});
setInterval(() => process.send({ type: 'heartbeat', ts: Date.now() }), 1000).unref();
    `,
  )
  return fixture
}

const mkTask = (id: string, goal: string): Task => ({
  id, parentId: null, goal,
  status: 'dispatched',
  assignedWorkerId: null,
  toolAllowlist: [],
  budget: { tokens: 0, calls: 0, wallMs: 0, usdCents: 0 },
  used: { tokens: 0, calls: 0, wallMs: 0, usdCents: 0 },
  history: [], result: null,
  createdAt: Date.now(), startedAt: null, endedAt: null,
})

describe('WorkerSupervisor', () => {
  it('dispatches a task to an idle worker and receives completion', async () => {
    const entry = buildEchoFixture()
    const sup = createSupervisor({
      spawner: createNodeForkSpawner(),
      workerEntry: entry,
      poolSize: 1,
    })

    const completed: string[] = []
    sup.on('task.complete', (taskId) => completed.push(taskId))

    await sup.start()
    const t = mkTask('01HX0000000000000000000001', 'hello')
    sup.dispatch(t)

    await new Promise((r) => setTimeout(r, 300))
    expect(completed).toContain('01HX0000000000000000000001')

    await sup.shutdown()
  })

  it('queues tasks when all workers are busy and drains them', async () => {
    const entry = buildEchoFixture()
    const sup = createSupervisor({
      spawner: createNodeForkSpawner(),
      workerEntry: entry,
      poolSize: 1,
    })
    const completed: string[] = []
    sup.on('task.complete', (taskId) => completed.push(taskId))

    await sup.start()
    sup.dispatch(mkTask('01HX0000000000000000000001', 'a'))
    sup.dispatch(mkTask('01HX0000000000000000000002', 'b'))
    sup.dispatch(mkTask('01HX0000000000000000000003', 'c'))

    await new Promise((r) => setTimeout(r, 800))
    expect(completed.sort()).toEqual([
      '01HX0000000000000000000001',
      '01HX0000000000000000000002',
      '01HX0000000000000000000003',
    ])

    await sup.shutdown()
  })

  it('replaces a worker whose heartbeat goes silent', async () => {
    // Fixture: a worker that *never* sends a heartbeat. Supervisor watchdog
    // should declare it dead and respawn it; subsequent dispatch should land
    // on the replacement and complete.
    const dir = mkdtempSync(`${tmpdir()}/swarm-silent-`)
    const fixture = resolve(dir, 'silent-then-echo.cjs')
    writeFileSync(
      fixture,
      `
process.on('message', (m) => {
  if (m && m.type === 'task.assign') {
    process.send({ type: 'task.complete', taskId: m.task.id, result: { summary: 'ok', artifacts: [] } });
  }
  if (m && m.type === 'shutdown') process.exit(0);
});
// No heartbeat. Spawn-time only. Supervisor must detect via watchdog.
      `,
    )

    const sup = createSupervisor({
      spawner: createNodeForkSpawner(),
      workerEntry: fixture,
      poolSize: 1,
      heartbeatTimeoutMs: 150,
      watchdogIntervalMs: 50,
    })

    const errors: Array<{ taskId: string; err: unknown }> = []
    sup.on('task.error', (taskId, err) => errors.push({ taskId, err }))
    const completed: string[] = []
    sup.on('task.complete', (taskId) => completed.push(taskId))

    await sup.start()
    // Wait long enough for the watchdog to trip and a new worker to be born.
    await new Promise((r) => setTimeout(r, 400))

    sup.dispatch(mkTask('01HX0000000000000000000099', 'after-respawn'))
    await new Promise((r) => setTimeout(r, 300))

    expect(completed).toContain('01HX0000000000000000000099')

    await sup.shutdown()
  })
})
```

- [ ] **Step 2: Run the test — expect failure**

Run: `pnpm test src/main/supervisor/index.test.ts`
Expected: FAIL — module not found.

- [ ] **Step 3: Implement `src/main/supervisor/index.ts`**

```ts
import { EventEmitter } from 'node:events'
import { ulid } from 'ulid'
import { createLogger } from '@shared/logger'
import { OutboundSchema, type Inbound, type Outbound } from '@shared/types/ipc'
import type { Task } from '@shared/types/task'
import type { WorkerHandle, WorkerSpawner } from './spawner'

export type SupervisorConfig = {
  spawner: WorkerSpawner
  workerEntry: string
  poolSize: number
  /** ms of heartbeat absence before declaring a worker dead. Default 30_000. */
  heartbeatTimeoutMs?: number
  /** ms between watchdog checks. Default 5_000. */
  watchdogIntervalMs?: number
}

type Slot = {
  handle: WorkerHandle
  state: 'idle' | 'busy' | 'dead'
  currentTaskId: string | null
  lastHeartbeat: number
}

type SupervisorEvents = {
  'task.complete': (taskId: string, result: Outbound & { type: 'task.complete' }) => void
  'task.error': (taskId: string, error: unknown) => void
  'progress': (taskId: string, event: Outbound & { type: 'progress' }) => void
}

export type Supervisor = {
  start(): Promise<void>
  dispatch(task: Task): void
  shutdown(): Promise<void>
  on<K extends keyof SupervisorEvents>(event: K, cb: SupervisorEvents[K]): void
}

export function createSupervisor(cfg: SupervisorConfig): Supervisor {
  const log = createLogger({ process: 'main' }).child({ component: 'supervisor' })
  const ee = new EventEmitter()
  const slots: Slot[] = []
  const queue: Task[] = []
  let shuttingDown = false

  const send = (slot: Slot, msg: Inbound): void => slot.handle.send(msg)

  const tryDispatchNext = (): void => {
    if (shuttingDown) return
    if (queue.length === 0) return
    const slot = slots.find((s) => s.state === 'idle')
    if (!slot) return
    const task = queue.shift() as Task
    slot.state = 'busy'
    slot.currentTaskId = task.id
    log.info({ msg: 'dispatching', taskId: task.id, workerId: slot.handle.workerId })
    send(slot, { type: 'task.assign', task, promptContext: '' })
  }

  const handleOutbound = (slot: Slot, raw: unknown): void => {
    const parsed = OutboundSchema.safeParse(raw)
    if (!parsed.success) {
      log.warn({ msg: 'invalid outbound', issues: parsed.error.issues })
      return
    }
    const m = parsed.data
    switch (m.type) {
      case 'heartbeat':
        slot.lastHeartbeat = m.ts
        return
      case 'task.complete':
        log.info({ msg: 'task complete', taskId: m.taskId })
        slot.state = 'idle'
        slot.currentTaskId = null
        ee.emit('task.complete', m.taskId, m)
        tryDispatchNext()
        return
      case 'task.error':
        log.error({ msg: 'task error', taskId: m.taskId, error: m.error })
        slot.state = 'idle'
        slot.currentTaskId = null
        ee.emit('task.error', m.taskId, m.error)
        tryDispatchNext()
        return
      case 'progress':
        if (slot.currentTaskId) ee.emit('progress', slot.currentTaskId, m)
        return
      // tool.call / permission.request / task.handoff handled in later plans
      default:
        log.debug({ msg: 'unhandled outbound (foundation plan)', type: m.type })
    }
  }

  const spawnSlot = (): Slot => {
    const workerId = `w-${ulid()}`
    const handle = cfg.spawner.spawn({ entry: cfg.workerEntry, workerId })
    const slot: Slot = { handle, state: 'idle', currentTaskId: null, lastHeartbeat: Date.now() }
    handle.onMessage((m) => handleOutbound(slot, m))
    handle.onExit((code) => {
      log.warn({ msg: 'worker exited', workerId, code })
      slot.state = 'dead'
    })
    return slot
  }

  const replaceSlot = (slot: Slot, reason: string): void => {
    log.warn({ msg: 'replacing worker', workerId: slot.handle.workerId, reason })
    const orphanedTaskId = slot.currentTaskId
    try {
      slot.handle.kill()
    } catch (e) {
      log.debug({ msg: 'kill threw (worker may already be dead)', err: String(e) })
    }
    const idx = slots.indexOf(slot)
    if (idx >= 0) slots[idx] = spawnSlot()
    if (orphanedTaskId) {
      ee.emit('task.error', orphanedTaskId, {
        code: 'worker_died',
        message: `worker replaced: ${reason}`,
        tier: 'fatal',
      })
    }
    tryDispatchNext()
  }

  const watchdogTimeout = cfg.heartbeatTimeoutMs ?? 30_000
  const watchdogInterval = cfg.watchdogIntervalMs ?? 5_000
  let watchdog: NodeJS.Timeout | null = null

  const tickWatchdog = (): void => {
    const now = Date.now()
    for (const slot of slots) {
      if (slot.state === 'dead') continue
      if (now - slot.lastHeartbeat > watchdogTimeout) {
        replaceSlot(slot, `heartbeat absent for ${now - slot.lastHeartbeat}ms`)
      }
    }
  }

  return {
    async start(): Promise<void> {
      for (let i = 0; i < cfg.poolSize; i++) slots.push(spawnSlot())
      // Wait one tick so child IPC pipes are ready before any dispatch.
      await new Promise((r) => setImmediate(r))
      watchdog = setInterval(tickWatchdog, watchdogInterval)
      watchdog.unref?.()
      log.info({ msg: 'supervisor started', poolSize: cfg.poolSize })
    },
    dispatch(task: Task): void {
      if (shuttingDown) throw new Error('supervisor is shutting down')
      queue.push(task)
      tryDispatchNext()
    },
    async shutdown(): Promise<void> {
      shuttingDown = true
      if (watchdog) {
        clearInterval(watchdog)
        watchdog = null
      }
      for (const s of slots) {
        if (s.state !== 'dead') s.handle.send({ type: 'shutdown' })
      }
      await Promise.all(slots.map((s) => s.handle.exited))
      log.info('supervisor shut down')
    },
    on(event, cb): void {
      ee.on(event, cb as (...args: unknown[]) => void)
    },
  }
}
```

- [ ] **Step 4: Run the test — expect pass**

Run: `pnpm test src/main/supervisor/index.test.ts`
Expected: PASS, 3 tests.

- [ ] **Step 5: Commit**

```bash
git add src/main/supervisor/index.ts src/main/supervisor/index.test.ts
git commit -m "feat(supervisor): pool, queue, lifecycle, watchdog, outbound routing"
```

---

### Task 10: Implement skeleton `PermissionGate`

**Files:**
- Create: `src/main/permission/gate.ts`
- Create: `src/main/permission/gate.test.ts`

- [ ] **Step 1: Write the failing test**

`src/main/permission/gate.test.ts`:

```ts
import { describe, expect, it } from 'vitest'
import { createPermissionGate } from './gate'

describe('PermissionGate (skeleton — no UI yet)', () => {
  it('low-risk requests are auto-granted', async () => {
    const gate = createPermissionGate({ defaultPolicy: 'prompt-on-medium-and-high' })
    const decision = await gate.evaluate({
      taskId: 't1',
      actionId: 'a1',
      risk: 'low',
      summary: 'reading screen',
      payload: {},
    })
    expect(decision).toBe('grant')
  })

  it('medium-risk requests await an external decision callback', async () => {
    const gate = createPermissionGate({ defaultPolicy: 'prompt-on-medium-and-high' })
    gate.setPromptHandler(async () => 'grant')
    const decision = await gate.evaluate({
      taskId: 't1',
      actionId: 'a2',
      risk: 'medium',
      summary: 'click button',
      payload: {},
    })
    expect(decision).toBe('grant')
  })

  it('high-risk denial is honored', async () => {
    const gate = createPermissionGate({ defaultPolicy: 'prompt-on-medium-and-high' })
    gate.setPromptHandler(async () => 'deny')
    const decision = await gate.evaluate({
      taskId: 't1',
      actionId: 'a3',
      risk: 'high',
      summary: 'quit app',
      payload: {},
    })
    expect(decision).toBe('deny')
  })

  it('throws if prompt handler is required but unset', async () => {
    const gate = createPermissionGate({ defaultPolicy: 'prompt-on-medium-and-high' })
    await expect(
      gate.evaluate({ taskId: 't1', actionId: 'a4', risk: 'medium', summary: 's', payload: {} }),
    ).rejects.toThrow(/no prompt handler/i)
  })
})
```

- [ ] **Step 2: Run the test — expect failure**

Run: `pnpm test src/main/permission/gate.test.ts`
Expected: FAIL — module not found.

- [ ] **Step 3: Implement `src/main/permission/gate.ts`**

```ts
import type { Risk } from '@shared/types/ipc'

export type PermissionRequest = {
  taskId: string
  actionId: string
  risk: Risk
  summary: string
  payload: unknown
}

export type PermissionDecision = 'grant' | 'deny' | 'skip'

export type PromptHandler = (req: PermissionRequest) => Promise<PermissionDecision>

export type GateConfig = {
  defaultPolicy: 'allow-all' | 'prompt-on-medium-and-high' | 'deny-all'
}

export type PermissionGate = {
  evaluate(req: PermissionRequest): Promise<PermissionDecision>
  setPromptHandler(h: PromptHandler): void
}

export function createPermissionGate(cfg: GateConfig): PermissionGate {
  let promptHandler: PromptHandler | null = null

  return {
    setPromptHandler(h) {
      promptHandler = h
    },
    async evaluate(req) {
      if (cfg.defaultPolicy === 'allow-all') return 'grant'
      if (cfg.defaultPolicy === 'deny-all') return 'deny'
      // prompt-on-medium-and-high
      if (req.risk === 'low') return 'grant'
      if (!promptHandler) throw new Error('no prompt handler registered for non-low-risk request')
      return promptHandler(req)
    },
  }
}
```

- [ ] **Step 4: Run the test — expect pass**

Run: `pnpm test src/main/permission/gate.test.ts`
Expected: PASS, 4 tests.

- [ ] **Step 5: Commit**

```bash
git add src/main/permission/gate.ts src/main/permission/gate.test.ts
git commit -m "feat(permission): skeleton gate with prompt handler indirection"
```

---

### Task 11: Wire supervisor + gate into Main process boot

**Files:**
- Modify: `src/main/index.ts`

- [ ] **Step 1: Read current `src/main/index.ts`**

Open and inspect; it currently boots a `BrowserWindow` and registers `ipcMain.on('ping')`. We are not changing window behavior — only adding a supervisor and gate that boot alongside the window so subsequent plans have an entry point.

- [ ] **Step 2: Add supervisor and gate boot**

In `src/main/index.ts`:

a) Add these new imports at the top (the file already imports `join` from `path` — do **not** duplicate it):

```ts
import { cpus } from 'node:os'
import { createLogger } from '@shared/logger'
import { createPermissionGate } from './permission/gate'
import { createSupervisor } from './supervisor'
import { createElectronSpawner } from './supervisor/electron-spawner'
```

b) Change the existing `app.whenReady().then(() => {` callback to `async () => {` so we can `await supervisor.start()`.

c) Inside that callback, **after** `electronApp.setAppUserModelId('com.electron')` and **before** `createWindow()`, insert:

```ts
const log = createLogger({ process: 'main' })
const poolSize = Math.min(cpus().length, 4)
const workerEntry = join(__dirname, 'worker.js')

const supervisor = createSupervisor({
  spawner: createElectronSpawner(),
  workerEntry,
  poolSize,
})
const permissionGate = createPermissionGate({ defaultPolicy: 'prompt-on-medium-and-high' })

await supervisor.start()
log.info({ msg: 'core services up', poolSize, workerEntry })

// Stash on globalThis for renderer-IPC handlers added in later plans.
;(globalThis as unknown as { __swarm: unknown }).__swarm = { supervisor, permissionGate }

app.on('before-quit', async () => {
  await supervisor.shutdown()
})
```

- [ ] **Step 3: Typecheck**

Run: `pnpm typecheck`
Expected: PASS. If `await` complaints, ensure the outer callback is `async`.

- [ ] **Step 4: Run the dev app — manual smoke test**

Run: `pnpm dev`
Expected:
- App window opens (no regression in the existing UI)
- In the terminal, structured log lines: `[main] supervisor started poolSize=N`, plus periodic `worker ready` lines from each spawned worker
- Close the app cleanly; you should see `supervisor shut down`

If any of the above fails, fix before committing.

- [ ] **Step 5: Commit**

```bash
git add src/main/index.ts
git commit -m "feat(main): boot supervisor and permission gate at app start"
```

---

### Task 12: Add `pnpm verify` aggregate script

**Files:**
- Modify: `package.json`

- [ ] **Step 1: Add aggregate script**

In `package.json` `scripts`, add (after `test:watch`):

```json
"verify": "pnpm run typecheck && pnpm run lint && pnpm run test"
```

- [ ] **Step 2: Run it**

Run: `pnpm verify`
Expected: typecheck PASS, lint clean (or only existing warnings), tests PASS.

If lint complains about new files (Biome import ordering, etc.), run `pnpm run check` once and re-commit any auto-fixes.

- [ ] **Step 3: Commit**

```bash
git add package.json
git commit -m "build: add verify script (typecheck + lint + test)"
```

---

## Plan 1 — Verification Checklist

When all tasks are complete, the following must hold:

- [ ] `pnpm verify` exits zero
- [ ] `pnpm dev` opens the existing app window and logs `supervisor started poolSize=<N>` plus per-worker `worker ready` lines
- [ ] `pnpm build` produces both `out/main/index.js` and `out/main/worker.js`
- [ ] Test files exist for: task types, IPC schemas, logger, worker handler, node-fork spawner, supervisor (including watchdog), permission gate
- [ ] No `// TODO` / `// TBD` / placeholder strings in committed source

If anything in this list fails, stop and fix before declaring the plan complete.

---

## Out of scope for Plan 1 (deferred to later plans)

- LLM provider integration (Plan 3)
- MCP Registry and Peekaboo wiring (Plan 2)
- Orchestrator and handoff logic (Plan 4)
- Persistence — SQLite, sessions directory, events.jsonl (Plan 5)
- UI changes — Cluster Overview, Task Timeline, Permission Sheet (Plan 6)
- Onboarding wizard, settings, Keychain (Plan 7)
- Signing, notarization, auto-update (Plan 8)
