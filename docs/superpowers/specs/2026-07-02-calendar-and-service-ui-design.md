# Calendar Sidecar + Merged Calendar View + Service-Sidebar Restructure — Design Spec

- **Date:** 2026-07-02
- **Status:** Approved (design); pending implementation plan
- **Related:** `CLAUDE.md` §5 (Log Every Business Path), §6 (Worktrees); spec `2026-07-01-gmail-sidecar-design.md` (direct template); memory `project_gmail_sidecar`, `feedback_all_scroll_use_scrollarea`

## 1. Problem

Two related asks:

1. **Calendar.** Agents cannot reach the user's calendar. The user wants to
   **fetch Google Calendar** (read) **and add a local calendar** (writable).
   This is the second external-account sidecar after Gmail and reuses the
   same resident-daemon + local-cache shape. The local calendar must be
   **visible** and is **merged into the existing `/scheduled` (定时任务)
   calendar view** — one unified calendar showing scheduled cron runs
   alongside Google + local events.
2. **Sidebar restructure.** Today the four service shortcuts
   (`/scheduled`, `/usage`, `/trending`, `/bilibili`) sit in a single
   horizontal row in the sidebar footer, next to Settings. The user wants
   **only Settings (and ThemeToggle) at the bottom** and **all service
   shortcuts under "New chat" as a 3-column grid**.

Gmail already proved the sidecar pattern; Calendar mirrors it and extends
the cache with a writable `local_events` table. No visualization is built
for Gmail — but for Calendar the user explicitly wants the local calendar
visualised, folded into the scheduled-tasks calendar.

## 2. Decisions (locked during brainstorming)

| # | Decision | Choice |
|---|----------|--------|
| 1 | Calendar shape | **Google read-only + local read/write**, unified `calendar.*` tools. "获取 google calendar" = read (`calendar.readonly` scope); "增加本地日历" = a writable app-local calendar. Rejected: EventKit (native module, macOS-only, conflicts with the no-native-ABI-rebuild convention — see memory). |
| 2 | Where the daemon lives | **Main process** (Approach B, same as Gmail). Daemon + all calendar logic in `src/main/calendar/`; `calendar.*` tools run in the service `utilityProcess` and query main's cache via the existing `mainRequest`/`mainResponse` channel. |
| 3 | Local calendar store | **sqlite `local_events` table in `calendar.db`** (same DB as the Google cache). Full CRUD. No cloud, no sync — purely app-local. |
| 4 | Google sync scope (v1) | **Primary calendar, forward 90-day window, `singleEvents=true`** (recurring events expanded by Google). Re-list + UPSERT (idempotent), 30-min poll. Multi-calendar and true incremental sync are fast-follows. |
| 5 | Agent tools | **5 tools, `group: 'calendar'`**: `list_upcoming` / `get_event` (low risk, read); `create_local` / `update_local` / `delete_local` (medium risk, mutate local only). Google is never written from the app. |
| 6 | Visualization | **Merge into `/scheduled`'s `ScheduledCalendarView`** — no new `/calendar` route. The month grid gains a new `DayItem` kind `event`; Google + local events render alongside cron runs/projections, color-coded by source. |
| 7 | Local-event UI CRUD | **View + create + delete** local events from the merged calendar (inline create form in the day-detail panel; per-event delete button, matching the existing cron cancel button). Edit is delete+recreate or the agent's `update_local` tool. Google events are read-only on the view. |
| 8 | Sidebar restructure | **3-column grid under "New chat"** for the four service shortcuts; **footer keeps only Settings + ThemeToggle**. The inline service JSX is extracted into a `{ icon, to, label }[]` array (a registry does not exist today) — this is the necessary prerequisite for the grid, not scope creep. |
| 9 | Sidebar relabel | The `/scheduled` shortcut tooltip changes 「定时任务」→「日历」 because the view now also shows calendar events. The route path `/scheduled` is unchanged (deep-link/menu IPC depends on it). |

## 3. Architecture

### 3.1 Calendar sidecar (mirrors Gmail; new writable table)

