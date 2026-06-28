# Bilibili Analysis Cache, Full-Text Display & Stage Progress — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Persist each video's analysis (summary + full text + source), badge analyzed videos in the list, show the cached result instantly on reopen with the full parsed text in a collapsible area, and animate the transcription stages (下载音频 → 解析音频 → AI 分析).

**Architecture:** A dedicated plain-JSON cache store keyed by bvid backs all three features. The subtitle pipeline and transcription queue return the full text + source on success; the IPC layer writes them to the cache. The list reads the analyzed bvid set for badges; the detail panel reads a single cached entry to render instantly. A new `TranscribeProgress` component renders the existing `bilibili:transcribe:progress` stages as an animated stepper.

**Tech Stack:** Electron 42, TypeScript, Zod, Vitest (electron runner), React 19 + TanStack Query, lucide-react (`Loader2`), the project `ScrollArea` component.

## Global Constraints

- Reply to the user in Chinese; **code comments and commit messages in English**.
- Business paths log entry/outcome/`catch` via `createLogger({ process: 'main' }).child({ component })`; every catch logs `{ msg, err, ... }` and never swallows silently.
- Run tests with `npm test -- <path>` (maps to `ELECTRON_RUN_AS_NODE=1 electron .../vitest.mjs run <path>`). Never bare `npx vitest`.
- All work stays in worktree `worktree-bilibili-analysis-cache`; use worktree-relative paths.
- Deps-injected pure modules in the style of `store.ts`/`subtitle.ts`; Zod schemas `.strict()`.
- The analysis cache is plain JSON (NOT `safeStorage`) — summaries/transcripts are not secrets.
- Every scroll container uses the project `ScrollArea` component (`@/components/ui/scroll-area`), never raw `overflow-auto`.

---

### Task 1: Analysis types and text/source on result success branches

**Files:**
- Modify: `src/shared/types/bilibili.ts`
- Test: `src/shared/types/bilibili.test.ts`

**Interfaces:**
- Produces:
  - `type BiliAnalysisSource = 'subtitle' | 'transcript'`
  - `type BiliAnalysis = { bvid: string; summary: BiliSummary; text: string; source: BiliAnalysisSource; analyzedAt: string }`
  - `BiliAnalysisSchema` (Zod, `.strict()`)
  - `BiliProcessResult` ok branch: `{ ok: true; summary: BiliSummary; text: string; source: 'subtitle' }`
  - `BiliTranscribeResult` ok branch: `{ ok: true; summary: BiliSummary; text: string; source: 'transcript' }`

- [ ] **Step 1: Write the failing test**

Add to `src/shared/types/bilibili.test.ts`:

```ts
import { BiliAnalysisSchema } from './bilibili'

describe('BiliAnalysisSchema', () => {
  it('accepts a valid analysis entry', () => {
    const r = BiliAnalysisSchema.safeParse({
      bvid: 'BV1',
      summary: { gist: 'g', points: [], experience: [], pitfalls: [], steps: [] },
      text: '全文',
      source: 'subtitle',
      analyzedAt: '2026-06-28T00:00:00.000Z',
    })
    expect(r.success).toBe(true)
  })

  it('rejects an unknown source', () => {
    const r = BiliAnalysisSchema.safeParse({
      bvid: 'BV1',
      summary: { gist: 'g', points: [], experience: [], pitfalls: [], steps: [] },
      text: 't',
      source: 'video',
      analyzedAt: '2026-06-28T00:00:00.000Z',
    })
    expect(r.success).toBe(false)
  })
})
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `npm test -- src/shared/types/bilibili.test.ts`
Expected: FAIL — `BiliAnalysisSchema` is not exported.

- [ ] **Step 3: Add the schema, types, and extend the result unions**

In `src/shared/types/bilibili.ts`, add after the existing `BiliSummary` type (which has `gist/points/experience/pitfalls/steps`):

```ts
export type BiliAnalysisSource = 'subtitle' | 'transcript'

const BiliSummarySchema = z
  .object({
    gist: z.string(),
    points: z.array(z.string()),
    experience: z.array(z.string()),
    pitfalls: z.array(z.string()),
    steps: z.array(z.string()),
  })
  .strict()

export const BiliAnalysisSchema = z
  .object({
    bvid: z.string(),
    summary: BiliSummarySchema,
    text: z.string(),
    source: z.enum(['subtitle', 'transcript']),
    analyzedAt: z.string(),
  })
  .strict()

export type BiliAnalysis = z.infer<typeof BiliAnalysisSchema>
```

Update `BiliProcessResult` (its current ok branch is `{ ok: true; summary: BiliSummary }`):

```ts
export type BiliProcessResult =
  | { ok: true; summary: BiliSummary; text: string; source: 'subtitle' }
  | { ok: false; code: 'no_subtitle' | 'no_provider' | 'llm_failed' | 'unknown'; message: string }
```

Update `BiliTranscribeResult` ok branch (currently `{ ok: true; summary: BiliSummary }`):

```ts
  | { ok: true; summary: BiliSummary; text: string; source: 'transcript' }
