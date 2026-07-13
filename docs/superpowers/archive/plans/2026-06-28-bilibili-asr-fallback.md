# Bilibili No-Subtitle Local Transcription Fallback — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** When a Bilibili video has no subtitle, let the user click a button to transcribe it locally (DASH audio → ffmpeg → sherpa-onnx SenseVoice) and feed the text into the existing summarization stage, producing the same `BiliSummary`.

**Architecture:** Four new deps-injected main-process modules (`playurl`, `audio`, `transcribe`, `transcribe-queue`) chained by a serial (concurrency=1) in-memory queue. The queue's terminal success reuses the existing `summarize`. New IPC handlers + preload bridge + a progress broadcast channel surface it to the renderer; the detail panel shows the button on `no_subtitle`, the settings page configures ffmpeg path + model dir.

**Tech Stack:** Electron 42, TypeScript, Zod, Vitest (run via `electron` with `ELECTRON_RUN_AS_NODE=1`), React 19 + TanStack Query, `sherpa-onnx-node` (N-API prebuilt), system ffmpeg.

## Global Constraints

- Reply to the user in Chinese; **code comments and commit messages in English** (project CLAUDE.md §0).
- Every business path logs entry (`info`) / outcome (`info` with `durationMs`) / every `catch` (`error` with `{ msg, err, bvid }`) / branch surprises (`warn`) via `createLogger({ process: 'main' }).child({ component })` (project CLAUDE.md §5).
- Run tests with `npm test -- <path>` (this maps to `ELECTRON_RUN_AS_NODE=1 electron .../vitest.mjs run <path>`). **Never** `npx vitest` bare; never `pnpm rebuild better-sqlite3`.
- All work stays in worktree `worktree-bilibili-asr-fallback`; use worktree-relative paths.
- Match existing module style: pure modules with injected `deps`, default deps exported (`defaultSubtitleDeps` pattern), Zod `.strict()` schemas.
- New deps: `sherpa-onnx-node`. ffmpeg is a system binary (configurable path) — no npm dep.

---

### Task 1: Config schema, types, and result/progress contracts

**Files:**
- Modify: `src/shared/types/bilibili.ts`
- Test: `src/shared/types/bilibili.test.ts`

**Interfaces:**
- Produces:
  - `type TranscriptionConfig = { ffmpegPath: string; modelDir: string }`
  - `BilibiliConfigOnDisk` gains `transcription: TranscriptionConfig | null` (default `null`)
  - `type BiliTranscribeStage = 'queued' | 'audio' | 'transcribing' | 'summarizing' | 'done' | 'failed'`
  - `type BiliTranscribeProgress = { bvid: string; stage: BiliTranscribeStage }`
  - `type BiliTranscribeResult = { ok: true; summary: BiliSummary } | { ok: false; code: 'no_config' | 'no_provider' | 'audio_failed' | 'ffmpeg_failed' | 'asr_failed' | 'llm_failed' | 'unknown'; message: string }`

- [ ] **Step 1: Update the default-config test to expect the new field**

In `src/shared/types/bilibili.test.ts`, replace the first assertion:

```ts
  it('defaults to null credentials', () => {
    expect(defaultBilibiliConfigOnDisk()).toEqual({ credentials: null, obsidian: null, transcription: null })
  })
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `npm test -- src/shared/types/bilibili.test.ts`
Expected: FAIL — received object missing `transcription` / not equal.

- [ ] **Step 3: Add the schema, types, and default**

In `src/shared/types/bilibili.ts`, after `ObsidianConfig` (around line 51) add:

```ts
export const TranscriptionConfigSchema = z
  .object({
    ffmpegPath: z.string(),
    modelDir: z.string(),
  })
  .strict()

export type TranscriptionConfig = z.infer<typeof TranscriptionConfigSchema>
```

Add `transcription` to `BilibiliConfigOnDisk`:

```ts
export const BilibiliConfigOnDisk = z
  .object({
    credentials: BiliCredentialsSchema.nullable(),
    obsidian: ObsidianConfigSchema.nullable().default(null),
    transcription: TranscriptionConfigSchema.nullable().default(null),
  })
  .strict()
```

Update the default factory:

```ts
export function defaultBilibiliConfigOnDisk(): BilibiliConfigOnDisk {
  return { credentials: null, obsidian: null, transcription: null }
}
```

At the end of the file add the transcription result/progress contracts:

```ts
export type BiliTranscribeStage = 'queued' | 'audio' | 'transcribing' | 'summarizing' | 'done' | 'failed'

export type BiliTranscribeProgress = { bvid: string; stage: BiliTranscribeStage }

export type BiliTranscribeResult =
  | { ok: true; summary: BiliSummary }
  | {
      ok: false
      code: 'no_config' | 'no_provider' | 'audio_failed' | 'ffmpeg_failed' | 'asr_failed' | 'llm_failed' | 'unknown'
      message: string
    }
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `npm test -- src/shared/types/bilibili.test.ts`
Expected: PASS (3 tests).

- [ ] **Step 5: Commit**

```bash
git add src/shared/types/bilibili.ts src/shared/types/bilibili.test.ts
git commit -m "feat(bilibili): transcription config schema and result/progress types"
```

---

### Task 2: `playurl.ts` — pick the lowest-bitrate DASH audio URL

**Files:**
- Create: `src/main/bilibili/playurl.ts`
- Test: `src/main/bilibili/playurl.test.ts`

**Interfaces:**
- Consumes: `get`, `toHttpsUrl`, `getWbiKeys`, `getCid` from `./api`; `encWbi` from `./wbi`; `SubtitleDeps` shape from `./subtitle`.
- Produces: `getDashAudioUrl(deps: PlayUrlDeps, c: BiliCredentials, bvid: string): Promise<string>`; `defaultPlayUrlDeps: PlayUrlDeps`; `type PlayUrlDeps = { getWbiKeys; getCid; nowSec }`.

- [ ] **Step 1: Write the failing test**

Create `src/main/bilibili/playurl.test.ts`:

