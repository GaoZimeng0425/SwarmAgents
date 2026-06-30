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
})
