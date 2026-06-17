# utilityProcess Transport Migration Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace the Main↔Service transport (localhost HTTP + SSE + stdout port handshake) with Electron's `utilityProcess` + `parentPort.postMessage`, keeping all business logic untouched.

**Architecture:** The Service is forked via `utilityProcess.fork` instead of `child_process.fork`. Main↔Service speak a tiny JSON RPC over the built-in `parentPort` channel: `{kind:'request', id, method, args}` → `{kind:'response', id, ok, result|error}`, plus unsolicited `{kind:'event', event, data}` and a one-shot `{kind:'ready'}`. The `ServiceClient` public interface and `SessionManager`'s `broadcast(event,data)` interface are preserved, so `swarm-ipc.ts`, `agent-runner.ts`, `session-manager.ts` business logic, `conversation-store.ts`, and `tools/*` do not change.

**Tech Stack:** Electron 42 (`utilityProcess`, `process.parentPort`), TypeScript, Vitest, electron-vite.

**Key constraint:** `utilityProcess` and `process.parentPort` exist ONLY inside a real Electron main process. The test suite runs under `ELECTRON_RUN_AS_NODE=1` (node mode) where neither exists. Therefore the two entry files (`src/main/index.ts`, `src/service/index.ts`) are thin wiring verified by RUNNING THE APP, not by unit tests — exactly as today (neither has a unit test now). All testable logic lives in `dispatcher.ts`, `broadcaster.ts`, and `service-client.ts`, which are transport-agnostic and unit-tested with in-memory fakes.

**Scope note — intentional drops:** The HTTP design exposed `/health`, `GET /events` (SSE), and `DELETE /sessions/:id` (endSession). None are called by `ServiceClient` (the only client). They are dropped: readiness is now the `ready` message; events flow over `parentPort`; `endSession` stays on `SessionManager` but loses its unused transport route. `cancelTask` remains a no-op returning `{ok:true}`, matching current `server.ts:82-86`.

---

## File Structure

**New files:**
- `src/shared/types/service-ipc.ts` — RPC message shapes + `ServiceMethod` union, shared by both sides (DRY, prevents drift).
- `src/service/broadcaster.ts` — sink-based event broadcaster (replaces `sse.ts`).
- `src/service/dispatcher.ts` — pure `(method, args) => result` request router (replaces `server.ts`).
- `src/service/broadcaster.test.ts`, `src/service/dispatcher.test.ts` — unit tests.

**Rewritten files:**
- `src/service/index.ts` — wires `parentPort` ↔ dispatcher + broadcaster; sends `ready`.
- `src/main/service-client.ts` — RPC over a `ServiceTransport` instead of HTTP/SSE.
- `src/main/service-client.test.ts` — tests against an in-memory mock transport.
- `src/main/index.ts` — `utilityProcess.fork` + ready handshake + passes the child as transport.

**Touched (1-2 lines):**
- `src/service/session-manager.ts` — type import `SseBroadcaster`→`Broadcaster`.
- `src/service/session-manager.test.ts` — `createSseBroadcaster()`→`createBroadcaster()` (12 sites + import).

**Deleted:**
- `src/service/sse.ts`, `src/service/sse.test.ts`, `src/service/server.ts`, `src/service/server.test.ts`.

**Verified unchanged:** `src/main/ipc/swarm-ipc.ts`, `src/main/ipc/forward-event.ts` (+test), `src/service/agent-runner.ts`, `src/service/conversation-store.ts`, `src/service/tools/*`, `electron.vite.config.ts` (service entry path `src/service/index.ts` → `out/main/service.js` is unchanged).

---

## Task 1: Shared RPC protocol types

**Files:**
- Create: `src/shared/types/service-ipc.ts`

- [ ] **Step 1: Create the protocol types**

