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
