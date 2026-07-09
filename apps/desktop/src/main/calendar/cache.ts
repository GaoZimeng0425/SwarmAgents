// src/main/calendar/cache.ts
//
// Local sqlite store for calendar. Two tables: google_events mirrors the
// remote calendar (the daemon reconciles it each sync — upsert returned events
// and prune ones that vanished from the window); local_events is the writable
// app-local calendar (agent + UI CRUD). Main process is the sole
// writer/reader; WAL for hygiene.
import { randomUUID } from 'node:crypto'
import type { CalendarEvent } from '@swarm/protocol'
import type { Database as DB } from 'better-sqlite3'
import Database from 'better-sqlite3'

export type Stats = { googleCount: number; localCount: number; lastSyncAt: number }

export type GoogleEventRow = {
  id: string // '{calendarId}:{sourceId}'
  sourceId: string
  calendarId: string
  title: string
  description: string | null
  location: string | null
  startMs: number
  endMs: number
  allDay: boolean
  attendees: string[]
}

export type LocalEventInput = {
  title: string
  startMs: number
  endMs: number
  allDay?: boolean
  description?: string | null
  location?: string | null
}

export type Cache = {
  // Make google_events match the remote calendar for a sync window: upsert the
  // returned rows and delete any cached rows that overlap [fromMs, toMs] for the
  // same calendar but were NOT returned (deleted/moved remotely). Returns how
  // many stale rows were pruned.
  reconcileGoogleWindow(input: { calendarId: string; fromMs: number; toMs: number; rows: GoogleEventRow[] }): {
    deleted: number
  }
  listInRange(fromMs: number, toMs: number): CalendarEvent[]
  getEvent(id: string): CalendarEvent | null
  createLocal(input: LocalEventInput): CalendarEvent
  updateLocal(id: string, patch: Partial<LocalEventInput>): CalendarEvent | null
  deleteLocal(id: string): boolean
  stats(): Stats
  setStats(stats: Partial<Stats>): void
  close(): void
}

const SCHEMA = `
CREATE TABLE IF NOT EXISTS google_events (
  id TEXT PRIMARY KEY, sourceId TEXT, calendarId TEXT,
  title TEXT, description TEXT, location TEXT,
  startMs INTEGER, endMs INTEGER, allDay INTEGER, attendees TEXT, updatedAt INTEGER
);
CREATE INDEX IF NOT EXISTS idx_google_events_start ON google_events(startMs);
CREATE INDEX IF NOT EXISTS idx_google_events_end ON google_events(endMs);
CREATE TABLE IF NOT EXISTS local_events (
  id TEXT PRIMARY KEY, title TEXT, description TEXT, location TEXT,
  startMs INTEGER, endMs INTEGER, allDay INTEGER, attendees TEXT,
  createdAt INTEGER, updatedAt INTEGER
);
CREATE INDEX IF NOT EXISTS idx_local_events_start ON local_events(startMs);
CREATE INDEX IF NOT EXISTS idx_local_events_end ON local_events(endMs);
CREATE TABLE IF NOT EXISTS sync_state (key TEXT PRIMARY KEY, value TEXT);
`

function googleRowToEvent(r: Record<string, unknown>): CalendarEvent {
  return {
    id: String(r.id),
    source: 'google',
    sourceId: String(r.sourceId ?? ''),
    title: String(r.title ?? ''),
    description: r.description == null ? null : String(r.description),
    location: r.location == null ? null : String(r.location),
    startMs: Number(r.startMs ?? 0),
    endMs: Number(r.endMs ?? 0),
    allDay: Number(r.allDay ?? 0) === 1,
    attendees: JSON.parse(String(r.attendees ?? '[]')) as string[],
    calendarId: String(r.calendarId ?? 'primary'),
  }
}

function localRowToEvent(r: Record<string, unknown>): CalendarEvent {
  return {
    id: String(r.id),
    source: 'local',
    sourceId: null,
    title: String(r.title ?? ''),
    description: r.description == null ? null : String(r.description),
    location: r.location == null ? null : String(r.location),
    startMs: Number(r.startMs ?? 0),
    endMs: Number(r.endMs ?? 0),
    allDay: Number(r.allDay ?? 0) === 1,
    attendees: JSON.parse(String(r.attendees ?? '[]')) as string[],
    calendarId: null,
  }
}

