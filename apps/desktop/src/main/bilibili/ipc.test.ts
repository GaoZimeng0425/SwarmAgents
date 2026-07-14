import type { AnalyzeBilibiliResult, BiliAnalysis, BiliVideo } from '@swarm/protocol'
import { describe, expect, it, vi } from 'vitest'

import type { AnalysisStore } from './analysis-store'
import { getFavFolders, getFavResources, getWatchLater } from './api'
import type { ArchiveStore } from './archive-store'
import type { Auth } from './auth'
import { buildList, openVideo, wireBilibiliIpc } from './ipc'
import type { PinStore } from './pin-store'
import type { Store } from './store'

// In-memory analysis store for IPC tests.
function fakeAnalysisStore(): AnalysisStore & { _map: Map<string, BiliAnalysis> } {
  const m = new Map<string, BiliAnalysis>()
  return {
    get: (b) => m.get(b) ?? null,
    put: async (a) => {
      m.set(a.bvid, a)
    },
    bvids: () => [...m.keys()],
    _map: m,
  }
}

// In-memory archive/pin stores keyed by bvid, mirroring the on-disk shape.
function fakeArchiveStore(): ArchiveStore & { _map: Map<string, BiliVideo> } {
  const m = new Map<string, BiliVideo>()
  return {
    list: () => [...m.values()],
    put: async (v) => {
      m.set(v.bvid, v)
    },
    remove: async (b) => {
      m.delete(b)
    },
    has: (b) => m.has(b),
    _map: m,
  }
}

function fakePinStore(): PinStore & { _map: Map<string, BiliVideo> } {
  const m = new Map<string, BiliVideo>()
  return {
    list: () => [...m.values()],
    put: async (v) => {
      m.set(v.bvid, v)
    },
    remove: async (b) => {
      m.delete(b)
    },
    has: (b) => m.has(b),
    _map: m,
  }
}

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
    shell: { openExternal: async () => undefined },
    dialog: { showOpenDialog: async () => ({ canceled: true, filePaths: [] as string[] }) },
    app: { getPath: () => '/tmp' },
    BrowserWindow: { getAllWindows: () => [] as unknown[] },
  }
})

// Stub ./api so list-handler tests can drive getFavResources/getWatchLater to
// failure without touching the network. Preserve the rest of the module
// (getWbiKeys, getCid, etc. consumed transitively via playurl/audio) via
// importOriginal; only override the list/delete functions. Default: empty
// success (overridable per-test via vi.mocked(...).mockRejectedValue).
vi.mock('./api', async (importOriginal) => {
  const actual = await importOriginal<typeof import('./api')>()
  return {
    ...actual,
    getFavFolders: vi.fn(async () => []),
    getFavResources: vi.fn(async () => []),
    getWatchLater: vi.fn(async () => []),
    deleteFavResource: vi.fn(async () => undefined),
    deleteWatchLater: vi.fn(async () => undefined),
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
      load: vi.fn(async () => ({ credentials: creds, obsidian: null, transcription: null })),
      save: vi.fn(async () => undefined),
    }
    wireBilibiliIpc({
      auth: fakeAuth,
      store: fakeStore,
      analysisStore: fakeAnalysisStore(),
      archiveStore: fakeArchiveStore(),
      pinStore: fakePinStore(),
      getInjection: () => null,
      analyzeBilibili: vi.fn(
        async () => ({ ok: false, code: 'no_provider', message: 'mock' }) as AnalyzeBilibiliResult
      ),
    })

    // Act
    const result = await invokeHandler('bilibili:process', 'BV1test')

    // Assert
    expect(result).toMatchObject({ ok: false, code: 'no_provider' })
  })
})

describe('wireBilibiliIpc / analysis cache queries', () => {
  it('exposes seeded analyses via analyzedBvids and getAnalysis', async () => {
    const fakeAuth: Auth = {
      status: vi.fn(async () => ({ loggedIn: true, uname: 'user', mid: 42 })),
      login: vi.fn(async () => ({ loggedIn: true, uname: 'user', mid: 42 })),
      logout: vi.fn(async () => undefined),
    }
    const fakeStore: Store = {
      load: vi.fn(async () => ({ credentials: creds, obsidian: null, transcription: null })),
      save: vi.fn(async () => undefined),
    }
    const analysisStore = fakeAnalysisStore()
    analysisStore._map.set('BV1', {
      bvid: 'BV1',
      summary: { gist: 'g', points: [], experience: [], pitfalls: [], steps: [] },
      text: '全文',
      source: 'subtitle',
      analyzedAt: '2026-06-28T00:00:00.000Z',
    })
    wireBilibiliIpc({
      auth: fakeAuth,
      store: fakeStore,
      analysisStore,
      archiveStore: fakeArchiveStore(),
      pinStore: fakePinStore(),
      getInjection: () => null,
      analyzeBilibili: vi.fn(
        async () => ({ ok: false, code: 'no_provider', message: 'mock' }) as AnalyzeBilibiliResult
      ),
    })

    expect(await invokeHandler('bilibili:analyzedBvids')).toEqual(['BV1'])
    expect(await invokeHandler('bilibili:getAnalysis', 'BV1')).toMatchObject({ bvid: 'BV1', source: 'subtitle' })
    expect(await invokeHandler('bilibili:getAnalysis', 'BVx')).toBeNull()
  })
})

