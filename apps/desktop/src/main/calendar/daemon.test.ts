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
    expect(synced).toHaveBeenCalledWith(expect.objectContaining({ count: 2, pastDays: 30, futureDays: 90 }))
    d.stop()
    cache.close()
  })

  it('pollOnce queries a window spanning 30 days back to 90 days forward', async () => {
    const cache = createCache({ filePath: ':memory:' })
    const listUpcoming = vi.fn(
      async (_input: { calendarId: string; fromMs: number; toMs: number; maxResults?: number }) =>
        [] as GoogleEventRow[]
    )
    const api = { listUpcoming, getPrimaryCalendarEmail: async () => 'me@x.com' }
    const before = Date.now()
    const d = createDaemon({ api, cache, intervalMs: 60_000 })
    await d.pollOnce()
    const after = Date.now()
    const DAY = 24 * 60 * 60 * 1000
    const { calendarId, fromMs, toMs } = listUpcoming.mock.calls[0]![0]
    expect(calendarId).toBe('primary')
    // fromMs is ~30 days in the past, toMs ~90 days in the future.
    expect(fromMs).toBeLessThanOrEqual(before - 30 * DAY)
    expect(fromMs).toBeGreaterThanOrEqual(before - 30 * DAY - (after - before) - 5)
    expect(toMs - fromMs).toBe(120 * DAY)
    d.stop()
    cache.close()
  })

  it('pollOnce prunes google events removed remotely across polls', async () => {
    const cache = createCache({ filePath: ':memory:' })
    const t = Date.now()
    const evt = (id: string): GoogleEventRow => ({
      id: `primary:${id}`,
      sourceId: id,
      calendarId: 'primary',
      title: id,
      description: null,
      location: null,
      startMs: t + 3_600_000, // inside the daemon's sync window
      endMs: t + 7_200_000,
      allDay: false,
      attendees: [],
    })
    let current = [evt('a'), evt('b')]
    const api = { listUpcoming: async () => current, getPrimaryCalendarEmail: async () => 'me@x.com' }
    const d = createDaemon({ api, cache, intervalMs: 60_000 })
    await d.pollOnce()
    expect(cache.stats().googleCount).toBe(2)
    // 'b' is deleted remotely; the next poll no longer returns it.
    current = [evt('a')]
    await d.pollOnce()
    expect(cache.stats().googleCount).toBe(1)
    expect(cache.getEvent('primary:a')).not.toBeNull()
    expect(cache.getEvent('primary:b')).toBeNull()
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
      expect.objectContaining({ error: expect.stringContaining('boom'), pastDays: 30, futureDays: 90 })
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
    expect(cb).toHaveBeenCalledWith(expect.objectContaining({ count: 1, pastDays: 30, futureDays: 90 }))
    off()
    await d.pollOnce()
    expect(cb).toHaveBeenCalledTimes(1)
    d.stop()
    cache.close()
  })
})
