import { describe, expect, it, vi } from 'vitest'

import type { Auth } from './auth'
import { buildList, openVideo, wireBilibiliIpc } from './ipc'
import type { Store } from './store'

// ipcMain mock: capture registered handlers by channel name.
vi.mock('electron', () => {
  const handlers = new Map<string, Function>()
  return {
    ipcMain: {
      handle: (ch: string, fn: Function) => {
        handlers.set(ch, fn)
      },
      removeHandler: (ch: string) => {
        handlers.delete(ch)
      },
      _handlers: handlers,
    },
  }
})

// Helper: invoke a captured ipcMain handler by channel name.
async function invokeHandler(channel: string, ...args: unknown[]): Promise<unknown> {
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const { ipcMain } = await import('electron')
  const fn = (ipcMain as unknown as { _handlers: Map<string, Function> })._handlers.get(channel)
  if (!fn) throw new Error(`No handler registered for '${channel}'`)
  return fn({} /* event */, ...args)
}

const creds = { sessdata: 's', biliJct: 'j', dedeUserId: '42' }
const vid = (bvid: string, source: string) => ({
  bvid,
  title: bvid,
  cover: '',
  author: 'up',
  durationSec: 1,
  intro: '',
  source,
})

describe('wireBilibiliIpc / bilibili:process', () => {
  it('process returns no_provider when injection is null', async () => {
    // Arrange: fake auth (logged in) + store (credentials present) + getInjection => null
    const fakeAuth: Auth = {
      status: vi.fn(async () => ({ loggedIn: true, uname: 'user', mid: 42 })),
      login: vi.fn(async () => ({ loggedIn: true, uname: 'user', mid: 42 })),
      logout: vi.fn(async () => undefined),
    }
    const fakeStore: Store = {
      load: vi.fn(async () => ({ credentials: creds, obsidian: null })),
      save: vi.fn(async () => undefined),
    }
    wireBilibiliIpc({ auth: fakeAuth, store: fakeStore, getInjection: () => null })

    // Act
    const result = await invokeHandler('bilibili:process', 'BV1test')

    // Assert
    expect(result).toMatchObject({ ok: false, code: 'no_provider' })
  })
})

describe('openVideo', () => {
  it('opens the bilipc app deep link and does not touch the web url on success', async () => {
    const opener = vi.fn(async () => undefined)
    await openVideo('BV1x', opener)
    expect(opener).toHaveBeenCalledTimes(1)
    expect(opener).toHaveBeenCalledWith('bilipc://video/BV1x')
  })

  it('falls back to the web url when the app open rejects', async () => {
    const opener = vi
      .fn<(url: string) => Promise<void>>()
      .mockRejectedValueOnce(new Error('no handler'))
      .mockResolvedValueOnce(undefined)
    await openVideo('BV1x', opener)
    expect(opener).toHaveBeenNthCalledWith(1, 'bilipc://video/BV1x')
    expect(opener).toHaveBeenNthCalledWith(2, 'https://www.bilibili.com/video/BV1x')
  })
})

describe('buildList', () => {
  it('aggregates folders, their videos, and watch-later', async () => {
    const deps = {
      getFavFolders: vi.fn(async () => [{ id: 99, title: 'CS', count: 1 }]),
      getFavResources: vi.fn(async () => [vid('BV1', 'CS')]),
      getWatchLater: vi.fn(async () => [vid('BV2', '稍后再看')]),
    }
    const result = await buildList(creds, 42, deps)
    expect(result.folders).toEqual([{ folder: { id: 99, title: 'CS', count: 1 }, videos: [vid('BV1', 'CS')] }])
    expect(result.watchLater).toEqual([vid('BV2', '稍后再看')])
    expect(deps.getFavResources).toHaveBeenCalledWith(creds, 99, 'CS')
  })

  it('tolerates a single folder failing without dropping the rest', async () => {
    const deps = {
      getFavFolders: vi.fn(async () => [
        { id: 1, title: 'A', count: 1 },
        { id: 2, title: 'B', count: 1 },
      ]),
      getFavResources: vi.fn(async (_c, id: number) => {
        if (id === 1) throw new Error('boom')
        return [vid('BV2', 'B')]
      }),
      getWatchLater: vi.fn(async () => []),
    }
    const result = await buildList(creds, 42, deps)
    expect(result.folders).toEqual([
      { folder: { id: 1, title: 'A', count: 1 }, videos: [] },
      { folder: { id: 2, title: 'B', count: 1 }, videos: [vid('BV2', 'B')] },
    ])
  })
})
