# Article Collection Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Browser extension extracts article content (readability) and pushes it to desktop; desktop shows a card-grid collection view (mirroring Bilibili) with a 472px detail panel that runs a fixed `article-analyst` agent analysis.

**Architecture:** UI mirrors Bilibili (card grid + detail panel, JSON-file store); backend mirrors Gmail (`launchRun` + dedicated agent + broadcast event stream in `service/`, WS-reachable so the extension can call `collectArticle`). Two call paths: `collectArticle` goes extension→WS→service (no provider); `analyzeArticle` goes renderer→main (host-injects provider)→service.

**Tech Stack:** zod (protocol), Electron IPC + WXT MV3, TanStack Router/Query + React 19 (renderer), `@mozilla/readability` + `turndown` (extraction), vitest (tests).

## Global Constraints

- **Language:** Code comments and commit messages in English only. No Japanese.
- **Package boundaries:** `@swarm/protocol` and `@swarm/shared` import nothing platform-bound (no Node/Electron/React). Enforced by `pnpm check-boundaries`.
- **Logging:** Every business path logs via `createLogger({...}).child({component})`. Structured first arg. Every `catch` logs at `error`. (AGENTS.md §5)
- **Surgical changes:** Match existing style. Don't refactor adjacent code.
- **TypeScript:** strict; follow existing tsconfig per package.
- **Test runner:** vitest (`pnpm --filter <pkg> run test`).
- **Verify gate:** `pnpm verify` must stay green (typecheck + test + check-boundaries).

**Reference spec:** `docs/superpowers/specs/2026-07-07-article-collection-design.md`

---

## File Structure

**Create:**
- `packages/protocol/src/types/article.ts` — zod schemas + RPC request/response types + broadcast event types
- `packages/protocol/src/types/article.test.ts` — schema parsing tests
- `apps/desktop/src/service/article/store.ts` — JSON persistence (collected-articles.json)
- `apps/desktop/src/service/article/store.test.ts` — store CRUD + atomic write
- `apps/desktop/src/service/article/collect.ts` — createCollectArticle
- `apps/desktop/src/service/article/collect.test.ts` — validation + add
- `apps/desktop/src/service/article/analyze.ts` — createAnalyzeArticle (launchRun + broadcast)
- `apps/desktop/src/service/article/analyze.test.ts` — broadcast sequence + early returns + JSON parse
- `apps/desktop/src/main/ipc/article-ipc.ts` — ipcMain handlers (host-inject provider)
- `apps/desktop/src/renderer/src/routes/article.tsx` — TanStack route
- `apps/desktop/src/renderer/src/components/views/article-view.tsx` — card grid
- `apps/desktop/src/renderer/src/components/views/article-view.test.tsx` — render + states
- `apps/desktop/src/renderer/src/components/views/article-detail-panel.tsx` — 472px detail panel
- `apps/extension/entrypoints/content/extract.ts` — readability content script
- `apps/extension/lib/extract.test.ts` — pure extract logic test

**Modify:**
- `packages/protocol/src/index.ts` — re-export article types
- `packages/protocol/src/types/service-ipc.ts` — ServiceMethod union
- `packages/protocol/src/types/ui.ts` — SwarmBridge.article namespace + UIEvent article.* variants
- `packages/protocol/src/service-client.ts` — 5 new methods
- `packages/protocol/src/service-client.test.ts` (or new test) — method dispatch
- `packages/shared/src/constants/agents.ts` — article-analyst agent
- `packages/shared/src/agents/default-prompt.ts` — ARTICLE_ANALYST_SYSTEM_PROMPT
- `apps/desktop/src/service/index.ts` — wire article deps + dispatcher cases
- `apps/desktop/src/service/ipc/dispatcher.ts` — 5 cases
- `apps/desktop/src/main/index.ts` — wire article-ipc
- `apps/desktop/src/preload/index.ts` + `.d.ts` — article bridge namespace
- `apps/desktop/src/renderer/src/components/rail-config.ts` — nav item
- `apps/desktop/src/renderer/src/lib/api.ts` — swarmApi.article*
- `apps/extension/entrypoints/background.ts` — collectCurrentPage handler
- `apps/extension/entrypoints/popup/Popup.tsx` — collect button
- `apps/extension/package.json` — readability + turndown deps
- `apps/extension/wxt.config.ts` — content script permissions (if needed)

---

## Task 1: Protocol types (article.ts)

**Files:**
- Create: `packages/protocol/src/types/article.ts`
- Create: `packages/protocol/src/types/article.test.ts`
- Modify: `packages/protocol/src/index.ts`

**Interfaces:**
- Produces: `ArticleSource`, `CollectedArticle`, `ArticleSummary`, `CollectedArticleWithAnalysis`, `CollectArticleRequest/Result`, `AnalyzeArticleRequest/Result`, `ArticleAnalysisDeltaEvent` and siblings (re-exported from `@swarm/protocol`).

- [ ] **Step 1: Write the failing test**

Create `packages/protocol/src/types/article.test.ts`:

```ts
import { describe, expect, it } from 'vitest'

import {
  AnalyzeArticleResult,
  ArticleSource,
  ArticleSummary,
  CollectArticleResult,
} from './article'

const validSource = {
  url: 'https://example.com/a',
  title: 'A Title',
  author: null,
  siteName: null,
  publishedTime: null,
  contentMarkdown: '# body',
}

describe('ArticleSource', () => {
  it('accepts a valid source', () => {
    const r = ArticleSource.safeParse(validSource)
    expect(r.success).toBe(true)
  })
  it('rejects a non-url', () => {
    const r = ArticleSource.safeParse({ ...validSource, url: 'not-a-url' })
    expect(r.success).toBe(false)
  })
  it('rejects empty contentMarkdown', () => {
    const r = ArticleSource.safeParse({ ...validSource, contentMarkdown: '' })
    expect(r.success).toBe(false)
  })
  it('rejects title over 500 chars', () => {
    const r = ArticleSource.safeParse({ ...validSource, title: 'x'.repeat(501) })
    expect(r.success).toBe(false)
  })
})

describe('ArticleSummary', () => {
  it('accepts a valid summary', () => {
    const r = ArticleSummary.safeParse({ gist: 'g', points: ['p'], takeaways: [] })
    expect(r.success).toBe(true)
  })
})

describe('CollectArticleResult', () => {
  it('parses a success', () => {
    const r = CollectArticleResult.safeParse({ ok: true, articleId: '01ABC' })
    expect(r.success).toBe(true)
  })
  it('parses an invalid failure', () => {
    const r = CollectArticleResult.safeParse({ ok: false, code: 'invalid', message: 'bad' })
    expect(r.success).toBe(true)
  })
})

describe('AnalyzeArticleResult', () => {
  it('parses a success', () => {
    const r = AnalyzeArticleResult.safeParse({ ok: true })
    expect(r.success).toBe(true)
  })
  it('parses no_provider', () => {
    const r = AnalyzeArticleResult.safeParse({ ok: false, code: 'no_provider', message: 'm' })
    expect(r.success).toBe(true)
  })
})
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm --filter @swarm/protocol run test`
Expected: FAIL — module `./article` not found.

- [ ] **Step 3: Write article.ts**

Create `packages/protocol/src/types/article.ts`:

