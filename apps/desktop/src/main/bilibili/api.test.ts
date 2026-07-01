import { afterEach, describe, expect, it, vi } from 'vitest'

import { cookieHeader, getFavFolders, getNav, getWatchLater, toHttpsUrl } from './api'

const creds = { sessdata: 's', biliJct: 'j', dedeUserId: '42' }

afterEach(() => vi.unstubAllGlobals())

function mockJson(body: unknown): void {
  vi.stubGlobal(
    'fetch',
    vi.fn(async () => new Response(JSON.stringify(body), { status: 200 }))
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
    mockJson({ code: 0, data: { list: [{ id: 99, title: 'CS', media_count: 7 }] } })
    expect(await getFavFolders(creds, 42)).toEqual([{ id: 99, title: 'CS', count: 7 }])
  })

  it('returns [] when data.list is null', async () => {
    mockJson({ code: 0, data: { list: null } })
    expect(await getFavFolders(creds, 42)).toEqual([])
  })

  it('throws on non-zero code', async () => {
    mockJson({ code: -400, message: 'bad request' })
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

describe('toHttpsUrl', () => {
  it('upgrades http URLs to https', () => {
    expect(toHttpsUrl('http://i2.hdslb.com/bfs/a.jpg')).toBe('https://i2.hdslb.com/bfs/a.jpg')
  })

  it('leaves https and other URLs unchanged', () => {
    expect(toHttpsUrl('https://i0.hdslb.com/x.jpg')).toBe('https://i0.hdslb.com/x.jpg')
    expect(toHttpsUrl('')).toBe('')
  })
})
