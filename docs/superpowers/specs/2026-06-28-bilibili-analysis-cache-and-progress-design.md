# Bilibili — Analysis Cache, Full-Text Display, and Stage Progress

Date: 2026-06-28
Branch: `worktree-bilibili-analysis-cache` (based on `develop` b445759, which includes milestone C)
Status: Design approved, pending implementation plan.

## Problem

Three user-requested additions on top of the Bilibili AI summary + transcription features:

1. **Show the full parsed text.** Today the detail panel shows only the structured
   `BiliSummary` (gist/points/…). The user wants the full subtitle text or transcript
   shown as well.
2. **Mark already-analyzed videos.** Today every "AI 分析" / transcription re-runs from
   scratch — nothing is persisted. The user wants a badge on videos that have been
   analyzed, and (per the chosen option) the cached result shown instantly on reopen so
   transcription (minutes long) never re-runs needlessly.
3. **Stage progress animations.** While a transcription runs, show an animated step
   indicator for 下载音频 → 解析音频 → AI 分析 instead of the current plain
   "转写中…(audio)" text.

## Decisions (locked)

- **Persist the full analyzed result** (summary + full text + source + timestamp) keyed
  by bvid, in a dedicated store. This single cache serves all three features: badges,
  instant reopen, and full-text display.
- **Full text shown in a collapsible section** below the summary, expanded into the
  project's `ScrollArea` component (fixed height), default collapsed.
- **Badge** is a small "AI" marker on the card cover corner.
- **On cache hit**, the detail panel shows the cached summary + text without re-running;
  the analyze button becomes "重新分析" (re-runs and overwrites the cache).
- **Stage progress** reuses the existing `bilibili:transcribe:progress` broadcast
  (stages `queued → audio → transcribing → summarizing → done/failed`). No new backend
  progress plumbing.
- The cache store is **plain JSON** (not `safeStorage`-encrypted): summaries/transcripts
  are not secrets, unlike the credentials in `store.ts`.

## Architecture

### 1. Data model (`src/shared/types/bilibili.ts`)

```ts
export type BiliAnalysisSource = 'subtitle' | 'transcript'

export type BiliAnalysis = {
  bvid: string
  summary: BiliSummary
  text: string // full subtitle text or transcript
  source: BiliAnalysisSource
  analyzedAt: string // ISO timestamp
}
```

Extend the success branches to carry the text back to the renderer and the cache:
- `BiliProcessResult` ok branch gains `text: string; source: 'subtitle'`.
- `BiliTranscribeResult` ok branch gains `text: string; source: 'transcript'`.

A Zod schema `BiliAnalysisSchema` (`.strict()`) validates persisted entries on load.

### 2. New store `src/main/bilibili/analysis-store.ts` (+ test)

Mirrors `store.ts`'s atomic write (tmp → rename) but stores a plain-JSON map keyed by
bvid and is **not** encrypted. Loads the whole map into memory on first access.

```ts
export type AnalysisStore = {
  get(bvid: string): BiliAnalysis | null
  put(a: BiliAnalysis): Promise<void>
  bvids(): string[] // keys only, for badges
}
export function createAnalysisStore(opts: { filePath: string }): AnalysisStore
```

- `get` returns a single entry (or null) — used by the detail panel.
- `bvids` returns just the keys — used for badges, so the full text never crosses IPC
  for the list view.
- `put` upserts and writes through to disk; a malformed on-disk file loads as empty.

Add `paths.bilibiliAnalysis()` in `src/main/constants.ts` (sibling file to the existing
bilibili config path).

### 3. Data flow

- `pipeline.processVideo` (subtitle path): on success it already holds `text`; return
  `{ ok: true, summary, text, source: 'subtitle' }`.
- `transcribe-queue` (transcription path): on success it already holds the transcript
  `text`; return `{ ok: true, summary, text, source: 'transcript' }`.