```ts
import type { BiliCredentials } from '@shared/types/bilibili'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { getDashAudioUrl } from './playurl'

const CRED: BiliCredentials = { sessdata: 's', biliJct: 'j', dedeUserId: 'u' }
const DEPS = {
  getWbiKeys: async () => ({ imgKey: 'a'.repeat(32), subKey: 'b'.repeat(32) }),
  getCid: async () => 999,
  nowSec: () => 1700000000,
}

afterEach(() => vi.restoreAllMocks())

describe('getDashAudioUrl', () => {
  it('selects the lowest-bandwidth audio track and upgrades it to https', async () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(
      new Response(
        JSON.stringify({
          code: 0,
          data: {
            dash: {
              audio: [
                { id: 30280, baseUrl: 'http://hi.example/high.m4s', bandwidth: 320000 },
                { id: 30216, baseUrl: '//lo.example/low.m4s', bandwidth: 64000 },
              ],
            },
          },
        })
      )
    )
    const url = await getDashAudioUrl(DEPS, CRED, 'BV1')
    expect(url).toBe('https://lo.example/low.m4s')
  })

  it('throws when there is no dash audio track', async () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(
      new Response(JSON.stringify({ code: 0, data: { dash: { audio: [] } } }))
    )
    await expect(getDashAudioUrl(DEPS, CRED, 'BV1')).rejects.toThrow(/no dash audio/)
  })
})
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `npm test -- src/main/bilibili/playurl.test.ts`
Expected: FAIL with "Cannot find module './playurl'".

- [ ] **Step 3: Write the implementation**

Create `src/main/bilibili/playurl.ts`:

```ts
// Picks a video's DASH audio-only stream URL for local ASR. Mirrors subtitle.ts:
// cid from the view endpoint, WBI-signed playurl (fnval=16 requests DASH). We
// choose the lowest-bandwidth audio track — ASR gains nothing from high bitrate,
// and a smaller file downloads and transcodes faster.
import { createLogger } from '@shared/logger'
import type { BiliCredentials } from '@shared/types/bilibili'

import { get, getCid, getWbiKeys, toHttpsUrl } from './api'
import type { SubtitleDeps } from './subtitle'
import { encWbi } from './wbi'

const log = createLogger({ process: 'main' }).child({ component: 'bilibili-playurl' })

export type PlayUrlDeps = SubtitleDeps

export const defaultPlayUrlDeps: PlayUrlDeps = {
  getWbiKeys,
  getCid,
  nowSec: () => Math.round(Date.now() / 1000),
}

type DashAudio = { id: number; baseUrl: string; bandwidth: number }
type PlayUrlData = { dash?: { audio?: DashAudio[] } }

export async function getDashAudioUrl(deps: PlayUrlDeps, c: BiliCredentials, bvid: string): Promise<string> {
  log.info({ msg: 'playurl started', bvid })
  const cid = await deps.getCid(c, bvid)
  const { imgKey, subKey } = await deps.getWbiKeys(c)
  const query = encWbi({ bvid, cid, fnval: 16, fourk: 1 }, imgKey, subKey, deps.nowSec())

  const data = await get<PlayUrlData>(`https://api.bilibili.com/x/player/wbi/playurl?${query}`, c)
  const audios = data.dash?.audio ?? []
  if (audios.length === 0) {
    log.warn({ msg: 'playurl no dash audio', bvid })
    throw new Error(`no dash audio for ${bvid}`)
  }
  const chosen = audios.reduce((lo, a) => (a.bandwidth < lo.bandwidth ? a : lo))
  log.info({ msg: 'playurl ok', bvid, bandwidth: chosen.bandwidth })
  return toHttpsUrl(chosen.baseUrl)
}
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `npm test -- src/main/bilibili/playurl.test.ts`
Expected: PASS (2 tests).

- [ ] **Step 5: Verify `encWbi` accepts numeric params**

Run: `grep -n "export function encWbi" src/main/bilibili/wbi.ts` and confirm it stringifies values. If it types params as `Record<string, string>`, pass strings: `{ bvid, cid: String(cid), fnval: '16', fourk: '1' }`. Adjust the implementation if typecheck fails in Step 6.

- [ ] **Step 6: Typecheck and commit**

Run: `npm run typecheck:node`
Expected: no errors.

```bash
git add src/main/bilibili/playurl.ts src/main/bilibili/playurl.test.ts
git commit -m "feat(bilibili): resolve lowest-bitrate DASH audio url via playurl"
```

---

### Task 3: `audio.ts` — download the m4s and transcode to 16k mono WAV

**Files:**
- Create: `src/main/bilibili/audio.ts`
- Test: `src/main/bilibili/audio.test.ts`

**Interfaces:**
- Consumes: `BILI_UA`, `BILI_REFERER`, `cookieHeader` from `./api`.
- Produces:
  - `class FfmpegError extends Error`
  - `type AudioDeps = { spawn: typeof import('node:child_process').spawn }`; `defaultAudioDeps: AudioDeps`
  - `type ExtractWavArgs = { audioUrl: string; c: BiliCredentials; ffmpegPath: string; workDir: string; bvid: string }`
  - `extractWav(deps: AudioDeps, args: ExtractWavArgs): Promise<string>` — returns the WAV path; removes the intermediate m4s; throws `FfmpegError` on non-zero ffmpeg exit, plain `Error` on download failure.

- [ ] **Step 1: Write the failing test**

Create `src/main/bilibili/audio.test.ts`:

```ts
import { EventEmitter } from 'node:events'
import { promises as fs } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { BiliCredentials } from '@shared/types/bilibili'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { extractWav, FfmpegError } from './audio'

const CRED: BiliCredentials = { sessdata: 's', biliJct: 'j', dedeUserId: 'u' }
let workDir = ''

beforeEach(async () => {
  workDir = await fs.mkdtemp(join(tmpdir(), 'asr-test-'))
})
afterEach(async () => {
  vi.restoreAllMocks()
  await fs.rm(workDir, { recursive: true, force: true })
})

// A fake child process whose exit code we control.
function fakeProc(exitCode: number) {
  const proc = new EventEmitter() as EventEmitter & { stderr: EventEmitter }
  proc.stderr = new EventEmitter()
  queueMicrotask(() => proc.emit('close', exitCode))
  return proc
}

describe('extractWav', () => {
  it('downloads the m4s, runs ffmpeg with 16k mono args, cleans up, and returns the wav path', async () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(new Response(new Uint8Array([1, 2, 3])))
    const spawn = vi.fn(() => fakeProc(0)) as unknown as AudioSpawn
    const wav = await extractWav({ spawn }, {
      audioUrl: 'https://x/low.m4s',
      c: CRED,
      ffmpegPath: '/usr/bin/ffmpeg',
      workDir,
      bvid: 'BV1',
    })
    expect(wav).toBe(join(workDir, 'BV1.wav'))
    // ffmpeg args must request 16kHz mono PCM wav
    const args = (spawn as unknown as { mock: { calls: unknown[][] } }).mock.calls[0]
    expect(args[0]).toBe('/usr/bin/ffmpeg')
    expect(args[1]).toEqual(expect.arrayContaining(['-ac', '1', '-ar', '16000', '-f', 'wav']))
    // intermediate m4s removed
    await expect(fs.access(join(workDir, 'BV1.m4s'))).rejects.toThrow()
  })

  it('throws FfmpegError on non-zero ffmpeg exit', async () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(new Response(new Uint8Array([1])))
    const spawn = vi.fn(() => fakeProc(1)) as unknown as AudioSpawn
    await expect(
      extractWav({ spawn }, { audioUrl: 'https://x/low.m4s', c: CRED, ffmpegPath: 'ffmpeg', workDir, bvid: 'BV1' })
    ).rejects.toBeInstanceOf(FfmpegError)
  })

  it('throws a plain Error when the audio download fails', async () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(new Response(null, { status: 403 }))
    const spawn = vi.fn(() => fakeProc(0)) as unknown as AudioSpawn
    await expect(
      extractWav({ spawn }, { audioUrl: 'https://x/low.m4s', c: CRED, ffmpegPath: 'ffmpeg', workDir, bvid: 'BV1' })
    ).rejects.not.toBeInstanceOf(FfmpegError)
  })
})

type AudioSpawn = import('./audio').AudioDeps['spawn']
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `npm test -- src/main/bilibili/audio.test.ts`
Expected: FAIL with "Cannot find module './audio'".

- [ ] **Step 3: Write the implementation**

Create `src/main/bilibili/audio.ts`:

```ts
// Downloads a DASH audio m4s (with Bilibili's required cookie/UA/Referer) and
// transcodes it to 16 kHz mono PCM WAV via the system ffmpeg — the input format
// sherpa-onnx's offline recognizer expects. ffmpeg is injected via deps.spawn so
// the transcode is unit-testable without a real binary.
import { spawn } from 'node:child_process'
import { promises as fs } from 'node:fs'
import { join } from 'node:path'
import { createLogger } from '@shared/logger'
import type { BiliCredentials } from '@shared/types/bilibili'