```typescript
// src/shared/types/service-ipc.ts
//
// Wire protocol for the Main <-> Service utilityProcess channel.
// Main sends ServiceRequest; Service replies with ServiceResponse (matched by
// `id`), pushes ServiceEvent unsolicited, and sends one ServiceReady at boot.

export type ServiceMethod =
  | 'createSession'
  | 'submitGoal'
  | 'listSessions'
  | 'getSessionTasks'
  | 'decidePermission'
  | 'cancelTask'

export type ServiceRequest = {
  kind: 'request'
  id: number
  method: ServiceMethod
  args: unknown[]
}

export type ServiceResponse =
  | { kind: 'response'; id: number; ok: true; result: unknown }
  | { kind: 'response'; id: number; ok: false; error: string }

export type ServiceEvent = {
  kind: 'event'
  event: string
  data: unknown
}

export type ServiceReady = { kind: 'ready' }

export type MainToService = ServiceRequest
export type ServiceToMain = ServiceResponse | ServiceEvent | ServiceReady
```

- [ ] **Step 2: Typecheck (additive — nothing else references it yet)**

Run: `pnpm run typecheck:node`
Expected: PASS

- [ ] **Step 3: Commit**

```bash
git add src/shared/types/service-ipc.ts
git commit -m "feat(service): add Main<->Service RPC protocol types"
```

---

## Task 2: Service side — broadcaster, dispatcher, parentPort entry

This task makes the Service speak `parentPort` instead of HTTP. It replaces `sse.ts`+`server.ts`, rewires `index.ts`, and renames the broadcaster type used by `session-manager`. After this task the service `*.test.ts` suite is green and `typecheck:node` passes (Main still uses the old HTTP client, which is untouched until Task 3).

**Files:**
- Create: `src/service/broadcaster.ts`, `src/service/broadcaster.test.ts`
- Create: `src/service/dispatcher.ts`, `src/service/dispatcher.test.ts`
- Rewrite: `src/service/index.ts`
- Modify: `src/service/session-manager.ts:13,29`, `src/service/session-manager.test.ts`
- Delete: `src/service/sse.ts`, `src/service/sse.test.ts`, `src/service/server.ts`, `src/service/server.test.ts`

- [ ] **Step 1: Write the failing broadcaster test**

```typescript
// src/service/broadcaster.test.ts
import { describe, it, expect, vi } from 'vitest'
import { createBroadcaster } from './broadcaster'

describe('broadcaster', () => {
  it('forwards broadcasts to the sink', () => {
    const sink = vi.fn()
    const b = createBroadcaster(sink)
    b.broadcast('task.complete', { taskId: 'x' })
    expect(sink).toHaveBeenCalledWith('task.complete', { taskId: 'x' })
  })

  it('defaults to a no-op sink', () => {
    const b = createBroadcaster()
    expect(() => b.broadcast('task.progress', { taskId: 'y' })).not.toThrow()
  })
})
```

- [ ] **Step 2: Run it to verify it fails**

Run: `pnpm test src/service/broadcaster.test.ts`
Expected: FAIL — cannot resolve `./broadcaster`.

- [ ] **Step 3: Create the broadcaster**

```typescript
// src/service/broadcaster.ts
//
// Fans task/session events out to a single sink. Under utilityProcess that
// sink is `parentPort.postMessage`; in tests it's a spy. Replaces the old
// SSE-client-set broadcaster — there is exactly one consumer (the parent),
// so no client registry is needed.

export type EventSink = (event: string, data: unknown) => void

export type Broadcaster = {
  broadcast(event: string, data: unknown): void
}

export function createBroadcaster(sink: EventSink = () => {}): Broadcaster {
  return {
    broadcast(event, data) {
      sink(event, data)
    },
  }
}
```

- [ ] **Step 4: Run the broadcaster test — green**

Run: `pnpm test src/service/broadcaster.test.ts`
Expected: PASS (2 tests)

- [ ] **Step 5: Write the failing dispatcher test**

