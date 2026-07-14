# Calendar Sidecar + Merged Calendar View Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add a Google Calendar read-only sidecar (mirrors the Gmail sidecar) plus a writable app-local calendar, expose both to agents as `calendar.*` tools, and visualise them by merging events into the existing `/scheduled` month-grid view; add a Calendar Settings panel for Google OAuth.

**Architecture:** A new `src/main/calendar/` feature slice (store/auth/api/cache/daemon/service/ipc/index) mirrors `src/main/gmail/`. The cache gains a writable `local_events` table alongside the read-only `google_events` cache. Agent tools in the service `utilityProcess` query main's cache via the existing `mainRequest`/`mainResponse` channel (5 new `calendar.*` `MainMethod`s). The renderer reaches the same service via `window.swarm.calendar.*`. The `ScheduledCalendarView` gains an `event` `DayItem` kind fed by a `useCalendarEvents(from,to)` hook; local events are creatable/deletable from the day-detail panel.

**Tech Stack:** Electron main + `utilityProcess`, better-sqlite3, `fetch`-based REST, Zod schemas in `@swarm/protocol`, react-query, TanStack Router, shadcn primitives, vitest.

**Reference spec:** `docs/superpowers/specs/2026-07-02-calendar-and-service-ui-design.md`. **Direct template:** `src/main/gmail/*` and `src/service/gmail/tools.ts` (Gmail sidecar).

## Global Constraints

- Conversation in Chinese; **code comments + commit messages in English** (CLAUDE.md §0).
- Log every business path under a `calendar-*` child logger; no silent `catch`; never log secrets (CLAUDE.md §5).
- All scroll uses the `ScrollArea` component (memory `feedback_all_scroll_use_scrollarea`).
- Biome formats the whole repo on `pnpm check` — use `npx biome check --write <file>` for scoped formatting (memory `reference_biome_check_hardcodes_dot`).
- Tests run via the Electron-node vitest runner: `npm test` (memory `project_run_tests_via_electron_node`). Never `pnpm rebuild better-sqlite3`; if ABI breaks, restore with `npm run postinstall`.
- TypeScript 6.0: no `baseUrl`; `paths` values prefixed with `./` (memory `reference_ts6_drops_baseurl`). If typecheck reports already-fixed errors, delete `**/*.tsbuildinfo` and re-run (memory `reference_tsc_stale_tsbuildinfo`).
- Executes in **worktree B**, rebased onto worktree A (sidebar). Does **not** touch `app-sidebar.tsx`.

## File Structure

**Protocol (new + extend):**
- Create `packages/protocol/src/types/calendar.ts` — Zod schemas + `CalendarEvent`.
- Modify `packages/protocol/src/types/service-ipc.ts` — extend `MainMethod` with 5 `calendar.*`.
- Modify `packages/protocol/src/types/ui.ts` — add `CalendarBridge` (+ result/input types).
- Modify `packages/protocol/src/index.ts` — re-export `./types/calendar`.

**Main sidecar (new slice `apps/desktop/src/main/calendar/`):**
- `store.ts` — mirror `gmail/store.ts` (encrypted config).
- `auth.ts` — mirror `gmail/auth.ts` (scope + `onProfile` diff).
- `api.ts` — Google Calendar REST client + `CalendarEvent` normaliser.
- `cache.ts` — `calendar.db`: `google_events` (ro) + `local_events` (rw) + `listInRange`/CRUD.
- `daemon.ts` — mirror `gmail/daemon.ts` (30-min poll, 90-day window).
- `service.ts` — config state machine + query/CRUD facade.
- `ipc.ts` — `wireCalendarIpc` (ipcMain.handle + mainRpcHandlers).
- `index.ts` — `initCalendar()` wiring.

**Main wiring / service tools:**
- Modify `apps/desktop/src/main/constants.ts` — `calendar()` + `calendarDb()`.
- Modify `apps/desktop/src/main/index.ts` — `initCalendar()` + dispose + registerMainRpc.
- Modify `apps/desktop/src/service/tools/builtins.ts` — `calendarMainRpc` dep + registration.
- Modify `apps/desktop/src/service/index.ts` — pass `calendarMainRpc`.
- Create `apps/desktop/src/service/calendar/tools.ts` — `calendarSpecs`.

**Renderer:**
- Modify `apps/desktop/src/preload/index.ts` — `calendar` bridge.
- Create `apps/desktop/src/renderer/src/components/views/calendar-view.tsx` — `CalendarSettingsView`.
- Modify `apps/desktop/src/renderer/src/stores/settings-dialog.ts` — `'calendar'` section.
- Modify `apps/desktop/src/renderer/src/components/settings-dialog.tsx` — Calendar nav + view.
- Create `apps/desktop/src/renderer/src/hooks/use-calendar.ts` — `useCalendarEvents` + CRUD hooks.
- Modify `apps/desktop/src/renderer/src/components/views/scheduled-calendar-view.tsx` — merge events.

---

## Phase 1 — Protocol & types

### Task 1: Calendar protocol types + MainMethod + Bridge + barrel

**Files:**
- Create: `packages/protocol/src/types/calendar.ts`
- Modify: `packages/protocol/src/types/service-ipc.ts:63`
- Modify: `packages/protocol/src/types/ui.ts` (append after the `GmailBridge` block, ~line 266)
- Modify: `packages/protocol/src/index.ts:10` (add barrel re-export)

**Interfaces:**
- Produces: `CalendarClientCreds`, `CalendarTokens`, `CalendarConfigOnDisk`, `defaultCalendarConfigOnDisk`, `CalendarConfigView`, `CalendarEvent`; extended `MainMethod`; `CalendarBridge`, `CalendarSetResult`, `CalendarLocalInput`.

- [ ] **Step 1: Create `packages/protocol/src/types/calendar.ts`**

```ts
// src/shared/types/calendar.ts
import { z } from 'zod'

// OAuth client credentials the user pastes into Settings (same shape as Gmail).
export const CalendarClientCredsSchema = z.object({
  clientId: z.string().min(1),
  clientSecret: z.string().min(1),
})
export type CalendarClientCreds = z.infer<typeof CalendarClientCredsSchema>

// Tokens obtained from the OAuth code exchange. Stored encrypted.
export const CalendarTokensSchema = z.object({
  accessToken: z.string(),
  refreshToken: z.string(),
  expiresAt: z.number().int(), // epoch ms
})
export type CalendarTokens = z.infer<typeof CalendarTokensSchema>

// On-disk config (encrypted via safeStorage).
export const CalendarConfigOnDiskSchema = z.object({
  clientCreds: CalendarClientCredsSchema.nullable(),
  tokens: CalendarTokensSchema.nullable(),
  accountEmail: z.string().nullable(),
})
export type CalendarConfigOnDisk = z.infer<typeof CalendarConfigOnDiskSchema>

export function defaultCalendarConfigOnDisk(): CalendarConfigOnDisk {
  return { clientCreds: null, tokens: null, accountEmail: null }
}

// Renderer-facing view: no secrets.
export const CalendarConfigViewSchema = z.object({
  hasClientCreds: z.boolean(),
  loggedIn: z.boolean(),
  accountEmail: z.string().nullable(),
  lastSyncAt: z.number().int().nullable(),
  googleEventCount: z.number().int().nullable(),
  localEventCount: z.number().int().nullable(),
  syncError: z.string().nullable(),
})
export type CalendarConfigView = z.infer<typeof CalendarConfigViewSchema>

// Unified event shape (cache row + tool result + view item).
export const CalendarEventSchema = z.object({
  id: z.string(),
  source: z.enum(['google', 'local']),
  sourceId: z.string().nullable(),
  title: z.string(),
  description: z.string().nullable(),
  location: z.string().nullable(),
  startMs: z.number().int(),
  endMs: z.number().int(),
  allDay: z.boolean(),
  attendees: z.array(z.string()),
  calendarId: z.string().nullable(),
})
export type CalendarEvent = z.infer<typeof CalendarEventSchema>
```

- [ ] **Step 2: Extend `MainMethod`**

In `packages/protocol/src/types/service-ipc.ts`, change the `MainMethod` union (line 63) to:

```ts
export type MainMethod =
  | 'gmail.search'
  | 'gmail.get_thread'
  | 'gmail.list_recent'
  | 'calendar.list_upcoming'
  | 'calendar.get_event'
  | 'calendar.create_local'
  | 'calendar.update_local'
  | 'calendar.delete_local'
```

- [ ] **Step 3: Add `CalendarBridge` to `ui.ts`**

Append immediately after the `GmailBridge` type (after line ~266) in `packages/protocol/src/types/ui.ts`:

```ts
export type CalendarSetResult = { ok: true } | { ok: false; code: string; message: string }

export type CalendarLocalInput = {
  title: string
  startMs: number
  endMs: number
  allDay?: boolean
  description?: string | null
  location?: string | null
}

export type CalendarBridge = {
  getStatus(): Promise<CalendarConfigView>
  setClientCreds(creds: CalendarClientCreds): Promise<CalendarSetResult>
  clearClientCreds(): Promise<unknown>
  linkAccount(): Promise<CalendarSetResult>
  unlinkAccount(): Promise<unknown>
  syncNow(): Promise<void>
  onStateChanged(cb: (view: CalendarConfigView) => void): () => void
  listInRange(fromMs: number, toMs: number): Promise<CalendarEvent[]>
  createLocal(input: CalendarLocalInput): Promise<CalendarEvent>
  updateLocal(id: string, patch: Partial<CalendarLocalInput>): Promise<CalendarEvent | null>
  deleteLocal(id: string): Promise<boolean>
}
```

