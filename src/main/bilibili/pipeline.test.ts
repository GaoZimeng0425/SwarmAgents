import type { BiliCredentials } from '@shared/types/bilibili'
import { describe, expect, it } from 'vitest'
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
    expect(r).toEqual({
      ok: true,
      summary: { gist: 'g', points: [], experience: [], pitfalls: [], steps: [] },
      text: '字幕文本',
      source: 'subtitle',
    })
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