```typescript
// src/service/dispatcher.test.ts
import { describe, it, expect, vi } from 'vitest'
import { createDispatcher } from './dispatcher'
import type { SessionManager } from './session-manager'

function mockManager(): SessionManager {
  return {
    createSession: vi.fn().mockReturnValue({ sessionId: 'ses-1' }),
    submitGoal: vi.fn().mockReturnValue({ taskId: 'task-1' }),
    resolvePermission: vi.fn(),
    endSession: vi.fn(),
    listSessions: vi.fn().mockReturnValue([{ id: 'ses-1' }]),
    getSessionTasks: vi.fn().mockReturnValue([]),
  } as unknown as SessionManager
}

describe('dispatcher', () => {
  it('createSession registers the provider then creates a session', () => {
    const manager = mockManager()
    const registerProvider = vi.fn()
    const dispatch = createDispatcher({ manager, registerProvider })
    const provider = { id: 'anthropic', model: 'claude-haiku-4-5', apiKey: 'k' }
    const result = dispatch('createSession', [provider])
    expect(registerProvider).toHaveBeenCalledWith(provider)
    expect(result).toEqual({ sessionId: 'ses-1' })
  })

  it('submitGoal forwards to the manager', () => {
    const manager = mockManager()
    const dispatch = createDispatcher({ manager, registerProvider: vi.fn() })
    const result = dispatch('submitGoal', ['ses-1', 'do it'])
    expect(manager.submitGoal).toHaveBeenCalledWith('ses-1', 'do it')
    expect(result).toEqual({ taskId: 'task-1' })
  })

  it('decidePermission routes to resolvePermission and returns ok', () => {
    const manager = mockManager()
    const dispatch = createDispatcher({ manager, registerProvider: vi.fn() })
    const result = dispatch('decidePermission', ['ses-1', 'act-1', 'grant'])
    expect(manager.resolvePermission).toHaveBeenCalledWith('ses-1', 'act-1', 'grant')
    expect(result).toEqual({ ok: true })
  })

  it('listSessions / getSessionTasks read through to the manager', () => {
    const manager = mockManager()
    const dispatch = createDispatcher({ manager, registerProvider: vi.fn() })
    expect(dispatch('listSessions', [])).toEqual([{ id: 'ses-1' }])
    expect(dispatch('getSessionTasks', ['ses-1'])).toEqual([])
  })

  it('cancelTask is a no-op returning ok', () => {
    const dispatch = createDispatcher({ manager: mockManager(), registerProvider: vi.fn() })
    expect(dispatch('cancelTask', ['ses-1', 'task-1'])).toEqual({ ok: true })
  })

  it('throws on an unknown method', () => {
    const dispatch = createDispatcher({ manager: mockManager(), registerProvider: vi.fn() })
    expect(() => dispatch('nope' as never, [])).toThrow(/unknown method/)
  })
})
```

- [ ] **Step 6: Run it to verify it fails**

Run: `pnpm test src/service/dispatcher.test.ts`
Expected: FAIL — cannot resolve `./dispatcher`.

- [ ] **Step 7: Create the dispatcher**

```typescript
// src/service/dispatcher.ts
//
// Pure request router. Maps a (method, args) RPC pair to a SessionManager
// call and returns a JSON-serialisable result. Replaces the URL/method
// matching that lived in the HTTP server. No transport, no I/O — trivially
// unit-testable.

import type { ProviderInjection } from '@shared/types/provider'
import type { ServiceMethod } from '@shared/types/service-ipc'
import type { PermissionDecision } from '@shared/types/ui'
import type { SessionManager } from './session-manager'

type DispatcherConfig = {
  manager: SessionManager
  registerProvider(provider: ProviderInjection): void
}

export type Dispatcher = (method: ServiceMethod, args: unknown[]) => unknown

export function createDispatcher(cfg: DispatcherConfig): Dispatcher {
  const { manager, registerProvider } = cfg
  return (method, args) => {
    switch (method) {
      case 'createSession': {
        const [provider] = args as [ProviderInjection]
        registerProvider(provider)
        return manager.createSession(provider)
      }
      case 'submitGoal': {
        const [sessionId, goal] = args as [string, string]
        return manager.submitGoal(sessionId, goal)
      }
      case 'listSessions':
        return manager.listSessions()
      case 'getSessionTasks': {
        const [sessionId] = args as [string]
        return manager.getSessionTasks(sessionId)
      }
      case 'decidePermission': {
        const [sessionId, actionId, decision] = args as [string, string, PermissionDecision]
        manager.resolvePermission(sessionId, actionId, decision)
        return { ok: true }
      }
      case 'cancelTask':
        // Parity with the old HTTP route: acknowledged, not yet wired to a
        // real cancellation path in SessionManager.
        return { ok: true }
      default:
        throw new Error(`unknown method: ${String(method)}`)
    }
  }
}
```