```
┌─ Main process (Electron) ─────────────────────────────────────────┐
│  src/main/calendar/  (new feature slice; ALL calendar logic in main)│
│   ├ store.ts     OAuth client creds + tokens (safeStorage)          │
│   ├ auth.ts      loopback HTTP → code→token exchange → refresh      │
│   ├ api.ts       Google Calendar REST (fetch; 401→refresh→retry)    │
│   ├ cache.ts     calendar.db: google_events (ro cache) +            │
│   │              local_events (rw) + sync_state  (better-sqlite3)   │
│   ├ daemon.ts    resident setInterval poll (api → upsert google)    │
│   ├ service.ts   config state machine + query/CRUD facade           │
│   ├ ipc.ts       renderer IPC + registers service→main handlers     │
│   └ index.ts     wiring; starts at app 'ready'                      │
└────────────────────────────── ▲ mainRequest ────────────────────────┘
                                 │ existing channel (gmail already uses)
┌─ Service utilityProcess ──────┘▼────────────────────────────────────┐
│  src/service/calendar/tools.ts   calendar.* ToolSpecs (→ call mainRpc)│
│  registerBuiltinTools(... calendarMainRpc ...)  in builtins.ts        │
└──────────────────────────────────────────────────────────────────────┘
```

### 3.2 Renderer

```
ScheduledCalendarView  (existing /scheduled view, now unified)
  ├ useAllCronJobs / useAllCronRuns       (existing — cron runs + projections)
  ├ useCalendarEvents(gridStart, gridEnd) (NEW — google + local in range)
  ├ itemsByDay merges: run | projection | event
  └ day-detail panel: cron items (existing) + event items (NEW)
       └ local events: inline create form + delete button

CalendarSettingsView  (NEW Settings panel — Google OAuth creds/link/sync)
window.swarm.calendar.*  (NEW preload bridge, mirrors window.swarm.gmail)

AppSidebar / SessionList  (restructured)
  ├ "New chat"  (top, unchanged)
  ├ [NEW] 3-col grid of service shortcuts {scheduled, usage, trending, bilibili}
  ├ ...session list...
  └ SidebarFooter: Settings + ThemeToggle  (shortcuts moved out)
```

### 3.3 Wire-protocol additions (`packages/protocol/src/types/service-ipc.ts`)

`MainMethod` already exists (Gmail added it). Calendar extends the union:

```ts
export type MainMethod =
  | 'gmail.search' | 'gmail.get_thread' | 'gmail.list_recent'
  // NEW:
  | 'calendar.list_upcoming'
  | 'calendar.get_event'
  | 'calendar.create_local'
  | 'calendar.update_local'
  | 'calendar.delete_local'
```

No new message shapes — `mainRequest`/`mainResponse` are reused.

## 4. Data Model

### 4.1 `packages/protocol/src/types/calendar.ts` (new)

```ts
import { z } from 'zod'

// OAuth client credentials the user pastes into Settings (same shape as Gmail).
export const CalendarClientCredsSchema = z.object({
  clientId: z.string().min(1),
  clientSecret: z.string().min(1),
})
export type CalendarClientCreds = z.infer<typeof CalendarClientCredsSchema>

export const CalendarTokensSchema = z.object({
  accessToken: z.string(),
  refreshToken: z.string(),
  expiresAt: z.number().int(),
})
export type CalendarTokens = z.infer<typeof CalendarTokensSchema>

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
  id: z.string(),                       // local: uuid; google: cache pk
  source: z.enum(['google', 'local']),
  sourceId: z.string().nullable(),      // Google event id; null for local
  title: z.string(),
  description: z.string().nullable(),
  location: z.string().nullable(),
  startMs: z.number().int(),
  endMs: z.number().int(),
  allDay: z.boolean(),
  attendees: z.array(z.string()).default([]),
  calendarId: z.string().nullable(),    // 'primary' for google; null for local
})
export type CalendarEvent = z.infer<typeof CalendarEventSchema>
```

### 4.2 `calendar.db` (sqlite, under `userData/`, main-only writer, WAL)

```sql
CREATE TABLE google_events (
  id           TEXT PRIMARY KEY,        -- '{calendarId}:{sourceId}'
  sourceId     TEXT,                    -- Google event id
  calendarId   TEXT,                    -- 'primary' (v1)
  title        TEXT,
  description  TEXT,
  location     TEXT,
  startMs      INTEGER,
  endMs        INTEGER,
  allDay       INTEGER,
  attendees    TEXT,                     -- JSON array of emails
  updatedAt    INTEGER
);
CREATE INDEX idx_google_events_start ON google_events(startMs);
CREATE INDEX idx_google_events_end   ON google_events(endMs);

CREATE TABLE local_events (
  id           TEXT PRIMARY KEY,        -- uuid
  title        TEXT,
  description  TEXT,
  location     TEXT,
  startMs      INTEGER,
  endMs        INTEGER,
  allDay       INTEGER,
  attendees    TEXT,
  createdAt    INTEGER,
  updatedAt    INTEGER
);
CREATE INDEX idx_local_events_start ON local_events(startMs);
CREATE INDEX idx_local_events_end   ON local_events(endMs);

CREATE TABLE sync_state (key TEXT PRIMARY KEY, value TEXT);
```