import { BILI_REFERER, BILI_UA, cookieHeader } from './api'

const log = createLogger({ process: 'main' }).child({ component: 'bilibili-audio' })

// Distinguishes an ffmpeg failure (binary missing / non-zero exit) from a
// network failure, so the queue can map each to the right user-facing code.
export class FfmpegError extends Error {}

export type AudioDeps = { spawn: typeof spawn }
export const defaultAudioDeps: AudioDeps = { spawn }

export type ExtractWavArgs = {
  audioUrl: string
  c: BiliCredentials
  ffmpegPath: string
  workDir: string
  bvid: string
}

function runFfmpeg(deps: AudioDeps, ffmpegPath: string, args: string[]): Promise<void> {
  return new Promise((resolve, reject) => {
    const proc = deps.spawn(ffmpegPath, args)
    let stderr = ''
    proc.stderr?.on('data', (d) => {
      stderr += String(d)
    })
    proc.on('error', (err) => reject(new FfmpegError(err.message)))
    proc.on('close', (code) => {
      if (code === 0) resolve()
      else reject(new FfmpegError(`ffmpeg exited ${code}: ${stderr.slice(-200)}`))
    })
  })
}

export async function extractWav(deps: AudioDeps, args: ExtractWavArgs): Promise<string> {
  const m4s = join(args.workDir, `${args.bvid}.m4s`)
  const wav = join(args.workDir, `${args.bvid}.wav`)
  log.info({ msg: 'audio extract started', bvid: args.bvid })

  const res = await fetch(args.audioUrl, {
    headers: { 'User-Agent': BILI_UA, Referer: BILI_REFERER, cookie: cookieHeader(args.c) },
  })
  if (!res.ok) {
    log.error({ msg: 'audio download failed', bvid: args.bvid, status: res.status })
    throw new Error(`audio download HTTP ${res.status}`)
  }
  await fs.writeFile(m4s, Buffer.from(await res.arrayBuffer()))

  try {
    // -y overwrite, -ac 1 mono, -ar 16000 16kHz, -f wav PCM container
    await runFfmpeg(deps, args.ffmpegPath, ['-y', '-i', m4s, '-ac', '1', '-ar', '16000', '-f', 'wav', wav])
  } finally {
    await fs.rm(m4s, { force: true })
  }
  log.info({ msg: 'audio extract ok', bvid: args.bvid })
  return wav
}
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `npm test -- src/main/bilibili/audio.test.ts`
Expected: PASS (3 tests).

- [ ] **Step 5: Typecheck and commit**

Run: `npm run typecheck:node`
Expected: no errors.

```bash
git add src/main/bilibili/audio.ts src/main/bilibili/audio.test.ts
git commit -m "feat(bilibili): download dash audio and transcode to 16k mono wav"
```

---

### Task 4: `transcribe.ts` — sherpa-onnx SenseVoice wrapper with per-model cache

**Files:**
- Create: `src/main/bilibili/transcribe.ts`
- Test: `src/main/bilibili/transcribe.test.ts`

**Interfaces:**
- Produces:
  - `type Recognizer = { transcribe(wavPath: string): string }`
  - `type RecognizerFactory = (modelDir: string) => Recognizer`
  - `transcribeWav(args: { wavPath: string; modelDir: string }, factory?: RecognizerFactory): Promise<string>` — builds (and caches per `modelDir`) a recognizer, returns recognized text.
  - `defaultRecognizerFactory: RecognizerFactory` (lazily requires `sherpa-onnx-node`).
  - `__clearRecognizerCache()` (test helper).

- [ ] **Step 1: Write the failing test**

Create `src/main/bilibili/transcribe.test.ts`:

```ts
import { afterEach, describe, expect, it, vi } from 'vitest'
import { __clearRecognizerCache, transcribeWav, type RecognizerFactory } from './transcribe'

afterEach(() => __clearRecognizerCache())

describe('transcribeWav', () => {
  it('returns the recognizer text for the wav', async () => {
    const factory: RecognizerFactory = () => ({ transcribe: () => '识别出来的文字' })
    const text = await transcribeWav({ wavPath: '/tmp/a.wav', modelDir: '/models/sv' }, factory)
    expect(text).toBe('识别出来的文字')
  })

  it('builds the recognizer once per modelDir and reuses it', async () => {
    const build = vi.fn(() => ({ transcribe: () => 'x' }))
    const factory: RecognizerFactory = (dir) => build(dir)
    await transcribeWav({ wavPath: '/tmp/a.wav', modelDir: '/models/sv' }, factory)
    await transcribeWav({ wavPath: '/tmp/b.wav', modelDir: '/models/sv' }, factory)
    expect(build).toHaveBeenCalledTimes(1)
    await transcribeWav({ wavPath: '/tmp/c.wav', modelDir: '/models/other' }, factory)
    expect(build).toHaveBeenCalledTimes(2)
  })
})
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `npm test -- src/main/bilibili/transcribe.test.ts`
Expected: FAIL with "Cannot find module './transcribe'".

- [ ] **Step 3: Write the implementation**

Create `src/main/bilibili/transcribe.ts`:

```ts
// Local speech-to-text via sherpa-onnx (SenseVoice offline model). The native
// module and the multi-hundred-MB model load once per modelDir and are cached —
// rebuilding per request would be prohibitively slow. The recognizer factory is
// injectable so unit tests never touch real native binaries or model files.
import { join } from 'node:path'
import { createLogger } from '@shared/logger'

const log = createLogger({ process: 'main' }).child({ component: 'bilibili-transcribe' })

export type Recognizer = { transcribe(wavPath: string): string }
export type RecognizerFactory = (modelDir: string) => Recognizer