- [ ] **Step 8: Run the dispatcher test — green**

Run: `pnpm test src/service/dispatcher.test.ts`
Expected: PASS (6 tests)

- [ ] **Step 9: Update `session-manager.ts` to the renamed broadcaster type**

In `src/service/session-manager.ts`, line 13:
```typescript
import type { SseBroadcaster } from './sse'
```
becomes:
```typescript
import type { Broadcaster } from './broadcaster'
```
And line 29:
```typescript
  broadcaster: SseBroadcaster
```
becomes:
```typescript
  broadcaster: Broadcaster
```

- [ ] **Step 10: Update `session-manager.test.ts` to the renamed factory**

In `src/service/session-manager.test.ts`, change the import (line 7):
```typescript
import { createSseBroadcaster } from './sse'
```
to:
```typescript
import { createBroadcaster } from './broadcaster'
```
Then replace every `createSseBroadcaster()` call with `createBroadcaster()` (12 sites). Sed:
```bash
sed -i '' 's/createSseBroadcaster()/createBroadcaster()/g' src/service/session-manager.test.ts
```

- [ ] **Step 11: Rewrite the service entry to use `parentPort`**

Replace the entire contents of `src/service/index.ts` with:
```typescript
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createLogger } from '@shared/logger'
import type { ProviderInjection } from '@shared/types/provider'
import type { ServiceRequest } from '@shared/types/service-ipc'

import { createBroadcaster } from './broadcaster'
import { createConversationStore } from './conversation-store'
import { createDispatcher } from './dispatcher'
import { createMemoryStore } from './memory-store'
import { createSessionManager } from './session-manager'
import { registerBuiltinTools } from './tools/builtins'
import { createToolRegistry } from './tools/registry'

const log = createLogger({ process: 'service' }).child({ component: 'index' })

// `process.parentPort` is injected by Electron only when this module runs as a
// utilityProcess. We type it locally so the service build stays decoupled from
// Electron's type package (it builds under the node tsconfig).
type ParentPort = {
  on(channel: 'message', listener: (e: { data: unknown }) => void): void
  postMessage(message: unknown): void
}
const parentPort = (process as unknown as { parentPort?: ParentPort }).parentPort
if (!parentPort) {
  log.error({ msg: 'no parentPort — service must be launched as a utilityProcess' })
  process.exit(1)
}

const dbPath = process.env.SWARM_SERVICE_DB_PATH ?? join(tmpdir(), 'swarm-agent-service.db')
const memoryPath = process.env.SWARM_SERVICE_MEMORY_PATH ?? join(tmpdir(), 'swarm-agent-memory.json')

const store = createConversationStore(dbPath)
const memoryStore = createMemoryStore(memoryPath)
const broadcaster = createBroadcaster((event, data) => parentPort.postMessage({ kind: 'event', event, data }))

const toolRegistry = createToolRegistry()
registerBuiltinTools(toolRegistry, { memoryStore })

const providerRegistry = new Map<string, ProviderInjection>()

const manager = createSessionManager({
  store,
  broadcaster,
  maxConcurrent: 4,
  getProvider: (key) => providerRegistry.get(key),
  toolRegistry,
})

const dispatch = createDispatcher({
  manager,
  registerProvider: (provider) => {
    providerRegistry.set(provider.id, provider)
  },
})

parentPort.on('message', async (e) => {
  const msg = e.data as ServiceRequest
  if (msg?.kind !== 'request') return
  try {
    const result = await dispatch(msg.method, msg.args)
    parentPort.postMessage({ kind: 'response', id: msg.id, ok: true, result })
  } catch (err) {
    parentPort.postMessage({ kind: 'response', id: msg.id, ok: false, error: String(err) })
  }
})

parentPort.postMessage({ kind: 'ready' })
log.info({ msg: 'service started', dbPath })

process.on('exit', () => store.close())
```

