# Renderer-IPC Single-Sourcing — Plan 1 (Mechanism + First Domains)

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build the renderer→main IPC signature tables + typed consumers (`invoke`/`subscribe` in preload, `createIpcRegistrar`/`sendToAllWindows` in main) and migrate the first six domains (swarm-ipc, article, trending, quick-panel, deep-link, index.ts inline).

**Architecture:** A type-only `RendererIpcSignatures`/`RendererIpcEvents` table in `@swarm/protocol` (per spec `docs/superpowers/specs/2026-07-17-renderer-ipc-single-source-design.md`); pure service passthroughs reference `ServiceMethodSignatures` via `Passthrough<M>`. Preload members and main handlers for migrated domains route through typed helpers; unmigrated domains (bilibili, gmail, calendar, providers, mcp, web-search, budgets, weather, workbench) keep raw calls until Plans 2/3.

**Tech Stack:** TypeScript 5.9, Electron ipcMain/ipcRenderer, vitest, pnpm + turbo monorepo.

## Global Constraints

- Work ONLY inside the worktree `/Users/gaozimeng/Learn/macOS/SwarmAgents/.claude/worktrees/renderer-ipc-single-source` (node_modules symlinked — never `pnpm install`/`rebuild`).
- Channel strings are FROZEN — copy verbatim from existing code; renaming is a defect.
- `window.swarm` bridge shape, `index.d.ts`, `swarmApi`, and all renderer files are untouched in this plan.
- `renderer-ipc.ts` is type-only: `import type` everywhere, no runtime values, no zod.
- Tests: `npm test -- <filter>` from the worktree root; if pnpm's `verifyDepsBeforeRun` wall appears, run through pnpm with `--config.verifyDepsBeforeRun=false` (prior branch hit this). Never plain `npx vitest` for suites touching better-sqlite3.
- Typecheck: `find . -name '*.tsbuildinfo' -not -path '*/node_modules/*' -delete && pnpm typecheck` (`apps/extension` may need `npx wxt prepare` once — pre-existing). Turbo emits stray `.js`/`.d.ts` under `apps/desktop/src` — never `git add -A`; stage exact paths.
- All code comments and commit messages in English. Format only touched files: `npx biome check --write <file...>`.

---

### Task 1: Channel inventory (authoritative strings for all three plans)

**Files:**
- Create: `docs/superpowers/specs/2026-07-17-renderer-ipc-channel-inventory.md`

**Interfaces:**
- Produces: the committed inventory doc — exact channel strings per domain (invoke + event), each with its handler file:line and preload member. Tasks 2/4 use it to verify entries; Plans 2/3 consume it wholesale.

- [ ] **Step 1: Extract the raw lists**

Run from the worktree root (plain `grep`, not through any wrapper that rewrites paths):

```bash
grep -rn "ipcMain.handle(" apps/desktop/src/main --include='*.ts' | grep -v '\.test\.' > /tmp/handles.txt
grep -n "ipcRenderer.invoke(" apps/desktop/src/preload/index.ts > /tmp/invokes.txt
grep -n "ipcRenderer.on(" apps/desktop/src/preload/index.ts > /tmp/subs.txt
grep -rn "webContents.send(" apps/desktop/src/main --include='*.ts' | grep -v '\.test\.' > /tmp/sends.txt
grep -rn "_CHANNEL = '\|_CHANNEL_ = '\|CHANNEL: '\|= 'swarm:\|= 'system:" apps/desktop/src/main apps/desktop/src/preload --include='*.ts' | grep -v '\.test\.' > /tmp/consts.txt
wc -l /tmp/handles.txt /tmp/invokes.txt /tmp/subs.txt /tmp/sends.txt
```

- [ ] **Step 2: Write the inventory doc**

Create `docs/superpowers/specs/2026-07-17-renderer-ipc-channel-inventory.md` with one table per domain (swarm-ipc, system, article, trending, quick-panel, deep-link, bilibili, providers, gmail, calendar, mcp-servers, web-search, budgets, weather, workbench), columns: `channel | handler file:line | preload member | notes`. Resolve every channel referenced through a constant (`PROVIDERS_STATE_CHANNEL` etc.) to its literal string using /tmp/consts.txt. Add a final **Reconciliation** section listing:
- preload invokes with no matching `ipcMain.handle` (each is a latent dead call — list, do not fix),
- handles with no preload caller (main-only or WS-era leftovers — list, do not fix),
- all event channels (`webContents.send` / `ipcRenderer.on`) with their literal strings and payload types (read the sender call site for the payload shape).