// Builds a SenseVoice recognizer from files inside modelDir. Expects the standard
// sherpa-onnx SenseVoice release layout: model.onnx (or model.int8.onnx) + tokens.txt.
export const defaultRecognizerFactory: RecognizerFactory = (modelDir) => {
  // Lazy require: main-process only, and keeps the native addon out of test loads.
  // biome-ignore lint/suspicious/noExplicitAny: third-party native module has no types
  const sherpa = require('sherpa-onnx-node') as any
  const recognizer = new sherpa.OfflineRecognizer({
    featConfig: { sampleRate: 16000, featureDim: 80 },
    modelConfig: {
      senseVoice: {
        model: join(modelDir, 'model.int8.onnx'),
        language: 'auto',
        useInverseTextNormalization: true,
      },
      tokens: join(modelDir, 'tokens.txt'),
      numThreads: 2,
      provider: 'cpu',
      debug: false,
    },
  })
  return {
    transcribe(wavPath: string): string {
      const wave = sherpa.readWave(wavPath)
      const stream = recognizer.createStream()
      stream.acceptWaveform({ samples: wave.samples, sampleRate: wave.sampleRate })
      recognizer.decode(stream)
      return recognizer.getResult(stream).text as string
    },
  }
}

const cache = new Map<string, Recognizer>()

export function __clearRecognizerCache(): void {
  cache.clear()
}

export async function transcribeWav(
  args: { wavPath: string; modelDir: string },
  factory: RecognizerFactory = defaultRecognizerFactory
): Promise<string> {
  log.info({ msg: 'transcribe started', wavPath: args.wavPath })
  let rec = cache.get(args.modelDir)
  if (!rec) {
    rec = factory(args.modelDir)
    cache.set(args.modelDir, rec)
    log.info({ msg: 'recognizer built', modelDir: args.modelDir })
  }
  const text = rec.transcribe(args.wavPath)
  log.info({ msg: 'transcribe ok', chars: text.length })
  return text
}
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `npm test -- src/main/bilibili/transcribe.test.ts`
Expected: PASS (2 tests).

- [ ] **Step 5: Typecheck and commit**

Run: `npm run typecheck:node`
Expected: no errors. (If `require` triggers a lint/TS error under ESM, keep the `biome-ignore` and ensure `tsconfig.node.json` allows CommonJS interop — it already builds native deps like better-sqlite3. If TS complains about `require` not defined, use `import { createRequire } from 'node:module'; const require = createRequire(import.meta.url)` at the top.)

```bash
git add src/main/bilibili/transcribe.ts src/main/bilibili/transcribe.test.ts
git commit -m "feat(bilibili): sherpa-onnx sensevoice transcription with per-model cache"
```

---

### Task 5: `transcribe-queue.ts` — serial queue chaining the stages into a summary

**Files:**
- Create: `src/main/bilibili/transcribe-queue.ts`
- Test: `src/main/bilibili/transcribe-queue.test.ts`

**Interfaces:**
- Consumes: `getDashAudioUrl` (Task 2), `extractWav` + `FfmpegError` (Task 3), `transcribeWav` (Task 4), `summarize` (existing), `BiliCredentials`, `TranscriptionConfig`, `BiliTranscribeResult`, `BiliTranscribeProgress`, `BiliSummary`, `ProviderInjection`.
- Produces:
  - `type TranscribeQueueDeps` (see code)
  - `createTranscribeQueue(deps): { enqueue(bvid: string): Promise<BiliTranscribeResult>; onProgress(cb): () => void; dispose(): void }`

- [ ] **Step 1: Write the failing test**

Create `src/main/bilibili/transcribe-queue.test.ts`:

```ts
import type { BiliCredentials, BiliSummary, BiliTranscribeProgress, TranscriptionConfig } from '@shared/types/bilibili'
import type { ProviderInjection } from '@shared/types/provider'
import { describe, expect, it, vi } from 'vitest'
import { createTranscribeQueue, type TranscribeQueueDeps } from './transcribe-queue'
import { FfmpegError } from './audio'

const CRED: BiliCredentials = { sessdata: 's', biliJct: 'j', dedeUserId: 'u' }
const CFG: TranscriptionConfig = { ffmpegPath: 'ffmpeg', modelDir: '/m' }
const INJ = { apiKey: 'k', model: 'm', apiStyle: 'openai' } as unknown as ProviderInjection
const SUMMARY: BiliSummary = { gist: 'g', points: [], experience: [], pitfalls: [], steps: [] }

function baseDeps(over: Partial<TranscribeQueueDeps> = {}): TranscribeQueueDeps {
  return {
    getCredentials: async () => CRED,
    getConfig: async () => CFG,
    getInjection: () => INJ,
    getMeta: () => ({ title: 't', author: 'a' }),
    getDashAudioUrl: async () => 'https://x/low.m4s',
    extractWav: async () => '/tmp/a.wav',
    transcribeWav: async () => '转写文本',
    summarize: async () => SUMMARY,
    workDir: '/tmp',
    cleanup: async () => {},
    ...over,
  }
}

describe('createTranscribeQueue', () => {
  it('runs the full chain and returns a summary, emitting stage progress', async () => {
    const q = createTranscribeQueue(baseDeps())
    const stages: string[] = []
    q.onProgress((p: BiliTranscribeProgress) => stages.push(p.stage))
    const res = await q.enqueue('BV1')
    expect(res).toEqual({ ok: true, summary: SUMMARY })
    expect(stages).toEqual(['queued', 'audio', 'transcribing', 'summarizing', 'done'])
  })

  it('returns no_config when transcription is not configured', async () => {
    const q = createTranscribeQueue(baseDeps({ getConfig: async () => null }))
    expect(await q.enqueue('BV1')).toMatchObject({ ok: false, code: 'no_config' })
  })

  it('maps an FfmpegError to ffmpeg_failed and a download error to audio_failed', async () => {
    const ff = createTranscribeQueue(baseDeps({ extractWav: async () => { throw new FfmpegError('x') } }))
    expect(await ff.enqueue('BV1')).toMatchObject({ ok: false, code: 'ffmpeg_failed' })
    const dl = createTranscribeQueue(baseDeps({ getDashAudioUrl: async () => { throw new Error('net') } }))
    expect(await dl.enqueue('BV1')).toMatchObject({ ok: false, code: 'audio_failed' })
  })

  it('maps a transcription error to asr_failed', async () => {
    const q = createTranscribeQueue(baseDeps({ transcribeWav: async () => { throw new Error('boom') } }))
    expect(await q.enqueue('BV1')).toMatchObject({ ok: false, code: 'asr_failed' })
  })

  it('runs jobs serially (concurrency = 1)', async () => {
    let active = 0
    let maxActive = 0
    const q = createTranscribeQueue(
      baseDeps({
        transcribeWav: async () => {
          active++
          maxActive = Math.max(maxActive, active)
          await new Promise((r) => setTimeout(r, 5))
          active--
          return 't'
        },
      })
    )
    await Promise.all([q.enqueue('A'), q.enqueue('B'), q.enqueue('C')])
    expect(maxActive).toBe(1)
  })
})
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `npm test -- src/main/bilibili/transcribe-queue.test.ts`
Expected: FAIL with "Cannot find module './transcribe-queue'".

- [ ] **Step 3: Write the implementation**

Create `src/main/bilibili/transcribe-queue.ts`:

```ts
// Serial (concurrency=1) in-memory queue that turns a no-subtitle video into a
// summary: dash audio -> wav -> sherpa transcription -> summarize. Each job emits
// stage progress for the renderer. Not persisted: pending jobs are dropped on
// restart (acceptable for a fallback action). Every stage logs with bvid; each
// failure mode maps to a structured BiliTranscribeResult code.
import { createLogger } from '@shared/logger'
import type {
  BiliCredentials,
  BiliSummary,
  BiliTranscribeProgress,
  BiliTranscribeResult,
  BiliTranscribeStage,
  TranscriptionConfig,
} from '@shared/types/bilibili'
import type { ProviderInjection } from '@shared/types/provider'