- [ ] **Step 12: Delete the dead HTTP/SSE files**

```bash
git rm src/service/sse.ts src/service/sse.test.ts src/service/server.ts src/service/server.test.ts
```

- [ ] **Step 13: Run the full service test suite + node typecheck**

Run: `pnpm test src/service && pnpm run typecheck:node`
Expected: PASS. (`typecheck:node` still green because `src/main/service-client.ts` — old HTTP client — is unchanged and self-consistent; `src/main/index.ts` still calls it the old way.)

- [ ] **Step 14: Commit**

```bash
git add -A src/service src/shared
git commit -m "feat(service): speak parentPort RPC instead of HTTP/SSE

Replace sse.ts (SSE client set) with a sink-based broadcaster and server.ts
(HTTP router) with a pure dispatcher. Wire service/index.ts to process.parentPort.
Drops unused /health, /events, DELETE routes."
```

---

## Task 3: Main side — transport client + utilityProcess entry

Rewrites `ServiceClient` to talk RPC over a `ServiceTransport`, and `main/index.ts` to fork via `utilityProcess` and pass the child as that transport. The `ServiceClient` exported type is preserved, so `swarm-ipc.ts` is untouched. After this task `pnpm verify` passes.

**Files:**
- Rewrite: `src/main/service-client.ts`, `src/main/service-client.test.ts`
- Rewrite: `src/main/index.ts:1,45-96,118-119`

- [ ] **Step 1: Rewrite the ServiceClient test against an in-memory transport**

Replace the entire contents of `src/main/service-client.test.ts` with:
```typescript
import { describe, it, expect } from 'vitest'
import { createServiceClient, type ServiceTransport } from './service-client'

function mockTransport() {
  const listeners = new Set<(m: unknown) => void>()
  const posted: Array<{ kind: string; id: number; method: string; args: unknown[] }> = []
  const t = {
    posted,
    postMessage(m: unknown) {
      posted.push(m as (typeof posted)[number])
    },
    on(_c: 'message', l: (m: unknown) => void) {
      listeners.add(l)
    },
    off(_c: 'message', l: (m: unknown) => void) {
      listeners.delete(l)
    },
    fire(m: unknown) {
      for (const l of listeners) l(m)
    },
  }
  return t as ServiceTransport & typeof t
}

describe('ServiceClient', () => {
  it('createSession posts a request and resolves with the response result', async () => {
    const t = mockTransport()
    const client = createServiceClient({ transport: t })
    await client.connect()
    const p = client.createSession({ id: 'anthropic', model: 'claude-haiku-4-5', apiKey: 'k' })
    const req = t.posted.at(-1)!
    expect(req).toMatchObject({ kind: 'request', method: 'createSession' })
    t.fire({ kind: 'response', id: req.id, ok: true, result: { sessionId: 'ses-42' } })
    expect((await p).sessionId).toBe('ses-42')
  })

  it('rejects when the service returns ok:false', async () => {
    const t = mockTransport()
    const client = createServiceClient({ transport: t })
    await client.connect()
    const p = client.submitGoal('ses-1', 'go')
    const req = t.posted.at(-1)!
    t.fire({ kind: 'response', id: req.id, ok: false, error: 'boom' })
    await expect(p).rejects.toThrow('boom')
  })

  it('forwards events to onEvent', async () => {
    const received: Array<{ e: string; d: unknown }> = []
    const t = mockTransport()
    const client = createServiceClient({ transport: t, onEvent: (e, d) => received.push({ e, d }) })
    await client.connect()
    t.fire({ kind: 'event', event: 'task.complete', data: { taskId: 'x' } })
    expect(received).toEqual([{ e: 'task.complete', d: { taskId: 'x' } }])
  })

  it('stops forwarding after disconnect', async () => {
    const received: unknown[] = []
    const t = mockTransport()
    const client = createServiceClient({ transport: t, onEvent: (e, d) => received.push({ e, d }) })
    await client.connect()
    client.disconnect()
    t.fire({ kind: 'event', event: 'task.progress', data: {} })
    expect(received).toHaveLength(0)
  })
})
```