```ts
import { z } from 'zod'

import { ProviderInjection } from './provider'

// Cleaned article body extracted by the extension's content script. Author /
// siteName / publishedTime are nullable because readability does not guarantee
// them; url / title / contentMarkdown are required.
export const ArticleSource = z.object({
  url: z.string().url().max(4096),
  title: z.string().min(1).max(500),
  author: z.string().max(200).nullable().default(null),
  siteName: z.string().max(200).nullable().default(null),
  publishedTime: z.string().datetime().nullable().default(null),
  contentMarkdown: z.string().min(1).max(200_000),
})
export type ArticleSource = z.infer<typeof ArticleSource>

// A persisted collected article (one record in collected-articles.json).
export const CollectedArticle = ArticleSource.extend({
  id: z.string(),
  collectedAt: z.string().datetime(),
  excerpt: z.string().max(300),
})
export type CollectedArticle = z.infer<typeof CollectedArticle>

// Structured output of the article-analyst agent.
export const ArticleSummary = z.object({
  gist: z.string(),
  points: z.array(z.string()),
  takeaways: z.array(z.string()),
})
export type ArticleSummary = z.infer<typeof ArticleSummary>

// A collected article with its analysis cache (returned by listArticles).
export const CollectedArticleWithAnalysis = CollectedArticle.extend({
  summary: ArticleSummary.nullable().default(null),
  analyzedAt: z.string().datetime().nullable().default(null),
})
export type CollectedArticleWithAnalysis = z.infer<typeof CollectedArticleWithAnalysis>

// collectArticle: WS-reachable (extension), no provider needed.
export const CollectArticleRequest = ArticleSource
export type CollectArticleRequest = z.infer<typeof CollectArticleRequest>
export const CollectArticleResult = z.discriminatedUnion('ok', [
  z.object({ ok: z.literal(true), articleId: z.string() }),
  z.object({ ok: z.literal(false), code: z.literal('invalid'), message: z.string() }),
])
export type CollectArticleResult = z.infer<typeof CollectArticleResult>

// analyzeArticle: renderer→main→service (main injects provider).
export const AnalyzeArticleRequest = z.object({
  articleId: z.string(),
  provider: ProviderInjection,
})
export type AnalyzeArticleRequest = z.infer<typeof AnalyzeArticleRequest>
export const AnalyzeArticleResult = z.discriminatedUnion('ok', [
  z.object({ ok: z.literal(true) }),
  z.object({
    ok: z.literal(false),
    code: z.enum(['no_provider', 'no_agent', 'no_article']),
    message: z.string(),
  }),
])
export type AnalyzeArticleResult = z.infer<typeof AnalyzeArticleResult>

// Broadcast events (mirror gmail.analysisDelta pattern).
export const ArticleAnalysisDeltaEvent = z.object({
  kind: z.literal('article.analysisDelta'),
  articleId: z.string(),
  text: z.string(),
  ts: z.number(),
})
export const ArticleAnalysisCompleteEvent = z.object({
  kind: z.literal('article.analysisComplete'),
  articleId: z.string(),
  summary: ArticleSummary,
  ts: z.number(),
})
export const ArticleAnalysisErrorEvent = z.object({
  kind: z.literal('article.analysisError'),
  articleId: z.string(),
  error: z.string(),
  ts: z.number(),
})
```

- [ ] **Step 4: Re-export from index.ts**

In `packages/protocol/src/index.ts`, add (in alphabetical position):

```ts
export * from './types/article'
```

- [ ] **Step 5: Run tests to verify pass**

Run: `pnpm --filter @swarm/protocol run test`
Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add packages/protocol/src/types/article.ts packages/protocol/src/types/article.test.ts packages/protocol/src/index.ts
git commit -m "feat(protocol): add article collection wire types"
```

---

## Task 2: Wire protocol into ServiceClient + ServiceMethod + SwarmBridge

**Files:**
- Modify: `packages/protocol/src/types/service-ipc.ts`
- Modify: `packages/protocol/src/types/ui.ts`
- Modify: `packages/protocol/src/service-client.ts`

**Interfaces:**
- Consumes: types from Task 1.
- Produces: `ServiceClient.collectArticle/analyzeArticle/listArticles/getArticleAnalysis/deleteArticle`; `ServiceMethod` additions; `SwarmBridge.article` namespace; `UIEvent` article.* variants.

- [ ] **Step 1: Add ServiceMethod variants**

In `packages/protocol/src/types/service-ipc.ts`, find the `ServiceMethod` union and add:

```ts
  | 'collectArticle'
  | 'analyzeArticle'
  | 'listArticles'
  | 'getArticleAnalysis'
  | 'deleteArticle'
```

- [ ] **Step 2: Add UIEvent article variants**

In `packages/protocol/src/types/ui.ts`, find the `UIEvent` union and add the three article events (import the types from `./article` at the top of ui.ts if not auto-imported via `export *`):

```ts
  | ArticleAnalysisDeltaEvent
  | ArticleAnalysisCompleteEvent
  | ArticleAnalysisErrorEvent
```

- [ ] **Step 3: Add SwarmBridge.article namespace**

In `packages/protocol/src/types/ui.ts`, inside `SwarmBridge`, add a new namespace (mirror the `trending` namespace style):

```ts
  article: {
    list(): Promise<CollectedArticleWithAnalysis[]>
    analyze(articleId: string): Promise<AnalyzeArticleResult>
    getAnalysis(articleId: string): Promise<{ summary: ArticleSummary | null; analyzedAt: string | null }>
    delete(articleId: string): Promise<void>
  }
```

(Add the type imports to ui.ts as needed — they come from `./article`.)

- [ ] **Step 4: Add ServiceClient methods**

In `packages/protocol/src/service-client.ts`:

Add imports near the top:

```ts
import type {
  AnalyzeArticleRequest,
  AnalyzeArticleResult,
  ArticleSource,
  CollectArticleResult,
  CollectedArticleWithAnalysis,
  ArticleSummary,
} from './types/article'
```

Add to the `ServiceClient` type (near analyzeThread):

```ts
  collectArticle(input: ArticleSource): Promise<CollectArticleResult>
  analyzeArticle(req: AnalyzeArticleRequest): Promise<AnalyzeArticleResult>
  listArticles(): Promise<CollectedArticleWithAnalysis[]>
  getArticleAnalysis(articleId: string): Promise<{ summary: ArticleSummary | null; analyzedAt: string | null }>
  deleteArticle(articleId: string): Promise<void>
```

Add to the `createServiceClient` returned object (near analyzeThread impl):

```ts
    collectArticle(input) {
      return call('collectArticle', [input])
    },
    analyzeArticle(req) {
      return call('analyzeArticle', [req])
    },
    listArticles() {
      return call('listArticles', [])
    },
    getArticleAnalysis(articleId) {
      return call('getArticleAnalysis', [articleId])
    },
    async deleteArticle(articleId) {
      await call('deleteArticle', [articleId])
    },
```

- [ ] **Step 5: Typecheck**

Run: `pnpm --filter @swarm/protocol run typecheck`
Expected: PASS (no type errors). Note: existing service-client tests should still pass.

Run: `pnpm --filter @swarm/protocol run test`
Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add packages/protocol/src/types/service-ipc.ts packages/protocol/src/types/ui.ts packages/protocol/src/service-client.ts
git commit -m "feat(protocol): wire article methods into ServiceClient/ServiceMethod/Bridge"
```

---

## Task 3: article-analyst agent (shared)

**Files:**
- Modify: `packages/shared/src/agents/default-prompt.ts`
- Modify: `packages/shared/src/constants/agents.ts`

**Interfaces:**
- Produces: `ARTICLE_ANALYST_SYSTEM_PROMPT` constant; `article-analyst` agent definition (id `article-analyst`, role `article-analyst`, capability `article-analyze`).

- [ ] **Step 1: Add the system prompt constant**

In `packages/shared/src/agents/default-prompt.ts`, add (near `GMAIL_ANALYST_SYSTEM_PROMPT`):

```ts
export const ARTICLE_ANALYST_SYSTEM_PROMPT = `You are an article analysis assistant. Read the article body the user provides and output STRICT JSON only (no markdown code fence), in this exact shape:

{"gist": "one-sentence conclusion", "points": ["core point 1", "..."], "takeaways": ["transferable insight 1", "..."]}

Rules:
- Respond in Chinese.
- gist: at most 50 Chinese characters.
- points: 3 to 6 items.
- takeaways: 0 to 4 items, focused on transferable experience or mental models.
- Output nothing except the JSON object.`
```

- [ ] **Step 2: Add the agent definition**

In `packages/shared/src/constants/agents.ts`, add the import of `ARTICLE_ANALYST_SYSTEM_PROMPT` (near the existing `GMAIL_ANALYST_SYSTEM_PROMPT` import) and add the agent into `baseAgents` right after `gmail-thread-analyst`:

