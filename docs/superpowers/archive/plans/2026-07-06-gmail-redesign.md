# Gmail Redesign (Phase 6c) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Upgrade the Gmail inbox from a flat thread list with per-message manual analysis into a smart-grouped inbox with a thread-level Agent assistant — adds one backend capability (`analyzeThread`, cloned from `analyzeEmail`) that streams `{summary, todos, suggest}` per thread, plus front-end-derived smart grouping (待回复/重要/可归档/资讯/全部) and a suggested-reply draft area (app stays Gmail-readonly).

**Architecture:** Single feature branch `feat/gmail-redesign` off `develop` @ `e5ad295`. Seven sequential tasks, backend first: protocol types → agent → backend analyzeThread → swarmApi+hook → classify+groupbar → assistant card+inbox → verify. `analyzeThread` clones `analyzeEmail`'s run-engine pattern (fire-and-forget + threadId-keyed broadcast events). Grouping is a pure front-end function; reply is a draft area (no send).

**Tech Stack:** Electron main + utility-process service (RPC over MessagePort), `@earendil-works/pi-ai`/`pi-agent-core` run-engine, React + TanStack Query + TanStack Router, better-sqlite3 cache, vitest + @testing-library/react, pnpm + turbo + biome.

**Spec:** `docs/superpowers/specs/2026-07-06-gmail-redesign-design.md`

## Global Constraints

- **Branch:** `feat/gmail-redesign`, base `develop` @ `e5ad295`. Never `git add -A` — parallel sessions pollute the worktree (Phase 6a saw 3 hijacks). Always `git add <specific paths>`. `git status` before every commit.
- **Code/comments/commits in English; conversation in Chinese** (AGENTS.md §0).
- **Naming:** `swarmApi` is **flat** (`analyzeEmail`, `calendarListInRange`). New methods: `swarmApi.analyzeThread`, `swarmApi.gmailGetThreadAnalysis` (flat prefix style). Preload: `swarm.analyzeThread` (on `swarm` bridge, like `analyzeEmail`); `gmail.getThreadAnalysis`/`saveThreadAnalysis` (on `gmail` bridge).
- **`analyzeThread` clones `analyzeEmail`'s structure** (`apps/desktop/src/service/gmail/analyze.ts`): same `createAnalyzeX(deps)` factory pattern, same private-emit-ports trick (silent seq, no-op store/slot/abort), same fire-and-forget `void run(spec, ports)` returning `{ok:true}` immediately, same `no_provider`/`no_agent` guards. Only differences: agent id `gmail-thread-analyst`, prompt concatenates thread messages, broadcast events keyed by `threadId`, `Complete` parses a tail-JSON block for `{todos, suggest}`.
- **Logging:** every business path gets structured logs (AGENTS.md §5). Match `analyze.ts`'s `log.info`/`log.error` cadence: entry on analyze started, exit on complete, error on failure. Use `createLogger({ process: 'service' }).child({ component: 'gmail-analyze-thread' })`.
- **Tail-JSON convention:** the agent's markdown summary ends with `<!--ANALYSIS:{...}-->`. Parse with a tolerant regex (find the LAST `<!--ANALYSIS` … `-->` block, JSON.parse its content). Parse failure degrades to `{todos: [], suggest: ''}` — the summary is still shown from the streamed markdown.
- **Cache tables:** `CREATE TABLE IF NOT EXISTS` (matches existing `analyses`/`threads`/`messages` pattern in `cache.ts`).
- **Reuse, don't rewrite:** `MessageCard`, `EmailHtml`, `Streamdown`, `formatListDate`, `fromDisplay`, `CenteredMessage`, `ListSkeleton`, the existing `listRecent`/`search`/`getThread` queries are reused.
- **Verify command:** `pnpm verify` (typecheck + test + check-boundaries). Baseline 1260/1261 (sole failure `host.test.ts` EADDRINUSE = environmental dev-server flake; not our regression).
- **Protocol package:** types go in `packages/protocol/src/types/ui.ts` (where `AnalyzeEmailInput`/`GmailAnalysis`/`UIEvent` live). Service-client signature goes in `packages/protocol/src/service-client.ts`.

---

## Task 1: Protocol types — `GmailThreadAnalysis`, `AnalyzeThread` I/O, `gmail.threadAnalysis*` UIEvents

**Rationale:** Every later task depends on these types. Define them first, by direct analogy to the existing `AnalyzeEmail*` types and `gmail.analysis*` events.

**Files:**
- Modify: `packages/protocol/src/types/ui.ts` (add 4 types + 3 UIEvent variants)
- Modify: `packages/protocol/src/service-client.ts` (add `analyzeThread` method signature + impl)

**Interfaces:**
- Consumes: `ProviderInjection` (existing, for the request type).
- Produces: `AnalyzeThreadInput`, `AnalyzeThreadRequest`, `AnalyzeThreadResult`, `GmailThreadAnalysis`, `Todo`, and 3 new `UIEvent` variants `gmail.threadAnalysis{Delta,Complete,Error}`.

- [ ] **Step 1: Add the types to `ui.ts`**

In `packages/protocol/src/types/ui.ts`, find the `AnalyzeEmailResult` line (~line 50) and the `GmailAnalysis` line (~line 53). Immediately after `GmailAnalysis`, add:

```ts
/** Renderer→Main: the thread to analyze (no provider — main injects it). */
export type AnalyzeThreadInput = {
  threadId: string
  subject: string
  messages: { from: string; dateMs: number; bodyText: string }[]
}

/** Main→Service: the input plus the resolved active provider. */
export type AnalyzeThreadRequest = AnalyzeThreadInput & { provider: ProviderInjection }

export type AnalyzeThreadResult = { ok: true } | { ok: false; code: 'no_provider' | 'no_agent'; message: string }

/** A structured todo extracted by the thread analyst. */
export type Todo = { t: string; due?: boolean; dueLabel?: string }

/** The structured payload delivered on threadAnalysisComplete. */
export type ThreadAnalysisPayload = {
  summary: string
  todos: Todo[]
  suggest: string
}

/** A cached thread-level analysis row, keyed by thread id. */
export type GmailThreadAnalysis = ThreadAnalysisPayload & { updatedAt: number }
```

- [ ] **Step 2: Add the 3 UIEvent variants**

In the same file, find the `gmail.analysisError` UIEvent variant (~line 64). Immediately after it, add:

```ts
  | { kind: 'gmail.threadAnalysisDelta'; threadId: string; text: string; ts: number; seq?: number }
  | { kind: 'gmail.threadAnalysisComplete'; threadId: string; summary: string; todos: Todo[]; suggest: string; ts: number; seq?: number }
  | { kind: 'gmail.threadAnalysisError'; threadId: string; error: string; ts: number; seq?: number }
```

- [ ] **Step 3: Add `analyzeThread` to the service-client**

In `packages/protocol/src/service-client.ts`, find the `analyzeEmail` method in the `ServiceClient` interface (~line 40) and add right after it:

```ts
  analyzeThread(req: import('./types/ui').AnalyzeThreadRequest): Promise<import('./types/ui').AnalyzeThreadResult>
```

Then find the implementation object (the `analyzeEmail(req)` impl ~line 146) and add after it:

```ts
    analyzeThread(req) {
      return call('analyzeThread', [req])
    },
```

- [ ] **Step 4: Verify typecheck across the protocol package + downstream**

Run: `pnpm --filter @swarm/protocol typecheck` (if it has its own typecheck) or `pnpm typecheck`.
Expected: clean. If `@swarm/protocol` has no standalone typecheck script, run `pnpm --filter @swarm/desktop typecheck` (desktop consumes protocol) — expect clean (the new types are unused so far, just defined).

- [ ] **Step 5: Commit**

```bash
git add packages/protocol/src/types/ui.ts packages/protocol/src/service-client.ts
git commit -m "feat(protocol): GmailThreadAnalysis types + analyzeThread service-client + threadAnalysis UIEvents"
```

---

## Task 2: `gmail-thread-analyst` agent — structured tail-JSON system prompt