import { FfmpegError } from './audio'

const log = createLogger({ process: 'main' }).child({ component: 'bilibili-transcribe-queue' })

export type TranscribeQueueDeps = {
  getCredentials: () => Promise<BiliCredentials | null>
  getConfig: () => Promise<TranscriptionConfig | null>
  getInjection: () => ProviderInjection | null
  getMeta: (bvid: string) => { title: string; author: string } | null
  getDashAudioUrl: (c: BiliCredentials, bvid: string) => Promise<string>
  extractWav: (args: {
    audioUrl: string
    c: BiliCredentials
    ffmpegPath: string
    workDir: string
    bvid: string
  }) => Promise<string>
  transcribeWav: (args: { wavPath: string; modelDir: string }) => Promise<string>
  summarize: (
    inj: ProviderInjection,
    input: { bvid: string; title: string; author: string; text: string }
  ) => Promise<BiliSummary>
  workDir: string
  cleanup: (wavPath: string) => Promise<void>
}

export function createTranscribeQueue(deps: TranscribeQueueDeps): {
  enqueue: (bvid: string) => Promise<BiliTranscribeResult>
  onProgress: (cb: (p: BiliTranscribeProgress) => void) => () => void
  dispose: () => void
} {
  const listeners = new Set<(p: BiliTranscribeProgress) => void>()
  const emit = (bvid: string, stage: BiliTranscribeStage): void => {
    for (const l of listeners) l({ bvid, stage })
  }

  // Serial: each job chains off the previous one's settlement.
  let tail: Promise<unknown> = Promise.resolve()

  const enqueue = (bvid: string): Promise<BiliTranscribeResult> => {
    emit(bvid, 'queued')
    log.info({ msg: 'transcribe queued', bvid })
    const run = tail.then(() => runJob(bvid))
    tail = run.catch(() => undefined)
    return run
  }

  async function runJob(bvid: string): Promise<BiliTranscribeResult> {
    const started = Date.now()
    const inj = deps.getInjection()
    if (!inj) {
      emit(bvid, 'failed')
      log.warn({ msg: 'transcribe no provider', bvid })
      return { ok: false, code: 'no_provider', message: '未配置 AI Provider，请在设置中添加。' }
    }
    const cfg = await deps.getConfig()
    if (!cfg) {
      emit(bvid, 'failed')
      log.warn({ msg: 'transcribe no config', bvid })
      return { ok: false, code: 'no_config', message: '未配置本地转写，请在设置中填写 ffmpeg 路径与模型目录。' }
    }
    const c = await deps.getCredentials()
    if (!c) {
      emit(bvid, 'failed')
      log.warn({ msg: 'transcribe no credentials', bvid })
      return { ok: false, code: 'unknown', message: '未登录' }
    }

    let wav: string | null = null
    try {
      emit(bvid, 'audio')
      const audioUrl = await deps.getDashAudioUrl(c, bvid)
      wav = await deps.extractWav({ audioUrl, c, ffmpegPath: cfg.ffmpegPath, workDir: deps.workDir, bvid })
    } catch (err) {
      emit(bvid, 'failed')
      const isFfmpeg = err instanceof FfmpegError
      log.error({ msg: 'transcribe audio stage failed', bvid, ffmpeg: isFfmpeg, err: errMsg(err) })
      return isFfmpeg
        ? { ok: false, code: 'ffmpeg_failed', message: 'ffmpeg 转码失败，请检查 ffmpeg 路径。' }
        : { ok: false, code: 'audio_failed', message: '获取音频失败。' }
    }

    let text: string
    try {
      emit(bvid, 'transcribing')
      text = await deps.transcribeWav({ wavPath: wav, modelDir: cfg.modelDir })
    } catch (err) {
      emit(bvid, 'failed')
      log.error({ msg: 'transcribe asr stage failed', bvid, err: errMsg(err) })
      return { ok: false, code: 'asr_failed', message: '本地转写失败，请检查模型目录。' }
    } finally {
      await deps.cleanup(wav).catch(() => undefined)
    }

    const meta = deps.getMeta(bvid) ?? { title: '', author: '' }
    try {
      emit(bvid, 'summarizing')
      const summary = await deps.summarize(inj, { bvid, ...meta, text })
      emit(bvid, 'done')
      log.info({ msg: 'transcribe ok', bvid, durationMs: Date.now() - started })
      return { ok: true, summary }
    } catch (err) {
      emit(bvid, 'failed')
      log.error({ msg: 'transcribe summarize stage failed', bvid, err: errMsg(err) })
      return { ok: false, code: 'llm_failed', message: 'AI 总结失败，请稍后重试。' }
    }
  }

  return {
    enqueue,
    onProgress(cb): () => void {
      listeners.add(cb)
      return () => listeners.delete(cb)
    },
    dispose(): void {
      listeners.clear()
    },
  }
}

function errMsg(err: unknown): string {
  return err instanceof Error ? err.message : String(err)
}
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `npm test -- src/main/bilibili/transcribe-queue.test.ts`
Expected: PASS (5 tests).

- [ ] **Step 5: Typecheck and commit**

Run: `npm run typecheck:node`
Expected: no errors.

```bash
git add src/main/bilibili/transcribe-queue.ts src/main/bilibili/transcribe-queue.test.ts
git commit -m "feat(bilibili): serial transcription queue chaining audio->asr->summary"
```

---

### Task 6: Add `sherpa-onnx-node` dependency and packaging config

**Files:**
- Modify: `package.json` (dependencies)
- Modify: `electron-builder.yml` (asarUnpack)

**Interfaces:**
- Produces: a runtime-loadable `sherpa-onnx-node` for `defaultRecognizerFactory`.

- [ ] **Step 1: Install the dependency**

