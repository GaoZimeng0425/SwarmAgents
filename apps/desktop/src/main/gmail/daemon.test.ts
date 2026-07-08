// src/main/gmail/daemon.test.ts
import { describe, expect, it, vi } from 'vitest'

import { createCache } from './cache'
import { createDaemon } from './daemon'

function fakeApi(threadIds: string[]) {
  return {
    getProfile: async () => ({ emailAddress: 'me@x.com', historyId: '100' }),
    // Default: no incremental changes since the cursor.
    getHistory: async () => ({
      expired: false as const,
      changedThreadIds: [] as string[],
      readThreadIds: [] as string[],
      unreadThreadIds: [] as string[],
      newHistoryId: '100',
    }),
    listThreads: async () => ({ threadIds, nextPageToken: null as string | null }),
    getInboxTotal: async () => threadIds.length,
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
          htmlBody: '<b>body</b>',
          dateMs: Number(id),
          labelIds: ['INBOX'],
        },
      ],
    }),
    markThreadRead: async () => {},
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
    expect(synced).toHaveBeenCalledWith(expect.objectContaining({ count: 2 }))
    d.stop()
    cache.close()
  })

  it('getPage pages via the token sequence and returns total + page ids', async () => {
    const cache = createCache({ filePath: ':memory:' })
    // 60 threads over two token-paged pages of 50.
    const all = Array.from({ length: 60 }, (_, i) => String(i + 1))
    const base = fakeApi(all)
    const api = {
      ...base,
      getInboxTotal: async () => 60,
      listThreads: async (input?: { max?: number; pageToken?: string }) => {
        // Page 1 (no token) -> first 50 + a nextPageToken; page 2 (token 'p2') -> rest, no token.
        if (!input?.pageToken) return { threadIds: all.slice(0, 50), nextPageToken: 'p2' }
        return { threadIds: all.slice(50), nextPageToken: null as string | null }
      },
    }
    const d = createDaemon({ api, cache, intervalMs: 60_000 })
    const p1 = await d.getPage(1)
    expect(p1.total).toBe(60)
    expect(p1.threadIds).toHaveLength(50)
    expect(cache.countMessages()).toBe(50)
    const p2 = await d.getPage(2)
    expect(p2.threadIds).toEqual(all.slice(50)) // remaining 10
    expect(cache.countMessages()).toBe(60)
    // Beyond the end -> empty page, still reports total.
    const p3 = await d.getPage(3)
    expect(p3.threadIds).toEqual([])
    expect(p3.total).toBe(60)
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
    await d.pollOnce() // incremental (history) -> no changes -> no fetch
    expect(fetchCalls).toBe(2) // no re-fetch
    expect(cache.countMessages()).toBe(2) // no-op poll must not zero the count
    await d.pollOnce({ force: true }) // force -> full re-fetch all
    expect(fetchCalls).toBe(4)
    d.stop()
    cache.close()
  })

  it('incremental sync applies an UNREAD removal done on another device', async () => {
    const cache = createCache({ filePath: ':memory:' })
    const base = fakeApi(['1'])
    const api = {
      ...base,
      getHistory: async () => ({
        expired: false as const,
        changedThreadIds: [],
        readThreadIds: ['1'],
        unreadThreadIds: [],
        newHistoryId: '200',
      }),
    }
    const d = createDaemon({ api, cache, intervalMs: 60_000 })
    await d.pollOnce() // full sync: thread 1 arrives unread
    expect(cache.getThread('1')?.thread.unread).toBe(true)
    await d.pollOnce() // incremental: read elsewhere -> UNREAD removed
    expect(cache.getThread('1')?.thread.unread).toBe(false)
    expect(cache.getHistoryId()).toBe('200')
    d.stop()
    cache.close()
  })

  it('incremental sync fetches newly-added threads (new mail)', async () => {
    const cache = createCache({ filePath: ':memory:' })
    const base = fakeApi(['1'])
    const api = {
      ...base,
      getHistory: async () => ({
        expired: false as const,
        changedThreadIds: ['9'],
        readThreadIds: [],
        unreadThreadIds: [],
        newHistoryId: '300',
      }),
    }
    const d = createDaemon({ api, cache, intervalMs: 60_000 })
    await d.pollOnce() // full: thread 1
    expect(cache.countMessages()).toBe(1)
    await d.pollOnce() // incremental: thread 9 added (re-fetched, still in INBOX -> upsert)
    expect(cache.getThread('9')?.thread.id).toBe('9')
    expect(cache.countMessages()).toBe(2)
    d.stop()
    cache.close()
  })

  it('incremental sync drops a thread archived elsewhere (no longer in INBOX)', async () => {
    const cache = createCache({ filePath: ':memory:' })
    const base = fakeApi(['1'])
    const api = {
      ...base,
      // Thread 1 was archived elsewhere: re-fetch shows it without the INBOX label.
      fetchThread: async (id: string) => {
        const full = await base.fetchThread(id)
        return { ...full, thread: { ...full.thread, labelIds: ['CATEGORY_PERSONAL'] } }
      },
      getHistory: async () => ({
        expired: false as const,
        changedThreadIds: ['1'],
        readThreadIds: [],
        unreadThreadIds: [],
        newHistoryId: '400',
      }),
    }
    const d = createDaemon({ api, cache, intervalMs: 60_000 })
    // Full sync seeds thread 1 (it upserts whatever fetch returns, no INBOX filter).
    await d.pollOnce()
    expect(cache.getThread('1')?.thread.id).toBe('1')
    await d.pollOnce() // incremental: archived -> reconcile drops it
    expect(cache.getThread('1')).toBeNull()
    d.stop()
    cache.close()
  })

  it('incremental sync drops a permanently-deleted thread (fetch 404s)', async () => {
    const cache = createCache({ filePath: ':memory:' })
    const base = fakeApi(['1'])
    const api = {
      ...base,
      getHistory: async () => ({
        expired: false as const,
        changedThreadIds: ['1'],
        readThreadIds: [],
        unreadThreadIds: [],
        newHistoryId: '500',
      }),
    }
    const d = createDaemon({ api, cache, intervalMs: 60_000 })
    await d.pollOnce() // full: thread 1 cached
    expect(cache.getThread('1')?.thread.id).toBe('1')
    // Now the thread is permanently gone: fetch 404s.
    api.fetchThread = async () => {
      throw new Error('gmail api 404')
    }
    await d.pollOnce() // incremental: 404 -> reconcile deletes
    expect(cache.getThread('1')).toBeNull()
    d.stop()
    cache.close()
  })

  it('falls back to a full sync when the history cursor expired', async () => {
    const cache = createCache({ filePath: ':memory:' })
    const base = fakeApi(['1', '2'])
    let listCalls = 0
    const api = {
      ...base,
      listThreads: async () => {
        listCalls++
        return { threadIds: ['1', '2'], nextPageToken: null as string | null }
      },
      getHistory: async () => ({ expired: true as const }),
    }
    const d = createDaemon({ api, cache, intervalMs: 60_000 })
    await d.pollOnce() // full (no cursor)
    expect(listCalls).toBe(1)
    await d.pollOnce() // incremental -> expired -> full resync
    expect(listCalls).toBe(2)
    d.stop()
    cache.close()
  })

  it('re-fetches cached threads whose messages lack htmlBody (one-time backfill)', async () => {
    const cache = createCache({ filePath: ':memory:' })
    // Seed a cached thread + message WITHOUT htmlBody (pre-migration cache).
    cache.upsertThreads([
      { id: '1', snippet: '', fromAddr: '', subject: '', lastDateMs: 1, labelIds: [], unread: false },
    ])
    cache.upsertMessages([
      {
        id: 'm-1',
        threadId: '1',
        fromAddr: '',
        toAddrs: [],
        subject: '',
        snippet: '',
        bodyText: 'b',
        htmlBody: '',
        dateMs: 1,
        labelIds: [],
      },
    ])
    expect(cache.threadMissingHtml('1')).toBe(true)
    const base = fakeApi(['1'])
    let fetchCalls = 0
    const api = { ...base, fetchThread: async (id: string) => (fetchCalls++, base.fetchThread(id)) }
    const d = createDaemon({ api, cache, intervalMs: 60_000 })
    await d.pollOnce()
    expect(fetchCalls).toBe(1) // missing htmlBody -> re-fetched
    expect(cache.threadMissingHtml('1')).toBe(false) // backfilled with <b>body</b>
    await d.pollOnce()
    expect(fetchCalls).toBe(1) // now complete -> skipped
    d.stop()
    cache.close()
  })

  it('serializes overlapping polls (no concurrent Gmail calls)', async () => {
    const cache = createCache({ filePath: ':memory:' })
    const base = fakeApi(['1'])
    let active = 0
    let maxActive = 0
    const gate = async (): Promise<void> => {
      active++
      maxActive = Math.max(maxActive, active)
      await new Promise((r) => setTimeout(r, 10))
      active--
    }
    const api = {
      ...base,
      getProfile: async () => (await gate(), base.getProfile()),
      getHistory: async () => (await gate(), base.getHistory()),
    }
    const d = createDaemon({ api, cache, intervalMs: 60_000 })
    // Fire two polls back-to-back (background timer overlapping a manual sync).
    // Serialized, the second waits for the first, so no two bodies run at once.
    await Promise.all([d.pollOnce(), d.pollOnce()])
    expect(maxActive).toBe(1)
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
    expect(cb).toHaveBeenCalledWith(expect.objectContaining({ count: 1 }))
    off()
    await d.pollOnce()
    expect(cb).toHaveBeenCalledTimes(1)
    d.stop()
    cache.close()
  })
})