`listInRange(fromMs, toMs)` returns the union of `google_events` and
`local_events` whose `[startMs, endMs]` overlaps `[fromMs, toMs]`, mapped to
`CalendarEvent` with `source` set accordingly.

## 5. Components

### 5.1 Main — `src/main/calendar/*`

**`store.ts`** — Encrypted on-disk store for `CalendarConfigOnDisk`.
1:1 mirror of `gmail/store.ts` (safeStorage, atomic tmp→rename, Zod-validate,
serialised save queue). Different file path (`paths.calendar()`).

**`auth.ts`** — `createAuth({ store, onProfile })`. Mirror of `gmail/auth.ts`
with two constants changed:
- `SCOPE = 'https://www.googleapis.com/auth/calendar.readonly'`
- `onProfile(token)`: `GET calendar-json.googleapis.com/calendar/v3/users/me/calendarList`,
  return the `id` of the entry with `primary: true` as the account email
  (Google's primary-calendar id is the user's email address — this avoids
  needing a separate `userinfo.email` scope).

Same loopback-server code-exchange + refresh flow, 5-min deadline.

**`api.ts`** — Hand-rolled Google Calendar REST client (`fetch`).
`listUpcoming({ calendarId: 'primary', fromMs, toMs, maxResults? })` →
`GET .../calendars/primary/events?singleEvents=true&timeMin=…&timeMax=…&orderBy=startTime`.
Sets `Authorization: Bearer {accessToken}`; on 401 → refresh → retry once; on
429/5xx → exponential backoff (max 3). Normalises the Google event JSON →
`CalendarEvent` (source `'google'`, `calendarId`, parses `start.dateTime` /
`start.date` → `startMs`/`endMs` + `allDay`, attendees → email array).

**`cache.ts`** — Opens `calendar.db`. Methods:
- `upsertGoogleEvents(rows)` — idempotent UPSERT.
- `listInRange(fromMs, toMs): CalendarEvent[]` — union query, both tables.
- `getEvent(id): CalendarEvent | null`.
- `createLocal(input): CalendarEvent` — inserts a uuid row, returns it.
- `updateLocal(id, patch): CalendarEvent | null`.
- `deleteLocal(id): boolean`.
- `stats(): { googleCount, localCount, lastSyncAt }` / `setStats(...)`.

**`daemon.ts`** — `createDaemon({ api, cache })`. `start()` → immediate poll +
`setInterval(poll, 30min)`. `pollOnce()`: `api.listUpcoming({ fromMs: now,
toMs: now + 90d, maxResults: 250 })` → `cache.upsertGoogleEvents` →
`setStats` → `fireSynced({ count, ts })`. Same `onSynced(cb)` listener shape
as Gmail. **Gap (v1):** re-list + UPSERT does not track deletions or events
beyond 90 days; `fireSynced` payload carries `windowDays: 90` so the limit is
visible.

**`service.ts`** — Config state machine (mirror `gmail/service.ts`):
`setClientCreds`, `clearClientCreds`, `linkAccount`, `unlinkAccount`,
`syncNow`, `getView()`, `onStateChanged(cb)`. Query/CRUD facade delegating to
the cache: `listInRange(fromMs, toMs)`, `getEvent(id)`, `createLocal`,
`updateLocal`, `deleteLocal`. `getView()` reports
`googleEventCount`/`localEventCount` from `cache.stats()`. Starts/stops the
daemon on link/unlink; mirrors cached config for synchronous `getView()`.

**`ipc.ts`** — `wireCalendarIpc({ service })`. Mirror of `wireGmailIpc`:
- Broadcasts `calendar:stateChanged` to all windows on state change.
- `ipcMain.handle`: `calendar:getStatus`, `calendar:setClientCreds`,
  `calendar:clearClientCreds`, `calendar:linkAccount`,
  `calendar:unlinkAccount`, `calendar:syncNow`, `calendar:listInRange`,
  `calendar:createLocal`, `calendar:updateLocal`, `calendar:deleteLocal`.