```ts
  {
    id: 'article-analyst',
    name: '文章分析',
    description: '分析用户收集的文章,输出结构化中文摘要(一句话结论/核心要点/可带走洞察)。',
    systemPrompt: ARTICLE_ANALYST_SYSTEM_PROMPT,
    maxIterations: 2,
    role: 'article-analyst',
    capabilities: ['article-analyze'],
    skills: [],
  },
```

- [ ] **Step 3: Verify**

Run: `pnpm --filter @swarm/shared run test`
Expected: PASS (existing agent tests + the new agent is in defaultAgents).

Run: `pnpm --filter @swarm/shared run typecheck`
Expected: PASS.

- [ ] **Step 4: Commit**

```bash
git add packages/shared/src/agents/default-prompt.ts packages/shared/src/constants/agents.ts
git commit -m "feat(shared): add article-analyst builtin agent"
```

---

## Task 4: Article store (service/article/store.ts)

**Files:**
- Create: `apps/desktop/src/service/article/store.ts`
- Create: `apps/desktop/src/service/article/store.test.ts`

**Interfaces:**
- Consumes: `ArticleSource`, `ArticleSummary`, `CollectedArticle`, `CollectedArticleWithAnalysis` from `@swarm/protocol`; `ulid`.
- Produces: `createArticleStore({ userDataDir }): ArticleStore` where `ArticleStore = { add, list, get, saveAnalysis, delete }`.

- [ ] **Step 1: Write the failing test**

Create `apps/desktop/src/service/article/store.test.ts`:

```ts
import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { afterEach, beforeEach, describe, expect, it } from 'vitest'

import { createArticleStore } from './store'

const sample = {
  url: 'https://example.com/a',
  title: 'A',
  author: null,
  siteName: 'Ex',
  publishedTime: null,
  contentMarkdown: 'body text here',
}

function tmpDir(): string {
  return mkdtempSync(join(tmpdir(), 'swarm-article-'))
}

describe('createArticleStore', () => {
  let dir: string
  beforeEach(() => {
    dir = tmpDir()
  })
  afterEach(() => {
    rmSync(dir, { recursive: true, force: true })
  })

  it('add returns the article with id/excerpt and persists', () => {
    const store = createArticleStore({ userDataDir: dir })
    const a = store.add(sample)
    expect(a.id).toBeTruthy()
    expect(a.excerpt).toBe('body text here')
    expect(a.collectedAt).toBeTruthy()
    // persisted to disk
    const raw = JSON.parse(readFileSync(join(dir, 'collected-articles.json'), 'utf8'))
    expect(raw[a.id].title).toBe('A')
  })

  it('list returns newest-first and includes analysis cache', () => {
    const store = createArticleStore({ userDataDir: dir })
    const a1 = store.add(sample)
    const a2 = store.add({ ...sample, title: 'B' })
    const list = store.list()
    expect(list[0].id).toBe(a2.id)
    expect(list[1].id).toBe(a1.id)
    expect(list[0].summary).toBeNull()
  })

  it('saveAnalysis attaches summary and analyzedAt', () => {
    const store = createArticleStore({ userDataDir: dir })
    const a = store.add(sample)
    store.saveAnalysis(a.id, { gist: 'g', points: ['p'], takeaways: [] })
    const got = store.get(a.id)
    expect(got?.summary?.gist).toBe('g')
    expect(got?.analyzedAt).toBeTruthy()
  })

  it('delete removes the record', () => {
    const store = createArticleStore({ userDataDir: dir })
    const a = store.add(sample)
    store.delete(a.id)
    expect(store.get(a.id)).toBeNull()
  })

  it('reload reads persisted state', () => {
    const store1 = createArticleStore({ userDataDir: dir })
    store1.add(sample)
    const store2 = createArticleStore({ userDataDir: dir })
    expect(store2.list()).toHaveLength(1)
  })

  it('excerpt truncates to 300 chars', () => {
    const store = createArticleStore({ userDataDir: dir })
    const a = store.add({ ...sample, contentMarkdown: 'x'.repeat(500) })
    expect(a.excerpt.length).toBe(300)
  })
})
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm --filter @swarm/desktop run test -- src/service/article/store.test.ts`
Expected: FAIL — module not found.

- [ ] **Step 3: Write store.ts**

Create `apps/desktop/src/service/article/store.ts`:

```ts
import { mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'

import { createLogger } from '@shared/logger'
import type {
  ArticleSource,
  ArticleSummary,
  CollectedArticle,
  CollectedArticleWithAnalysis,
} from '@swarm/protocol'
import { ulid } from 'ulid'
import { z } from 'zod'

const log = createLogger({ process: 'service' }).child({ component: 'article-store' })

const ArticleRecordSchema = z.object({
  url: z.string(),
  title: z.string(),
  author: z.string().nullable(),
  siteName: z.string().nullable(),
  publishedTime: z.string().nullable(),
  contentMarkdown: z.string(),
  id: z.string(),
  collectedAt: z.string(),
  excerpt: z.string(),
  summary: z.object({
    gist: z.string(),
    points: z.array(z.string()),
    takeaways: z.array(z.string()),
  }).nullable(),
  analyzedAt: z.string().nullable(),
})

type ArticleRecord = z.infer<typeof ArticleRecordSchema>

const FileSchema = z.record(z.string(), ArticleRecordSchema)

export type ArticleStore = {
  add(input: ArticleSource): CollectedArticle
  list(): CollectedArticleWithAnalysis[]
  get(id: string): ArticleRecord | null
  saveAnalysis(id: string, summary: ArticleSummary): void
  delete(id: string): void
}

export function createArticleStore(deps: { userDataDir: string }): ArticleStore {
  const file = join(deps.userDataDir, 'collected-articles.json')
  let cache = new Map<string, ArticleRecord>()
  let saveQueue: Promise<void> = Promise.resolve()

  load()

  function load(): void {
    try {
      const raw = readFileSync(file, 'utf8')
      const parsed = FileSchema.safeParse(JSON.parse(raw))
      if (parsed.success) {
        cache = new Map(Object.entries(parsed.data))
      } else {
        log.warn({ msg: 'article store parse failed, starting empty' })
      }
    } catch {
      // first run — file does not exist yet
    }
  }

  function persist(): void {
    saveQueue = saveQueue
      .then(() => {
        mkdirSync(dirname(file), { recursive: true })
        const tmp = `${file}.tmp`
        writeFileSync(tmp, JSON.stringify(Object.fromEntries(cache), null, 2))
        renameSync(tmp, file)
      })
      .catch((err) => {
        log.error({ msg: 'article store write failed', err: err instanceof Error ? err.message : String(err) })
      })
  }

  function toPublic(r: ArticleRecord): CollectedArticleWithAnalysis {
    const { summary, analyzedAt, ...rest } = r
    return { ...rest, summary: summary ?? null, analyzedAt: analyzedAt ?? null }
  }

  return {
    add(input) {
      const id = ulid()
      const now = new Date().toISOString()
      const record: ArticleRecord = {
        ...input,
        id,
        collectedAt: now,
        excerpt: input.contentMarkdown.slice(0, 300),
        summary: null,
        analyzedAt: null,
      }
      cache.set(id, record)
      persist()
      const { summary, analyzedAt, ...publicFields } = record
      return publicFields
    },
    list() {
      return [...cache.values()]
        .sort((a, b) => b.collectedAt.localeCompare(a.collectedAt))
        .map(toPublic)
    },
    get(id) {
      return cache.get(id) ?? null
    },
    saveAnalysis(id, summary) {
      const r = cache.get(id)
      if (!r) return
      cache.set(id, { ...r, summary, analyzedAt: new Date().toISOString() })
      persist()
    },
    delete(id) {
      if (cache.delete(id)) persist()
    },
  }
}
```

- [ ] **Step 4: Run tests to verify pass**

Run: `pnpm --filter @swarm/desktop run test -- src/service/article/store.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add apps/desktop/src/service/article/store.ts apps/desktop/src/service/article/store.test.ts
git commit -m "feat(service): article JSON store with atomic write"
```