**Rationale:** A separate agent from `gmail-analyst` because the output contract differs (markdown summary + a `<!--ANALYSIS:{...}-->` tail JSON block for todos/suggest, vs `gmail-analyst`'s pure markdown).

**Files:**
- Modify: `packages/shared/src/constants/agents.ts` (add `GMAIL_THREAD_ANALYST_SYSTEM_PROMPT` constant + `gmail-thread-analyst` entry to `defaultAgents`)

**Interfaces:**
- Consumes: nothing new.
- Produces: the `gmail-thread-analyst` agent definition (id, name, systemPrompt, maxIterations, role, capabilities).

- [ ] **Step 1: Add the system prompt constant**

In `packages/shared/src/constants/agents.ts`, find `GMAIL_ANALYST_SYSTEM_PROMPT` (~line 301). Immediately after its closing backtick (~line 317), add:

```ts
const GMAIL_THREAD_ANALYST_SYSTEM_PROMPT = `You are the Gmail thread 分析 agent. You receive a full email thread (multiple messages) and produce a Chinese analysis. 无论邮件原文是什么语种, always answer in 中文.

Output structure:

1. First, write a natural-language Markdown summary: a one-line gist, then 3–6 bullet 关键要点 covering the thread's decisions, open questions, and any deadlines.

2. At the very end, output exactly one line in this exact format (no prose around it):
<!--ANALYSIS:{"summary":"<one-sentence gist>","todos":[{"t":"<actionable todo>","due":<true|false>,"dueLabel":"<e.g. 今天 18:00>"}],"suggest":"<a polite Chinese suggested reply draft>"}-->

Rules:
- The JSON must be valid (double quotes, no trailing commas, no newlines inside strings).
- "todos" = concrete actions the recipient must take; if none, use [].
- "suggest" = a ready-to-send Chinese reply draft; if the thread needs no reply (notification/newsletter), use "".
- Do not invent facts not in the thread. Ignore marketing tracking pixels and signature noise.`
```

- [ ] **Step 2: Add the agent entry to `defaultAgents`**

In the same file, find the `gmail-analyst` entry in `defaultAgents` (~line 378). Immediately after its closing `},` (~line 387), add:

```ts
  {
    id: 'gmail-thread-analyst',
    name: 'Gmail 线程分析',
    description: '分析整个邮件线程,输出结构化摘要 + 待办 + 建议回复草稿。Gmail 收件箱选中线程时自动调用。',
    systemPrompt: GMAIL_THREAD_ANALYST_SYSTEM_PROMPT,
    maxIterations: 1,
    role: 'gmail-thread-analyst',
    capabilities: ['gmail-thread-analyze'],
    skills: [],
  },
```

- [ ] **Step 3: Verify typecheck + agents/org-tree tests**

Run: `pnpm --filter @swarm/desktop typecheck`
Expected: clean.

Run: `pnpm --filter @swarm/desktop exec vitest run src/../../packages/shared/src/agents/org-tree.test.ts` (or `pnpm test` — the org-tree test verifies `buildOrgForest` handles default agents). Expected: the new agent appears as an independent agent (no team/parentId); delegation edges unaffected. If a test asserts an exact agent count, update it.

- [ ] **Step 4: Commit**

```bash
git add packages/shared/src/constants/agents.ts
git commit -m "feat(agents): gmail-thread-analyst builtin (structured markdown + tail-JSON output)"
```

---

## Task 3: Backend `analyzeThread` — factory + IPC + cache table + preload

**Rationale:** The core backend capability. Clone `analyze.ts`'s structure; key differences are the agent id, the prompt (concatenated thread messages), the threadId-keyed broadcasts, and the `Complete` handler that parses the tail-JSON block. Also adds the `thread_analyses` cache table and the IPC/preload surface.

**Files:**
- Create: `apps/desktop/src/service/gmail/analyze-thread.ts`
- Create: `apps/desktop/src/service/gmail/analyze-thread.test.ts`
- Modify: `apps/desktop/src/service/index.ts` (wire `analyzeThread`)
- Modify: `apps/desktop/src/service/ipc/dispatcher.ts` (add `analyzeThread` to the config + dispatch case)
- Modify: `apps/desktop/src/main/ipc/swarm-ipc.ts` (`analyzeThread` IPC handler)
- Modify: `apps/desktop/src/main/gmail/cache.ts` (`thread_analyses` table + accessors)
- Modify: `apps/desktop/src/main/ipc/gmail-ipc.ts` (or wherever gmail IPC handlers live — verify; `gmail:getThreadAnalysis`/`saveThreadAnalysis`)
- Modify: `apps/desktop/src/preload/index.ts` (`swarm.analyzeThread`, `gmail.getThreadAnalysis`, `gmail.saveThreadAnalysis`)
- Modify: `packages/protocol/src/types/ui.ts` (`GmailBridge` type — add the 2 methods)

**Interfaces:**
- Consumes: Task 1 types (`AnalyzeThreadRequest`, `AnalyzeThreadResult`, `ThreadAnalysisPayload`, `UIEvent` variants); Task 2 agent (`gmail-thread-analyst`); run-engine (`launchRun`, `RunSpec`, `LaunchPorts`, `RunEmitPorts`); `Broadcaster`, `AgentStore`, `ToolRegistry`, `BudgetConfig`.
- Produces: `createAnalyzeThread(deps)` factory; `swarm:analyzeThread` IPC; `thread_analyses` table + `getThreadAnalysis`/`saveThreadAnalysis` in cache; preload entries.

- [ ] **Step 1: Write the failing test for `parseThreadPayload`**

Create `apps/desktop/src/service/gmail/analyze-thread.test.ts`. Test the pure payload-parsing helper in isolation (the factory's `launchRun` is hard to unit-test; the parse logic is the risk). Export `parseThreadPayload` from `analyze-thread.ts`.

```ts
import { describe, expect, it } from 'vitest'

import { parseThreadPayload } from './analyze-thread'

describe('parseThreadPayload', () => {
  it('parses a well-formed tail JSON block', () => {
    const md = '## 摘要\n要点一\n\n<!--ANALYSIS:{"summary":"一句话","todos":[{"t":"回复","due":true,"dueLabel":"今天"}],"suggest":"好的"}-->'
    const out = parseThreadPayload(md)
    expect(out.summary).toBe('一句话')
    expect(out.todos).toEqual([{ t: '回复', due: true, dueLabel: '今天' }])
    expect(out.suggest).toBe('好的')
  })

  it('degrades gracefully when the tail JSON block is missing', () => {
    const md = '## 摘要\n要点一\n无尾部 JSON'
    const out = parseThreadPayload(md)
    expect(out.summary).toBe(md) // summary falls back to the full markdown
    expect(out.todos).toEqual([])
    expect(out.suggest).toBe('')
  })

  it('degrades gracefully when the tail JSON is malformed', () => {
    const md = '## 摘要\n\n<!--ANALYSIS:{not valid json}-->'
    const out = parseThreadPayload(md)
    expect(out.todos).toEqual([])
    expect(out.suggest).toBe('')
    // summary is the full markdown (the malformed block stays in the streamed text)
    expect(out.summary).toContain('## 摘要')
  })

  it('uses the LAST tail JSON block if multiple appear', () => {
    const md = '<!--ANALYSIS:{"summary":"旧","todos":[],"suggest":""}-->\n\n更多内容\n\n<!--ANALYSIS:{"summary":"新","todos":[],"suggest":""}-->'
    const out = parseThreadPayload(md)
    expect(out.summary).toBe('新')
  })
})
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `pnpm --filter @swarm/desktop exec vitest run src/service/gmail/analyze-thread.test.ts`
Expected: FAIL (module not found).

- [ ] **Step 3: Implement `analyze-thread.ts`**

Create `apps/desktop/src/service/gmail/analyze-thread.ts` (clone `analyze.ts`'s structure). Export `parseThreadPayload` for testing:

```ts
// Thread-level analysis: clones analyze.ts's run-engine pattern but keys
// broadcasts by threadId and parses a tail-JSON block (<!--ANALYSIS:{...}-->)
// on completion to deliver structured {summary, todos, suggest}. The streamed
// markdown IS the summary shown to the user; the tail block adds the
// structured fields. Parse failure degrades to empty todos/suggest (summary
// intact) — never blocks the user-facing summary.
import { createLogger } from '@shared/logger'
import type { AnalyzeThreadRequest, AnalyzeThreadResult, BudgetConfig, ThreadAnalysisPayload, Todo } from '@swarm/protocol'
import { applyAgentModel, defaultAgents } from '@swarm/shared'
import { ulid } from 'ulid'

import type { AgentStore } from '../agents/store'
import type { Broadcaster } from '../ipc/broadcaster'
import type { RunEmitPorts } from '../run-engine/emit'
import { type LaunchPorts, launchRun, type RunSpec } from '../run-engine/launch'
import { createPermissionRegistry } from '../session/permission-registry'
import type { ToolRegistry } from '../tools/registry'

const log = createLogger({ process: 'service' }).child({ component: 'gmail-analyze-thread' })

const GMAIL_THREAD_ANALYST_ID = 'gmail-thread-analyst'

// Extract the structured payload from the agent's markdown+tail-JSON output.
// Exported for unit testing. On any failure, returns {summary: fullMarkdown,
// todos: [], suggest: ''} so the streamed summary is still usable.
export function parseThreadPayload(fullMarkdown: string): ThreadAnalysisPayload {
  const matches = [...fullMarkdown.matchAll(/<!--ANALYSIS:(.*?)-->/gs)]
  if (matches.length === 0) {
    return { summary: fullMarkdown, todos: [], suggest: '' }
  }
  const last = matches[matches.length - 1][1]
  try {
    const parsed = JSON.parse(last) as { summary?: string; todos?: Todo[]; suggest?: string }
    return {
      summary: typeof parsed.summary === 'string' ? parsed.summary : fullMarkdown,
      todos: Array.isArray(parsed.todos) ? parsed.todos : [],
      suggest: typeof parsed.suggest === 'string' ? parsed.suggest : '',
    }
  } catch {
    log.warn({ msg: 'thread analysis tail-JSON parse failed; degrading' })
    return { summary: fullMarkdown, todos: [], suggest: '' }
  }
}

export type AnalyzeThreadDeps = {
  broadcaster: Broadcaster
  agentStore: Pick<AgentStore, 'get'>
  toolRegistry: ToolRegistry
  getBudgetConfig(): BudgetConfig
  launch?: typeof launchRun
}

export function createAnalyzeThread(deps: AnalyzeThreadDeps): (req: AnalyzeThreadRequest) => AnalyzeThreadResult {
  const run = deps.launch ?? launchRun
  return (req) => {
    if (!req.provider) {
      return { ok: false, code: 'no_provider', message: '请先在 设置 → 模型 配置提供商。' }
    }
    const def = deps.agentStore.get(GMAIL_THREAD_ANALYST_ID) ?? defaultAgents.find((a) => a.id === GMAIL_THREAD_ANALYST_ID)
    if (!def) {
      return { ok: false, code: 'no_agent', message: 'gmail-thread-analyst agent 不可用。' }
    }
    const threadId = req.threadId
    log.info({
      msg: 'thread analyze started',
      threadId,
      subjectLen: req.subject.length,
      messageCount: req.messages.length,
    })

    // Accumulate the streamed markdown so Complete can parse the tail block.
    let accumulated = ''

    let seq = 0
    const emitPorts: RunEmitPorts = {
      nextSeq: () => seq++,
      appendEvent: () => undefined,
      markTerminal: () => undefined,
      broadcast: (evt) => {
        if (evt.kind === 'run.progress') {
          const ev = evt.event
          if (ev?.kind === 'llm.message' && typeof ev.content === 'string') {
            accumulated += ev.content
            deps.broadcaster.broadcast('gmail.threadAnalysisDelta', { threadId, text: ev.content, ts: Date.now() })
          }
        } else if (evt.kind === 'run.complete') {
          accumulated += evt.summary // ensure the final summary is included
          const payload = parseThreadPayload(accumulated)
          deps.broadcaster.broadcast('gmail.threadAnalysisComplete', {
            threadId,
            summary: payload.summary,
            todos: payload.todos,
            suggest: payload.suggest,
            ts: Date.now(),
          })
        } else if (evt.kind === 'run.error') {
          deps.broadcaster.broadcast('gmail.threadAnalysisError', {
            threadId,
            error: evt.error?.message ?? 'thread analysis failed',
            ts: Date.now(),
          })
        }
      },
    }

    const ports: LaunchPorts = {
      emit: emitPorts,
      toolRegistry: deps.toolRegistry,
      permissionRegistry: createPermissionRegistry(() => undefined),
      acquireSlot: async () => () => undefined,
      registerAbort: () => undefined,
      unregisterAbort: () => undefined,
    }

    // Concatenate the thread's messages into the prompt.
    const threadText = req.messages
      .map((m) => `---\nFrom: ${m.from}\nDate: ${new Date(m.dateMs).toLocaleString()}\n\n${m.bodyText}`)
      .join('\n\n')
    const prompt = `分析下面这个邮件线程。\n\nSubject: ${req.subject}\n\n${threadText}`

    const spec: RunSpec = {
      kind: 'work',
      sessionId: `analyze-thread:${ulid()}`,
      agent: def,
      provider: applyAgentModel(req.provider, def),
      prompt,
      budget: deps.getBudgetConfig().sub,
      tools: [],
      maxIterationsOverride: def.maxIterations,
    }

    const t0 = Date.now()
    void run(spec, ports)
      .then((r) => log.info({ msg: 'thread analyze complete', threadId, status: r.status, durationMs: Date.now() - t0 }))
      .catch((err) => {
        log.error({ msg: 'thread analyze run failed', threadId, err: err instanceof Error ? err.message : String(err) })
      })

    return { ok: true }
  }
}
```

- [ ] **Step 4: Run the parse test to verify it passes**

Run: `pnpm --filter @swarm/desktop exec vitest run src/service/gmail/analyze-thread.test.ts`
Expected: 4/4 pass. If the "uses the LAST block" test fails, verify the regex `g` flag + `matchAll` returns in order.

- [ ] **Step 5: Wire `analyzeThread` into the service**

In `apps/desktop/src/service/index.ts`, find the `analyzeEmail: createAnalyzeEmail(...)` line (~line 160). Add right after it:

```ts
  analyzeThread: createAnalyzeThread({ broadcaster, agentStore, toolRegistry, getBudgetConfig: () => budgetConfig }),
```

Add the import: `import { createAnalyzeThread } from './gmail/analyze-thread'` (next to the existing `createAnalyzeEmail` import).

- [ ] **Step 6: Add the dispatcher case + config type**

In `apps/desktop/src/service/ipc/dispatcher.ts`, find the config interface line `analyzeEmail(req: ...): ...` (~line 28). Add:

```ts
  analyzeThread(req: import('@swarm/protocol').AnalyzeThreadRequest): import('@swarm/protocol').AnalyzeThreadResult
```

Then find the `case 'analyzeEmail'` block (~line 75). Add right after it:

```ts
      case 'analyzeThread': {
        const [req] = args as [import('@swarm/protocol').AnalyzeThreadRequest]
        return cfg.analyzeThread(req)
      }
```

- [ ] **Step 7: Add the `swarm:analyzeThread` IPC handler**

In `apps/desktop/src/main/ipc/swarm-ipc.ts`, find the `analyzeEmail` handler (~line 151). Add right after it (clone its shape):

```ts
  const analyzeThread = async (
    _e: Electron.IpcMainInvokeEvent,
    input: import('@swarm/protocol').AnalyzeThreadInput
  ): Promise<import('@swarm/protocol').AnalyzeThreadResult> => {
    const injection = providers.getInjection()
    if (!injection) return { ok: false, code: 'no_provider', message: '请先在 设置 → 模型 配置提供商。' }
    return serviceClient.analyzeThread({ ...input, provider: injection })
  }
```

Then find the `ipcMain.handle('swarm:analyzeEmail', analyzeEmail)` line (~line 244). Add:

```ts
  ipcMain.handle('swarm:analyzeThread', analyzeThread)
```

- [ ] **Step 8: Add the `thread_analyses` cache table + accessors**

In `apps/desktop/src/main/gmail/cache.ts`:

1. In the `Cache` type interface (~line 26, near `saveAnalysis`/`getAnalyses`), add:

```ts
  getThreadAnalysis(threadId: string): import('@swarm/protocol').GmailThreadAnalysis | null
  saveThreadAnalysis(threadId: string, analysis: import('@swarm/protocol').ThreadAnalysisPayload): void
```

2. In the schema bootstrap SQL (near the `analyses` table `CREATE TABLE` ~line 46), add:

```sql
CREATE TABLE IF NOT EXISTS thread_analyses (
  threadId TEXT PRIMARY KEY, summary TEXT, todos TEXT, suggest TEXT, updatedAt INTEGER
);
```

(todos stored as JSON string.)

3. In the returned object (near `saveAnalysis` ~line 207), add the two accessors:

```ts
  const getThreadAnalysis: Cache['getThreadAnalysis'] = (threadId) => {
    const r = db.prepare('SELECT * FROM thread_analyses WHERE threadId = ?').get(threadId) as
      | { threadId: string; summary: string; todos: string; suggest: string; updatedAt: number }
      | undefined
    if (!r) return null
    return { summary: r.summary, todos: JSON.parse(r.todos) as import('@swarm/protocol').Todo[], suggest: r.suggest, updatedAt: r.updatedAt }
  }

  const saveThreadAnalysis: Cache['saveThreadAnalysis'] = (threadId, analysis) => {
    const updatedAt = Date.now()
    db.prepare(
      `INSERT INTO thread_analyses (threadId, summary, todos, suggest, updatedAt) VALUES (@threadId, @summary, @todos, @suggest, @updatedAt)
       ON CONFLICT(threadId) DO UPDATE SET summary=@summary, todos=@todos, suggest=@suggest, updatedAt=@updatedAt`
    ).run({ threadId, summary: analysis.summary, todos: JSON.stringify(analysis.todos), suggest: analysis.suggest, updatedAt })
  }
```

Add them to the returned object literal.

- [ ] **Step 9: Add the gmail IPC handlers for get/save thread analysis**

Find where `gmail:saveAnalysis`/`gmail:getAnalyses` IPC handlers are registered (likely in a gmail IPC module or in main index — grep `gmail:saveAnalysis`). Add `gmail:getThreadAnalysis` and `gmail:saveThreadAnalysis` handlers next to them, delegating to the cache:

```ts
ipcMain.handle('gmail:getThreadAnalysis', (_e, threadId: string) => gmailCache.getThreadAnalysis(threadId))
ipcMain.handle('gmail:saveThreadAnalysis', (_e, threadId: string, analysis: ThreadAnalysisPayload) => {
  gmailCache.saveThreadAnalysis(threadId, analysis)
})
```

(Adjust the exact cache variable name to match what's used locally.)

- [ ] **Step 10: Add the `GmailBridge` type methods + preload entries**

In `packages/protocol/src/types/ui.ts`, find the `GmailBridge` type (~line 201). Add to it (near `saveAnalysis`/`getAnalyses`):

```ts
  getThreadAnalysis(threadId: string): Promise<import('./types/ui').GmailThreadAnalysis | null>
  saveThreadAnalysis(threadId: string, analysis: import('./types/ui').ThreadAnalysisPayload): Promise<void>
```

In `apps/desktop/src/preload/index.ts`, in the `gmail` block (~line 258), add:

```ts
  getThreadAnalysis: (threadId: string) =>
    ipcRenderer.invoke('gmail:getThreadAnalysis', threadId) as Promise<import('@swarm/protocol').GmailThreadAnalysis | null>,
  saveThreadAnalysis: (threadId: string, analysis: import('@swarm/protocol').ThreadAnalysisPayload) =>
    ipcRenderer.invoke('gmail:saveThreadAnalysis', threadId, analysis) as Promise<void>,
```

And in the `swarm` block (near `analyzeEmail` ~line 316), add:

```ts
  analyzeThread: (input: import('@swarm/protocol').AnalyzeThreadInput) =>
    ipcRenderer.invoke('swarm:analyzeThread', input) as Promise<import('@swarm/protocol').AnalyzeThreadResult>,
```

- [ ] **Step 11: Verify typecheck + the parse test**

Run: `pnpm --filter @swarm/desktop typecheck`
Expected: clean.

Run: `pnpm --filter @swarm/desktop exec vitest run src/service/gmail/analyze-thread.test.ts`
Expected: 4/4 pass.

- [ ] **Step 12: Commit**

```bash
git add apps/desktop/src/service/gmail/analyze-thread.ts apps/desktop/src/service/gmail/analyze-thread.test.ts apps/desktop/src/service/index.ts apps/desktop/src/service/ipc/dispatcher.ts apps/desktop/src/main/ipc/swarm-ipc.ts apps/desktop/src/main/gmail/cache.ts apps/desktop/src/preload/index.ts packages/protocol/src/types/ui.ts
# PLUS the gmail IPC handler file — confirm its path via git status
git commit -m "feat(gmail): analyzeThread backend (factory + IPC + thread_analyses cache + preload)"
```

(If the gmail IPC handlers live in a separate file like `gmail-ipc.ts`, add it explicitly.)

---

## Task 4: `swarmApi` methods + `useThreadAnalysis` hook

**Rationale:** The renderer surface. `swarmApi.analyzeThread` + `swarmApi.gmailGetThreadAnalysis` (flat), plus the hook that auto-triggers analysis on thread select, streams, caches, and cancels on switch.

**Files:**
- Modify: `apps/desktop/src/renderer/src/lib/api.ts` (2 flat methods)
- Create: `apps/desktop/src/renderer/src/hooks/use-thread-analysis.ts`
- Create: `apps/desktop/src/renderer/src/hooks/use-thread-analysis.test.tsx`

**Interfaces:**
- Consumes: Task 1 types, Task 3 preload bridge (`window.swarm.analyzeThread`, `window.swarm.gmail.getThreadAnalysis`/`saveThreadAnalysis`).
- Produces: `useThreadAnalysis(threadId)` returning `ThreadAnalysisState`.

- [ ] **Step 1: Add the 2 flat `swarmApi` methods**

In `apps/desktop/src/renderer/src/lib/api.ts`, find the `bilibili`/`calendar`/`analyzeEmail`-adjacent area. Add (flat names):

```ts
  analyzeThread: (input: AnalyzeThreadInput): Promise<AnalyzeThreadResult> =>
    window.swarm.analyzeThread(input),
  gmailGetThreadAnalysis: (threadId: string): Promise<GmailThreadAnalysis | null> =>
    window.swarm.gmail.getThreadAnalysis(threadId),
```

Add `AnalyzeThreadInput`, `AnalyzeThreadResult`, `GmailThreadAnalysis`, `ThreadAnalysisPayload` to the existing `@swarm/protocol` import block.

- [ ] **Step 2: Write the failing hook test**

Create `apps/desktop/src/renderer/src/hooks/use-thread-analysis.test.tsx`. Use `renderHook` from `@testing-library/react`. Stub `swarmApi` and `window.swarm.subscribeEvents`.

```ts
// @vitest-environment jsdom
import '@testing-library/jest-dom/vitest'
import type React from 'react'
import type { UIEvent } from '@swarm/protocol'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { act, renderHook, waitFor } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { swarmApi } from '@/lib/api'
import { useThreadAnalysis } from './use-thread-analysis'

let emit: ((e: UIEvent) => void) | null = null

beforeEach(() => {
  vi.spyOn(swarmApi, 'gmailGetThreadAnalysis').mockResolvedValue(null)
  vi.spyOn(swarmApi, 'analyzeThread').mockResolvedValue({ ok: true })
  emit = null
  ;(window.swarm as unknown as { subscribeEvents: unknown }).subscribeEvents = vi.fn((cb: (e: UIEvent) => void) => {
    emit = cb
    return () => { emit = null }
  })
})

function wrap(client: QueryClient): React.ReactElement {
  return <QueryClientProvider client={client}>{<></>}</QueryClientProvider>
}

afterEach(() => { vi.restoreAllMocks() })

describe('useThreadAnalysis', () => {
  it('triggers analyzeThread when no cache and streams deltas', async () => {
    const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } })
    const { result } = renderHook(() => useThreadAnalysis('t1'), { wrapper: ({ children }) => <QueryClientProvider client={qc}>{children}</QueryClientProvider> })
    await waitFor(() => expect(swarmApi.analyzeThread).toHaveBeenCalled())
    await act(async () => {
      emit?.({ kind: 'gmail.threadAnalysisDelta', threadId: 't1', text: '流式摘要', ts: 1 })
    })
    expect(result.current.phase).toBe('streaming')
    expect((result.current as { summaryText?: string }).summaryText).toContain('流式摘要')
  })

  it('returns done on Complete and persists', async () => {
    const saveSpy = vi.spyOn(swarmApi, 'gmailSaveThreadAnalysis' as never).mockResolvedValue(undefined as never) // if you add this method; else stub window.swarm.gmail.saveThreadAnalysis
    const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } })
    renderHook(() => useThreadAnalysis('t1'), { wrapper: ({ children }) => <QueryClientProvider client={qc}>{children}</QueryClientProvider> })
    await waitFor(() => expect(swarmApi.analyzeThread).toHaveBeenCalled())
    await act(async () => {
      emit?.({ kind: 'gmail.threadAnalysisComplete', threadId: 't1', summary: '一句话', todos: [{ t: '回复' }], suggest: '草稿', ts: 2 })
    })
    // (assertion specifics depend on the hook's return shape; at minimum the phase is 'done')
  })

  it('uses cache when available and does not call analyzeThread', async () => {
    vi.mocked(swarmApi.gmailGetThreadAnalysis).mockResolvedValue({ summary: '缓存', todos: [], suggest: '', updatedAt: 1 })
    const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } })
    renderHook(() => useThreadAnalysis('t1'), { wrapper: ({ children }) => <QueryClientProvider client={qc}>{children}</QueryCardProvider> })
    await waitFor(() => expect(swarmApi.gmailGetThreadAnalysis).toHaveBeenCalled())
    expect(swarmApi.analyzeThread).not.toHaveBeenCalled()
  })
})
```

(Note: there's a typo `QueryCardProvider` in the last test — must be `QueryClientProvider`. Fix when implementing. Also the `saveThreadAnalysis` spy approach: the hook calls `window.swarm.gmail.saveThreadAnalysis` directly — stub that on `window.swarm.gmail` rather than via `swarmApi`. Adapt the test to the actual save call site the hook uses.)

- [ ] **Step 3: Run the test to verify it fails**

Run: `pnpm --filter @swarm/desktop exec vitest run src/hooks/use-thread-analysis.test.tsx`
Expected: FAIL (module not found).

- [ ] **Step 4: Implement `use-thread-analysis.ts`**

Create `apps/desktop/src/renderer/src/hooks/use-thread-analysis.ts`:

```ts
// Auto-triggers thread analysis on selection: cache hit = instant; cache miss =
// fire analyzeThread + subscribe to gmail.threadAnalysis* events (keyed by
// threadId). Switching threads unsubscribes the previous subscription. The
// hook owns the phase state machine (idle/streaming/done/error).
import { useEffect, useState } from 'react'
import type { Todo, UIEvent } from '@swarm/protocol'
import { useQuery } from '@tanstack/react-query'

