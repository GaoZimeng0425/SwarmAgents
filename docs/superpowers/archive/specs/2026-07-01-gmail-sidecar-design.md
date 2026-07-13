# Gmail Read-Only Sidecar — Design Spec

- **Date:** 2026-07-01
- **Status:** Approved (design); pending implementation plan
- **Related:** `CLAUDE.md` §5 (Log Every Business Path), §6 (Worktrees), memory `project_agent_env_blueprint` (P1 tools → external capabilities)

## 1. Problem

Agents today cannot reach the user's mailbox. The user wants a **sidecar
("旁路") service** — an always-on background daemon that owns the Gmail
connection and keeps a local cache — and to expose that cache to agents as
`gmail.*` tools. Gmail is the **first** such sidecar; the design should be
shaped so other external-account sidecars can follow.

Gmail is chosen first because it is the highest-value personal-data source for
an assistant (triage, summarisation, "what did X say"). The first phase is
**read-only triage** (no send): poll Gmail, store locally, let agents
search/read/summarise. Sending, attachments, and multi-account are explicit
fast-follows.

## 2. Decisions (locked during brainstorming)

| # | Decision | Choice |
|---|----------|--------|
| 1 | Sidecar form | **Resident background daemon** — independent lifecycle, owns the Gmail connection, polls on a timer, maintains a local cache. Agents do not call the Gmail API directly. |
| 2 | First-phase capability | **Read-only triage** — `gmail.readonly` OAuth scope. Poll → cache → search/read. No send/draft in v1. |
| 3 | Agent consumption | **`gmail.*` built-in tools reading the local cache** (`gmail.search`, `gmail.get_thread`, `gmail.list_recent`). Registered in `toolRegistry`; any agent with the group in its allowlist can call. |
| 4 | OAuth credentials | **User-supplied OAuth client** — the user creates a "Desktop app" OAuth client in Google Cloud Console (kept in Testing mode, self added as test user) and pastes `client_id`/`client_secret` into Settings. Avoids Google's restricted-scope verification; works immediately for personal use. |
| 5 | Architecture (where the daemon lives) | **Approach B** — the daemon and the entire Gmail logic live in the **Electron main process**; the `gmail.*` tools run in the service `utilityProcess` and query main's cache via IPC. (Rejected: A, daemon in the service thread; C, external Gmail MCP server — contradicts the resident-cache decision.) |
| 6 | Service→Main query channel | **Extend the wire protocol symmetrically** — add `mainRequest`/`mainResponse` mirroring the existing `ServiceRequest`/`ServiceResponse`. Rejected: cross-process sqlite WAL (fragile across crashes); event-then-callback dance (overloads the event channel). The protocol extension is reusable for any future service→main query. |
| 7 | OAuth redirect flow | **Loopback HTTP server** (`http://127.0.0.1:{port}`) — Google's documented installed-app flow. Rejected: BrowserWindow cookie interception (bilibili's pattern works for cookies, but fighting Google's consent JS for an OAuth code is fragile). |
| 8 | Incremental sync (v1) | **Re-list recent + UPSERT** (idempotent, simple). Does **not** track deletions or old-thread updates — logged explicitly. True `historyId` incremental sync is fast-follow. |
| 9 | Gmail API client | **Hand-rolled REST** (`fetch` against `gmail.googleapis.com/gmail/v1`), matching `bilibili/api.ts`. Rejected: the `googleapis` npm package (heavy, inconsistent with the rest of the codebase). |

## 3. Architecture