Run: `pnpm add sherpa-onnx-node`
Expected: adds `sherpa-onnx-node` to `dependencies` and its platform-specific prebuilt package (e.g. `sherpa-onnx-darwin-arm64`) as an optional dep. No native rebuild (N-API). If postinstall complains, **do not** run `pnpm rebuild`; `npmRebuild: false` is already set in `electron-builder.yml`.

- [ ] **Step 2: Unpack the native module from asar**

In `electron-builder.yml`, extend `asarUnpack`:

```yaml
asarUnpack:
  - resources/**
  - node_modules/sherpa-onnx-node/**
  - node_modules/sherpa-onnx-*/**
```

- [ ] **Step 3: Verify the module loads under the test runtime**

Run: `npm test -- src/main/bilibili/transcribe.test.ts`
Expected: PASS (the unit test injects a fake factory, so it must still pass — this confirms adding the dep didn't break the import graph).

- [ ] **Step 4: Verify typecheck still passes**

Run: `npm run typecheck:node`
Expected: no errors.

- [ ] **Step 5: Commit**

```bash
git add package.json pnpm-lock.yaml electron-builder.yml
git commit -m "build(bilibili): add sherpa-onnx-node dependency and unpack from asar"
```

---

### Task 7: IPC wiring — config handlers, transcribe handler, progress broadcast

**Files:**
- Modify: `src/main/bilibili/ipc.ts`
- Modify: `src/main/bilibili/index.ts`
- Modify: `src/main/bilibili/ipc.test.ts` (add a focused wiring assertion if practical; otherwise no test change — IPC handlers are integration-tested manually, the queue is unit-tested in Task 5)

**Interfaces:**
- Consumes: `createTranscribeQueue` + deps (Tasks 2–5), `paths`, `app` (for `workDir`), `BrowserWindow`.
- Produces IPC channels: `bilibili:getTranscribeConfig`, `bilibili:setTranscribeConfig`, `bilibili:pickModelDir`, `bilibili:transcribe`, and broadcast channel `bilibili:transcribe:progress`.

- [ ] **Step 1: Add a progress channel constant and import the new modules**

At the top of `src/main/bilibili/ipc.ts`, add imports:

```ts
import { promises as fs } from 'node:fs'
import { join } from 'node:path'
import { app, BrowserWindow, dialog, ipcMain, shell } from 'electron'
import type { BiliTranscribeProgress, BiliTranscribeResult, TranscriptionConfig } from '@shared/types/bilibili'

import { defaultAudioDeps, extractWav } from './audio'
import { defaultPlayUrlDeps, getDashAudioUrl } from './playurl'
import { createTranscribeQueue } from './transcribe-queue'
import { transcribeWav } from './transcribe'
```

(Merge the `electron` import with the existing one; remove the now-duplicate `import { dialog, ipcMain, shell } from 'electron'`.)

Add the channel constant near the top:

```ts
export const TRANSCRIBE_PROGRESS_CHANNEL = 'bilibili:transcribe:progress'
```

- [ ] **Step 2: Build the queue and broadcast inside `wireBilibiliIpc`**

Inside `wireBilibiliIpc`, after `const metaIndex = ...`, add:

```ts
  const workDir = join(app.getPath('temp'), 'swarm-bili-asr')

  const broadcast = (p: BiliTranscribeProgress): void => {
    for (const w of BrowserWindow.getAllWindows()) {
      if (!w.isDestroyed()) w.webContents.send(TRANSCRIBE_PROGRESS_CHANNEL, p)
    }
  }

  const queue = createTranscribeQueue({
    getCredentials: async () => (await store.load()).credentials,
    getConfig: async () => (await store.load()).transcription,
    getInjection: opts.getInjection,
    getMeta: (id) => metaIndex.get(id) ?? null,
    getDashAudioUrl: (c, id) => getDashAudioUrl(defaultPlayUrlDeps, c, id),
    extractWav: (a) => extractWav(defaultAudioDeps, a),
    transcribeWav,
    summarize,
    workDir,
    cleanup: (wav) => fs.rm(wav, { force: true }),
  })
  queue.onProgress(broadcast)
```

Ensure `workDir` exists before first use by creating it inside the transcribe handler (Step 3).

- [ ] **Step 3: Add the IPC handlers**

After the existing `bilibili:save` handler, add:

```ts
  ipcMain.handle('bilibili:getTranscribeConfig', async (): Promise<TranscriptionConfig | null> => {
    return (await store.load()).transcription ?? null
  })

  ipcMain.handle('bilibili:setTranscribeConfig', async (_e, cfg: TranscriptionConfig): Promise<void> => {
    const current = await store.load()
    await store.save({ ...current, transcription: cfg })
    log.info({ msg: 'transcribe config saved', ffmpegPath: cfg.ffmpegPath, modelDir: cfg.modelDir })
  })

  ipcMain.handle('bilibili:pickModelDir', async (): Promise<string | null> => {
    const r = await dialog.showOpenDialog({ properties: ['openDirectory'] })
    return r.canceled || r.filePaths.length === 0 ? null : r.filePaths[0]
  })

  ipcMain.handle('bilibili:transcribe', async (_e, bvid: string): Promise<BiliTranscribeResult> => {
    await fs.mkdir(workDir, { recursive: true })
    log.info({ msg: 'transcribe requested', bvid })
    return queue.enqueue(bvid)
  })
```

- [ ] **Step 4: Add the new channels to `dispose` and dispose the queue**

In the `dispose` channel list, add the four new `ipcMain` channels:

```ts
        'bilibili:getTranscribeConfig',
        'bilibili:setTranscribeConfig',
        'bilibili:pickModelDir',
        'bilibili:transcribe',
```

And before the loop / at the end of `dispose()`, add `queue.dispose()`.

- [ ] **Step 5: Verify existing IPC tests still pass and typecheck**

Run: `npm test -- src/main/bilibili/ipc.test.ts`
Expected: PASS (unchanged — `buildList`/`openVideo` behavior is untouched).

Run: `npm run typecheck:node`
Expected: no errors.

- [ ] **Step 6: Commit**

```bash
git add src/main/bilibili/ipc.ts src/main/bilibili/index.ts
git commit -m "feat(bilibili): IPC for transcribe config, queue, and progress broadcast"
```

---

### Task 8: Preload bridge, shared bridge type, and renderer api wrappers

**Files:**
- Modify: `src/shared/types/ui.ts` (`BilibiliBridge`)
- Modify: `src/preload/index.ts` (`bilibili` bridge object)
- Modify: `src/renderer/src/lib/api.ts` (`swarmApi` wrappers)

**Interfaces:**
- Consumes: channels from Task 7.
- Produces on `window.swarm.bilibili`: `getTranscribeConfig`, `setTranscribeConfig`, `pickModelDir`, `transcribe`, `onTranscribeProgress`. And `swarmApi` wrappers used by the UI.

- [ ] **Step 1: Extend the `BilibiliBridge` type**

In `src/shared/types/ui.ts`, add to `BilibiliBridge` (after `save`):

```ts
  getTranscribeConfig: () => Promise<TranscriptionConfig | null>
  setTranscribeConfig: (cfg: TranscriptionConfig) => Promise<void>
  pickModelDir: () => Promise<string | null>
  transcribe: (bvid: string) => Promise<BiliTranscribeResult>
  onTranscribeProgress: (cb: (p: BiliTranscribeProgress) => void) => () => void
```

Add the needed imports to the type file's existing bilibili type import:

```ts
import type {
  // ...existing...
  BiliTranscribeProgress,
  BiliTranscribeResult,
  TranscriptionConfig,
} from './bilibili'
```

(If `ui.ts` imports bilibili types inline, add these names there.)

- [ ] **Step 2: Implement the preload bridge methods**

In `src/preload/index.ts`, add the channel constant near the other channel constants:

```ts
const TRANSCRIBE_PROGRESS_CHANNEL = 'bilibili:transcribe:progress'
```

Add to the `bilibili` object (after `save`):

```ts
  getTranscribeConfig: () =>
    ipcRenderer.invoke('bilibili:getTranscribeConfig') as Promise<TranscriptionConfig | null>,
  setTranscribeConfig: (cfg: TranscriptionConfig) =>
    ipcRenderer.invoke('bilibili:setTranscribeConfig', cfg) as Promise<void>,
  pickModelDir: () => ipcRenderer.invoke('bilibili:pickModelDir') as Promise<string | null>,
  transcribe: (bvid: string) => ipcRenderer.invoke('bilibili:transcribe', bvid) as Promise<BiliTranscribeResult>,
  onTranscribeProgress: (cb: (p: BiliTranscribeProgress) => void) => {
    const listener = (_e: unknown, p: BiliTranscribeProgress): void => cb(p)
    ipcRenderer.on(TRANSCRIBE_PROGRESS_CHANNEL, listener)
    return () => {
      ipcRenderer.removeListener(TRANSCRIBE_PROGRESS_CHANNEL, listener)
    }
  },
```

Add the type imports at the top of `src/preload/index.ts` (extend the existing bilibili import):

```ts
import type { BiliTranscribeProgress, BiliTranscribeResult, TranscriptionConfig } from '../shared/types/bilibili'
```

- [ ] **Step 3: Add `swarmApi` wrappers**

In `src/renderer/src/lib/api.ts`, extend the import and add wrappers after `bilibiliSave`:

```ts
import type {
  // ...existing...
  BiliTranscribeProgress,
  BiliTranscribeResult,
  TranscriptionConfig,
} from '@shared/types/bilibili'
```

```ts
  bilibiliGetTranscribeConfig: (): Promise<TranscriptionConfig | null> =>
    window.swarm.bilibili.getTranscribeConfig(),
  bilibiliSetTranscribeConfig: (cfg: TranscriptionConfig): Promise<void> =>
    window.swarm.bilibili.setTranscribeConfig(cfg),
  bilibiliPickModelDir: (): Promise<string | null> => window.swarm.bilibili.pickModelDir(),
  bilibiliTranscribe: (bvid: string): Promise<BiliTranscribeResult> => window.swarm.bilibili.transcribe(bvid),
  bilibiliOnTranscribeProgress: (cb: (p: BiliTranscribeProgress) => void): (() => void) =>
    window.swarm.bilibili.onTranscribeProgress(cb),
```

- [ ] **Step 4: Typecheck both projects**

Run: `npm run typecheck`
Expected: no errors (node + web).

- [ ] **Step 5: Commit**

```bash
git add src/shared/types/ui.ts src/preload/index.ts src/renderer/src/lib/api.ts
git commit -m "feat(bilibili): preload bridge and api wrappers for transcription"
```

---

### Task 9: Settings UI — "本地转写 (ASR)" section

**Files:**
- Modify: `src/renderer/src/components/views/bilibili-settings-view.tsx`
- Test: `src/renderer/src/components/views/bilibili-settings-view.test.tsx`

**Interfaces:**
- Consumes: `swarmApi.bilibiliGetTranscribeConfig/SetTranscribeConfig/PickModelDir` (Task 8).

- [ ] **Step 1: Read the existing settings view to match its form patterns**

Run: `sed -n '1,80p' src/renderer/src/components/views/bilibili-settings-view.tsx`
Note how the Obsidian section reads config via TanStack Query, edits local state, and saves — mirror it exactly for the transcription section (two text inputs: ffmpeg path, model dir; a "选择目录" button calling `bilibiliPickModelDir`; a "保存" button calling `bilibiliSetTranscribeConfig`).

- [ ] **Step 2: Write the failing test**

In `src/renderer/src/components/views/bilibili-settings-view.test.tsx`, add a test asserting the section renders and saving calls the API. Mirror the existing Obsidian test's mocking of `swarmApi`. Example skeleton (adapt mocks to the file's existing setup):