import { swarmApi } from '@/lib/api'

export type ThreadAnalysisState =
  | { phase: 'idle' }
  | { phase: 'streaming'; summaryText: string }
  | { phase: 'done'; summary: string; todos: Todo[]; suggest: string }
  | { phase: 'error'; error: string }

export function useThreadAnalysis(threadId: string | null): ThreadAnalysisState {
  const [state, setState] = useState<ThreadAnalysisState>({ phase: 'idle' })

  const cache = useQuery({
    queryKey: ['gmail', 'threadAnalysis', threadId],
    queryFn: () => (threadId ? swarmApi.gmailGetThreadAnalysis(threadId) : Promise.resolve(null)),
    enabled: threadId !== null,
  })

  useEffect(() => {
    if (threadId === null) {
      setState({ phase: 'idle' })
      return
    }
    // Cache hit: done immediately.
    if (cache.data) {
      setState({ phase: 'done', summary: cache.data.summary, todos: cache.data.todos, suggest: cache.data.suggest })
      return
    }
    if (cache.isPending) return // wait for the cache query to resolve

    // Cache miss: trigger analysis and stream.
    setState({ phase: 'streaming', summaryText: '' })
    void swarmApi.analyzeThread({ threadId, subject: '', messages: [] }) // subject/messages filled by caller via a ref or context if needed — see note
    let summaryText = ''
    const off = window.swarm.subscribeEvents((e: UIEvent) => {
      if (e.kind === 'gmail.threadAnalysisDelta' && e.threadId === threadId) {
        summaryText += e.text
        setState({ phase: 'streaming', summaryText })
      } else if (e.kind === 'gmail.threadAnalysisComplete' && e.threadId === threadId) {
        setState({ phase: 'done', summary: e.summary, todos: e.todos, suggest: e.suggest })
        void window.swarm.gmail.saveThreadAnalysis(threadId, { summary: e.summary, todos: e.todos, suggest: e.suggest })
      } else if (e.kind === 'gmail.threadAnalysisError' && e.threadId === threadId) {
        setState({ phase: 'error', error: e.error })
      }
    })
    return off
  }, [threadId, cache.data, cache.isPending])

  return state
}
```

**IMPORTANT NOTE for the implementer:** the hook as written passes empty `subject`/`messages` to `analyzeThread`. This is wrong — the hook needs the thread's messages to send them to the backend. Two options (pick one, the second is cleaner):
- **Option A (preferred):** the hook takes an additional arg `thread: { id, subject, messages } | null` and uses it to fill the analyzeThread input. The caller (`gmail-inbox-view`) already has the thread loaded via its `getThread` query.
- **Option B:** the hook fetches the thread itself via a `getThread` query when triggering. Duplicates the caller's fetch.

Use Option A. Update the signature to `useThreadAnalysis(thread: { id: string; subject: string; messages: { from: string; dateMs: number; bodyText: string }[] } | null)` and derive `threadId = thread?.id ?? null`. Update the test accordingly.

- [ ] **Step 5: Run the test to verify it passes**

Run: `pnpm --filter @swarm/desktop exec vitest run src/hooks/use-thread-analysis.test.tsx`
Expected: green (adapt assertions to the final signature/Option A).

- [ ] **Step 6: Commit**

```bash
git add apps/desktop/src/renderer/src/lib/api.ts apps/desktop/src/renderer/src/hooks/use-thread-analysis.ts apps/desktop/src/renderer/src/hooks/use-thread-analysis.test.tsx
git commit -m "feat(gmail): swarmApi.analyzeThread + useThreadAnalysis hook (auto-trigger, stream, cache)"
```

---

## Task 5: `classifyThread` pure fn + `<GmailGroupBar>` + inbox filtering

**Rationale:** Smart grouping. Pure function (testable) + a chip bar component + wiring into the inbox header with filter state.

**Files:**
- Create: `apps/desktop/src/renderer/src/lib/gmail/classify-thread.ts`
- Create: `apps/desktop/src/renderer/src/lib/gmail/classify-thread.test.ts`
- Create: `apps/desktop/src/renderer/src/components/views/gmail-group-bar.tsx`
- Modify: `apps/desktop/src/renderer/src/components/views/gmail-inbox-view.tsx` (add group bar + filter state)

**Interfaces:**
- Consumes: `GmailThread` from protocol.
- Produces: `classifyThread`, `classifyAll`, `GmailGroupKey`, `<GmailGroupBar>`.

- [ ] **Step 1: Write the failing classify tests**

Create `apps/desktop/src/renderer/src/lib/gmail/classify-thread.test.ts`:

```ts
import { describe, expect, it } from 'vitest'