```
┌─ Main process (Electron) ─────────────────────────────────────────┐
│  src/main/gmail/  (new feature slice; ALL Gmail logic in main)    │
│   ├ store.ts     OAuth client creds + tokens (safeStorage)         │
│   ├ auth.ts      loopback HTTP → code→token exchange → refresh     │
│   ├ api.ts       Gmail REST client (fetch; 401→refresh→retry)      │
│   ├ cache.ts     gmail.db (better-sqlite3, main-only writer, WAL)  │
│   ├ daemon.ts    resident setInterval poll (api → cache upsert)    │
│   ├ service.ts   config state machine + RPC query methods          │
│   ├ ipc.ts       renderer IPC + registers service→main handler     │
│   └ index.ts     wiring; starts at app 'ready'                     │
│                                                                   │
│  src/main/ipc/   main-rpc router (routes mainRequest → gmail svc)  │
└────────────────────────────── ▲ postMessage ───────────────────────┘
                                 │ NEW mainRequest / mainResponse
┌─ Service utilityProcess ───────┘▼──────────────────────────────────┐
│  src/service/gmail/tools.ts      gmail.* ToolSpecs (→ call mainRpc)│
│  src/service/gmail/main-rpc.ts   service-side RPC client (await)    │
│  toolRegistry.register(gmailSpecs)  in src/service/index.ts         │
└────────────────────────────────────────────────────────────────────┘
```

The daemon is the **first always-on network poller** in main, but
`src/main/system/auto-update.ts` is already precedent for resident periodic
network activity in main; the daemon follows that lifecycle (start at boot,
interval-driven, structured logs). The encrypted store, the feature-slice
`index/ipc/service/store` shape, and the renderer Settings panel all reuse the
established patterns from `providers` / `web-search` / `bilibili`.

### Wire-protocol extension (`src/shared/types/service-ipc.ts`)

The current protocol is one-directional for requests: Main sends
`ServiceRequest`, Service replies `ServiceResponse`; Service→Main is events +
one boot `ServiceReady`. Gmail query tools (in Service) need to call Main and
await a result, so the protocol gains a symmetric reverse direction.

```ts
// New: methods the Service can invoke on Main. Starts with Gmail; grows
// as future sidecars add service→main queries.
export type MainMethod =
  | 'gmail.search'
  | 'gmail.get_thread'
  | 'gmail.list_recent'

// New message shapes, mirroring ServiceRequest/ServiceResponse.
export type MainRequest = {
  kind: 'mainRequest'
  id: number
  method: MainMethod
  args: unknown[]
}
export type MainResponse =
  | { kind: 'mainResponse'; id: number; ok: true; result: unknown }
  | { kind: 'mainResponse'; id: number; ok: false; error: string }
```

`MainToService` gains `MainResponse` (main replying); `ServiceToMain` gains
`MainRequest` (service asking). Main-side: `service-client.ts`'s incoming-port
listener gains a `mainRequest` branch that routes via a registered handler map
and posts back `mainResponse`. Service-side: `main-rpc.ts` keeps an id counter
+ pending-promise map keyed by id; resolves on the matching `mainResponse`.

## 4. Data Model

### `src/shared/types/gmail.ts`

```ts
// OAuth client credentials the user pastes into Settings.
export const GmailClientCredsSchema = z.object({
  clientId: z.string().min(1),
  clientSecret: z.string().min(1),
})

// Tokens obtained from the OAuth code exchange. Stored encrypted.
export const GmailTokensSchema = z.object({
  accessToken: z.string(),
  refreshToken: z.string(),        // gmail.readonly grants offline access
  expiresAt: z.number().int(),     // epoch ms
})

// On-disk config (encrypted via safeStorage).
export const GmailConfigOnDiskSchema = z.object({
  clientCreds: GmailClientCredsSchema.nullable(),
  tokens: GmailTokensSchema.nullable(),
  accountEmail: z.string().nullable(),
})

// Renderer-facing view: no secrets.
export const GmailConfigViewSchema = z.object({
  hasClientCreds: z.boolean(),
  loggedIn: z.boolean(),
  accountEmail: z.string().nullable(),
  lastSyncAt: z.number().int().nullable(),
  messageCount: z.number().int().nullable(),
  syncError: z.string().nullable(),
})

// Cache row shapes (also the tool result shapes).
export const GmailThreadSchema = z.object({
  id: z.string(),
  snippet: z.string(),
  fromAddr: z.string(),
  subject: z.string(),
  lastDateMs: z.number().int(),
  labelIds: z.array(z.string()),
  unread: z.boolean(),
})
export const GmailMessageSchema = z.object({
  id: z.string(),
  threadId: z.string(),
  fromAddr: z.string(),
  toAddrs: z.array(z.string()),
  subject: z.string(),
  snippet: z.string(),
  bodyText: z.string(),
  dateMs: z.number().int(),
  labelIds: z.array(z.string()),
})
```

