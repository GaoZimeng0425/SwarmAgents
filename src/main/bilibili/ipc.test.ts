import { describe, expect, it, vi } from 'vitest'
import { buildList } from './ipc'

const creds = { sessdata: 's', biliJct: 'j', dedeUserId: '42' }
const vid = (bvid: string, source: string) => ({
  bvid, title: bvid, cover: '', author: 'up', durationSec: 1, intro: '', source,
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