---

## Task 5: collect.ts (service)

**Files:**
- Create: `apps/desktop/src/service/article/collect.ts`
- Create: `apps/desktop/src/service/article/collect.test.ts`

**Interfaces:**
- Consumes: `ArticleSource` (validated by zod), `ArticleStore.add`.
- Produces: `createCollectArticle({ store }): (input: ArticleSource) => CollectArticleResult`.

- [ ] **Step 1: Write the failing test**

Create `apps/desktop/src/service/article/collect.test.ts`:

```ts
import { describe, expect, it } from 'vitest'

import type { ArticleStore } from './store'
import { createCollectArticle } from './collect'

function fakeStore(): ArticleStore {
  const added: unknown[] = []
  return {
    add(input) {
      added.push(input)
      return { ...input, id: '01ID', collectedAt: '2026-07-07T00:00:00.000Z', excerpt: input.contentMarkdown.slice(0, 300) }
    },
    list: () => [],
    get: () => null,
    saveAnalysis: () => undefined,
    delete: () => undefined,
  }
}

const valid = {
  url: 'https://example.com/a',
  title: 'A',
  author: null,
  siteName: null,
  publishedTime: null,
  contentMarkdown: 'body',
}

describe('createCollectArticle', () => {
  it('accepts valid input and returns articleId', () => {
    const collect = createCollectArticle({ store: fakeStore() })
    const r = collect(valid)
    expect(r).toEqual({ ok: true, articleId: '01ID' })
  })
  it('rejects invalid url', () => {
    const collect = createCollectArticle({ store: fakeStore() })
    const r = collect({ ...valid, url: 'nope' })
    expect(r.ok).toBe(false)
    if (!r.ok) expect(r.code).toBe('invalid')
  })
})
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm --filter @swarm/desktop run test -- src/service/article/collect.test.ts`
Expected: FAIL — module not found.

- [ ] **Step 3: Write collect.ts**

Create `apps/desktop/src/service/article/collect.ts`:

```ts
import { createLogger } from '@shared/logger'
import { ArticleSource, type CollectArticleResult } from '@swarm/protocol'

import type { ArticleStore } from './store'

const log = createLogger({ process: 'service' }).child({ component: 'article-collect' })

export function createCollectArticle(deps: { store: ArticleStore }) {
  return (input: unknown): CollectArticleResult => {
    const parsed = ArticleSource.safeParse(input)
    if (!parsed.success) {
      log.warn({ msg: 'article rejected', reason: parsed.error.message })
      return { ok: false, code: 'invalid', message: parsed.error.message }
    }
    const article = deps.store.add(parsed.data)
    log.info({ msg: 'article collected', articleId: article.id, url: article.url, titleLen: article.title.length })
    return { ok: true, articleId: article.id }
  }
}
```

- [ ] **Step 4: Run tests to verify pass**

Run: `pnpm --filter @swarm/desktop run test -- src/service/article/collect.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add apps/desktop/src/service/article/collect.ts apps/desktop/src/service/article/collect.test.ts
git commit -m "feat(service): article collect handler with validation"
```

---

## Task 6: analyze.ts (service — launchRun + broadcast)

**Files:**
- Create: `apps/desktop/src/service/article/analyze.ts`
- Create: `apps/desktop/src/service/article/analyze.test.ts`

**Interfaces:**
- Consumes: `AnalyzeArticleRequest/Result`, `ArticleSummary`, `ArticleStore`, `Broadcaster`, `AgentStore.get`, `BudgetConfig`, `launchRun`, `applyAgentModel`/`defaultAgents` from `@swarm/shared`, `LaunchPorts`/`RunSpec`/`RunEmitPorts` from `../run-engine/*`, `createPermissionRegistry` from `../session/permission-registry`, `ToolRegistry`.
- Produces: `createAnalyzeArticle(deps): (req) => AnalyzeArticleResult`. Broadcasts `article.analysisDelta/Complete/Error`.

- [ ] **Step 1: Write the failing test**

Create `apps/desktop/src/service/article/analyze.test.ts`:

```ts
import { describe, expect, it, vi } from 'vitest'

import type { ArticleSummary } from '@swarm/protocol'

import type { ArticleStore } from './store'
import { createAnalyzeArticle } from './analyze'

function fakeStore(): ArticleStore {
  return {
    add: () => ({}) as never,
    list: () => [],
    get: () => ({
      url: 'https://example.com/a', title: 'A', author: null, siteName: null,
      publishedTime: null, contentMarkdown: 'body', id: '01ID',
      collectedAt: '2026-07-07T00:00:00.000Z', excerpt: 'body',
      summary: null, analyzedAt: null,
    }),
    saveAnalysis: vi.fn(),
    delete: () => undefined,
  }
}

function fakeBroadcaster() {
  const events: { event: string; data: unknown }[] = []
  return {
    broadcast: vi.fn((event: string, data: unknown) => events.push({ event, data })),
    events,
  }
}

const injection = { id: 'p', apiStyle: 'openai' as const, model: 'gpt-4o', apiKey: 'k' }

describe('createAnalyzeArticle early returns', () => {
  it('returns no_provider when provider missing', () => {
    const broadcaster = fakeBroadcaster()
    const analyze = createAnalyzeArticle({
      broadcaster: broadcaster as never,
      agentStore: { get: () => null } as never,
      store: fakeStore(),
      toolRegistry: {} as never,
      getBudgetConfig: () => ({ main: {}, sub: {} } as never),
    })
    const r = analyze({ articleId: '01ID', provider: undefined as never })
    expect(r).toEqual({ ok: false, code: 'no_provider', message: expect.any(String) })
  })
})

describe('createAnalyzeArticle broadcast', () => {
  it('broadcasts analysisComplete with parsed summary on run.complete', async () => {
    const broadcaster = fakeBroadcaster()
    const summary: ArticleSummary = { gist: 'g', points: ['p'], takeaways: [] }

    // Fake launch: directly invokes the broadcast port with a run.complete event
    // whose summary is a JSON string, then returns a terminal result.
    const fakeLaunch = vi.fn((_spec: unknown, ports: any) => {
      ports.emit.broadcast({ kind: 'run.complete', summary: JSON.stringify(summary) })
      return Promise.resolve({ status: 'complete', runId: 'r' })
    })

    const store = fakeStore()
    const analyze = createAnalyzeArticle({
      broadcaster: broadcaster as never,
      agentStore: {
        get: () => ({
          id: 'article-analyst', name: 'A', systemPrompt: 'x', maxIterations: 2,
          role: 'article-analyst', capabilities: [], skills: [],
        }),
      } as never,
      store,
      toolRegistry: {} as never,
      getBudgetConfig: () => ({ main: {}, sub: {} } as never),
      launch: fakeLaunch as never,
    })

    const r = analyze({ articleId: '01ID', provider: injection as never })
    expect(r).toEqual({ ok: true })
    await Promise.resolve() // let the run promise tick
    expect(broadcaster.broadcast).toHaveBeenCalledWith('article.analysisComplete', expect.objectContaining({ articleId: '01ID' }))
    expect(store.saveAnalysis).toHaveBeenCalledWith('01ID', summary)
  })
})
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm --filter @swarm/desktop run test -- src/service/article/analyze.test.ts`
Expected: FAIL — module not found.

- [ ] **Step 3: Write analyze.ts**

Create `apps/desktop/src/service/article/analyze.ts` (mirror `service/gmail/analyze.ts`):