Every row must carry a real file:line — no guessed strings.

- [ ] **Step 3: Verify counts reconcile**

The doc's totals must equal the `wc -l` numbers from Step 1 (each grep hit appears in exactly one table row or the Reconciliation section). If a hit is unaccounted for, the doc is incomplete — fix before committing.

- [ ] **Step 4: Commit**

```bash
git add docs/superpowers/specs/2026-07-17-renderer-ipc-channel-inventory.md
git commit -m "docs: renderer-main IPC channel inventory (authoritative strings for plans 1-3)"
```

---

### Task 2: Signature tables in protocol + type tests

**Files:**
- Create: `packages/protocol/src/renderer-ipc.ts`
- Modify: `packages/protocol/src/index.ts` (add `export * from './renderer-ipc'`)
- Test: `packages/protocol/src/renderer-ipc.test.ts`

**Interfaces:**
- Consumes: `ServiceMethod`, `ServiceMethodSignatures` from `./service-methods`; types from `./types/*`; the Task 1 inventory doc (verify every channel string below against it — the inventory wins on any mismatch, and quick-panel hotkey channels plus the six `*_CHANNEL` const values MUST be taken from it).
- Produces: `RendererIpcSignatures`, `RendererIpcChannel`, `RendererIpcEvents`, `RendererIpcEventChannel` — consumed by Tasks 3–6 and Plans 2/3.

- [ ] **Step 1: Write the failing type test**

Create `packages/protocol/src/renderer-ipc.test.ts`:

```ts
import { describe, expectTypeOf, it } from 'vitest'

import type { RendererIpcEvents, RendererIpcSignatures } from './renderer-ipc'
import type { ServiceMethodSignatures } from './service-methods'
import type { UIEvent } from './types/ui'

describe('RendererIpcSignatures', () => {
  it('passthrough entries mirror the service table exactly', () => {
    expectTypeOf<RendererIpcSignatures['swarm:listSessions']>().toEqualTypeOf<ServiceMethodSignatures['listSessions']>()
    expectTypeOf<RendererIpcSignatures['skills:list']>().toEqualTypeOf<ServiceMethodSignatures['listSkills']>()
    expectTypeOf<RendererIpcSignatures['swarm:submitPrompt']>().toEqualTypeOf<ServiceMethodSignatures['submitPrompt']>()
  })

  it('main-transformed entries diverge deliberately from the service table', () => {
    // createSession: renderer sends no args; main injects the provider.
    expectTypeOf<RendererIpcSignatures['swarm:createSession']['args']>().toEqualTypeOf<[]>()
    // cancelRun: main swallows errors and resolves void (not { ok: true }).
    expectTypeOf<RendererIpcSignatures['swarm:cancelRun']['result']>().toEqualTypeOf<void>()
  })

  it('event payloads are typed', () => {
    expectTypeOf<RendererIpcEvents['swarm:event']>().toEqualTypeOf<UIEvent>()
    expectTypeOf<RendererIpcEvents['system:accentChange']>().toEqualTypeOf<{ hex: string }>()
  })
})
```

- [ ] **Step 2: Run to verify it fails**

Run: `npm test -- renderer-ipc.test`
Expected: FAIL — cannot resolve `./renderer-ipc`.

- [ ] **Step 3: Implement the tables**

Create `packages/protocol/src/renderer-ipc.ts`. The Plan-1 entries below are complete; verify each string against the Task 1 inventory before writing (inventory wins). Plans 2/3 append their domains to these same types.