- [ ] **Step 2: Run it to verify it fails**

Run: `pnpm test src/main/service-client.test.ts`
Expected: FAIL — `createServiceClient` does not accept `{ transport }` / no `ServiceTransport` export.

- [ ] **Step 3: Rewrite the ServiceClient over a transport**

Replace the entire contents of `src/main/service-client.ts` with:
```typescript
import { createLogger } from '@shared/logger'
import type { ProviderInjection } from '@shared/types/provider'
import type { ServiceMethod, ServiceToMain } from '@shared/types/service-ipc'
import type { PermissionDecision } from '@shared/types/ui'

const log = createLogger({ process: 'main' }).child({ component: 'service-client' })

// Minimal duplex channel the client needs. Electron's UtilityProcess satisfies
// this structurally (postMessage + EventEmitter on/off); tests pass a fake.
export type ServiceTransport = {
  postMessage(message: unknown): void
  on(channel: 'message', listener: (message: unknown) => void): void
  off(channel: 'message', listener: (message: unknown) => void): void
}

type ServiceClientConfig = {
  transport: ServiceTransport
  onEvent?: (event: string, data: unknown) => void
}

export type ServiceClient = {
  connect(): Promise<void>
  disconnect(): void
  createSession(provider: ProviderInjection): Promise<{ sessionId: string }>
  submitGoal(sessionId: string, goal: string): Promise<{ taskId: string }>
  listSessions(): Promise<import('@shared/types/ui').SessionSummary[]>
  getSessionTasks(sessionId: string): Promise<import('@shared/types/task').Task[]>
  decidePermission(sessionId: string, actionId: string, decision: PermissionDecision): Promise<void>
  cancelTask(sessionId: string, taskId: string): Promise<void>
}

export function createServiceClient(cfg: ServiceClientConfig): ServiceClient {
  const { transport, onEvent } = cfg
  let nextId = 1
  const pending = new Map<number, { resolve: (v: unknown) => void; reject: (e: unknown) => void }>()
  let listener: ((message: unknown) => void) | null = null

  const handle = (message: unknown): void => {
    const msg = message as ServiceToMain
    if (msg.kind === 'response') {
      const p = pending.get(msg.id)
      if (!p) {
        log.warn({ msg: 'response for unknown request id', id: msg.id })
        return
      }
      pending.delete(msg.id)
      if (msg.ok) p.resolve(msg.result)
      else p.reject(new Error(msg.error))
    } else if (msg.kind === 'event') {
      if (onEvent) onEvent(msg.event, msg.data)
    }
  }

  function call<T>(method: ServiceMethod, args: unknown[]): Promise<T> {
    const id = nextId++
    return new Promise<T>((resolve, reject) => {
      pending.set(id, { resolve: resolve as (v: unknown) => void, reject })
      transport.postMessage({ kind: 'request', id, method, args })
    })
  }

  return {
    connect() {
      listener = handle
      transport.on('message', listener)
      return Promise.resolve()
    },
    disconnect() {
      if (listener) transport.off('message', listener)
      listener = null
    },
    createSession(provider) {
      return call('createSession', [provider])
    },
    submitGoal(sessionId, goal) {
      return call('submitGoal', [sessionId, goal])
    },
    listSessions() {
      return call('listSessions', [])
    },
    getSessionTasks(sessionId) {
      return call('getSessionTasks', [sessionId])
    },
    async decidePermission(sessionId, actionId, decision) {
      await call('decidePermission', [sessionId, actionId, decision])
    },
    async cancelTask(sessionId, taskId) {
      await call('cancelTask', [sessionId, taskId])
    },
  }
}
```

