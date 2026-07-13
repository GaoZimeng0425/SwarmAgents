# Gmail Email Analyze Agent + Per-Message Analyze Button — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add a visible builtin `gmail-analyst` agent and an「分析」button on every Gmail message card that streams a structured Chinese Markdown analysis inline beneath the email body, cached per message.

**Architecture:** A new service method `analyzeEmail` runs the `gmail-analyst` agent one-shot and tool-less over the email's `bodyText`, streaming `gmail.analysis{Delta,Complete,Error}` events back over the existing service→main→renderer event bus. Main injects the active provider (exactly like `createSession`) and forwards events generically via `toRendererEvent`. Results persist in a new `analyses` table in the Gmail sqlite cache. The renderer's new `MessageAnalysis` component subscribes to events filtered by `messageId`, renders incremental Markdown via `Streamdown`, and saves the final result through the gmail bridge.

**Tech Stack:** TypeScript, Electron (main + service UtilityProcess + renderer), React 19, TanStack Query, vitest (jsdom for renderer), better-sqlite3, `streamdown` for Markdown, `@swarm/protocol` (shared wire types), `@swarm/shared` (builtin agents).

## Global Constraints

- **Language:** code comments and commit messages in English. UI copy (button labels, the analysis output itself) in Chinese. The `gmail-analyst` system prompt forces Chinese output regardless of the email's language.
- **Run tests via Electron node:** `cd apps/desktop && ELECTRON_RUN_AS_NODE=1 electron node_modules/vitest/vitest.mjs run <path>` — never bare `npx vitest`, never `pnpm rebuild better-sqlite3`.
- **Renderer tests** must start with `// @vitest-environment jsdom` (the `environmentMatchGlobs` in `vitest.config.ts` is not honored).
- **Scoped lint:** `cd apps/desktop && node_modules/.bin/biome check --write <file>` — do not run repo-wide `pnpm check`.
- **Worktree:** this plan executes inside the `feat-gmail-analyze-agent` worktree (already created, based on `develop`, node_modules symlinked). Commit per task.

---

## File Structure

**Create:**
- `apps/desktop/src/service/gmail/analyze.ts` — `createAnalyzeEmail(deps)`: builds a one-shot tool-less runner, translates its events to `gmail.analysis*` broadcasts. One responsibility.
- `apps/desktop/src/service/gmail/analyze.test.ts` — unit test with a stubbed runner factory.

**Modify:**
- `packages/shared/src/constants/agents.ts` — add `gmail-analyst` to `baseAgents`.
- `packages/shared/src/constants/agents.test.ts` — assert the new builtin ships.
- `packages/protocol/src/types/ui.ts` — add `gmail.analysis*` UIEvent variants; `AnalyzeEmailInput/Request/Result`; `GmailAnalysis`; extend `SwarmBridge` (`analyzeEmail`) and `GmailBridge` (`saveAnalysis`, `getAnalyses`).
- `packages/protocol/src/types/service-ipc.ts` — add `'analyzeEmail'` to `ServiceMethod`.
- `packages/protocol/src/service-client.ts` — add `analyzeEmail` to the `ServiceClient` type and impl.
- `apps/desktop/src/main/gmail/cache.ts` — `analyses` table + `saveAnalysis` / `getAnalyses`.
- `apps/desktop/src/main/gmail/cache.test.ts` — cover the two new methods.
- `apps/desktop/src/main/gmail/service.ts` — expose `saveAnalysis` / `getAnalyses`.
- `apps/desktop/src/main/gmail/ipc.ts` — `gmail:saveAnalysis` / `gmail:getAnalyses` handlers.
- `apps/desktop/src/service/ipc/dispatcher.ts` — route `analyzeEmail`.
- `apps/desktop/src/service/index.ts` — wire `analyzeEmail` into the dispatcher config.
- `apps/desktop/src/main/ipc/swarm-ipc.ts` — `swarm:analyzeEmail` handler that injects the active provider.
- `apps/desktop/src/preload/index.ts` — expose `swarm.analyzeEmail`, `gmail.saveAnalysis`, `gmail.getAnalyses`.
- `apps/desktop/src/renderer/src/components/views/gmail-inbox-view.tsx` — new `MessageAnalysis` component; wire into `MessageCard`; parallel `getAnalyses` query.

---

### Task 1: `gmail-analyst` builtin agent

**Files:**
- Modify: `packages/shared/src/constants/agents.ts`
- Test: `packages/shared/src/constants/agents.test.ts`

**Interfaces:**
- Produces: `defaultAgents` now contains an entry with `id: 'gmail-analyst'`, `toolScope: 'peekaboo'`, `maxIterations: 2`, `capabilities: ['gmail-analyze']`. Consumed by the agent store reconcile (already wired in `service/index.ts`) and by Task 5's fallback lookup.

- [ ] **Step 1: Write the failing test**