```ts
// Single source of truth for the renderer->main IPC surface (desktop only).
// Type-only: no runtime values. Channel strings are frozen — they must match
// the literals in preload/index.ts and the main-process handle sites verbatim.
// Growth rule: each migration plan appends its domain's entries; a channel
// appears here if and only if a typed consumer (preload invoke / registrar
// handle) uses it.
import type { ServiceMethod, ServiceMethodSignatures } from './service-methods'
import type { ArtifactEntry } from './types/artifact'
import type { AnalyzeArticleResult } from './types/article'
import type { BiliTranscribeProgress } from './types/bilibili'
import type { McpServerStatus } from './types/mcp'
import type { Skill, SkillMutationResult } from './types/skill'
import type { ResearchRepoResult, TrendingPeriod, TrendingRepo } from './types/trending'
import type {
  AnalyzeThreadInput,
  AnalyzeThreadResult,
  MacPermissions,
  UIEvent,
} from './types/ui'

// A channel that forwards verbatim to the service: same args, same result.
// Service signature changes propagate here without touching this file.
type Passthrough<M extends ServiceMethod> = ServiceMethodSignatures[M]

export type RendererIpcSignatures = {
  // ---- ipc/swarm-ipc.ts ----
  'mcp:getStatus': Passthrough<'getMcpStatus'>
  'skills:list': Passthrough<'listSkills'>
  'agents:list': Passthrough<'listAgents'>
  'skills:save': Passthrough<'saveSkill'>
  'skills:delete': Passthrough<'deleteSkill'>
  'agents:save': Passthrough<'saveAgent'>
  'agents:delete': Passthrough<'deleteAgent'>
  'agents:restore-defaults': Passthrough<'restoreDefaultAgents'>
  // Dialog flow when sourceDir is absent; echoes sourceDir on a name clash.
  'skills:import': {
    args: [{ sourceDir?: string; overwrite?: boolean }?]
    result: SkillMutationResult | { ok: false; code: 'cancelled' | 'exists'; message: string; sourceDir?: string }
  }
  'memory:list': Passthrough<'listMemory'>
  'toolToggles:get': Passthrough<'getToolToggles'>
  'toolToggles:setSkill': Passthrough<'setSkillEnabled'>
  'toolToggles:setToolGroup': Passthrough<'setToolGroupEnabled'>
  'tools:listGroups': Passthrough<'listToolGroups'>
  'swarm:createSession': { args: []; result: { sessionId: string } } // main injects provider
  'swarm:forkSession': Passthrough<'forkSession'>
  'swarm:analyzeThread': { args: [AnalyzeThreadInput]; result: AnalyzeThreadResult } // main injects provider
  'swarm:listSessions': Passthrough<'listSessions'>
  'swarm:getSessionEntries': Passthrough<'getSessionEntries'>
  'swarm:getUsageStats': Passthrough<'getUsageStats'>
  'swarm:deleteSession': Passthrough<'deleteSession'>
  'swarm:renameSession': Passthrough<'renameSession'>
  'swarm:setSessionPinned': Passthrough<'setSessionPinned'>
  'swarm:updateSessionSettings': Passthrough<'updateSessionSettings'>
  'swarm:reorderSessions': Passthrough<'reorderSessions'>
  'swarm:submitPrompt': Passthrough<'submitPrompt'>
  // Main catches serviceClient errors and resolves void (fire-and-forget).
  'swarm:cancelRun': { args: [string]; result: void }
  'swarm:decidePermission': { args: [string, string, import('./types/ui').PermissionDecision]; result: void }
  'swarm:listCronJobsForSession': Passthrough<'listCronJobsForSession'>
  'swarm:listAllCronJobs': Passthrough<'listAllCronJobs'>
  'swarm:listAllCronRuns': Passthrough<'listAllCronRuns'>
  'swarm:cancelCronJob': Passthrough<'cancelCronJob'>
  'swarm:exportSessionMarkdown': Passthrough<'exportSessionMarkdown'>
  'swarm:listArtifacts': { args: [{ query?: string; limit?: number }?]; result: ArtifactEntry[] }
  // ---- system (ipc/swarm-ipc.ts + index.ts) ----
  'system:getAccent': { args: []; result: string | null }
  'system:readImageFile': { args: [string]; result: { mimeType: string; data: string } | null }
  'system:readDocumentFile': { args: [string]; result: { mediaType: string; data: string } | null }
  'system:openPath': { args: [string]; result: void }
  'system:openUserDataDir': { args: []; result: void }
  'system:pickPath': { args: ['directory' | 'file']; result: string | null }
  'system:listDir': { args: [string, string?]; result: { name: string; isDir: boolean }[] }
  'system:getMacPermissions': { args: []; result: MacPermissions }
  'system:openPrivacySettings': { args: ['screen' | 'accessibility']; result: void }
  'system:getWsHostConfig': { args: []; result: { port: number; token: string; lanIp: string | null } | null }
  // ---- ipc/article-ipc.ts ----
  'swarm:article:list': Passthrough<'listArticles'>
  'swarm:article:analyze': { args: [string]; result: AnalyzeArticleResult } // main injects provider
  'swarm:article:getAnalysis': Passthrough<'getArticleAnalysis'>
  'swarm:article:delete': Passthrough<'deleteArticle'>
  // ---- trending/ipc.ts ----
  'trending:get': { args: [TrendingPeriod, string]; result: TrendingRepo[] }
  'trending:research': { args: [TrendingRepo, TrendingPeriod]; result: ResearchRepoResult } // main injects provider
  'trending:getResearch': Passthrough<'getRepoResearch'>
  'trending:researchedNames': Passthrough<'researchedRepoNames'>
  // ---- quick-panel/ipc.ts (verify all four strings against the inventory) ----
  'swarm:quickPanel:hide': { args: []; result: void }
  'swarm:quickPanel:focusMain': { args: [{ navigate?: string; settings?: string }]; result: void }
  'swarm:quickPanel:getHotkey': { args: []; result: string }
  'swarm:quickPanel:setHotkey': { args: [string]; result: { ok: boolean } }
  // ---- system/deep-link.ts ----
  'swarm:consumePendingDeepLink': { args: []; result: { sessionId: string } | null }
}
export type RendererIpcChannel = keyof RendererIpcSignatures

// All 14 event channels land in Plan 1 (spec §4). The six *_CHANNEL const
// literals and the two payload types marked below MUST be transcribed from the
// Task 1 inventory doc — the strings here are the expected values to verify.
export type RendererIpcEvents = {
  'swarm:event': UIEvent
  'mcp:status': McpServerStatus[]
  'system:accentChange': { hex: string }
  'swarm:navigate': { sessionId?: string; route?: string }
  'swarm:navigateToSettings': string // verify literal + payload against inventory
  'bilibili:transcribe:progress': BiliTranscribeProgress
  'gmail:stateChanged': import('./types/gmail').GmailConfigView // verify payload type name against sender
  'calendar:stateChanged': import('./types/calendar').CalendarConfigView
  'providers:stateChanged': import('./types/provider').ProvidersStateView // verify literal (PROVIDERS_STATE_CHANNEL)
  'mcp:configChanged': import('./types/mcp').McpServerConfig[] // verify literal (MCP_CONFIG_CHANGED_CHANNEL)
  'webSearch:stateChanged': import('./types/web-search').WebSearchConfigView // verify literal
  'weather:forecastChanged': import('./types/weather').WeatherConfigView // verify literal + payload
  'budgets:stateChanged': import('./types/budgets').BudgetConfig // verify literal
  'workbench:stateChanged': import('./types/workbench').WorkbenchData // verify literal
}
export type RendererIpcEventChannel = keyof RendererIpcEvents
```