- [ ] **Step 4: Run the ServiceClient test — green**

Run: `pnpm test src/main/service-client.test.ts`
Expected: PASS (4 tests)

- [ ] **Step 5: Rewrite `main/index.ts` to fork via utilityProcess**

In `src/main/index.ts`, change the import on line 1:
```typescript
import { fork } from 'node:child_process'
```
to:
```typescript
import { app, BrowserWindow, dialog, ipcMain, utilityProcess } from 'electron'
```
and DELETE the existing `import { app, BrowserWindow, dialog, ipcMain } from 'electron'` line (line 5) — it is merged into the import above. (Keep all other imports as-is.)

Then replace the block from line 45 (`const serviceEntry = ...`) through line 96 (the `}` closing the `catch`) with:
```typescript
  const serviceEntry = join(__dirname, 'service.js')
  const serviceProcess = utilityProcess.fork(serviceEntry, [], {
    stdio: ['ignore', 'inherit', 'pipe'],
    env: {
      ...process.env,
      SWARM_SERVICE_DB_PATH: join(app.getPath('userData'), 'agent-service.db'),
      SWARM_SERVICE_MEMORY_PATH: join(app.getPath('userData'), 'agent-memory.json'),
    },
  })

  let serviceClient: ReturnType<typeof createServiceClient>
  try {
    serviceProcess.stderr?.on('data', (c: Buffer) => log.warn({ msg: 'service stderr', data: c.toString().trim() }))

    await new Promise<void>((resolve, reject) => {
      const timeout = setTimeout(() => reject(new Error('service startup timeout')), 10_000)
      const onReady = (message: unknown): void => {
        if ((message as { kind?: string })?.kind === 'ready') {
          clearTimeout(timeout)
          serviceProcess.off('message', onReady)
          resolve()
        }
      }
      serviceProcess.on('message', onReady)
      serviceProcess.once('exit', (code) => {
        clearTimeout(timeout)
        reject(new Error(`service exited with code ${String(code)}`))
      })
    })

    serviceClient = createServiceClient({
      transport: serviceProcess as unknown as import('./service-client').ServiceTransport,
      onEvent: (event, data) => {
        const payload = toRendererEvent(event, data)
        for (const w of BrowserWindow.getAllWindows()) {
          if (!w.isDestroyed()) w.webContents.send('swarm:event', payload)
        }
      },
    })
    await serviceClient.connect()

    wireSwarmIpc({ serviceClient, providers: providers.service })
    log.info({ msg: 'core services up' })
  } catch (err) {
    log.error({ msg: 'Agent Service failed to start', err: String(err) })
    serviceProcess.kill()
    dialog.showErrorBox('Agent Service failed', String(err))
    app.quit()
    return
  }
```

Then update the teardown block (originally lines 117-120):
```typescript
  app.on('before-quit', () => {
    serviceClient.disconnect()
    serviceProcess.kill('SIGTERM')
  })
```
to:
```typescript
  app.on('before-quit', () => {
    serviceClient.disconnect()
    serviceProcess.kill()
  })
```

- [ ] **Step 6: Typecheck both projects**

Run: `pnpm run typecheck`
Expected: PASS. If the `serviceProcess as unknown as ServiceTransport` cast errors on the `import(...)` form, hoist `import type { ServiceTransport } from './service-client'` to the top of the file and cast to the bare name.

- [ ] **Step 7: Commit**

```bash
git add src/main
git commit -m "feat(main): fork the service as a utilityProcess, talk RPC over parentPort

ServiceClient now speaks postMessage RPC over a ServiceTransport instead of
HTTP/SSE; main/index.ts forks via utilityProcess.fork and waits for a ready
message instead of parsing a port from stdout."
```

---

## Task 4: Full verification + app smoke test

