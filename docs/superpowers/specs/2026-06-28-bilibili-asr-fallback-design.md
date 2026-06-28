# Milestone C — Bilibili No-Subtitle Local Transcription Fallback

Date: 2026-06-28
Branch: `worktree-bilibili-asr-fallback`
Status: Design approved, pending implementation plan.

## Problem

The Bilibili pipeline currently summarizes a video from its subtitle track. When a
video has no subtitle, `processVideo` returns a structured `no_subtitle` result and
stops (`src/main/bilibili/pipeline.ts` — comment "ASR fallback is milestone C").

Milestone C adds a local speech-to-text fallback: pull the video's DASH audio track,
transcode it to WAV with ffmpeg, transcribe it locally with sherpa-onnx (SenseVoice),
and feed the resulting text into the existing summarization stage — producing the same
`BiliSummary` the subtitle path produces.

## Decisions (locked)

- **Trigger**: explicit button, not auto. When `bilibili:process` returns `no_subtitle`,
  the detail panel shows a "本地转写" (Local transcription) button. Transcription is
  expensive (minutes, CPU-bound); the user opts in per video.
- **Dependency strategy**: `sherpa-onnx-node` bundled (N-API prebuilt, ABI-stable across
  Electron — no electron-rebuild). ffmpeg is the **system binary** at a user-configurable
  path — no npm dependency for ffmpeg.
- **Model**: the SenseVoice model (hundreds of MB) is downloaded by the user and its
  directory configured in Settings. Not bundled, not auto-downloaded.
- **Queue**: in-memory FIFO, **concurrency = 1**, not persisted to disk. A "formal queue"
  here means stateful + serialized + observable (progress events), as opposed to the
  existing single-flight map. Pending jobs are dropped on app restart — acceptable for a
  fallback action; resuming a half-finished ffmpeg/ASR job across restarts is out of scope.
- **Audio track selection**: pick the **lowest-bitrate** DASH audio track. ASR does not
  benefit from high bitrate; lower bitrate saves download time and bandwidth.

## Architecture

New modules under `src/main/bilibili/`, each deps-injected and unit-testable in the style
of the existing `subtitle.ts`:

### `playurl.ts`
`getDashAudioUrl(deps, c, bvid): Promise<string>`
- WBI-signs and calls `/x/player/wbi/playurl?fnval=16&...` (fnval=16 requests DASH).
- Reads `dash.audio[]`, selects the entry with the lowest `bandwidth`, returns its URL
  (https-normalized via `toHttpsUrl`).
- `deps`: `{ getWbiKeys, getCid, nowSec }` — same shape as `SubtitleDeps`.
- Logs entry/outcome/catch with `bvid`.

### `audio.ts`
`extractWav({ audioUrl, c, ffmpegPath, workDir }): Promise<string>`
- Downloads the audio m4s to a temp file in `workDir` using `fetch` with the Bilibili
  cookie + UA + Referer headers (the CDN requires them).
- Spawns the system ffmpeg at `ffmpegPath` to transcode to `16 kHz / mono / PCM s16le WAV`
  (sherpa-onnx offline recognizer input requirement).
- Returns the WAV path; removes the intermediate m4s.
- The caller (queue) removes the WAV after transcription. Logs entry/outcome/catch.

### `transcribe.ts`
`transcribeWav({ wavPath, modelDir }): Promise<string>`
- Lazily `require`s `sherpa-onnx-node` (main process only; never imported by renderer).
- Builds a SenseVoice `OfflineRecognizer` from files in `modelDir`, **cached as a singleton
  keyed by `modelDir`** so the multi-hundred-MB model loads once, not per request.
- Decodes the WAV and returns the recognized text. Logs entry/outcome/catch.
- The sherpa module / recognizer factory is injectable so unit tests never load real native
  binaries or models.

