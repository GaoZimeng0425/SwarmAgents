# Method-Table Single-Sourcing Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** One source of truth in `@swarm/protocol` for all 45 `ServiceMethod` + 11 `MainMethod` RPC signatures; `ServiceClient` and the service dispatcher derived from it; zod args validation at the dispatcher entry.

**Architecture:** A new `packages/protocol/src/service-methods.ts` holds a `ServiceMethodSignatures` type map and a parallel `serviceMethodArgSchemas` zod table (lockstep enforced by a mapped type). `service-client.ts` generates its 45 RPC members by iterating the schema table. The dispatcher becomes a typed handler map with a single validated entry point. Wire format (`{kind:'request', id, method, args[]}`) is unchanged.

**Tech Stack:** TypeScript 5.9 (workspace), zod 4, vitest, pnpm + turbo monorepo.

**Spec:** `docs/superpowers/specs/2026-07-17-method-table-design.md` (committed, this worktree).

## Global Constraints

- Work happens in worktree `method-table-single-source` (branch `worktree-method-table-single-source`), based on develop. Never `cd` to the main checkout; never `pnpm install` or `pnpm rebuild` in the worktree (node_modules are symlinked from the main checkout).
- Wire format unchanged: requests are `{ kind: 'request', id, method, args: unknown[] }`. Do not rename any method string.
- All code comments and commit messages in English.
- Run tests with `npm test -- <filter>` from the repo (worktree) root — never bare `npx vitest` (tests must run under Electron's node ABI).
- Typecheck with `pnpm typecheck` from the worktree root. Before typechecking, delete stale build info: `find . -name '*.tsbuildinfo' -not -path '*/node_modules/*' -delete`. Turbo typecheck emits stray `.js`/`.d.ts` next to `.ts` files under `apps/desktop/src` — never `git add -A`; always add files by exact path.
- Format only touched files: `npx biome check --write <file...>` (never `pnpm check` — it reformats the whole repo).
- In `service-methods.ts`, use `import type` for every type-only import (keeps runtime import graph acyclic; `types/*` files must never import the table).
- The dispatcher and `@swarm/protocol` stay logger-free (throw on failure; logging happens in `service/index.ts`'s existing `defaultHandler` wrapper).

---

### Task 1: Signature table + arg-schema table in `@swarm/protocol`

**Files:**
- Create: `packages/protocol/src/service-methods.ts`
- Modify: `packages/protocol/src/types/service-ipc.ts` (replace bare unions with re-exports)
- Modify: `packages/protocol/src/index.ts` (add `export * from './service-methods'` alongside the existing exports — inspect the file first; it re-exports modules individually)
- Test: `packages/protocol/src/service-methods.test.ts`

**Interfaces:**
- Consumes: existing zod schemas — `ProviderInjection` (types/provider.ts), `ArticleSource`/`AnalyzeArticleRequest` (types/article.ts), `ResearchRepoRequest` (types/trending.ts), `WebSearchInjection` (types/web-search.ts), `BudgetConfigSchema` (types/budgets.ts), `SkillSchema` (types/skill.ts), `AgentDefinitionSchema` (types/agent.ts), `McpServerConfigSchema` (types/mcp.ts), `AttachmentSchema` (types/artifact.ts), `SubmitOptionsSchema`/`PermissionModeSchema`/`ExecutionModeSchema` (types/execution.ts).
- Produces (used by Tasks 2–4): `ServiceMethodSignatures`, `ServiceMethod`, `serviceMethodArgSchemas`, `MainMethodSignatures`, `MainMethod`, `CallMainFn`. `types/service-ipc.ts` keeps exporting `ServiceMethod`/`MainMethod`/`RpcMethod` (now re-exported), plus its unchanged `RpcRequest`/`RpcResponse`/`RpcEvent`/`RpcReady`/`RpcMessage`.

- [ ] **Step 1: Locate two import paths this task needs**

Run (from worktree root):
```bash
grep -rn "export type ThreadAnalysisPayload\|export const ThreadAnalysisPayload" packages/protocol/src
grep -rn "export type CalendarLocalInput\|export const CalendarLocalInput" packages/protocol/src
```
Note the two file paths; use them in the imports in Step 4 (expected: a gmail types file and a calendar types file under `packages/protocol/src/types/`).

- [ ] **Step 2: Write the failing test**

Create `packages/protocol/src/service-methods.test.ts`:

```ts
import { describe, expect, it } from 'vitest'

import { serviceMethodArgSchemas } from './service-methods'
import type { ServiceMethod } from './service-methods'

describe('serviceMethodArgSchemas', () => {
  it('covers exactly the 45 service methods', () => {
    expect(Object.keys(serviceMethodArgSchemas)).toHaveLength(45)
  })

  it('accepts a full-arity call', () => {
    const r = serviceMethodArgSchemas.renameSession.safeParse(['s1', 'new title'])
    expect(r.success).toBe(true)
  })

  it('accepts omitted trailing optionals (short array)', () => {
    expect(serviceMethodArgSchemas.getSessionEntries.safeParse(['s1']).success).toBe(true)
    expect(serviceMethodArgSchemas.submitPrompt.safeParse(['s1', 'hello']).success).toBe(true)
    expect(serviceMethodArgSchemas.listMemory.safeParse([]).success).toBe(true)
  })

  it('accepts explicit undefined in optional slots', () => {
    expect(serviceMethodArgSchemas.getSessionEntries.safeParse(['s1', undefined]).success).toBe(true)
  })

  it('rejects wrong arity and wrong types', () => {
    expect(serviceMethodArgSchemas.renameSession.safeParse(['s1']).success).toBe(false)
    expect(serviceMethodArgSchemas.renameSession.safeParse([1, 2]).success).toBe(false)
    expect(serviceMethodArgSchemas.getSessionEntries.safeParse(['s1', 'not-a-number']).success).toBe(false)
  })

  it('rejects malformed complex objects', () => {
    expect(serviceMethodArgSchemas.saveAgent.safeParse([{ id: 'Bad Id!' }]).success).toBe(false)
    expect(serviceMethodArgSchemas.decidePermission.safeParse(['s1', 'a1', 'nope']).success).toBe(false)
  })

  it('accepts a valid mutating complex object', () => {
    const def = { id: 'my-agent', name: 'My Agent', description: 'Use when testing.', systemPrompt: 'x', maxIterations: 25 }
    expect(serviceMethodArgSchemas.saveAgent.safeParse([def]).success).toBe(true)
  })

  it('every method name round-trips as a ServiceMethod', () => {
    const methods = Object.keys(serviceMethodArgSchemas) as ServiceMethod[]
    expect(methods).toContain('submitPrompt')
    expect(methods).toContain('forkSession')
  })
})
```

- [ ] **Step 3: Run test to verify it fails**

Run: `npm test -- service-methods.test`
Expected: FAIL — cannot resolve `./service-methods`.

- [ ] **Step 4: Implement the table**

Create `packages/protocol/src/service-methods.ts`. Complete content (adjust ONLY the two import paths found in Step 1):

```ts
// Single source of truth for the main<->service RPC method table (both
// directions). ServiceClient and the service dispatcher are DERIVED from the
// artifacts here: adding a method means adding a signature + a schema entry —
// a missing or mismatched entry on either side is a compile error.
//
// One-way import rule: this file imports from ./types/*; no types/* file may
// import this one (prevents runtime cycles — the unions in types/service-ipc.ts
// are re-exports FROM here).
import { z } from 'zod'

import { AgentDefinitionSchema } from './types/agent'
import type { AgentDefinition, AgentListItem, AgentMutationResult } from './types/agent'
import { AnalyzeArticleRequest, ArticleSource } from './types/article'
import type {
  AnalyzeArticleResult,
  ArticleSummary,
  CollectArticleResult,
  CollectedArticleWithAnalysis,
} from './types/article'
import { AttachmentSchema } from './types/artifact'
import type { Attachment } from './types/artifact'
import type { AnalyzeBilibiliRequest, AnalyzeBilibiliResult } from './types/bilibili'
import { BudgetConfigSchema } from './types/budgets'
import type { BudgetConfig } from './types/budgets'
import type { CalendarLocalInput } from './types/calendar' // path from Task 1 Step 1
import { ExecutionModeSchema, PermissionModeSchema, SubmitOptionsSchema } from './types/execution'
import type { SubmitOptions } from './types/execution'
import type { ThreadAnalysisPayload } from './types/gmail' // path from Task 1 Step 1
import { McpServerConfigSchema } from './types/mcp'
import type { McpServerConfig, McpServerStatus } from './types/mcp'
import type { MemoryView } from './types/memory'
import { ProviderInjection } from './types/provider'
import type { EntryRow } from './types/session-entry'
import { SkillSchema } from './types/skill'
import type { Skill, SkillMutationResult } from './types/skill'
import type { ToolGroupInfo, ToolToggles } from './types/tool-toggles'
import { ResearchRepoRequest } from './types/trending'
import type { RepoResearch, ResearchRepoResult } from './types/trending'
import type {
  AnalyzeThreadRequest,
  AnalyzeThreadResult,
  CronJobSummary,
  CronRun,
  PermissionDecision,
  ScheduledTask,
  SessionSettings,
  SessionSummary,
} from './types/ui'
import type { UsageStats } from './types/usage'
import { WebSearchInjection } from './types/web-search'

// ---- schemas for types/ui.ts types that are type-only today --------------
// Defined here (not in types/ui.ts) to keep the one-way import rule.

const SessionSettingsSchema = z.object({
  cwd: z.string().optional(),
  permissionMode: PermissionModeSchema.optional(),
  executionMode: ExecutionModeSchema.optional(),
  agentType: z.string().optional(),
})

const PermissionDecisionSchema = z.enum(['grant', 'deny', 'skip', 'grant_always'])

const AnalyzeThreadRequestSchema = z.object({
  threadId: z.string(),
  subject: z.string(),
  messages: z.array(z.object({ from: z.string(), dateMs: z.number(), bodyText: z.string() })),
  provider: ProviderInjection,
})

const AnalyzeBilibiliRequestSchema = z.object({
  bvid: z.string(),
  provider: ProviderInjection,
  text: z.string(),
  title: z.string(),
  author: z.string(),
  source: z.enum(['subtitle', 'transcript']),
})

// ---- ServiceMethod: methods the service process serves -------------------

export type ServiceMethodSignatures = {
  createSession: { args: [ProviderInjection]; result: { sessionId: string } }
  forkSession: { args: [string, number]; result: { sessionId: string } }
  submitPrompt: { args: [string, string, Attachment[]?, SubmitOptions?]; result: { runId: string } }
  analyzeThread: { args: [AnalyzeThreadRequest]; result: AnalyzeThreadResult }
  collectArticle: { args: [ArticleSource]; result: CollectArticleResult }
  analyzeArticle: { args: [AnalyzeArticleRequest]; result: AnalyzeArticleResult }
  analyzeBilibili: { args: [AnalyzeBilibiliRequest]; result: AnalyzeBilibiliResult }
  listArticles: { args: []; result: CollectedArticleWithAnalysis[] }
  getArticleAnalysis: { args: [string]; result: { summary: ArticleSummary | null; analyzedAt: string | null } }
  deleteArticle: { args: [string]; result: void }
  researchRepo: { args: [ResearchRepoRequest]; result: ResearchRepoResult }
  getRepoResearch: { args: [string]; result: { research: RepoResearch | null; researchedAt: string | null } }
  researchedRepoNames: { args: []; result: string[] }
  listSessions: { args: []; result: SessionSummary[] }
  getSessionEntries: { args: [string, number?]; result: EntryRow[] }
  exportSessionMarkdown: { args: [string]; result: { path: string } }
  deleteSession: { args: [string]; result: { ok: true } }
  renameSession: { args: [string, string]; result: { ok: true } }
  setSessionPinned: { args: [string, boolean]; result: { ok: true } }
  updateSessionSettings: { args: [string, SessionSettings]; result: { ok: true } }
  reorderSessions: { args: [string[]]; result: { ok: true } }
  decidePermission: { args: [string, string, PermissionDecision]; result: { ok: true } }
  cancelRun: { args: [string]; result: { ok: true } }
  setMcpServers: { args: [McpServerConfig[]]; result: { ok: true } }
  getMcpStatus: { args: []; result: McpServerStatus[] }
  setWebSearchConfig: { args: [WebSearchInjection]; result: { ok: true } }
  setBudgetConfig: { args: [BudgetConfig]; result: { ok: true } }
  listSkills: { args: []; result: Skill[] }
  listAgents: { args: []; result: AgentListItem[] }
  saveAgent: { args: [AgentDefinition]; result: AgentMutationResult }
  deleteAgent: { args: [string]; result: AgentMutationResult }
  restoreDefaultAgents: { args: []; result: AgentMutationResult }
  saveSkill: { args: [Skill]; result: SkillMutationResult }
  deleteSkill: { args: [string]; result: SkillMutationResult }
  importSkill: { args: [string, boolean?]; result: SkillMutationResult }
  getToolToggles: { args: []; result: ToolToggles }
  setSkillEnabled: { args: [string, boolean]; result: ToolToggles }
  setToolGroupEnabled: { args: [string, boolean]; result: ToolToggles }
  listToolGroups: { args: []; result: ToolGroupInfo[] }
  listMemory: { args: [string?]; result: MemoryView[] }
  getUsageStats: { args: [number]; result: UsageStats }
  listCronJobsForSession: { args: [string]; result: CronJobSummary[] }
  listAllCronJobs: { args: []; result: ScheduledTask[] }
  listAllCronRuns: { args: []; result: CronRun[] }
  cancelCronJob: { args: [string]; result: { ok: true } }
}

export type ServiceMethod = keyof ServiceMethodSignatures

// Args validators, one per method — the mapped type makes a missing entry or
// an output/signature mismatch a compile error. Precision is graded: primitive
// args are exact; mutating complex objects use their real schemas; provider-
// shaped open payloads reuse the existing (already loose-ish) schema consts.
// Optional trailing args use plain .optional(): the dispatcher normalizes
// top-level null -> undefined before parsing (WS JSON turns undefined into
// null in arrays; no table method takes null as a meaningful top-level arg).
export const serviceMethodArgSchemas: {
  [M in ServiceMethod]: z.ZodType<ServiceMethodSignatures[M]['args']>
} = {
  createSession: z.tuple([ProviderInjection]),
  forkSession: z.tuple([z.string(), z.number()]),
  submitPrompt: z.tuple([z.string(), z.string().min(1), z.array(AttachmentSchema).optional(), SubmitOptionsSchema.optional()]),
  analyzeThread: z.tuple([AnalyzeThreadRequestSchema]),
  collectArticle: z.tuple([ArticleSource]),
  analyzeArticle: z.tuple([AnalyzeArticleRequest]),
  analyzeBilibili: z.tuple([AnalyzeBilibiliRequestSchema]),
  listArticles: z.tuple([]),
  getArticleAnalysis: z.tuple([z.string()]),
  deleteArticle: z.tuple([z.string()]),
  researchRepo: z.tuple([ResearchRepoRequest]),
  getRepoResearch: z.tuple([z.string()]),
  researchedRepoNames: z.tuple([]),
  listSessions: z.tuple([]),
  getSessionEntries: z.tuple([z.string(), z.number().optional()]),
  exportSessionMarkdown: z.tuple([z.string()]),
  deleteSession: z.tuple([z.string()]),
  renameSession: z.tuple([z.string(), z.string()]),
  setSessionPinned: z.tuple([z.string(), z.boolean()]),
  updateSessionSettings: z.tuple([z.string(), SessionSettingsSchema]),
  reorderSessions: z.tuple([z.array(z.string())]),
  decidePermission: z.tuple([z.string(), z.string(), PermissionDecisionSchema]),
  cancelRun: z.tuple([z.string()]),
  setMcpServers: z.tuple([z.array(McpServerConfigSchema)]),
  getMcpStatus: z.tuple([]),
  setWebSearchConfig: z.tuple([WebSearchInjection]),
  setBudgetConfig: z.tuple([BudgetConfigSchema]),
  listSkills: z.tuple([]),
  listAgents: z.tuple([]),
  saveAgent: z.tuple([AgentDefinitionSchema]),
  deleteAgent: z.tuple([z.string()]),
  restoreDefaultAgents: z.tuple([]),
  saveSkill: z.tuple([SkillSchema]),
  deleteSkill: z.tuple([z.string()]),
  importSkill: z.tuple([z.string(), z.boolean().optional()]),
  getToolToggles: z.tuple([]),
  setSkillEnabled: z.tuple([z.string(), z.boolean()]),
  setToolGroupEnabled: z.tuple([z.string(), z.boolean()]),
  listToolGroups: z.tuple([]),
  listMemory: z.tuple([z.string().optional()]),
  getUsageStats: z.tuple([z.number()]),
  listCronJobsForSession: z.tuple([z.string()]),
  listAllCronJobs: z.tuple([]),
  listAllCronRuns: z.tuple([]),
  cancelCronJob: z.tuple([z.string()]),
}

// ---- MainMethod: methods only Main serves (called by the service) --------
// Args are the contract (typed below); results stay `unknown` in this pass —
// today's callers cast results at the call site, and WS peers can never reach
// these handlers (the bridge only forwards peer requests INTO the service
// process), so there is no runtime schema table for this direction.

export type MainMethodSignatures = {
  'gmail.search': { args: [string, number?]; result: unknown }
  'gmail.get_thread': { args: [string]; result: unknown }
  'gmail.list_recent': { args: [{ limit?: number; label?: string }?]; result: unknown }
  'gmail.save_thread_analysis': { args: [string, ThreadAnalysisPayload]; result: unknown }
  'bilibili.save_analysis': { args: [string, unknown]; result: unknown }
  'calendar.list_upcoming': { args: [number?]; result: unknown }
  'calendar.get_event': { args: [string]; result: unknown }
  'calendar.create_local': { args: [CalendarLocalInput]; result: unknown }
  'calendar.update_local': { args: [string, Partial<CalendarLocalInput>]; result: unknown }
  'calendar.delete_local': { args: [string]; result: unknown }
  'weather.get_forecast': { args: [number, number]; result: unknown }
}

export type MainMethod = keyof MainMethodSignatures

// The service-side "call out to main" function shape (tools, analyzers).
export type CallMainFn = <M extends MainMethod>(method: M, args: MainMethodSignatures[M]['args']) => Promise<unknown>
```

If `z.ZodType<...>` assignment fails for a specific entry (zod 4 tuple optional-element inference), apply the spec's fallback for that entry only: keep the required prefix in `z.tuple([...])` and validate the optional tail with `.rest(z.unknown())`, leaving the signature type authoritative.

- [ ] **Step 5: Rewire `types/service-ipc.ts`**

In `packages/protocol/src/types/service-ipc.ts`, delete the two union definitions (`export type ServiceMethod = ...` lines 12–57 and `export type MainMethod = ...` lines 61–72) and replace with:

```ts
// The method unions now live in the single-source table (service-methods.ts);
// re-exported here so existing imports keep working.
export type { MainMethod, ServiceMethod } from '../service-methods'
import type { MainMethod, ServiceMethod } from '../service-methods'
```

Keep `RpcMethod = ServiceMethod | MainMethod` and everything below it unchanged.

- [ ] **Step 6: Export the new module**

In `packages/protocol/src/index.ts`, add (matching the file's existing export style):

```ts
export * from './service-methods'
```

- [ ] **Step 7: Run tests + typecheck**

Run: `npm test -- service-methods.test` → Expected: PASS (all cases).
Run: `npm test -- service-ipc.test` → Expected: PASS (existing assignability test still holds).
Run: `find . -name '*.tsbuildinfo' -not -path '*/node_modules/*' -delete && pnpm typecheck` → Expected: clean.

- [ ] **Step 8: Commit**

```bash
git add packages/protocol/src/service-methods.ts packages/protocol/src/service-methods.test.ts packages/protocol/src/types/service-ipc.ts packages/protocol/src/index.ts
git commit -m "feat(protocol): single-source RPC method table with per-method arg schemas"
```

---

### Task 2: Generate `ServiceClient` from the table

**Files:**
- Modify: `packages/protocol/src/service-client.ts` (full rewrite below)
- Test: `packages/protocol/src/service-client.test.ts` (create)

**Interfaces:**
- Consumes: `ServiceMethodSignatures`, `ServiceMethod`, `serviceMethodArgSchemas`, `MainMethodSignatures`, `MainMethod` (Task 1); `createRpcPeer`/`RpcTransport` (rpc-peer.ts, unchanged).
- Produces: `ServiceClient` type (same member names as today; the 11 fire-and-forget members change from `Promise<void>` to `Promise<{ ok: true }>` — callers only `await` them, so no call-site edits), `createServiceClient(cfg)` (same config shape), `ServiceTransport` alias (unchanged).

- [ ] **Step 1: Write the failing test**

Create `packages/protocol/src/service-client.test.ts`:

```ts
import { describe, expect, it } from 'vitest'

import { createServiceClient } from './service-client'
import { serviceMethodArgSchemas } from './service-methods'

type Sent = { kind: string; id: string; method: string; args: unknown[] }

function fakeTransport() {
  const sent: Sent[] = []
  let listener: ((m: unknown) => void) | null = null
  return {
    sent,
    emit: (m: unknown) => listener?.(m),
    transport: {
      postMessage: (m: unknown) => sent.push(m as Sent),
      on: (_c: 'message', l: (m: unknown) => void) => {
        listener = l
      },
      off: () => {
        listener = null
      },
    },
  }
}

describe('createServiceClient (generated)', () => {
  it('exposes one function per table method', () => {
    const { transport } = fakeTransport()
    const client = createServiceClient({ transport }) as unknown as Record<string, unknown>
    for (const m of Object.keys(serviceMethodArgSchemas)) {
      expect(typeof client[m], m).toBe('function')
    }
  })

  it('sends the table method name and raw args on the wire, resolves on response', async () => {
    const ft = fakeTransport()
    const client = createServiceClient({ transport: ft.transport })
    await client.connect()
    const p = client.renameSession('s1', 'new title')
    expect(ft.sent).toHaveLength(1)
    expect(ft.sent[0]).toMatchObject({ kind: 'request', method: 'renameSession', args: ['s1', 'new title'] })
    ft.emit({ kind: 'response', id: ft.sent[0].id, ok: true, result: { ok: true } })
    await expect(p).resolves.toEqual({ ok: true })
  })

  it('omits trailing optionals from the wire args (short array)', async () => {
    const ft = fakeTransport()
    const client = createServiceClient({ transport: ft.transport })
    await client.connect()
    void client.getSessionEntries('s1')
    expect(ft.sent[0]).toMatchObject({ method: 'getSessionEntries', args: ['s1'] })
  })

  it('rejects the pending call on an error response', async () => {
    const ft = fakeTransport()
    const client = createServiceClient({ transport: ft.transport })
    await client.connect()
    const p = client.listSessions()
    ft.emit({ kind: 'response', id: ft.sent[0].id, ok: false, error: 'boom' })
    await expect(p).rejects.toThrow('boom')
  })
})
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npm test -- service-client.test`
Expected: FAIL — today's hand-written `submitPrompt` always sends 4-element args, and there is no test file yet; the suite fails on the short-array expectation once the file exists. (Initial run fails simply because the generated behavior doesn't exist.)

- [ ] **Step 3: Rewrite `service-client.ts`**

Replace the entire file with:

```ts
import { createRpcPeer, type RpcTransport } from './rpc-peer'
import { serviceMethodArgSchemas } from './service-methods'
import type { MainMethod, MainMethodSignatures, ServiceMethod, ServiceMethodSignatures } from './service-methods'

// Kept as an alias so existing imports of ServiceTransport (desktop main,
// extension, RN) don't need to change.
export type ServiceTransport = RpcTransport

// The 45 RPC members are derived from the method table — adding a method to
// service-methods.ts adds it here automatically. Fire-and-forget methods now
// surface the wire-truth `{ ok: true }` result (previously typed void);
// callers that only await are unaffected.
export type ServiceClient = {
  [M in ServiceMethod]: (...args: ServiceMethodSignatures[M]['args']) => Promise<ServiceMethodSignatures[M]['result']>
} & {
  connect(): Promise<void>
  disconnect(): void
  // Registers a handler this side can serve for the other side's call() — e.g.
  // main registers 'weather.get_forecast' so the service process can call it.
  // Args are typed from the table; results stay unknown in this pass (callers
  // cast at the call site, as before).
  registerHandler<M extends MainMethod>(
    method: M,
    fn: (...args: MainMethodSignatures[M]['args']) => unknown | Promise<unknown>
  ): void
}

export function createServiceClient(cfg: {
  transport: ServiceTransport
  onEvent?: (event: string, data: unknown) => void
}): ServiceClient {
  const peer = createRpcPeer({
    transport: cfg.transport,
    onEvent: cfg.onEvent,
    // A request for a method nobody registered still gets an error response
    // (RpcPeer would do that on its own), but warn here first so the miss is
    // visible in this side's logs — a silent wrong-side dispatch is exactly
    // the bug class that made get_weather fall back to wttr.in. console, not
    // pino: @swarm/protocol stays logger-free for portability.
    defaultHandler: (method, _args, id) => {
      console.warn({ msg: 'no rpc handler', method, id })
      throw new Error(`no handler for ${method}`)
    },
  })

  const client: Record<string, unknown> = {
    connect: () => peer.connect(),
    disconnect: () => peer.disconnect(),
    registerHandler: (method: MainMethod, fn: (...args: unknown[]) => unknown) => peer.registerHandler(method, fn),
  }
  for (const method of Object.keys(serviceMethodArgSchemas) as ServiceMethod[]) {
    client[method] = (...args: unknown[]) => peer.call(method, args)
  }
  return client as unknown as ServiceClient
}
```

Note the behavior nuance the test pins: generated members are variadic, so `client.getSessionEntries('s1')` sends `args: ['s1']` (the old hand-written wrappers padded with `undefined`). Both shapes are legal for the dispatcher (optional tuple elements), but the short array is what WS-JSON round-trips cleanly.

- [ ] **Step 4: Run tests + typecheck**

Run: `npm test -- service-client.test` → Expected: PASS.
Run: `find . -name '*.tsbuildinfo' -not -path '*/node_modules/*' -delete && pnpm typecheck` → Expected: clean. If a caller of the 11 previously-`void` methods does anything with the resolved value other than awaiting it, the compiler will flag it — fix that call site to ignore the result (none are expected; verified callers only await).

- [ ] **Step 5: Commit**

```bash
git add packages/protocol/src/service-client.ts packages/protocol/src/service-client.test.ts
git commit -m "feat(protocol): generate ServiceClient members from the method table"
```

---

### Task 3: Dispatcher — switch → validated handler map

**Files:**
- Modify: `apps/desktop/src/service/ipc/dispatcher.ts` (full rewrite below; `DispatcherConfig` and the public `Dispatcher` type are unchanged)
- Modify: `apps/desktop/src/service/ipc/dispatcher.test.ts` (add validation cases; keep all existing cases)

**Interfaces:**
- Consumes: `serviceMethodArgSchemas`, `ServiceMethod`, `ServiceMethodSignatures` from `@swarm/protocol` (Task 1); `SessionService` (unchanged).
- Produces: `createDispatcher(cfg: DispatcherConfig): Dispatcher` with `Dispatcher = (method: ServiceMethod, args: unknown[]) => unknown` — identical to today, so `service/index.ts` needs no change.

- [ ] **Step 1: Add failing validation tests**

Append to `apps/desktop/src/service/ipc/dispatcher.test.ts` (reuse the file's existing mock `cfg`/`service` builders — read the file first and follow its fixture pattern):

```ts
describe('args validation', () => {
  it('rejects wrong arity with the method name in the error', () => {
    const dispatch = createDispatcher(cfg)
    expect(() => dispatch('renameSession', ['only-one'])).toThrow(/invalid args for renameSession/)
  })

  it('rejects wrong primitive types', () => {
    const dispatch = createDispatcher(cfg)
    expect(() => dispatch('renameSession', [1, 2])).toThrow(/invalid args for renameSession/)
  })

  it('rejects malformed complex objects', () => {
    const dispatch = createDispatcher(cfg)
    expect(() => dispatch('saveAgent', [{ id: 'Bad Id!' }])).toThrow(/invalid args for saveAgent/)
  })

  it('accepts omitted trailing optionals', () => {
    const dispatch = createDispatcher(cfg)
    dispatch('getSessionEntries', ['s1'])
    expect(service.getSessionEntries).toHaveBeenCalledWith('s1', undefined)
  })

  it('normalizes WS-JSON null to undefined for optional slots', () => {
    const dispatch = createDispatcher(cfg)
    dispatch('getSessionEntries', ['s1', null])
    expect(service.getSessionEntries).toHaveBeenCalledWith('s1', undefined)
  })

  it('still throws on unknown methods', () => {
    const dispatch = createDispatcher(cfg)
    expect(() => dispatch('nope' as never, [])).toThrow(/unknown method/)
  })
})
```

- [ ] **Step 2: Run to verify the new cases fail**

Run: `npm test -- dispatcher.test`
Expected: the new `args validation` cases FAIL (today's switch casts blindly — wrong-arity/typed calls reach the mock instead of throwing); existing cases PASS.

- [ ] **Step 3: Rewrite the dispatcher**

In `apps/desktop/src/service/ipc/dispatcher.ts`: keep the header comment, the imports, and `DispatcherConfig` exactly as they are (add `serviceMethodArgSchemas` and `ServiceMethodSignatures` to the `@swarm/protocol` import, and change the zod-free import list accordingly — `serviceMethodArgSchemas` is a value import). Replace `createDispatcher` and add `ServiceHandlers`:

```ts
export type Dispatcher = (method: ServiceMethod, args: unknown[]) => unknown

// One handler per table method; each body is compile-checked against the
// single-source signature (args AND result). Replaces the switch whose arms
// cast `args as [...]` blindly.
type ServiceHandlers = {
  [M in ServiceMethod]: (
    ...args: ServiceMethodSignatures[M]['args']
  ) => ServiceMethodSignatures[M]['result'] | Promise<ServiceMethodSignatures[M]['result']>
}

export function createDispatcher(cfg: DispatcherConfig): Dispatcher {
  const { service, registerProvider } = cfg
  const handlers: ServiceHandlers = {
    createSession: (provider) => {
      registerProvider(provider)
      return service.createSession(provider)
    },
    forkSession: (sourceSessionId, upToRowId) => service.forkSession(sourceSessionId, upToRowId),
    // Routes to SessionService.submitPrompt (entries-driven) and returns { runId }.
    submitPrompt: (sessionId, prompt, attachments, options) =>
      service.submitPrompt(sessionId, prompt, attachments, undefined, options),
    analyzeThread: (req) => cfg.analyzeThread(req),
    collectArticle: (input) => cfg.collectArticle(input),
    analyzeArticle: (req) => cfg.analyzeArticle(req),
    analyzeBilibili: (req) => cfg.analyzeBilibili(req),
    listArticles: () => cfg.listArticles(),
    getArticleAnalysis: (articleId) => cfg.getArticleAnalysis(articleId),
    deleteArticle: (articleId) => cfg.deleteArticle(articleId),
    researchRepo: (req) => cfg.researchRepo(req),
    getRepoResearch: (repoName) => cfg.getRepoResearch(repoName),
    researchedRepoNames: () => cfg.researchedRepoNames(),
    listSessions: () => service.listSessions(),
    getSessionEntries: (sessionId, afterRowId) => service.getSessionEntries(sessionId, afterRowId),
    exportSessionMarkdown: (sessionId) => service.exportSessionMarkdown(sessionId),
    deleteSession: (sessionId) => {
      service.deleteSession(sessionId)
      return { ok: true } as const
    },
    renameSession: (sessionId, title) => {
      service.renameSession(sessionId, title)
      return { ok: true } as const
    },
    setSessionPinned: (sessionId, pinned) => {
      service.setSessionPinned(sessionId, pinned)
      return { ok: true } as const
    },
    updateSessionSettings: (sessionId, settings) => {
      service.updateSessionSettings(sessionId, settings)
      return { ok: true } as const
    },
    reorderSessions: (orderedIds) => {
      service.reorderSessions(orderedIds)
      return { ok: true } as const
    },
    decidePermission: (sessionId, actionId, decision) => {
      service.resolvePermission(sessionId, actionId, decision)
      return { ok: true } as const
    },
    cancelRun: (sessionId) => {
      service.cancelRun(sessionId)
      return { ok: true } as const
    },
    setMcpServers: (configs) => cfg.setMcpServers(configs).then(() => ({ ok: true }) as const),
    getMcpStatus: () => cfg.getMcpStatus(),
    setWebSearchConfig: (config) => {
      cfg.setWebSearchConfig(config)
      return { ok: true } as const
    },
    setBudgetConfig: (config) => {
      cfg.setBudgetConfig(config)
      return { ok: true } as const
    },
    listSkills: () => cfg.listSkills(),
    listAgents: () => cfg.listAgents(),
    saveAgent: (def) => cfg.saveAgent(def),
    deleteAgent: (id) => cfg.deleteAgent(id),
    restoreDefaultAgents: () => cfg.restoreDefaultAgents(),
    saveSkill: (skill) => cfg.saveSkill(skill),
    deleteSkill: (name) => cfg.deleteSkill(name),
    importSkill: (sourceDir, overwrite) => cfg.importSkill(sourceDir, overwrite),
    getToolToggles: () => cfg.getToolToggles(),
    setSkillEnabled: (name, enabled) => cfg.setSkillEnabled(name, enabled),
    setToolGroupEnabled: (group, enabled) => cfg.setToolGroupEnabled(group, enabled),
    listToolGroups: () => cfg.listToolGroups(),
    listMemory: (namespace) => cfg.listMemory(namespace),
    getUsageStats: (rangeDays) => service.getUsageStats(rangeDays),
    listCronJobsForSession: (sessionId) => cfg.listCronJobsForSession(sessionId),
    listAllCronJobs: () => cfg.listAllCronJobs(),
    listAllCronRuns: () => cfg.listAllCronRuns(),
    cancelCronJob: (id) => {
      cfg.cancelCronJob(id)
      return { ok: true } as const
    },
  }

  return (method, args) => {
    const schema = serviceMethodArgSchemas[method]
    if (!schema) throw new Error(`unknown method: ${String(method)}`)
    // WS clients JSON.stringify their frames, turning omitted trailing
    // optionals (undefined) into null. No table method takes null as a
    // meaningful top-level arg, so normalize before validation; nested nulls
    // inside objects are governed by each schema.
    const normalized = args.map((a) => (a === null ? undefined : a))
    const parsed = schema.safeParse(normalized)
    if (!parsed.success) {
      const issue = parsed.error.issues[0]
      throw new Error(
        `invalid args for ${method}: ${issue ? `${issue.path.join('.') || '(root)'} ${issue.message}` : 'invalid'}`
      )
    }
    // Correlated-union call: TS cannot prove handlers[method] accepts
    // parsed.data for the same M — the single documented cast at the choke point.
    return (handlers[method] as (...a: unknown[]) => unknown)(...parsed.data)
  }
}
```

Delete the old switch body entirely. The `analyzeThread`/`collectArticle`/etc. members of `DispatcherConfig` keep their existing declared types.

- [ ] **Step 4: Run tests**

Run: `npm test -- dispatcher.test`
Expected: PASS — all pre-existing cases plus the six new validation cases. If a pre-existing case fails because it called `dispatch` with malformed args that the old switch tolerated, fix the TEST to use table-legal args (that enforcement is the point of this change) and note it in the commit body.

- [ ] **Step 5: Run the service suite + typecheck**

Run: `npm test -- apps/desktop/src/service` → Expected: PASS (notably the session/permission integration tests).
Run: `find . -name '*.tsbuildinfo' -not -path '*/node_modules/*' -delete && pnpm typecheck` → Expected: clean.

- [ ] **Step 6: Commit**

```bash
git add apps/desktop/src/service/ipc/dispatcher.ts apps/desktop/src/service/ipc/dispatcher.test.ts
git commit -m "feat(service): dispatcher as table-derived handler map with zod args validation"
```

---

### Task 4: Tighten MainMethod consumers (typed registerHandler/callMain)

**Files:**
- Modify: `apps/desktop/src/main/gmail/ipc.ts`, `apps/desktop/src/main/calendar/ipc.ts`, `apps/desktop/src/main/weather/ipc.ts` (their local `RpcHandlers` types)
- Modify: `apps/desktop/src/service/index.ts` (type the `callMain` lambdas), `apps/desktop/src/service/gmail/analyze-thread.ts:24`, `apps/desktop/src/service/bilibili/analyze.ts:20` (replace local `CallMain` aliases), plus the `callMain` dep type in `apps/desktop/src/service/tools/builtins.ts`
- Possibly touched by typecheck fallout: `apps/desktop/src/main/{gmail,calendar,weather,bilibili}/index.ts` local structural client types

**Interfaces:**
- Consumes: `MainMethodSignatures`, `MainMethod`, `CallMainFn` (Task 1); typed `registerHandler` (Task 2).
- Produces: no new exports — this task converts `(...args: unknown[])` main-handler and `callMain` types to table-derived ones.

- [ ] **Step 1: Tighten the per-module `RpcHandlers` types**

In each of `gmail/ipc.ts`, `calendar/ipc.ts`, `weather/ipc.ts`, find the local `RpcHandlers` type (grep `type RpcHandlers`) and replace its value shape with the table-derived one. Pattern (gmail shown; use `calendar.` / `weather.` prefixes in the others):

```ts
import type { MainMethod, MainMethodSignatures } from '@swarm/protocol'

type GmailMethod = Extract<MainMethod, `gmail.${string}`>
export type RpcHandlers = {
  [M in GmailMethod]: (...args: MainMethodSignatures[M]['args']) => Promise<unknown>
}
```

Then remove the now-redundant runtime coercions the compiler flags as unnecessary casts — but ONLY where the compiler flags them; defensive `String(...)`/`Number(...)` calls that still typecheck stay untouched (surgical-change rule).

- [ ] **Step 2: Replace service-side `CallMain` aliases**

In `apps/desktop/src/service/gmail/analyze-thread.ts` and `apps/desktop/src/service/bilibili/analyze.ts`, delete the local `CallMain` type and import `CallMainFn` from `@swarm/protocol`, using it for the dep field. In `apps/desktop/src/service/index.ts` and `apps/desktop/src/service/tools/builtins.ts`, type the `callMain` lambdas/deps as `CallMainFn`:

```ts
const callMain: CallMainFn = (method, args) => rpcPeer.call(method, args)
```

- [ ] **Step 3: Reconcile call sites**

Run: `grep -rn "callMain(" apps/desktop/src/service --include='*.ts' | grep -v '\.test\.'`
For each call site, confirm the args array matches `MainMethodSignatures` (they already do at runtime; the compiler now checks). Fix any mismatch the typechecker reports — expected zero to few.

- [ ] **Step 4: Typecheck + full main/service tests**

Run: `find . -name '*.tsbuildinfo' -not -path '*/node_modules/*' -delete && pnpm typecheck` → Expected: clean.
Run: `npm test -- apps/desktop/src/main apps/desktop/src/service` → Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add -u apps/desktop/src/main apps/desktop/src/service
git commit -m "refactor(main,service): derive MainMethod handler and callMain types from the table"
```

(`git add -u` stages modified tracked files only — safe against turbo's stray emitted `.js`, which are untracked.)

---

### Task 5: Full regression + format

**Files:**
- No new files; possible formatting-only diffs on files touched in Tasks 1–4.

- [ ] **Step 1: Format touched files only**

```bash
npx biome check --write \
  packages/protocol/src/service-methods.ts packages/protocol/src/service-methods.test.ts \
  packages/protocol/src/service-client.ts packages/protocol/src/service-client.test.ts \
  packages/protocol/src/types/service-ipc.ts packages/protocol/src/index.ts \
  apps/desktop/src/service/ipc/dispatcher.ts apps/desktop/src/service/ipc/dispatcher.test.ts
```
(Also include the Task 4 files if biome flags them.)

- [ ] **Step 2: Full test suite**

Run: `npm test`
Expected: PASS, except the 6 pre-existing rail/weather failures from the workbench merge (known on develop — compare against a develop baseline if unsure; do NOT fix them here).

- [ ] **Step 3: Full typecheck**

Run: `find . -name '*.tsbuildinfo' -not -path '*/node_modules/*' -delete && pnpm typecheck`
Expected: clean.

- [ ] **Step 4: Commit any formatting deltas**

```bash
git add -u packages/protocol apps/desktop/src/service apps/desktop/src/main
git status --short   # verify: only intended files staged, no stray .js/.d.ts
git commit -m "style: biome format for method-table changes" || echo "nothing to format"
```

- [ ] **Step 5: Hand off**

Do not merge in this task. Integration follows the finishing-a-development-branch flow: rebase onto develop + `git merge --ff-only` (per project convention), after verifying the MAIN checkout's `git status` is clean.
