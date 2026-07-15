// Serial (concurrency=1) in-memory queue that turns a no-subtitle video into a
// summary: dash audio -> wav -> sherpa transcription -> summarize. Each job emits
// stage progress for the renderer. Not persisted: pending jobs are dropped on
// restart (acceptable for a fallback action). Every stage logs with bvid; each
// failure mode maps to a structured BiliTranscribeResult code.
import { createLogger } from '@shared/logger'
import type {
  BiliAnalysisSource,
  BiliCredentials,
  BiliTranscribeProgress,
  BiliTranscribeResult,
  BiliTranscribeStage,
  ProviderInjection,
  TranscriptionConfig,
} from '@swarm/protocol'

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
  triggerAnalyze: (
    inj: ProviderInjection,
    input: { bvid: string; title: string; author: string; text: string; source: BiliAnalysisSource }
  ) => Promise<void>
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
      // Best-effort temp cleanup: a failure here must not fail the job, but log it
      // so a leaking temp dir is diagnosable.
      await deps.cleanup(wav).catch((err) => {
        log.warn({ msg: 'transcribe wav cleanup failed', bvid, err: errMsg(err) })
      })
    }

    const meta = deps.getMeta(bvid) ?? { title: '', author: '' }
    try {
      emit(bvid, 'summarizing')
      await deps.triggerAnalyze(inj, { bvid, ...meta, text, source: 'transcript' })
      emit(bvid, 'done')
      log.info({ msg: 'transcribe ok', bvid, durationMs: Date.now() - started })
      return { ok: true, text, source: 'transcript' }
    } catch (err) {
      emit(bvid, 'failed')
      log.error({ msg: 'transcribe analyze stage failed', bvid, err: errMsg(err) })
      return { ok: false, code: 'llm_failed', message: 'AI 总结失败，请稍后重试。' }
    }
  }

  return {
    enqueue,
    onProgress(cb): () => void {
      listeners.add(cb)
      return () => {
        listeners.delete(cb)
      }
    },
    dispose(): void {
      listeners.clear()
    },
  }
}

function errMsg(err: unknown): string {
  return err instanceof Error ? err.message : String(err)
}