### `transcribe-queue.ts`
`createTranscribeQueue(deps): { enqueue(bvid): void; onProgress(cb): void; getState(): JobState[]; dispose(): void }`
- In-memory FIFO, concurrency = 1.
- Per-job state machine: `queued → audio → transcribing → summarizing → done | failed`.
- Emits a progress event on every transition (consumed by IPC → renderer).
- Job pipeline: `getDashAudioUrl → extractWav → transcribeWav → summarize → BiliSummary`,
  then temp-file cleanup. Each stage logs with `bvid`.
- `deps` injects the four module functions + `summarize` + `getInjection` + `getMeta` +
  config/credentials accessors, so the queue is unit-testable without network/ffmpeg/sherpa.

## Config & Settings

### Schema (`src/shared/types/bilibili.ts`)
Add to `BilibiliConfigOnDisk`:
```ts
transcription: z
  .object({ ffmpegPath: z.string(), modelDir: z.string() })
  .strict()
  .nullable()
  .default(null)
```
Add `TranscriptionConfig` type + `defaultBilibiliConfigOnDisk()` returns `transcription: null`.

### Settings UI (`bilibili-settings-view.tsx`)
New "本地转写 (ASR)" section:
- ffmpeg path: text input (with a folder/file picker via dialog).
- Model directory: directory picker (reuses the `pickVault` dialog pattern).
- Persists through the encrypted store.

## IPC (`ipc.ts`)
New handlers, registered and disposed alongside the existing ones:
- `bilibili:getTranscribeConfig` → `TranscriptionConfig | null`
- `bilibili:setTranscribeConfig` (cfg) → void
- `bilibili:pickModelDir` → `string | null` (directory dialog)
- `bilibili:transcribe` (bvid) → enqueues a job; returns immediately (or joins if queued)
- `bilibili:transcribe:progress` → event channel pushing `JobState[]` / per-job updates to
  the renderer

The transcription job's terminal success reuses the **same** `summarize` call and yields a
`BiliSummary`, so the detail panel and Obsidian-save flow are unchanged.

## Result types & error handling

Structured result codes, every `catch` logged at `error` with `bvid`:
- `no_config` — ffmpegPath or modelDir not set → UI directs the user to Settings.
- `audio_failed` — playurl fetch or m4s download failed.
- `ffmpeg_failed` — ffmpeg missing or non-zero exit.
- `asr_failed` — sherpa transcription failed.
- `llm_failed` — reused from the existing summarize stage.

Extend the result/union types accordingly (a transcription-specific result type carrying the
job state + final `BiliSummary` or an error code).

## Packaging

- Add `sherpa-onnx-node` to `dependencies`. It ships per-platform prebuilt binaries as
  optional deps (`*-darwin-arm64`, etc.); N-API means no electron-rebuild is required.
- Add `sherpa-onnx-node` (and its `.node`/`.dylib` assets) to electron-builder `asarUnpack`
  so the native libraries are loadable at runtime.
- ffmpeg: system binary, configurable path — no bundling.

## Testing (TDD)

- `playurl.test.ts` — mock `get`; assert the WBI query is signed and the lowest-bandwidth
  audio track is selected.
- `audio.test.ts` — mock `fetch` + `spawn`; assert ffmpeg args produce 16 kHz mono WAV and
  the intermediate m4s is cleaned up.
- `transcribe.test.ts` — inject a fake recognizer factory; assert text extraction and that
  the recognizer is cached per `modelDir`.
- `transcribe-queue.test.ts` — assert FIFO order, concurrency = 1, progress emission on each
  transition, and each failure mode maps to the right code.
- Pipeline integration — transcription text flows into `summarize` and yields a `BiliSummary`.

Real sherpa inference and real ffmpeg are out of unit-test scope (covered by injection);
end-to-end verification requires the user-downloaded model + system ffmpeg.

## Out of scope

- Persisting queue state across restarts.
- Auto-transcription without an explicit click.
- Bundling ffmpeg or auto-downloading the SenseVoice model.
- Multi-page (multi-cid) videos — first page only, matching the existing subtitle path.