Every `// verify` marker is an instruction to replace the guessed literal/payload with the inventory's authoritative value, then DELETE the marker comment. A remaining `verify` comment at commit time is a task failure.

- [ ] **Step 4: Export + run tests + typecheck**

Add `export * from './renderer-ipc'` to `packages/protocol/src/index.ts`.
Run: `npm test -- renderer-ipc.test` → Expected: PASS.
Run: `find . -name '*.tsbuildinfo' -not -path '*/node_modules/*' -delete && pnpm typecheck` → Expected: clean.

- [ ] **Step 5: Commit**

```bash
git add packages/protocol/src/renderer-ipc.ts packages/protocol/src/renderer-ipc.test.ts packages/protocol/src/index.ts
git commit -m "feat(protocol): renderer-main IPC signature tables (plan-1 domains + all event channels)"
```

---

### Task 3: Typed registrar + event sender in main

**Files:**
- Create: `apps/desktop/src/main/ipc/wire.ts`
- Test: `apps/desktop/src/main/ipc/wire.test.ts`

**Interfaces:**
- Consumes: `RendererIpcSignatures`, `RendererIpcChannel`, `RendererIpcEvents`, `RendererIpcEventChannel` from `@swarm/protocol` (Task 2).
- Produces: `createIpcRegistrar(): { handle<C>(channel, fn): void; dispose(): void }`, `sendToAllWindows<C>(channel, payload): void`, `TypedIpcHandler<C>` — consumed by Tasks 5–6 and Plans 2/3.