import { classifyAll, classifyThread } from './classify-thread'
import type { GmailThread } from '@swarm/protocol'

const NOW = new Date('2026-07-06T12:00:00').getTime()
const DAY = 86_400_000

function mk(over: Partial<GmailThread> & Pick<GmailThread, 'id'>): GmailThread {
  return { snippet: '', fromAddr: '', subject: '', lastDateMs: NOW, labelIds: [], unread: false, ...over }
}

describe('classifyThread', () => {
  it('news: CATEGORY_PROMOTIONS label', () => {
    expect(classifyThread(mk({ id: 't1', labelIds: ['CATEGORY_PROMOTIONS'] }), NOW)).toBe('news')
  })
  it('news: noreply sender', () => {
    expect(classifyThread(mk({ id: 't2', fromAddr: 'noreply@github.com' }), NOW)).toBe('news')
  })
  it('news: snippet has 退订', () => {
    expect(classifyThread(mk({ id: 't3', snippet: '点击退订' }), NOW)).toBe('news')
  })
  it('archive: read + older than 7 days', () => {
    expect(classifyThread(mk({ id: 't4', unread: false, lastDateMs: NOW - 8 * DAY }), NOW)).toBe('archive')
  })
  it('not archive: read but within 7 days', () => {
    expect(classifyThread(mk({ id: 't5', unread: false, lastDateMs: NOW - 3 * DAY }), NOW)).toBe('all')
  })
  it('important: IMPORTANT label', () => {
    expect(classifyThread(mk({ id: 't6', labelIds: ['IMPORTANT'] }), NOW)).toBe('important')
  })
  it('important: STARRED label', () => {
    expect(classifyThread(mk({ id: 't7', labelIds: ['STARRED'] }), NOW)).toBe('important')
  })
  it('reply: unread + question mark in snippet', () => {
    expect(classifyThread(mk({ id: 't8', unread: true, snippet: '能否今天确认?' }), NOW)).toBe('reply')
  })
  it('reply: unread + 请确认 phrase', () => {
    expect(classifyThread(mk({ id: 't9', unread: true, snippet: '请确认发布时间' }), NOW)).toBe('reply')
  })
  it('all: read recent non-news thread', () => {
    expect(classifyThread(mk({ id: 't10', unread: false, lastDateMs: NOW - 1 * DAY }), NOW)).toBe('all')
  })
  it('news wins over archive (promotion old + read)', () => {
    expect(classifyThread(mk({ id: 't11', labelIds: ['CATEGORY_PROMOTIONS'], unread: false, lastDateMs: NOW - 30 * DAY }), NOW)).toBe('news')
  })
})