```ts
// One-shot, tool-less analysis of a collected article. Mirrors service/gmail/analyze.ts:
// a PRIVATE LaunchPorts binding (silent seq, no store append, no-op slot/abort ports),
// a broadcast adapter translating run.* into article.analysis* events keyed by articleId.
// On run.complete the agent's JSON output is parsed into ArticleSummary; success caches
// the summary back to the article store (re-viewable, like bili's analysis cache).
import { createLogger } from '@shared/logger'
import type { AnalyzeArticleRequest, AnalyzeArticleResult, ArticleSummary, BudgetConfig } from '@swarm/protocol'
import { applyAgentModel, defaultAgents } from '@swarm/shared'
import { ulid } from 'ulid'

import type { AgentStore } from '../agents/store'
import type { Broadcaster } from '../ipc/broadcaster'
import type { RunEmitPorts } from '../run-engine/emit'
import { type LaunchPorts, launchRun, type RunSpec } from '../run-engine/launch'
import { createPermissionRegistry } from '../session/permission-registry'
import type { ToolRegistry } from '../tools/registry'
import type { ArticleStore } from './store'

const log = createLogger({ process: 'service' }).child({ component: 'article-analyze' })

const ARTICLE_ANALYST_ID = 'article-analyst'

export type AnalyzeDeps = {
  broadcaster: Broadcaster
  agentStore: Pick<AgentStore, 'get'>
  store: ArticleStore
  toolRegistry: ToolRegistry
  getBudgetConfig(): BudgetConfig
  /** Injectable so tests can drive the emit adapter without a real provider/engine. */
  launch?: typeof launchRun
}

// Parse the agent's JSON output into ArticleSummary. Tolerates accidental
// markdown code fences by stripping them before JSON.parse.
function parseSummary(raw: string): ArticleSummary | null {
  const cleaned = raw.replace(/^```(?:json)?\s*|\s*```$/g, '').trim()
  try {
    const obj = JSON.parse(cleaned) as unknown
    const summary = obj as { gist?: unknown; points?: unknown; takeaways?: unknown }
    if (
      typeof summary?.gist === 'string' &&
      Array.isArray(summary?.points) &&
      Array.isArray(summary?.takeaways)
    ) {
      return { gist: summary.gist, points: summary.points as string[], takeaways: summary.takeaways as string[] }
    }
    return null
  } catch {
    return null
  }
}

export function createAnalyzeArticle(deps: AnalyzeDeps): (req: AnalyzeArticleRequest) => AnalyzeArticleResult {
  const run = deps.launch ?? launchRun
  return (req) => {
    if (!req.provider) {
      return { ok: false, code: 'no_provider', message: '请先在 设置 → 模型 配置提供商。' }
    }
    const def = deps.agentStore.get(ARTICLE_ANALYST_ID) ?? defaultAgents.find((a) => a.id === ARTICLE_ANALYST_ID)
    if (!def) {
      return { ok: false, code: 'no_agent', message: 'article-analyst agent 不可用。' }
    }
    const article = deps.store.get(req.articleId)
    if (!article) {
      return { ok: false, code: 'no_article', message: '文章不存在。' }
    }

    let seq = 0
    const emitPorts: RunEmitPorts = {
      nextSeq: () => seq++,
      appendEvent: () => undefined,
      markTerminal: () => undefined,
      broadcast: (evt) => {
        if (evt.kind === 'run.progress') {
          const ev = evt.event
          if (ev?.kind === 'llm.message' && typeof ev.content === 'string') {
            deps.broadcaster.broadcast('article.analysisDelta', { articleId: req.articleId, text: ev.content, ts: Date.now() })
          }
        } else if (evt.kind === 'run.complete') {
          const summary = parseSummary(evt.summary)
          if (summary) {
            deps.store.saveAnalysis(req.articleId, summary)
            deps.broadcaster.broadcast('article.analysisComplete', { articleId: req.articleId, summary, ts: Date.now() })
          } else {
            deps.broadcaster.broadcast('article.analysisError', {
              articleId: req.articleId,
              error: '分析结果解析失败',
              ts: Date.now(),
            })
          }
        } else if (evt.kind === 'run.error') {
          deps.broadcaster.broadcast('article.analysisError', {
            articleId: req.articleId,
            error: evt.error?.message ?? 'analysis failed',
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

    const analyzePrompt = `分析下面这篇文章。\n\nTitle: ${article.title}\nSource: ${article.url}\n\n${article.contentMarkdown}`
    const spec: RunSpec = {
      kind: 'work',
      sessionId: `analyze-article:${ulid()}`,
      agent: def,
      provider: applyAgentModel(req.provider, def),
      prompt: analyzePrompt,
      budget: deps.getBudgetConfig().sub,
      tools: [],
      maxIterationsOverride: def.maxIterations,
    }

    const t0 = Date.now()
    log.info({ msg: 'article analyze started', articleId: req.articleId, contentLen: article.contentMarkdown.length })
    void run(spec, ports)
      .then((r) => log.info({ msg: 'article analyze complete', articleId: req.articleId, status: r.status, durationMs: Date.now() - t0 }))
      .catch((err) => {
        log.error({ msg: 'article analyze run failed', articleId: req.articleId, err: err instanceof Error ? err.message : String(err) })
      })

    return { ok: true }
  }
}
```

- [ ] **Step 4: Run tests to verify pass**

Run: `pnpm --filter @swarm/desktop run test -- src/service/article/analyze.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add apps/desktop/src/service/article/analyze.ts apps/desktop/src/service/article/analyze.test.ts
git commit -m "feat(service): article analyze via launchRun + broadcast"
```

---

## Task 7: Wire service dispatcher + index.ts

**Files:**
- Modify: `apps/desktop/src/service/ipc/dispatcher.ts`
- Modify: `apps/desktop/src/service/index.ts`

**Interfaces:**
- Consumes: `createArticleStore`, `createCollectArticle`, `createAnalyzeArticle` (Tasks 4-6); existing deps (broadcaster, agentStore, toolRegistry, userDataDir, getBudgetConfig).
- Produces: dispatcher routes 5 article methods; service index constructs and injects article handlers.

- [ ] **Step 1: Add dispatcher cases**

In `apps/desktop/src/service/ipc/dispatcher.ts`, find where `analyzeEmail`/`analyzeThread` cases live and add (mirror their shape — these call the cfg handlers):

```ts
    case 'collectArticle':
      return cfg.collectArticle(args[0])
    case 'analyzeArticle':
      return cfg.analyzeArticle(args[0])
    case 'listArticles':
      return cfg.listArticles()
    case 'getArticleAnalysis':
      return cfg.getArticleAnalysis(args[0] as string)
    case 'deleteArticle':
      return cfg.deleteArticle(args[0] as string)
```

Add the corresponding fields to the dispatcher `cfg` type (the config object type near the top of dispatcher.ts — add `collectArticle`, `analyzeArticle`, `listArticles`, `getArticleAnalysis`, `deleteArticle`).

- [ ] **Step 2: Wire in service/index.ts**

In `apps/desktop/src/service/index.ts`:
- Import `createArticleStore`, `createCollectArticle`, `createAnalyzeArticle` from `./article/...`.
- Construct the store with the userDataDir already available in this module (find where other userData-derived paths are resolved).
- Construct collect/analyze handlers with the same deps shape used for `createAnalyzeEmail` (broadcaster, agentStore, toolRegistry, getBudgetConfig), plus the new `store`.
- Add to the dispatcher config object:
  ```ts
  collectArticle: createCollectArticle({ store: articleStore }),
  analyzeArticle: createAnalyzeArticle({ broadcaster, agentStore, store: articleStore, toolRegistry, getBudgetConfig }),
  listArticles: () => articleStore.list(),
  getArticleAnalysis: (id) => {
    const r = articleStore.get(id)
    return { summary: r?.summary ?? null, analyzedAt: r?.analyzedAt ?? null }
  },
  deleteArticle: (id) => articleStore.delete(id),
  ```

- [ ] **Step 3: Typecheck**

Run: `pnpm --filter @swarm/desktop run typecheck:node`
Expected: PASS.

- [ ] **Step 4: Commit**

```bash
git add apps/desktop/src/service/ipc/dispatcher.ts apps/desktop/src/service/index.ts
git commit -m "feat(service): wire article handlers into dispatcher"
```

---

## Task 8: Main IPC (article-ipc.ts) + wire

**Files:**
- Create: `apps/desktop/src/main/ipc/article-ipc.ts`
- Modify: `apps/desktop/src/main/index.ts`

