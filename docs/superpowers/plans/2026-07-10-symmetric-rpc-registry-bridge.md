# Symmetric RPC + Registry-Routed Bridge Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Collapse the duplicate `request`/`mainRequest` RPC pair into one symmetric `request`/`response` protocol, and make the WS host bridge route responses precisely to the peer connection that asked for them (a registry lookup) instead of broadcasting to every connected peer and relying on id-collision-avoidance to filter.

**Architecture:** Extract a new, direction-neutral `createRpcPeer` primitive (own `pending` map for outbound `call()`, own `handlers` map + optional `defaultHandler` fallback for inbound `request` dispatch) into `@swarm/protocol`. Both main and the service process instantiate it — main via the existing `createServiceClient` (now a thin typed wrapper over `createRpcPeer`), the service process directly. `mainRequest`/`mainResponse` are retired; every RPC call, in either direction, is a `request`/`response`. The WS host (`apps/desktop/src/main/host`) gains a `ConnRegistry` shared across all peer connections: a peer's outbound `request` claims its id's `connId` prefix; a `response` is only ever forwarded to the peer that claimed the matching `connId`. A `request` the service itself emits (a call to a main-only method) is never forwarded to any peer — it was never claimed by one.

**Tech Stack:** TypeScript, vitest, Electron `utilityProcess`/`parentPort`, `ws` (WebSocket server), pnpm workspaces (`@swarm/protocol`, `@swarm/desktop`).

## Global Constraints

- Desktop tests MUST run via `npm test` inside `apps/desktop` (Electron-as-node runner), never bare `npx vitest` from the repo root — the `@` alias and native-module ABI only resolve correctly that way.
- `packages/protocol` stays logger-free (no pino dependency) so it remains portable across desktop/extension/RN — no `createLogger` imports in `rpc-peer.ts` or `service-client.ts`.
- Every renamed/removed exported symbol must be re-checked against ALL its consumers before moving to the next task (see per-task "Files" lists — they are exhaustive for that symbol, found via repo-wide grep during planning).
- Pre-commit hook runs `biome check --write --staged` + `pnpm run typecheck` — a failing typecheck aborts the commit; do not bypass with `--no-verify`.
- Run this whole plan in a dedicated git worktree per `CLAUDE.md` §6 ("Use Worktrees for Feature Work") — it touches the core RPC layer every feature depends on.

---

### Task 1: Add the `createRpcPeer` primitive

**Files:**
- Create: `packages/protocol/src/rpc-peer.ts`
- Test: `packages/protocol/src/rpc-peer.test.ts`