Approach B does **not** define an injection type — the service never holds
tokens; it queries main.

### `gmail.db` (sqlite, under `userData/`, main-only writer)

```sql
CREATE TABLE threads (
  id          TEXT PRIMARY KEY,   -- Gmail thread id
  snippet     TEXT,
  fromAddr    TEXT,
  subject     TEXT,
  lastDateMs  INTEGER,
  labelIds    TEXT,               -- JSON array
  unread      INTEGER,            -- 0/1
  updatedAt   INTEGER
);
CREATE INDEX idx_threads_date ON threads(lastDateMs);

CREATE TABLE messages (
  id          TEXT PRIMARY KEY,   -- Gmail message id
  threadId    TEXT,
  fromAddr    TEXT,
  toAddrs     TEXT,               -- JSON array
  subject     TEXT,
  snippet     TEXT,
  bodyText    TEXT,
  dateMs      INTEGER,
  labelIds    TEXT                -- JSON array
);
CREATE INDEX idx_messages_thread ON messages(threadId);
CREATE INDEX idx_messages_date   ON messages(dateMs);

CREATE TABLE sync_state (
  key   TEXT PRIMARY KEY,         -- 'lastSyncAt' | 'messageCount' | ...
  value TEXT
);
```

Opened with `better-sqlite3` (already a dependency), WAL mode for hygiene even
though main is the sole accessor. v1 search is sqlite `LIKE` over
subject/snippet/fromAddr/bodyText; FTS5 is fast-follow.

## 5. Components

**`src/main/gmail/store.ts`** — Encrypted on-disk store for
`GmailConfigOnDisk`. Mirrors `providers/store.ts`: `safeStorage`
encrypt/decrypt, atomic tmp→rename, Zod-validate-before-encrypt, serialised
save queue, forgiving `load()` / strict `loadOrRecover()`.