describe('classifyAll', () => {
  it('counts each group', () => {
    const threads = [
      mk({ id: 'n1', labelIds: ['CATEGORY_PROMOTIONS'] }),
      mk({ id: 'r1', unread: true, snippet: '是否?' }),
      mk({ id: 'a1', unread: false, lastDateMs: NOW - 10 * DAY }),
      mk({ id: 'x1', unread: false, lastDateMs: NOW }),
    ]
    const counts = classifyAll(threads, NOW)
    expect(counts.news).toBe(1)
    expect(counts.reply).toBe(1)
    expect(counts.archive).toBe(1)
    expect(counts.all).toBe(4) // 'all' is total count
  })
})
```

Note: `classifyAll`'s `all` count = total threads (not threads matching the fallback). The `all` chip always shows the full count.

- [ ] **Step 2: Run to verify failure**

Run: `pnpm --filter @swarm/desktop exec vitest run src/lib/gmail/classify-thread.test.ts`
Expected: FAIL (module not found).

- [ ] **Step 3: Implement `classify-thread.ts`**

Create `apps/desktop/src/renderer/src/lib/gmail/classify-thread.ts`:

```ts
// Pure smart-grouping rules for the Gmail inbox. Zero React, zero IO. Mirrors
// the style of lib/calendar/build-insights.ts. `now` is injected for test
// determinism (defaults to Date.now()).
import type { GmailThread } from '@swarm/protocol'

