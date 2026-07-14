# Bilibili Milestone B — AI 字幕总结（面板内展示）Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 点击 Bilibili 视频后，拉取其字幕、调用已配置的 LLM 产出结构化总结（主旨/要点/经验/踩坑/步骤），在已有的详情面板内展示。

**Architecture:** 沿用 milestone A 的 `src/main/bilibili/` 分层。新增 `wbi.ts`（WBI 签名）、`subtitle.ts`（取 cid + 字幕文本）、`summarize.ts`（组 prompt → 调 provider injection 的 chat 接口 → 解析结构化 JSON）、`pipeline.ts`（串联，单飞 single-flight）。`ipc.ts` 增 `bilibili:process` 端点。渲染层在 `bilibili-view.tsx` 的详情 Sheet 内加「AI 分析」按钮与结果区。

**Tech Stack:** Electron main (Node `fetch`, `node:crypto` md5), TanStack Query, 既有 `providers` service (`getInjection()`)。

## Global Constraints

- 语言：对话用中文；**代码注释与 commit message 一律英文**（CLAUDE.md §0）。
- 日志：每个业务路径用 `createLogger({ process: 'main' }).child({ component: 'bilibili-<module>' })`，入口/出口 `info` 带 `bvid` 与阶段名，每个 `catch` `error` 不吞，分支意外 `warn`（CLAUDE.md §5）。
- 简单优先、外科手术式改动（CLAUDE.md §2/§3）。
- 测试用 `npm test`（Electron node），**绝不** `pnpm rebuild better-sqlite3`。
- 本里程碑**只走字幕路径**；视频无字幕时返回结构化「无字幕」错误，由 UI 提示——本地 ASR 兜底是 milestone C。
- Worktree：在专用 worktree 实现；进入后若无 `node_modules` 先 `ln -s <main>/node_modules <worktree>/node_modules`。

---

### Task 1: 共享类型 `BiliSummary` 与 IPC 桥接签名

**Files:**
- Modify: `src/shared/types/bilibili.ts`
- Modify: `src/shared/types/ui.ts:191-195`（`BilibiliBridge` 增 `process`）

**Interfaces:**
- Produces:
  - `type BiliSummary = { gist: string; points: string[]; experience: string[]; pitfalls: string[]; steps: string[] }`
  - `type BiliProcessResult = { ok: true; summary: BiliSummary } | { ok: false; code: 'no_subtitle' | 'no_provider' | 'llm_failed' | 'unknown'; message: string }`
  - `BilibiliBridge.process(bvid: string): Promise<BiliProcessResult>`

- [ ] **Step 1: Add types to `src/shared/types/bilibili.ts`** (append after `BiliListResult`)

```typescript
// AI summary of a single video, parsed from the LLM's structured output.
export type BiliSummary = {
  gist: string
  points: string[]
  experience: string[]
  pitfalls: string[]
  steps: string[]
}

export type BiliProcessResult =
  | { ok: true; summary: BiliSummary }
  | { ok: false; code: 'no_subtitle' | 'no_provider' | 'llm_failed' | 'unknown'; message: string }
```

- [ ] **Step 2: Extend the renderer bridge type** in `src/shared/types/ui.ts` (the `BilibiliBridge` block around line 191)

```typescript
  list: () => Promise<BiliListResult>
  process: (bvid: string) => Promise<BiliProcessResult>
```

Add `BiliProcessResult` to the existing `@shared/types/bilibili` import in that file.

- [ ] **Step 3: Typecheck**

Run: `npm run typecheck:node`
Expected: no new errors referencing `bilibili.ts` / `ui.ts` (pre-existing `TS6307` config noise about `tsconfig.web.json` is unrelated).

- [ ] **Step 4: Commit**

```bash
git add src/shared/types/bilibili.ts src/shared/types/ui.ts
git commit -m "feat(bilibili): add BiliSummary and process bridge types"
```

---

### Task 2: WBI 签名 `wbi.ts`

**Files:**
- Create: `src/main/bilibili/wbi.ts`
- Test: `src/main/bilibili/wbi.test.ts`

**Interfaces:**
- Consumes: nothing from earlier tasks.
- Produces:
  - `function getMixinKey(orig: string): string`
  - `function encWbi(params: Record<string, string | number>, imgKey: string, subKey: string, wts: number): string` — returns the signed query string `k=v&...&wts=<wts>&w_rid=<md5>`.
  - `function keyFromUrl(url: string): string` — filename stem of a wbi_img url.

- [ ] **Step 1: Write the failing test** `src/main/bilibili/wbi.test.ts`