Append to `packages/shared/src/constants/agents.test.ts` (inside the top `describe` that imports `defaultAgents`; if the file's structure differs, add a new `describe('gmail-analyst builtin', ...)` block):

```ts
import { defaultAgents } from './agents'

describe('gmail-analyst builtin', () => {
  it('ships a peekaboo, no-tool analysis agent', () => {
    const a = defaultAgents.find((d) => d.id === 'gmail-analyst')
    expect(a).toBeDefined()
    expect(a?.toolScope).toBe('peekaboo')
    expect(a?.maxIterations).toBe(2)
    expect(a?.capabilities).toContain('gmail-analyze')
    expect(a?.systemPrompt).toMatch(/中文/)
    expect(a?.systemPrompt).toMatch(/摘要/)
  })
})
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd apps/desktop && ELECTRON_RUN_AS_NODE=1 electron node_modules/vitest/vitest.mjs run ../../packages/shared/src/constants/agents.test.ts`
Expected: FAIL — `expected undefined to be defined` (no `gmail-analyst` yet).

- [ ] **Step 3: Write minimal implementation**

In `packages/shared/src/constants/agents.ts`, add the prompt constant near the other `*_SYSTEM_PROMPT` declarations (e.g. just before `const COORDINATION_PROTOCOL`):

```ts
const GMAIL_ANALYST_SYSTEM_PROMPT = `You are the Gmail 邮件分析 agent. You receive a single email's text and produce a concise Chinese analysis — 无论邮件原文是什么语种, always answer in 中文.

Output exactly this Markdown structure, and nothing before the first heading:

## 摘要
2–3 句话概括邮件核心内容。

## 关键要点
- 用项目符号列出 3–6 个关键信息点。

## 待办事项
- 用 [ ] 复选框列出收件人需要采取的行动;若邮件不要求任何行动,写一行 "无"。

## 优先级与分类
一行结论,格式为 "优先级 · 类别",例如 "高 · 需回复"、"中 · 审批"、"低 · 订阅通知";后跟一句简短理由。

要求:简洁;不得编造邮件中不存在的事实;忽略营销跟踪像素和签名档废话。`
```

Then add the agent to the `baseAgents` array (after the `default` entry is a fine spot):

```ts
  {
    id: 'gmail-analyst',
    name: 'Gmail 邮件分析',
    description: '分析单封邮件,输出结构化中文摘要(摘要/关键要点/待办/优先级)。Gmail 收件箱的「分析」按钮调用它。',
    systemPrompt: GMAIL_ANALYST_SYSTEM_PROMPT,
    toolScope: 'peekaboo',
    maxIterations: 2,
    role: 'gmail-analyst',
    capabilities: ['gmail-analyze'],
    skills: [],
  },
```

- [ ] **Step 4: Run test to verify it passes**

Run: `cd apps/desktop && ELECTRON_RUN_AS_NODE=1 electron node_modules/vitest/vitest.mjs run ../../packages/shared/src/constants/agents.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add packages/shared/src/constants/agents.ts packages/shared/src/constants/agents.test.ts
git commit -m "feat(agents): add gmail-analyst builtin agent for email analysis"
```

---

### Task 2: Protocol wire types

**Files:**
- Modify: `packages/protocol/src/types/ui.ts`
- Modify: `packages/protocol/src/types/service-ipc.ts`
- Modify: `packages/protocol/src/service-client.ts`

**Interfaces:**
- Produces (consumed by later tasks):
  - `AnalyzeEmailInput` `{ messageId, subject, from, content }`, `AnalyzeEmailRequest = AnalyzeEmailInput & { provider: ProviderInjection }`, `AnalyzeEmailResult`, `GmailAnalysis`.
  - `UIEvent` gains `gmail.analysisDelta | gmail.analysisComplete | gmail.analysisError`.
  - `ServiceMethod` gains `'analyzeEmail'`.
  - `SwarmBridge.analyzeEmail(input): Promise<AnalyzeEmailResult>` (renderer→main; no provider).
  - `GmailBridge.saveAnalysis` / `getAnalyses`.
  - `ServiceClient.analyzeEmail(req): Promise<AnalyzeEmailResult>` (main→service; with provider).

This is a type-only foundation task; verification is a typecheck.

- [ ] **Step 1: Add the analyze + analysis types and UIEvent variants**

In `packages/protocol/src/types/ui.ts`, add the new types near the other small types (e.g. just above `export type UIEvent =`):

```ts
/** Renderer→Main: analyze one email. Main injects the active provider before
 *  forwarding to the service, so the renderer never handles a provider here. */
export type AnalyzeEmailInput = {
  messageId: string
  subject: string
  from: string
  content: string
}

/** Main→Service: the input plus the resolved active provider. */
export type AnalyzeEmailRequest = AnalyzeEmailInput & {
  provider: import('./provider').ProviderInjection
}

export type AnalyzeEmailResult = { ok: true } | { ok: false; code: 'no_provider' | 'no_agent'; message: string }

/** A cached analysis row, keyed by message id. */
export type GmailAnalysis = { analysis: string; updatedAt: number }
```

Add the three variants to the `UIEvent` union (after the `agents.changed` line):

```ts
  | { kind: 'gmail.analysisDelta'; messageId: string; text: string; ts: number; seq?: number }
  | { kind: 'gmail.analysisComplete'; messageId: string; markdown: string; ts: number; seq?: number }
  | { kind: 'gmail.analysisError'; messageId: string; error: string; ts: number; seq?: number }
```

- [ ] **Step 2: Extend SwarmBridge and GmailBridge**

Still in `ui.ts`, add `analyzeEmail` to the `SwarmBridge` type (next to `submitGoal`):

```ts
  analyzeEmail(input: AnalyzeEmailInput): Promise<AnalyzeEmailResult>
```

Add the two persistence methods to the `GmailBridge` type (next to `getThread`):

```ts
  saveAnalysis(messageId: string, analysis: string): Promise<void>
  getAnalyses(threadId: string): Promise<Record<string, GmailAnalysis>>
```

- [ ] **Step 3: Add the service method**

In `packages/protocol/src/types/service-ipc.ts`, add to the `ServiceMethod` union:

```ts
  | 'analyzeEmail'
```

- [ ] **Step 4: Add ServiceClient.analyzeEmail**

In `packages/protocol/src/service-client.ts`, add to the `ServiceClient` type (after `submitGoal`):

```ts
  analyzeEmail(req: import('./types/ui').AnalyzeEmailRequest): Promise<import('./types/ui').AnalyzeEmailResult>
```

And the impl in the returned object (after the `submitGoal` method):

```ts
    analyzeEmail(req) {
      return call('analyzeEmail', [req])
    },
```

- [ ] **Step 5: Typecheck the protocol package**

Run: `cd packages/protocol && npx tsc --noEmit`
Expected: no errors.

- [ ] **Step 6: Commit**

```bash
git add packages/protocol/src/types/ui.ts packages/protocol/src/types/service-ipc.ts packages/protocol/src/service-client.ts
git commit -m "feat(protocol): add gmail email-analyze wire types"
```

---

### Task 3: Cache `analyses` table + methods

**Files:**
- Modify: `apps/desktop/src/main/gmail/cache.ts`
- Test: `apps/desktop/src/main/gmail/cache.test.ts`

**Interfaces:**
- Produces: `Cache.saveAnalysis(messageId, analysis): void` and `Cache.getAnalyses(threadId): Record<string, GmailAnalysis>`.

- [ ] **Step 1: Write the failing tests**

In `apps/desktop/src/main/gmail/cache.test.ts`, add (the existing file already creates a `:memory:` cache via `createCache({ filePath: ':memory:' })`; mirror its setup):

```ts
import { createCache } from './cache'

describe('analyses cache', () => {
  it('round-trips an analysis keyed by message id', () => {
    const c = createCache({ filePath: ':memory:' })
    c.upsertThreads([{ id: 't1', snippet: '', fromAddr: '', subject: '', lastDateMs: 1, labelIds: [], unread: false }])
    c.upsertMessages([
      { id: 'm1', threadId: 't1', fromAddr: '', toAddrs: [], subject: '', snippet: '', bodyText: '', htmlBody: '', dateMs: 1, labelIds: [] },
    ])
    c.saveAnalysis('m1', '## 摘要\nhi')
    const map = c.getAnalyses('t1')
    expect(map.m1.analysis).toBe('## 摘要\nhi')
    expect(map.m1.updatedAt).toBeGreaterThan(0)
  })

  it('overwrites on re-analyze and only returns the thread’s messages', () => {
    const c = createCache({ filePath: ':memory:' })
    c.upsertThreads([
      { id: 't1', snippet: '', fromAddr: '', subject: '', lastDateMs: 1, labelIds: [], unread: false },
      { id: 't2', snippet: '', fromAddr: '', subject: '', lastDateMs: 1, labelIds: [], unread: false },
    ])
    c.upsertMessages([
      { id: 'm1', threadId: 't1', fromAddr: '', toAddrs: [], subject: '', snippet: '', bodyText: '', htmlBody: '', dateMs: 1, labelIds: [] },
      { id: 'm2', threadId: 't2', fromAddr: '', toAddrs: [], subject: '', snippet: '', bodyText: '', htmlBody: '', dateMs: 1, labelIds: [] },
    ])
    c.saveAnalysis('m1', 'old')
    c.saveAnalysis('m1', 'new')
    c.saveAnalysis('m2', 'other thread')
    expect(c.getAnalyses('t1').m1.analysis).toBe('new')
    expect(c.getAnalyses('t1').m2).toBeUndefined()
  })
})
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `cd apps/desktop && ELECTRON_RUN_AS_NODE=1 electron node_modules/vitest/vitest.mjs run src/main/gmail/cache.test.ts`
Expected: FAIL — `c.saveAnalysis is not a function`.

- [ ] **Step 3: Implement the table + methods**

In `apps/desktop/src/main/gmail/cache.ts`:

Add to the `SCHEMA` string (after the `messages` index lines):

```sql
CREATE TABLE IF NOT EXISTS analyses (
  messageId TEXT PRIMARY KEY, analysis TEXT, updatedAt INTEGER
);
```

Add to the `Cache` type (next to `countMessages`):

```ts
  saveAnalysis(messageId: string, analysis: string): void
  getAnalyses(threadId: string): Record<string, import('@swarm/protocol').GmailAnalysis>
```

Inside `createCache`, after the `setStats` prepared-statement block, add the prepared statements and methods:

```ts
  const upsertAnalysis = db.prepare(
    `INSERT INTO analyses (messageId, analysis, updatedAt) VALUES (@messageId, @analysis, @updatedAt)
     ON CONFLICT(messageId) DO UPDATE SET analysis=@analysis, updatedAt=@updatedAt`
  )
  const saveAnalysis: Cache['saveAnalysis'] = (messageId, analysis) => {
    upsertAnalysis.run({ messageId, analysis, updatedAt: Date.now() })
  }
  const getAnalyses: Cache['getAnalyses'] = (threadId) => {
    const rows = db
      .prepare(
        `SELECT a.messageId AS messageId, a.analysis AS analysis, a.updatedAt AS updatedAt
         FROM analyses a JOIN messages m ON a.messageId = m.id
         WHERE m.threadId = ?`
      )
      .all(threadId) as { messageId: string; analysis: string; updatedAt: number }[]
    const out: Record<string, import('@swarm/protocol').GmailAnalysis> = {}
    for (const r of rows) out[r.messageId] = { analysis: r.analysis, updatedAt: r.updatedAt }
    return out
  }
```

And add `saveAnalysis` and `getAnalyses` to the returned object literal (next to `countMessages`/`listRecent`).

- [ ] **Step 4: Run tests to verify they pass**

Run: `cd apps/desktop && ELECTRON_RUN_AS_NODE=1 electron node_modules/vitest/vitest.mjs run src/main/gmail/cache.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add apps/desktop/src/main/gmail/cache.ts apps/desktop/src/main/gmail/cache.test.ts
git commit -m "feat(gmail): cache analyses table + save/get methods"
```

---

### Task 4: Main gmail persistence bridge

**Files:**
- Modify: `apps/desktop/src/main/gmail/service.ts`
- Modify: `apps/desktop/src/main/gmail/ipc.ts`
- Modify: `apps/desktop/src/preload/index.ts`

**Interfaces:**
- Consumes: `Cache.saveAnalysis` / `getAnalyses` (Task 3), `GmailBridge` methods (Task 2).
- Produces: renderer can call `window.swarm.gmail.saveAnalysis(id, markdown)` and `window.swarm.gmail.getAnalyses(threadId)`.

- [ ] **Step 1: Expose the methods on the gmail service**

In `apps/desktop/src/main/gmail/service.ts`, add to the `Service` type (next to `getThread`):

```ts
  saveAnalysis(messageId: string, analysis: string): void
  getAnalyses(threadId: string): ReturnType<Cache['getAnalyses']>
```

Add to the returned object (next to `getThread: (id) => deps.cache.getThread(id),`):

```ts
    saveAnalysis: (messageId, analysis) => deps.cache.saveAnalysis(messageId, analysis),
    getAnalyses: (threadId) => deps.cache.getAnalyses(threadId),
```

- [ ] **Step 2: Add the IPC handlers**

In `apps/desktop/src/main/gmail/ipc.ts`, register handlers (next to the other `ipcMain.handle('gmail:…')` lines):

```ts
  ipcMain.handle('gmail:saveAnalysis', (_e, messageId: string, analysis: string) =>
    service.saveAnalysis(String(messageId), String(analysis))
  )
  ipcMain.handle('gmail:getAnalyses', (_e, threadId: string) => service.getAnalyses(String(threadId)))
```

Add `'gmail:saveAnalysis'` and `'gmail:getAnalyses'` to the dispose channel list inside `dispose()`.

- [ ] **Step 3: Expose on the preload gmail bridge**

In `apps/desktop/src/preload/index.ts`, add to the `gmail` object (after `search:`):

```ts
  saveAnalysis: (messageId: string, analysis: string) =>
    ipcRenderer.invoke('gmail:saveAnalysis', messageId, analysis) as Promise<void>,
  getAnalyses: (threadId: string) =>
    ipcRenderer.invoke('gmail:getAnalyses', threadId) as Promise<
      Record<string, import('@swarm/protocol').GmailAnalysis>
    >,
```

Also add `GmailAnalysis` to the type import list at the top of the file.

- [ ] **Step 4: Typecheck**

Run: `cd apps/desktop && npm run typecheck`
Expected: no errors.

- [ ] **Step 5: Commit**

```bash
git add apps/desktop/src/main/gmail/service.ts apps/desktop/src/main/gmail/ipc.ts apps/desktop/src/preload/index.ts
git commit -m "feat(gmail): expose saveAnalysis + getAnalyses over IPC"
```

---

### Task 5: Service `analyzeEmail` (runner + streaming events)

**Files:**
- Create: `apps/desktop/src/service/gmail/analyze.ts`
- Create: `apps/desktop/src/service/gmail/analyze.test.ts`
- Modify: `apps/desktop/src/service/ipc/dispatcher.ts`
- Modify: `apps/desktop/src/service/index.ts`

**Interfaces:**
- Consumes: `defaultAgents` (Task 1), `AnalyzeEmailRequest/Result` (Task 2), `createAgentRunner`, `createPermissionRegistry`, `applyAgentModel`, `Broadcaster`, `AgentStore`, `ToolRegistry`, `getBudgetConfig`.
- Produces: `createAnalyzeEmail(deps) → analyzeEmail(req): AnalyzeEmailResult`. It broadcasts `gmail.analysisDelta|Complete|Error` via the broadcaster and returns an ack synchronously (the run proceeds async).

- [ ] **Step 1: Write the failing test**

Create `apps/desktop/src/service/gmail/analyze.test.ts`:

```ts
// @vitest-environment node
import type { AgentRunner, AgentRunnerDeps } from '../session/agent-runner'
import { emptyUsed } from '@swarm/protocol'
import { describe, expect, it, vi } from 'vitest'

import { createAnalyzeEmail } from './analyze'

const fakeProvider = { id: 'p', model: 'm' } as unknown as import('@swarm/protocol').ProviderInjection

function fakeRunner(events: { event: string; data: unknown }[]): typeof createAgentRunner {
  return ((deps: AgentRunnerDeps) => ({
    run: async () => {
      for (const e of events) deps.emit(e.event, e.data)
      return { status: 'completed' as const, summary: '## 摘要\n测试', messages: [], used: emptyUsed() }
    },
  })) as unknown as typeof createAgentRunner
}

describe('analyzeEmail', () => {
  it('streams deltas then complete, and returns an ack immediately', async () => {
    const broadcasts: Array<[string, unknown]> = []
    const broadcaster = { broadcast: (e: string, d: unknown) => broadcasts.push([e, d]) }
    const agentStore = { get: () => undefined } // force defaultAgents fallback
    const toolRegistry = {} as unknown as Parameters<typeof createAnalyzeEmail>[0]['toolRegistry']
    const analyze = createAnalyzeEmail({
      broadcaster: broadcaster as unknown as Parameters<typeof createAnalyzeEmail>[0]['broadcaster'],
      agentStore: agentStore as unknown as Parameters<typeof createAnalyzeEmail>[0]['agentStore'],
      toolRegistry,
      getBudgetConfig: () => ({ main: { tokens: 0, calls: 0, wallMs: 0, usdCents: 0 }, sub: { tokens: 0, calls: 0, wallMs: 0, usdCents: 0 } }),
      createRunner: fakeRunner([
        { event: 'task.progress', data: { taskId: 'm1', event: { kind: 'llm.message', role: 'assistant', content: '## 摘要\n', ts: 1 } } },
        { event: 'task.progress', data: { taskId: 'm1', event: { kind: 'llm.message', role: 'assistant', content: '测试', ts: 2 } } },
        { event: 'task.complete', data: { taskId: 'm1', result: { summary: '## 摘要\n测试', artifacts: [] }, ts: 3 } },
      ]),
    })

    const ack = analyze({
      messageId: 'm1',
      subject: 's',
      from: 'a@b',
      content: 'body',
      provider: fakeProvider,
    })

    expect(ack).toEqual({ ok: true })
    // The run is fire-and-forget; await a microtask flush.
    await new Promise((r) => setTimeout(r, 0))
    const deltas = broadcasts.filter(([e]) => e === 'gmail.analysisDelta')
    expect(deltas.map(([, d]) => (d as { text: string }).text)).toEqual(['## 摘要\n', '测试'])
    const complete = broadcasts.find(([e]) => e === 'gmail.analysisComplete')
    expect((complete![1] as { markdown: string }).markdown).toBe('## 摘要\n测试')
    expect((complete![1] as { messageId: string }).messageId).toBe('m1')
  })

  it('returns no_provider when the provider is missing', () => {
    const analyze = createAnalyzeEmail({
      broadcaster: { broadcast: () => undefined } as unknown as Parameters<typeof createAnalyzeEmail>[0]['broadcaster'],
      agentStore: { get: () => undefined } as unknown as Parameters<typeof createAnalyzeEmail>[0]['agentStore'],
      toolRegistry: {} as unknown as Parameters<typeof createAnalyzeEmail>[0]['toolRegistry'],
      getBudgetConfig: () => ({ main: { tokens: 0, calls: 0, wallMs: 0, usdCents: 0 }, sub: { tokens: 0, calls: 0, wallMs: 0, usdCents: 0 } }),
    })
    const r = analyze({ messageId: 'm1', subject: '', from: '', content: '', provider: undefined as never })
    expect(r).toEqual({ ok: false, code: 'no_provider', message: expect.any(String) })
  })
})
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd apps/desktop && ELECTRON_RUN_AS_NODE=1 electron node_modules/vitest/vitest.mjs run src/service/gmail/analyze.test.ts`
Expected: FAIL — `Cannot find module './analyze'`.

- [ ] **Step 3: Implement `createAnalyzeEmail`**

Create `apps/desktop/src/service/gmail/analyze.ts`:

```ts
// One-shot, tool-less analysis of a single email's bodyText. Mirrors the
// buildAnalyzeImage precedent (agent-runner.ts): a silent-ish runner with an
// empty tool allowlist, but its `emit` is wired to broadcast progress so the
// renderer's MessageAnalysis panel can stream. The gmail-analyst agent
// (a visible builtin) supplies the Chinese structured-Markdown prompt.
import { createLogger } from '@shared/logger'
import type { AnalyzeEmailRequest, AnalyzeEmailResult } from '@swarm/protocol'
import { applyAgentModel, defaultAgents } from '@swarm/shared'
import { ulid } from 'ulid'

import { type AgentRunnerDeps, createAgentRunner } from '../session/agent-runner'
import { createPermissionRegistry } from '../session/permission-registry'
import type { AgentStore } from '../agents/store'
import type { Broadcaster } from '../ipc/broadcaster'
import type { ToolRegistry } from '../tools/registry'

const log = createLogger({ process: 'service' }).child({ component: 'gmail-analyze' })

const GMAIL_ANALYST_ID = 'gmail-analyst'

export type AnalyzeDeps = {
  broadcaster: Broadcaster
  agentStore: Pick<AgentStore, 'get'>
  toolRegistry: ToolRegistry
  getBudgetConfig(): import('@swarm/protocol').BudgetConfig
  /** Injectable so tests can stub the runner without a real provider. */
  createRunner?: typeof createAgentRunner
}

export function createAnalyzeEmail(deps: AnalyzeDeps): (req: AnalyzeEmailRequest) => AnalyzeEmailResult {
  const createRunner = deps.createRunner ?? createAgentRunner
  return (req) => {
    if (!req.provider) {
      return { ok: false, code: 'no_provider', message: '请先在 设置 → 模型 配置提供商。' }
    }
    const def = deps.agentStore.get(GMAIL_ANALYST_ID) ?? defaultAgents.find((a) => a.id === GMAIL_ANALYST_ID)
    if (!def) {
      return { ok: false, code: 'no_agent', message: 'gmail-analyst agent 不可用。' }
    }
    log.info({
      msg: 'analyze started',
      messageId: req.messageId,
      subjectLen: req.subject.length,
      contentLen: req.content.length,
    })

    const messageId = req.messageId
    const emit = (event: string, data: unknown): void => {
      const obj = (data && typeof data === 'object' ? data : {}) as Record<string, unknown>
      if (event === 'task.progress') {
        const ev = obj.event as { kind?: string; content?: string } | undefined
        if (ev?.kind === 'llm.message' && typeof ev.content === 'string') {
          deps.broadcaster.broadcast('gmail.analysisDelta', { messageId, text: ev.content, ts: Date.now() })
        }
      } else if (event === 'task.complete') {
        const markdown = (obj.result as { summary?: string } | undefined)?.summary ?? ''
        deps.broadcaster.broadcast('gmail.analysisComplete', { messageId, markdown, ts: Date.now() })
      } else if (event === 'task.error') {
        const error = (obj.error as { message?: string } | undefined)?.message ?? 'analysis failed'
        deps.broadcaster.broadcast('gmail.analysisError', { messageId, error, ts: Date.now() })
      }
    }

    const runnerDeps: AgentRunnerDeps = {
      correlationId: messageId,
      goal: `分析下面这封邮件。\n\nSubject: ${req.subject}\nFrom: ${req.from}\n\n${req.content}`,
      executionMode: 'goal',
      budget: deps.getBudgetConfig().sub,
      toolAllowlist: [],
      provider: applyAgentModel(req.provider, def),
      agentDefinition: def,
      sessionId: `analyze:${ulid()}`,
      emit,
      permissionRegistry: createPermissionRegistry(() => undefined),
      toolRegistry: deps.toolRegistry,
      initialMessages: [],
      spawnChild: () => Promise.reject(new Error('spawnChild unavailable in analyze')),
      maxVerifyRounds: 0,
      maxIterationsOverride: def.maxIterations,
    }

    const t0 = Date.now()
    void createRunner(runnerDeps)
      .run()
      .then((r) => log.info({ msg: 'analyze complete', messageId, status: r.status, durationMs: Date.now() - t0 }))
      .catch((err) => {
        const msg = err instanceof Error ? err.message : String(err)
        log.error({ msg: 'analyze run failed', messageId, err: msg })
        deps.broadcaster.broadcast('gmail.analysisError', { messageId, error: msg, ts: Date.now() })
      })

    return { ok: true }
  }
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `cd apps/desktop && ELECTRON_RUN_AS_NODE=1 electron node_modules/vitest/vitest.mjs run src/service/gmail/analyze.test.ts`
Expected: PASS.

- [ ] **Step 5: Wire into the dispatcher and service index**

In `apps/desktop/src/service/ipc/dispatcher.ts`:

Add to `DispatcherConfig` (next to `manager: SessionManager`):

```ts
  analyzeEmail(req: import('@swarm/protocol').AnalyzeEmailRequest): import('@swarm/protocol').AnalyzeEmailResult
```

Add a case in the switch (after `submitGoal`):

```ts
      case 'analyzeEmail': {
        const [req] = args as [import('@swarm/protocol').AnalyzeEmailRequest]
        return cfg.analyzeEmail(req)
      }
```

In `apps/desktop/src/service/index.ts`, add the import near the other service imports:

```ts
import { createAnalyzeEmail } from './gmail/analyze'
```

Add the wiring inside the `createDispatcher({ … })` call (e.g. after `manager,`):

```ts
  analyzeEmail: createAnalyzeEmail({ broadcaster, agentStore, toolRegistry, getBudgetConfig: () => budgetConfig }),
```

- [ ] **Step 6: Typecheck + full test run**

Run: `cd apps/desktop && npm run typecheck`
Expected: no errors.

Run: `cd apps/desktop && ELECTRON_RUN_AS_NODE=1 electron node_modules/vitest/vitest.mjs run src/service/gmail/analyze.test.ts`
Expected: PASS.

- [ ] **Step 7: Commit**

```bash
git add apps/desktop/src/service/gmail/analyze.ts apps/desktop/src/service/gmail/analyze.test.ts apps/desktop/src/service/ipc/dispatcher.ts apps/desktop/src/service/index.ts
git commit -m "feat(gmail): service analyzeEmail — one-shot streamed analysis"
```

---

### Task 6: Main `analyzeEmail` wiring (provider injection + preload)

**Files:**
- Modify: `apps/desktop/src/main/ipc/swarm-ipc.ts`
- Modify: `apps/desktop/src/preload/index.ts`

**Interfaces:**
- Consumes: `ServiceClient.analyzeEmail` (Task 2), `providers.getInjection()` (existing), `AnalyzeEmailInput` (Task 2).
- Produces: renderer calls `window.swarm.analyzeEmail({ messageId, subject, from, content })`; main injects the active provider and forwards to the service.

- [ ] **Step 1: Add the main handler**

In `apps/desktop/src/main/ipc/swarm-ipc.ts`, add a handler next to `createSession` (the `providers.getInjection()` pattern):

```ts
  const analyzeEmail = async (
    _e: Electron.IpcMainInvokeEvent,
    input: import('@swarm/protocol').AnalyzeEmailInput
  ): Promise<import('@swarm/protocol').AnalyzeEmailResult> => {
    const injection = providers.getInjection()
    if (!injection) return { ok: false, code: 'no_provider', message: '请先在 设置 → 模型 配置提供商。' }
    return serviceClient.analyzeEmail({ ...input, provider: injection })
  }
```

Register it (next to `ipcMain.handle('swarm:createSession', …)`):

```ts
  ipcMain.handle('swarm:analyzeEmail', analyzeEmail)
```

Add `'swarm:analyzeEmail'` to the `dispose()` removal list.

- [ ] **Step 2: Expose on the preload swarm bridge**

In `apps/desktop/src/preload/index.ts`, add to the `swarm` object (next to `submitGoal:`):

```ts
  analyzeEmail: (input) =>
    ipcRenderer.invoke('swarm:analyzeEmail', input) as Promise<import('@swarm/protocol').AnalyzeEmailResult>,
```

Add `AnalyzeEmailInput` and `AnalyzeEmailResult` to the type import list at the top.

- [ ] **Step 3: Typecheck**

Run: `cd apps/desktop && npm run typecheck`
Expected: no errors.

- [ ] **Step 4: Commit**

```bash
git add apps/desktop/src/main/ipc/swarm-ipc.ts apps/desktop/src/preload/index.ts
git commit -m "feat(gmail): wire analyzeEmail through main (provider injection) + preload"
```

---

### Task 7: Renderer `MessageAnalysis` component + inbox wiring

**Files:**
- Modify: `apps/desktop/src/renderer/src/components/views/gmail-inbox-view.tsx`
- Test: `apps/desktop/src/renderer/src/components/views/gmail-inbox-view.test.tsx` (new)

**Interfaces:**
- Consumes: `window.swarm.analyzeEmail` (Task 6), `window.swarm.gmail.saveAnalysis` / `getAnalyses` (Task 4), `gmail.analysis*` UIEvents (Task 2), `Streamdown` (`'streamdown'`).
- Produces: each `MessageCard` renders a `MessageAnalysis` panel beneath the body; opening a thread shows cached analyses; clicking「分析」streams then persists.

- [ ] **Step 1: Write the failing component test**

Create `apps/desktop/src/renderer/src/components/views/gmail-inbox-view.test.tsx`:

```tsx
// @vitest-environment jsdom
import { act, render, screen } from '@testing-library/react'
import { describe, expect, it, vi, beforeEach } from 'vitest'

import { MessageAnalysis } from './gmail-inbox-view'

// Minimal GmailMessage the component needs.
function msg(overrides: Partial<{ id: string; subject: string; fromAddr: string; bodyText: string }> = {}) {
  return {
    id: 'm1', threadId: 't1', fromAddr: 'a@b', toAddrs: [], subject: 'S',
    snippet: '', bodyText: 'body', htmlBody: '', dateMs: 1, labelIds: [],
    ...overrides,
  } as import('@swarm/protocol').GmailMessage
}

describe('MessageAnalysis', () => {
  beforeEach(() => {
    vi.restoreAllMocks()
  })

  it('renders the cached analysis without calling analyzeEmail', () => {
    const analyzeEmail = vi.fn()
    render(<MessageAnalysis message={msg()} cached={{ analysis: '## 摘要\n缓存结果', updatedAt: 1 }} />)
    expect(screen.getByText(/缓存结果/)).toBeTruthy()
    expect(analyzeEmail).not.toHaveBeenCalled()
  })

  it('streams deltas into the panel and persists on complete', async () => {
    let subscriber: ((e: { kind: string; messageId?: string; text?: string; markdown?: string }) => void) | null = null
    ;(window as unknown as { swarm: unknown }).swarm = {
      analyzeEmail: vi.fn().mockResolvedValue({ ok: true }),
      subscribeEvents: (cb: unknown) => {
        subscriber = cb as typeof subscriber
        return () => {}
      },
      gmail: { saveAnalysis: vi.fn().mockResolvedValue(undefined) },
    } as unknown as typeof window.swarm

    render(<MessageAnalysis message={msg()} />)
    await act(async () => {
      screen.getByRole('button', { name: /分析/ }).click()
    })
    expect((window.swarm.analyzeEmail as unknown as ReturnType<typeof vi.fn>).toHaveBeenCalledWith({
      messageId: 'm1', subject: 'S', from: 'a@b', content: 'body',
    })
    await act(async () => {
      subscriber!({ kind: 'gmail.analysisDelta', messageId: 'm1', text: '## 摘要\n流式' })
    })
    expect(screen.getByText(/流式/)).toBeTruthy()
    await act(async () => {
      subscriber!({ kind: 'gmail.analysisComplete', messageId: 'm1', markdown: '## 摘要\n最终' })
    })
    expect(screen.getByText(/最终/)).toBeTruthy()
    expect((window.swarm.gmail.saveAnalysis as unknown as ReturnType<typeof vi.fn>).toHaveBeenCalledWith('m1', '## 摘要\n最终'))
  })
})
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd apps/desktop && ELECTRON_RUN_AS_NODE=1 electron node_modules/vitest/vitest.mjs run src/renderer/src/components/views/gmail-inbox-view.test.tsx`
Expected: FAIL — `MessageAnalysis is not exported`.

- [ ] **Step 3: Implement `MessageAnalysis` and wire it in**

In `apps/desktop/src/renderer/src/components/views/gmail-inbox-view.tsx`:

Add imports at the top:

```tsx
import { useEffect, useRef, useState } from 'react'
import type { GmailAnalysis, GmailMessage, UIEvent } from '@swarm/protocol'
import { Loader2, Sparkles } from 'lucide-react'
import { Streamdown } from 'streamdown'
```

(Adjust the existing `useEffect`/`useState` import line so it also imports these; merge rather than duplicate.)

Add the `MessageAnalysis` component (above `MessageCard`):

```tsx
export function MessageAnalysis({
  message,
  cached,
}: {
  message: GmailMessage
  cached?: GmailAnalysis
}): React.JSX.Element {
  const [phase, setPhase] = useState<'idle' | 'streaming' | 'done' | 'error'>(
    cached ? 'done' : 'idle'
  )
  const [text, setText] = useState<string>(cached?.analysis ?? '')
  const [error, setError] = useState<string | null>(null)
  const runId = useRef(0)

  useEffect(() => {
    return window.swarm.subscribeEvents((e: UIEvent) => {
      if (e.kind === 'gmail.analysisDelta' && e.messageId === message.id) {
        runId.current // touch to keep the ref "used" for lint
        setText((prev) => `${prev}${e.text}`)
        setPhase('streaming')
      } else if (e.kind === 'gmail.analysisComplete' && e.messageId === message.id) {
        setText(e.markdown)
        setPhase('done')
        void window.swarm.gmail.saveAnalysis(message.id, e.markdown)
      } else if (e.kind === 'gmail.analysisError' && e.messageId === message.id) {
        setError(e.error)
        setPhase('error')
      }
    })
  }, [message.id])

  const analyze = (): void => {
    if (!message.bodyText.trim()) return
    setError(null)
    setText('')
    setPhase('streaming')
    runId.current += 1
    void window.swarm.analyzeEmail({
      messageId: message.id,
      subject: message.subject,
      from: message.fromAddr,
      content: message.bodyText,
    })
  }

  return (
    <div className="mt-3 rounded-md border border-border/40 bg-background/40 p-3">
      {phase === 'idle' && (
        <Button disabled={!message.bodyText.trim()} onClick={analyze} size="sm" variant="outline">
          <Sparkles className="size-3.5" /> 分析
        </Button>
      )}
      {phase === 'error' && (
        <div className="flex items-center gap-2">
          <span className="text-destructive text-xs">{error ?? '分析失败'}</span>
          <Button onClick={analyze} size="sm" variant="outline">重试</Button>
        </div>
      )}
      {(phase === 'streaming' || phase === 'done') && (
        <div className="flex flex-col gap-2">
          {phase === 'streaming' && <Loader2 className="size-3.5 animate-spin text-muted-foreground" />}
          <Streamdown className="text-foreground/90 text-sm">{text}</Streamdown>
          {phase === 'done' && (
            <Button onClick={analyze} size="sm" variant="ghost">↻ 重新分析</Button>
          )}
        </div>
      )}
    </div>
  )
}
```

Render it inside `MessageCard`, beneath the body:

```tsx
      {m.htmlBody ? <EmailHtml html={m.htmlBody} /> : (
        <pre className="mt-3 whitespace-pre-wrap break-words font-sans text-foreground/90 text-sm">{m.bodyText}</pre>
      )}
      <MessageAnalysis cached={analyses?.[m.id]} message={m} />
```

Add the parallel analyses query inside `GmailInboxView` (next to the `detail` query), and pass `analyses` down to `MessageCard`:

```tsx
  const analyses = useQuery({
    queryKey: ['gmail', 'analyses', selectedId],
    queryFn: () => window.swarm.gmail.getAnalyses(selectedId!),
    enabled: linked && selectedId !== null,
  })
```

Change the `MessageCard` signature to accept analyses and thread them through:

```tsx
function MessageCard({ m, analyses }: { m: GmailMessage; analyses?: Record<string, GmailAnalysis> }): React.JSX.Element {
```

…and update the call site `{detail.data.messages.map((m) => <MessageCard key={m.id} m={m} analyses={analyses.data} />)}`.

- [ ] **Step 4: Run test to verify it passes**

Run: `cd apps/desktop && ELECTRON_RUN_AS_NODE=1 electron node_modules/vitest/vitest.mjs run src/renderer/src/components/views/gmail-inbox-view.test.tsx`
Expected: PASS.

- [ ] **Step 5: Scoped lint + typecheck**

Run: `cd apps/desktop && node_modules/.bin/biome check --write src/renderer/src/components/views/gmail-inbox-view.tsx src/renderer/src/components/views/gmail-inbox-view.test.tsx`
Run: `cd apps/desktop && npm run typecheck`
Expected: clean / no errors.

- [ ] **Step 6: Commit**

```bash
git add apps/desktop/src/renderer/src/components/views/gmail-inbox-view.tsx apps/desktop/src/renderer/src/components/views/gmail-inbox-view.test.tsx
git commit -m "feat(gmail): MessageAnalysis — streamed inline analysis + per-message button"
```

---

### Task 8: End-to-end verification

**Files:** none (verification only).

- [ ] **Step 1: Full test suite**

Run: `cd apps/desktop && ELECTRON_RUN_AS_NODE=1 electron node_modules/vitest/vitest.mjs run`
Expected: all green except the two known-unrelated pre-existing failures (`packages/protocol/src/types/gmail.test.ts` schema mismatch, `host.test.ts` EADDRINUSE).

- [ ] **Step 2: Run the app and exercise the feature**

Use the `run-desktop` skill to launch the app, open the Gmail inbox, pick a thread, click「分析」on a message:
- Expect: the spinner appears, Markdown streams in, then「↻ 重新分析」shows.
- Reopen the same thread: the analysis renders immediately from cache (no spinner, no network).
- Confirm no CSP/sandbox console noise from the analysis panel (independent of the email iframe).

- [ ] **Step 3: Final commit (if any test fixtures or follow-ups landed)**

If verification surfaced fixes, commit them. Otherwise no commit.

---

## Self-Review (completed)

- **Spec coverage:** builtin agent (T1), streaming one-shot path (T5/T6), persistence (T3/T4), frontend states + cache-on-open (T7), events (T2), logging in `analyze.ts` (T5), testing per layer (T1/T3/T5/T7). Error handling: `no_provider`/`no_agent` ack codes + `gmail.analysisError` event + retry button (T5/T7).
- **Placeholder scan:** none — every code step shows full code; commit messages are concrete.
- **Type consistency:** `AnalyzeEmailRequest` (with provider, service-side) vs `AnalyzeEmailInput` (no provider, renderer-side) is intentional and consistent across T2/T5/T6. `GmailAnalysis` shape (`{analysis, updatedAt}`) matches between T3 (cache), T2 (type), T4 (bridge), T7 (component). UIEvent variant names `gmail.analysis{Delta,Complete,Error}` match between T2, T5 (emit), and T7 (subscribe). `messageId` is the correlation key everywhere.
