import type {
  BiliCredentials,
  BiliSummary,
  BiliTranscribeProgress,
  ProviderInjection,
  TranscriptionConfig,
} from '@swarm/protocol'
import { describe, expect, it } from 'vitest'

import { FfmpegError } from './audio'
import { createTranscribeQueue, type TranscribeQueueDeps } from './transcribe-queue'

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
    expect(res).toEqual({ ok: true, summary: SUMMARY, text: '转写文本', source: 'transcript' })
    expect(stages).toEqual(['queued', 'audio', 'transcribing', 'summarizing', 'done'])
  })

  it('returns no_config when transcription is not configured', async () => {
    const q = createTranscribeQueue(baseDeps({ getConfig: async () => null }))
    expect(await q.enqueue('BV1')).toMatchObject({ ok: false, code: 'no_config' })
  })

  it('maps an FfmpegError to ffmpeg_failed and a download error to audio_failed', async () => {
    const ff = createTranscribeQueue(
      baseDeps({
        extractWav: async () => {
          throw new FfmpegError('x')
        },
      })
    )
    expect(await ff.enqueue('BV1')).toMatchObject({ ok: false, code: 'ffmpeg_failed' })
    const dl = createTranscribeQueue(
      baseDeps({
        getDashAudioUrl: async () => {
          throw new Error('net')
        },
      })
    )
    expect(await dl.enqueue('BV1')).toMatchObject({ ok: false, code: 'audio_failed' })
  })

  it('maps a transcription error to asr_failed', async () => {
    const q = createTranscribeQueue(
      baseDeps({
        transcribeWav: async () => {
          throw new Error('boom')
        },
      })
    )
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