```typescript
import { describe, expect, it } from 'vitest'
import { encWbi, getMixinKey, keyFromUrl } from './wbi'

describe('wbi', () => {
  it('derives the 32-char mixin key via the permutation table', () => {
    // 64 distinct chars so each table index maps to a known position.
    const orig = 'abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789+/'.padEnd(64, 'X')
    const key = getMixinKey(orig)
    expect(key).toHaveLength(32)
  })

  it('extracts the filename stem from a wbi_img url', () => {
    expect(keyFromUrl('https://i0.hdslb.com/bfs/wbi/7cd084941338484aae1ad9425b84077c.png')).toBe(
      '7cd084941338484aae1ad9425b84077c'
    )
  })

  it('appends sorted params, wts, and a 32-char w_rid', () => {
    const q = encWbi({ bvid: 'BV1xx', cid: 123 }, 'a'.repeat(32), 'b'.repeat(32), 1700000000)
    expect(q).toContain('bvid=BV1xx')
    expect(q).toContain('cid=123')
    expect(q).toContain('wts=1700000000')
    expect(/&w_rid=[a-f0-9]{32}$/.test(q)).toBe(true)
    // params must be sorted: bvid < cid < wts
    expect(q.indexOf('bvid=')).toBeLessThan(q.indexOf('cid='))
    expect(q.indexOf('cid=')).toBeLessThan(q.indexOf('wts='))
  })
})
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npm test -- --run src/main/bilibili/wbi.test.ts`
Expected: FAIL — `Cannot find module './wbi'`.

- [ ] **Step 3: Implement `src/main/bilibili/wbi.ts`**