```ts
it('saves the transcription config (ffmpeg path + model dir)', async () => {
  const setCfg = vi.spyOn(swarmApi, 'bilibiliSetTranscribeConfig').mockResolvedValue()
  vi.spyOn(swarmApi, 'bilibiliGetTranscribeConfig').mockResolvedValue(null)
  render(<BilibiliSettingsView />)
  await userEvent.type(await screen.findByLabelText('ffmpeg 路径'), '/usr/bin/ffmpeg')
  await userEvent.type(screen.getByLabelText('模型目录'), '/models/sv')
  await userEvent.click(screen.getByRole('button', { name: '保存转写配置' }))
  expect(setCfg).toHaveBeenCalledWith({ ffmpegPath: '/usr/bin/ffmpeg', modelDir: '/models/sv' })
})
```

- [ ] **Step 3: Run the test to verify it fails**

Run: `npm test -- src/renderer/src/components/views/bilibili-settings-view.test.tsx`
Expected: FAIL (no such inputs/button yet).

- [ ] **Step 4: Implement the section**

Add a "本地转写 (ASR)" section to `bilibili-settings-view.tsx` mirroring the Obsidian section: a `useQuery` for `bilibiliGetTranscribeConfig`, local `ffmpegPath`/`modelDir` state seeded from it, labeled inputs (`ffmpeg 路径`, `模型目录`), a "选择目录" button that sets `modelDir` from `bilibiliPickModelDir()`, and a "保存转写配置" button calling `bilibiliSetTranscribeConfig({ ffmpegPath, modelDir })`. Include a one-line hint: 模型需自行下载 SenseVoice 后填写其所在目录.

- [ ] **Step 5: Run the test to verify it passes**

Run: `npm test -- src/renderer/src/components/views/bilibili-settings-view.test.tsx`
Expected: PASS.

- [ ] **Step 6: Typecheck and commit**

Run: `npm run typecheck:web`
Expected: no errors.

```bash
git add src/renderer/src/components/views/bilibili-settings-view.tsx src/renderer/src/components/views/bilibili-settings-view.test.tsx
git commit -m "feat(bilibili): settings section for local transcription (ffmpeg + model dir)"
```