**`src/main/gmail/auth.ts`** — `createAuth({ store })`, credentials read from the
store (mirrors bilibili's `createAuth`).
- `login()`: read `clientCreds` from the store (reject if absent) → start a
  loopback HTTP server on a random free port →
  build the Google consent URL with `redirect_uri=http://127.0.0.1:{port}`,
  `scope=https://www.googleapis.com/auth/gmail.readonly`,
  `access_type=offline`, `prompt=consent` → `shell.openExternal(url)` → await
  the `?code=` callback (5-min deadline, like bilibili) → POST the code to
  `oauth2.googleapis.com/token` → persist tokens → fetch the profile
  (`gmail.googleapis.com/gmail/v1/users/me/profile`) for the account email →
  resolve status. If the port is taken, retry on another random port.
- `logout()`: clear tokens + account email.
- `refreshIfNeeded(tokens)`: if `expiresAt` is past, POST the
  `refresh_token` grant → new `accessToken` + `expiresAt` → persist.
- Returns `Auth = { login, logout }`.

**`src/main/gmail/api.ts`** — Thin Gmail REST client (hand-rolled `fetch`).
`listThreads({ label?, pageToken?, maxResults? })`, `getThread(id)`,
`getMessage(id)`. Each request sets `Authorization: Bearer {accessToken}`. On
401 → `refreshIfNeeded` → retry once. On 429/5xx → exponential backoff
(max 3). Normalises Gmail JSON → `GmailThread` / `GmailMessage`. Body text
extraction walks the `payload` MIME tree (prefer `text/plain`, fall back to
`text/html` stripped to text); HTML/attachments are not stored in v1.

**`src/main/gmail/cache.ts`** — Opens `gmail.db`. Methods: `upsertThreads`,
`upsertMessages`, `search(query, limit)`, `getThread(id)` (thread + messages),
`listRecent({ limit, label? })`, `stats()` (count + lastSyncAt). UPSERTs are
idempotent so re-listing is safe.

**`src/main/gmail/daemon.ts`** — `createDaemon({ api, cache, getStatus,
onSynced })`. `start()`: if logged in, `setInterval(poll, 5min)` + an
immediate poll. `stop()`: `clearInterval`. `poll()`: `listThreads` recent
(cap 200 total across pages) → for each new/changed thread `getThread` (full)
→ normalise → `cache.upsert` → update `sync_state` → emit a `gmail.synced`
event `{ count, ts, deletionsNotTracked: true }`. On auth failure → `stop()`,
emit `gmail.auth_failed`. Lifecycle: `start()` on successful `login()`,
`stop()` on `logout()`.

**`src/main/gmail/service.ts`** — Config state machine (mirrors
`budgets`/`web-search` service). `setClientCreds`, `clearClientCreds`,
`linkAccount()` (delegates to `auth.login`), `unlinkAccount()`, `getView()`.
RPC query methods the main-rpc router delegates to: `search(q, limit)`,
`getThread(id)`, `listRecent({ limit, label? })` (these three are exposed to
the service via `mainRequest`; `status()` is renderer-IPC-only). `search`
runs a sqlite `LIKE '%q%'` over subject/snippet/fromAddr/bodyText — a local
substring match, **not** Gmail `q`-syntax (the cache is searched, not Gmail).
Orchestrates daemon start/stop on link/unlink. `onStateChanged(cb)` for the UI.

**`src/main/gmail/ipc.ts`** — Renderer IPC handlers: `gmail:getStatus`,
`gmail:setClientCreds`, `gmail:clearClientCreds`, `gmail:linkAccount`,
`gmail:unlinkAccount`, `gmail:syncNow`. Broadcasts `gmail:changed` on state
change. **Registers the service→main query handler** mapping
`gmail.search | gmail.get_thread | gmail.list_recent` → the service's query
methods.

**`src/main/gmail/index.ts`** — `createGmail(opts)` wiring: builds store →
api → cache → auth → daemon → service; returns `{ service, registerIpc,
registerMainRpc }`. Called from main's app-ready wiring with the `userData`
path; `registerMainRpc` installs handlers into the main-rpc router.

**`src/service/gmail/main-rpc.ts`** — Service-side RPC client. `mainRpc(method,
args): Promise<result>` with an id counter + pending map; posts `mainRequest`
on `parentPort` and resolves on the matched `mainResponse`. Set up as a
module-level singleton in `src/service/index.ts` (parallel to how
`webSearchConfig` is wired).

**`src/service/gmail/tools.ts`** — `ToolSpec` entries, `group: 'gmail'`,
`source: 'builtin'`, `risk: 'low'`:
- `gmail.search({ query: string, limit?: number })` → `mainRpc('gmail.search', [query, limit])`.
- `gmail.get_thread({ id: string })` → `mainRpc('gmail.get_thread', [id])`.
- `gmail.list_recent({ limit?: number, label?: string })` → `mainRpc('gmail.list_recent', [{ limit, label }])`.

Each `build(ctx)` returns a pi `AgentTool` whose `execute` calls `mainRpc` and
returns rows (errors surface as tool error text). Registered in
`src/service/index.ts` via `registerBuiltinTools` (or directly).

**Renderer Settings UI** — New Gmail panel alongside the existing
providers/web-search sections: `client_id`/`client_secret` password inputs,
"Link account" button, status line (email / last sync / message count / sync
error), "Sync now", "Unlink". Reuses the existing settings-dialog patterns.

## 6. Data Flows

**Query** — agent calls `gmail.search({ q })` → tool `execute` →
`mainRpc('gmail.search', [q, limit])` → service posts `{kind:'mainRequest',...}`
→ main-rpc router → `gmailService.search(q, limit)` reads `gmail.db` → main
posts `{kind:'mainResponse', id, ok:true, result}` → tool resolves with rows →
agent sees the thread/message objects. One cross-process round trip per call
(acceptable: agent tool calls are not a hot path).

**Sync** — daemon timer fires → `api.listThreads` → per-thread
`api.getThread` → normalise → `cache.upsert` → update `sync_state` → emit
`gmail.synced` event → renderer refreshes status.

**Auth** — Settings: user pastes `client_id`/`client_secret` → clicks "Link
account" → main starts the loopback server and `shell.openExternal` to the
Google consent URL → user consents → Google redirects to
`http://127.0.0.1:{port}?code=…` → loopback server captures the code → main
exchanges code for tokens → persists encrypted → fetches profile for email →
daemon starts → UI shows "linked".

## 7. Sync Strategy (v1)

- **Initial pull:** immediately after login, pull the most recent 200 INBOX
  threads; each fetched `format=FULL` and reduced to plain-text body (HTML
  stripped, attachments not stored).
- **Incremental:** every 5 min, `users.messages.list` re-lists the recent 100
  and UPSERTs (idempotent). **Explicit gap:** this does not capture deletions
  or updates to older threads; the `gmail.synced` event carries
  `deletionsNotTracked: true` so the limitation is visible, not silent. True
  `historyId`-based incremental (with expired-history → full-resync fallback)
  is fast-follow.
- **Triggers:** resident while the app is open; manual "Sync now"; not synced
  while the app is closed.
- **Label scope:** v1 syncs `INBOX`. The cache schema and `list_recent` accept
  a `label` argument so `SENT`/archive/multiple labels are a fast-follow
  without schema changes.

## 8. v1 Scope

**In:**
- Read-only, single account, `INBOX` recent 200 threads.
- Plain-text bodies; no HTML, no attachments.
- `LIKE`-based search.
- 5-min poll + manual "Sync now".
- User-supplied OAuth client credentials in Settings.
- Link / unlink / status UI.
- `gmail.search`, `gmail.get_thread`, `gmail.list_recent` tools.

**Out (fast-follow, explicitly):**
- Send / draft (requires `gmail.send` scope + a permission gate).
- Attachments.
- FTS5 full-text search.
- Multiple accounts.
- `SENT` / archive / custom-label sync.
- Push notifications (daemon wakes an agent on new important mail).
- Sync while the app is closed.
- True `historyId` incremental sync.

## 9. Error Handling & Logging (per `CLAUDE.md` §5)

Every business path logs under a per-module child logger so the log file alone
explains what happened and where it failed.

- **Token refresh failure** → daemon `stop()`, status `loggedIn: false`,
  `syncError` set, UI prompts re-link. Logged at `error`.
- **429 / 5xx** from Gmail → exponential backoff, max 3 retries. Logged at
  `warn`.
- **Loopback port in use** → retry on another random port. Logged at `debug`.
- **OAuth window / consent timeout** (5 min) → reject. Logged at `warn`.
- **`gmail.db` write** → main is the sole writer (no lock contention); WAL
  enabled; each sync batch logs `synced count` at `info`.
- **Every `catch`** logs `{ msg, err, ...ctx }` before rethrow/return — no
  silent catches. Component children: `gmail-auth`, `gmail-api`, `gmail-daemon`,
  `gmail-cache`, `gmail-service`, `gmail-main-rpc`.
- Secrets never logged (rely on the existing logger `redact` config; never
  dump raw token/provider objects).

## 10. Testing

- **Unit, per module** (mocked `fetch`, mocked loopback http, in-memory
  sqlite `:memory:`):
  - `store.test.ts` — encrypt/decrypt round trip, schema validation.
  - `auth.test.ts` — code→token exchange and refresh with mocked fetch + a
    mocked loopback server.
  - `api.test.ts` — Gmail REST calls, 401→refresh→retry, 429 backoff, MIME
    body extraction.
  - `cache.test.ts` — UPSERT idempotency, search, schema.
  - `daemon.test.ts` — poll orchestration with a mocked api; auth-failure
    stops the daemon.
  - `service.test.ts` — query methods over an in-memory cache; link/unlink
    lifecycle.
- **main-rpc round trip** — two in-process emitters (mirror
  `dispatcher.test.ts`): service posts `mainRequest`, main handler replies
  `mainResponse`, promise resolves.
- **Tools** — mock `mainRpc`, assert each tool returns the expected row shape
  and surfaces errors as tool error text.
- **E2E smoke (optional, env-gated)** — a real-account smoke akin to
  `scripts/smoke-company.ts`, behind a `GMAIL_SMOKE=1` env var and a linked
  account; not a CI test.