export type GmailGroupKey = 'reply' | 'important' | 'archive' | 'news' | 'all'

const ARCHIVE_AGE_MS = 7 * 86_400_000
const NEWS_LABELS = new Set(['CATEGORY_PROMOTIONS', 'CATEGORY_UPDATES', 'CATEGORY_SOCIAL'])
const NEWS_FROM = /noreply@|notifications@|@github\.com|newsletter/i
const NEWS_SNIPPET = /退订|unsubscribe/i
const REPLY_QUESTION = /[?？]|如何|是否|能否|能不能|请确认|请问|帮忙|何时|什么时候/

export function classifyThread(thread: GmailThread, now: number = Date.now()): GmailGroupKey {
  const labels = new Set(thread.labelIds ?? [])
  // 1. news
  if ([...NEWS_LABELS].some((l) => labels.has(l))) return 'news'
  if (NEWS_FROM.test(thread.fromAddr ?? '')) return 'news'
  if (NEWS_SNIPPET.test(thread.snippet ?? '')) return 'news'
  // 2. archive (read + stale)
  if (thread.unread === false && now - thread.lastDateMs > ARCHIVE_AGE_MS) return 'archive'
  // 3. important
  if (labels.has('IMPORTANT') || labels.has('STARRED')) return 'important'
  // 4. reply
  if (thread.unread === true && REPLY_QUESTION.test(thread.snippet ?? '')) return 'reply'
  // 5. all (fallback)
  return 'all'
}

export function classifyAll(threads: GmailThread[], now?: number): Record<GmailGroupKey, number> {
  const counts: Record<GmailGroupKey, number> = { all: threads.length, reply: 0, important: 0, archive: 0, news: 0 }
  for (const t of threads) {
    const g = classifyThread(t, now)
    if (g !== 'all') counts[g]++
  }
  return counts
}
```

- [ ] **Step 4: Run the classify test to verify it passes**

Run: `pnpm --filter @swarm/desktop exec vitest run src/lib/gmail/classify-thread.test.ts`
Expected: all pass.

- [ ] **Step 5: Create the `<GmailGroupBar>` component**

Create `apps/desktop/src/renderer/src/components/views/gmail-group-bar.tsx`:

```tsx
import { Sparkles } from 'lucide-react'

import type { GmailGroupKey } from '@/lib/gmail/classify-thread'
import { cn } from '@/lib/utils'

const GROUPS: { key: GmailGroupKey; label: string; smart: boolean }[] = [
  { key: 'all', label: '全部', smart: false },
  { key: 'reply', label: '待回复', smart: true },
  { key: 'important', label: '重要', smart: true },
  { key: 'archive', label: '可归档', smart: true },
  { key: 'news', label: '资讯', smart: true },
]

export function GmailGroupBar({
  groups,
  active,
  onPick,
}: {
  groups: Record<GmailGroupKey, number>
  active: GmailGroupKey
  onPick: (g: GmailGroupKey) => void
}): React.JSX.Element {
  return (
    <div className="flex flex-wrap items-center gap-2">
      {GROUPS.map((g) => {
        const isActive = active === g.key
        return (
          <button
            className={cn(
              'inline-flex items-center gap-1.5 rounded-full border px-3 py-1 text-xs transition-colors',
              isActive ? 'border-foreground bg-foreground text-background' : 'border-border bg-card text-foreground/70 hover:bg-accent'
            )}
            key={g.key}
            onClick={() => onPick(g.key)}
            type="button"
          >
            {g.smart ? <Sparkles className={cn('size-3', isActive ? 'text-violet-300' : 'text-violet-500')} /> : null}
            <span className="font-semibold">{g.label}</span>
            <span className={cn('tabular-nums', isActive ? 'text-background/70' : 'text-muted-foreground')}>
              {groups[g.key]}
            </span>
          </button>
        )
      })}
    </div>
  )
}
```

- [ ] **Step 6: Wire the group bar + filter into `gmail-inbox-view.tsx`**

In `apps/desktop/src/renderer/src/components/views/gmail-inbox-view.tsx`:

1. Imports:
```ts
import { GmailGroupBar } from './gmail-group-bar'
import { classifyAll, classifyThread, type GmailGroupKey } from '@/lib/gmail/classify-thread'
```

2. In `GmailInboxView`, add state:
```ts
  const [activeGroup, setActiveGroup] = useState<GmailGroupKey>('all')