---

### Task 10: Detail panel — "本地转写" button on no-subtitle + progress

**Files:**
- Modify: `src/renderer/src/components/views/bilibili-view.tsx`
- Test: `src/renderer/src/components/views/bilibili-view.test.tsx`

**Interfaces:**
- Consumes: `swarmApi.bilibiliTranscribe`, `swarmApi.bilibiliOnTranscribeProgress` (Task 8); reuses `SummaryView` and the save flow.

- [ ] **Step 1: Write the failing test**

In `src/renderer/src/components/views/bilibili-view.test.tsx`, add a test: when `bilibiliProcess` resolves `{ ok: false, code: 'no_subtitle' }`, a "本地转写" button appears; clicking it calls `bilibiliTranscribe` and, on `{ ok: true, summary }`, renders the summary. Mirror the existing detail-panel test's setup. Skeleton:

```ts
it('offers local transcription when the video has no subtitle', async () => {
  vi.spyOn(swarmApi, 'bilibiliProcess').mockResolvedValue({ ok: false, code: 'no_subtitle', message: '无字幕' })
  const transcribe = vi
    .spyOn(swarmApi, 'bilibiliTranscribe')
    .mockResolvedValue({ ok: true, summary: { gist: 'g', points: [], experience: [], pitfalls: [], steps: [] } })
  vi.spyOn(swarmApi, 'bilibiliOnTranscribeProgress').mockReturnValue(() => {})
  // ...open a video card, click 'AI 分析'...
  await userEvent.click(await screen.findByRole('button', { name: '本地转写' }))
  expect(transcribe).toHaveBeenCalled()
  expect(await screen.findByText('g')).toBeInTheDocument()
})
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `npm test -- src/renderer/src/components/views/bilibili-view.test.tsx`
Expected: FAIL (no "本地转写" button).

- [ ] **Step 3: Implement in `VideoDetailSheet`**

Add a transcription mutation and progress state alongside the existing `mutation`:

```tsx
  const [stage, setStage] = useState<string | null>(null)
  const transcribeMutation = useMutation({ mutationFn: (bvid: string) => swarmApi.bilibiliTranscribe(bvid) })

  // Subscribe to transcription progress only while this sheet is mounted.
  useEffect(() => {
    const off = swarmApi.bilibiliOnTranscribeProgress((p) => {
      if (p.bvid === video?.bvid) setStage(p.stage)
    })
    return off
  }, [video?.bvid])
```

Reset `transcribeMutation` and `setStage(null)` in the existing bvid-change reset effect.

Where the error message renders (`mutation.data && !mutation.data.ok`), special-case `no_subtitle` to show the button + progress instead of a bare error:

```tsx
{mutation.data && !mutation.data.ok && mutation.data.code === 'no_subtitle' ? (
  <div className="flex flex-col gap-1">
    <Button
      className="w-fit"
      disabled={transcribeMutation.isPending}
      onClick={() => video && transcribeMutation.mutate(video.bvid)}
      variant="outline"
    >
      {transcribeMutation.isPending ? `转写中…${stage ? ` (${stage})` : ''}` : '本地转写'}
    </Button>
    <span className="text-muted-foreground text-xs">该视频无字幕，可下载音轨本地转写（需在设置中配置）。</span>
  </div>
) : null}
```

Render the transcription result reusing `SummaryView` + the Obsidian save block (extract the summary+save JSX so both the subtitle path and the transcription path render it, or duplicate the small block). Show `transcribeMutation.data.message` when `!ok`.

- [ ] **Step 4: Run the test to verify it passes**

Run: `npm test -- src/renderer/src/components/views/bilibili-view.test.tsx`
Expected: PASS.

- [ ] **Step 5: Typecheck and commit**

Run: `npm run typecheck:web`
Expected: no errors.

```bash
git add src/renderer/src/components/views/bilibili-view.tsx src/renderer/src/components/views/bilibili-view.test.tsx
git commit -m "feat(bilibili): local transcription button and progress in detail panel"
```

---

### Task 11: Full verification

- [ ] **Step 1: Run the whole verify suite**

Run: `pnpm run verify`
Expected: typecheck + lint + all tests pass + native-feel check passes. Fix any fallout (lint/format) before proceeding.

- [ ] **Step 2: Manual smoke (requires user-provided model + ffmpeg)**

Document for the user: install ffmpeg (`brew install ffmpeg`), download a SenseVoice sherpa-onnx model, set both paths in Bilibili Settings → 本地转写. Then open a no-subtitle video → AI 分析 → 本地转写, and confirm a summary appears and the log file shows the `audio → transcribing → summarizing → done` stages.

- [ ] **Step 3: Final commit if any verify fixups were made**

```bash
git add -A
git commit -m "chore(bilibili): verify fixups for transcription fallback"
```

---

## Self-Review

**Spec coverage:**
- Trigger = explicit button → Task 10. ✓
- sherpa bundled + ffmpeg system/configurable → Tasks 4, 6, 3. ✓
- Model user-downloaded + path configured → Tasks 1, 9. ✓
- In-memory serial queue (concurrency 1), not persisted, progress events → Task 5 (+ broadcast Task 7). ✓
- Lowest-bitrate audio selection → Task 2. ✓
- Modules playurl/audio/transcribe/queue → Tasks 2–5. ✓
- Config schema `transcription` → Task 1. ✓
- Settings UI → Task 9. ✓
- IPC channels (4 + progress) → Task 7; preload/api → Task 8. ✓
- Error codes `no_config/audio_failed/ffmpeg_failed/asr_failed/llm_failed` → Tasks 1 (types), 5 (mapping). ✓
- asarUnpack → Task 6. ✓
- Tests for playurl/audio/transcribe/queue/UI → Tasks 2–5, 9, 10. ✓
- Out of scope (no persistence, no auto-transcribe, no ffmpeg bundling, first-page only) → respected. ✓

**Placeholder scan:** Tasks 9 and 10 reference "mirror the existing section/test" rather than reproducing every line of the large existing view files — this is deliberate (the implementer must follow the established Obsidian-section pattern in the same file), and the new behavior (labels, button names, API calls, code blocks) is given concretely. No `TBD`/`TODO`.

**Type consistency:** `BiliTranscribeResult` / `BiliTranscribeProgress` / `BiliTranscribeStage` / `TranscriptionConfig` defined in Task 1 are used verbatim in Tasks 5, 7, 8, 9, 10. `extractWav(deps, args)` signature consistent (Task 3 def → Task 7 call wraps as `(a) => extractWav(defaultAudioDeps, a)`). `transcribeWav(args, factory?)` — Task 7 passes `transcribeWav` directly (queue calls it with `{ wavPath, modelDir }`, factory defaults). `getDashAudioUrl(deps, c, bvid)` consistent (Task 2 → Task 7). Queue's `enqueue` returns `Promise<BiliTranscribeResult>` used by the IPC handler and the renderer mutation. ✓