**Interfaces:**
- Consumes: `serviceClient` (the main-side client that talks to the service via MessagePort), `providers.getInjection()` (host-injects active provider).
- Produces: `ipcMain.handle('swarm:article:list'|'swarm:article:analyze'|'swarm:article:getAnalysis'|'swarm:article:delete')`. NOTE: `collectArticle` is NOT registered here — it is WS-only (extension).

- [ ] **Step 1: Write article-ipc.ts**

Create `apps/desktop/src/main/ipc/article-ipc.ts` (mirror `swarm-ipc.ts`'s analyzeEmail block):

```ts
import type { AnalyzeArticleResult } from '@swarm/protocol'
import { ipcMain } from 'electron'

import type { Service as ProvidersService } from '../providers'

const log // reuse the main logger pattern from swarm-ipc.ts

type Args = {
  serviceClient: import('@swarm/protocol').ServiceClient
  providers: ProvidersService
}

export function wireArticleIpc(args: Args): () => void {
  const { serviceClient, providers } = args

  const analyzeArticle = async (_e: unknown, articleId: string): Promise<AnalyzeArticleResult> => {
    const injection = providers.getInjection()
    if (!injection) {
      return { ok: false, code: 'no_provider', message: '请先在 设置 → 模型 配置提供商。' }
    }
    return serviceClient.analyzeArticle({ articleId, provider: injection })
  }

  ipcMain.handle('swarm:article:list', () => serviceClient.listArticles())
  ipcMain.handle('swarm:article:analyze', analyzeArticle)
  ipcMain.handle('swarm:article:getAnalysis', (_e, id: string) => serviceClient.getArticleAnalysis(id))
  ipcMain.handle('swarm:article:delete', (_e, id: string) => serviceClient.deleteArticle(id))

  return () => {
    ipcMain.removeHandler('swarm:article:list')
    ipcMain.removeHandler('swarm:article:analyze')
    ipcMain.removeHandler('swarm:article:getAnalysis')
    ipcMain.removeHandler('swarm:article:delete')
  }
}
```

- [ ] **Step 2: Wire in main/index.ts**

In `apps/desktop/src/main/index.ts`, find where `wireSwarmIpc` (or equivalent) is called and add `wireArticleIpc` next to it with the same `serviceClient` and `providers`:

```ts
wireArticleIpc({ serviceClient, providers })
```

(Match the exact import + call style used for the existing swarm ipc wiring.)

- [ ] **Step 3: Typecheck**

Run: `pnpm --filter @swarm/desktop run typecheck:node`
Expected: PASS.

- [ ] **Step 4: Commit**

```bash
git add apps/desktop/src/main/ipc/article-ipc.ts apps/desktop/src/main/index.ts
git commit -m "feat(main): article IPC handlers with host-injected provider"
```

---

## Task 9: Preload bridge (article namespace)

**Files:**
- Modify: `apps/desktop/src/preload/index.ts`

**Interfaces:**
- Consumes: `SwarmBridge.article` shape (defined in Task 2).
- Produces: `contextBridge` exposure of `window.swarm.article.{list,analyze,getAnalysis,delete}`.

- [ ] **Step 1: Add the article namespace to the exposed bridge**

In `apps/desktop/src/preload/index.ts`, find the object passed to `contextBridge.exposeInMainWorld('swarm', {...})` and add a new `article` namespace (mirror the `bilibili` namespace style around line 232):

```ts
  article: {
    list: () => ipcRenderer.invoke('swarm:article:list'),
    analyze: (articleId: string) => ipcRenderer.invoke('swarm:article:analyze', articleId),
    getAnalysis: (articleId: string) => ipcRenderer.invoke('swarm:article:getAnalysis', articleId),
    delete: (articleId: string) => ipcRenderer.invoke('swarm:article:delete', articleId),
  },
```

(Add return-type casts to match the `SwarmBridge.article` signatures if the surrounding code casts.)

- [ ] **Step 2: Typecheck**

Run: `pnpm --filter @swarm/desktop run typecheck:node`
Expected: PASS.

- [ ] **Step 3: Commit**

```bash
git add apps/desktop/src/preload/index.ts
git commit -m "feat(preload): expose window.swarm.article namespace"
```

---

## Task 10: Renderer route + nav item + swarmApi

**Files:**
- Modify: `apps/desktop/src/renderer/src/components/rail-config.ts`
- Modify: `apps/desktop/src/renderer/src/lib/api.ts`
- Create: `apps/desktop/src/renderer/src/routes/article.tsx`

**Interfaces:**
- Consumes: `SwarmBridge.article` (preload); `ArticleView` (Task 11).
- Produces: `/articles` route; rail nav item; `swarmApi.article*`.

- [ ] **Step 1: Add rail nav item**

In `apps/desktop/src/renderer/src/components/rail-config.ts`, add `Newspaper` to the lucide-react import and add to the `services` section (after bilibili):

```ts
{ key: 'article', label: '文章', icon: Newspaper, target: { kind: 'route', to: '/articles', match: 'exact' } },
```

- [ ] **Step 2: Add swarmApi.article methods**

In `apps/desktop/src/renderer/src/lib/api.ts`, add to the `swarmApi` object:

```ts
  articleList: () => window.swarm.article.list(),
  articleAnalyze: (articleId: string) => window.swarm.article.analyze(articleId),
  articleGetAnalysis: (articleId: string) => window.swarm.article.getAnalysis(articleId),
  articleDelete: (articleId: string) => window.swarm.article.delete(articleId),
```

- [ ] **Step 3: Create the route**

Create `apps/desktop/src/renderer/src/routes/article.tsx`:

```ts
import { createFileRoute } from '@tanstack/react-router'

import { ArticleView } from '@/components/views/article-view'

export const Route = createFileRoute('/articles')({ component: ArticleView })
```

- [ ] **Step 4: Regenerate route tree**

Run: `pnpm --filter @swarm/desktop run dev` briefly to let TanStack Router regenerate `routeTree.gen.ts`, then stop. (Or run the router's codegen if a standalone command exists.)

- [ ] **Step 5: Typecheck**

Run: `pnpm --filter @swarm/desktop run typecheck:web`
Expected: PASS (ArticleView will be referenced — created in Task 11; if typecheck fails because ArticleView does not exist yet, defer this step's typecheck to end of Task 11).

- [ ] **Step 6: Commit**

```bash
git add apps/desktop/src/renderer/src/components/rail-config.ts apps/desktop/src/renderer/src/lib/api.ts apps/desktop/src/renderer/src/routes/article.tsx apps/desktop/src/renderer/src/routeTree.gen.ts
git commit -m "feat(renderer): article route + nav item + swarmApi"
```

---

## Task 11: ArticleView (card grid)

**Files:**
- Create: `apps/desktop/src/renderer/src/components/views/article-view.tsx`
- Create: `apps/desktop/src/renderer/src/components/views/article-view.test.tsx`

**Interfaces:**
- Consumes: `swarmApi.articleList` (Task 10); `ArticleDetailPanel` (Task 12).
- Produces: `<ArticleView />` — card grid (responsive columns via ResizeObserver, mirror bili's `measureRef`), top stat pill, empty state.

- [ ] **Step 1: Write the failing test**

Create `apps/desktop/src/renderer/src/components/views/article-view.test.tsx`:

```tsx
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { render, screen, waitFor } from '@testing-library/react'
import { describe, expect, it, vi, beforeEach } from 'vitest'

import { ArticleView } from './article-view'

function withClient(ui: React.ReactNode) {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } })
  return <QueryClientProvider client={qc}>{ui}</QueryClientProvider>
}

describe('ArticleView', () => {
  beforeEach(() => {
    vi.stubGlobal('swarm', {
      article: {
        list: vi.fn().mockResolvedValue([]),
        analyze: vi.fn(),
        getAnalysis: vi.fn(),
        delete: vi.fn(),
      },
    })
  })

  it('renders empty state when no articles', async () => {
    render(withClient(<ArticleView />))
    await waitFor(() => expect(screen.getByText(/还没有收集的文章/)).toBeInTheDocument())
  })

  it('renders cards when articles exist', async () => {
    vi.mocked(window.swarm.article.list).mockResolvedValueOnce([
      {
        url: 'https://example.com/a', title: 'First Article', author: null, siteName: 'Ex',
        publishedTime: null, contentMarkdown: 'body', id: '1',
        collectedAt: '2026-07-07T00:00:00.000Z', excerpt: 'body', summary: null, analyzedAt: null,
      },
    ])
    render(withClient(<ArticleView />))
    await waitFor(() => expect(screen.getByText('First Article')).toBeInTheDocument())
  })
})
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm --filter @swarm/desktop run test -- src/components/views/article-view.test.tsx`
Expected: FAIL — module not found.

- [ ] **Step 3: Write article-view.tsx**

Create `apps/desktop/src/renderer/src/components/views/article-view.tsx`. Mirror `bilibili-view.tsx` structure but simplified (no tabs, no login, no folder filter). Key elements:

- `useQuery(['articles','list'], swarmApi.articleList)` + `useQuery(['articles','analyzedIds'])` derived from the list (articles where `summary != null`).
- Top bar: title "文章收集" + the "✨ AI 已解析 N / M" pill (reuse the bili pill classes: `rounded-full border border-violet-500/20 bg-linear-to-br from-violet-500/10 to-primary/10 px-3 py-1 text-xs`).
- Responsive grid via `measureRef` + `ResizeObserver` (copy bili's `columnsForWidth`/`measureRef` with `MIN_CARD_PX=176, GAP_PX=12`).
- `ArticleCard`: 16:9 site-color block + site initial (color via a small `colorForSite(siteName)` hash→palette fn inlined in this file), optional favicon overlay (`https://www.google.com/s2/favicons?domain=${encodeURIComponent(hostname)}&sz=64`), `[AI]` badge top-right when `summary != null`, title (2-line clamp), `siteName · relative-date`.
- Empty state: `📰` + "还没有收集的文章" + "安装浏览器插件…".
- Right side: `<ArticleDetailPanel article={selected} onClose={...} />` (always mounted as sibling, like bili).

Card color helper (inline):

```ts
const SITE_PALETTE = ['bg-violet-500/15 text-violet-600', 'bg-sky-500/15 text-sky-600', 'bg-emerald-500/15 text-emerald-600', 'bg-amber-500/15 text-amber-600', 'bg-rose-500/15 text-rose-600']
function colorForSite(siteName: string | null): string {
  if (!siteName) return SITE_PALETTE[0]
  let h = 0
  for (let i = 0; i < siteName.length; i++) h = (h * 31 + siteName.charCodeAt(i)) >>> 0
  return SITE_PALETTE[h % SITE_PALETTE.length]
}
```

- [ ] **Step 4: Run tests to verify pass**

Run: `pnpm --filter @swarm/desktop run test -- src/components/views/article-view.test.tsx`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add apps/desktop/src/renderer/src/components/views/article-view.tsx apps/desktop/src/renderer/src/components/views/article-view.test.tsx
git commit -m "feat(renderer): article card-grid view"
```

---

## Task 12: ArticleDetailPanel (472px detail + analysis stream)

**Files:**
- Create: `apps/desktop/src/renderer/src/components/views/article-detail-panel.tsx`

**Interfaces:**
- Consumes: `swarmApi.articleAnalyze/articleDelete`; `window.swarm.subscribeEvents` for `article.analysisDelta/Complete/Error`; `<Streamdown>`; `CollectedArticleWithAnalysis`, `ArticleSummary`.
- Produces: `<ArticleDetailPanel article onClose onChanged />`.

- [ ] **Step 1: Write the component**

Create `apps/desktop/src/renderer/src/components/views/article-detail-panel.tsx`. Mirror `bilibili-detail-panel.tsx` (472px `<aside>`, two columns, SummaryView + FullText tabs). Key behaviors:

- Props: `{ article: CollectedArticleWithAnalysis | null; onClose: () => void; onChanged: () => void }`.
- Left column (280px): site-color block + excerpt preview + buttons `[AI 分析]` (calls `swarmApi.articleAnalyze(article.id)`, disabled while pending), `[打开原文]` (`window.open(article.url)`), `[删除]` (calls `swarmApi.articleDelete(article.id)` then `onChanged`).
- Right column: `[AI 解析]` / `[原文]` tab toggle. AI 解析 renders a `SummaryView` (gist card + 核心要点 + 可带走洞察 lists, copy bili's structure but drop pitfalls/steps). 原文 renders `<Streamdown>{article.contentMarkdown}</Streamdown>`.
- Analysis stream state machine (local `useState`): `idle` → `streaming` (subscribe to `article.analysisDelta`, accumulate text, show with `<Streamdown>`) → `done` (on `article.analysisComplete`, set summary, invalidate `['articles','list']` via `useQueryClient`). On `article.analysisError` show destructive error text.
- Reset state when `article.id` changes (useEffect on `[article?.id]`).
- Empty state (no article selected): `📰 选择一篇文章查看详情`.

SummaryView (inline subcomponent):

```tsx
function SummaryView({ summary }: { summary: ArticleSummary }) {
  return (
    <div className="flex flex-col gap-5">
      <div className="rounded-md border border-border bg-muted/30 p-4">
        <p className="mb-2 font-medium text-muted-foreground text-xs tracking-wide">一句话结论</p>
        <p className="text-[15px] text-foreground leading-7">{summary.gist}</p>
      </div>
      {summary.points.length > 0 ? (
        <section className="rounded-md border border-border p-4">
          <p className="mb-3 font-medium text-foreground text-sm">核心要点</p>
          <ul className="flex list-disc flex-col gap-2 pl-4 text-[13px] text-foreground/85 leading-6">
            {summary.points.map((p, i) => <li key={i}>{p}</li>)}
          </ul>
        </section>
      ) : null}
      {summary.takeaways.length > 0 ? (
        <section className="rounded-md border border-border p-4">
          <p className="mb-3 font-medium text-foreground text-sm">可带走洞察</p>
          <ul className="flex list-disc flex-col gap-2 pl-4 text-[13px] text-foreground/85 leading-6">
            {summary.takeaways.map((p, i) => <li key={i}>{p}</li>)}
          </ul>
        </section>
      ) : null}
    </div>
  )
}
```

Event subscription (mirror gmail-inbox-view's MessageAnalysis):

```tsx
useEffect(() => {
  if (!article) return
  const off = window.swarm.subscribeEvents((e) => {
    if (e.kind === 'article.analysisDelta' && e.articleId === article.id) {
      setPhase('streaming')
      setStreamText((prev) => prev + e.text)
    } else if (e.kind === 'article.analysisComplete' && e.articleId === article.id) {
      setSummary(e.summary)
      setPhase('done')
      queryClient.invalidateQueries({ queryKey: ['articles', 'list'] })
    } else if (e.kind === 'article.analysisError' && e.articleId === article.id) {
      setError(e.error)
      setPhase('error')
    }
  })
  return off
}, [article?.id, queryClient])
```

- [ ] **Step 2: Typecheck**

Run: `pnpm --filter @swarm/desktop run typecheck:web`
Expected: PASS.

- [ ] **Step 3: Commit**

```bash
git add apps/desktop/src/renderer/src/components/views/article-detail-panel.tsx
git commit -m "feat(renderer): article detail panel with analysis stream"
```

---

## Task 13: Extension content script (extract)

**Files:**
- Modify: `apps/extension/package.json`
- Create: `apps/extension/lib/extract.ts`
- Create: `apps/extension/lib/extract.test.ts`
- Create: `apps/extension/entrypoints/content/extract.ts`

**Interfaces:**
- Produces: pure `extractArticleFromDocument(doc, location): ArticleSource | null` (testable); a WXT content script that wires it to a message listener.

- [ ] **Step 1: Add deps**

In `apps/extension/package.json` `dependencies`, add (match desktop's versions):

```json
    "@mozilla/readability": "^0.6.0",
    "turndown": "^7.2.4"
```

And devDeps:

```json
    "@types/turndown": "^5.0.5"
```

Run: `pnpm install`

- [ ] **Step 2: Write the failing test (pure logic)**

Create `apps/extension/lib/extract.test.ts`:

```ts
import { JSDOM } from 'jsdom'
import { describe, expect, it } from 'vitest'

import { extractArticleFromDocument } from './extract'

function dom(html: string, url = 'https://example.com/a'): { document: Document; location: Location } {
  const dom = new JSDOM(html, { url })
  return { document: dom.window.document, location: dom.window.location }
}

describe('extractArticleFromDocument', () => {
  it('extracts an article document', () => {
    const { document, location } = dom(`<html><head><title>T</title></head><body><article><h1>T</h1><p>${'long paragraph '.repeat(50)}</article></body></html>`)
    const r = extractArticleFromDocument(document, location)
    expect(r).not.toBeNull()
    expect(r?.url).toBe('https://example.com/a')
    expect(r?.title.length).toBeGreaterThan(0)
    expect(r?.contentMarkdown.length).toBeGreaterThan(0)
  })
  it('returns null for a non-article page', () => {
    const { document, location } = dom('<html><body><p>hi</p></body></html>')
    const r = extractArticleFromDocument(document, location)
    expect(r).toBeNull()
  })
})
```

- [ ] **Step 3: Run test to verify it fails**

Run: `pnpm --filter @swarm/extension run test`
Expected: FAIL — module not found.

- [ ] **Step 4: Write extract.ts (pure)**

Create `apps/extension/lib/extract.ts`:

```ts
import { Readability } from '@mozilla/readability'
import TurndownService from 'turndown'

import type { ArticleSource } from '@swarm/protocol'

// Pure extractor: takes a Document + Location (both injectable for tests via jsdom)
// and returns a cleaned ArticleSource, or null if the page is not an article.
export function extractArticleFromDocument(doc: Document, loc: Location): ArticleSource | null {
  try {
    const clone = doc.cloneNode(true) as Document
    const article = new Readability(clone).parse()
    if (!article?.content) return null
    const contentMarkdown = new TurndownService().turndown(article.content)
    return {
      url: loc.href,
      title: article.title ?? doc.title,
      author: article.byline ?? null,
      siteName: article.siteName ?? null,
      publishedTime: null,
      contentMarkdown,
    }
  } catch {
    return null
  }
}
```

Add `jsdom` to extension devDeps if not transitively available; the test imports it directly. (Desktop already has jsdom; for the extension package add `"jsdom": "^29.1.1"` to devDependencies if the test runner needs it.)

- [ ] **Step 5: Run tests to verify pass**

Run: `pnpm --filter @swarm/extension run test`
Expected: PASS.

- [ ] **Step 6: Write the content script**

Create `apps/extension/entrypoints/content/extract.ts`:

```ts
import { extractArticleFromDocument } from '../../lib/extract'

export default defineContentScript({
  matches: ['<all_urls>'],
  main() {
    browser.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
      if ((msg as { type?: string })?.type !== 'extract') return false
      try {
        const result = extractArticleFromDocument(document, location)
        sendResponse(result)
      } catch {
        sendResponse(null)
      }
      return false
    })
  },
})
```

- [ ] **Step 7: Commit**

```bash
git add apps/extension/package.json apps/extension/lib/extract.ts apps/extension/lib/extract.test.ts apps/extension/entrypoints/content/extract.ts
git commit -m "feat(extension): readability content script for article extraction"
```

---

## Task 14: Extension background + popup (collect current page)

**Files:**
- Modify: `apps/extension/entrypoints/background.ts`
- Modify: `apps/extension/entrypoints/popup/Popup.tsx`

**Interfaces:**
- Consumes: `ServiceClient.collectArticle` (existing client in background); content script `extract` message; `browser.tabs.query`.
- Produces: `collectCurrentPage` message handler; popup "收集当前页" button with status feedback.

- [ ] **Step 1: Add collectCurrentPage handler to background.ts**

In `apps/extension/entrypoints/background.ts`, inside the existing `browser.runtime.onMessage.addListener(...)` (the one that currently handles `listAgents`), add a branch BEFORE returning false:

```ts
    if ((msg as { type?: string })?.type === 'collectCurrentPage' && client) {
      ;(async () => {
        try {
          const [tab] = await browser.tabs.query({ active: true, currentWindow: true })
          if (!tab.id) {
            sendResponse({ ok: false, error: 'no active tab' })
            return
          }
          const input = await browser.tabs.sendMessage(tab.id, { type: 'extract' })
          if (!input) {
            sendResponse({ ok: false, error: '抽取失败(非文章页?)' })
            return
          }
          const res = await client.collectArticle(input)
          if (res.ok) sendResponse({ ok: true, articleId: res.articleId })
          else sendResponse({ ok: false, error: res.message })
        } catch (err) {
          sendResponse({ ok: false, error: String(err) })
        }
      })()
      return true
    }
```

Place it so the existing `listAgents` branch still returns its own value; ensure the two branches are mutually exclusive (check `msg.type` distinctly).

- [ ] **Step 2: Update popup**

In `apps/extension/entrypoints/popup/Popup.tsx`, add a "收集当前页到文章库" primary button + status line. On click: send `{ type: 'collectCurrentPage' }` to the background; show `◷ 发送中…` → `✓ 已收集,去 desktop 查看` (green) or `✗ <error>` (red). Disable the button when the connection probe (existing) is not connected, or while sending.

- [ ] **Step 3: Build to verify**

Run: `pnpm --filter @swarm/extension run build`
Expected: builds `.output/chrome-mv3/` with the content script + updated popup + background.

- [ ] **Step 4: Commit**

```bash
git add apps/extension/entrypoints/background.ts apps/extension/entrypoints/popup/Popup.tsx
git commit -m "feat(extension): collect-current-page button + background handler"
```

---

## Task 15: Verify gate + manual smoke notes

**Files:** none (verification only).

- [ ] **Step 1: Full typecheck**

Run: `pnpm run typecheck`
Expected: PASS across all packages.

- [ ] **Step 2: Full test**

Run: `pnpm run test`
Expected: PASS (all new tests + existing).

- [ ] **Step 3: Boundaries**

Run: `pnpm run check-boundaries`
Expected: PASS (protocol/shared import nothing platform-bound).

- [ ] **Step 4: Lint touched files**

Run: `pnpm run check`
Expected: clean (or only pre-existing debt unchanged).

- [ ] **Step 5: Manual smoke (document in PR)**

1. `pnpm --filter @swarm/desktop run dev`.
2. Load the built extension (`apps/extension/.output/chrome-mv3`) in Chrome, paste token.
3. Open an article page → popup → "收集当前页" → see ✓.
4. In desktop → 文章 nav → card appears → click → detail panel → "AI 分析" → structured summary streams in.
5. Reopen the same card → summary is cached (no re-analyze needed).

- [ ] **Step 6: Final commit (if any fixups)**

```bash
git commit --allow-empty -m "chore(article): verify gate green"
```

---

## Self-Review Notes

**Spec coverage:** Every spec section maps to a task — §4 protocol (T1-2), §5 backend (T4-8), §5.4 agent (T3), §6 extension (T13-14), §7 renderer (T9-12), §8 file list (all tasks), §9 testing (each task has tests), §10 risks addressed in implementation (JSON parse tolerance T6, button-disable T14).

**Type consistency:** `ArticleSummary` shape `{gist, points, takeaways}` is identical in T1 (protocol), T3 (agent prompt), T6 (analyze parse), T12 (SummaryView). `ArticleStore` interface in T4 matches what T5/T6/T7 consume. `ServiceClient` methods in T2 match T8/T10 usage. `SwarmBridge.article` in T2 matches T9 preload + T10/T12 renderer usage.

**Placeholder scan:** No TBD/TODO. Task 7/8 reference "find where X lives" — these are navigation instructions to existing code the implementer must locate, with enough context to find it (mirror analyzeEmail/bilibili wiring); they are not undefined behavior.

**Signature correction vs spec:** spec §5.3 wrote `acquireSlot: async () => () => undefined` — T6 reproduces the EXACT gmail signature (verified at `service/gmail/analyze.ts:85`), which is correct.