- `mainRpcHandlers` for the agent tools:
  `'calendar.list_upcoming' | 'calendar.get_event' | 'calendar.create_local' | 'calendar.update_local' | 'calendar.delete_local'`.

**`index.ts`** — `initCalendar(): Promise<CalendarHandle>` wiring (store →
auth → api → cache → daemon → service → ipc). Returns
`{ service, registerMainRpc(client), dispose() }`. Called from main's
app-ready wiring alongside `initGmail`.

### 5.2 Paths (`src/main/constants.ts`)

Add to `paths`:
```ts
calendar: () => join(app.getPath('userData'), 'calendar.enc'),
calendarDb: () => join(app.getPath('userData'), 'calendar.db'),
```

### 5.3 Protocol bridge type (`packages/protocol/src/types/ui.ts`)

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
Exported via the package barrel; preload exposes `window.swarm.calendar`
mirroring `window.swarm.gmail` (same `contextBridge.exposeInMainWorld` shape).

### 5.4 Agent tools (`src/service/calendar/tools.ts`)

`calendarSpecs(mainRpc): ToolSpec[]`, `group: 'calendar'`, `source: 'builtin'`:

| name | risk | params → mainRpc call |
|---|---|---|
| `list_upcoming` | low | `{ days?: number }` → `mainRpc('calendar.list_upcoming', [days ?? 14])` (service maps to `listInRange(now, now+days*86400000)`) |
| `get_event` | low | `{ id }` → `mainRpc('calendar.get_event', [id])` |
| `create_local` | medium | `{ title, startMs, endMs, allDay?, description?, location? }` → `mainRpc('calendar.create_local', [input])` |
| `update_local` | medium | `{ id, ...patch }` → `mainRpc('calendar.update_local', [id, patch])` |
| `delete_local` | medium | `{ id }` → `mainRpc('calendar.delete_local', [id])` |

Each `build()` returns a pi `AgentTool` whose `execute` calls `mainRpc` and
renders rows as readable text (title — start→end — location; `source` badge).
Errors surface as tool error text (mirror `gmail/tools.ts` `ok`/`err`).

**Registration** (`src/service/tools/builtins.ts`): add a `calendarMainRpc`
dep (mirror the `gmailMainRpc` line) and
`if (deps?.calendarMainRpc) for (const spec of calendarSpecs(deps.calendarMainRpc)) registry.register(spec)`.
The main wiring passes the same `mainRpc` fn it already builds for Gmail.

### 5.5 Settings panel (`src/renderer/src/components/views/calendar-view.tsx`)

`CalendarSettingsView` — 1:1 mirror of `GmailSettingsView`: paste OAuth
Desktop client creds → Save/Clear → Link account / Sync now / Unlink → live
status (`onStateChanged` → react-query cache). Help text references scope
`calendar.readonly` and the same Google Cloud "Desktop app" + Testing-mode +
test-user recipe. Status rows show account, cached Google events, local
events, last sync, sync error.

**Wiring** (`stores/settings-dialog.ts`): add `'calendar'` to the
`SettingsSection` union and `SECTIONS` array. `settings-dialog.tsx` renders
`<CalendarSettingsView />` for that section (mirror the Gmail branch).

### 5.6 Merged calendar view (`scheduled-calendar-view.tsx`)

The existing month grid becomes a unified calendar.

- **New `DayItem` kind:** `{ kind: 'event'; at: Date; event: CalendarEvent }`
  (alongside `run` and `projection`). `at` = `new Date(event.startMs)`.
- **New hook** `useCalendarEvents(from: Date, to: Date)` in
  `src/renderer/src/hooks/use-calendar.ts` (mirror `use-cron.ts`):
  `useQuery({ queryKey: ['calendar','range', from.getTime(), to.getTime()],
  queryFn: () => window.swarm.calendar.listInRange(from.getTime(), to.getTime()) })`.
  Invalidated on `calendar:stateChanged`.
- **Merge:** in the `itemsByDay` memo, after runs/projections, push each
  returned event whose `startMs` is within `[gridStart, gridEnd]`.
- **Color coding** in day cells: `run` = status color (existing),
  `projection` = hollow muted (existing), `event` source `google` = blue dot,
  `event` source `local` = violet dot. Event pill shows `HH:mm` + truncated
  title; `allDay` events show an "全天" tag instead of a time.