- [ ] **Step 1: Write the failing tests**

Create `apps/desktop/src/main/ipc/wire.test.ts`:

```ts
import { beforeEach, describe, expect, it, vi } from 'vitest'

// vi.mock factories hoist above imports and top-level lets — shared mutable
// state must come from vi.hoisted to avoid the TDZ.
const state = vi.hoisted(() => ({
  handles: new Map<string, unknown>(),
  windows: [] as Array<{ isDestroyed: () => boolean; webContents: { send: ReturnType<typeof vi.fn> } }>,
}))
vi.mock('electron', () => ({
  ipcMain: {
    handle: vi.fn((c: string, fn: unknown) => state.handles.set(c, fn)),
    removeHandler: vi.fn((c: string) => state.handles.delete(c)),
  },
  BrowserWindow: {
    getAllWindows: vi.fn(() => state.windows),
  },
}))

import { createIpcRegistrar, sendToAllWindows } from './wire'

describe('createIpcRegistrar', () => {
  beforeEach(() => {
    state.handles.clear()
    state.windows = []
  })

  it('registers handlers and dispose removes exactly the registered set', () => {
    const reg = createIpcRegistrar()
    reg.handle('swarm:listSessions', async () => [])
    reg.handle('system:getAccent', () => null)
    expect(state.handles.has('swarm:listSessions')).toBe(true)
    expect(state.handles.has('system:getAccent')).toBe(true)
    reg.dispose()
    expect(state.handles.size).toBe(0)
  })

  it('dispose is idempotent', () => {
    const reg = createIpcRegistrar()
    reg.handle('system:getAccent', () => null)
    reg.dispose()
    expect(() => reg.dispose()).not.toThrow()
  })
})

describe('sendToAllWindows', () => {
  it('sends to live windows and skips destroyed ones', () => {
    const live = { isDestroyed: () => false, webContents: { send: vi.fn() } }
    const dead = { isDestroyed: () => true, webContents: { send: vi.fn() } }
    state.windows = [live, dead]
    sendToAllWindows('system:accentChange', { hex: 'FF0000FF' })
    expect(live.webContents.send).toHaveBeenCalledWith('system:accentChange', { hex: 'FF0000FF' })
    expect(dead.webContents.send).not.toHaveBeenCalled()
  })
})
```

- [ ] **Step 2: Run to verify failure**

Run: `npm test -- wire.test`
Expected: FAIL — cannot resolve `./wire`.

- [ ] **Step 3: Implement `wire.ts`**

```ts
// Typed bindings between the renderer-IPC signature tables and Electron's
// untyped ipcMain/webContents surfaces. One registrar per wiring unit: it
// remembers what it registered so dispose() removes exactly that set — the
// hand-maintained removeHandler lists this replaces drifted from the handle
// lists more than once.
import type { RendererIpcChannel, RendererIpcEventChannel, RendererIpcEvents, RendererIpcSignatures } from '@swarm/protocol'
import { BrowserWindow, ipcMain } from 'electron'

export type TypedIpcHandler<C extends RendererIpcChannel> = (
  e: Electron.IpcMainInvokeEvent,
  ...args: RendererIpcSignatures[C]['args']
) => RendererIpcSignatures[C]['result'] | Promise<RendererIpcSignatures[C]['result']>

export function createIpcRegistrar(): {
  handle<C extends RendererIpcChannel>(channel: C, fn: TypedIpcHandler<C>): void
  dispose(): void
} {
  const registered: RendererIpcChannel[] = []
  return {
    handle(channel, fn) {
      // Single documented cast: Electron's handler type is untyped; the table
      // typing above is the real contract (mirrors the service dispatcher's
      // choke-point cast).
      ipcMain.handle(channel, fn as (e: Electron.IpcMainInvokeEvent, ...args: unknown[]) => unknown)
      registered.push(channel)
    },
    dispose() {
      for (const channel of registered.splice(0)) ipcMain.removeHandler(channel)
    },
  }
}

export function sendToAllWindows<C extends RendererIpcEventChannel>(channel: C, payload: RendererIpcEvents[C]): void {
  for (const w of BrowserWindow.getAllWindows()) {
    if (!w.isDestroyed()) w.webContents.send(channel, payload)
  }
}
```