describe('openVideo', () => {
  it('opens the bilibili web url in the default browser', async () => {
    const opener = vi.fn(async () => undefined)
    await openVideo('BV1x', opener)
    expect(opener).toHaveBeenCalledTimes(1)
    expect(opener).toHaveBeenCalledWith('https://www.bilibili.com/video/BV1x')
  })
})

describe('wireBilibiliIpc / bilibili:save', () => {
  it('save returns no_vault when no obsidian vault is configured', async () => {
    const fakeAuth: Auth = {
      status: vi.fn(async () => ({ loggedIn: true, uname: 'user', mid: 42 })),
      login: vi.fn(async () => ({ loggedIn: true, uname: 'user', mid: 42 })),
      logout: vi.fn(async () => undefined),
    }
    const fakeStore: Store = {
      load: vi.fn(async () => ({ credentials: creds, obsidian: null, transcription: null })),
      save: vi.fn(async () => undefined),
    }
    wireBilibiliIpc({
      auth: fakeAuth,
      store: fakeStore,
      analysisStore: fakeAnalysisStore(),
      archiveStore: fakeArchiveStore(),
      pinStore: fakePinStore(),
      getInjection: () => null,
      analyzeBilibili: vi.fn(
        async () => ({ ok: false, code: 'no_provider', message: 'mock' }) as AnalyzeBilibiliResult
      ),
    })
    const video = vid('BV1', 'CS')
    const summary = { gist: 'g', points: [], experience: [], pitfalls: [], steps: [] }
    const result = await invokeHandler('bilibili:save', video, summary)
    expect(result).toMatchObject({ ok: false, code: 'no_vault' })
  })
})

