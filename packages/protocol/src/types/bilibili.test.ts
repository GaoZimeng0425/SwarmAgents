import { describe, expect, it } from 'vitest'

import { BiliAnalysisSchema, BilibiliConfigOnDisk, defaultBilibiliConfigOnDisk } from './bilibili'

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

describe('BilibiliConfigOnDisk', () => {
  it('defaults to null credentials', () => {
    expect(defaultBilibiliConfigOnDisk()).toEqual({ credentials: null, obsidian: null, transcription: null })
  })

  it('accepts a valid credentials object', () => {
    const r = BilibiliConfigOnDisk.safeParse({
      credentials: { sessdata: 'a', biliJct: 'b', dedeUserId: '123' },
    })
    expect(r.success).toBe(true)
  })

  it('rejects unknown top-level keys', () => {
    const r = BilibiliConfigOnDisk.safeParse({ credentials: null, extra: 1 })
    expect(r.success).toBe(false)
  })
})
