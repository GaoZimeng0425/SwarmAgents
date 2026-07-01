import type { BiliCredentials } from '@swarm/protocol'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { getSubtitleText } from './subtitle'

const CRED: BiliCredentials = { sessdata: 's', biliJct: 'j', dedeUserId: 'u' }
const DEPS = {
  getWbiKeys: async () => ({ imgKey: 'a'.repeat(32), subKey: 'b'.repeat(32) }),
  getCid: async () => 999,
  nowSec: () => 1700000000,
}

afterEach(() => vi.restoreAllMocks())

describe('getSubtitleText', () => {
  it('returns null when the player response has no subtitle entries', async () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(
      new Response(JSON.stringify({ code: 0, data: { subtitle: { subtitles: [] } } }))
    )
    expect(await getSubtitleText(DEPS, CRED, 'BV1')).toBeNull()
  })

  it('fetches the first subtitle JSON and joins its body content', async () => {
    const fetchMock = vi
      .spyOn(globalThis, 'fetch')
      .mockResolvedValueOnce(
        new Response(
          JSON.stringify({
            code: 0,
            data: { subtitle: { subtitles: [{ subtitle_url: '//aisubtitle.hdslb.com/x.json', lan: 'ai-zh' }] } },
          })
        )
      )
      .mockResolvedValueOnce(
        new Response(JSON.stringify({ body: [{ content: '第一句' }, { content: '第二句' }] }))
      )
    const text = await getSubtitleText(DEPS, CRED, 'BV1')
    expect(text).toBe('第一句\n第二句')
    // second fetch must be upgraded to https
    expect(String(fetchMock.mock.calls[1][0])).toBe('https://aisubtitle.hdslb.com/x.json')
  })
})