describe('wireBilibiliIpc / delete + archive + pins', () => {
  // Shared fakes for the handlers below. Returns the stores so assertions can
  // inspect the in-memory maps directly.
  function buildHandlers(): {
    archiveStore: ReturnType<typeof fakeArchiveStore>
    pinStore: ReturnType<typeof fakePinStore>
  } {
    const fakeAuth: Auth = {
      status: vi.fn(async () => ({ loggedIn: true, uname: 'user', mid: 42 })),
      login: vi.fn(async () => ({ loggedIn: true, uname: 'user', mid: 42 })),
      logout: vi.fn(async () => undefined),
    }
    const fakeStore: Store = {
      load: vi.fn(async () => ({ credentials: creds, obsidian: null, transcription: null })),
      save: vi.fn(async () => undefined),
    }
    const archiveStore = fakeArchiveStore()
    const pinStore = fakePinStore()
    wireBilibiliIpc({
      auth: fakeAuth,
      store: fakeStore,
      analysisStore: fakeAnalysisStore(),
      archiveStore,
      pinStore,
      getInjection: () => null,
      analyzeBilibili: vi.fn(
        async () => ({ ok: false, code: 'no_provider', message: 'mock' }) as AnalyzeBilibiliResult
      ),
    })
    return { archiveStore, pinStore }
  }

  it('deleteWatchLater returns not_logged_in when credentials are absent', async () => {
    const fakeAuth: Auth = {
      status: vi.fn(async () => ({ loggedIn: true, uname: 'user', mid: 42 })),
      login: vi.fn(async () => ({ loggedIn: true, uname: 'user', mid: 42 })),
      logout: vi.fn(async () => undefined),
    }
    const fakeStore: Store = {
      load: vi.fn(async () => ({ credentials: null, obsidian: null, transcription: null })),
      save: vi.fn(async () => undefined),
    }
    wireBilibiliIpc({
      auth: fakeAuth,
      store: fakeStore,
      analysisStore: fakeAnalysisStore(),
      archiveStore: fakeArchiveStore(),
      pinStore: fakePinStore(),
      getInjection: () => null,
      analyzeBilibili: vi.fn(
        async () => ({ ok: false, code: 'no_provider', message: 'mock' }) as AnalyzeBilibiliResult
      ),
    })
    const result = await invokeHandler('bilibili:deleteWatchLater', 'BV1')
    expect(result).toMatchObject({ ok: false, code: 'not_logged_in' })
  })

  it('deleteFav returns unknown when fav ids are missing on the video', async () => {
    buildHandlers()
    const video = vid('BV1', 'CS') // no favMediaId/favOid/favType
    const result = await invokeHandler('bilibili:deleteFav', video)
    expect(result).toMatchObject({ ok: false, code: 'unknown' })
  })

  it('archivePut/archiveList round-trips through the store', async () => {
    const { archiveStore } = buildHandlers()
    const video = { ...vid('BV1', 'CS'), favMediaId: 1, favOid: 2, favType: 2 }
    await invokeHandler('bilibili:archivePut', video)
    expect(archiveStore._map.get('BV1')).toEqual(video)
    const list = (await invokeHandler('bilibili:archiveList')) as unknown[]
    expect(list).toHaveLength(1)
  })

  it('archiveRemove deletes from the store', async () => {
    const { archiveStore } = buildHandlers()
    const video = vid('BV1', 'CS')
    await invokeHandler('bilibili:archivePut', video)
    await invokeHandler('bilibili:archiveRemove', 'BV1')
    expect(archiveStore._map.has('BV1')).toBe(false)
  })

  it('pinsPut/pinsRemove mutate the pin store', async () => {
    const { pinStore } = buildHandlers()
    const video = vid('BVP', '收藏')
    await invokeHandler('bilibili:pinsPut', video)
    expect(pinStore._map.has('BVP')).toBe(true)
    await invokeHandler('bilibili:pinsRemove', 'BVP')
    expect(pinStore._map.has('BVP')).toBe(false)
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
    expect(result.failedFolders).toBe(1)
    expect(result.failedWatchLater).toBe(false)
  })

  it('counts all folders as failed when every getFavResources throws', async () => {
    const deps = {
      getFavFolders: vi.fn(async () => [
        { id: 1, title: 'A', count: 1 },
        { id: 2, title: 'B', count: 1 },
      ]),
      getFavResources: vi.fn(async () => {
        throw new Error('412 风控')
      }),
      getWatchLater: vi.fn(async () => []),
    }
    const result = await buildList(creds, 42, deps)
    expect(result.failedFolders).toBe(2)
    expect(result.folders.every((f) => f.videos.length === 0)).toBe(true)
  })

  it('marks failedWatchLater when getWatchLater throws', async () => {
    const deps = {
      getFavFolders: vi.fn(async () => [{ id: 99, title: 'CS', count: 1 }]),
      getFavResources: vi.fn(async () => [vid('BV1', 'CS')]),
      getWatchLater: vi.fn(async () => {
        throw new Error('412 风控')
      }),
    }
    const result = await buildList(creds, 42, deps)
    expect(result.failedWatchLater).toBe(true)
    expect(result.watchLater).toEqual([])
  })
})

describe('wireBilibiliIpc / bilibili:list all-sources-failed', () => {
  it('throws when every fav folder fails and watch-later is empty', async () => {
    // Configure the ./api stubs: one folder, its resources throw, watch-later empty.
    vi.mocked(getFavFolders).mockResolvedValue([{ id: 1, title: 'A', count: 1 }])
    vi.mocked(getFavResources).mockRejectedValue(new Error('412 风控'))
    vi.mocked(getWatchLater).mockResolvedValue([])

    const fakeAuth: Auth = {
      status: vi.fn(async () => ({ loggedIn: true, uname: 'user', mid: 42 })),
      login: vi.fn(async () => ({ loggedIn: true, uname: 'user', mid: 42 })),
      logout: vi.fn(async () => undefined),
    }
    const fakeStore: Store = {
      load: vi.fn(async () => ({ credentials: creds, obsidian: null, transcription: null })),
      save: vi.fn(async () => undefined),
    }
    wireBilibiliIpc({
      auth: fakeAuth,
      store: fakeStore,
      analysisStore: fakeAnalysisStore(),
      archiveStore: fakeArchiveStore(),
      pinStore: fakePinStore(),
      getInjection: () => null,
      analyzeBilibili: vi.fn(
        async () => ({ ok: false, code: 'no_provider', message: 'mock' }) as AnalyzeBilibiliResult
      ),
    })

    await expect(invokeHandler('bilibili:list')).rejects.toThrow('收藏列表加载失败')
  })
})