- IPC `bilibili:process` and `bilibili:transcribe`: on an ok result, call
  `analysisStore.put({ bvid, summary, text, source, analyzedAt })`. A cache write failure
  is logged at `warn` and does **not** change the user-facing result (they still get the
  summary).

### 4. New IPC + bridge

- `bilibili:analyzedBvids` → `string[]`
- `bilibili:getAnalysis` (bvid) → `BiliAnalysis | null`

Wired through preload (`src/preload/index.ts`), the `BilibiliBridge` type
(`src/shared/types/ui.ts`), and `swarmApi` (`src/renderer/src/lib/api.ts`), following the
existing method patterns.

### 5. Renderer

#### List view (`bilibili-view.tsx`)
- A `useQuery` for `analyzedBvids` produces a `Set<string>`.
- `VideoCard` gets an `analyzed` prop; when true it renders a small "AI" badge in the
  cover's top-right corner (absolute-positioned over the cover image).
- After any analysis/transcription completes in the detail panel, invalidate the
  `analyzedBvids` query so the freshly analyzed card shows its badge.

#### Detail panel (`VideoDetailSheet`)
- On open, `useQuery(getAnalysis(bvid))`.
- Unified `summary`/`text`/`source` resolution order: cached analysis → fresh subtitle
  result → fresh transcription result.
- **Cache hit**: render the summary + full-text section immediately, no auto-run. The
  analyze button reads "重新分析" and re-runs the subtitle/transcription path, overwriting
  the cache on success.
- **Cache miss**: existing "AI 分析" / "本地转写" flows unchanged; on success the result
  is cached and the full text becomes available.
- **Full-text section**: a collapsible block under the summary (default collapsed). When
  expanded, the text renders inside the project's `ScrollArea` at a fixed height, with a
  heading reflecting the source — "字幕原文" or "转写全文".

#### Stage progress (`TranscribeProgress` component + test)
- A 3-step indicator: 下载音频 (`audio`) → 解析音频 (`transcribing`) → AI 分析
  (`summarizing`). Step state derived from the current `stage`:
  - completed → check icon
  - active → `Loader2` with `animate-spin`
  - pending → dim dot
  - `failed` → the active step is marked with an error style
  - `queued` → a "排队中" label, all steps pending
- Rendered in the detail panel while `transcribeMutation.isPending`, driven by the
  `bilibili:transcribe:progress` events already subscribed to (replacing the current
  "转写中…(stage)" button text).
- **Subtitle path** (`bilibili:process`) has only the AI-analysis step, so it shows a
  single spinner + "AI 分析中…" rather than the 3-step indicator (the 3 steps would
  misleadingly imply audio download/transcription that this path never does).

### 6. Error handling

- Cache read failure → treated as no cache (panel falls back to the normal run flow).
- Cache write failure → logged at `warn` with `bvid`; the user-facing result is unchanged.
- A `failed` transcription stage drives the indicator's error style; the specific error
  message continues to come from the result's `message` (unchanged from milestone C).

### 7. Testing

- `analysis-store.test.ts` — put/get/bvids round-trip; missing file → empty; corrupt file
  → empty; `put` overwrites an existing bvid.
- `pipeline.test.ts` / `transcribe-queue.test.ts` — success results include `text` and the
  correct `source`.
- `ipc.test.ts` — a successful `bilibili:process` / `bilibili:transcribe` writes the entry
  to the analysis store; `analyzedBvids` / `getAnalysis` return persisted data.
- `bilibili-view` tests — a card with an analyzed bvid shows the badge; opening a cached
  video shows the summary + full text without calling `bilibiliProcess`; the full-text
  section is collapsible.
- `TranscribeProgress` test — each `stage` value renders the expected per-step states
  (done/active/pending/error).

## Out of scope

- Cache eviction / size limits (personal-scale favorites list; revisit only if it grows).
- Encrypting the analysis cache (no secrets stored).
- Progress for the subtitle path beyond a single spinner (it is one LLM call).
- Editing or manually clearing cached analyses (re-analyze overwrites; full management UI
  is not requested).
