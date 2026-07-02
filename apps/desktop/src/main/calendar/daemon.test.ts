// src/main/calendar/daemon.test.ts
import { describe, expect, it, vi } from 'vitest'

import { createCache, type GoogleEventRow } from './cache'
import { createDaemon } from './daemon'

function fakeApi(rows: GoogleEventRow[]) {
  return {
    listUpcoming: async () => rows,
    getPrimaryCalendarEmail: async () => 'me@x.com',
  }
}

const row = (id: string): GoogleEventRow => ({
  id,
  sourceId: id,
  calendarId: 'primary',
  title: `T ${id}`,
  description: null,
  location: null,
  startMs: Number(id),
  endMs: Number(id) + 1,
  allDay: false,
  attendees: [],
})

describe('calendar daemon', () => {
  it('pollOnce syncs events into cache and emits synced', async () => {
    const cache = createCache({ filePath: ':memory:' })
    const api = fakeApi([row('1'), row('2')])
    const synced = vi.fn()
    const d = createDaemon({ api, cache, intervalMs: 60_000, onSynced: synced })
    await d.pollOnce()
    expect(cache.stats().googleCount).toBe(2)
    expect(synced).toHaveBeenCalledWith(expect.objectContaining({ count: 2, windowDays: 90 }))
    d.stop()
    cache.close()
  })

  it('pollOnce reports error without throwing', async () => {
    const cache = createCache({ filePath: ':memory:' })
    const api = {
      ...fakeApi([]),
      listUpcoming: async () => {
        throw new Error('boom')
      },
    }
    const synced = vi.fn()
    const d = createDaemon({ api, cache, intervalMs: 60_000, onSynced: synced })
    await expect(d.pollOnce()).resolves.toBeUndefined()
    expect(synced).toHaveBeenCalledWith(
      expect.objectContaining({ error: expect.stringContaining('boom'), windowDays: 90 })
    )
    d.stop()
    cache.close()
  })

  it('onSynced(cb) fires on poll and unsubscribe stops further calls', async () => {
    const cache = createCache({ filePath: ':memory:' })
    const api = fakeApi([row('1')])
    const d = createDaemon({ api, cache, intervalMs: 60_000 })
    const cb = vi.fn()
    const off = d.onSynced(cb)
    await d.pollOnce()
    expect(cb).toHaveBeenCalledTimes(1)
    expect(cb).toHaveBeenCalledWith(expect.objectContaining({ count: 1, windowDays: 90 }))
    off()
    await d.pollOnce()
    expect(cb).toHaveBeenCalledTimes(1)
    d.stop()
    cache.close()
  })
})
