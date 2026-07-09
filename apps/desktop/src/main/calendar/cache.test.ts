import { rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'

import { createCache, type GoogleEventRow, type LocalEventInput } from './cache'

function tmpDb(): string {
  return join(tmpdir(), `cal-${Math.random().toString(36).slice(2)}.db`)
}

let paths: string[] = []
afterEach(() => {
  for (const p of paths) {
    try {
      rmSync(p)
    } catch {
      /* ignore */
    }
  }
  paths = []
})

const googleRow = (over: Partial<GoogleEventRow> = {}): GoogleEventRow => ({
  id: 'primary:evt-1',
  sourceId: 'evt-1',
  calendarId: 'primary',
  title: 'Standup',
  description: null,
  location: null,
  startMs: Date.now() + 3_600_000,
  endMs: Date.now() + 3_600_000 * 2,
  allDay: false,
  attendees: ['a@x.com'],
  ...over,
})

// Reconcile a set of google rows over a window wide enough to cover them all.
const putGoogle = (cache: ReturnType<typeof createCache>, rows: GoogleEventRow[]): { deleted: number } =>
  cache.reconcileGoogleWindow({ calendarId: 'primary', fromMs: 0, toMs: Number.MAX_SAFE_INTEGER, rows })

describe('calendar cache', () => {
  it('reconcileGoogleWindow is idempotent', () => {
    const db = tmpDb()
    paths.push(db)
    const cache = createCache({ filePath: db })
    putGoogle(cache, [googleRow()])
    putGoogle(cache, [googleRow()])
    const stats = cache.stats()
    expect(stats.googleCount).toBe(1)
  })

  it('reconcileGoogleWindow prunes events that vanished from the window but keeps out-of-window rows', () => {
    const db = tmpDb()
    paths.push(db)
    const cache = createCache({ filePath: db })
    const t = Date.now()
    const inA = googleRow({ id: 'primary:a', sourceId: 'a', startMs: t + 1000, endMs: t + 2000 })
    const inB = googleRow({ id: 'primary:b', sourceId: 'b', startMs: t + 3000, endMs: t + 4000 })
    // An out-of-window row from an earlier, wider sync.
    const far = googleRow({ id: 'primary:far', sourceId: 'far', startMs: t + 100_000, endMs: t + 100_001 })
    putGoogle(cache, [far]) // seed the far row across the whole range
    // Now reconcile only the [t, t+5000] window with A + B present.
    cache.reconcileGoogleWindow({ calendarId: 'primary', fromMs: t, toMs: t + 5000, rows: [inA, inB] })
    expect(
      cache
        .listInRange(t, t + 5000)
        .map((e) => e.id)
        .sort()
    ).toEqual(['primary:a', 'primary:b'])
    // B deleted remotely: reconcile the same window with A only -> B pruned.
    const { deleted } = cache.reconcileGoogleWindow({ calendarId: 'primary', fromMs: t, toMs: t + 5000, rows: [inA] })
    expect(deleted).toBe(1)
    expect(cache.getEvent('primary:b')).toBeNull()
    expect(cache.getEvent('primary:a')).not.toBeNull()
    // The out-of-window row is untouched by the windowed reconcile.
    expect(cache.getEvent('primary:far')).not.toBeNull()
  })

  it('listInRange merges google + local and filters by overlap', () => {
    const db = tmpDb()
    paths.push(db)
    const cache = createCache({ filePath: db })
    const t = Date.now()
    putGoogle(cache, [googleRow({ id: 'primary:g1', sourceId: 'g1', startMs: t + 1000, endMs: t + 2000, title: 'G' })])
    const local = cache.createLocal({ title: 'L', startMs: t + 3000, endMs: t + 4000 })
    const both = cache.listInRange(t, t + 5000)
    expect(both.map((e) => e.title).sort()).toEqual(['G', 'L'])
    expect(both.find((e) => e.id === local.id)?.source).toBe('local')
    expect(both.find((e) => e.id === 'primary:g1')?.source).toBe('google')
    // out-of-range event excluded
    expect(cache.listInRange(t + 10_000, t + 20_000)).toHaveLength(0)
  })

  it('local CRUD round-trips', () => {
    const db = tmpDb()
    paths.push(db)
    const cache = createCache({ filePath: db })
    const input: LocalEventInput = { title: 'Meeting', startMs: 100, endMs: 200, allDay: false }
    const created = cache.createLocal(input)
    expect(created.source).toBe('local')
    expect(created.title).toBe('Meeting')

    const updated = cache.updateLocal(created.id, { title: 'Standup' })
    expect(updated?.title).toBe('Standup')

    expect(cache.getEvent(created.id)?.title).toBe('Standup')
    expect(cache.deleteLocal(created.id)).toBe(true)
    expect(cache.getEvent(created.id)).toBeNull()
    expect(cache.deleteLocal(created.id)).toBe(false)
  })

  it('stats tracks googleCount, localCount, lastSyncAt', () => {
    const db = tmpDb()
    paths.push(db)
    const cache = createCache({ filePath: db })
    putGoogle(cache, [googleRow()])
    cache.createLocal({ title: 'L', startMs: 1, endMs: 2 })
    cache.setStats({ lastSyncAt: 999 })
    const s = cache.stats()
    expect(s.googleCount).toBe(1)
    expect(s.localCount).toBe(1)
    expect(s.lastSyncAt).toBe(999)
  })
})