The entry wiring (both `index.ts` files) has no unit coverage by design, so this task verifies it by running the real app.

**Files:** none modified.

- [ ] **Step 1: Run the full verification gate**

Run: `pnpm run verify`
Expected: PASS — typecheck (node + web), lint, full vitest suite, native-feel check. Confirm no test still imports `./sse`, `./server`, or constructs `createServiceClient({ port })`.

- [ ] **Step 2: Confirm the production build emits the service entry**

Run: `pnpm run build`
Expected: PASS. Confirm `out/main/service.js` exists (the utilityProcess entry). The vite config's `service: resolve('src/service/index.ts')` input is unchanged, so this should require no config edit.

```bash
ls -la out/main/service.js
```

- [ ] **Step 3: Launch the app and drive an end-to-end task**

Use the `run-desktop` skill to build, launch, and screenshot the app. Then:
1. Confirm the window opens and the renderer loads (no "Agent Service failed" dialog — that proves fork + ready handshake worked).
2. With a provider API key configured in Settings, create a session and submit a goal.
3. Confirm streaming progress appears token-by-token in the conversation thread (proves `event` messages flow Service → parentPort → renderer).
4. Confirm the task reaches `completed` (proves `agent_end` → `task.complete` → SSE-equivalent path).
5. Check the dev log (`~/Library/Application Support/<app>/swarm-dev.log` or `SWARM_LOG_FILE`) for `service started` and absence of `parentPort` / `worker has exited` errors.

Expected: a goal submitted from the UI streams output and completes, identical to pre-migration behavior.

- [ ] **Step 4: Final commit (if any incidental fixes were needed during smoke test)**

```bash
git add -A
git commit -m "chore: verify utilityProcess migration end-to-end"
```

---

## Self-Review

**Spec coverage:**
- Fork via utilityProcess → Task 3 Step 5. ✅
- parentPort RPC (request/response) → Tasks 1, 2 (service), 3 (client). ✅
- Events over parentPort → Task 2 (broadcaster sink → `kind:'event'`), Task 3 (client routes to onEvent). ✅
- Ready handshake replaces stdout port → Task 2 Step 11 (`postMessage({kind:'ready'})`), Task 3 Step 5 (waits for it). ✅
- Business logic untouched → only `session-manager.ts` type rename touched; `swarm-ipc.ts`, `agent-runner.ts`, `conversation-store.ts`, `tools/*` not in any task. ✅
- Tests for testable units → broadcaster, dispatcher, service-client all have failing-first tests. ✅
- Entry wiring verified by running the app → Task 4 Step 3. ✅

**Placeholder scan:** No TBD/TODO/"handle errors" — every code step shows full content. ✅

**Type consistency:** `ServiceMethod`, `ServiceRequest`, `ServiceResponse`, `ServiceEvent`, `ServiceToMain` defined in Task 1 and used verbatim in Tasks 2-3. `Broadcaster`/`createBroadcaster`, `Dispatcher`/`createDispatcher`, `ServiceTransport`/`createServiceClient` names match across definition and use. Method-name strings in `service-client.ts` (`'createSession'`, etc.) are constrained by the `ServiceMethod` union and match the dispatcher's `switch` cases. ✅

## Risks (verify during execution)

1. **`utilityProcess` stdio shape** — `stdio: ['ignore','inherit','pipe']` recited from Electron docs. If `serviceProcess.stderr` is undefined at runtime, adjust the stdio array (index 0 must be `'ignore'`; stdin is unsupported).
2. **UtilityProcess → ServiceTransport structural cast** — `on('message', listener)` delivers the message data directly (not a `MessageEvent`); the service side unwraps `e.data` because `parentPort` wraps it, but the Main side (`UtilityProcess`) does not. The client's `handle` is written for the un-wrapped form. If events arrive as `{data: ...}` on Main, unwrap in the `onEvent` adapter.
3. **`pino` worker transport** — must NOT run inside the utilityProcess. Already mitigated: `logger.ts:16-24` uses a synchronous multistream. Do not reintroduce a worker transport.