**Interfaces:**
- Produces: `RpcTransport` (structurally identical to today's `ServiceTransport`: `postMessage`/`on`/`off`), `RpcMessage` (discriminated union: `request`/`response`/`event`/`ready`), `RpcHandler = (...args: unknown[]) => Promise<unknown> | unknown`, `RpcPeerConfig = { transport: RpcTransport; onEvent?: (event: string, data: unknown) => void; defaultHandler?: (method: string, args: unknown[], id: string) => Promise<unknown> | unknown }`, `RpcPeer = { connect(): Promise<void>; disconnect(): void; call<T>(method: string, args: unknown[]): Promise<T>; registerHandler(method: string, fn: RpcHandler): void }`, and the factory `createRpcPeer(cfg: RpcPeerConfig): RpcPeer`. Later tasks import all of these from `./rpc-peer` (and, once Task 4 lands, from `@swarm/protocol`).

- [ ] **Step 1: Write the failing test**

Create `packages/protocol/src/rpc-peer.test.ts`:

```typescript
import { describe, expect, it, vi } from 'vitest'

import { createRpcPeer } from './rpc-peer'

function fakeTransport() {
  const listeners = new Set<(m: unknown) => void>()
  const posted: unknown[] = []
  return {
    posted,
    postMessage(m: unknown) {
      posted.push(m)
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
}

describe('createRpcPeer', () => {
  it('call() posts a request and resolves on the matching response', async () => {
    const t = fakeTransport()
    const peer = createRpcPeer({ transport: t })
    await peer.connect()
    const p = peer.call('listAgents', [])
    const req = t.posted.at(-1) as { kind: string; id: string; method: string }
    expect(req).toMatchObject({ kind: 'request', method: 'listAgents' })
    t.fire({ kind: 'response', id: req.id, ok: true, result: ['ceo'] })
    await expect(p).resolves.toEqual(['ceo'])
  })

  it('call() rejects on an ok:false response', async () => {
    const t = fakeTransport()
    const peer = createRpcPeer({ transport: t })
    await peer.connect()
    const p = peer.call('submitGoal', ['s1', 'go'])
    const req = t.posted.at(-1) as { id: string }
    t.fire({ kind: 'response', id: req.id, ok: false, error: 'boom' })
    await expect(p).rejects.toThrow('boom')
  })

  it('dispatches an incoming request to a registered handler and posts the result', async () => {
    const t = fakeTransport()
    const peer = createRpcPeer({ transport: t })
    await peer.connect()
    const handler = vi.fn(async (a: number, b: number) => a + b)
    peer.registerHandler('add', handler as (...args: unknown[]) => Promise<unknown>)

    t.fire({ kind: 'request', id: 'x:1', method: 'add', args: [2, 3] })
    await Promise.resolve()
    await Promise.resolve()

    expect(handler).toHaveBeenCalledWith(2, 3)
    expect(t.posted).toContainEqual({ kind: 'response', id: 'x:1', ok: true, result: 5 })
  })

  it('falls back to defaultHandler when no per-method handler is registered', async () => {
    const t = fakeTransport()
    const defaultHandler = vi.fn(async (method: string, args: unknown[]) => ({ method, args }))
    const peer = createRpcPeer({ transport: t, defaultHandler })
    await peer.connect()

    t.fire({ kind: 'request', id: 'x:1', method: 'anything', args: [1] })
    await Promise.resolve()
    await Promise.resolve()

    expect(defaultHandler).toHaveBeenCalledWith('anything', [1], 'x:1')
    expect(t.posted).toContainEqual({
      kind: 'response',
      id: 'x:1',
      ok: true,
      result: { method: 'anything', args: [1] },
    })
  })

  it('posts an error response when neither a handler nor defaultHandler exists', async () => {
    const t = fakeTransport()
    const peer = createRpcPeer({ transport: t })
    await peer.connect()

    t.fire({ kind: 'request', id: 'x:1', method: 'ghost', args: [] })
    await Promise.resolve()
    await Promise.resolve()

    expect(t.posted).toContainEqual({ kind: 'response', id: 'x:1', ok: false, error: 'no handler for ghost' })
  })

  it('forwards event messages to onEvent', async () => {
    const t = fakeTransport()
    const received: Array<{ e: string; d: unknown }> = []
    const peer = createRpcPeer({ transport: t, onEvent: (e, d) => received.push({ e, d }) })
    await peer.connect()
    t.fire({ kind: 'event', event: 'run.progress', data: { runId: 'r1' } })
    expect(received).toEqual([{ e: 'run.progress', d: { runId: 'r1' } }])
  })

  it('two peers sharing one transport never collide on id even from 1', async () => {
    const t = fakeTransport()
    const peerA = createRpcPeer({ transport: t })
    const peerB = createRpcPeer({ transport: t })
    await peerA.connect()
    await peerB.connect()
    const pA = peerA.call('m', [])
    const pB = peerB.call('m', [])
    const idA = (t.posted[0] as { id: string }).id
    const idB = (t.posted[1] as { id: string }).id
    expect(idA).not.toBe(idB)
    t.fire({ kind: 'response', id: idA, ok: true, result: 'A' })
    t.fire({ kind: 'response', id: idB, ok: true, result: 'B' })
    await expect(pA).resolves.toBe('A')
    await expect(pB).resolves.toBe('B')
  })
})
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd packages/protocol && npx vitest run src/rpc-peer.test.ts`
Expected: FAIL — `Cannot find module './rpc-peer'` (the file doesn't exist yet).

- [ ] **Step 3: Write the implementation**

Create `packages/protocol/src/rpc-peer.ts`:

```typescript
// Symmetric request/response/event peer over a duplex message transport.
// Both ends of a channel (main<->service, or an external peer<->service over
// the WS bridge) instantiate one of these: either side can call() a method
// the other side registered via registerHandler(), and receives unsolicited
// event pushes via onEvent. There is no fixed "client" or "server" role —
// whoever registers a handler for a method answers it, regardless of which
// side initiated the underlying connection.
export type RpcTransport = {
  postMessage(message: unknown): void
  on(channel: 'message', listener: (message: unknown) => void): void
  off(channel: 'message', listener: (message: unknown) => void): void
}

export type RpcMessage =
  | { kind: 'request'; id: string; method: string; args: unknown[] }
  | { kind: 'response'; id: string; ok: true; result: unknown }
  | { kind: 'response'; id: string; ok: false; error: string }
  | { kind: 'event'; event: string; data: unknown }
  | { kind: 'ready' }

export type RpcHandler = (...args: unknown[]) => Promise<unknown> | unknown

export type RpcPeerConfig = {
  transport: RpcTransport
  onEvent?: (event: string, data: unknown) => void
  // Fallback invoked when no per-method handler was registered via
  // registerHandler. Lets a side with a large existing method table (the
  // service process's ~50 ServiceMethods) plug in as one function instead of
  // calling registerHandler once per method. Receives the request id too, so
  // callers can log/correlate exactly like the old per-request dispatcher did.
  defaultHandler?: (method: string, args: unknown[], id: string) => Promise<unknown> | unknown
}

export type RpcPeer = {
  connect(): Promise<void>
  disconnect(): void
  call<T>(method: string, args: unknown[]): Promise<T>
  registerHandler(method: string, fn: RpcHandler): void
}

// Every peer instance numbers its own outbound calls from 1, but replies
// broadcast over a transport that may be shared with other peers (see
// bridge.ts) — so a bare number can collide between two different callers'
// in-flight requests. Prefixing with a per-instance random tag makes ids
// collision-free without requiring any caller to know who else shares the
// channel.
const randomConnId = (): string => `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`

export function createRpcPeer(cfg: RpcPeerConfig): RpcPeer {
  const { transport, onEvent, defaultHandler } = cfg
  const connId = randomConnId()
  let nextId = 1
  const pending = new Map<string, { resolve: (v: unknown) => void; reject: (e: unknown) => void }>()
  const handlers = new Map<string, RpcHandler>()
  let listener: ((message: unknown) => void) | null = null

  const respond = (id: string, work: Promise<unknown>): void => {
    work.then(
      (result) => transport.postMessage({ kind: 'response', id, ok: true, result }),
      (err: unknown) => {
        const message = err instanceof Error ? err.message : String(err)
        transport.postMessage({ kind: 'response', id, ok: false, error: message })
      }
    )
  }

  const handle = (message: unknown): void => {
    const msg = message as RpcMessage
    if (msg.kind === 'response') {
      const p = pending.get(msg.id)
      if (!p) return // foreign id — another peer's in-flight call sharing this transport. Drop.
      pending.delete(msg.id)
      if (msg.ok) p.resolve(msg.result)
      else p.reject(new Error(msg.error))
    } else if (msg.kind === 'event') {
      onEvent?.(msg.event, msg.data)
    } else if (msg.kind === 'request') {
      const handler = handlers.get(msg.method)
      const work = handler
        ? Promise.resolve().then(() => handler(...msg.args))
        : defaultHandler
          ? Promise.resolve().then(() => defaultHandler(msg.method, msg.args, msg.id))
          : Promise.reject(new Error(`no handler for ${msg.method}`))
      respond(msg.id, work)
    }
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
    call<T>(method: string, args: unknown[]): Promise<T> {
      const id = `${connId}:${nextId++}`
      return new Promise<T>((resolve, reject) => {
        pending.set(id, { resolve: resolve as (v: unknown) => void, reject })
        transport.postMessage({ kind: 'request', id, method, args })
      })
    },
    registerHandler(method, fn) {
      handlers.set(method, fn)
    },
  }
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `cd packages/protocol && npx vitest run src/rpc-peer.test.ts`
Expected: PASS (7 tests).

- [ ] **Step 5: Commit**

```bash
git add packages/protocol/src/rpc-peer.ts packages/protocol/src/rpc-peer.test.ts
git commit -m "feat(protocol): add createRpcPeer, a symmetric request/response/event peer"
```

---

### Task 2: Unify the wire types — retire `mainRequest`/`mainResponse`

**Files:**
- Modify: `packages/protocol/src/types/service-ipc.ts` (full rewrite)
- Modify: `packages/protocol/src/types/service-ipc.test.ts` (full rewrite)

**Interfaces:**
- Consumes: nothing from Task 1.
- Produces: `ServiceMethod`, `MainMethod` (both unchanged, still separate lists for readability), `RpcMethod = ServiceMethod | MainMethod`, `RpcRequest`, `RpcResponse`, `RpcEvent`, `RpcReady`, `RpcMessage = RpcRequest | RpcResponse | RpcEvent | RpcReady`. Removes `ServiceRequest`, `ServiceResponse`, `MainRequest`, `MainResponse`, `MainToService`, `ServiceToMain` — Task 3 and Task 5 update the two remaining consumers of those removed names.

- [ ] **Step 1: Write the failing test**

Replace the full contents of `packages/protocol/src/types/service-ipc.test.ts`:

```typescript
import { describe, expect, it } from 'vitest'

import type { MainMethod, RpcMessage, RpcMethod, RpcRequest, RpcResponse, ServiceMethod } from './service-ipc'

describe('service-ipc unified rpc types', () => {
  it('an RpcRequest carries a ServiceMethod or a MainMethod', () => {
    const service: RpcRequest = { kind: 'request', id: 'a:1', method: 'listAgents', args: [] }
    const main: RpcRequest = { kind: 'request', id: 'b:1', method: 'weather.get_forecast', args: [null, null] }
    expect(service.method).toBe('listAgents')
    expect(main.method).toBe('weather.get_forecast')
  })

  it('RpcResponse is discriminated on ok', () => {
    const ok: RpcResponse = { kind: 'response', id: 'a:1', ok: true, result: [] }
    const bad: RpcResponse = { kind: 'response', id: 'a:2', ok: false, error: 'boom' }
    expect(ok.ok).toBe(true)
    expect(bad.ok).toBe(false)
  })

  it('RpcRequest and RpcResponse are both valid RpcMessage values', () => {
    const req: RpcMessage = { kind: 'request', id: 'a:1', method: 'gmail.search', args: ['x', 10] }
    const res: RpcMessage = { kind: 'response', id: 'a:1', ok: true, result: 1 }
    expect(req.kind).toBe('request')
    expect(res.kind).toBe('response')
  })

  it('RpcMethod accepts both ServiceMethod and MainMethod values', () => {
    const a: RpcMethod = 'submitGoal'
    const b: RpcMethod = 'calendar.list_upcoming'
    expect(a).toBe('submitGoal')
    expect(b).toBe('calendar.list_upcoming')
  })
})
```

`MainMethod` and `ServiceMethod` are imported only for their use inside the `RpcRequest`/`RpcMethod` literal assignments above — TypeScript checks the assignment is valid at compile time; there's no separate runtime assertion needed against them.

- [ ] **Step 2: Run test to verify it fails**

Run: `cd packages/protocol && npx vitest run src/types/service-ipc.test.ts`
Expected: FAIL — TypeScript error, `RpcMessage`/`RpcMethod`/`RpcRequest`/`RpcResponse` are not exported from `./service-ipc` (they don't exist yet; the file still only has `MainRequest`/`MainResponse`/etc).

- [ ] **Step 3: Write the implementation**

Replace the full contents of `packages/protocol/src/types/service-ipc.ts`:

```typescript
// Wire protocol for the Main <-> Service utilityProcess channel, and (via the
// WS bridge) for external peers <-> Service. One symmetric request/response
// pair: whoever registers a handler for a method answers it, regardless of
// which side initiated the connection or which side is calling. `id` is a
// string, not a number: it's prefixed per RpcPeer instance (see rpc-peer.ts)
// so ids never collide across main's own peer and any number of WS-bridged
// external peers sharing the same service transport — each numbers its own
// requests from 1 independently.

// Methods the service process can serve — main calls these on behalf of the
// renderer (createSession, submitGoal, listAgents, ...).
export type ServiceMethod =
  | 'createSession'
  | 'submitGoal'
  | 'listSessions'
  | 'getRunEvents'
  | 'deleteSession'
  | 'renameSession'
  | 'setSessionPinned'
  | 'updateSessionSettings'
  | 'reorderSessions'
  | 'decidePermission'
  | 'cancelRun'
  | 'interruptWith'
  | 'setMcpServers'
  | 'getMcpStatus'
  | 'setWebSearchConfig'
  | 'setBudgetConfig'
  | 'listSkills'
  | 'listAgents'
  | 'saveSkill'
  | 'deleteSkill'
  | 'saveAgent'
  | 'deleteAgent'
  | 'restoreDefaultAgents'
  | 'importSkill'
  | 'getToolToggles'
  | 'setSkillEnabled'
  | 'setToolGroupEnabled'
  | 'listToolGroups'
  | 'listMemory'
  | 'getUsageStats'
  | 'listCronJobsForSession'
  | 'listAllCronJobs'
  | 'listAllCronRuns'
  | 'cancelCronJob'
  | 'analyzeEmail'
  | 'analyzeThread'
  | 'collectArticle'
  | 'analyzeArticle'
  | 'listArticles'
  | 'getArticleAnalysis'
  | 'deleteArticle'
  | 'researchRepo'
  | 'getRepoResearch'
  | 'researchedRepoNames'
  | 'exportSessionMarkdown'

// Methods only Main can serve — the service process calls these when a tool
// needs data only Main holds (the gmail/calendar cache, QWeather config).
export type MainMethod =
  | 'gmail.search'
  | 'gmail.get_thread'
  | 'gmail.list_recent'
  | 'calendar.list_upcoming'
  | 'calendar.get_event'
  | 'calendar.create_local'
  | 'calendar.update_local'
  | 'calendar.delete_local'
  | 'weather.get_forecast'

export type RpcMethod = ServiceMethod | MainMethod

export type RpcRequest = {
  kind: 'request'
  id: string
  method: RpcMethod
  args: unknown[]
}

export type RpcResponse =
  | { kind: 'response'; id: string; ok: true; result: unknown }
  | { kind: 'response'; id: string; ok: false; error: string }

export type RpcEvent = {
  kind: 'event'
  event: string
  data: unknown
}

export type RpcReady = { kind: 'ready' }

export type RpcMessage = RpcRequest | RpcResponse | RpcEvent | RpcReady
```

- [ ] **Step 4: Run test to verify it passes**

Run: `cd packages/protocol && npx vitest run src/types/service-ipc.test.ts`
Expected: PASS (4 tests).

- [ ] **Step 5: Commit**

This leaves `packages/protocol/src/service-client.ts` and `apps/desktop/src/service/index.ts` broken (they still import the removed `MainRequest`/`ServiceRequest`/`ServiceToMain` names) — that's expected, Tasks 3 and 5 fix them next. Commit anyway so each task is its own reviewable unit; the repo-wide typecheck in Task 8 is the final gate, not every intermediate commit.

```bash
git add packages/protocol/src/types/service-ipc.ts packages/protocol/src/types/service-ipc.test.ts
git commit -m "feat(protocol): unify service-ipc wire types into one request/response pair"
```

---

### Task 3: Rebuild `createServiceClient` on `createRpcPeer`

**Files:**
- Modify: `packages/protocol/src/service-client.ts` (full rewrite)
- Verify unchanged: `packages/protocol/src/service-client.test.ts` (should still pass with zero edits)
- Delete: `packages/protocol/src/service-client.mainrpc.test.ts`
- Create: `packages/protocol/src/service-client.handlers.test.ts`

**Interfaces:**
- Consumes: `createRpcPeer`, `RpcTransport` from `./rpc-peer` (Task 1); `MainMethod` from `./types/service-ipc` (Task 2).
- Produces: `ServiceClient.registerHandler(method: MainMethod, fn: (...args: unknown[]) => Promise<unknown> | unknown): void` — renamed from `registerMainRpc`. Every other `ServiceClient` method signature is unchanged. `ServiceTransport` stays exported (now a type alias for `RpcTransport`) so `apps/desktop/src/main/index.ts`, `apps/desktop/src/main/host/*.ts`, and `apps/extension/entrypoints/background.ts` need zero import changes.

- [ ] **Step 1: Write the failing test**

Delete `packages/protocol/src/service-client.mainrpc.test.ts` and create `packages/protocol/src/service-client.handlers.test.ts`:

```typescript
import { describe, expect, it } from 'vitest'

import { createServiceClient, type ServiceTransport } from './service-client'

function fakeTransport(): { t: ServiceTransport; sent: unknown[]; deliver(m: unknown): void } {
  const sent: unknown[] = []
  let listener: ((m: unknown) => void) | null = null
  return {
    sent,
    t: {
      postMessage: (m: unknown) => sent.push(m),
      on: (_c: 'message', l: (m: unknown) => void) => {
        listener = l
      },
      off: () => {
        listener = null
      },
    } as unknown as ServiceTransport,
    deliver(m: unknown) {
      listener?.(m)
    },
  }
}

// Drain microtasks until the request -> response promise chain resolves. The
// handler runs inside a Promise.resolve().then(...).then(...) chain, and
// async handlers add their own ticks, so a single await is not enough.
async function flush(): Promise<void> {
  for (let i = 0; i < 10; i++) {
    // eslint-disable-next-line no-await-in-loop
    await Promise.resolve()
  }
}

describe('service-client registerHandler routing', () => {
  it('routes an incoming request to a registered handler and posts a response', async () => {
    const { t, sent, deliver } = fakeTransport()
    const client = createServiceClient({ transport: t })
    await client.connect()
    client.registerHandler('gmail.search', async (q, limit) => [{ id: 't1', q, limit }])

    deliver({ kind: 'request', id: 'peer-1:77', method: 'gmail.search', args: ['inv', 5] })
    await flush()

    expect(sent).toEqual([{ kind: 'response', id: 'peer-1:77', ok: true, result: [{ id: 't1', q: 'inv', limit: 5 }] }])
  })

  it('posts an error response when the handler throws', async () => {
    const { t, sent, deliver } = fakeTransport()
    const client = createServiceClient({ transport: t })
    await client.connect()
    client.registerHandler('gmail.get_thread', async () => {
      throw new Error('boom')
    })

    deliver({ kind: 'request', id: 'peer-1:9', method: 'gmail.get_thread', args: ['x'] })
    await flush()

    expect(sent).toEqual([{ kind: 'response', id: 'peer-1:9', ok: false, error: 'boom' }])
  })

  it('posts an error response for a request with no registered handler', async () => {
    const { t, sent, deliver } = fakeTransport()
    const client = createServiceClient({ transport: t })
    await client.connect()
    deliver({ kind: 'request', id: 'peer-1:3', method: 'gmail.list_recent', args: [] })
    await flush()
    expect(sent).toEqual([{ kind: 'response', id: 'peer-1:3', ok: false, error: expect.stringContaining('no handler') }])
  })
})
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd packages/protocol && npx vitest run src/service-client.handlers.test.ts`
Expected: FAIL — `client.registerHandler is not a function` (the current `ServiceClient` still only exposes `registerMainRpc`, and still speaks `mainRequest`/`mainResponse`, not `request`/`response`, for this direction).

- [ ] **Step 3: Write the implementation**

Replace the full contents of `packages/protocol/src/service-client.ts`:

```typescript
import type { AgentDefinition, AgentListItem, AgentMutationResult } from './types/agent'
import type {
  AnalyzeArticleRequest,
  AnalyzeArticleResult,
  ArticleSource,
  ArticleSummary,
  CollectArticleResult,
  CollectedArticleWithAnalysis,
} from './types/article'
import type { BudgetConfig } from './types/budgets'
import type { McpServerConfig, McpServerStatus } from './types/mcp'
import type { MemoryView } from './types/memory'
import type { ProviderInjection } from './types/provider'
import type { MainMethod } from './types/service-ipc'
import type { Skill, SkillMutationResult } from './types/skill'
import type { ToolGroupInfo, ToolToggles } from './types/tool-toggles'
import type { RepoResearch, ResearchRepoRequest, ResearchRepoResult } from './types/trending'
import type { PermissionDecision } from './types/ui'
import type { WebSearchInjection } from './types/web-search'
import { createRpcPeer, type RpcTransport } from './rpc-peer'

// Kept as an alias so existing imports of ServiceTransport (desktop main,
// extension, RN) don't need to change.
export type ServiceTransport = RpcTransport

export type ServiceClient = {
  connect(): Promise<void>
  disconnect(): void
  createSession(provider: ProviderInjection): Promise<{ sessionId: string }>
  submitGoal(
    sessionId: string,
    goal: string,
    attachments?: import('./types/task').Attachment[],
    options?: import('./types/task').RunOptions
  ): Promise<{ runId: string }>
  analyzeEmail(req: import('./types/ui').AnalyzeEmailRequest): Promise<import('./types/ui').AnalyzeEmailResult>
  analyzeThread(req: import('./types/ui').AnalyzeThreadRequest): Promise<import('./types/ui').AnalyzeThreadResult>
  collectArticle(input: ArticleSource): Promise<CollectArticleResult>
  analyzeArticle(req: AnalyzeArticleRequest): Promise<AnalyzeArticleResult>
  listArticles(): Promise<CollectedArticleWithAnalysis[]>
  getArticleAnalysis(articleId: string): Promise<{ summary: ArticleSummary | null; analyzedAt: string | null }>
  deleteArticle(articleId: string): Promise<void>
  researchRepo(req: ResearchRepoRequest): Promise<ResearchRepoResult>
  getRepoResearch(repoName: string): Promise<{ research: RepoResearch | null; researchedAt: string | null }>
  researchedRepoNames(): Promise<string[]>
  listSessions(): Promise<import('./types/ui').SessionSummary[]>
  getRunEvents(sessionId: string): Promise<import('./types/task').RunEvent[]>
  exportSessionMarkdown(sessionId: string): Promise<{ path: string }>
  deleteSession(sessionId: string): Promise<void>
  renameSession(sessionId: string, title: string): Promise<void>
  setSessionPinned(sessionId: string, pinned: boolean): Promise<void>
  updateSessionSettings(sessionId: string, settings: import('./types/ui').SessionSettings): Promise<void>
  reorderSessions(orderedIds: string[]): Promise<void>
  decidePermission(sessionId: string, actionId: string, decision: PermissionDecision): Promise<void>
  cancelRun(sessionId: string, runId: string): Promise<void>
  interruptWith(sessionId: string, runId: string): Promise<void>
  setMcpServers(configs: McpServerConfig[]): Promise<void>
  getMcpStatus(): Promise<McpServerStatus[]>
  setWebSearchConfig(config: WebSearchInjection): Promise<void>
  setBudgetConfig(config: BudgetConfig): Promise<void>
  listSkills(): Promise<Skill[]>
  listAgents(): Promise<AgentListItem[]>
  saveAgent(def: AgentDefinition): Promise<AgentMutationResult>
  deleteAgent(id: string): Promise<AgentMutationResult>
  restoreDefaultAgents(): Promise<AgentMutationResult>
  saveSkill(skill: Skill): Promise<SkillMutationResult>
  deleteSkill(name: string): Promise<SkillMutationResult>
  importSkill(sourceDir: string, overwrite?: boolean): Promise<SkillMutationResult>
  getToolToggles(): Promise<ToolToggles>
  setSkillEnabled(name: string, enabled: boolean): Promise<ToolToggles>
  setToolGroupEnabled(group: string, enabled: boolean): Promise<ToolToggles>
  listToolGroups(): Promise<ToolGroupInfo[]>
  listMemory(namespace?: string): Promise<MemoryView[]>
  getUsageStats(rangeDays: number): Promise<import('./types/usage').UsageStats>
  listCronJobsForSession(sessionId: string): Promise<import('./types/ui').CronJobSummary[]>
  listAllCronJobs(): Promise<import('./types/ui').ScheduledTask[]>
  listAllCronRuns(): Promise<import('./types/ui').CronRun[]>
  cancelCronJob(id: string): Promise<void>
  // Registers a handler this side can serve for the other side's call() — e.g.
  // main registers 'weather.get_forecast' so the service process can call it.
  // Renamed from the old registerMainRpc: with one symmetric request/response
  // pair there's no "main-specific" RPC anymore, just "a handler this
  // instance can serve."
  registerHandler(method: MainMethod, fn: (...args: unknown[]) => Promise<unknown> | unknown): void
}

export function createServiceClient(cfg: {
  transport: ServiceTransport
  onEvent?: (event: string, data: unknown) => void
}): ServiceClient {
  const peer = createRpcPeer({ transport: cfg.transport, onEvent: cfg.onEvent })

  return {
    connect: () => peer.connect(),
    disconnect: () => peer.disconnect(),
    registerHandler: (method, fn) => peer.registerHandler(method, fn),
    createSession: (provider) => peer.call('createSession', [provider]),
    submitGoal: (sessionId, goal, attachments, options) =>
      peer.call('submitGoal', [sessionId, goal, attachments, options]),
    analyzeEmail: (req) => peer.call('analyzeEmail', [req]),
    analyzeThread: (req) => peer.call('analyzeThread', [req]),
    collectArticle: (input) => peer.call('collectArticle', [input]),
    analyzeArticle: (req) => peer.call('analyzeArticle', [req]),
    listArticles: () => peer.call('listArticles', []),
    getArticleAnalysis: (articleId) => peer.call('getArticleAnalysis', [articleId]),
    async deleteArticle(articleId) {
      await peer.call('deleteArticle', [articleId])
    },
    researchRepo: (req) => peer.call('researchRepo', [req]),
    getRepoResearch: (repoName) => peer.call('getRepoResearch', [repoName]),
    researchedRepoNames: () => peer.call('researchedRepoNames', []),
    listSessions: () => peer.call('listSessions', []),
    getRunEvents: (sessionId) => peer.call('getRunEvents', [sessionId]),
    exportSessionMarkdown: (sessionId) => peer.call('exportSessionMarkdown', [sessionId]),
    async deleteSession(sessionId) {
      await peer.call('deleteSession', [sessionId])
    },
    async renameSession(sessionId, title) {
      await peer.call('renameSession', [sessionId, title])
    },
    async setSessionPinned(sessionId, pinned) {
      await peer.call('setSessionPinned', [sessionId, pinned])
    },
    async updateSessionSettings(sessionId, settings) {
      await peer.call('updateSessionSettings', [sessionId, settings])
    },
    async reorderSessions(orderedIds) {
      await peer.call('reorderSessions', [orderedIds])
    },
    async decidePermission(sessionId, actionId, decision) {
      await peer.call('decidePermission', [sessionId, actionId, decision])
    },
    async cancelRun(sessionId, runId) {
      await peer.call('cancelRun', [sessionId, runId])
    },
    async interruptWith(sessionId, runId) {
      await peer.call('interruptWith', [sessionId, runId])
    },
    async setMcpServers(configs) {
      await peer.call('setMcpServers', [configs])
    },
    getMcpStatus: () => peer.call('getMcpStatus', []),
    async setWebSearchConfig(config) {
      await peer.call('setWebSearchConfig', [config])
    },
    async setBudgetConfig(config) {
      await peer.call('setBudgetConfig', [config])
    },
    listSkills: () => peer.call('listSkills', []),
    listAgents: () => peer.call('listAgents', []),
    saveAgent: (def) => peer.call('saveAgent', [def]),
    deleteAgent: (id) => peer.call('deleteAgent', [id]),
    restoreDefaultAgents: () => peer.call('restoreDefaultAgents', []),
    saveSkill: (skill) => peer.call('saveSkill', [skill]),
    deleteSkill: (name) => peer.call('deleteSkill', [name]),
    importSkill: (sourceDir, overwrite) => peer.call('importSkill', [sourceDir, overwrite]),
    getToolToggles: () => peer.call('getToolToggles', []),
    setSkillEnabled: (name, enabled) => peer.call('setSkillEnabled', [name, enabled]),
    setToolGroupEnabled: (group, enabled) => peer.call('setToolGroupEnabled', [group, enabled]),
    listToolGroups: () => peer.call('listToolGroups', []),
    listMemory: (namespace) => peer.call('listMemory', [namespace]),
    getUsageStats: (rangeDays) => peer.call('getUsageStats', [rangeDays]),
    listCronJobsForSession: (sessionId) => peer.call('listCronJobsForSession', [sessionId]),
    listAllCronJobs: () => peer.call('listAllCronJobs', []),
    listAllCronRuns: () => peer.call('listAllCronRuns', []),
    async cancelCronJob(id) {
      await peer.call('cancelCronJob', [id])
    },
  }
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `cd packages/protocol && npx vitest run src/service-client.handlers.test.ts src/service-client.test.ts`
Expected: PASS — the new handlers test (3 tests) AND the pre-existing `service-client.test.ts` (4 tests, unmodified) both pass. `service-client.test.ts` passing unmodified confirms `createSession`/`submitGoal`/events/disconnect all still behave identically after the `createRpcPeer` rebuild.

- [ ] **Step 5: Commit**

```bash
git add packages/protocol/src/service-client.ts packages/protocol/src/service-client.handlers.test.ts
git rm packages/protocol/src/service-client.mainrpc.test.ts
git commit -m "refactor(protocol): rebuild createServiceClient on createRpcPeer, rename registerMainRpc to registerHandler"
```

---

### Task 4: Export `createRpcPeer` from the package barrel

**Files:**
- Modify: `packages/protocol/src/index.ts:1-5`

**Interfaces:**
- Consumes: `rpc-peer.ts` exports (Task 1).
- Produces: `createRpcPeer`, `RpcTransport`, `RpcPeer`, `RpcPeerConfig`, `RpcMessage`, `RpcHandler` now importable as `import { createRpcPeer } from '@swarm/protocol'` — Task 5 (the service process, in `apps/desktop`, a separate package) needs this.

- [ ] **Step 1: Write the failing test**

There's no dedicated test for barrel exports in this package; the "test" is Task 5's implementation failing to compile without this export. Skip straight to the change — it's a one-line addition with no independent behavior to fail first.

- [ ] **Step 2: Make the change**

In `packages/protocol/src/index.ts`, add one line after the existing `export * from './service-client'`:

```typescript
// RPC client + transport (consumed unchanged by desktop, extension, RN)
export * from './service-client'
export * from './rpc-peer'
export * from './types/agent'
```

- [ ] **Step 3: Verify the whole protocol package still typechecks and tests pass**

Run: `cd packages/protocol && npx tsc --noEmit && npx vitest run`
Expected: `tsc` reports no errors; vitest reports all suites passing (rpc-peer.test.ts, service-ipc.test.ts, service-client.test.ts, service-client.handlers.test.ts, plus any other pre-existing `packages/protocol/src/**/*.test.ts` files untouched by this plan).

- [ ] **Step 4: Commit**

```bash
git add packages/protocol/src/index.ts
git commit -m "feat(protocol): export createRpcPeer from the package barrel"
```

---

### Task 5: Migrate the service process to `createRpcPeer`

**Files:**
- Modify: `apps/desktop/src/service/index.ts:1-6, 146-172, 268-289`
- Delete: `apps/desktop/src/service/gmail/main-rpc.ts`
- Delete: `apps/desktop/src/service/gmail/main-rpc.test.ts`

**Interfaces:**
- Consumes: `createRpcPeer` from `@swarm/protocol` (Task 4); `ServiceMethod` from `@swarm/protocol` (already exported, unchanged by Task 2).
- Produces: nothing new exported — `registerBuiltinTools`'s `gmailMainRpc`/`calendarMainRpc`/`weatherMainRpc` deps (in `apps/desktop/src/service/tools/builtins.ts`) keep their exact existing parameter names and `(method: MainMethod, args: unknown[]) => Promise<unknown>` signature; only what gets passed in at the call site changes, from `mainRpc.mainRpc` to an arrow wrapping `rpcPeer.call`. `builtins.ts` itself needs zero edits.

- [ ] **Step 1: Write the failing test**

This task has no new automated test of its own — it's a call-site migration inside an already-tested peer/dispatcher pair (Task 1 covers `createRpcPeer`'s generic behavior; the service's own dispatcher logic in `createDispatcher` has its own pre-existing tests, untouched). The verification is: the service process still boots, and `apps/desktop/src/main/host/host.test.ts`'s end-to-end loopback test (unmodified — see Task 6) still passes with the new wiring. Run it now to confirm the OLD wiring passes, as the baseline:

Run: `cd apps/desktop && npm test -- run src/main/host/host.test.ts`
Expected: PASS (1 test) — this is the baseline before the migration; it must still pass after Step 3 below.

- [ ] **Step 2: Read the exact current block being replaced**

Current `apps/desktop/src/service/index.ts` (relevant excerpts, for reference — do not skip re-reading the live file before editing, in case something shifted):

```typescript
// line 4 (import block)
import type { ProviderInjection, ServiceRequest, WebSearchInjection } from '@swarm/protocol'
```

```typescript
// line 17 (import block)
import { createMainRpc } from './gmail/main-rpc'
```

```typescript
// lines 146-171
// Service-side main-rpc client: gmail.* tools call mainRpc('gmail.search', [...]),
// which posts a mainRequest that Main answers with a mainResponse. The client
// resolves the pending promise for each matched id. subscribe adds a second
// parentPort 'message' listener (the ServiceRequest handler filters by kind, so
// there is no conflict); utilityProcess parentPort has no off(), so unsubscribe
// is a no-op — the listener lives for the process lifetime.
const mainRpc = createMainRpc({
  post: (m) => parentPort.postMessage(m),
  subscribe: (fn) => {
    const listener = (e: { data: unknown }): void => fn(e.data)
    parentPort.on('message', listener)
    return () => {}
  },
})

registerBuiltinTools(toolRegistry, {
  memoryStore,
  skillStore,
  scheduler,
  claudeCode,
  getWebSearchConfig: () => webSearchConfig,
  isSkillEnabled: (name) => toolToggles.isSkillEnabled(name),
  gmailMainRpc: mainRpc.mainRpc,
  calendarMainRpc: mainRpc.mainRpc,
  weatherMainRpc: mainRpc.mainRpc,
})
scheduler.start()
```

```typescript
// lines 268-289
parentPort.on('message', async (e) => {
  const msg = e.data as ServiceRequest
  if (msg?.kind !== 'request') return
  const t0 = Date.now()
  log.debug({ msg: 'request', method: msg.method, id: msg.id })
  try {
    const result = await dispatch(msg.method, msg.args)
    parentPort.postMessage({ kind: 'response', id: msg.id, ok: true, result })
    log.debug({ msg: 'request ok', method: msg.method, id: msg.id, durationMs: Date.now() - t0 })
  } catch (err) {
    log.error({
      msg: 'request failed',
      method: msg.method,
      id: msg.id,
      durationMs: Date.now() - t0,
      err: err instanceof Error ? err.message : String(err),
    })
    parentPort.postMessage({ kind: 'response', id: msg.id, ok: false, error: String(err) })
  }
})

parentPort.postMessage({ kind: 'ready' })
```

- [ ] **Step 3: Write the implementation**

Edit the import block: replace

```typescript
import type { ProviderInjection, ServiceRequest, WebSearchInjection } from '@swarm/protocol'
```

with

```typescript
import { createRpcPeer, type ProviderInjection, type ServiceMethod, type WebSearchInjection } from '@swarm/protocol'
```

Delete the import line:

```typescript
import { createMainRpc } from './gmail/main-rpc'
```

Replace the block at (former) lines 146-171 with:

```typescript
// One symmetric RPC peer over parentPort, both directions: main sends
// `request`s that this side answers via `dispatch` (registered below as the
// defaultHandler, so the service keeps its single big method table instead
// of calling registerHandler once per ServiceMethod), and gmail.*/calendar.*/
// weather.* tools call() out to main for data only main holds. parentPort has
// no off(), so disconnect() is never called — the listener lives for the
// process lifetime.
const rpcPeer = createRpcPeer({
  transport: {
    postMessage: (m) => parentPort.postMessage(m),
    on: (_ch, fn) => parentPort.on('message', (e) => fn(e.data)),
    off: () => {},
  },
  defaultHandler: async (method, args, id) => {
    const m = method as ServiceMethod
    const t0 = Date.now()
    log.debug({ msg: 'request', method: m, id })
    try {
      const result = await dispatch(m, args)
      log.debug({ msg: 'request ok', method: m, id, durationMs: Date.now() - t0 })
      return result
    } catch (err) {
      log.error({
        msg: 'request failed',
        method: m,
        id,
        durationMs: Date.now() - t0,
        err: err instanceof Error ? err.message : String(err),
      })
      throw err
    }
  },
})
rpcPeer.connect()

registerBuiltinTools(toolRegistry, {
  memoryStore,
  skillStore,
  scheduler,
  claudeCode,
  getWebSearchConfig: () => webSearchConfig,
  isSkillEnabled: (name) => toolToggles.isSkillEnabled(name),
  gmailMainRpc: (method, args) => rpcPeer.call(method, args),
  calendarMainRpc: (method, args) => rpcPeer.call(method, args),
  weatherMainRpc: (method, args) => rpcPeer.call(method, args),
})
scheduler.start()
```

Note the forward reference: `defaultHandler` closes over `dispatch`, which is declared later in this same module (in the `createDispatcher({...})` block, further down, unchanged by this task). This is safe — `defaultHandler` is only *invoked* asynchronously when a message arrives, which can't happen until the entire synchronous module body (including the `const dispatch = createDispatcher(...)` line) has already finished running. Do not reorder `rpcPeer`'s creation to "fix" this; reordering is unnecessary and would make the diff larger.

Delete the entire block at (former) lines 268-286 (the raw `parentPort.on('message', async (e) => {...})` dispatcher) — its logic now lives inside `createRpcPeer`'s `defaultHandler`. Leave the following two lines, which are unrelated to request dispatch (a one-time boot handshake and a startup log), exactly where they are:

```typescript
parentPort.postMessage({ kind: 'ready' })
log.info({ msg: 'service started', dbPath })
```

- [ ] **Step 4: Delete the now-unused main-rpc module and its test**

```bash
git rm apps/desktop/src/service/gmail/main-rpc.ts apps/desktop/src/service/gmail/main-rpc.test.ts
```

- [ ] **Step 5: Run test to verify it passes**

Run: `cd apps/desktop && npm test -- run src/main/host/host.test.ts src/service`
Expected: PASS — the loopback integration test from Step 1 still passes (confirming the service process still answers `listAgents` correctly end-to-end through the new `rpcPeer`), and every existing test under `src/service` (session-service, dispatcher, tools, etc. — unmodified by this task) still passes.

- [ ] **Step 6: Typecheck**

Run: `cd apps/desktop && npx tsc --noEmit -p tsconfig.node.json`
Expected: no errors. If you see `Cannot find module './gmail/main-rpc'` anywhere else, grep for it — that means a consumer outside this task's file list was missed; go fix that import before proceeding (there should be none — Task 5's planning grep found only `service/index.ts`, `service/tools/builtins.ts` (uses only the `MainMethod` type, unaffected), and the two deleted files).

- [ ] **Step 7: Commit**

```bash
git add apps/desktop/src/service/index.ts
git commit -m "refactor(service): migrate the service process to createRpcPeer, retire createMainRpc"
```

---

### Task 6: Rewrite the WS bridge with registry-based precise routing

**Files:**
- Modify: `apps/desktop/src/main/host/bridge.ts` (full rewrite)
- Modify: `apps/desktop/src/main/host/index.ts:1-28` (full rewrite)
- Modify: `apps/desktop/src/main/host/bridge.test.ts` (full rewrite)

**Interfaces:**
- Consumes: `ServiceTransport` from `@swarm/protocol` (unchanged).
- Produces: `ConnRegistry = { claim(connId: string, peer: WebSocket): void; ownerOf(connId: string): WebSocket | undefined; release(peer: WebSocket): void }`, `createConnRegistry(): ConnRegistry`, and `attachBridge`'s config gains a required `registry: ConnRegistry` field. `host/index.ts`'s `startWsHost` creates one registry per host instance and threads it through — its own exported signature (`StartWsHost`, return shape) is unchanged, so nothing outside `main/host/` needs to change.

- [ ] **Step 1: Write the failing test**

Replace the full contents of `apps/desktop/src/main/host/bridge.test.ts`:

```typescript
import { EventEmitter } from 'node:events'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { WebSocket, WebSocketServer } from 'ws'

import { attachBridge, createConnRegistry } from './bridge'

// A fake service transport: structured like the Electron utilityProcess —
// postMessage + EventEmitter 'message'. The host's main serviceClient uses the
// same shape, so a peer sharing it sees the same traffic.
function fakeServiceTransport() {
  const bus = new EventEmitter()
  return {
    postMessage: (m: unknown) => bus.emit('message', m),
    on: (_ch: 'message', fn: (m: unknown) => void) => bus.on('message', fn),
    off: (_ch: 'message', fn: (m: unknown) => void) => bus.off('message', fn),
    emit: (m: unknown) => bus.emit('message', m), // test hook to simulate service→main
  }
}

async function connectPeer(port: number): Promise<WebSocket> {
  const ws = new WebSocket(`ws://127.0.0.1:${port}`)
  await new Promise((res, rej) => {
    ws.once('open', res)
    ws.once('error', rej)
  })
  return ws
}

describe('ws bridge', () => {
  let server: WebSocketServer
  let port: number
  beforeEach(async () => {
    server = new WebSocketServer({ host: '127.0.0.1', port: 0 })
    await new Promise<void>((res) => server.once('listening', res))
    port = (server.address() as { port: number }).port
  })
  afterEach(() => server.close())

  it('relays a peer request to the service transport', async () => {
    const svc = fakeServiceTransport()
    const received: unknown[] = []
    svc.on('message', (m) => received.push(m))
    const registry = createConnRegistry()
    server.on('connection', (ws) => attachBridge({ peer: ws, service: svc as never, log: console, registry }))

    const ws = await connectPeer(port)
    ws.send(JSON.stringify({ kind: 'request', id: 'peerA:1', method: 'listAgents', args: [] }))
    await new Promise((res) => setTimeout(res, 50))
    expect(received).toHaveLength(1)
    expect(received[0]).toMatchObject({ kind: 'request', id: 'peerA:1', method: 'listAgents' })
    ws.close()
  })

  it('routes a response only to the peer that claimed its connId', async () => {
    const svc = fakeServiceTransport()
    const registry = createConnRegistry()
    server.on('connection', (ws) => attachBridge({ peer: ws, service: svc as never, log: console, registry }))

    const peerA = await connectPeer(port)
    const peerB = await connectPeer(port)
    const seenA: unknown[] = []
    const seenB: unknown[] = []
    peerA.on('message', (raw) => seenA.push(JSON.parse(raw.toString())))
    peerB.on('message', (raw) => seenB.push(JSON.parse(raw.toString())))

    // Only peerA asks — this is what claims connId "peerA" for peerA.
    peerA.send(JSON.stringify({ kind: 'request', id: 'peerA:1', method: 'listAgents', args: [] }))
    await new Promise((res) => setTimeout(res, 50))

    svc.emit({ kind: 'response', id: 'peerA:1', ok: true, result: { agents: [] } })
    await new Promise((res) => setTimeout(res, 50))

    expect(seenA).toEqual([{ kind: 'response', id: 'peerA:1', ok: true, result: { agents: [] } }])
    expect(seenB).toHaveLength(0)
    peerA.close()
    peerB.close()
  })

  it('broadcasts an event to every connected peer', async () => {
    const svc = fakeServiceTransport()
    const registry = createConnRegistry()
    server.on('connection', (ws) => attachBridge({ peer: ws, service: svc as never, log: console, registry }))

    const peerA = await connectPeer(port)
    const peerB = await connectPeer(port)
    const seenA: unknown[] = []
    const seenB: unknown[] = []
    peerA.on('message', (raw) => seenA.push(JSON.parse(raw.toString())))
    peerB.on('message', (raw) => seenB.push(JSON.parse(raw.toString())))

    svc.emit({ kind: 'event', event: 'run.progress', data: { runId: 'r1' } })
    await new Promise((res) => setTimeout(res, 50))

    expect(seenA).toEqual([{ kind: 'event', event: 'run.progress', data: { runId: 'r1' } }])
    expect(seenB).toEqual([{ kind: 'event', event: 'run.progress', data: { runId: 'r1' } }])
    peerA.close()
    peerB.close()
  })

  it('never forwards a request the service itself emits (a main-only call) to any peer', async () => {
    // Regression: gmail.*/calendar.*/weather.* calls are the service asking
    // main directly — main answers via its own listener on the same
    // transport, never via the bridge. No peer ever claimed this id, so it
    // must never be delivered to anyone.
    const svc = fakeServiceTransport()
    const registry = createConnRegistry()
    server.on('connection', (ws) => attachBridge({ peer: ws, service: svc as never, log: console, registry }))

    const peer = await connectPeer(port)
    const seen: unknown[] = []
    peer.on('message', (raw) => seen.push(JSON.parse(raw.toString())))

    svc.emit({ kind: 'request', id: 'service:1', method: 'weather.get_forecast', args: [null, null] })
    await new Promise((res) => setTimeout(res, 50))

    expect(seen).toHaveLength(0)
    peer.close()
  })

  it('never forwards a response for an id no connected peer claimed', async () => {
    const svc = fakeServiceTransport()
    const registry = createConnRegistry()
    server.on('connection', (ws) => attachBridge({ peer: ws, service: svc as never, log: console, registry }))

    const peer = await connectPeer(port)
    const seen: unknown[] = []
    peer.on('message', (raw) => seen.push(JSON.parse(raw.toString())))

    // This peer never sent a request with this id — e.g. it answers main's
    // own submitGoal call, made directly against the service, not via this peer.
    svc.emit({ kind: 'response', id: 'main-conn:1', ok: true, result: { runId: 'r1' } })
    await new Promise((res) => setTimeout(res, 50))

    expect(seen).toHaveLength(0)
    peer.close()
  })

  it("removes a peer's claimed connIds when it disconnects", async () => {
    const svc = fakeServiceTransport()
    const registry = createConnRegistry()
    server.on('connection', (ws) => attachBridge({ peer: ws, service: svc as never, log: console, registry }))

    const peer = await connectPeer(port)
    peer.send(JSON.stringify({ kind: 'request', id: 'peerA:1', method: 'listAgents', args: [] }))
    await new Promise((res) => setTimeout(res, 50))
    expect(registry.ownerOf('peerA')).toBe(peer)

    peer.close()
    await new Promise((res) => setTimeout(res, 50))
    expect(registry.ownerOf('peerA')).toBeUndefined()
  })
})
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd apps/desktop && npm test -- run src/main/host/bridge.test.ts`
Expected: FAIL — `createConnRegistry` is not exported from `./bridge`, and `attachBridge` doesn't accept a `registry` option yet.

- [ ] **Step 3: Write the implementation**

Replace the full contents of `apps/desktop/src/main/host/bridge.ts`:

```typescript
import type { ServiceTransport } from '@swarm/protocol'
import type { WebSocket } from 'ws'

export type BridgeLog = { info: (m: unknown) => void; warn: (m: unknown) => void; error: (m: unknown) => void }

// Tracks which WS peer originated each in-flight request id, keyed by the
// connId prefix every RpcPeer stamps onto its own ids (see rpc-peer.ts:
// `${connId}:${counter}`). Shared across every peer connection on one
// startWsHost instance so a response is routed to exactly the peer that
// asked for it — never broadcast, never delivered to the wrong peer.
export type ConnRegistry = {
  claim(connId: string, peer: WebSocket): void
  ownerOf(connId: string): WebSocket | undefined
  release(peer: WebSocket): void
}

export function createConnRegistry(): ConnRegistry {
  const byConnId = new Map<string, WebSocket>()
  return {
    claim(connId, peer) {
      byConnId.set(connId, peer)
    },
    ownerOf(connId) {
      return byConnId.get(connId)
    },
    release(peer) {
      for (const [connId, owner] of byConnId) {
        if (owner === peer) byConnId.delete(connId)
      }
    },
  }
}

export type AttachBridge = {
  peer: WebSocket
  service: ServiceTransport
  log: BridgeLog
  registry: ConnRegistry
}

const connIdOf = (id: unknown): string | null => {
  if (typeof id !== 'string') return null
  const i = id.indexOf(':')
  return i < 0 ? null : id.slice(0, i)
}

// Wire one WS peer to the service transport, with per-connection routing
// instead of a broadcast:
//   peer -> service: only 'request' messages are forwarded (peers only ever
//     ask for things); the connId in the request's id is claimed for this peer.
//   service -> peer: 'event' is broadcast to every connected peer (nobody
//     asked for it specifically; everybody who cares should see it).
//     'response' is sent ONLY to the peer that claimed the matching connId —
//     if no peer claimed it (it answers a request main itself made, or an
//     internal gmail.*/calendar.*/weather.* call the service made to main),
//     no peer ever sees it. A bare 'request' emitted BY the service (never by
//     a peer, since peers only ever initiate 'request') is always such an
//     internal main-only call, and is never forwarded either.
// Heartbeat: the peer (extension SW / RN) pings; ws auto-answers with pong,
// and the host logs the ping for liveness.
export function attachBridge(cfg: AttachBridge): () => void {
  const { peer, service, log, registry } = cfg

  const onPeerMessage = (raw: unknown): void => {
    try {
      const msg = typeof raw === 'string' ? JSON.parse(raw) : JSON.parse(String(raw))
      const kind = (msg as { kind?: string }).kind
      if (kind !== 'request') return
      const connId = connIdOf((msg as { id?: unknown }).id)
      if (connId) registry.claim(connId, peer)
      service.postMessage(msg)
    } catch (err) {
      log.warn({ msg: 'ws-host peer sent invalid json', err: String(err) })
    }
  }
  const onServiceMessage = (msg: unknown): void => {
    const m = msg as { kind?: string; id?: unknown }
    if (m.kind === 'event') {
      if (peer.readyState === peer.OPEN) peer.send(JSON.stringify(msg))
      return
    }
    if (m.kind === 'response') {
      const connId = connIdOf(m.id)
      if (connId && registry.ownerOf(connId) === peer && peer.readyState === peer.OPEN) {
        peer.send(JSON.stringify(msg))
      }
    }
    // 'request' (service calling main) and 'ready' never reach any peer.
  }

  peer.on('message', onPeerMessage)
  service.on('message', onServiceMessage)
  peer.on('ping', () => log.info({ msg: 'ws-host ping' }))

  log.info({ msg: 'ws-host bridge attached' })
  return () => {
    peer.off('message', onPeerMessage)
    service.off('message', onServiceMessage)
    registry.release(peer)
    log.info({ msg: 'ws-host bridge detached' })
  }
}
```

Replace the full contents of `apps/desktop/src/main/host/index.ts`:

```typescript
import type { ServiceTransport } from '@swarm/protocol'

import { loadOrCreateHostConfig } from './auth'
import { attachBridge, createConnRegistry } from './bridge'
import { startWsServer } from './ws-server'

export type StartWsHost = {
  serviceProcess: ServiceTransport
  userDataDir: string
  log: { info: (m: unknown) => void; warn: (m: unknown) => void; error: (m: unknown) => void }
}

// Boot the agent-runtime WS host: load/create port+token, start the loopback
// server, and attach a bridge on each authenticated peer. One ConnRegistry is
// shared across every peer connection so responses route to the peer that
// asked, never to a different one. Returns dispose().
export async function startWsHost(cfg: StartWsHost): Promise<{ port: number; token: string; dispose: () => void }> {
  const { port, token } = loadOrCreateHostConfig(cfg.userDataDir)
  const registry = createConnRegistry()
  const started = await startWsServer({
    port,
    token,
    log: cfg.log,
    onPeer: (peer) => {
      const detach = attachBridge({ peer, service: cfg.serviceProcess, log: cfg.log, registry })
      peer.on('close', () => detach())
    },
  })
  cfg.log.info({ msg: 'ws-host started', port: started.port })
  return { port: started.port, token, dispose: started.close }
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `cd apps/desktop && npm test -- run src/main/host/bridge.test.ts src/main/host/host.test.ts`
Expected: PASS — all 7 `bridge.test.ts` tests, plus the unmodified `host.test.ts` loopback test (its `createServiceClient({transport: wsTransport(ws)})` peer now claims a connId on its first `listAgents` request the same way, so the existing assertions still hold).

- [ ] **Step 5: Commit**

```bash
git add apps/desktop/src/main/host/bridge.ts apps/desktop/src/main/host/bridge.test.ts apps/desktop/src/main/host/index.ts
git commit -m "refactor(host): route bridge responses via a per-peer ConnRegistry instead of broadcasting"
```

---

### Task 7: Rename `client.registerMainRpc` to `client.registerHandler` at its 3 call sites

**Files:**
- Modify: `apps/desktop/src/main/gmail/index.ts:18-23, 51-55`
- Modify: `apps/desktop/src/main/calendar/index.ts:17-19, 46-50`
- Modify: `apps/desktop/src/main/weather/index.ts:14-16, 37-41`

**Interfaces:**
- Consumes: `ServiceClient.registerHandler` (Task 3).
- Produces: no change to `GmailHandle.registerMainRpc` / `CalendarHandle.registerMainRpc` / `WeatherHandle.registerMainRpc` — those method *names* are each module's own local API (called from `apps/desktop/src/main/index.ts:153-155` as `gmail.registerMainRpc(serviceClient)` etc.) and are intentionally left as-is to keep this task's diff to exactly the one renamed call inside each file. `apps/desktop/src/main/index.ts` needs zero edits.

- [ ] **Step 1: Write the failing test**

There's no dedicated unit test for these three `index.ts` files (they're thin wiring, exercised indirectly by the loopback/bridge tests already covered). The failing signal here is the typecheck in Step 3 — skip straight to the change.

- [ ] **Step 2: Make the change**

In `apps/desktop/src/main/gmail/index.ts`, change:

```typescript
type MainRpcClient = {
  registerMainRpc(method: MainMethod, fn: (...args: unknown[]) => Promise<unknown>): void
}
```

to:

```typescript
type MainRpcClient = {
  registerHandler(method: MainMethod, fn: (...args: unknown[]) => Promise<unknown>): void
}
```

and change:

```typescript
    registerMainRpc(client) {
      ;(Object.keys(wired.mainRpcHandlers) as Array<keyof typeof wired.mainRpcHandlers>).forEach((method) => {
        client.registerMainRpc(method, wired.mainRpcHandlers[method]!)
      })
    },
```

to:

```typescript
    registerMainRpc(client) {
      ;(Object.keys(wired.mainRpcHandlers) as Array<keyof typeof wired.mainRpcHandlers>).forEach((method) => {
        client.registerHandler(method, wired.mainRpcHandlers[method]!)
      })
    },
```

In `apps/desktop/src/main/calendar/index.ts`, change:

```typescript
type MainRpcClient = {
  registerMainRpc(method: MainMethod, fn: (...args: unknown[]) => Promise<unknown>): void
}
```

to:

```typescript
type MainRpcClient = {
  registerHandler(method: MainMethod, fn: (...args: unknown[]) => Promise<unknown>): void
}
```

and change:

```typescript
    registerMainRpc(client) {
      ;(Object.keys(wired.mainRpcHandlers) as Array<keyof typeof wired.mainRpcHandlers>).forEach((method) => {
        client.registerMainRpc(method, wired.mainRpcHandlers[method]!)
      })
    },
```

to:

```typescript
    registerMainRpc(client) {
      ;(Object.keys(wired.mainRpcHandlers) as Array<keyof typeof wired.mainRpcHandlers>).forEach((method) => {
        client.registerHandler(method, wired.mainRpcHandlers[method]!)
      })
    },
```

In `apps/desktop/src/main/weather/index.ts`, change:

```typescript
type MainRpcClient = {
  registerMainRpc(method: MainMethod, fn: (...args: unknown[]) => Promise<unknown>): void
}
```

to:

```typescript
type MainRpcClient = {
  registerHandler(method: MainMethod, fn: (...args: unknown[]) => Promise<unknown>): void
}
```

and change:

```typescript
    registerMainRpc(client) {
      ;(Object.keys(wired.mainRpcHandlers) as Array<keyof typeof wired.mainRpcHandlers>).forEach((method) => {
        client.registerMainRpc(method, wired.mainRpcHandlers[method]!)
      })
    },
```

to:

```typescript
    registerMainRpc(client) {
      ;(Object.keys(wired.mainRpcHandlers) as Array<keyof typeof wired.mainRpcHandlers>).forEach((method) => {
        client.registerHandler(method, wired.mainRpcHandlers[method]!)
      })
    },
```

All three files have identical shapes for this rename (`MainRpcClient`'s one method, and `registerMainRpc(client) { ... }`'s one inner call) — the code above is not abbreviated, it is the complete, correct edit for each of the three files.

- [ ] **Step 3: Typecheck to verify it passes**

Run: `cd apps/desktop && npx tsc --noEmit -p tsconfig.node.json`
Expected: no errors. Before Step 2, this would have failed with `Property 'registerHandler' does not exist on type 'ServiceClient'` is NOT the error you'd see (since `MainRpcClient` is a separate structural type, not literally `ServiceClient`) — instead you'd see it fail post-Task-3-and-pre-Task-7 with `Property 'registerMainRpc' does not exist on type 'ServiceClient'` at the call sites in `apps/desktop/src/main/index.ts:153-155` (`gmail.registerMainRpc(serviceClient)` passes `serviceClient` where `MainRpcClient` is expected — TypeScript structurally checks `ServiceClient` against `MainRpcClient`, and before this task `MainRpcClient` still says `registerMainRpc` while `ServiceClient` now only has `registerHandler`). This step's job is confirming that mismatch is gone.

- [ ] **Step 4: Run the full desktop main-process test suite**

Run: `cd apps/desktop && npm test -- run src/main`
Expected: PASS — every test under `src/main` (gmail, calendar, weather, host, providers, etc.), none of which were expected to change behavior.

- [ ] **Step 5: Commit**

```bash
git add apps/desktop/src/main/gmail/index.ts apps/desktop/src/main/calendar/index.ts apps/desktop/src/main/weather/index.ts
git commit -m "refactor(main): call the renamed ServiceClient.registerHandler from gmail/calendar/weather wiring"
```

---

### Task 8: Full-repo verification

**Files:** none (verification only).

- [ ] **Step 1: Typecheck every affected package**

```bash
cd /path/to/SwarmAgents
npx turbo run typecheck
```

Expected: `@swarm/protocol`, `@swarm/desktop`, `@swarm/extension` all report success. If `@swarm/desktop`'s `tsc` reports stale errors from a previous run, delete `**/*.tsbuildinfo` under `apps/desktop` first and re-run (a known gotcha in this repo — cached `.tsbuildinfo` can report already-fixed errors).

- [ ] **Step 2: Run the full test suites**

```bash
cd packages/protocol && npx vitest run
cd ../../apps/desktop && npm test
cd ../extension && npx vitest run
```

Expected: all green. Specifically confirm these suites, each exercised by an earlier task but worth re-checking together: `rpc-peer.test.ts`, `service-ipc.test.ts`, `service-client.test.ts`, `service-client.handlers.test.ts`, `bridge.test.ts`, `host.test.ts`, and the pre-existing `apps/extension/lib/transport-ws.test.ts` (unmodified — confirms the extension's own WS transport adapter, which `background.ts` feeds into `createServiceClient`, still works against the renamed/rebuilt client with zero changes on the extension side).

- [ ] **Step 3: Grep for any leftover reference to the retired names**

```bash
grep -rln "mainRequest\|mainResponse\|registerMainRpc\|createMainRpc\|ServiceRequest\b\|MainRequest\b\|MainToService\|ServiceToMain" --include="*.ts" --include="*.tsx" apps packages | grep -v node_modules
```

Expected: only `GmailHandle.registerMainRpc` / `CalendarHandle.registerMainRpc` / `WeatherHandle.registerMainRpc` *method names* remain (intentionally kept per Task 7's note) — i.e. this grep should surface `apps/desktop/src/main/gmail/index.ts`, `apps/desktop/src/main/calendar/index.ts`, `apps/desktop/src/main/weather/index.ts` (the `registerMainRpc(client) { ... }` method definitions and doc comments), and `apps/desktop/src/main/index.ts` (the `gmail.registerMainRpc(serviceClient)` call sites) — nothing else. If anything else shows up, go fix it before proceeding.

- [ ] **Step 4: Manual runtime smoke test**

Use the `run-desktop` skill to build and launch the app:
1. Launch the app fresh (full quit + relaunch if one was already running, so the new code is actually loaded — utilityProcess forks aren't hot-reloaded).
2. Open a chat session and trigger the `get_weather` tool (e.g. "今天天气怎么样"). Confirm in `~/.swarm-agents/swarm-dev.log` that it resolves via QWeather (`"source":"qweather"` in the tool result details), not the wttr.in fallback — this is the original bug this whole effort traces back to.
3. If the browser extension is available and configured with a valid WS host token, connect it and confirm `listAgents`/session activity still works through the WS bridge, and that triggering `get_weather` again (with the extension connected) *still* resolves via QWeather — this is the regression this plan specifically targets: previously, the extension's own now-defunct `registerMainRpc`-less client would race and win with a bogus "no handler" answer.

Expected: `get_weather` resolves via QWeather both with and without the extension connected.

- [ ] **Step 5: Final commit (if any formatting-only changes remain)**

```bash
git status
```

If clean (all substantive commits already made in Tasks 1-7), there's nothing to commit here. If `biome`'s pre-commit hook left any staged-but-uncommitted formatting fixes from a prior task's commit, commit them now with a small message, e.g.:

```bash
git add -u
git commit -m "chore: biome formatting fixes from pre-commit hook"
```