```

3. After `const threads = list.data ?? []` (~line 95), add:
```ts
  const groupCounts = useMemo(() => classifyAll(threads), [threads])
  const visibleThreads = activeGroup === 'all' ? threads : threads.filter((t) => classifyThread(t) === activeGroup)
```
Import `useMemo` from react.

4. Render the group bar in the header (below the existing account/search row, before the list):
```tsx
        <GmailGroupBar active={activeGroup} groups={groupCounts} onPick={setActiveGroup} />
```

5. Change the thread list to iterate `visibleThreads` instead of `threads`.

- [ ] **Step 7: Verify**

Run: `pnpm --filter @swarm/desktop typecheck`
Expected: clean.

Run: `pnpm --filter @swarm/desktop exec vitest run src/lib/gmail/classify-thread.test.ts src/components/views/gmail-inbox-view.test.tsx`
Expected: classify tests green; inbox tests may need updating in Task 6 (some may still pass, some may fail because the list now shows filtered — note failures for Task 6).

- [ ] **Step 8: Commit**

```bash
git add apps/desktop/src/renderer/src/lib/gmail/classify-thread.ts apps/desktop/src/renderer/src/lib/gmail/classify-thread.test.ts apps/desktop/src/renderer/src/components/views/gmail-group-bar.tsx apps/desktop/src/renderer/src/components/views/gmail-inbox-view.tsx
git commit -m "feat(gmail): smart grouping (classifyThread pure rules + group bar + inbox filter)"
```

---

## Task 6: `<GmailAssistantCard>` + inbox integration (drop per-message analysis mount)

**Rationale:** The thread-level Agent assistant UI. Renders streaming summary + todos + suggest + draft area. Replaces the per-message `<MessageAnalysis>` mount.

**Files:**
- Create: `apps/desktop/src/renderer/src/components/views/gmail-assistant-card.tsx`
- Modify: `apps/desktop/src/renderer/src/components/views/gmail-inbox-view.tsx` (mount the card; remove `MessageAnalysis` mount; use `useThreadAnalysis`)
- Modify: `apps/desktop/src/renderer/src/components/views/gmail-inbox-view.test.tsx` (update tests)

**Interfaces:**
- Consumes: `useThreadAnalysis` (Task 4), `Streamdown`.
- Produces: `<GmailAssistantCard>` mounted in the inbox detail.

- [ ] **Step 1: Create `gmail-assistant-card.tsx`**

Create `apps/desktop/src/renderer/src/components/views/gmail-assistant-card.tsx`:

```tsx
// The thread-level Agent assistant card. Renders the streaming summary, the
// extracted todos, and the suggested reply with a "采用并回复" draft area.
// The draft is copy-only (the app is Gmail-readonly).
import { useState } from 'react'
import { Button } from '@swarm/ui'
import { Check, Copy, Loader2, RefreshCw, Sparkles } from 'lucide-react'
import { Streamdown } from 'streamdown'

import type { ThreadAnalysisState } from '@/hooks/use-thread-analysis'

export function GmailAssistantCard({
  analysis,
  messageCount,
  onRegenerate,
}: {
  analysis: ThreadAnalysisState
  messageCount: number
  onRegenerate: () => void
}): React.JSX.Element | null {
  const [draftOpen, setDraftOpen] = useState(false)
  const [draft, setDraft] = useState('')
  const [copied, setCopied] = useState(false)

  if (analysis.phase === 'idle') return null

  const copy = async (): Promise<void> => {
    await navigator.clipboard.writeText(draft)
    setCopied(true)
    setTimeout(() => setCopied(false), 1500)
  }

  return (
    <div className="overflow-hidden rounded-xl border border-violet-500/20 shadow-sm">
      <div className="flex items-center gap-2 border-b border-violet-500/15 bg-linear-to-br from-violet-500/10 to-primary/10 px-4 py-2.5">
        <span className="flex size-5 items-center justify-center rounded-md bg-linear-to-br from-violet-500 to-primary">
          <Sparkles className="size-3 text-white" />
        </span>
        <span className="font-semibold text-[13px] text-violet-700 dark:text-violet-300">Agent 助手</span>
        <span className="ml-auto text-[10.5px] text-violet-500/80">已读取全部 {messageCount} 条消息</span>
      </div>

      <div className="flex flex-col gap-3 bg-card p-4">
        {analysis.phase === 'streaming' && (
          <div className="flex items-center gap-2 text-muted-foreground text-xs">
            <Loader2 className="size-3.5 animate-spin" /> 分析中…
          </div>
        )}
        {(analysis.phase === 'streaming' || analysis.phase === 'done') && (
          <Streamdown className="text-[13px] text-foreground/90">
            {analysis.phase === 'done' ? analysis.summary : analysis.summaryText}
          </Streamdown>
        )}

        {analysis.phase === 'done' && analysis.todos.length > 0 && (
          <div className="flex flex-col gap-1.5">
            <p className="text-[10.5px] tracking-wide text-muted-foreground uppercase">抽取的待办</p>
            {analysis.todos.map((td, i) => (
              <div className="flex items-start gap-2" key={i}>
                <span className="mt-0.5 size-4 shrink-0 rounded border border-border" />
                <span className="text-[12.5px] text-foreground/80">{td.t}</span>
                {td.due && td.dueLabel ? (
                  <span className="ml-1 rounded bg-red-500/10 px-1.5 py-0.5 text-[10.5px] font-semibold text-red-600 dark:text-red-400">{td.dueLabel}</span>
                ) : null}
              </div>
            ))}
          </div>
        )}

        {analysis.phase === 'done' && analysis.suggest && (
          <div className="rounded-lg border border-border/60 bg-muted/40 p-3">
            <p className="mb-1.5 text-[10.5px] tracking-wide text-muted-foreground uppercase">建议回复</p>
            <p className="text-[12.5px] text-foreground/80">{analysis.suggest}</p>
            <div className="mt-2 flex gap-2">
              <Button
                onClick={() => {
                  setDraft(analysis.suggest)
                  setDraftOpen(true)
                }}
                size="sm"
              >
                采用并回复
              </Button>
              <Button onClick={onRegenerate} size="sm" variant="outline">
                <RefreshCw className="size-3.5" /> 重新生成
              </Button>
            </div>
          </div>
        )}

        {draftOpen && (
          <div className="flex flex-col gap-2">
            <textarea
              className="min-h-24 w-full rounded-md border border-border bg-background p-2 text-[13px]"
              onChange={(e) => setDraft(e.target.value)}
              value={draft}
            />
            <div className="flex items-center gap-2">
              <Button onClick={() => void copy()} size="sm" variant="outline">
                {copied ? <Check className="size-3.5" /> : <Copy className="size-3.5" />}
                {copied ? '已复制' : '复制到剪贴板'}
              </Button>
              <span className="text-[11px] text-muted-foreground">复制后到 Gmail 网页/客户端发送（应用保持只读）</span>
            </div>
          </div>
        )}

        {analysis.phase === 'error' && (
          <div className="flex items-center gap-2">
            <span className="text-[12px] text-destructive">{analysis.error}</span>
            <Button onClick={onRegenerate} size="sm" variant="outline">重试</Button>
          </div>
        )}
      </div>
    </div>
  )
}
```

- [ ] **Step 2: Wire into `gmail-inbox-view.tsx`; drop the per-message `MessageAnalysis` mount**

In `apps/desktop/src/renderer/src/components/views/gmail-inbox-view.tsx`:

1. Imports:
```ts
import { GmailAssistantCard } from './gmail-assistant-card'
import { useThreadAnalysis } from '@/hooks/use-thread-analysis'
```

2. Inside the detail render (where `selectedId !== null` and `detail.data` exists), build the thread input for the hook and call it:
```ts
          const threadInput = detail.data
            ? { id: selectedId!, subject: detail.data.thread.subject, messages: detail.data.messages.map((m) => ({ from: m.fromAddr, dateMs: m.dateMs, bodyText: m.bodyText })) }
            : null
          const analysis = useThreadAnalysis(threadInput)
