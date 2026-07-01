import type { BiliCredentials } from '@swarm/protocol'
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
