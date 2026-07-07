import { afterEach, describe, expect, it, vi } from 'vitest'

import { cookieHeader, deleteWatchLater, getFavFolders, getNav, getWatchLater, toHttpsUrl } from './api'

const creds = { sessdata: 's', biliJct: 'j', dedeUserId: '42' }

// A nav payload carrying wbi keys; getFavFolders/getFavResources fetch this
// first (via getWbiKeys) before their own signed request.
const NAV_WITH_WBI = {
  code: 0,
  data: {
    wbi_img: {
      img_url: 'https://i0.hdslb.com/bfs/7eaa1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1.png',
      sub_url: 'https://i0.hdslb.com/bfs/8bb16e9c9c9c9c9c9c9c9c9c9c9c9c9c9c9c9c9c.png',
    },
  },
}

afterEach(() => vi.unstubAllGlobals())

function mockJson(body: unknown): void {
  vi.stubGlobal(
    'fetch',
    vi.fn(async () => new Response(JSON.stringify(body), { status: 200 }))
  )
}

// Stubs fetch to return the nav (wbi keys) first, then `body` for the real call.
// Use this for endpoints that sign with wbi (getFavFolders, getFavResources).
function mockJsonWithWbi(body: unknown): void {
  const responses = [
    new Response(JSON.stringify(NAV_WITH_WBI), { status: 200 }),
    new Response(JSON.stringify(body), { status: 200 }),
  ]
  vi.stubGlobal(
    'fetch',
    vi.fn(async () => responses.shift() as Response)
  )
}

describe('cookieHeader', () => {
  it('serializes the three required cookies', () => {
    expect(cookieHeader(creds)).toBe('SESSDATA=s; bili_jct=j; DedeUserID=42')
  })
})

describe('getNav', () => {
  it('maps logged-in nav payload', async () => {
    mockJson({ code: 0, data: { isLogin: true, uname: 'me', mid: 42 } })
    expect(await getNav(creds)).toEqual({ loggedIn: true, uname: 'me', mid: 42 })
  })

  it('reports logged-out when code is -101', async () => {
    mockJson({ code: -101, message: 'not logged in', data: { isLogin: false } })
    expect(await getNav(creds)).toEqual({ loggedIn: false, uname: null, mid: null })
  })
})

describe('getFavFolders', () => {
  it('maps folder list', async () => {
    mockJsonWithWbi({ code: 0, data: { list: [{ id: 99, title: 'CS', media_count: 7 }] } })
    expect(await getFavFolders(creds, 42)).toEqual([{ id: 99, title: 'CS', count: 7 }])
  })

  it('returns [] when data.list is null', async () => {
    mockJsonWithWbi({ code: 0, data: { list: null } })
    expect(await getFavFolders(creds, 42)).toEqual([])
  })

  it('throws on non-zero code', async () => {
    mockJsonWithWbi({ code: -400, message: 'bad request' })
    await expect(getFavFolders(creds, 42)).rejects.toThrow(/-400/)
  })
})

describe('getWatchLater', () => {
  it('maps toview list to BiliVideo', async () => {
    mockJson({
      code: 0,
      data: {
        list: [
          {
            bvid: 'BV1',
            title: 'T',
            pic: 'http://img',
            duration: 600,
            owner: { name: 'up' },
            desc: 'hello',
          },
        ],
      },
    })
    expect(await getWatchLater(creds)).toEqual([
      {
        bvid: 'BV1',
        title: 'T',
        cover: 'https://img',
        author: 'up',
        durationSec: 600,
        intro: 'hello',
        source: '稍后再看',
      },
    ])
  })
})

describe('deleteWatchLater', () => {
  it('resolves the aid from bvid and posts aid (not bvid) to toview/del', async () => {
    const calls: { url: string; body?: string }[] = []
    vi.stubGlobal(
      'fetch',
      vi.fn(async (url: string, init?: RequestInit) => {
        calls.push({ url, body: init?.body as string | undefined })
        // First call resolves the aid; second is the delete.
        if (url.includes('/web-interface/view')) {
          return new Response(JSON.stringify({ code: 0, data: { aid: 12345 } }), { status: 200 })
        }
        return new Response(JSON.stringify({ code: 0, data: {} }), { status: 200 })
      })
    )
    await deleteWatchLater(creds, 'BV1zRKD6FEBq')
    const del = calls.find((c) => c.url.includes('/toview/del'))
    expect(del?.body).toContain('aid=12345')
    expect(del?.body).not.toContain('bvid')
    expect(del?.body).toContain('csrf=j')
  })
})

describe('toHttpsUrl', () => {
  it('upgrades http URLs to https', () => {
    expect(toHttpsUrl('http://i2.hdslb.com/bfs/a.jpg')).toBe('https://i2.hdslb.com/bfs/a.jpg')
  })

  it('leaves https and other URLs unchanged', () => {
    expect(toHttpsUrl('https://i0.hdslb.com/x.jpg')).toBe('https://i0.hdslb.com/x.jpg')
    expect(toHttpsUrl('')).toBe('')
  })
})