- **Day-detail panel:** render `event` items (title, time range, location,
  source badge). Local events get a delete button (Trash2 →
  `window.swarm.calendar.deleteLocal(id)`, mirrors the cron cancel button).
  A 「＋ 新建本地事件」 button at the panel top expands an inline mini-form
  (title + start datetime + end datetime; optional location) →
  `createLocal` → invalidate the range query. Google events are read-only.
- **Header count:** 「N 次运行」→ 「N 个事项」(items now include events).

### 5.7 Sidebar restructure (`app-sidebar.tsx`, `session-list.tsx`)

- **Extract a services array** (today these are inline `<Link>` blocks in
  `SidebarFooter`):
  ```ts
  const SERVICES = [
    { icon: CalendarClock, to: '/scheduled', label: '日历' },   // was 定时任务
    { icon: BarChart3,     to: '/usage',     label: '用量统计' },
    { icon: TrendingUp,    to: '/trending',  label: 'GitHub 趋势' },
    { icon: Video,         to: '/bilibili',  label: 'Bilibili 收藏' },
  ] as const
  ```
- **Render the grid under "New chat"** inside `SessionList`, directly below
  the "New chat" button and above the search/segmented-control/sessions:
  `<div className="grid grid-cols-3 gap-1">…</div>`, each cell a `<Link>`/
  button reusing the existing `iconBtn` styling (icon + tooltip via the
  existing `<Tooltip>` wrapper).
- **`SidebarFooter` keeps only** the Settings button and `ThemeToggle`
  (remove the four service `<Link>`s and the now-unneeded `flex-1` spacer).

## 6. Data Flows

**Agent read** — agent calls `calendar.list_upcoming({ days: 14 })` → tool
`execute` → `mainRpc('calendar.list_upcoming', [14])` → service maps to
`listInRange(now, now+14d)` → union query over `calendar.db` → rows returned
to the agent. One cross-process round trip per call.

**Agent local write** — `calendar.create_local({ title, startMs, endMs })` →
`mainRpc('calendar.create_local', [input])` → `cache.createLocal` inserts a
uuid row → returns the `CalendarEvent` → `service.getView()` re-snapshots
(localEventCount bumped) → `calendar:stateChanged` broadcast → the merged
view's range query invalidates and refetches.

**UI local CRUD** — day-detail panel "新建本地事件" form →
`window.swarm.calendar.createLocal(input)` → `ipcMain.handle('calendar:createLocal')`
→ `service.createLocal` → same cache insert + broadcast. Delete symmetric.

**Google sync** — daemon timer (30 min) → `api.listUpcoming({ fromMs: now,
toMs: now+90d })` → `cache.upsertGoogleEvents` → `setStats` → `fireSynced` →
service re-snapshots → `calendar:stateChanged` → view refetches range.

**Auth** — Settings panel: paste `client_id`/`client_secret` → "Link
account" → main starts loopback server + `shell.openExternal(consent URL)`
with `scope=calendar.readonly` → user consents → Google redirects to
`http://127.0.0.1:{port}?code=…` → exchange → persist → fetch primary
calendar → daemon starts → UI shows "linked".

## 7. Sync Strategy (Google, v1)

- **Initial pull:** on login, list primary-calendar events for
  `[now, now+90d]`, `singleEvents=true`, `orderBy=startTime`, cap 250.
- **Incremental:** every 30 min, re-list the same forward window and UPSERT
  (idempotent). **Explicit gaps:** past events beyond the window are not
  fetched; deletions/cancellations in Google are not reflected (the cache
  only grows within the window). The `calendar.synced` payload carries
  `windowDays: 90` so the limit is visible, not silent.
- **Triggers:** resident while the app is open; manual "Sync now"; not
  synced while closed.
- **Multi-calendar / true incremental (`syncToken`) / past events** are
  fast-follows; the schema already isolates `calendarId` to allow them.

## 8. Sidebar Restructure (task 2 detail)

Pure renderer change; no backend, no protocol.

- `app-sidebar.tsx`: define the `SERVICES` array; reduce `SidebarFooter` to
  Settings + ThemeToggle only. Relabel the `/scheduled` tooltip 「定时任务」→「日历」.
- `session-list.tsx`: render the 3-col grid directly below the "New chat"
  button (before the search/segmented-control/sessions), inside the existing
  root container; the session `ScrollArea` stays unchanged. Placement is
  definite: under "New chat", inside `SessionList`.