export function createCache(opts: { filePath: string }): Cache {
  const db: DB = new Database(opts.filePath)
  db.pragma('journal_mode = WAL')
  db.exec(SCHEMA)

  const upsertGoogle = db.prepare(
    `INSERT INTO google_events (id, sourceId, calendarId, title, description, location, startMs, endMs, allDay, attendees, updatedAt)
     VALUES (@id, @sourceId, @calendarId, @title, @description, @location, @startMs, @endMs, @allDay, @attendees, @updatedAt)
     ON CONFLICT(id) DO UPDATE SET
       sourceId=@sourceId, calendarId=@calendarId, title=@title, description=@description, location=@location,
       startMs=@startMs, endMs=@endMs, allDay=@allDay, attendees=@attendees, updatedAt=@updatedAt`
  )

  // Prune cached rows overlapping [fromMs, toMs] for a calendar that are NOT in
  // the kept-id set — i.e. events Google would have returned for this window but
  // didn't (deleted or moved out of range remotely). json_each keeps the id set
  // out of SQL parameter limits; an empty set correctly deletes the whole window.
  const pruneStaleInWindow = db.prepare(
    `DELETE FROM google_events
     WHERE calendarId = @calendarId
       AND startMs <= @toMs AND endMs >= @fromMs
       AND id NOT IN (SELECT value FROM json_each(@keepIds))`
  )

  const reconcileGoogleWindow: Cache['reconcileGoogleWindow'] = ({ calendarId, fromMs, toMs, rows }) => {
    const now = Date.now()
    let deleted = 0
    const tx = db.transaction(() => {
      for (const r of rows) {
        upsertGoogle.run({
          id: r.id,
          sourceId: r.sourceId,
          calendarId: r.calendarId,
          title: r.title,
          description: r.description,
          location: r.location,
          startMs: r.startMs,
          endMs: r.endMs,
          allDay: r.allDay ? 1 : 0,
          attendees: JSON.stringify(r.attendees),
          updatedAt: now,
        })
      }
      deleted = pruneStaleInWindow.run({
        calendarId,
        fromMs,
        toMs,
        keepIds: JSON.stringify(rows.map((r) => r.id)),
      }).changes
    })
    tx()
    return { deleted }
  }

  // Overlap: event [startMs, endMs] intersects [fromMs, toMs].
  const listInRange: Cache['listInRange'] = (fromMs, toMs) => {
    const g = db
      .prepare('SELECT * FROM google_events WHERE startMs <= @toMs AND endMs >= @fromMs ORDER BY startMs ASC')
      .all({ fromMs, toMs }) as Record<string, unknown>[]
    const l = db
      .prepare('SELECT * FROM local_events WHERE startMs <= @toMs AND endMs >= @fromMs ORDER BY startMs ASC')
      .all({ fromMs, toMs }) as Record<string, unknown>[]
    return [...g.map(googleRowToEvent), ...l.map(localRowToEvent)]
  }

  const getEvent: Cache['getEvent'] = (id) => {
    const g = db.prepare('SELECT * FROM google_events WHERE id = ?').get(id) as Record<string, unknown> | undefined
    if (g) return googleRowToEvent(g)
    const l = db.prepare('SELECT * FROM local_events WHERE id = ?').get(id) as Record<string, unknown> | undefined
    return l ? localRowToEvent(l) : null
  }

  const createLocal: Cache['createLocal'] = (input) => {
    const id = randomUUID()
    const now = Date.now()
    db.prepare(
      `INSERT INTO local_events (id, title, description, location, startMs, endMs, allDay, attendees, createdAt, updatedAt)
       VALUES (@id, @title, @description, @location, @startMs, @endMs, @allDay, @attendees, @createdAt, @updatedAt)`
    ).run({
      id,
      title: input.title,
      description: input.description ?? null,
      location: input.location ?? null,
      startMs: input.startMs,
      endMs: input.endMs,
      allDay: input.allDay ? 1 : 0,
      attendees: JSON.stringify([]),
      createdAt: now,
      updatedAt: now,
    })
    return getEvent(id) as CalendarEvent
  }

  const updateLocal: Cache['updateLocal'] = (id, patch) => {
    const cur = db.prepare('SELECT * FROM local_events WHERE id = ?').get(id) as Record<string, unknown> | undefined
    if (!cur) return null
    const merged: LocalEventInput = {
      title: patch.title ?? String(cur.title),
      startMs: patch.startMs ?? Number(cur.startMs),
      endMs: patch.endMs ?? Number(cur.endMs),
      allDay: patch.allDay ?? Number(cur.allDay) === 1,
      description: patch.description ?? (cur.description == null ? null : String(cur.description)),
      location: patch.location ?? (cur.location == null ? null : String(cur.location)),
    }
    db.prepare(
      `UPDATE local_events SET title=@title, description=@description, location=@location,
        startMs=@startMs, endMs=@endMs, allDay=@allDay, updatedAt=@updatedAt WHERE id=@id`
    ).run({
      id,
      title: merged.title,
      description: merged.description ?? null,
      location: merged.location ?? null,
      startMs: merged.startMs,
      endMs: merged.endMs,
      allDay: merged.allDay ? 1 : 0,
      updatedAt: Date.now(),
    })
    return getEvent(id)
  }

  const deleteLocal: Cache['deleteLocal'] = (id) =>
    db.prepare('DELETE FROM local_events WHERE id = ?').run(id).changes > 0

  const stats: Cache['stats'] = () => {
    const googleCount = (db.prepare('SELECT COUNT(*) AS n FROM google_events').get() as { n: number }).n
    const localCount = (db.prepare('SELECT COUNT(*) AS n FROM local_events').get() as { n: number }).n
    const r = db.prepare('SELECT value FROM sync_state WHERE key = ?').get('lastSyncAt') as
      | { value?: string }
      | undefined
    return { googleCount, localCount, lastSyncAt: r?.value ? Number(r.value) : 0 }
  }
  const setStats: Cache['setStats'] = (s) => {
    const set = db.prepare(
      'INSERT INTO sync_state (key, value) VALUES (@k, @v) ON CONFLICT(key) DO UPDATE SET value=@v'
    )
    if (s.lastSyncAt != null) set.run({ k: 'lastSyncAt', v: String(s.lastSyncAt) })
  }

  return {
    reconcileGoogleWindow,
    listInRange,
    getEvent,
    createLocal,
    updateLocal,
    deleteLocal,
    stats,
    setStats,
    close: () => db.close(),
  }
}
