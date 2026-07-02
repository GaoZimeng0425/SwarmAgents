// src/main/gmail/daemon.test.ts
import { describe, expect, it, vi } from 'vitest'

import { createCache } from './cache'
import { createDaemon } from './daemon'

function fakeApi(threadIds: string[]) {
  return {
    getProfile: async () => ({ emailAddress: 'me@x.com' }),
    listThreads: async () => ({ threadIds }),
    fetchThread: async (id: string) => ({
      thread: {
        id,
        snippet: `s${id}`,
        fromAddr: 'a@x.com',
        subject: `Sub ${id}`,
        lastDateMs: Number(id),
        labelIds: ['INBOX'],
        unread: true,
      },
      messages: [
        {
          id: `m-${id}`,
          threadId: id,
          fromAddr: 'a@x.com',
          toAddrs: [],
          subject: `Sub ${id}`,
          snippet: 'sn',
          bodyText: 'body',
          dateMs: Number(id),
          labelIds: ['INBOX'],
        },
      ],
    }),
  }
}

describe('gmail daemon', () => {
  it('pollOnce syncs threads into cache and emits synced', async () => {
    const cache = createCache({ filePath: ':memory:' })
    const api = fakeApi(['1', '2'])
    const synced = vi.fn()
    const d = createDaemon({ api, cache, intervalMs: 60_000, onSynced: synced })
    await d.pollOnce()
    expect(cache.listRecent({ limit: 10 }).map((t) => t.id)).toEqual(['2', '1'])
    expect(synced).toHaveBeenCalledWith(expect.objectContaining({ count: 2, deletionsNotTracked: true }))
    d.stop()
    cache.close()
  })

  it('incremental poll skips cached threads; force re-fetches all', async () => {
    const cache = createCache({ filePath: ':memory:' })
    const base = fakeApi(['1', '2'])
    let fetchCalls = 0
    const api = {
      ...base,
      fetchThread: async (id: string) => {
        fetchCalls++
        return base.fetchThread(id)
      },
    }
    const d = createDaemon({ api, cache, intervalMs: 60_000 })
    await d.pollOnce()
    expect(fetchCalls).toBe(2) // empty cache -> fetch both
    expect(cache.countMessages()).toBe(2)
    await d.pollOnce() // incremental -> both now cached -> skip
    expect(fetchCalls).toBe(2) // no re-fetch
    expect(cache.countMessages()).toBe(2) // no-op poll must not zero the count
    await d.pollOnce({ force: true }) // force -> re-fetch all
    expect(fetchCalls).toBe(4)
    d.stop()
    cache.close()
  })

  it('pollOnce reports error without throwing', async () => {
    const cache = createCache({ filePath: ':memory:' })
    const api = {
      ...fakeApi([]),
      listThreads: async () => {
        throw new Error('boom')
      },
    }
    const synced = vi.fn()
    const d = createDaemon({ api, cache, intervalMs: 60_000, onSynced: synced })
    await expect(d.pollOnce()).resolves.toBeUndefined()
    expect(synced).toHaveBeenCalledWith(expect.objectContaining({ error: expect.stringContaining('boom') }))
    d.stop()
    cache.close()
  })

  it('onSynced(cb) fires on poll and unsubscribe stops further calls', async () => {
    const cache = createCache({ filePath: ':memory:' })
    const api = fakeApi(['1'])
    const d = createDaemon({ api, cache, intervalMs: 60_000 })
    const cb = vi.fn()
    const off = d.onSynced(cb)
    await d.pollOnce()
    expect(cb).toHaveBeenCalledTimes(1)
    expect(cb).toHaveBeenCalledWith(expect.objectContaining({ count: 1, deletionsNotTracked: true }))
    off()
    await d.pollOnce()
    expect(cb).toHaveBeenCalledTimes(1)
    d.stop()
    cache.close()
  })
})