- All scrolling continues to use the `ScrollArea` component (memory
  `feedback_all_scroll_use_scrollarea`); the grid itself is non-scrolling.

## 9. v1 Scope

**In:**
- Google Calendar read-only, primary calendar, forward 90-day window,
  `singleEvents=true`, 30-min poll + manual Sync now.
- User-supplied OAuth client credentials in a Calendar Settings panel.
- Local calendar: sqlite `local_events`, full CRUD via agent tools and via
  the merged view (create + delete; edit via delete+recreate or agent tool).
- `calendar.list_upcoming`, `calendar.get_event`, `calendar.create_local`,
  `calendar.update_local`, `calendar.delete_local` tools.
- Merged `/scheduled` view showing cron runs/projections + Google + local
  events, color-coded; local create/delete from the day-detail panel.
- Sidebar 3-col grid under "New chat"; footer = Settings + ThemeToggle.

**Out (fast-follow, explicitly):**
- Writing to Google Calendar (events.create/patch on Google — needs scope
  bump + permission gate).
- Multi-calendar (calendarList), `syncToken` incremental sync, past-event
  history, deletion tracking.
- Recurring-event editing (v1 only displays expanded instances).
- Reminders/notifications; `.ics` import/export; attendees write-back.
- Edit-in-UI for local events (delete+recreate or agent tool in v1).
- A standalone `/calendar` route (folded into `/scheduled` by decision #6).

## 10. Error Handling & Logging (per `CLAUDE.md` §5)

Every business path logs under a per-module child logger
(`calendar-auth`, `calendar-api`, `calendar-daemon`, `calendar-cache`,
`calendar-service`, `calendar-ipc`) so the log file alone explains what
happened and where it failed.

- **Token refresh failure** → daemon `stop()`, `syncError` set, view
  `loggedIn` still true but sync stalled → UI prompts re-link. `error`.
- **401 after refresh-retry / 429 / 5xx** → backoff, max 3; `warn`.
- **Loopback port in use** → retry on another random port; `debug`.
- **OAuth consent timeout (5 min)** → reject; `warn`.
- **`calendar.db` write** → main is sole writer; WAL; each sync batch logs
  `synced count` at `info`; each local CRUD logs at `info` with `eventId`.
- **Every `catch`** logs `{ msg, err, ...ctx }` before rethrow/return — no
  silent catches.
- Secrets never logged (logger `redact`; never dump raw token objects).

## 11. Testing

- **Unit, per main module** (mocked `fetch`, mocked loopback http, in-memory
  sqlite `:memory:`):
  - `store.test.ts` — encrypt/decrypt, schema validation (mirror gmail).
  - `auth.test.ts` — code→token exchange + refresh, scope asserted
    `calendar.readonly`.
  - `api.test.ts` — `listUpcoming` query shape (`singleEvents`,
    `timeMin`/`timeMax`, `orderBy`), 401→refresh→retry, backoff,
    all-day vs dateTime parsing.
  - `cache.test.ts` — google UPSERT idempotency, `listInRange` union +
    overlap semantics, local CRUD round trips.
  - `daemon.test.ts` — poll orchestration with mocked api; 90-day window.
  - `service.test.ts` — query/CRUD over in-memory cache; link/unlink
    lifecycle; `getView` counts.
- **main-rpc round trip** — assert each of the 5 `calendar.*` handlers
  resolves via the existing `mainRequest`/`mainResponse` channel (mirror the
  gmail round-trip test).
- **Tools** — mock `mainRpc`, assert each tool's text output and error
  surfacing.
- **Renderer** — `CalendarSettingsView` render + mutations (mirror
  gmail-view test if present); `ScheduledCalendarView` merges events from a
  mocked `useCalendarEvents` and renders the create/delete affordances.

## 12. Implementation Sequencing

Two independent features → two worktrees (per `CLAUDE.md` §6; memory
`feedback_worktree_rebase_before_merge`). `app-sidebar.tsx` is touched by
both (task 2 restructures it; task 1 relabels the `/scheduled` tooltip), so:

1. **Worktree A — sidebar restructure** (small, pure renderer): owns
   `app-sidebar.tsx` + `session-list.tsx`, including the 「定时任务」→「日历」
   relabel. Lands first.
2. **Worktree B — calendar** (backend + protocol + tools + Settings panel +
   merged view): rebases onto A. Does **not** touch `app-sidebar.tsx`.

Integration via `git rebase develop` then `git merge --ff-only` into develop
(memory), keeping history linear.