```

(Leave the `BiliTranscribeResult` error branch exactly as-is.)

- [ ] **Step 4: Run the test to verify it passes**

Run: `npm test -- src/shared/types/bilibili.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/shared/types/bilibili.ts src/shared/types/bilibili.test.ts
git commit -m "feat(bilibili): analysis cache types and text/source on result success"
```

---

### Task 2: Analysis cache store

**Files:**
- Create: `src/main/bilibili/analysis-store.ts`
- Test: `src/main/bilibili/analysis-store.test.ts`
- Modify: `src/main/constants.ts` (add `paths.bilibiliAnalysis`)

**Interfaces:**
- Consumes: `BiliAnalysis`, `BiliAnalysisSchema` (Task 1).
- Produces:
  - `type AnalysisStore = { get(bvid: string): BiliAnalysis | null; put(a: BiliAnalysis): Promise<void>; bvids(): string[] }`
  - `createAnalysisStore(opts: { filePath: string }): AnalysisStore`
  - `paths.bilibiliAnalysis(): string`

- [ ] **Step 1: Add the path**

In `src/main/constants.ts`, next to `bilibili: () => join(app.getPath('userData'), 'bilibili.bin'),` add:

```ts
  bilibiliAnalysis: () => join(app.getPath('userData'), 'bilibili-analysis.json'),
```

- [ ] **Step 2: Write the failing test**

Create `src/main/bilibili/analysis-store.test.ts`:

```ts
import { promises as fs } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { BiliAnalysis } from '@shared/types/bilibili'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { createAnalysisStore } from './analysis-store'

let filePath = ''
const ENTRY: BiliAnalysis = {
  bvid: 'BV1',
  summary: { gist: 'g', points: ['p'], experience: [], pitfalls: [], steps: [] },
  text: '全文内容',
  source: 'subtitle',
  analyzedAt: '2026-06-28T00:00:00.000Z',
}

beforeEach(async () => {
  filePath = join(await fs.mkdtemp(join(tmpdir(), 'bili-analysis-')), 'a.json')
})
afterEach(async () => {
  await fs.rm(join(filePath, '..'), { recursive: true, force: true })
})

describe('analysis store', () => {
  it('returns null / empty when the file is missing', () => {
    const s = createAnalysisStore({ filePath })
    expect(s.get('BV1')).toBeNull()
    expect(s.bvids()).toEqual([])
  })

  it('round-trips an entry and lists its bvid', async () => {
    const s = createAnalysisStore({ filePath })
    await s.put(ENTRY)
    expect(s.get('BV1')).toEqual(ENTRY)
    expect(s.bvids()).toEqual(['BV1'])
    // a fresh store instance reads it back from disk
    const s2 = createAnalysisStore({ filePath })
    expect(s2.get('BV1')).toEqual(ENTRY)
  })

  it('overwrites an existing bvid', async () => {
    const s = createAnalysisStore({ filePath })
    await s.put(ENTRY)
    await s.put({ ...ENTRY, text: '新的全文', source: 'transcript' })
    expect(s.get('BV1')?.text).toBe('新的全文')
    expect(s.bvids()).toEqual(['BV1'])
  })

  it('treats a corrupt file as empty', async () => {
    await fs.writeFile(filePath, 'not json')
    const s = createAnalysisStore({ filePath })
    expect(s.bvids()).toEqual([])
  })
})
```

- [ ] **Step 3: Run the test to verify it fails**

Run: `npm test -- src/main/bilibili/analysis-store.test.ts`
Expected: FAIL — `Cannot find module './analysis-store'`.

- [ ] **Step 4: Write the implementation**

Create `src/main/bilibili/analysis-store.ts`:

```ts
// Plain-JSON cache of AI analyses keyed by bvid (summary + full text + source).
// Not encrypted: unlike credentials in store.ts, summaries/transcripts are not
// secrets. Loads the whole map into memory on first access; writes are atomic
// (tmp -> rename). A malformed file loads as empty so a bad write never wedges
// the feature.
import { existsSync, promises as fs, readFileSync } from 'node:fs'
import { type BiliAnalysis, BiliAnalysisSchema } from '@shared/types/bilibili'
import { z } from 'zod'

export type AnalysisStore = {
  get(bvid: string): BiliAnalysis | null
  put(a: BiliAnalysis): Promise<void>
  bvids(): string[]
}

const MapSchema = z.record(z.string(), BiliAnalysisSchema)