```typescript
// WBI signing for Bilibili web endpoints that require `w_rid` (e.g. the
// player subtitle endpoint). Algorithm per bilibili-API-collect: mix the two
// nav keys through a fixed permutation table, then md5(sorted-query + mixin).
import { createHash } from 'node:crypto'

const MIXIN_KEY_ENC_TAB = [
  46, 47, 18, 2, 53, 8, 23, 32, 15, 50, 10, 31, 58, 3, 45, 35, 27, 43, 5, 49, 33, 9, 42, 19, 29, 28, 14, 39, 12, 38,
  41, 13, 37, 48, 7, 16, 24, 55, 40, 61, 26, 17, 0, 1, 60, 51, 30, 4, 22, 25, 54, 21, 56, 59, 6, 63, 57, 62, 11, 36,
  20, 34, 44, 52,
]

export function getMixinKey(orig: string): string {
  return MIXIN_KEY_ENC_TAB.map((n) => orig[n] ?? '').join('').slice(0, 32)
}

export function keyFromUrl(url: string): string {
  const file = url.split('/').pop() ?? ''
  return file.split('.')[0] ?? ''
}

export function encWbi(
  params: Record<string, string | number>,
  imgKey: string,
  subKey: string,
  wts: number
): string {
  const mixinKey = getMixinKey(imgKey + subKey)
  const withTs: Record<string, string | number> = { ...params, wts }
  const query = Object.keys(withTs)
    .sort()
    .map((k) => `${encodeURIComponent(k)}=${encodeURIComponent(String(withTs[k]).replace(/[!'()*]/g, ''))}`)
    .join('&')
  const wrid = createHash('md5').update(query + mixinKey).digest('hex')
  return `${query}&w_rid=${wrid}`
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npm test -- --run src/main/bilibili/wbi.test.ts`
Expected: PASS (3 tests).

- [ ] **Step 5: Commit**

```bash
git add src/main/bilibili/wbi.ts src/main/bilibili/wbi.test.ts
git commit -m "feat(bilibili): add WBI request signing"
```

---

### Task 3: 取 cid + 字幕文本 `subtitle.ts`

**Files:**
- Create: `src/main/bilibili/subtitle.ts`
- Test: `src/main/bilibili/subtitle.test.ts`
- Modify: `src/main/bilibili/api.ts`（导出 `getWbiKeys`，复用既有 `get<T>` / `toHttpsUrl`）

**Interfaces:**
- Consumes: `encWbi`, `keyFromUrl` (Task 2); `toHttpsUrl`, `cookieHeader`, `BILI_UA`, `BILI_REFERER` (api.ts).
- Produces:
  - `getWbiKeys(c: BiliCredentials): Promise<{ imgKey: string; subKey: string }>` (in `api.ts`)
  - `getCid(c: BiliCredentials, bvid: string): Promise<number>`
  - `getSubtitleText(deps: SubtitleDeps, c: BiliCredentials, bvid: string): Promise<string | null>` — joined plain text, or `null` when the video has no subtitle.
  - `type SubtitleDeps = { getWbiKeys: typeof getWbiKeys; getCid: (c, bvid) => Promise<number>; nowSec: () => number }`

- [ ] **Step 1: Write the failing test** `src/main/bilibili/subtitle.test.ts`

```typescript
import type { BiliCredentials } from '@shared/types/bilibili'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { getSubtitleText } from './subtitle'

const CRED: BiliCredentials = { sessdata: 's', biliJct: 'j', dedeUserId: 'u' }
const DEPS = {
  getWbiKeys: async () => ({ imgKey: 'a'.repeat(32), subKey: 'b'.repeat(32) }),
  getCid: async () => 999,
  nowSec: () => 1700000000,
}

afterEach(() => vi.restoreAllMocks())

describe('getSubtitleText', () => {
  it('returns null when the player response has no subtitle entries', async () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(
      new Response(JSON.stringify({ code: 0, data: { subtitle: { subtitles: [] } } }))
    )
    expect(await getSubtitleText(DEPS, CRED, 'BV1')).toBeNull()
  })

  it('fetches the first subtitle JSON and joins its body content', async () => {
    const fetchMock = vi
      .spyOn(globalThis, 'fetch')
      .mockResolvedValueOnce(
        new Response(
          JSON.stringify({
            code: 0,
            data: { subtitle: { subtitles: [{ subtitle_url: '//aisubtitle.hdslb.com/x.json', lan: 'ai-zh' }] } },
          })
        )
      )
      .mockResolvedValueOnce(
        new Response(JSON.stringify({ body: [{ content: '第一句' }, { content: '第二句' }] }))
      )
    const text = await getSubtitleText(DEPS, CRED, 'BV1')
    expect(text).toBe('第一句\n第二句')
    // second fetch must be upgraded to https
    expect(String(fetchMock.mock.calls[1][0])).toBe('https://aisubtitle.hdslb.com/x.json')
  })
})
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npm test -- --run src/main/bilibili/subtitle.test.ts`
Expected: FAIL — `Cannot find module './subtitle'`.

- [ ] **Step 3a: Add `getWbiKeys` to `src/main/bilibili/api.ts`** (after `getNav`)

```typescript
import { keyFromUrl } from './wbi'

// The two WBI keys live in the nav response under wbi_img; their filename stems
// feed the signing mixin.
export async function getWbiKeys(c: BiliCredentials): Promise<{ imgKey: string; subKey: string }> {
  const data = await get<{ wbi_img: { img_url: string; sub_url: string } }>(
    'https://api.bilibili.com/x/web-interface/nav',
    c
  )
  return { imgKey: keyFromUrl(data.wbi_img.img_url), subKey: keyFromUrl(data.wbi_img.sub_url) }
}
```

> Note: `get<T>` returns the `data` field already (see existing `getNav`). If `get<T>` is private, export it or add `getWbiKeys` in the same file (preferred — keep it co-located).

- [ ] **Step 3b: Implement `src/main/bilibili/subtitle.ts`**

```typescript
// Fetches a video's subtitle as plain text. cid comes from the view endpoint;
// the subtitle list comes from the WBI-signed player endpoint; each entry's
// subtitle_url points at a JSON of {body:[{content}]}. Returns null when the
// video carries no subtitle (caller decides the fallback).
import { createLogger } from '@shared/logger'
import type { BiliCredentials } from '@shared/types/bilibili'

import { BILI_REFERER, BILI_UA, cookieHeader, getWbiKeys, toHttpsUrl } from './api'
import { encWbi } from './wbi'

const log = createLogger({ process: 'main' }).child({ component: 'bilibili-subtitle' })

export type SubtitleDeps = {
  getWbiKeys: (c: BiliCredentials) => Promise<{ imgKey: string; subKey: string }>
  getCid: (c: BiliCredentials, bvid: string) => Promise<number>
  nowSec: () => number
}

export const defaultSubtitleDeps: SubtitleDeps = {
  getWbiKeys,
  getCid,
  nowSec: () => Math.round(Date.now() / 1000),
}

async function biliGet<T>(url: string, c: BiliCredentials): Promise<T> {
  const res = await fetch(url, {
    headers: { 'User-Agent': BILI_UA, Referer: BILI_REFERER, Cookie: cookieHeader(c) },
  })
  const json = (await res.json()) as { code: number; message?: string; data: T }
  if (json.code !== 0) throw new Error(`bilibili api code ${json.code}: ${json.message ?? ''}`)
  return json.data
}

export async function getCid(c: BiliCredentials, bvid: string): Promise<number> {
  const data = await biliGet<{ cid: number }>(`https://api.bilibili.com/x/web-interface/view?bvid=${bvid}`, c)
  return data.cid
}

export async function getSubtitleText(deps: SubtitleDeps, c: BiliCredentials, bvid: string): Promise<string | null> {
  const cid = await deps.getCid(c, bvid)
  const { imgKey, subKey } = await deps.getWbiKeys(c)
  const query = encWbi({ bvid, cid }, imgKey, subKey, deps.nowSec())
  const player = await biliGet<{ subtitle: { subtitles: { subtitle_url: string; lan: string }[] } }>(
    `https://api.bilibili.com/x/player/wbi/v2?${query}`,
    c
  )
  const subs = player.subtitle?.subtitles ?? []
  if (subs.length === 0) {
    log.warn({ msg: 'no subtitle for video', bvid })
    return null
  }
  // Prefer a Chinese track; otherwise the first available.
  const chosen = subs.find((s) => s.lan.includes('zh')) ?? subs[0]
  const url = toHttpsUrl(chosen.subtitle_url)
  const res = await fetch(url, { headers: { 'User-Agent': BILI_UA, Referer: BILI_REFERER } })
  const doc = (await res.json()) as { body: { content: string }[] }
  return doc.body.map((l) => l.content).join('\n')
}
```

- [ ] **Step 4: Run tests**

Run: `npm test -- --run src/main/bilibili/subtitle.test.ts`
Expected: PASS (2 tests).

- [ ] **Step 5: Commit**

```bash
git add src/main/bilibili/subtitle.ts src/main/bilibili/subtitle.test.ts src/main/bilibili/api.ts
git commit -m "feat(bilibili): fetch subtitle text via cid + WBI player endpoint"
```

---

### Task 4: LLM 结构化总结 `summarize.ts`

**Files:**
- Create: `src/main/bilibili/summarize.ts`
- Test: `src/main/bilibili/summarize.test.ts`

**Interfaces:**
- Consumes: `ProviderInjection` from `@shared/types/provider` (shape: `{ apiKey, baseUrl?, registry?, apiStyle, models: string[] }` — confirm field names against `src/main/providers/test-connection.ts`).
- Produces:
  - `function buildPrompt(input: { title: string; author: string; text: string }): string`
  - `function parseSummary(raw: string): BiliSummary` — tolerant JSON extraction (strips ```json fences).
  - `async function summarize(inj: ProviderInjection, input): Promise<BiliSummary>`

- [ ] **Step 1: Write the failing test** `src/main/bilibili/summarize.test.ts`

```typescript
import { describe, expect, it } from 'vitest'
import { parseSummary } from './summarize'

describe('parseSummary', () => {
  it('parses a fenced JSON block into the structured shape', () => {
    const raw = '```json\n{"gist":"主旨","points":["p1"],"experience":[],"pitfalls":["x"],"steps":["s1","s2"]}\n```'
    const s = parseSummary(raw)
    expect(s.gist).toBe('主旨')
    expect(s.points).toEqual(['p1'])
    expect(s.steps).toEqual(['s1', 's2'])
  })

  it('coerces missing arrays to empty arrays', () => {
    const s = parseSummary('{"gist":"g"}')
    expect(s.points).toEqual([])
    expect(s.pitfalls).toEqual([])
  })
})
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npm test -- --run src/main/bilibili/summarize.test.ts`
Expected: FAIL — `Cannot find module './summarize'`.

- [ ] **Step 3: Implement `src/main/bilibili/summarize.ts`**

```typescript
// Turns a transcript into a structured "experience note" summary by calling the
// user's configured provider through an OpenAI/Anthropic-style chat request.
// URL composition mirrors providers/test-connection.ts so runtime and health
// check go through the same path.
import { createLogger } from '@shared/logger'
import type { BiliSummary } from '@shared/types/bilibili'
import type { ProviderInjection } from '@shared/types/provider'

const log = createLogger({ process: 'main' }).child({ component: 'bilibili-summarize' })

export function buildPrompt(input: { title: string; author: string; text: string }): string {
  return [
    `视频标题：${input.title}`,
    `UP主：${input.author}`,
    '以下是该视频的字幕全文。请基于字幕，输出一篇“经验型”知识卡片。',
    '只返回 JSON，字段：gist(一句话主旨,string)、points(核心要点,string[])、',
    'experience(可复用经验/方法论,string[])、pitfalls(踩坑/注意,string[])、steps(可执行步骤,string[])。',
    '不要输出 JSON 以外的任何文字。',
    '---字幕开始---',
    input.text,
    '---字幕结束---',
  ].join('\n')
}

export function parseSummary(raw: string): BiliSummary {
  const fenced = raw.match(/```(?:json)?\s*([\s\S]*?)```/)
  const body = (fenced ? fenced[1] : raw).trim()
  const obj = JSON.parse(body) as Partial<BiliSummary>
  const arr = (v: unknown): string[] => (Array.isArray(v) ? v.map(String) : [])
  return {
    gist: typeof obj.gist === 'string' ? obj.gist : '',
    points: arr(obj.points),
    experience: arr(obj.experience),
    pitfalls: arr(obj.pitfalls),
    steps: arr(obj.steps),
  }
}

// Mirror providers/test-connection.ts URL composition. Confirm DEFAULT_BASE_URL
// / PATH_BY_STYLE values against that file when implementing.
function chatUrl(inj: ProviderInjection): { url: string; style: 'anthropic' | 'openai' } {
  const style = (inj.registry ?? inj.apiStyle) as 'anthropic' | 'openai'
  const base =
    inj.baseUrl ??
    (style === 'anthropic' ? 'https://api.anthropic.com' : 'https://api.openai.com/v1')
  const path = style === 'anthropic' ? '/v1/messages' : '/chat/completions'
  return { url: `${base.replace(/\/+$/, '')}${path}`, style }
}

export async function summarize(
  inj: ProviderInjection,
  input: { title: string; author: string; text: string }
): Promise<BiliSummary> {
  const model = inj.models[0]
  if (!model) throw new Error('no model configured')
  const { url, style } = chatUrl(inj)
  const prompt = buildPrompt(input)
  log.info({ msg: 'summarize request', model, chars: input.text.length })

  const headers: Record<string, string> = { 'Content-Type': 'application/json' }
  let body: string
  if (style === 'anthropic') {
    headers['x-api-key'] = inj.apiKey
    headers['anthropic-version'] = '2023-06-01'
    body = JSON.stringify({ model, max_tokens: 2048, messages: [{ role: 'user', content: prompt }] })
  } else {
    headers.Authorization = `Bearer ${inj.apiKey}`
    body = JSON.stringify({ model, messages: [{ role: 'user', content: prompt }] })
  }

  const res = await fetch(url, { method: 'POST', headers, body })
  if (!res.ok) {
    const text = await res.text().catch(() => '')
    log.error({ msg: 'summarize http error', status: res.status, body: text.slice(0, 200) })
    throw new Error(`llm http ${res.status}`)
  }
  const json = (await res.json()) as Record<string, unknown>
  const content =
    style === 'anthropic'
      ? // { content: [{ text }] }
        ((json.content as { text?: string }[] | undefined)?.[0]?.text ?? '')
      : // { choices: [{ message: { content } }] }
        (((json.choices as { message?: { content?: string } }[] | undefined)?.[0]?.message?.content) ?? '')
  return parseSummary(content)
}
```

- [ ] **Step 4: Run tests**

Run: `npm test -- --run src/main/bilibili/summarize.test.ts`
Expected: PASS (2 tests).

- [ ] **Step 5: Commit**

```bash
git add src/main/bilibili/summarize.ts src/main/bilibili/summarize.test.ts
git commit -m "feat(bilibili): structured LLM summary via provider injection"
```

---

### Task 5: 串联 `pipeline.ts`（single-flight）

**Files:**
- Create: `src/main/bilibili/pipeline.ts`
- Test: `src/main/bilibili/pipeline.test.ts`

**Interfaces:**
- Consumes: `getSubtitleText` (Task 3), `summarize` (Task 4), `ProviderInjection`.
- Produces:
  - `type PipelineDeps = { getSubtitleText: (...) => Promise<string | null>; summarize: (...) => Promise<BiliSummary>; getInjection: () => ProviderInjection | null; getMeta: (bvid: string) => { title: string; author: string } | null }`
  - `async function processVideo(deps: PipelineDeps, c: BiliCredentials, bvid: string): Promise<BiliProcessResult>`

- [ ] **Step 1: Write the failing test** `src/main/bilibili/pipeline.test.ts`

```typescript
import type { BiliCredentials } from '@shared/types/bilibili'
import { describe, expect, it, vi } from 'vitest'
import { processVideo } from './pipeline'

const CRED: BiliCredentials = { sessdata: 's', biliJct: 'j', dedeUserId: 'u' }
const META = { title: 'T', author: 'A' }
const baseDeps = {
  getInjection: () => ({ apiKey: 'k', apiStyle: 'openai', models: ['m'] }) as any,
  getMeta: () => META,
  getSubtitleText: async () => '字幕文本',
  summarize: async () => ({ gist: 'g', points: [], experience: [], pitfalls: [], steps: [] }),
}

describe('processVideo', () => {
  it('returns no_provider when no provider is configured', async () => {
    const r = await processVideo({ ...baseDeps, getInjection: () => null }, CRED, 'BV1')
    expect(r).toEqual({ ok: false, code: 'no_provider', message: expect.any(String) })
  })

  it('returns no_subtitle when the video has no subtitle', async () => {
    const r = await processVideo({ ...baseDeps, getSubtitleText: async () => null }, CRED, 'BV1')
    expect(r.ok).toBe(false)
    if (!r.ok) expect(r.code).toBe('no_subtitle')
  })

  it('returns the summary on the happy path', async () => {
    const r = await processVideo(baseDeps, CRED, 'BV1')
    expect(r).toEqual({ ok: true, summary: { gist: 'g', points: [], experience: [], pitfalls: [], steps: [] } })
  })

  it('maps a summarize throw to llm_failed', async () => {
    const r = await processVideo(
      { ...baseDeps, summarize: async () => { throw new Error('boom') } },
      CRED,
      'BV1'
    )
    expect(r.ok).toBe(false)
    if (!r.ok) expect(r.code).toBe('llm_failed')
  })
})
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npm test -- --run src/main/bilibili/pipeline.test.ts`
Expected: FAIL — `Cannot find module './pipeline'`.

- [ ] **Step 3: Implement `src/main/bilibili/pipeline.ts`**

```typescript
// Orchestrates one video: subtitle text -> LLM summary. Each stage logs its
// entry/outcome with the bvid so a failure is locatable from the log alone.
// This milestone is subtitle-only; missing subtitle returns a structured
// no_subtitle (ASR fallback is milestone C).
import { createLogger } from '@shared/logger'
import type { BiliCredentials, BiliProcessResult, BiliSummary } from '@shared/types/bilibili'
import type { ProviderInjection } from '@shared/types/provider'

const log = createLogger({ process: 'main' }).child({ component: 'bilibili-pipeline' })

export type PipelineDeps = {
  getInjection: () => ProviderInjection | null
  getMeta: (bvid: string) => { title: string; author: string } | null
  getSubtitleText: (c: BiliCredentials, bvid: string) => Promise<string | null>
  summarize: (inj: ProviderInjection, input: { title: string; author: string; text: string }) => Promise<BiliSummary>
}

export async function processVideo(deps: PipelineDeps, c: BiliCredentials, bvid: string): Promise<BiliProcessResult> {
  const started = Date.now()
  log.info({ msg: 'process started', bvid })
  const inj = deps.getInjection()
  if (!inj) {
    log.warn({ msg: 'process no provider', bvid })
    return { ok: false, code: 'no_provider', message: '未配置 AI Provider，请在设置中添加。' }
  }
  let text: string | null
  try {
    text = await deps.getSubtitleText(c, bvid)
  } catch (err) {
    log.error({ msg: 'subtitle stage failed', bvid, err: err instanceof Error ? err.message : String(err) })
    return { ok: false, code: 'unknown', message: '获取字幕失败' }
  }
  if (text === null) {
    log.warn({ msg: 'process no subtitle', bvid })
    return { ok: false, code: 'no_subtitle', message: '该视频没有字幕，暂不支持（语音转写为后续里程碑）。' }
  }
  const meta = deps.getMeta(bvid) ?? { title: '', author: '' }
  try {
    const summary = await deps.summarize(inj, { ...meta, text })
    log.info({ msg: 'process ok', bvid, durationMs: Date.now() - started })
    return { ok: true, summary }
  } catch (err) {
    log.error({ msg: 'summarize stage failed', bvid, err: err instanceof Error ? err.message : String(err) })
    return { ok: false, code: 'llm_failed', message: 'AI 总结失败，请稍后重试。' }
  }
}
```

- [ ] **Step 4: Run tests**

Run: `npm test -- --run src/main/bilibili/pipeline.test.ts`
Expected: PASS (4 tests).

- [ ] **Step 5: Commit**

```bash
git add src/main/bilibili/pipeline.ts src/main/bilibili/pipeline.test.ts
git commit -m "feat(bilibili): pipeline wiring subtitle -> summary with staged logging"
```

---

### Task 6: IPC 端点 `bilibili:process` + 单飞

**Files:**
- Modify: `src/main/bilibili/ipc.ts`
- Modify: `src/main/bilibili/ipc.test.ts`
- Modify: `src/main/bilibili/index.ts`（装配：把 providers `getInjection` 与 list 的 meta 来源注入 pipeline）

**Interfaces:**
- Consumes: `processVideo` (Task 5), `defaultSubtitleDeps`/`getSubtitleText` (Task 3), `summarize` (Task 4), providers `service.getInjection`.
- Produces: IPC channel `bilibili:process` returning `BiliProcessResult`. A `bvid->inflight Promise` map makes repeat clicks single-flight.

- [ ] **Step 1: Write the failing test** — add to `src/main/bilibili/ipc.test.ts`

```typescript
it('process returns no_provider when injection is null', async () => {
  // Arrange a wireBilibiliIpc with auth logged in, store credentials present,
  // providers.getInjection() => null. Invoke the registered 'bilibili:process'
  // handler with a bvid and assert { ok:false, code:'no_provider' }.
})
```

(Implement using the same `ipcMain.handle` capture pattern the existing tests in this file use — mirror that file's harness exactly.)

- [ ] **Step 2: Run test to verify it fails**

Run: `npm test -- --run src/main/bilibili/ipc.test.ts`
Expected: FAIL — handler not registered / wrong result.

- [ ] **Step 3: Wire `bilibili:process`** in `src/main/bilibili/ipc.ts` (inside `wireBilibiliIpc`, after the `bilibili:list` handler). Accept a `getInjection` dep on `wireBilibiliIpc` opts.

```typescript
const inflight = new Map<string, Promise<BiliProcessResult>>()

ipcMain.handle('bilibili:process', async (_e, bvid: string): Promise<BiliProcessResult> => {
  const existing = inflight.get(bvid)
  if (existing) {
    log.warn({ msg: 'process already inflight; joining', bvid })
    return existing
  }
  const run = (async (): Promise<BiliProcessResult> => {
    const st = await auth.status()
    const cfg = await store.load()
    if (!st.loggedIn || !cfg.credentials) return { ok: false, code: 'unknown', message: '未登录' }
    return processVideo(
      {
        getInjection: opts.getInjection,
        getMeta: (id) => metaIndex.get(id) ?? null,
        getSubtitleText: (c, id) => getSubtitleText(defaultSubtitleDeps, c, id),
        summarize,
      },
      cfg.credentials,
      bvid
    )
  })()
  inflight.set(bvid, run)
  try {
    return await run
  } finally {
    inflight.delete(bvid)
  }
})
```

> `metaIndex`: build a `Map<bvid, {title, author}>` when `bilibili:list` resolves (store the last list result in a module variable), so the pipeline gets title/author without a refetch. Add `'bilibili:process'` to the `dispose()` channel list.

- [ ] **Step 4: Add `getInjection` to the assembly** in `src/main/bilibili/index.ts` — pass `providers.service.getInjection` (the providers handle is initialized in `src/main/index.ts`; thread it into `wireBilibiliIpc`).

- [ ] **Step 5: Run tests**

Run: `npm test -- --run src/main/bilibili/ipc.test.ts`
Expected: PASS.

- [ ] **Step 6: Add the preload bridge method** — wherever `bilibili.list` is exposed (search `bilibili:list` in `src/preload`), add:

```typescript
process: (bvid: string) => ipcRenderer.invoke('bilibili:process', bvid),
```

And in `src/renderer/src/lib/api.ts`, add `bilibiliProcess(bvid)` mirroring `getBilibiliList`.

- [ ] **Step 7: Typecheck + commit**

Run: `npm run typecheck:node`

```bash
git add src/main/bilibili/ipc.ts src/main/bilibili/ipc.test.ts src/main/bilibili/index.ts src/preload src/renderer/src/lib/api.ts
git commit -m "feat(bilibili): bilibili:process IPC endpoint with single-flight"
```

---

### Task 7: 详情面板「AI 分析」按钮与结果区

**Files:**
- Modify: `src/renderer/src/components/views/bilibili-view.tsx`
- Modify: `src/renderer/src/components/views/bilibili-view.test.tsx`

**Interfaces:**
- Consumes: `swarmApi.bilibiliProcess(bvid)` (Task 6); `BiliSummary`, `BiliProcessResult`.
- Produces: in-panel summary UI; no new exports.

- [ ] **Step 1: Write the failing test** — add to `bilibili-view.test.tsx`

```typescript
it('runs AI analysis from the detail panel and shows the summary', async () => {
  vi.spyOn(swarmApi, 'getBilibiliStatus').mockResolvedValue({ loggedIn: true, uname: 'me', mid: 42 })
  vi.spyOn(swarmApi, 'getBilibiliList').mockResolvedValue(SAMPLE)
  vi.spyOn(swarmApi, 'bilibiliProcess').mockResolvedValue({
    ok: true,
    summary: { gist: 'AI主旨', points: ['要点一'], experience: [], pitfalls: [], steps: [] },
  })
  render(wrap(<BilibiliView />))
  fireEvent.click(await screen.findByText('视频甲'))
  fireEvent.click(await screen.findByRole('button', { name: /AI 分析/ }))
  expect(await screen.findByText('AI主旨')).toBeInTheDocument()
  expect(screen.getByText('要点一')).toBeInTheDocument()
})

it('shows the no-subtitle message when analysis fails that way', async () => {
  vi.spyOn(swarmApi, 'getBilibiliStatus').mockResolvedValue({ loggedIn: true, uname: 'me', mid: 42 })
  vi.spyOn(swarmApi, 'getBilibiliList').mockResolvedValue(SAMPLE)
  vi.spyOn(swarmApi, 'bilibiliProcess').mockResolvedValue({
    ok: false,
    code: 'no_subtitle',
    message: '该视频没有字幕，暂不支持（语音转写为后续里程碑）。',
  })
  render(wrap(<BilibiliView />))
  fireEvent.click(await screen.findByText('视频甲'))
  fireEvent.click(await screen.findByRole('button', { name: /AI 分析/ }))
  expect(await screen.findByText(/没有字幕/)).toBeInTheDocument()
})
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npm test -- --run src/renderer/src/components/views/bilibili-view.test.tsx`
Expected: FAIL — no `AI 分析` button / `bilibiliProcess` undefined.

- [ ] **Step 3: Implement** — inside `VideoDetailSheet`, add a TanStack `useMutation` calling `swarmApi.bilibiliProcess(video.bvid)`, an `AI 分析` button (disabled while pending, label `分析中…`), and render the result: on `ok` show gist + the non-empty sections (要点/经验/踩坑/步骤) as labelled lists; on `!ok` show `result.message` in a muted/destructive style. Reset the mutation when `video` changes (so reopening another card clears the previous summary).

```tsx
// sketch — adapt to the existing useMutation import in the renderer
const mutation = useMutation({ mutationFn: (bvid: string) => swarmApi.bilibiliProcess(bvid) })
// in JSX, below the intro:
<Button disabled={mutation.isPending} onClick={() => video && mutation.mutate(video.bvid)}>
  {mutation.isPending ? '分析中…' : 'AI 分析'}
</Button>
{mutation.data?.ok ? <SummaryView summary={mutation.data.summary} /> : null}
{mutation.data && !mutation.data.ok ? <p className="text-destructive text-sm">{mutation.data.message}</p> : null}
```

Add a small `SummaryView` sub-component that renders `gist` plus each non-empty array under a Chinese heading (核心要点 / 可复用经验 / 踩坑注意 / 可执行步骤).

- [ ] **Step 4: Run tests**

Run: `npm test -- --run src/renderer/src/components/views/bilibili-view.test.tsx`
Expected: PASS (all, including the 2 new).

- [ ] **Step 5: Lint + typecheck**

Run: `node_modules/.bin/biome check --write src/renderer/src/components/views/bilibili-view.tsx src/renderer/src/components/views/bilibili-view.test.tsx`
Run: `npm run typecheck:web` (ignore pre-existing TS6307 noise)

- [ ] **Step 6: Commit**

```bash
git add src/renderer/src/components/views/bilibili-view.tsx src/renderer/src/components/views/bilibili-view.test.tsx
git commit -m "feat(bilibili): AI analysis button and summary view in detail panel"
```

---

## Self-Review

- **Spec coverage (B 范围):** 字幕提取 ✔ (Task 3)、WBI 签名 ✔ (Task 2)、LLM 结构化总结 ✔ (Task 4)、串联 + 阶段日志 ✔ (Task 5)、IPC + 单飞队列雏形 ✔ (Task 6)、面板内展示 ✔ (Task 7)。**不在本里程碑**：无字幕 ASR 兜底、Obsidian 写入、Settings 配置栏、多任务队列——分别留给 milestone C / B2（见设计文档 §4-§7）。
- **Provider injection 字段名**：Task 4 的 `ProviderInjection` 字段（`registry`/`apiStyle`/`baseUrl`/`apiKey`/`models`）以 `src/main/providers/test-connection.ts` 为准，实现时核对。
- **响应解析**：Anthropic `content[0].text` vs OpenAI `choices[0].message.content` 已分支处理；若用户用 OpenRouter（openai 风格）走后者。
- **类型一致性**：`BiliProcessResult` 的 code 枚举在 Task 1/5/7 一致（`no_subtitle|no_provider|llm_failed|unknown`）。
- **single-flight**：Task 6 的 inflight map 即设计文档「点一个跑一个」的最小实现；正式队列（可排队多个）随 milestone C 引入。