- [ ] **Step 4: Run tests**

Run: `npm test -- wire.test` → Expected: PASS (4/4).

- [ ] **Step 5: Commit**

```bash
git add apps/desktop/src/main/ipc/wire.ts apps/desktop/src/main/ipc/wire.test.ts
git commit -m "feat(main): typed IPC registrar and event sender over the renderer-IPC tables"
```

---

### Task 4: Preload typed helpers + Plan-1 member switch + all subscriptions

**Files:**
- Modify: `apps/desktop/src/preload/index.ts`

**Interfaces:**
- Consumes: `RendererIpcSignatures`/`RendererIpcEvents` types (Task 2).
- Produces: internal `invoke`/`subscribe` helpers; Plan-1 domain bridge members routed through them. Bridge OBJECT SHAPE unchanged — `index.d.ts` untouched.

- [ ] **Step 1: Add the helpers near the top of `preload/index.ts`**

```ts
import type {
  RendererIpcChannel,
  RendererIpcEventChannel,
  RendererIpcEvents,
  RendererIpcSignatures,
} from '@swarm/protocol'

// Typed gateways to the renderer-IPC tables. Every bridge member for a
// migrated domain routes through these; unmigrated domains keep raw
// ipcRenderer calls until their plan (see spec §4).
const invoke = <C extends RendererIpcChannel>(
  channel: C,
  ...args: RendererIpcSignatures[C]['args']
): Promise<RendererIpcSignatures[C]['result']> =>
  ipcRenderer.invoke(channel, ...args) as Promise<RendererIpcSignatures[C]['result']>

const subscribe = <C extends RendererIpcEventChannel>(
  channel: C,
  cb: (payload: RendererIpcEvents[C]) => void
): (() => void) => {
  const listener = (_e: Electron.IpcRendererEvent, payload: RendererIpcEvents[C]): void => cb(payload)
  ipcRenderer.on(channel, listener)
  return () => ipcRenderer.removeListener(channel, listener)
}
```

- [ ] **Step 2: Switch Plan-1 domain members to `invoke`**

For every bridge member whose channel is in the Task 2 table (swarm:\*, skills:\*, agents:\*, memory:list, toolToggles:\*, tools:listGroups, mcp:getStatus, system:\*, swarm:article:\*, trending:\*, swarm:quickPanel:\*, swarm:consumePendingDeepLink), replace `ipcRenderer.invoke('<channel>', …) as Promise<…>` with `invoke('<channel>', …)` and DELETE the `as Promise<…>` cast — the helper's return type is now authoritative, and a signature mismatch must surface as a compile error, not be re-cast away. Example (before → after):

```ts
// before
list: () => ipcRenderer.invoke('swarm:listSessions') as Promise<SessionSummary[]>,
// after
list: () => invoke('swarm:listSessions'),
```

Members with parameters pass them through positionally: `rename: (sessionId, title) => invoke('swarm:renameSession', sessionId, title)`. Members that post-process results keep their bodies, only the transport line changes. Do NOT touch members of unmigrated domains (bilibili, gmail, calendar, providers, mcp config mutations, webSearch, weather, budgets, workbench).

Note: the bridge's `deleteSession`/`rename`/`setPinned`/`updateSettings`/`reorder`/`cancelCronJob` members are typed `Promise<void>` in `SwarmBridge` while the table (via `Passthrough`) now says `Promise<{ ok: true }>`. Fix each member by keeping the declared bridge contract: `delete: async (sessionId) => { await invoke('swarm:deleteSession', sessionId) }`. Do not change `SwarmBridge`.

- [ ] **Step 3: Switch ALL 14 event subscriptions to `subscribe`**

Every `ipcRenderer.on(<channel>, listener)` + `removeListener` pair in the preload becomes a `subscribe(<channel>, cb)` call (all 14 channels are in the events table). Helpers with extra behavior (payload massaging, one-shot semantics) keep that logic in the `cb`. Delete the now-unused per-domain `*_CHANNEL` const in the preload ONLY if it has no other use in the file; the main-process consts are Plans 2/3 territory — leave them.

- [ ] **Step 4: Typecheck + tests**