```
(`useThreadAnalysis` must be called unconditionally per rules-of-hooks — lift it above the early returns, keyed on `selectedId`. Refactor: call `useThreadAnalysis(selectedId ? threadInputRef.current : null)` via a ref, OR move the hook call into a child component `<ThreadDetail>` that only mounts when `selectedId` is set. The child-component approach is cleaner — extract the right pane into a `<GmailThreadDetail threadId thread subject messages />` component that calls the hook.)

**Use the child-component approach:** create an inline `GmailThreadDetail` component in the same file (or inline the JSX) that receives `detail.data` + `selectedId` and calls `useThreadAnalysis`. This avoids conditional-hook violations.

3. Mount `<GmailAssistantCard analysis={analysis} messageCount={detail.data.messages.length} onRegenerate={() => /* re-trigger */} />` at the TOP of the detail column, before `messages.map(MessageCard)`.

4. **Remove** the `<MessageAnalysis ... />` line from inside `MessageCard` (or stop rendering it). Keep the `MessageAnalysis` component defined (backward compat) but it's no longer mounted. Remove its import usage if it becomes orphaned.

- [ ] **Step 3: Update `gmail-inbox-view.test.tsx`**

Read the existing test file. Tests that asserted on per-message analysis (e.g. clicking "分析", streaming text) need updating: the thread assistant replaces that flow. Update or remove those tests; add a smoke test that the assistant card renders (mock `useThreadAnalysis` via mocking `swarmApi.analyzeThread` + the event stream, or just assert the card container appears).

Keep the structural tests (login prompt, list rendering, search) intact.

- [ ] **Step 4: Verify**

Run: `pnpm --filter @swarm/desktop typecheck`
Expected: clean (watch for hooks-rule violations).

Run: `pnpm --filter @swarm/desktop exec vitest run src/components/views/gmail-inbox-view.test.tsx`
Expected: green.

- [ ] **Step 5: Commit**

```bash
git add apps/desktop/src/renderer/src/components/views/gmail-assistant-card.tsx apps/desktop/src/renderer/src/components/views/gmail-inbox-view.tsx apps/desktop/src/renderer/src/components/views/gmail-inbox-view.test.tsx
git commit -m "feat(gmail): thread Agent assistant card (summary/todos/suggest + draft area); drop per-message analysis mount"
```

---

## Task 7: Full verify, cross-cutting final review, progress ledger

**Rationale:** Final gate. Confirm the whole branch is green and the spec's success criteria hold.

**Files:**
- Create (local, gitignored): `.superpowers/sdd/progress-gmail.md`

- [ ] **Step 1: Full verify**

Run: `pnpm verify`
Expected: typecheck clean; tests pass (1260 baseline + Phase 6c new tests ≈ +20); `check-boundaries` passes. The `host.test.ts` EADDRINUSE flake is environmental (live dev-server) — not a regression.

- [ ] **Step 2: Cross-cutting review checklist**

Walk these seams (controller-level mental check, or dispatch an Explore agent):

1. **Type flow:** `AnalyzeThreadInput` (renderer) → `swarm:analyzeThread` (preload) → `AnalyzeThreadRequest` (+provider, main) → `analyzeThread` (service) → broadcast `gmail.threadAnalysisComplete` (with `summary/todos/suggest`) → `useThreadAnalysis` → `<GmailAssistantCard>`. Verify the field names match end-to-end.
2. **Cache round-trip:** Complete → `saveThreadAnalysis` → `getThreadAnalysis` returns the same shape.
3. **Grouping:** counts in the bar match `classifyAll`; clicking a chip filters; switching back to 全部 restores.
4. **Subscription cleanup:** switching threads doesn't leak subscriptions (old threadId's events ignored).
5. **Provider missing:** assistant card shows the prompt, not a dead spinner.
6. **Dark mode:** group bar, assistant card, draft area legible.
7. **`analyzeEmail` backward compat:** the old path still compiles (not mounted but present).
8. **`gmail-thread-analyst` in formations:** appears as an independent agent; delegation edges intact.

- [ ] **Step 3: Write the progress ledger**

Create `.superpowers/sdd/progress-gmail.md` (gitignored — local recovery map):

```markdown
# Progress — Phase 6c Gmail Redesign

Spec: docs/superpowers/specs/2026-07-06-gmail-redesign-design.md
Plan: docs/superpowers/plans/2026-07-06-gmail-redesign.md
Branch: feat/gmail-redesign  Base: e5ad295 (develop post 6a + hooks)

## Tasks
- [x] Task 1: protocol types (GmailThreadAnalysis/AnalyzeThread I/O/threadAnalysis UIEvents) — complete (commit <hash>)
- [x] Task 2: gmail-thread-analyst agent (tail-JSON system prompt) — complete (commit <hash>)
- [x] Task 3: backend analyzeThread (factory + IPC + thread_analyses cache + preload) — complete (commit <hash>)
- [x] Task 4: swarmApi + useThreadAnalysis hook — complete (commit <hash>)
- [x] Task 5: classifyThread pure fn + group bar + inbox filter — complete (commit <hash>)
- [x] Task 6: GmailAssistantCard + inbox integration — complete (commit <hash>)
- [x] Task 7: full verify + review + ledger — complete

## Final review: READY to merge
- Full suite N/N green (host.test flake aside); typecheck clean; check-boundaries OK.
- Deviations honored: rule-based grouping, draft-area reply (readonly), display-only todos, MessageAnalysis kept-but-unmounted.

## Follow-ups
- LLM-based grouping refinement; todo ingestion into task台/calendar; batch thread analysis; send-mail capability.
```

Fill commit hashes from `git log --oneline feat/gmail-redesign ^develop`.

- [ ] **Step 4: Report merge-readiness**

Report to the user: branch ready to merge into develop (fast-forward or PR). GUI smoke per spec §5 deferred to user.

---

## Self-Review (run after writing this plan)

**1. Spec coverage:**
- §1 smart grouping → Tasks 5 ✓
- §1 thread assistant backend → Tasks 1-3 ✓
- §1 useThreadAnalysis (auto-trigger/stream/cache/cancel) → Task 4 ✓
- §1 assistant card (summary/todos/suggest/draft) → Task 6 ✓
- §1 drop per-message analysis mount → Task 6 ✓
- §1 success criteria → Task 7 Step 2 walks each ✓
- Non-goals (send, todo ingestion, batch, LLM-grouping) → respected ✓

**2. Placeholder scan:** No "TBD"/"TODO"/"implement later". Code blocks contain real code. Two implementation notes flagged inline (the `QueryCardProvider` typo in Task 4's test scaffold → "must be QueryClientProvider"; the hook signature Option A vs B → resolved to A). Commit hashes in the ledger template are `<hash>` filled at Task 7 Step 3 — execution-time fill, acceptable.

**3. Type consistency:**
- `ThreadAnalysisPayload` (Task 1) = `{summary, todos: Todo[], suggest}`; `GmailThreadAnalysis` extends it with `updatedAt` (Task 1) ✓
- `Todo` (Task 1) = `{t, due?, dueLabel?}`; used in Task 3 broadcast, Task 4 hook state, Task 6 card ✓
- `AnalyzeThreadInput` (Task 1) → preload (Task 3) → swarmApi (Task 4) → hook (Task 4) ✓
- `GmailGroupKey` (Task 5) = `'reply'|'important'|'archive'|'news'|'all'`; used in group bar + inbox ✓
- `ThreadAnalysisState` (Task 4) phases `idle|streaming|done|error`; consumed in Task 6 card ✓
- broadcast event names `gmail.threadAnalysis{Delta,Complete,Error}` consistent across Task 1 (types), Task 3 (broadcaster), Task 4 (subscriber) ✓

**4. Risk notes for the implementer (flagged inline, not blockers):**
- Task 3 Step 9: the gmail IPC handler file location needs grep confirmation (`gmail:saveAnalysis` reference).
- Task 4: hook signature must use Option A (caller passes the thread object) to fill analyzeThread's subject/messages.
- Task 6: hooks-rule compliance — extract a `<GmailThreadDetail>` child to call `useThreadAnalysis` unconditionally.
- Task 6 Step 3: the existing `gmail-inbox-view.test.tsx` content is unknown; the implementer must read it before rewriting.

Plan is complete.