Add the needed imports at the top of `ui.ts` (next to the existing `GmailConfigView`/`GmailClientCreds` imports):

```ts
import type { CalendarClientCreds, CalendarConfigView, CalendarEvent } from './calendar'
```

(Check `ui.ts`'s existing import style — Gmail types are imported there; mirror it. If `ui.ts` imports from a single `./gmail` line, add a parallel `./calendar` import.)

- [ ] **Step 4: Re-export from the barrel**

In `packages/protocol/src/index.ts`, after line 10 (`export * from './types/gmail'`), add:

```ts
export * from './types/calendar'
```

- [ ] **Step 5: Typecheck the protocol package**

Run: `cd packages/protocol && npx tsc --noEmit`
Expected: no errors.

- [ ] **Step 6: Commit**

```bash
git add packages/protocol/src/types/calendar.ts packages/protocol/src/types/service-ipc.ts packages/protocol/src/types/ui.ts packages/protocol/src/index.ts
git commit -m "feat(protocol): add calendar types, MainMethod, and CalendarBridge"
```

---

### Task 2: `paths.calendar()` + `paths.calendarDb()`

**Files:**
- Modify: `apps/desktop/src/main/constants.ts` (add two entries to the `paths` object, after `gmailDb` at line 44)

**Interfaces:**
- Produces: `paths.calendar()` → `userData/calendar.enc`; `paths.calendarDb()` → `userData/calendar.db`.

- [ ] **Step 1: Add the two path entries**

In `apps/desktop/src/main/constants.ts`, after the `gmailDb` line (44), add:

```ts
  calendar: () => join(app.getPath('userData'), 'calendar.enc'),
  calendarDb: () => join(app.getPath('userData'), 'calendar.db'),
```

- [ ] **Step 2: Commit**

```bash
git add apps/desktop/src/main/constants.ts
git commit -m "feat(main): add calendar paths"
```

---

## Phase 2 — Main sidecar (bottom-up)

### Task 3: `cache.ts` (new logic — `google_events` + `local_events` + range/CRUD)

**Files:**
- Create: `apps/desktop/src/main/calendar/cache.ts`
- Test: `apps/desktop/src/main/calendar/cache.test.ts`

**Interfaces:**
- Produces: `Cache` type, `createCache({ filePath })`, `GoogleEventRow`, `LocalEventInput`. Consumed by daemon (upsert), service (all methods).

- [ ] **Step 1: Write the failing test**

Create `apps/desktop/src/main/calendar/cache.test.ts`:

```ts
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
    } catch {}
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

describe('calendar cache', () => {
  it('upsertGoogleEvents is idempotent', () => {
    const db = tmpDb()
    paths.push(db)
    const cache = createCache({ filePath: db })
    cache.upsertGoogleEvents([googleRow()])
    cache.upsertGoogleEvents([googleRow()])
    const stats = cache.stats()
    expect(stats.googleCount).toBe(1)
  })

  it('listInRange merges google + local and filters by overlap', () => {
    const db = tmpDb()
    paths.push(db)
    const cache = createCache({ filePath: db })
    const t = Date.now()
    cache.upsertGoogleEvents([
      googleRow({ id: 'primary:g1', sourceId: 'g1', startMs: t + 1000, endMs: t + 2000, title: 'G' }),
    ])
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
    cache.upsertGoogleEvents([googleRow()])
    cache.createLocal({ title: 'L', startMs: 1, endMs: 2 })
    cache.setStats({ lastSyncAt: 999 })
    const s = cache.stats()
    expect(s.googleCount).toBe(1)
    expect(s.localCount).toBe(1)
    expect(s.lastSyncAt).toBe(999)
  })
})
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd apps/desktop && npx vitest run src/main/calendar/cache.test.ts`
Expected: FAIL — `./cache` not found.

- [ ] **Step 3: Write the implementation**

Create `apps/desktop/src/main/calendar/cache.ts`:

```ts
// src/main/calendar/cache.ts
//
// Local sqlite store for calendar. Two tables: google_events is a read-only
// cache the daemon upserts; local_events is the writable app-local calendar
// (agent + UI CRUD). Main process is the sole writer/reader; WAL for hygiene.
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
  upsertGoogleEvents(rows: GoogleEventRow[]): void
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

  const upsertGoogleEvents: Cache['upsertGoogleEvents'] = (rows) => {
    const now = Date.now()
    const tx = db.transaction((items: GoogleEventRow[]) => {
      for (const r of items) {
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
    })
    tx(rows)
  }

  // Overlap: event [startMs, endMs] intersects [fromMs, toMs].
  const listInRange: Cache['listInRange'] = (fromMs, toMs) => {
    const g = db
      .prepare(
        `SELECT * FROM google_events WHERE startMs <= @toMs AND endMs >= @fromMs ORDER BY startMs ASC`
      )
      .all({ fromMs, toMs }) as Record<string, unknown>[]
    const l = db
      .prepare(
        `SELECT * FROM local_events WHERE startMs <= @toMs AND endMs >= @fromMs ORDER BY startMs ASC`
      )
      .all({ fromMs, toMs }) as Record<string, unknown>[]
    return [...g.map(googleRowToEvent), ...l.map(localRowToEvent)]
  }

  const getEvent: Cache['getEvent'] = (id) => {
    const g = db.prepare('SELECT * FROM google_events WHERE id = ?').get(id) as Record<
      string,
      unknown
    > | undefined
    if (g) return googleRowToEvent(g)
    const l = db.prepare('SELECT * FROM local_events WHERE id = ?').get(id) as Record<
      string,
      unknown
    > | undefined
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
    const cur = db.prepare('SELECT * FROM local_events WHERE id = ?').get(id) as Record<
      string,
      unknown
    > | undefined
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
    const googleCount = (
      db.prepare('SELECT COUNT(*) AS n FROM google_events').get() as { n: number }
    ).n
    const localCount = (
      db.prepare('SELECT COUNT(*) AS n FROM local_events').get() as { n: number }
    ).n
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
    upsertGoogleEvents,
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
```

- [ ] **Step 4: Run test to verify it passes**

Run: `cd apps/desktop && npx vitest run src/main/calendar/cache.test.ts`
Expected: PASS (4 tests).

- [ ] **Step 5: Commit**

```bash
git add apps/desktop/src/main/calendar/cache.ts apps/desktop/src/main/calendar/cache.test.ts
git commit -m "feat(calendar): add sqlite cache (google_events + local_events CRUD)"
```

---

### Task 4: `store.ts` (mirror `gmail/store.ts`)

**Files:**
- Create: `apps/desktop/src/main/calendar/store.ts`
- Test: `apps/desktop/src/main/calendar/store.test.ts`

**Interfaces:**
- Produces: `createStore({ filePath })`, `Store` type (`load()`, `save(state)`). Consumes the `CalendarConfigOnDisk` type from Task 1.

- [ ] **Step 1: Copy + adapt the Gmail store**

Copy `apps/desktop/src/main/gmail/store.ts` to `apps/desktop/src/main/calendar/store.ts`. Apply these exact changes:
- Replace the import `from '@swarm/protocol'`: `GmailClientCreds, GmailConfigOnDisk` → `CalendarClientCreds, CalendarConfigOnDisk, defaultCalendarConfigOnDisk`.
- Type aliases/params: `GmailConfigOnDisk` → `CalendarConfigOnDisk` everywhere.
- The `load()` default when the file is absent: return `defaultCalendarConfigOnDisk()` (imported in Task 1) instead of constructing inline.
- Child-logger component string: `gmail-store` → `calendar-store`.
- Keep `safeStorage` encrypt/decrypt, atomic tmp→rename, Zod-validate-before-encrypt, serialised save queue, forgiving `load()` / strict `loadOrRecover()` exactly as in Gmail.

- [ ] **Step 2: Write the test (mirror `gmail/store.test.ts` if present, else minimal)**

Create `apps/desktop/src/main/calendar/store.test.ts`:

```ts
import { rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { afterEach, describe, expect, it } from 'vitest'

import { createStore } from './store'

let paths: string[] = []
afterEach(() => {
  for (const p of paths) try { rmSync(p) } catch {}
  paths = []
})

describe('calendar store', () => {
  it('persists and reloads config', async () => {
    const file = join(tmpdir(), `cal-store-${Math.random().toString(36).slice(2)}.enc`)
    paths.push(file)
    const store = createStore({ filePath: file })
    expect((await store.load()).clientCreds).toBeNull()
    await store.save({
      clientCreds: { clientId: 'c', clientSecret: 's' },
      tokens: null,
      accountEmail: null,
    })
    const reloaded = await createStore({ filePath: file }).load()
    expect(reloaded.clientCreds?.clientId).toBe('c')
  })
})
```

> Note: `store.ts` uses Electron `safeStorage`, which is only available in a running app. If the test environment lacks `safeStorage` (the Gmail store test handles this), mirror whatever guard `gmail/store.test.ts` uses (skip-on-missing-safeStorage). If unsure, gate the test body with `import { safeStorage } from 'electron'` and `it.skipIf(!safeStorage?.isEncryptionAvailable())(...)`.

- [ ] **Step 3: Run test + commit**

Run: `cd apps/desktop && npx vitest run src/main/calendar/store.test.ts` (Expected: PASS, or SKIP if `safeStorage` unavailable in that runner).
Format: `cd apps/desktop && npx biome check --write src/main/calendar/store.ts src/main/calendar/store.test.ts`
Commit:

```bash
git add apps/desktop/src/main/calendar/store.ts apps/desktop/src/main/calendar/store.test.ts
git commit -m "feat(calendar): add encrypted config store"
```

---

### Task 5: `auth.ts` (mirror `gmail/auth.ts`, scope + onProfile diff)

**Files:**
- Create: `apps/desktop/src/main/calendar/auth.ts`
- Test: `apps/desktop/src/main/calendar/auth.test.ts`

**Interfaces:**
- Produces: `createAuth({ store, onProfile })`, `Auth` type (`login`, `logout`, `getAccessToken`, `refreshAccessToken`). `onProfile(token)` resolves to the primary calendar id (the user's email).

- [ ] **Step 1: Copy + adapt the Gmail auth**

Copy `apps/desktop/src/main/gmail/auth.ts` to `apps/desktop/src/main/calendar/auth.ts`. Apply these exact changes:
- Imports: `GmailClientCreds, GmailConfigOnDisk, GmailTokens` → `CalendarClientCreds, CalendarConfigOnDisk, CalendarTokens`.
- `SCOPE`: `'https://www.googleapis.com/auth/gmail.readonly'` → `'https://www.googleapis.com/auth/calendar.readonly'`.
- All token/state type references: `Gmail*` → `Calendar*`.
- Child-logger component: `gmail-auth` → `calendar-auth`.
- `CONSENT_URL`, `TOKEN_ENDPOINT`, `LOGIN_TIMEOUT_MS`, `extractCode`, `exchangeCode`, `refreshTokens` stay identical (same Google OAuth2 endpoints).
- Keep the loopback-server flow, 5-min deadline, `access_type=offline`, `prompt=consent` exactly as in Gmail.

The `onProfile` callback is supplied by `index.ts` (Task 10), not defined here — `auth.ts` just calls `deps.onProfile(tokens.accessToken)` to resolve `{ emailAddress }`.

- [ ] **Step 2: Write the test (mirror `gmail/auth.test.ts`)**

Create `apps/desktop/src/main/calendar/auth.test.ts`. Mirror `apps/desktop/src/main/gmail/auth.test.ts` (assert `SCOPE` is `calendar.readonly`; reuse its mocked-`fetch` + mocked-loopback-server harness). Rename `gmail`→`calendar` throughout. If `gmail/auth.test.ts` does not exist, write a focused test that:
  - mocks global `fetch` to return a token JSON for the token endpoint and a `calendarList` JSON (`{ items: [{ primary: true, id: 'user@example.com' }] }`) for the profile call,
  - drives `login()` against an in-memory store,
  - asserts `store.load()` persisted tokens and `onProfile` received `'user@example.com'`,
  - asserts the consent URL the test intercepted contains `scope=https%3A%2F%2Fwww.googleapis.com%2Fauth%2Fcalendar.readonly`.

- [ ] **Step 3: Run test + commit**

Run: `cd apps/desktop && npx vitest run src/main/calendar/auth.test.ts` (Expected: PASS).
Format: `cd apps/desktop && npx biome check --write src/main/calendar/auth.ts src/main/calendar/auth.test.ts`
Commit:

```bash
git add apps/desktop/src/main/calendar/auth.ts apps/desktop/src/main/calendar/auth.test.ts
git commit -m "feat(calendar): add OAuth loopback auth (calendar.readonly)"
```

---

### Task 6: `api.ts` (Google Calendar REST + normaliser)

**Files:**
- Create: `apps/desktop/src/main/calendar/api.ts`
- Test: `apps/desktop/src/main/calendar/api.test.ts`

**Interfaces:**
- Consumes: `Auth` from Task 5 (`getAccessToken`, `refreshAccessToken`).
- Produces: `createApi(auth)`, `CalendarApi` type with `listUpcoming({ calendarId, fromMs, toMs, maxResults? })` → `GoogleEventRow[]`, and `getPrimaryCalendarEmail()` → `string`.

- [ ] **Step 1: Write the failing test**

Create `apps/desktop/src/main/calendar/api.test.ts`:

```ts
import { afterEach, describe, expect, it, vi } from 'vitest'

import { createApi } from './api'

const baseEventsJson = {
  items: [
    {
      id: 'evt-1',
      summary: 'Standup',
      location: 'Zoom',
      description: 'Daily',
      start: { dateTime: '2026-07-02T09:00:00Z' },
      end: { dateTime: '2026-07-02T09:30:00Z' },
      attendees: [{ email: 'a@x.com' }],
    },
    {
      id: 'evt-2',
      summary: 'PTO',
      start: { date: '2026-07-03' },
      end: { date: '2026-07-04' },
    },
  ],
}

describe('calendar api', () => {
  afterEach(() => vi.restoreAllMocks())

  it('listUpcoming sends the right query and normalises rows', async () => {
    const fetchMock = vi.spyOn(globalThis, 'fetch').mockResolvedValue(
      new Response(JSON.stringify(baseEventsJson), { status: 200 })
    )
    const api = createApi({
      getAccessToken: async () => 'TOKEN',
      refreshAccessToken: async () => {},
    })
    const rows = await api.listUpcoming({
      calendarId: 'primary',
      fromMs: Date.parse('2026-07-02T00:00:00Z'),
      toMs: Date.parse('2026-07-09T00:00:00Z'),
      maxResults: 50,
    })
    expect(rows).toHaveLength(2)
    const standup = rows.find((r) => r.sourceId === 'evt-1')!
    expect(standup.title).toBe('Standup')
    expect(standup.allDay).toBe(false)
    expect(standup.attendees).toEqual(['a@x.com'])
    expect(standup.id).toBe('primary:evt-1')
    const pto = rows.find((r) => r.sourceId === 'evt-2')!
    expect(pto.allDay).toBe(true)

    const url = fetchMock.mock.calls[0][0] as string
    expect(url).toContain('/calendars/primary/events')
    expect(url).toContain('singleEvents=true')
    expect(url).toContain('orderBy=startTime')
    expect(url).toContain('timeMin=')
    expect(url).toContain('timeMax=')
    const init = fetchMock.mock.calls[0][1] as RequestInit
    expect((init.headers as Record<string, string>).Authorization).toBe('Bearer TOKEN')
  })

  it('getPrimaryCalendarEmail returns the primary calendar id', async () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(
      new Response(JSON.stringify({ items: [{ primary: true, id: 'user@example.com' }] }), {
        status: 200,
      })
    )
    const api = createApi({ getAccessToken: async () => 'TOKEN', refreshAccessToken: async () => {} })
    expect(await api.getPrimaryCalendarEmail()).toBe('user@example.com')
  })

  it('refreshes once on 401 then retries', async () => {
    let calls = 0
    const refresh = vi.fn(async () => {})
    vi.spyOn(globalThis, 'fetch').mockImplementation(async () => {
      calls++
      if (calls === 1) return new Response('unauth', { status: 401 })
      return new Response(JSON.stringify({ items: [] }), { status: 200 })
    })
    const api = createApi({ getAccessToken: async () => 'TOKEN', refreshAccessToken: refresh })
    const rows = await api.listUpcoming({ calendarId: 'primary', fromMs: 0, toMs: 1 })
    expect(rows).toEqual([])
    expect(refresh).toHaveBeenCalledOnce()
  })
})
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd apps/desktop && npx vitest run src/main/calendar/api.test.ts`
Expected: FAIL — `./api` not found.

- [ ] **Step 3: Write the implementation**

Create `apps/desktop/src/main/calendar/api.ts`:

```ts
// src/main/calendar/api.ts
//
// Hand-rolled Google Calendar REST client (mirrors gmail/api.ts shape):
// listUpcoming + getPrimaryCalendarEmail. 401 -> refresh -> retry once.
// 429/5xx -> exponential backoff (max 3). Normalises Google JSON -> GoogleEventRow.
import { createLogger } from '@shared/logger'

import type { GoogleEventRow } from './cache'

const log = createLogger({ process: 'main' }).child({ component: 'calendar-api' })

const BASE = 'https://calendar-json.googleapis.com/calendar/v3'

type Auth = { getAccessToken(): Promise<string>; refreshAccessToken(): Promise<void> }

export type CalendarApi = {
  listUpcoming(input: {
    calendarId: string
    fromMs: number
    toMs: number
    maxResults?: number
  }): Promise<GoogleEventRow[]>
  getPrimaryCalendarEmail(): Promise<string>
}

function parseAllDayDate(s: string): number {
  // 'yyyy-MM-dd' -> local-midnight epoch ms (matches how the view groups by day).
  const [y, m, d] = s.split('-').map(Number)
  return new Date(y, (m ?? 1) - 1, d ?? 1).getTime()
}

function normalise(calendarId: string, raw: Record<string, unknown>): GoogleEventRow {
  const start = (raw.start ?? {}) as { dateTime?: string; date?: string }
  const end = (raw.end ?? {}) as { dateTime?: string; date?: string }
  const allDay = !!start.date
  const startMs = start.dateTime ? Date.parse(start.dateTime) : start.date ? parseAllDayDate(start.date) : 0
  const endMs = end.dateTime ? Date.parse(end.dateTime) : end.date ? parseAllDayDate(end.date) : startMs
  const attendees = ((raw.attendees ?? []) as { email?: string }[])
    .map((a) => a.email)
    .filter((x): x is string => !!x)
  const sourceId = String(raw.id ?? '')
  return {
    id: `${calendarId}:${sourceId}`,
    sourceId,
    calendarId,
    title: String(raw.summary ?? '(untitled)'),
    description: raw.description == null ? null : String(raw.description),
    location: raw.location == null ? null : String(raw.location),
    startMs,
    endMs,
    allDay,
    attendees,
  }
}

export function createApi(auth: Auth): CalendarApi {
  let refreshing = false

  async function request(path: string): Promise<Record<string, unknown>> {
    const url = path.startsWith('http') ? path : `${BASE}${path}`
    for (let attempt = 0; attempt < 4; attempt++) {
      const token = await auth.getAccessToken()
      const res = await fetch(url, { headers: { Authorization: `Bearer ${token}` } })
      if (res.status === 401 && !refreshing) {
        refreshing = true
        try {
          await auth.refreshAccessToken()
        } finally {
          refreshing = false
        }
        continue // retry once with the refreshed token
      }
      if (res.status === 429 || res.status >= 500) {
        const wait = 2 ** attempt * 500
        log.warn({ msg: 'calendar api backoff', status: res.status, wait })
        await new Promise((r) => setTimeout(r, wait))
        continue
      }
      if (!res.ok) throw new Error(`calendar api ${res.status}: ${await res.text()}`)
      return (await res.json()) as Record<string, unknown>
    }
    throw new Error(`calendar api exhausted retries: ${path}`)
  }

  return {
    async listUpcoming({ calendarId, fromMs, toMs, maxResults = 250 }) {
      const params = new URLSearchParams({
        singleEvents: 'true',
        orderBy: 'startTime',
        timeMin: new Date(fromMs).toISOString(),
        timeMax: new Date(toMs).toISOString(),
        maxResults: String(maxResults),
      })
      const json = await request(`/calendars/${encodeURIComponent(calendarId)}/events?${params}`)
      const items = ((json.items ?? []) as Record<string, unknown>[]).map((r) =>
        normalise(calendarId, r)
      )
      log.debug({ msg: 'calendar listUpcoming', count: items.length })
      return items
    },
    async getPrimaryCalendarEmail() {
      const json = await request('/users/me/calendarList')
      const items = (json.items ?? []) as { primary?: boolean; id: string }[]
      const primary = items.find((i) => i.primary) ?? items[0]
      if (!primary) throw new Error('no primary calendar found')
      return primary.id
    },
  }
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `cd apps/desktop && npx vitest run src/main/calendar/api.test.ts`
Expected: PASS (3 tests).

- [ ] **Step 5: Commit**

```bash
git add apps/desktop/src/main/calendar/api.ts apps/desktop/src/main/calendar/api.test.ts
git commit -m "feat(calendar): add Google Calendar REST client + event normaliser"
```

---

### Task 7: `daemon.ts` (mirror `gmail/daemon.ts`, 30-min / 90-day)

**Files:**
- Create: `apps/desktop/src/main/calendar/daemon.ts`
- Test: `apps/desktop/src/main/calendar/daemon.test.ts`

**Interfaces:**
- Consumes: `CalendarApi` (Task 6), `Cache` (Task 3).
- Produces: `createDaemon({ api, cache })`, `Daemon` (`start`, `stop`, `pollOnce`, `onSynced`).

- [ ] **Step 1: Copy + adapt the Gmail daemon**

Copy `apps/desktop/src/main/gmail/daemon.ts` to `apps/desktop/src/main/calendar/daemon.ts`. Apply these exact changes:
- `DEFAULT_INTERVAL_MS`: `5 * 60 * 1000` → `30 * 60 * 1000` (30 min; calendar changes less often than inbox).
- `SyncedPayload`: replace `{ count, ts, deletionsNotTracked: true, error? }` with `{ count, ts, windowDays: 90, error? }`.
- `pollOnce`: replace the gmail body (`listThreads` + per-thread `fetchThread` + `upsertThreads`/`upsertMessages`) with:
  ```ts
  const now = Date.now()
  const WINDOW_MS = 90 * 24 * 60 * 60 * 1000
  const rows = await deps.api.listUpcoming({ calendarId: 'primary', fromMs: now, toMs: now + WINDOW_MS })
  deps.cache.upsertGoogleEvents(rows)
  deps.cache.setStats({ lastSyncAt: now })
  log.info({ msg: 'calendar synced', count: rows.length })
  fireSynced({ count: rows.length, ts: now, windowDays: 90 })
  ```
  The `catch` logs `calendar sync failed` and fires `{ count: 0, ts, windowDays: 90, error: msg }`.
- Imports: `GmailMessage, GmailThread` → remove; import `CalendarEvent` not needed here. Keep `createLogger` + the `CalendarApi`/`Cache` type imports.
- Child-logger component: `gmail-daemon` → `calendar-daemon`.
- Keep `start`/`stop`/`onSynced` lifecycle identical to Gmail.

- [ ] **Step 2: Write the test (mirror `gmail/daemon.test.ts`)**

Create `apps/desktop/src/main/calendar/daemon.test.ts` using a mocked `api` and an in-memory `cache` (real `createCache({ filePath: ':memory:' })` works). Assert:
- `pollOnce()` calls `api.listUpcoming` with a ~90-day window and `upsertGoogleEvents` is reflected in `cache.stats().googleCount`.
- `onSynced` fires with `{ windowDays: 90 }` on success and `{ error }` on api failure.

- [ ] **Step 3: Run test + commit**

Run: `cd apps/desktop && npx vitest run src/main/calendar/daemon.test.ts` (Expected: PASS).
Format + commit:

```bash
npx biome check --write apps/desktop/src/main/calendar/daemon.ts apps/desktop/src/main/calendar/daemon.test.ts
git add apps/desktop/src/main/calendar/daemon.ts apps/desktop/src/main/calendar/daemon.test.ts
git commit -m "feat(calendar): add resident sync daemon (30-min poll, 90-day window)"
```

---

### Task 8: `service.ts` (config state machine + query/CRUD facade)

**Files:**
- Create: `apps/desktop/src/main/calendar/service.ts`
- Test: `apps/desktop/src/main/calendar/service.test.ts`

**Interfaces:**
- Consumes: `Store` (Task 4), `Cache` (Task 3), `Auth` (Task 5), `Daemon` (Task 7).
- Produces: `createService(deps)`, `Service` (config methods mirror Gmail + `listInRange`, `getEvent`, `createLocal`, `updateLocal`, `deleteLocal`).

- [ ] **Step 1: Copy + adapt the Gmail service**

Copy `apps/desktop/src/main/gmail/service.ts` to `apps/desktop/src/main/calendar/service.ts`. Apply these exact changes:
- Type imports: `GmailClientCreds, GmailConfigOnDisk, GmailConfigView` → `CalendarClientCreds, CalendarConfigOnDisk, CalendarConfigView`. Add `import type { CalendarEvent } from '@swarm/protocol'`.
- The `Service` type: keep `setClientCreds`, `clearClientCreds`, `linkAccount`, `unlinkAccount`, `getView`, `syncNow`, `onStateChanged`. Replace the gmail query methods (`search`/`getThread`/`listRecent`) with:
  ```ts
  listInRange(fromMs: number, toMs: number): CalendarEvent[]
  getEvent(id: string): CalendarEvent | null
  createLocal(input: import('./cache').LocalEventInput): CalendarEvent
  updateLocal(id: string, patch: Partial<import('./cache').LocalEventInput>): CalendarEvent | null
  deleteLocal(id: string): boolean
  ```
- `snapshot()` (the `CalendarConfigView`): replace `messageCount` with `googleEventCount` and `localEventCount` from `deps.cache.stats()`. Keep `lastSyncAt`, `syncError`, `loggedIn`, `accountEmail`, `hasClientCreds`.
- In the method bodies, `cachedConfig`/`syncError` handling stays identical; the query/CRUD methods delegate:
  ```ts
  listInRange: (fromMs, toMs) => deps.cache.listInRange(fromMs, toMs),
  getEvent: (id) => deps.cache.getEvent(id),
  createLocal: (input) => { const e = deps.cache.createLocal(input); emit(); return e },
  updateLocal: (id, patch) => { const e = deps.cache.updateLocal(id, patch); emit(); return e },
  deleteLocal: (id) => { const ok = deps.cache.deleteLocal(id); emit(); return ok },
  ```
  (Local CRUD calls `emit()` so `calendar:stateChanged` refreshes `localEventCount` and the view refetches.)
- Child-logger component: `gmail-service` → `calendar-service`.

- [ ] **Step 2: Write the test (mirror `gmail/service.test.ts`)**

Create `apps/desktop/src/main/calendar/service.test.ts`. Assert over an in-memory cache (`:memory:`), a stub `Auth`/`Store`/`Daemon`:
- `createLocal` then `listInRange` returns it; `getView().localEventCount` is 1.
- `deleteLocal` flips it back to 0 and `emit`/`onStateChanged` fired.
- `linkAccount` rejects when `clientCreds` is null (`not_linked`).

- [ ] **Step 3: Run test + commit**

Run: `cd apps/desktop && npx vitest run src/main/calendar/service.test.ts` (Expected: PASS).
Format + commit:

```bash
npx biome check --write apps/desktop/src/main/calendar/service.ts apps/desktop/src/main/calendar/service.test.ts
git add apps/desktop/src/main/calendar/service.ts apps/desktop/src/main/calendar/service.test.ts
git commit -m "feat(calendar): add config state machine + query/CRUD facade"
```

---

### Task 9: `ipc.ts` (`wireCalendarIpc`)

**Files:**
- Create: `apps/desktop/src/main/calendar/ipc.ts`

**Interfaces:**
- Consumes: `Service` (Task 8). Produces `{ dispose, mainRpcHandlers }` (mirrors `wireGmailIpc`).

- [ ] **Step 1: Write the file**

Create `apps/desktop/src/main/calendar/ipc.ts`:

```ts
// src/main/calendar/ipc.ts
//
// Wires the Calendar service to Electron IPC (renderer handlers) and exposes
// the main-rpc query/CRUD handlers the service->main bridge dispatches to.
// Mirrors gmail/ipc.ts; broadcasts calendar:stateChanged to all windows.
import { createLogger } from '@shared/logger'
import type { CalendarClientCreds, MainMethod } from '@swarm/protocol'
import { BrowserWindow, ipcMain } from 'electron'

import type { LocalEventInput } from './cache'
import type { Service } from './service'

const log = createLogger({ process: 'main' }).child({ component: 'calendar-ipc' })

const STATE_CHANGED = 'calendar:stateChanged'

export type MainRpcHandlers = Record<MainMethod, (...args: unknown[]) => Promise<unknown>>

export function wireCalendarIpc(args: { service: Service }): {
  dispose: () => void
  mainRpcHandlers: MainRpcHandlers
} {
  const { service } = args

  const unsubscribe = service.onStateChanged((view) => {
    for (const w of BrowserWindow.getAllWindows()) {
      if (!w.isDestroyed()) w.webContents.send(STATE_CHANGED, view)
    }
  })

  ipcMain.handle('calendar:getStatus', () => service.getView())
  ipcMain.handle('calendar:setClientCreds', (_e, creds: CalendarClientCreds) =>
    service.setClientCreds(creds)
  )
  ipcMain.handle('calendar:clearClientCreds', () => service.clearClientCreds())
  ipcMain.handle('calendar:linkAccount', () => service.linkAccount())
  ipcMain.handle('calendar:unlinkAccount', () => service.unlinkAccount())
  ipcMain.handle('calendar:syncNow', () => service.syncNow())
  ipcMain.handle('calendar:listInRange', (_e, fromMs: number, toMs: number) =>
    service.listInRange(Number(fromMs), Number(toMs))
  )
  ipcMain.handle('calendar:createLocal', (_e, input: LocalEventInput) => service.createLocal(input))
  ipcMain.handle('calendar:updateLocal', (_e, id: string, patch: Partial<LocalEventInput>) =>
    service.updateLocal(String(id), patch)
  )
  ipcMain.handle('calendar:deleteLocal', (_e, id: string) => service.deleteLocal(String(id)))

  const DAY_MS = 24 * 60 * 60 * 1000
  const mainRpcHandlers: MainRpcHandlers = {
    'calendar.list_upcoming': (days) => {
      const d = Number(days ?? 14)
      const now = Date.now()
      return Promise.resolve(service.listInRange(now, now + d * DAY_MS))
    },
    'calendar.get_event': (id) => Promise.resolve(service.getEvent(String(id))),
    'calendar.create_local': (input) =>
      Promise.resolve(service.createLocal(input as LocalEventInput)),
    'calendar.update_local': (id, patch) =>
      Promise.resolve(service.updateLocal(String(id), patch as Partial<LocalEventInput>)),
    'calendar.delete_local': (id) => Promise.resolve(service.deleteLocal(String(id))),
  }

  log.info({ msg: 'calendar IPC wired' })

  const channels = [
    'calendar:getStatus',
    'calendar:setClientCreds',
    'calendar:clearClientCreds',
    'calendar:linkAccount',
    'calendar:unlinkAccount',
    'calendar:syncNow',
    'calendar:listInRange',
    'calendar:createLocal',
    'calendar:updateLocal',
    'calendar:deleteLocal',
  ]
  return {
    dispose() {
      unsubscribe()
      for (const ch of channels) ipcMain.removeHandler(ch)
    },
    mainRpcHandlers,
  }
}
```

- [ ] **Step 2: Typecheck + format + commit**

Run: `cd apps/desktop && npx tsc --noEmit -p tsconfig.json` (Expected: no errors — note `Service` and `index.ts` wiring land in Tasks 8/10, so this file typechecks once those exist; if running standalone, expect `Service` import to resolve from Task 8).
Format: `cd apps/desktop && npx biome check --write src/main/calendar/ipc.ts`
Commit:

```bash
git add apps/desktop/src/main/calendar/ipc.ts
git commit -m "feat(calendar): wire renderer IPC + main-rpc handlers"
```

---

### Task 10: `index.ts` (`initCalendar`) + main/service wiring

**Files:**
- Create: `apps/desktop/src/main/calendar/index.ts`
- Modify: `apps/desktop/src/main/index.ts` (imports + init + dispose + registerMainRpc)
- Modify: `apps/desktop/src/service/tools/builtins.ts` (add `calendarMainRpc` dep + registration)
- Modify: `apps/desktop/src/service/index.ts:128-137` (pass `calendarMainRpc`)

**Interfaces:**
- Produces: `initCalendar(): Promise<CalendarHandle>`. Wires store→auth→api→cache→daemon→service→ipc.

- [ ] **Step 1: Create `index.ts`**

Create `apps/desktop/src/main/calendar/index.ts`:

```ts
// src/main/calendar/index.ts
//
// Entry point for the Calendar subsystem. Mirrors gmail/index.ts. Runs after
// app.whenReady(); registerMainRpc is called from main wiring once the
// ServiceClient exists.
import type { MainMethod } from '@swarm/protocol'

import { paths } from '../constants'
import { createApi } from './api'
import { createAuth } from './auth'
import { createCache } from './cache'
import { createDaemon } from './daemon'
import { wireCalendarIpc } from './ipc'
import { createService, type Service } from './service'
import { createStore } from './store'

type MainRpcClient = {
  registerMainRpc(method: MainMethod, fn: (...args: unknown[]) => Promise<unknown>): void
}

export type CalendarHandle = {
  service: Service
  registerMainRpc(client: MainRpcClient): void
  dispose(): void
}

export async function initCalendar(): Promise<CalendarHandle> {
  const store = createStore({ filePath: paths.calendar() })
  const cache = createCache({ filePath: paths.calendarDb() })
  const auth = createAuth({
    store,
    onProfile: async (token) => {
      // The primary calendar id IS the user's email address.
      const api = createApi({ getAccessToken: async () => token, refreshAccessToken: async () => {} })
      const emailAddress = await api.getPrimaryCalendarEmail()
      return { emailAddress }
    },
  })
  const api = createApi(auth)
  const daemon = createDaemon({ api, cache })
  const service = await createService({ store, cache, auth, daemon })
  const wired = wireCalendarIpc({ service })

  return {
    service,
    registerMainRpc(client) {
      ;(Object.keys(wired.mainRpcHandlers) as Array<keyof typeof wired.mainRpcHandlers>).forEach(
        (method) => {
          client.registerMainRpc(method, wired.mainRpcHandlers[method])
        }
      )
    },
    dispose() {
      wired.dispose()
      daemon.stop()
      cache.close()
    },
  }
}
```

- [ ] **Step 2: Wire `initCalendar` into main startup**

In `apps/desktop/src/main/index.ts`:
- Add import (after line 10, the gmail import):
  ```ts
  import { initCalendar } from './calendar'
  ```
- After the gmail init block (after line 74), add:
  ```ts
  const calendar = await initCalendar()
  log.info({ msg: 'calendar sidecar initialised' })
  ```
- In the `before-quit` handler (after `gmail.dispose()` at line 83), add `calendar.dispose()`.
- After `gmail.registerMainRpc(serviceClient)` (line 135), add:
  ```ts
  calendar.registerMainRpc(serviceClient)
  ```

- [ ] **Step 3: Add `calendarMainRpc` to `registerBuiltinTools`**

In `apps/desktop/src/service/tools/builtins.ts`:
- Add to the `deps` type (next to `gmailMainRpc`, ~line 70):
  ```ts
  /** Service-side client for calendar.* mainRequest/mainResponse calls. */
  calendarMainRpc?: (method: import('@swarm/protocol').MainMethod, args: unknown[]) => Promise<unknown>
  ```
- After the gmail registration line (`if (deps?.gmailMainRpc) ...`, ~line 109), add:
  ```ts
  // calendar.* tools need the service->main rpc to query/mutate the cache.
  if (deps?.calendarMainRpc)
    for (const spec of calendarSpecs(deps.calendarMainRpc)) registry.register(spec)
  ```
- Add the import at the top (next to the gmail import, line 5):
  ```ts
  import { calendarSpecs } from '../calendar/tools'
  ```

- [ ] **Step 4: Pass `calendarMainRpc` from `service/index.ts`**

In `apps/desktop/src/service/index.ts`, in the `registerBuiltinTools` call (line 128-137), after `gmailMainRpc: mainRpc.mainRpc,` (line 136), add:
```ts
  calendarMainRpc: mainRpc.mainRpc,
```

- [ ] **Step 5: Typecheck + format**

Run: `cd apps/desktop && npx tsc --noEmit -p tsconfig.json`
> The `calendarSpecs` import resolves in Task 11. Either implement Task 11 first or temporarily comment the registration line to typecheck — but the natural order is Task 10 + Task 11 together. Run typecheck again after Task 11.
Format: `cd apps/desktop && npx biome check --write src/main/calendar/index.ts src/main/index.ts src/service/tools/builtins.ts src/service/index.ts`

- [ ] **Step 6: Commit**

```bash
git add apps/desktop/src/main/calendar/index.ts apps/desktop/src/main/index.ts apps/desktop/src/service/tools/builtins.ts apps/desktop/src/service/index.ts
git commit -m "feat(calendar): wire initCalendar into main + register calendarMainRpc"
```

---

## Phase 3 — Agent tools

### Task 11: `calendar.*` tool specs

**Files:**
- Create: `apps/desktop/src/service/calendar/tools.ts`
- Test: `apps/desktop/src/service/calendar/tools.test.ts`

**Interfaces:**
- Consumes: `mainRpc` fn (passed via `calendarMainRpc`).
- Produces: `calendarSpecs(mainRpc): ToolSpec[]` (5 specs, `group: 'calendar'`).

- [ ] **Step 1: Write the failing test**

Create `apps/desktop/src/service/calendar/tools.test.ts`:

```ts
import { describe, expect, it, vi } from 'vitest'

import { calendarSpecs } from './tools'

function build(specName: string, mainRpc: ReturnType<typeof vi.fn>) {
  const specs = calendarSpecs(mainRpc)
  const spec = specs.find((s) => s.name === specName)!
  return spec.build()
}

describe('calendar tools', () => {
  it('list_upcoming renders events returned by mainRpc', async () => {
    const mainRpc = vi.fn().mockResolvedValue([
      { title: 'Standup', startMs: 1000, endMs: 2000, location: 'Zoom', source: 'google' },
    ])
    const tool = build('list_upcoming', mainRpc)
    const out = await tool.execute('id', { days: 7 })
    expect(mainRpc).toHaveBeenCalledWith('calendar.list_upcoming', [7])
    expect(out.content[0].text).toContain('Standup')
  })

  it('create_local forwards the input', async () => {
    const mainRpc = vi.fn().mockResolvedValue({ id: 'x', title: 'M', source: 'local' })
    const tool = build('create_local', mainRpc)
    await tool.execute('id', { title: 'M', startMs: 1, endMs: 2 })
    expect(mainRpc).toHaveBeenCalledWith('calendar.create_local', [
      { title: 'M', startMs: 1, endMs: 2 },
    ])
  })

  it('delete_local forwards id and surfaces errors', async () => {
    const mainRpc = vi.fn().mockResolvedValue(true)
    const tool = build('delete_local', mainRpc)
    const out = await tool.execute('id', { id: 'abc' })
    expect(mainRpc).toHaveBeenCalledWith('calendar.delete_local', ['abc'])
    expect(out.content[0].text).toContain('deleted')
  })
})
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd apps/desktop && npx vitest run src/service/calendar/tools.test.ts`
Expected: FAIL — `./tools` not found.

- [ ] **Step 3: Write the implementation**

Create `apps/desktop/src/service/calendar/tools.ts`:

```ts
// src/service/calendar/tools.ts
//
// calendar.* built-in tools. Reads (list_upcoming, get_event) are low risk;
// local mutations (create/update/delete_local) are medium. Google is never
// written. Each tool is a thin client over the local cache via the
// service->main rpc.
import type { AgentTool } from '@earendil-works/pi-agent-core'
import { Type } from '@earendil-works/pi-ai'
import type { MainMethod } from '@swarm/protocol'

import type { ToolSpec } from '../tools/registry'

type MainRpcFn = (method: MainMethod, args: unknown[]) => Promise<unknown>
type Result = { content: [{ type: 'text'; text: string }]; details: Record<string, unknown> }
const ok = (text: string, details: Record<string, unknown> = {}): Result => ({
  content: [{ type: 'text', text }],
  details,
})
const err = (message: string): Result => ok(`error: ${message}`, { error: message })

function fmtTime(ms: number): string {
  return new Date(ms).toLocaleString()
}

function renderEvent(e: {
  title?: string
  startMs?: number
  endMs?: number
  location?: string | null
  source?: string
  allDay?: boolean
}): string {
  const when = e.allDay ? '(all day)' : `${fmtTime(e.startMs ?? 0)} → ${fmtTime(e.endMs ?? 0)}`
  return `• [${e.source ?? ''}] ${e.title ?? '(untitled)'}\n  ${when}${e.location ? ` @ ${e.location}` : ''}`
}

const ListParams = Type.Object({
  days: Type.Optional(Type.Number({ description: 'Forward window in days (default 14).' })),
})
const GetParams = Type.Object({ id: Type.String({ description: 'Event id.' }) })
const CreateParams = Type.Object({
  title: Type.String({ description: 'Event title.' }),
  startMs: Type.Number({ description: 'Start, epoch ms.' }),
  endMs: Type.Number({ description: 'End, epoch ms.' }),
  allDay: Type.Optional(Type.Boolean({ description: 'All-day flag.' })),
  description: Type.Optional(Type.String({ description: 'Optional description.' })),
  location: Type.Optional(Type.String({ description: 'Optional location.' })),
})
const UpdateParams = Type.Object({
  id: Type.String({ description: 'Local event id.' }),
  title: Type.Optional(Type.String()),
  startMs: Type.Optional(Type.Number()),
  endMs: Type.Optional(Type.Number()),
  allDay: Type.Optional(Type.Boolean()),
  description: Type.Optional(Type.String()),
  location: Type.Optional(Type.String()),
})
const DeleteParams = Type.Object({ id: Type.String({ description: 'Local event id.' }) })

export function calendarSpecs(mainRpc: MainRpcFn): ToolSpec[] {
  const listUpcoming: ToolSpec = {
    group: 'calendar',
    name: 'list_upcoming',
    risk: 'low',
    source: 'builtin',
    build: (): AgentTool => ({
      name: 'list_upcoming',
      label: 'List upcoming calendar',
      description:
        'List upcoming calendar events (Google + local) within a forward window (default 14 days). Returns title, time, location, source.',
      parameters: ListParams,
      execute: async (_id, params) => {
        const p = (params as { days?: number }) ?? {}
        try {
          const rows = (await mainRpc('calendar.list_upcoming', [p.days ?? 14])) as unknown[]
          if (rows.length === 0) return ok('(no upcoming events)', { count: 0 })
          return ok(rows.map((r) => renderEvent(r as Parameters<typeof renderEvent>[0])).join('\n'), {
            count: rows.length,
          })
        } catch (e) {
          return err(e instanceof Error ? e.message : String(e))
        }
      },
    }),
  }

  const getEvent: ToolSpec = {
    group: 'calendar',
    name: 'get_event',
    risk: 'low',
    source: 'builtin',
    build: (): AgentTool => ({
      name: 'get_event',
      label: 'Get calendar event',
      description: 'Return a single calendar event by id (from either Google cache or local).',
      parameters: GetParams,
      execute: async (_id, params) => {
        const id = ((params as { id?: string })?.id ?? '').trim()
        if (!id) return err('missing id')
        try {
          const e = (await mainRpc('calendar.get_event', [id])) as Parameters<
            typeof renderEvent
          >[0] | null
          if (!e) return ok('(event not found)', { id })
          return ok(renderEvent(e), { id })
        } catch (e) {
          return err(e instanceof Error ? e.message : String(e))
        }
      },
    }),
  }

  const createLocal: ToolSpec = {
    group: 'calendar',
    name: 'create_local',
    risk: 'medium',
    source: 'builtin',
    build: (): AgentTool => ({
      name: 'create_local',
      label: 'Create local calendar event',
      description:
        'Create an event on the app-local calendar (not Google). Use for reminders/schedules the agent owns.',
      parameters: CreateParams,
      execute: async (_id, params) => {
        const p = params as {
          title?: string
          startMs?: number
          endMs?: number
          allDay?: boolean
          description?: string | null
          location?: string | null
        }
        if (!p.title || p.startMs == null || p.endMs == null) return err('title, startMs, endMs required')
        const input = {
          title: p.title,
          startMs: p.startMs,
          endMs: p.endMs,
          allDay: p.allDay,
          description: p.description,
          location: p.location,
        }
        try {
          const e = (await mainRpc('calendar.create_local', [input])) as { id?: string }
          return ok(`created local event (${e.id ?? '?'})`, { id: e.id })
        } catch (e) {
          return err(e instanceof Error ? e.message : String(e))
        }
      },
    }),
  }

  const updateLocal: ToolSpec = {
    group: 'calendar',
    name: 'update_local',
    risk: 'medium',
    source: 'builtin',
    build: (): AgentTool => ({
      name: 'update_local',
      label: 'Update local calendar event',
      description: 'Update fields of a local calendar event by id (Google events cannot be edited from here).',
      parameters: UpdateParams,
      execute: async (_id, params) => {
        const p = (params as { id?: string } & Record<string, unknown>) ?? {}
        const id = (p.id ?? '').toString()
        if (!id) return err('missing id')
        const { id: _omit, ...patch } = p
        try {
          const e = (await mainRpc('calendar.update_local', [id, patch])) as { id?: string } | null
          if (!e) return ok('(local event not found)', { id })
          return ok(`updated local event (${e.id})`, { id: e.id })
        } catch (e) {
          return err(e instanceof Error ? e.message : String(e))
        }
      },
    }),
  }

  const deleteLocal: ToolSpec = {
    group: 'calendar',
    name: 'delete_local',
    risk: 'medium',
    source: 'builtin',
    build: (): AgentTool => ({
      name: 'delete_local',
      label: 'Delete local calendar event',
      description: 'Delete a local calendar event by id (Google events cannot be deleted from here).',
      parameters: DeleteParams,
      execute: async (_id, params) => {
        const id = ((params as { id?: string })?.id ?? '').trim()
        if (!id) return err('missing id')
        try {
          const removed = (await mainRpc('calendar.delete_local', [id])) as boolean
          return ok(removed ? `deleted local event ${id}` : `(not found: ${id})`, { id, removed })
        } catch (e) {
          return err(e instanceof Error ? e.message : String(e))
        }
      },
    }),
  }

  return [listUpcoming, getEvent, createLocal, updateLocal, deleteLocal]
}
```

- [ ] **Step 4: Run test + typecheck + commit**

Run: `cd apps/desktop && npx vitest run src/service/calendar/tools.test.ts` (Expected: PASS).
Run: `cd apps/desktop && npx tsc --noEmit -p tsconfig.json` (Expected: no errors — resolves Task 10's forward reference).
Format: `cd apps/desktop && npx biome check --write src/service/calendar/tools.ts src/service/calendar/tools.test.ts`
Commit:

```bash
git add apps/desktop/src/service/calendar/tools.ts apps/desktop/src/service/calendar/tools.test.ts
git commit -m "feat(calendar): add calendar.* agent tools"
```

---

## Phase 4 — Renderer

### Task 12: `window.swarm.calendar` preload bridge

**Files:**
- Modify: `apps/desktop/src/preload/index.ts` (imports + `calendar` block + add to `swarm`)

**Interfaces:**
- Produces: `window.swarm.calendar` matching `CalendarBridge`.

- [ ] **Step 1: Add type imports**

In the `import type { ... } from '@swarm/protocol'` block (lines 2-57), add:
```ts
  CalendarBridge,
  CalendarClientCreds,
  CalendarConfigView,
  CalendarLocalInput,
  CalendarSetResult,
  CalendarEvent,
```

- [ ] **Step 2: Add the `calendar` block**

After the `gmail` block (after line 244), add:
```ts
const calendar: CalendarBridge = {
  getStatus: () => ipcRenderer.invoke('calendar:getStatus') as Promise<CalendarConfigView>,
  setClientCreds: (creds: CalendarClientCreds) =>
    ipcRenderer.invoke('calendar:setClientCreds', creds) as Promise<CalendarSetResult>,
  clearClientCreds: () => ipcRenderer.invoke('calendar:clearClientCreds') as Promise<unknown>,
  linkAccount: () => ipcRenderer.invoke('calendar:linkAccount') as Promise<CalendarSetResult>,
  unlinkAccount: () => ipcRenderer.invoke('calendar:unlinkAccount') as Promise<unknown>,
  syncNow: () => ipcRenderer.invoke('calendar:syncNow') as Promise<void>,
  listInRange: (fromMs: number, toMs: number) =>
    ipcRenderer.invoke('calendar:listInRange', fromMs, toMs) as Promise<CalendarEvent[]>,
  createLocal: (input: CalendarLocalInput) =>
    ipcRenderer.invoke('calendar:createLocal', input) as Promise<CalendarEvent>,
  updateLocal: (id: string, patch: Partial<CalendarLocalInput>) =>
    ipcRenderer.invoke('calendar:updateLocal', id, patch) as Promise<CalendarEvent | null>,
  deleteLocal: (id: string) => ipcRenderer.invoke('calendar:deleteLocal', id) as Promise<boolean>,
  onStateChanged: (cb: (view: CalendarConfigView) => void) => {
    const listener = (_e: unknown, view: CalendarConfigView): void => cb(view)
    ipcRenderer.on('calendar:stateChanged', listener)
    return () => {
      ipcRenderer.removeListener('calendar:stateChanged', listener)
    }
  },
}
```

- [ ] **Step 3: Register it on `swarm`**

In the `swarm: SwarmBridge` object, after `gmail,` (line 334), add `calendar,`. Also add `calendar: CalendarBridge` to the `SwarmBridge` type in `packages/protocol/src/types/ui.ts` (find the `SwarmBridge` type and add the field next to `gmail: GmailBridge`).

- [ ] **Step 4: Typecheck + format + commit**

Run: `cd apps/desktop && npx tsc --noEmit -p tsconfig.json` (Expected: no errors).
Format: `cd apps/desktop && npx biome check --write src/preload/index.ts`
Commit:

```bash
git add apps/desktop/src/preload/index.ts packages/protocol/src/types/ui.ts
git commit -m "feat(preload): expose window.swarm.calendar bridge"
```

---

### Task 13: `CalendarSettingsView` + Settings nav entry

**Files:**
- Create: `apps/desktop/src/renderer/src/components/views/calendar-view.tsx`
- Modify: `apps/desktop/src/renderer/src/stores/settings-dialog.ts` (union + `SECTIONS`)
- Modify: `apps/desktop/src/renderer/src/components/settings-dialog.tsx` (icon import + view import + nav entry)

**Interfaces:**
- Consumes: `window.swarm.calendar` (Task 12).

- [ ] **Step 1: Create the view (mirror `GmailSettingsView`)**

Create `apps/desktop/src/renderer/src/components/views/calendar-view.tsx` by copying `gmail-view.tsx` and applying these changes:
- Replace `window.swarm.gmail.*` → `window.swarm.calendar.*` everywhere.
- Query key `['gmail', 'status']` → `['calendar', 'status']`.
- State channel `gmail:stateChanged` (inside `onStateChanged`) is already abstracted by the bridge — just swap the bridge object.
- `SettingsHeader` title `Gmail` → `Calendar`; description: scope text `gmail.readonly` → `calendar.readonly`, and mention "read-only Google Calendar fetch + a writable local calendar".
- Status rows: `Cached messages`/`messageCount` → two rows: `Google events`/`googleEventCount` and `Local events`/`localEventCount` (both read from `status`).
- Keep the OAuth-creds Save/Clear, Link/Sync/Unlink buttons identical.

- [ ] **Step 2: Add the Settings section**

In `apps/desktop/src/renderer/src/stores/settings-dialog.ts`:
- Add `'calendar'` to the `SettingsSection` union (after `'gmail'`).
- Add `'calendar'` to the `SECTIONS` array (after `'gmail'`).

- [ ] **Step 3: Render the nav entry + view**

In `apps/desktop/src/renderer/src/components/settings-dialog.tsx`:
- Add `Calendar` to the lucide import (line 2-13).
- Add `import { CalendarSettingsView } from '@/components/views/calendar-view'` (next to the gmail-view import, line 22).
- In the `SECTIONS` array, after the gmail entry (line 36), add:
  ```ts
  { key: 'calendar', label: 'Calendar', icon: Calendar, View: CalendarSettingsView },
  ```

- [ ] **Step 4: Typecheck + format + commit**

Run: `cd apps/desktop && npx tsc --noEmit -p tsconfig.json` (Expected: no errors).
Format: `cd apps/desktop && npx biome check --write src/renderer/src/components/views/calendar-view.tsx src/renderer/src/stores/settings-dialog.ts src/renderer/src/components/settings-dialog.tsx`
Commit:

```bash
git add apps/desktop/src/renderer/src/components/views/calendar-view.tsx apps/desktop/src/renderer/src/stores/settings-dialog.ts apps/desktop/src/renderer/src/components/settings-dialog.tsx
git commit -m "feat(renderer): add Calendar settings panel (Google OAuth + local CRUD status)"
```

---

### Task 14: `use-calendar.ts` hook + merge events into `ScheduledCalendarView`

**Files:**
- Create: `apps/desktop/src/renderer/src/hooks/use-calendar.ts`
- Modify: `apps/desktop/src/renderer/src/components/views/scheduled-calendar-view.tsx`

**Interfaces:**
- Consumes: `window.swarm.calendar` (Task 12). Produces: `useCalendarEvents(from, to)`, `useCreateLocalEvent`, `useDeleteLocalEvent`.

- [ ] **Step 1: Create the hooks**

Create `apps/desktop/src/renderer/src/hooks/use-calendar.ts`:

```ts
import type { CalendarEvent, CalendarLocalInput } from '@swarm/protocol'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'

export const CALENDAR_RANGE_KEY = (fromMs: number, toMs: number): unknown[] => [
  'calendar',
  'range',
  fromMs,
  toMs,
]

// Invalidate every 'calendar' query (status + any range). Used after local
// CRUD and on calendar:stateChanged pushes from main.
function invalidateCalendar(qc: ReturnType<typeof useQueryClient>): Promise<void> {
  return qc.invalidateQueries({ queryKey: ['calendar'] })
}

export function useCalendarEvents(from: Date, to: Date) {
  return useQuery<CalendarEvent[]>({
    queryKey: CALENDAR_RANGE_KEY(from.getTime(), to.getTime()),
    queryFn: () => window.swarm.calendar.listInRange(from.getTime(), to.getTime()),
  })
}

export function useCreateLocalEvent() {
  const qc = useQueryClient()
  return useMutation({
    mutationFn: (input: CalendarLocalInput) => window.swarm.calendar.createLocal(input),
    onSuccess: () => invalidateCalendar(qc),
  })
}

export function useDeleteLocalEvent() {
  const qc = useQueryClient()
  return useMutation({
    mutationFn: (id: string) => window.swarm.calendar.deleteLocal(id),
    onSuccess: () => invalidateCalendar(qc),
  })
}
```

- [ ] **Step 2: Feed `calendar:stateChanged` into react-query**

In the component that already subscribes to gmail events (search `apps/desktop/src/renderer/src/hooks/use-events-subscription.ts` for the `gmail.onStateChanged` wiring), add a parallel subscription:
```ts
window.swarm.calendar.onStateChanged((view) => {
  void qc.setQueryData(['calendar', 'status'], view)
  void qc.invalidateQueries({ queryKey: ['calendar', 'range'] })
})
```
(If `use-events-subscription.ts` is the single events wiring point, add it there; mirror the exact gmail subscription shape already present. This keeps the panel and the grid live without manual refetch.)

- [ ] **Step 3: Add the `event` DayItem + merge in `ScheduledCalendarView`**

In `apps/desktop/src/renderer/src/components/views/scheduled-calendar-view.tsx`:

(a) Extend the `DayItem` union (around line 27):
```ts
type DayItem =
  | { kind: 'run'; at: Date; run: CronRun; task: ScheduledTask | undefined }
  | { kind: 'projection'; at: Date; task: ScheduledTask }
  | { kind: 'event'; at: Date; event: CalendarEvent }
```
Add the import: `import type { CalendarEvent } from '@swarm/protocol'`.

(b) Inside `ScheduledCalendarView`, after the `useAllCronRuns()` line (line 50), add:
```ts
const { data: events = [] } = useCalendarEvents(gridStart, gridEnd)
const createLocal = useCreateLocalEvent()
const deleteLocal = useDeleteLocalEvent()
```
Add the import: `import { useCalendarEvents, useCreateLocalEvent, useDeleteLocalEvent } from '@/hooks/use-calendar'`.

(c) In the `itemsByDay` memo (after the projections loop, before the `sortBy`), push events:
```ts
for (const ev of events) {
  const at = new Date(ev.startMs)
  if (at < gridStart || at > gridEnd) continue
  push(at, { kind: 'event', at, event: ev })
}
```
Then extend the `sortBy` to also order `event` items by `at` (they already share `.at`, so the existing `(i) => i.at.getTime()` works — TypeScript may need the memo's `push`/`itemLabel` to handle the new variant; update `itemLabel` below).

(d) Extend `itemLabel` (line 31) to handle events:
```ts
const itemLabel = (it: DayItem): string =>
  it.kind === 'run'
    ? (it.task?.name ?? it.task?.goal ?? '(已删除任务)')
    : it.kind === 'projection'
      ? (it.task.name ?? it.task.goal)
      : it.event.title
```

(e) In the day-cell rendering (the `items.slice(0, 3).map(...)` block, lines ~182-199), add event styling. Extend the `className` ternary and the inner badge:
```tsx
{items.slice(0, 3).map((it, i) => (
  <span
    className={cn(
      'flex items-center gap-1 truncate rounded px-1 text-[10px] leading-tight',
      it.kind === 'run'
        ? 'bg-muted/60 text-foreground/80'
        : it.kind === 'projection'
          ? 'bg-primary/5 text-muted-foreground'
          : it.event.source === 'google'
            ? 'bg-blue-500/10 text-blue-600 dark:text-blue-400'
            : 'bg-violet-500/10 text-violet-600 dark:text-violet-400'
    )}
    key={`${it.at.getTime()}-${i}`}
    title={`${format(it.at, 'HH:mm')} · ${itemLabel(it)}`}
  >
    {it.kind === 'run' ? (
      <span className={cn('shrink-0', runTone(it.run.status))}>●</span>
    ) : it.kind === 'projection' ? (
      <span className="shrink-0 text-muted-foreground/40">○</span>
    ) : (
      <span className="shrink-0">◆</span>
    )}
    <span className="shrink-0 tabular-nums">
      {it.kind === 'event' && it.event.allDay ? '全天' : format(it.at, 'HH:mm')}
    </span>
    <span className="truncate">{itemLabel(it)}</span>
  </span>
))}
```

(f) In the day-detail panel (`selectedItems.map(...)` block, lines ~238-315), handle `event` items. Add a branch: if `it.kind === 'event'`, render the event card (title, time range or 全天, location, source badge) and — for `source === 'local'` — a delete button (`<Trash2>` → `deleteLocal.mutate(it.event.id)`, mirroring the cron cancel button). For `source === 'google'`, render read-only (no delete). Add a 「＋ 新建本地事件」 button at the top of the panel that toggles an inline form (title `<Input>`, two `<Input type="datetime-local">` for start/end) → on submit, `createLocal.mutate({ title, startMs: Date.parse(start), endMs: Date.parse(end) })`. Keep the form minimal — title + start + end are required; location/description omitted in v1.

(g) Update the header count label (line 116): `{totalThisMonth} 次运行` → `{totalThisMonth} 个事项`.

- [ ] **Step 4: Typecheck + format**

Run: `cd apps/desktop && npx tsc --noEmit -p tsconfig.json` (Expected: no errors).
Format: `cd apps/desktop && npx biome check --write src/renderer/src/hooks/use-calendar.ts src/renderer/src/components/views/scheduled-calendar-view.tsx src/renderer/src/hooks/use-events-subscription.ts`

- [ ] **Step 5: Commit**

```bash
git add apps/desktop/src/renderer/src/hooks/use-calendar.ts apps/desktop/src/renderer/src/hooks/use-events-subscription.ts apps/desktop/src/renderer/src/components/views/scheduled-calendar-view.tsx
git commit -m "feat(renderer): merge calendar events into /scheduled view + local CRUD"
```

---

## Phase 5 — Verification

### Task 15: Full typecheck, tests, build, smoke

**Files:** none (verification only).

- [ ] **Step 1: Protocol + desktop typecheck**

```bash
cd packages/protocol && npx tsc --noEmit
cd ../../apps/desktop && npx tsc --noEmit -p tsconfig.json
```
Expected: no errors. If stale `.tsbuildinfo` reports fixed errors, delete `**/*.tsbuildinfo` and re-run (memory `reference_tsc_stale_tsbuildinfo`).

- [ ] **Step 2: Run the calendar test suite**

```bash
cd apps/desktop && npm test -- src/main/calendar src/service/calendar
```
Expected: all calendar tests PASS.

- [ ] **Step 3: Build the desktop app**

```bash
cd apps/desktop && npm run build
```
Expected: build succeeds (catches bundler/type errors tests miss).

- [ ] **Step 4: Smoke run with `run-desktop`**

Launch the app (run-desktop skill). Verify:
1. Settings → **Calendar** panel appears; paste a Google OAuth Desktop client → Save → Link account → status shows the primary-calendar email + `Google events` count after sync.
2. Open **日历** (the `/scheduled` grid, relabelled by Plan A): upcoming Google events appear (blue ◆) and any local events (violet ◆) alongside cron runs/projections.
3. Click a day → 「＋ 新建本地事件」 → enter title + start/end → Save → the violet pill appears; the Settings panel `Local events` count increments.
4. Delete a local event from the day-detail panel → it disappears.
5. From an agent session, call `calendar.list_upcoming` / `calendar.create_local` / `calendar.delete_local` and observe results.
6. Check `~/.swarm-agents/swarm-dev.log` for `calendar-*` component lines at each step (entry, outcome, errors) — the log alone must explain each path.

- [ ] **Step 5: Commit any final format churn**

```bash
git status
# if biome reformatted anything during the run:
git add -A && git commit -m "chore(calendar): format"
```

---

## Self-Review

- **Spec coverage:** §4 data model (Task 1 + Task 3 SQL ✓); §5.1 main slice store/auth/api/cache/daemon/service/ipc/index (Tasks 4-10 ✓); §5.2 paths (Task 2 ✓); §5.3 CalendarBridge (Task 1 + Task 12 ✓); §5.4 tools (Task 11 ✓); §5.5 Settings panel (Task 13 ✓); §5.6 merged view (Task 14 ✓); §5.7 sidebar belongs to Plan A; §6 data flows (list_upcoming Task 11, local CRUD Tasks 8/11/14, sync Task 7, auth Task 5 ✓); §7 sync strategy (Task 7 ✓); §9 v1 scope (write-to-Google/multi-calendar/syncToken/edit-UI explicitly out ✓); §10 logging (each module child logger + no silent catch, called out in Global Constraints ✓); §11 testing (per-module tests Tasks 3-8,11 ✓); §12 sequencing (Plan A first, this rebases — noted in Global Constraints ✓).
- **Type consistency:** `CalendarEvent` field names (`id`, `source`, `sourceId`, `title`, `description`, `location`, `startMs`, `endMs`, `allDay`, `attendees`, `calendarId`) identical across Task 1 schema, Task 3 cache mappers, Task 6 normaliser output (`GoogleEventRow` feeds the same fields via `upsertGoogleEvents`), Task 11 tool rendering, Task 14 view. `LocalEventInput` identical in Task 1 (`CalendarLocalInput`), Task 3, Task 9, Task 11, Task 12, Task 14. `MainMethod` strings (`calendar.list_upcoming` etc.) match between Task 1, Task 9 handlers, Task 11 tool calls. ipcMain.handle channels (`calendar:*`) match between Task 9 and Task 12 preload. `paths.calendar()`/`calendarDb()` (Task 2) match Task 10 usage.
- **No placeholders:** all code blocks complete; mirror tasks name the exact source file + exact diffs; commands given with expected output. One deliberate "run typecheck after Task 11" note in Task 10 because Tasks 10 and 11 are mutually referencing — the plan sequences them consecutively.