Run: `find . -name '*.tsbuildinfo' -not -path '*/node_modules/*' -delete && pnpm typecheck` → Expected: clean. Any error here is a transcription mismatch between the table and reality — fix the TABLE only if the inventory doc proves the table wrong; otherwise fix the preload line.
Run: `npm test -- apps/desktop/src/renderer` → Expected: same pass/fail set as develop (renderer tests mock `window.swarm`; they prove no shape drift).

- [ ] **Step 5: Commit**

```bash
git add apps/desktop/src/preload/index.ts
git commit -m "feat(preload): typed invoke/subscribe helpers; plan-1 domains and all event subscriptions routed through the tables"
```

---

### Task 5: Migrate `ipc/swarm-ipc.ts` to the registrar

**Files:**
- Modify: `apps/desktop/src/main/ipc/swarm-ipc.ts`

**Interfaces:**
- Consumes: `createIpcRegistrar`, `sendToAllWindows` (Task 3).
- Produces: same exported `wireSwarmIpc(args): { dispose }` contract — `main/index.ts` unchanged.

- [ ] **Step 1: Swap registrations**

At the top of `wireSwarmIpc`, create `const ipc = createIpcRegistrar()`. Replace every `ipcMain.handle('<channel>', fn)` with `ipc.handle('<channel>', fn)` (43 sites; handler bodies unchanged). The compiler now checks each handler against the table — expected friction points, resolve as noted:
- `system:readImageFile`/`readDocumentFile`/`openPath`/`listDir` handlers currently type their arg as `unknown` and guard with `typeof path !== 'string'`. The table says `string`. Keep the runtime guards (defense in depth is fine), adjust the parameter type to match the table.
- `system:pickPath` handler takes `kind: unknown` — type it `'directory' | 'file'` per the table; keep the runtime ternary.
- `swarm:decidePermission` keeps its fire-and-forget body (returns void — matches the table's hand-written entry).

- [ ] **Step 2: Replace the accent broadcast loop**

The `subscribeAccent` callback currently loops `BrowserWindow.getAllWindows()` sending `ACCENT_CHANGE_CHANNEL`. Replace with `sendToAllWindows('system:accentChange', { hex })` and delete the local `ACCENT_CHANGE_CHANNEL` const.

- [ ] **Step 3: Shrink dispose**

Replace the ~40-line `removeHandler` list in `dispose()` with `ipc.dispose()`. Keep the non-IPC unsubscribes (`offMcpChange`, `offWebSearchChange`, `offBudgetsChange`, `unsubscribeAccent`) exactly as they are.

- [ ] **Step 4: Typecheck + service/main tests**

Run: `find . -name '*.tsbuildinfo' -not -path '*/node_modules/*' -delete && pnpm typecheck` → Expected: clean.
Run: `npm test -- apps/desktop/src/main` → Expected: same pass set as develop (host.test EADDRINUSE may flake — pre-existing).

- [ ] **Step 5: Commit**

```bash
git add apps/desktop/src/main/ipc/swarm-ipc.ts
git commit -m "refactor(main): swarm-ipc through the typed registrar; dispose list automated"
```

---

### Task 6: Migrate article / trending / quick-panel / deep-link / index.ts

**Files:**
- Modify: `apps/desktop/src/main/ipc/article-ipc.ts`, `apps/desktop/src/main/trending/ipc.ts`, `apps/desktop/src/main/quick-panel/ipc.ts`, `apps/desktop/src/main/system/deep-link.ts`, `apps/desktop/src/main/index.ts`

**Interfaces:**
- Consumes: `createIpcRegistrar`, `sendToAllWindows` (Task 3).
- Produces: unchanged export contracts (`wireArticleIpc`, `wireTrendingIpc`, `wireTrendingResearchIpc`, `wireQuickPanelIpc`, `registerDeepLinkIpc`).

- [ ] **Step 1: article-ipc.ts**

Registrar + 4 channels (`swarm:article:list/analyze/getAnalysis/delete`); dispose becomes `ipc.dispose()`. `analyzeArticle`'s first param is typed `Electron.IpcMainInvokeEvent` (was `unknown`) to satisfy `TypedIpcHandler`.

- [ ] **Step 2: trending/ipc.ts**

Both wiring functions get their own registrar. Note `trending:get`'s handler currently takes `(period: unknown, language: unknown)` and coerces — the table says `[TrendingPeriod, string]`. Keep the coercion body (`asPeriod` guard stays; it protects against a compromised renderer and costs nothing), type the params per the table.

- [ ] **Step 3: quick-panel/ipc.ts**

Registrar + the 4 quickPanel channels. `wireQuickPanelIpc` currently returns void — change it to return `{ dispose: () => void }` wired to `ipc.dispose()`, and update its caller in `main/index.ts` (`initQuickPanel`) to expose/chain that dispose alongside the existing `quickPanel.dispose()` teardown (read the call site; keep its current shutdown order).

- [ ] **Step 4: deep-link.ts + index.ts**

`registerDeepLinkIpc`: registrar for `swarm:consumePendingDeepLink` (module-level registrar const; no dispose caller exists today — expose a `dispose` return for symmetry only if the call site can consume it without new plumbing; otherwise leave registration lifetime as-is and note it).
`main/index.ts`: the inline `ipcMain.handle('system:getWsHostConfig', …)` moves to a small registrar created next to it; the serviceClient `onEvent` broadcast loop (windows loop sending `swarm:event`/`mcp:status`) is replaced by `sendToAllWindows(channel, payload)` — TypeScript will require the channel to be narrowed to the two event-table keys; use an explicit conditional (`event.startsWith('mcp.') ? sendToAllWindows('mcp:status', data) : sendToAllWindows('swarm:event', toRendererEvent(event, data))`).

- [ ] **Step 5: Typecheck + tests + commit**

Run: `find . -name '*.tsbuildinfo' -not -path '*/node_modules/*' -delete && pnpm typecheck` → clean.
Run: `npm test -- apps/desktop/src/main` → same pass set as develop.

```bash
git add apps/desktop/src/main/ipc/article-ipc.ts apps/desktop/src/main/trending/ipc.ts apps/desktop/src/main/quick-panel/ipc.ts apps/desktop/src/main/system/deep-link.ts apps/desktop/src/main/index.ts
git commit -m "refactor(main): article/trending/quick-panel/deep-link/index through the typed registrar"
```

---

### Task 7: Full regression + run-desktop smoke test

**Files:**
- No new files; formatting-only diffs possible.

- [ ] **Step 1: Format touched files**

```bash
npx biome check --write \
  packages/protocol/src/renderer-ipc.ts packages/protocol/src/renderer-ipc.test.ts packages/protocol/src/index.ts \
  apps/desktop/src/main/ipc/wire.ts apps/desktop/src/main/ipc/wire.test.ts \
  apps/desktop/src/preload/index.ts apps/desktop/src/main/ipc/swarm-ipc.ts \
  apps/desktop/src/main/ipc/article-ipc.ts apps/desktop/src/main/trending/ipc.ts \
  apps/desktop/src/main/quick-panel/ipc.ts apps/desktop/src/main/system/deep-link.ts apps/desktop/src/main/index.ts
```

- [ ] **Step 2: Full suite + typecheck**

Run: `npm test` → Expected: same failure set as develop (host.test EADDRINUSE, use-thread-analysis gmail spy, mobile jest env — all pre-existing; anything else fails = report, don't fix silently).
Run: `find . -name '*.tsbuildinfo' -not -path '*/node_modules/*' -delete && pnpm typecheck` → clean.

- [ ] **Step 3: run-desktop smoke test**

Use the `run-desktop` skill flow from the worktree: build + launch the app, take a screenshot, and exercise one end-to-end IPC path per migrated mechanism class: open the app (listSessions renders the sidebar = invoke path), toggle a skill in Settings (toolToggles round-trip), and confirm the accent/theme still applies (subscribe path). If the user's app instance is already running, note the single-instance lock behavior (launcher exits 0 — check via the skill's DevTools route instead).

- [ ] **Step 4: Commit formatting deltas if any**

```bash
git add -u packages/protocol apps/desktop/src
git status --short   # verify: no stray emitted .js/.d.ts staged
git commit -m "style: biome format for renderer-ipc plan 1" || echo "nothing to format"
```

- [ ] **Step 5: Hand off**

Do not merge. Integration follows finishing-a-development-branch (rebase develop + ff-only after verifying the main checkout is clean).