export function createAnalysisStore(opts: { filePath: string }): AnalysisStore {
  const { filePath } = opts

  const load = (): Record<string, BiliAnalysis> => {
    if (!existsSync(filePath)) return {}
    try {
      const parsed = MapSchema.safeParse(JSON.parse(readFileSync(filePath, 'utf8')))
      return parsed.success ? parsed.data : {}
    } catch {
      return {}
    }
  }

  const map = load()

  let saveQueue: Promise<void> = Promise.resolve()
  const persist = (): Promise<void> => {
    const next = saveQueue.then(async () => {
      const tmp = `${filePath}.tmp`
      await fs.writeFile(tmp, JSON.stringify(map))
      await fs.rename(tmp, filePath)
    })
    saveQueue = next.catch(() => undefined)
    return next
  }

  return {
    get: (bvid) => map[bvid] ?? null,
    put: (a) => {
      map[a.bvid] = a
      return persist()
    },
    bvids: () => Object.keys(map),
  }
}
```

- [ ] **Step 5: Run the test to verify it passes**

Run: `npm test -- src/main/bilibili/analysis-store.test.ts`
Expected: PASS (4 tests).

- [ ] **Step 6: Typecheck and commit**

Run: `npm run typecheck:node`
Expected: no errors.

```bash
git add src/main/bilibili/analysis-store.ts src/main/bilibili/analysis-store.test.ts src/main/constants.ts
git commit -m "feat(bilibili): plain-json analysis cache store keyed by bvid"
```

---

### Task 3: Return full text + source from the subtitle and transcription paths

**Files:**
- Modify: `src/main/bilibili/pipeline.ts`
- Modify: `src/main/bilibili/transcribe-queue.ts`
- Test: `src/main/bilibili/pipeline.test.ts`, `src/main/bilibili/transcribe-queue.test.ts`

**Interfaces:**
- Consumes: extended `BiliProcessResult` / `BiliTranscribeResult` (Task 1).
- Produces: both success results now carry `text` and `source`.

- [ ] **Step 1: Update the pipeline test expectation**

In `src/main/bilibili/pipeline.test.ts`, find the success-path assertion (it asserts an ok result with `summary`). Update the expected object to include `text` and `source: 'subtitle'`. For example, if the test does `expect(result).toEqual({ ok: true, summary: SUMMARY })`, change it to:

```ts
expect(result).toEqual({ ok: true, summary: SUMMARY, text: SUBTITLE_TEXT, source: 'subtitle' })
```

where `SUBTITLE_TEXT` is whatever the mocked `getSubtitleText` returns in that test (match the existing mock's return value).

- [ ] **Step 2: Update the transcribe-queue test expectation**

In `src/main/bilibili/transcribe-queue.test.ts`, the first test asserts `expect(res).toEqual({ ok: true, summary: SUMMARY })`. Change it to:

```ts
expect(res).toEqual({ ok: true, summary: SUMMARY, text: '转写文本', source: 'transcript' })
```

(`'转写文本'` is what the `baseDeps().transcribeWav` fake returns.)

- [ ] **Step 3: Run the tests to verify they fail**

Run: `npm test -- src/main/bilibili/pipeline.test.ts src/main/bilibili/transcribe-queue.test.ts`
Expected: FAIL — results lack `text`/`source`.

- [ ] **Step 4: Update the pipeline implementation**

In `src/main/bilibili/pipeline.ts`, the success return is currently:

```ts
    const summary = await deps.summarize(inj, { bvid, ...meta, text })
    log.info({ msg: 'process ok', bvid, durationMs: Date.now() - started })
    return { ok: true, summary }
```

Change the return to:

```ts
    return { ok: true, summary, text, source: 'subtitle' }
```

- [ ] **Step 5: Update the transcription queue implementation**

In `src/main/bilibili/transcribe-queue.ts`, the success return inside `runJob` is currently:

```ts
      const summary = await deps.summarize(inj, { bvid, ...meta, text })
      emit(bvid, 'done')
      log.info({ msg: 'transcribe ok', bvid, durationMs: Date.now() - started })
      return { ok: true, summary }
```

Change the return to:

```ts
      return { ok: true, summary, text, source: 'transcript' }
