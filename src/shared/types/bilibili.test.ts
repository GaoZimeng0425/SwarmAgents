import { describe, expect, it } from 'vitest'
import { BilibiliConfigOnDisk, defaultBilibiliConfigOnDisk } from './bilibili'

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