```

- [ ] **Step 6: Run the tests to verify they pass**

Run: `npm test -- src/main/bilibili/pipeline.test.ts src/main/bilibili/transcribe-queue.test.ts`
Expected: PASS.

- [ ] **Step 7: Typecheck and commit**

Run: `npm run typecheck:node`
Expected: no errors.

```bash
git add src/main/bilibili/pipeline.ts src/main/bilibili/transcribe-queue.ts src/main/bilibili/pipeline.test.ts src/main/bilibili/transcribe-queue.test.ts
git commit -m "feat(bilibili): carry full text and source back from analysis paths"
```

---

### Task 4: Wire the cache store into IPC — persist on success, expose queries

**Files:**
- Modify: `src/main/bilibili/index.ts`
- Modify: `src/main/bilibili/ipc.ts`
- Test: `src/main/bilibili/ipc.test.ts`

**Interfaces:**
- Consumes: `createAnalysisStore` / `AnalysisStore` (Task 2); extended results (Task 3).
- Produces: `wireBilibiliIpc` opts gain `analysisStore: AnalysisStore`; IPC channels `bilibili:analyzedBvids` → `string[]`, `bilibili:getAnalysis` (bvid) → `BiliAnalysis | null`; `bilibili:process` and `bilibili:transcribe` persist on success.

- [ ] **Step 1: Create and pass the store in index.ts**

In `src/main/bilibili/index.ts`:

```ts
import { createAnalysisStore } from './analysis-store'
// ...
export function initBilibili(opts: { getInjection: () => ProviderInjection | null }): BilibiliHandle {
  const store = createStore({ filePath: paths.bilibili() })
  const analysisStore = createAnalysisStore({ filePath: paths.bilibiliAnalysis() })
  const auth = createAuth({ store })
  const { dispose } = wireBilibiliIpc({ auth, store, analysisStore, getInjection: opts.getInjection })
  return { dispose }
}
```

- [ ] **Step 2: Add the store to the IPC types and imports**

In `src/main/bilibili/ipc.ts`, add to the type imports from `@shared/types/bilibili`: `BiliAnalysis`. Add a value import for the store type:

```ts
import type { AnalysisStore } from './analysis-store'
```

Extend the `wireBilibiliIpc` options type to include `analysisStore: AnalysisStore` and destructure it:

```ts
export function wireBilibiliIpc(opts: {
  auth: Auth
  store: Store
  analysisStore: AnalysisStore
  getInjection: () => ProviderInjection | null
}): { dispose: () => void } {
  const { auth, store, analysisStore } = opts
```

- [ ] **Step 3: Persist on a successful subtitle analysis**

In the `bilibili:process` handler, the inner `run` currently returns `processVideo(...)`. After awaiting the result, persist on success. Replace the handler body's `return await run` / surrounding logic so that on an ok result it writes to the cache. Concretely, change the `run` IIFE's resolution handling: after `const result = await run` (the value returned in the `try`), add persistence. The simplest in-place change — wrap the existing `processVideo` call's result:

```ts
    const run = (async (): Promise<BiliProcessResult> => {
      const st = await auth.status()
      const cfg = await store.load()
      if (!st.loggedIn || !cfg.credentials) return { ok: false, code: 'unknown', message: '未登录' }
      const result = await processVideo(
        {
          getInjection: opts.getInjection,
          getMeta: (id) => metaIndex.get(id) ?? null,
          getSubtitleText: (c, id) => getSubtitleText(defaultSubtitleDeps, c, id),
          summarize,
        },
        cfg.credentials,
        bvid
      )
      if (result.ok) await persistAnalysis(bvid, result.summary, result.text, result.source)
      return result
    })()
```

Add this helper inside `wireBilibiliIpc` (near the queue setup):

```ts
  const persistAnalysis = async (
    bvid: string,
    summary: BiliSummary,
    text: string,
    source: BiliAnalysis['source']
  ): Promise<void> => {
    try {
      await analysisStore.put({ bvid, summary, text, source, analyzedAt: new Date().toISOString() })
    } catch (err) {
      log.warn({ msg: 'analysis cache write failed', bvid, err: err instanceof Error ? err.message : String(err) })
    }
  }
```

- [ ] **Step 4: Persist on a successful transcription**

The `bilibili:transcribe` handler currently ends with `return queue.enqueue(bvid)`. Change it to await, persist on success, and return:

```ts
  ipcMain.handle('bilibili:transcribe', async (_e, bvid: string): Promise<BiliTranscribeResult> => {
    try {
      await fs.mkdir(workDir, { recursive: true })
    } catch (err) {
      log.error({ msg: 'transcribe workdir create failed', bvid, err: err instanceof Error ? err.message : String(err) })
      return { ok: false, code: 'unknown', message: '无法创建临时目录。' }
    }
    log.info({ msg: 'transcribe requested', bvid })
    const result = await queue.enqueue(bvid)
    if (result.ok) await persistAnalysis(bvid, result.summary, result.text, result.source)
    return result
  })
```

- [ ] **Step 5: Add the query handlers**

After the `bilibili:transcribe` handler add:

```ts
  ipcMain.handle('bilibili:analyzedBvids', (): string[] => analysisStore.bvids())

  ipcMain.handle('bilibili:getAnalysis', (_e, bvid: string): BiliAnalysis | null => analysisStore.get(bvid))
```

Add both channels to the `dispose` removal list:

```ts
        'bilibili:analyzedBvids',
        'bilibili:getAnalysis',
```

- [ ] **Step 6: Update the IPC test to supply a fake store and assert persistence**

In `src/main/bilibili/ipc.test.ts`, the tests call `wireBilibiliIpc({ auth, store, getInjection })`. Add a fake `analysisStore` to every such call. Add an in-memory fake near the other fakes:

```ts
function fakeAnalysisStore() {
  const m = new Map<string, import('@shared/types/bilibili').BiliAnalysis>()
  return {
    get: (b: string) => m.get(b) ?? null,
    put: async (a: import('@shared/types/bilibili').BiliAnalysis) => {
      m.set(a.bvid, a)
    },
    bvids: () => [...m.keys()],
    _map: m,
  }
}
```

Pass `analysisStore: fakeAnalysisStore()` in each `wireBilibiliIpc(...)` call (capture the instance in tests that assert on it).

Add one focused test (mirror the file's existing handler-invocation helper `invoke(channel, ...args)`):

```ts
it('caches the analysis after a successful process and exposes it via analyzedBvids/getAnalysis', async () => {
  // ...arrange auth logged-in + credentials + a getInjection returning a provider,
  // and a metaIndex entry, exactly as the existing process test does...
  // mock processVideo's dependencies so the result is ok with text+source — or, if the
  // existing test stubs `summarize`/`getSubtitleText` via module mocks, reuse that setup.
  const store = fakeAnalysisStore()
  wireBilibiliIpc({ auth: fakeAuth, store: fakeStore, analysisStore: store, getInjection: () => injection })
  await invoke('bilibili:process', 'BV1')
  expect(store.bvids()).toContain('BV1')
  expect(await invoke('bilibili:getAnalysis', 'BV1')).toMatchObject({ bvid: 'BV1', source: 'subtitle' })
})
```

If the existing `ipc.test.ts` does not already exercise a fully-successful `bilibili:process` (it may only test `buildList`/`openVideo`), keep this test minimal: assert that `bilibili:analyzedBvids` and `bilibili:getAnalysis` are registered and return the fake store's data by pre-seeding the fake (`store._map.set('BV1', entry)`) and invoking the channels. Do NOT fabricate a provider/network stack just to force a success — prefer pre-seeding the store to test the query handlers, and rely on Task 3's queue/pipeline tests for the result shape.

- [ ] **Step 7: Run the tests and typecheck**

Run: `npm test -- src/main/bilibili/ipc.test.ts`
Expected: PASS.
Run: `npm run typecheck:node`
Expected: no errors.

- [ ] **Step 8: Commit**

```bash
git add src/main/bilibili/index.ts src/main/bilibili/ipc.ts src/main/bilibili/ipc.test.ts
git commit -m "feat(bilibili): persist analyses on success and expose cache queries over IPC"
```

---

### Task 5: Preload bridge, shared type, and api wrappers for the cache queries

**Files:**
- Modify: `src/shared/types/ui.ts` (`BilibiliBridge`)
- Modify: `src/preload/index.ts`
- Modify: `src/renderer/src/lib/api.ts`

**Interfaces:**
- Consumes: channels from Task 4.
- Produces on `window.swarm.bilibili`: `analyzedBvids`, `getAnalysis`; and `swarmApi.bilibiliAnalyzedBvids`, `swarmApi.bilibiliGetAnalysis`.

- [ ] **Step 1: Extend the bridge type**

In `src/shared/types/ui.ts`, add `BiliAnalysis` to the existing bilibili type import, and add to `BilibiliBridge` (after `onTranscribeProgress`):

```ts
  analyzedBvids: () => Promise<string[]>
  getAnalysis: (bvid: string) => Promise<BiliAnalysis | null>
```

- [ ] **Step 2: Implement the preload methods**

In `src/preload/index.ts`, add `BiliAnalysis` to the bilibili type import, and to the `bilibili` bridge object (after `onTranscribeProgress`):

```ts
  analyzedBvids: () => ipcRenderer.invoke('bilibili:analyzedBvids') as Promise<string[]>,
  getAnalysis: (bvid: string) => ipcRenderer.invoke('bilibili:getAnalysis', bvid) as Promise<BiliAnalysis | null>,
```

- [ ] **Step 3: Add the api wrappers**

In `src/renderer/src/lib/api.ts`, add `BiliAnalysis` to the bilibili type import and add after `bilibiliOnTranscribeProgress`:

```ts
  bilibiliAnalyzedBvids: (): Promise<string[]> => window.swarm.bilibili.analyzedBvids(),
  bilibiliGetAnalysis: (bvid: string): Promise<BiliAnalysis | null> => window.swarm.bilibili.getAnalysis(bvid),
```

- [ ] **Step 4: Typecheck and commit**

Run: `npm run typecheck`
Expected: no errors (node + web).

```bash
git add src/shared/types/ui.ts src/preload/index.ts src/renderer/src/lib/api.ts
git commit -m "feat(bilibili): bridge and api wrappers for analysis cache queries"
```

---

### Task 6: `TranscribeProgress` stage indicator component

**Files:**
- Create: `src/renderer/src/components/views/transcribe-progress.tsx`
- Test: `src/renderer/src/components/views/transcribe-progress.test.tsx`

**Interfaces:**
- Produces: `TranscribeProgress({ stage }: { stage: string | null }): React.JSX.Element` — renders three steps (`audio` 下载音频, `transcribing` 解析音频, `summarizing` AI 分析). Each step root carries `data-testid={`step-${key}`}` and `data-state` ∈ `done | active | pending`.

- [ ] **Step 1: Write the failing test**

Create `src/renderer/src/components/views/transcribe-progress.test.tsx`:

```tsx
// @vitest-environment jsdom
import '@testing-library/jest-dom/vitest'
import { cleanup, render, screen } from '@testing-library/react'
import { afterEach, describe, expect, it } from 'vitest'
import { TranscribeProgress } from './transcribe-progress'

afterEach(cleanup)

const stateOf = (key: string) => screen.getByTestId(`step-${key}`).getAttribute('data-state')

describe('TranscribeProgress', () => {
  it('marks the active step and leaves later steps pending', () => {
    render(<TranscribeProgress stage="transcribing" />)
    expect(stateOf('audio')).toBe('done')
    expect(stateOf('transcribing')).toBe('active')
    expect(stateOf('summarizing')).toBe('pending')
  })

  it('marks all steps pending while queued', () => {
    render(<TranscribeProgress stage="queued" />)
    expect(stateOf('audio')).toBe('pending')
    expect(stateOf('transcribing')).toBe('pending')
    expect(stateOf('summarizing')).toBe('pending')
  })

  it('marks earlier steps done on the last step', () => {
    render(<TranscribeProgress stage="summarizing" />)
    expect(stateOf('audio')).toBe('done')
    expect(stateOf('transcribing')).toBe('done')
    expect(stateOf('summarizing')).toBe('active')
  })
})
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `npm test -- src/renderer/src/components/views/transcribe-progress.test.tsx`
Expected: FAIL — `Cannot find module './transcribe-progress'`.

- [ ] **Step 3: Write the component**

Create `src/renderer/src/components/views/transcribe-progress.tsx`:

```tsx
import { Check, Loader2 } from 'lucide-react'

// Maps the transcription queue's progress stages to a 3-step indicator:
// 下载音频 (audio) -> 解析音频 (transcribing) -> AI 分析 (summarizing). The active
// step spins; earlier steps show a check; later steps are dimmed. 'queued'/null
// leave every step pending.
const STEPS = [
  { key: 'audio', label: '下载音频' },
  { key: 'transcribing', label: '解析音频' },
  { key: 'summarizing', label: 'AI 分析' },
] as const

type StepState = 'done' | 'active' | 'pending'

export function TranscribeProgress({ stage }: { stage: string | null }): React.JSX.Element {
  const activeIdx = STEPS.findIndex((s) => s.key === stage)

  const stateFor = (idx: number): StepState => {
    if (activeIdx < 0) return 'pending'
    if (idx < activeIdx) return 'done'
    if (idx === activeIdx) return 'active'
    return 'pending'
  }

  return (
    <div className="flex flex-col gap-2">
      {STEPS.map((step, idx) => {
        const state = stateFor(idx)
        return (
          <div className="flex items-center gap-2 text-sm" data-state={state} data-testid={`step-${step.key}`} key={step.key}>
            {state === 'done' ? (
              <Check className="size-4 text-primary" />
            ) : state === 'active' ? (
              <Loader2 className="size-4 animate-spin text-primary" />
            ) : (
              <span className="size-1.5 rounded-full bg-muted-foreground/40" />
            )}
            <span className={state === 'pending' ? 'text-muted-foreground' : 'text-foreground'}>{step.label}</span>
          </div>
        )
      })}
    </div>
  )
}
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `npm test -- src/renderer/src/components/views/transcribe-progress.test.tsx`
Expected: PASS (3 tests).

- [ ] **Step 5: Typecheck and commit**

Run: `npm run typecheck:web`
Expected: no errors.

```bash
git add src/renderer/src/components/views/transcribe-progress.tsx src/renderer/src/components/views/transcribe-progress.test.tsx
git commit -m "feat(bilibili): TranscribeProgress stage indicator component"
```

---

### Task 7: Badge analyzed videos in the list

**Files:**
- Modify: `src/renderer/src/components/views/bilibili-view.tsx`
- Test: `src/renderer/src/components/views/bilibili-view.test.tsx`

**Interfaces:**
- Consumes: `swarmApi.bilibiliAnalyzedBvids` (Task 5).
- Produces: `VideoCard` accepts an `analyzed?: boolean` prop and renders an "AI" badge over the cover; `BilibiliView` supplies it from an `analyzedBvids` query.

- [ ] **Step 1: Write the failing test**

In `src/renderer/src/components/views/bilibili-view.test.tsx`, add (the file's `beforeEach` already stubs `bilibiliOnTranscribeProgress`; also stub the new query by default in that `beforeEach`: `vi.spyOn(swarmApi, 'bilibiliAnalyzedBvids').mockResolvedValue([])`):

```tsx
it('shows an AI badge on analyzed videos', async () => {
  vi.spyOn(swarmApi, 'getBilibiliStatus').mockResolvedValue({ loggedIn: true, uname: 'me', mid: 42 })
  vi.spyOn(swarmApi, 'getBilibiliList').mockResolvedValue(SAMPLE)
  vi.spyOn(swarmApi, 'bilibiliAnalyzedBvids').mockResolvedValue(['BV1'])
  render(wrap(<BilibiliView />))
  const card = (await screen.findByText('视频甲')).closest('button') as HTMLElement
  expect(within(card).getByText('AI')).toBeInTheDocument()
})
```

Add `within` to the testing-library import. Ensure the default `beforeEach` stub for `bilibiliAnalyzedBvids` returns `[]` so other tests don't hit the real bridge.

- [ ] **Step 2: Run the test to verify it fails**

Run: `npm test -- src/renderer/src/components/views/bilibili-view.test.tsx`
Expected: FAIL — no "AI" badge.

- [ ] **Step 3: Add the badge to `VideoCard`**

In `src/renderer/src/components/views/bilibili-view.tsx`, change `VideoCard`'s signature and cover markup:

```tsx
function VideoCard({
  video,
  selected,
  analyzed,
  onClick,
}: {
  video: BiliVideo
  selected: boolean
  analyzed: boolean
  onClick: (v: BiliVideo) => void
}): React.JSX.Element {
  return (
    <button
      className={`flex flex-col gap-1 rounded-md border p-2 text-left transition-colors hover:bg-sidebar-accent ${
        selected ? 'border-ring ring-2 ring-ring/50' : 'border-sidebar-border'
      }`}
      onClick={() => onClick(video)}
      type="button"
    >
      <div className="relative w-full">
        {video.cover ? (
          <img
            alt=""
            className="aspect-video w-full rounded object-cover"
            referrerPolicy="no-referrer"
            src={video.cover}
          />
        ) : null}
        {analyzed ? (
          <span className="absolute top-1 right-1 rounded bg-primary px-1.5 py-0.5 font-medium text-[10px] text-primary-foreground">
            AI
          </span>
        ) : null}
      </div>
      <div className="truncate font-medium text-foreground text-sm">{video.title}</div>
      <div className="truncate text-muted-foreground text-xs">{video.author}</div>
    </button>
  )
}
```

- [ ] **Step 4: Supply `analyzed` from a query in `BilibiliView`**

In `BilibiliView`, add the query (near the other `useQuery`s):

```tsx
  const analyzedQuery = useQuery({
    queryKey: ['bilibili', 'analyzedBvids'],
    queryFn: () => swarmApi.bilibiliAnalyzedBvids(),
  })
  const analyzedSet = useMemo(() => new Set(analyzedQuery.data ?? []), [analyzedQuery.data])
```

Find where `VideoCard` is rendered (inside the grid-row render) and pass `analyzed={analyzedSet.has(v.bvid)}`. The existing call passes `video`, `selected`, `onClick`; add the prop.

- [ ] **Step 5: Run the test to verify it passes**

Run: `npm test -- src/renderer/src/components/views/bilibili-view.test.tsx`
Expected: PASS (all tests, including the new badge test).

- [ ] **Step 6: Typecheck and commit**

Run: `npm run typecheck:web`
Expected: no errors.

```bash
git add src/renderer/src/components/views/bilibili-view.tsx src/renderer/src/components/views/bilibili-view.test.tsx
git commit -m "feat(bilibili): AI badge on analyzed videos in the list"
```

---

### Task 8: Detail panel — cached result, full-text section, animated progress

**Files:**
- Modify: `src/renderer/src/components/views/bilibili-view.tsx`
- Test: `src/renderer/src/components/views/bilibili-view.test.tsx`

**Interfaces:**
- Consumes: `swarmApi.bilibiliGetAnalysis` (Task 5), `TranscribeProgress` (Task 6).
- Produces: `VideoDetailSheet` shows a cached analysis instantly, a collapsible full-text section, the animated stepper during transcription, and invalidates the analyzed/analysis queries after a fresh run.

- [ ] **Step 1: Write the failing tests**

In `src/renderer/src/components/views/bilibili-view.test.tsx`, add a default stub for the per-video analysis query in `beforeEach`: `vi.spyOn(swarmApi, 'bilibiliGetAnalysis').mockResolvedValue(null)`. Then add:

```tsx
it('shows a cached analysis without calling bilibiliProcess', async () => {
  vi.spyOn(swarmApi, 'getBilibiliStatus').mockResolvedValue({ loggedIn: true, uname: 'me', mid: 42 })
  vi.spyOn(swarmApi, 'getBilibiliList').mockResolvedValue(SAMPLE)
  const process = vi.spyOn(swarmApi, 'bilibiliProcess')
  vi.spyOn(swarmApi, 'bilibiliGetAnalysis').mockResolvedValue({
    bvid: 'BV1',
    summary: { gist: '缓存主旨', points: [], experience: [], pitfalls: [], steps: [] },
    text: '字幕全文内容',
    source: 'subtitle',
    analyzedAt: '2026-06-28T00:00:00.000Z',
  })
  render(wrap(<BilibiliView />))
  fireEvent.click(await screen.findByText('视频甲'))
  expect(await screen.findByText('缓存主旨')).toBeInTheDocument()
  expect(process).not.toHaveBeenCalled()
})

it('reveals the full text when the section is expanded', async () => {
  vi.spyOn(swarmApi, 'getBilibiliStatus').mockResolvedValue({ loggedIn: true, uname: 'me', mid: 42 })
  vi.spyOn(swarmApi, 'getBilibiliList').mockResolvedValue(SAMPLE)
  vi.spyOn(swarmApi, 'bilibiliGetAnalysis').mockResolvedValue({
    bvid: 'BV1',
    summary: { gist: 'g', points: [], experience: [], pitfalls: [], steps: [] },
    text: '字幕全文内容',
    source: 'subtitle',
    analyzedAt: '2026-06-28T00:00:00.000Z',
  })
  render(wrap(<BilibiliView />))
  fireEvent.click(await screen.findByText('视频甲'))
  fireEvent.click(await screen.findByRole('button', { name: /字幕原文/ }))
  expect(await screen.findByText('字幕全文内容')).toBeInTheDocument()
})
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `npm test -- src/renderer/src/components/views/bilibili-view.test.tsx`
Expected: FAIL — no cached summary shown / no 字幕原文 toggle.

- [ ] **Step 3: Add imports and the cache query**

In `bilibili-view.tsx`, add imports:

```tsx
import { useState } from 'react' // already imported via the existing `react` import — ensure useState is in the list
import { ScrollArea } from '@/components/ui/scroll-area'
import { TranscribeProgress } from './transcribe-progress'
```

(`useQueryClient` is already imported.) In `VideoDetailSheet`, add the query client and cache query:

```tsx
  const queryClient = useQueryClient()
  const analysisQuery = useQuery({
    queryKey: ['bilibili', 'analysis', video?.bvid],
    queryFn: () => (video ? swarmApi.bilibiliGetAnalysis(video.bvid) : Promise.resolve(null)),
    enabled: video !== null,
  })
```

- [ ] **Step 4: Unify the summary/text/source sources and add invalidation**

Replace the existing `const summary = ...` derivation with one that also reads the cache, and derive `text`/`source`:

```tsx
  const cached = analysisQuery.data ?? null
  const summary = mutation.data?.ok
    ? mutation.data.summary
    : transcribeMutation.data?.ok
      ? transcribeMutation.data.summary
      : (cached?.summary ?? null)
  const fullText = mutation.data?.ok
    ? { text: mutation.data.text, source: mutation.data.source }
    : transcribeMutation.data?.ok
      ? { text: transcribeMutation.data.text, source: transcribeMutation.data.source }
      : cached
        ? { text: cached.text, source: cached.source }
        : null
```

Add an `onSuccess` to both mutations that invalidates the analyzed/analysis queries so the badge and cache refresh. Change the mutation declarations:

```tsx
  const mutation = useMutation({
    mutationFn: (bvid: string) => swarmApi.bilibiliProcess(bvid),
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: ['bilibili', 'analyzedBvids'] })
      if (video) void queryClient.invalidateQueries({ queryKey: ['bilibili', 'analysis', video.bvid] })
    },
  })
  const transcribeMutation = useMutation({
    mutationFn: (bvid: string) => swarmApi.bilibiliTranscribe(bvid),
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: ['bilibili', 'analyzedBvids'] })
      if (video) void queryClient.invalidateQueries({ queryKey: ['bilibili', 'analysis', video.bvid] })
    },
  })
```

- [ ] **Step 5: Render the full-text section, progress stepper, and re-analyze label**

Add full-text section state near the other hooks: `const [showText, setShowText] = useState(false)` and reset it in the bvid-change effect (`setShowText(false)`).

Change the analyze button label to reflect a cache hit (re-analyze):

```tsx
                <Button disabled={mutation.isPending} onClick={() => mutation.mutate(video.bvid)}>
                  {mutation.isPending ? '分析中…' : cached ? '重新分析' : 'AI 分析'}
                </Button>
```

Inside the no-subtitle transcription block, replace the in-button stage text with the stepper. Where it currently renders `{transcribeMutation.isPending ? \`转写中…${stage ? \` (${stage})\` : ''}\` : '本地转写'}`, change the button text to a static `'转写中…'` / `'本地转写'`, and render `<TranscribeProgress stage={stage} />` right below the button while pending:

```tsx
                  <Button
                    className="w-fit"
                    disabled={transcribeMutation.isPending}
                    onClick={() => video && transcribeMutation.mutate(video.bvid)}
                    variant="outline"
                  >
                    {transcribeMutation.isPending ? '转写中…' : '本地转写'}
                  </Button>
                  {transcribeMutation.isPending ? <TranscribeProgress stage={stage} /> : null}
```

After the summary/save block, add the collapsible full-text section (shown whenever `fullText` is available):

```tsx
              {fullText ? (
                <div className="flex flex-col gap-1">
                  <Button className="w-fit" onClick={() => setShowText((v) => !v)} variant="ghost">
                    {showText ? '收起' : ''}
                    {fullText.source === 'subtitle' ? '字幕原文' : '转写全文'}
                  </Button>
                  {showText ? (
                    <ScrollArea className="h-64 rounded border p-2">
                      <p className="whitespace-pre-wrap text-foreground/80 text-sm">{fullText.text}</p>
                    </ScrollArea>
                  ) : null}
                </div>
              ) : null}
```

Note: the toggle button's accessible name contains "字幕原文" or "转写全文" in both states (the "收起" prefix only adds to it), so the test's `{ name: /字幕原文/ }` query matches whether collapsed or expanded.

- [ ] **Step 6: Run the tests to verify they pass**

Run: `npm test -- src/renderer/src/components/views/bilibili-view.test.tsx`
Expected: PASS (all tests).

- [ ] **Step 7: Typecheck and commit**

Run: `npm run typecheck:web`
Expected: no errors.

```bash
git add src/renderer/src/components/views/bilibili-view.tsx src/renderer/src/components/views/bilibili-view.test.tsx
git commit -m "feat(bilibili): cached analysis, full-text section, and animated stage progress in detail panel"
```

---

### Task 9: Full verification

- [ ] **Step 1: Typecheck, targeted lint, and the full suite**

Run: `npm run typecheck`
Expected: no errors (node + web).

Run: `npx biome lint src/main/bilibili/analysis-store.ts src/main/bilibili/analysis-store.test.ts src/main/bilibili/ipc.ts src/main/bilibili/pipeline.ts src/main/bilibili/transcribe-queue.ts src/main/bilibili/index.ts src/shared/types/bilibili.ts src/shared/types/ui.ts src/preload/index.ts src/renderer/src/lib/api.ts src/renderer/src/components/views/transcribe-progress.tsx src/renderer/src/components/views/transcribe-progress.test.tsx src/renderer/src/components/views/bilibili-view.tsx src/renderer/src/components/views/bilibili-view.test.tsx`
Expected: `No issues found`. (Repo-wide `pnpm run verify` has pre-existing lint failures in unrelated files; lint only the changed files.)

Run: `npm test`
Expected: all test files pass.

- [ ] **Step 2: Commit any fixups**

```bash
git add -A
git commit -m "chore(bilibili): verify fixups for analysis cache and progress"
```

---

## Self-Review

**Spec coverage:**
- Full-text display → Tasks 1 (text on results), 3 (paths return text), 8 (collapsible ScrollArea section). ✓
- Analyzed badge + cache → Tasks 2 (store), 4 (persist + queries), 5 (bridge), 7 (badge), 8 (cache hit / invalidation). ✓
- Stage progress animation → Tasks 6 (component), 8 (integration). ✓
- Cache hit shows result without re-running, button → 重新分析 → Task 8. ✓
- Plain-JSON store, not encrypted → Task 2. ✓
- Subtitle path keeps single spinner (no 3-step) → Task 8 leaves the `bilibili:process` "分析中…" button untouched; the stepper is only rendered in the transcription block. ✓
- ScrollArea for the text → Task 8. ✓

**Placeholder scan:** Task 4 Step 6 gives the implementer a choice (assert via a forced success vs pre-seeding the fake store) with explicit guidance to prefer pre-seeding — this is deliberate because `ipc.test.ts`'s existing coverage of a full `bilibili:process` success is uncertain; both branches are concrete. No `TBD`/`TODO` remain.

**Type consistency:** `BiliAnalysis` (Task 1) is used identically in Tasks 2, 4, 5. `AnalysisStore` (Task 2: `get`/`put`/`bvids`) is consumed verbatim in Task 4. Result ok branches gain `text: string` + `source` (Task 1) and are produced in Task 3 and read in Tasks 4 and 8. `TranscribeProgress({ stage })` (Task 6) is called with `stage={stage}` in Task 8, where `stage` is the existing `string | null` state. Channel names `bilibili:analyzedBvids` / `bilibili:getAnalysis` match across Tasks 4 and 5. Query keys `['bilibili','analyzedBvids']` and `['bilibili','analysis',bvid]` match between the badge query (Task 7), the cache query and the invalidations (Task 8). ✓
