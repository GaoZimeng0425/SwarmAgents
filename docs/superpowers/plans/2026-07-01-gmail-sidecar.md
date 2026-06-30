# Gmail Read-Only Sidecar Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add a resident main-process Gmail daemon that OAuth-links the user's account, polls INBOX into a local sqlite cache, and exposes `gmail.search` / `gmail.get_thread` / `gmail.list_recent` tools to agents via a new symmetric service→main RPC channel.

**Architecture:** Approach B from the spec — all Gmail logic (auth, REST, cache, daemon) lives in the Electron **main process** under `src/main/gmail/`. The `gmail.*` tools run in the **service utilityProcess** and query main's cache by extending the wire protocol with `mainRequest`/`mainResponse` (mirroring the existing `ServiceRequest`/`ServiceResponse`).

**Tech Stack:** Electron (`safeStorage`, `utilityProcess`, `ipcMain`, `shell`), `better-sqlite3`, `zod`, typebox (`@earendil-works/pi-ai` `Type`), `pi-agent-core` `AgentTool`, vitest.

**Spec:** `docs/superpowers/specs/2026-07-01-gmail-sidecar-design.md`

## Global Constraints

- **Language:** Code comments and commit messages in English. Conversation in Chinese.
- **Tests:** Run with `npm test -- <path>` (NEVER bare `npx vitest`; the project runs vitest through Electron's node — see memory `project_run_tests_via_electron_node`). Expected end state of every test step is PASS.
- **Format:** Scope a format with `npx biome check --write <file>` (NOT `pnpm check`, which reformats the whole repo — memory `reference_biome_check_hardcodes_dot`).
- **Logging:** Every business path logged under a `gmail-*` child logger per `CLAUDE.md` §5; every `catch` logs `{ msg, err, ...ctx }`; secrets never logged.
- **Secrets:** All OAuth tokens / client secrets persisted only via `safeStorage` (encrypted) under `userData/`, never plaintext.
- **Scope:** v1 is read-only (`gmail.readonly`), single account, INBOX recent 200, plain-text bodies, `LIKE` search. Do NOT implement send/draft/attachments/FTS/multi-account.
- **Reuse, don't invent:** Feature-slice shape mirrors `src/main/budgets/` and `src/main/providers/`; encrypted store mirrors `src/main/providers/store.ts`; IPC mirrors `src/main/budgets/ipc.ts`; tool shape mirrors `src/service/tools/web.ts`.

---

## File Structure

**Create:**
- `src/shared/types/gmail.ts` (+ `gmail.test.ts`) — zod schemas + defaults.
- `src/main/gmail/store.ts` (+ test) — encrypted `GmailConfigOnDisk` store.
- `src/main/gmail/cache.ts` (+ test) — `gmail.db` sqlite read/write.
- `src/main/gmail/api.ts` (+ test) — Gmail REST client + MIME body extraction.
- `src/main/gmail/auth.ts` (+ test) — OAuth loopback + token exchange + refresh.
- `src/main/gmail/daemon.ts` (+ test) — resident poll timer.
- `src/main/gmail/service.ts` (+ test) — config state machine + query methods.
- `src/main/gmail/ipc.ts` (+ test) — renderer IPC + main-rpc handler registration.
- `src/main/gmail/index.ts` — slice wiring (`initGmail`).
- `src/service/gmail/main-rpc.ts` (+ test) — service-side `mainRpc` client.
- `src/service/gmail/tools.ts` (+ test) — `gmail.*` ToolSpecs.

**Modify:**
- `src/shared/types/service-ipc.ts` — add `MainMethod`, `MainRequest`, `MainResponse`; widen `MainToService`/`ServiceToMain`.
- `src/main/constants.ts` — add `paths.gmail()` + `paths.gmailDb()`.
- `src/main/service-client.ts` — add `mainRequest` branch + `registerMainRpc`.
- `src/main/index.ts` — call `initGmail`, wire `registerMainRpc`, dispose.
- `src/service/tools/builtins.ts` — register gmail specs when `mainRpc` injected.
- `src/service/index.ts` — construct `mainRpc`, handle `mainResponse`, pass to `registerBuiltinTools`.
- `src/preload/index.ts` — add `gmail` bridge.
- `src/renderer/src/components/views/gmail-view.tsx` — Settings panel.
- `src/renderer/src/stores/settings-dialog.ts` + `src/renderer/src/components/settings-dialog.tsx` — register the Gmail nav entry.

---

## Task 1: Shared Gmail types

**Files:**
- Create: `src/shared/types/gmail.ts`
- Test: `src/shared/types/gmail.test.ts`

**Interfaces:**
- Produces: `GmailClientCreds`, `GmailTokens`, `GmailConfigOnDisk`, `defaultGmailConfigOnDisk()`, `GmailConfigView`, `GmailThread`, `GmailMessage` (all zod schemas + inferred types). Later tasks import these by these exact names.

- [ ] **Step 1: Write the failing test**

```ts
// src/shared/types/gmail.test.ts
import { describe, it, expect } from 'vitest'
import {
  GmailConfigOnDisk,
  GmailConfigViewSchema,
  GmailMessageSchema,
  GmailThreadSchema,
  defaultGmailConfigOnDisk,
} from './gmail'

describe('gmail types', () => {
  it('default config is valid and empty', () => {
    const d = defaultGmailConfigOnDisk()
    expect(d.clientCreds).toBeNull()
    expect(d.tokens).toBeNull()
    expect(d.accountEmail).toBeNull()
    expect(() => GmailConfigOnDisk.parse(d)).not.toThrow()
  })

  it('parses a thread row', () => {
    const t = GmailThreadSchema.parse({
      id: 't1',
      snippet: 'hi',
      fromAddr: 'a@b.com',
      subject: 'S',
      lastDateMs: 1,
      labelIds: ['INBOX'],
      unread: true,
    })
    expect(t.unread).toBe(true)
  })

  it('parses a message row', () => {
    const m = GmailMessageSchema.parse({
      id: 'm1',
      threadId: 't1',
      fromAddr: 'a@b.com',
      toAddrs: ['c@d.com'],
      subject: 'S',
      snippet: 'snip',
      bodyText: 'body',
      dateMs: 2,
      labelIds: ['INBOX'],
    })
    expect(m.bodyText).toBe('body')
  })

  it('view omits secrets', () => {
    const v = GmailConfigViewSchema.parse({
      hasClientCreds: true,
      loggedIn: false,
      accountEmail: null,
      lastSyncAt: null,
      messageCount: null,
      syncError: null,
    })
    expect(v.hasClientCreds).toBe(true)
  })
})
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npm test -- src/shared/types/gmail.test.ts`
Expected: FAIL — module `./gmail` not found.

- [ ] **Step 3: Write minimal implementation**

```ts
// src/shared/types/gmail.ts
import { z } from 'zod'

// OAuth client credentials the user pastes into Settings.
export const GmailClientCredsSchema = z.object({
  clientId: z.string().min(1),
  clientSecret: z.string().min(1),
})
export type GmailClientCreds = z.infer<typeof GmailClientCredsSchema>

// Tokens obtained from the OAuth code exchange. Stored encrypted.
export const GmailTokensSchema = z.object({
  accessToken: z.string(),
  refreshToken: z.string(), // gmail.readonly grants offline access
  expiresAt: z.number().int(), // epoch ms
})
export type GmailTokens = z.infer<typeof GmailTokensSchema>

// On-disk config (encrypted via safeStorage).
export const GmailConfigOnDisk = z.object({
  clientCreds: GmailClientCredsSchema.nullable(),
  tokens: GmailTokensSchema.nullable(),
  accountEmail: z.string().nullable(),
})
export type GmailConfigOnDisk = z.infer<typeof GmailConfigOnDisk>

export function defaultGmailConfigOnDisk(): GmailConfigOnDisk {
  return { clientCreds: null, tokens: null, accountEmail: null }
}

// Renderer-facing view: no secrets.
export const GmailConfigViewSchema = z.object({
  hasClientCreds: z.boolean(),
  loggedIn: z.boolean(),
  accountEmail: z.string().nullable(),
  lastSyncAt: z.number().int().nullable(),
  messageCount: z.number().int().nullable(),
  syncError: z.string().nullable(),
})
export type GmailConfigView = z.infer<typeof GmailConfigViewSchema>

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
export type GmailThread = z.infer<typeof GmailThreadSchema>

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
export type GmailMessage = z.infer<typeof GmailMessageSchema>
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npm test -- src/shared/types/gmail.test.ts`
Expected: PASS (4 tests).

- [ ] **Step 5: Commit**

```bash
git add src/shared/types/gmail.ts src/shared/types/gmail.test.ts
git commit -m "feat(gmail): add shared zod schemas and defaults"
```

---

## Task 2: Wire-protocol extension (types only)

**Files:**
- Modify: `src/shared/types/service-ipc.ts`
- Test: `src/shared/types/service-ipc.test.ts` (new)

**Interfaces:**
- Produces: `MainMethod` (`'gmail.search' | 'gmail.get_thread' | 'gmail.list_recent'`), `MainRequest`, `MainResponse`; widens `MainToService` to include `MainResponse` and `ServiceToMain` to include `MainRequest`.

- [ ] **Step 1: Write the failing test**

```ts
// src/shared/types/service-ipc.test.ts
import { describe, it, expect } from 'vitest'
import type { MainRequest, MainResponse, ServiceToMain, MainToService } from './service-ipc'

describe('service-ipc main-rpc extension', () => {
  it('a MainRequest has kind mainRequest', () => {
    const m: MainRequest = { kind: 'mainRequest', id: 1, method: 'gmail.search', args: ['x', 10] }
    expect(m.kind).toBe('mainRequest')
    expect(m.method).toBe('gmail.search')
  })

  it('MainResponse discriminated on ok', () => {
    const ok: MainResponse = { kind: 'mainResponse', id: 1, ok: true, result: [] }
    const bad: MainResponse = { kind: 'mainResponse', id: 2, ok: false, error: 'boom' }
    expect(ok.ok).toBe(true)
    expect(bad.ok).toBe(false)
  })

  it('MainRequest is a valid ServiceToMain message', () => {
    const m: ServiceToMain = { kind: 'mainRequest', id: 1, method: 'gmail.list_recent', args: [] }
    expect(m.kind).toBe('mainRequest')
  })

  it('MainResponse is a valid MainToService message', () => {
    const m: MainToService = { kind: 'mainResponse', id: 1, ok: true, result: 1 }
    expect(m.kind).toBe('mainResponse')
  })
})
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npm test -- src/shared/types/service-ipc.test.ts`
Expected: FAIL — `MainRequest` / `MainResponse` not exported.

- [ ] **Step 3: Write minimal implementation**

Append to `src/shared/types/service-ipc.ts` (after `ServiceReady`):

```ts
// Service→Main request/reply: symmetric reverse direction. Main answers a
// MainRequest with a MainResponse matched by `id`. Used by service-side tools
// that need data only Main holds (e.g. the gmail cache).
export type MainMethod = 'gmail.search' | 'gmail.get_thread' | 'gmail.list_recent'

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

And change the two union aliases at the bottom from:

```ts
export type MainToService = ServiceRequest
export type ServiceToMain = ServiceResponse | ServiceEvent | ServiceReady
```

to:

```ts
export type MainToService = ServiceRequest | MainResponse
export type ServiceToMain = ServiceResponse | ServiceEvent | ServiceReady | MainRequest
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npm test -- src/shared/types/service-ipc.test.ts`
Expected: PASS (4 tests).

- [ ] **Step 5: Commit**

```bash
git add src/shared/types/service-ipc.ts src/shared/types/service-ipc.test.ts
git commit -m "feat(ipc): add symmetric mainRequest/mainResponse protocol"
```

---

## Task 3: Encrypted config store

**Files:**
- Create: `src/main/gmail/store.ts`
- Test: `src/main/gmail/store.test.ts`

**Interfaces:**
- Consumes: `GmailConfigOnDisk`, `defaultGmailConfigOnDisk()` from Task 1.
- Produces: `Store` (`load()`, `loadOrRecover()`, `save(state)`), `createStore({ filePath })`, `LoadResult`.

- [ ] **Step 1: Write the failing test**

```ts
// src/main/gmail/store.test.ts
import { afterEach, describe, expect, it, vi } from 'vitest'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createStore } from './store'

// Identity safeStorage so encrypt/decrypt round-trip in tests.
vi.mock('electron', () => ({
  safeStorage: {
    encryptString: (s: string) => Buffer.from(s, 'utf8'),
    decryptString: (b: Buffer) => b.toString('utf8'),
    isEncryptionAvailable: () => true,
  },
}))

let dir: string
afterEach(() => {
  if (dir) rmSync(dir, { recursive: true, force: true })
})

describe('gmail store', () => {
  it('load returns defaults when file absent', async () => {
    dir = mkdtempSync(join(tmpdir(), 'gmail-'))
    const store = createStore({ filePath: join(dir, 'gmail.enc') })
    const state = await store.load()
    expect(state.clientCreds).toBeNull()
    expect(state.tokens).toBeNull()
  })

  it('save then load round-trips with secrets', async () => {
    dir = mkdtempSync(join(tmpdir(), 'gmail-'))
    const filePath = join(dir, 'gmail.enc')
    const store = createStore({ filePath })
    await store.save({
      clientCreds: { clientId: 'cid', clientSecret: 'sec' },
      tokens: { accessToken: 'at', refreshToken: 'rt', expiresAt: 123 },
      accountEmail: 'me@x.com',
    })
    const state = await store.load()
    expect(state.clientCreds?.clientId).toBe('cid')
    expect(state.tokens?.refreshToken).toBe('rt')
    expect(state.accountEmail).toBe('me@x.com')
  })

  it('loadOrRecover reports decrypt_failed on garbage', async () => {
    dir = mkdtempSync(join(tmpdir(), 'gmail-'))
    const filePath = join(dir, 'gmail.enc')
    const { writeFile } = await import('node:fs/promises')
    await writeFile(filePath, Buffer.from('not-encrypted-garbage'))
    const store = createStore({ filePath })
    const r = await store.loadOrRecover()
    expect(r.ok).toBe(false)
    if (!r.ok) expect(r.reason).toBe('decrypt_failed')
  })
})
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npm test -- src/main/gmail/store.test.ts`
Expected: FAIL — `./store` not found.

- [ ] **Step 3: Write minimal implementation**

```ts
// src/main/gmail/store.ts
//
// Encrypted on-disk Gmail config store. Reads/writes a single file via Electron
// safeStorage (Keychain-backed on macOS). Saves are atomic (write tmp → rename)
// and validated against the Zod schema before encryption so we never persist
// garbage. Pure module: no logging, no globals — callers inject the filePath.
import { existsSync, promises as fs } from 'node:fs'
import { GmailConfigOnDisk, defaultGmailConfigOnDisk } from '@shared/types/gmail'
import { safeStorage } from 'electron'

export type LoadResult =
  | { ok: true; state: GmailConfigOnDisk }
  | { ok: false; reason: 'decrypt_failed' | 'schema_invalid' }

export type Store = {
  load(): Promise<GmailConfigOnDisk> // forgiving — returns defaults on missing/failure
  loadOrRecover(): Promise<LoadResult> // strict — reports failure reason
  save(state: GmailConfigOnDisk): Promise<void>
}

export function createStore(opts: { filePath: string }): Store {
  const { filePath } = opts

  const loadOrRecover: Store['loadOrRecover'] = async () => {
    if (!existsSync(filePath)) return { ok: true, state: defaultGmailConfigOnDisk() }
    const buf = await fs.readFile(filePath)
    let json: string
    try {
      json = safeStorage.decryptString(buf)
    } catch {
      return { ok: false, reason: 'decrypt_failed' }
    }
    let parsed: unknown
    try {
      parsed = JSON.parse(json)
    } catch {
      return { ok: false, reason: 'schema_invalid' }
    }
    const checked = GmailConfigOnDisk.safeParse(parsed)
    if (!checked.success) return { ok: false, reason: 'schema_invalid' }
    return { ok: true, state: checked.data }
  }

  const load: Store['load'] = async () => {
    const r = await loadOrRecover()
    return r.ok ? r.state : defaultGmailConfigOnDisk()
  }

  // Serialize saves so concurrent calls don't race on the shared .tmp path.
  let saveQueue: Promise<void> = Promise.resolve()
  const save: Store['save'] = (state) => {
    const next = saveQueue.then(async () => {
      GmailConfigOnDisk.parse(state) // validate before encrypting
      const ciphertext = safeStorage.encryptString(JSON.stringify(state))
      const tmp = `${filePath}.tmp`
      await fs.writeFile(tmp, ciphertext)
      await fs.rename(tmp, filePath)
    })
    saveQueue = next.catch(() => undefined)
    return next
  }

  return { load, loadOrRecover, save }
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npm test -- src/main/gmail/store.test.ts`
Expected: PASS (3 tests).

- [ ] **Step 5: Commit**

```bash
git add src/main/gmail/store.ts src/main/gmail/store.test.ts
git commit -m "feat(gmail): add encrypted config store"
```

---

## Task 4: sqlite cache

**Files:**
- Create: `src/main/gmail/cache.ts`
- Test: `src/main/gmail/cache.test.ts`

**Interfaces:**
- Consumes: `GmailThread`, `GmailMessage` from Task 1.
- Produces: `Cache` with:
  - `upsertThreads(rows: GmailThread[]): void`
  - `upsertMessages(rows: GmailMessage[]): void`
  - `search(query: string, limit: number): GmailThread[]`
  - `getThread(id: string): { thread: GmailThread; messages: GmailMessage[] } | null`
  - `listRecent(input: { limit: number; label?: string }): GmailThread[]`
  - `stats(): { messageCount: number; lastSyncAt: number }` / `setStats(stats): void`
  - `close(): void`
  - `createCache({ filePath }: { filePath: string }): Cache` — `':memory:'` for tests.

- [ ] **Step 1: Write the failing test**

```ts
// src/main/gmail/cache.test.ts
import { afterEach, describe, expect, it } from 'vitest'
import { createCache, type Cache } from './cache'

let cache: Cache
afterEach(() => cache?.close())

describe('gmail cache', () => {
  it('upsert + search by substring (case-insensitive)', () => {
    cache = createCache({ filePath: ':memory:' })
    cache.upsertThreads([
      { id: 't1', snippet: 'invoice attached', fromAddr: 'acme@x.com', subject: 'Invoice 42', lastDateMs: 10, labelIds: ['INBOX'], unread: true },
      { id: 't2', snippet: 'lunch?', fromAddr: 'bob@x.com', subject: 'Lunch', lastDateMs: 20, labelIds: ['INBOX'], unread: false },
    ])
    const hits = cache.search('INVOICE', 10)
    expect(hits.map((t) => t.id)).toEqual(['t1'])
  })

  it('getThread returns thread + messages', () => {
    cache = createCache({ filePath: ':memory:' })
    cache.upsertThreads([{ id: 't1', snippet: 's', fromAddr: 'a@x.com', subject: 'S', lastDateMs: 1, labelIds: ['INBOX'], unread: false }])
    cache.upsertMessages([{ id: 'm1', threadId: 't1', fromAddr: 'a@x.com', toAddrs: [], subject: 'S', snippet: 'sn', bodyText: 'hello', dateMs: 1, labelIds: ['INBOX'] }])
    const t = cache.getThread('t1')
    expect(t?.thread.id).toBe('t1')
    expect(t?.messages[0].bodyText).toBe('hello')
    expect(cache.getThread('nope')).toBeNull()
  })

  it('listRecent orders by date desc and filters by label', () => {
    cache = createCache({ filePath: ':memory:' })
    cache.upsertThreads([
      { id: 't1', snippet: '', fromAddr: '', subject: '', lastDateMs: 5, labelIds: ['INBOX'], unread: false },
      { id: 't2', snippet: '', fromAddr: '', subject: '', lastDateMs: 50, labelIds: ['INBOX'], unread: false },
      { id: 't3', snippet: '', fromAddr: '', subject: '', lastDateMs: 999, labelIds: ['SENT'], unread: false },
    ])
    const recent = cache.listRecent({ limit: 10, label: 'INBOX' })
    expect(recent.map((t) => t.id)).toEqual(['t2', 't1'])
  })

  it('upsert is idempotent and updates fields', () => {
    cache = createCache({ filePath: ':memory:' })
    cache.upsertThreads([{ id: 't1', snippet: 'old', fromAddr: '', subject: '', lastDateMs: 1, labelIds: ['INBOX'], unread: true }])
    cache.upsertThreads([{ id: 't1', snippet: 'new', fromAddr: '', subject: '', lastDateMs: 1, labelIds: ['INBOX'], unread: false }])
    const t = cache.getThread('t1')
    expect(t?.thread.snippet).toBe('new')
    expect(t?.thread.unread).toBe(false)
  })

  it('stats round-trips', () => {
    cache = createCache({ filePath: ':memory:' })
    cache.setStats({ messageCount: 7, lastSyncAt: 123 })
    expect(cache.stats()).toEqual({ messageCount: 7, lastSyncAt: 123 })
  })
})
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npm test -- src/main/gmail/cache.test.ts`
Expected: FAIL — `./cache` not found.

- [ ] **Step 3: Write minimal implementation**

```ts
// src/main/gmail/cache.ts
//
// Local sqlite cache of synced Gmail threads/messages. Main process is the
// sole writer (the daemon) and sole reader (the query methods); WAL is enabled
// for hygiene. Opened with better-sqlite3; ':memory:' is used in tests.
import type { GmailMessage, GmailThread } from '@shared/types/gmail'
import Database from 'better-sqlite3'
import type { Database as DB } from 'better-sqlite3'

export type ThreadStats = { messageCount: number; lastSyncAt: number }

export type Cache = {
  upsertThreads(rows: GmailThread[]): void
  upsertMessages(rows: GmailMessage[]): void
  search(query: string, limit: number): GmailThread[]
  getThread(id: string): { thread: GmailThread; messages: GmailMessage[] } | null
  listRecent(input: { limit: number; label?: string }): GmailThread[]
  stats(): ThreadStats
  setStats(stats: ThreadStats): void
  close(): void
}

const SCHEMA = `
CREATE TABLE IF NOT EXISTS threads (
  id TEXT PRIMARY KEY, snippet TEXT, fromAddr TEXT, subject TEXT,
  lastDateMs INTEGER, labelIds TEXT, unread INTEGER, updatedAt INTEGER
);
CREATE INDEX IF NOT EXISTS idx_threads_date ON threads(lastDateMs);
CREATE TABLE IF NOT EXISTS messages (
  id TEXT PRIMARY KEY, threadId TEXT, fromAddr TEXT, toAddrs TEXT,
  subject TEXT, snippet TEXT, bodyText TEXT, dateMs INTEGER, labelIds TEXT
);
CREATE INDEX IF NOT EXISTS idx_messages_thread ON messages(threadId);
CREATE INDEX IF NOT EXISTS idx_messages_date ON messages(dateMs);
CREATE TABLE IF NOT EXISTS sync_state (key TEXT PRIMARY KEY, value TEXT);
`

function rowToThread(r: Record<string, unknown>): GmailThread {
  return {
    id: String(r.id),
    snippet: String(r.snippet ?? ''),
    fromAddr: String(r.fromAddr ?? ''),
    subject: String(r.subject ?? ''),
    lastDateMs: Number(r.lastDateMs ?? 0),
    labelIds: JSON.parse(String(r.labelIds ?? '[]')) as string[],
    unread: Number(r.unread ?? 0) === 1,
  }
}

function rowToMessage(r: Record<string, unknown>): GmailMessage {
  return {
    id: String(r.id),
    threadId: String(r.threadId ?? ''),
    fromAddr: String(r.fromAddr ?? ''),
    toAddrs: JSON.parse(String(r.toAddrs ?? '[]')) as string[],
    subject: String(r.subject ?? ''),
    snippet: String(r.snippet ?? ''),
    bodyText: String(r.bodyText ?? ''),
    dateMs: Number(r.dateMs ?? 0),
    labelIds: JSON.parse(String(r.labelIds ?? '[]')) as string[],
  }
}

export function createCache(opts: { filePath: string }): Cache {
  const db: DB = new Database(opts.filePath)
  db.pragma('journal_mode = WAL')
  db.exec(SCHEMA)

  const upsertThread = db.prepare(
    `INSERT INTO threads (id, snippet, fromAddr, subject, lastDateMs, labelIds, unread, updatedAt)
     VALUES (@id, @snippet, @fromAddr, @subject, @lastDateMs, @labelIds, @unread, @updatedAt)
     ON CONFLICT(id) DO UPDATE SET
       snippet=@snippet, fromAddr=@fromAddr, subject=@subject, lastDateMs=@lastDateMs,
       labelIds=@labelIds, unread=@unread, updatedAt=@updatedAt`,
  )
  const upsertMessage = db.prepare(
    `INSERT INTO messages (id, threadId, fromAddr, toAddrs, subject, snippet, bodyText, dateMs, labelIds)
     VALUES (@id, @threadId, @fromAddr, @toAddrs, @subject, @snippet, @bodyText, @dateMs, @labelIds)
     ON CONFLICT(id) DO UPDATE SET
       threadId=@threadId, fromAddr=@fromAddr, toAddrs=@toAddrs, subject=@subject,
       snippet=@snippet, bodyText=@bodyText, dateMs=@dateMs, labelIds=@labelIds`,
  )

  const upsertThreads: Cache['upsertThreads'] = (rows) => {
    const now = Date.now()
    const tx = db.transaction((items: GmailThread[]) => {
      for (const t of items) {
        upsertThread.run({
          id: t.id,
          snippet: t.snippet,
          fromAddr: t.fromAddr,
          subject: t.subject,
          lastDateMs: t.lastDateMs,
          labelIds: JSON.stringify(t.labelIds),
          unread: t.unread ? 1 : 0,
          updatedAt: now,
        })
      }
    })
    tx(rows)
  }

  const upsertMessages: Cache['upsertMessages'] = (rows) => {
    const tx = db.transaction((items: GmailMessage[]) => {
      for (const m of items) {
        upsertMessage.run({
          id: m.id,
          threadId: m.threadId,
          fromAddr: m.fromAddr,
          toAddrs: JSON.stringify(m.toAddrs),
          subject: m.subject,
          snippet: m.snippet,
          bodyText: m.bodyText,
          dateMs: m.dateMs,
          labelIds: JSON.stringify(m.labelIds),
        })
      }
    })
    tx(rows)
  }

  const search: Cache['search'] = (query, limit) => {
    const like = `%${query}%`
    const rows = db
      .prepare(
        `SELECT * FROM threads
         WHERE subject LIKE @like OR snippet LIKE @like OR fromAddr LIKE @like
         OR id IN (SELECT threadId FROM messages WHERE bodyText LIKE @like OR subject LIKE @like)
         ORDER BY lastDateMs DESC LIMIT @limit`,
      )
      .all({ like, limit }) as Record<string, unknown>[]
    return rows.map(rowToThread)
  }

  const getThread: Cache['getThread'] = (id) => {
    const tr = db.prepare('SELECT * FROM threads WHERE id = ?').get(id) as
      | Record<string, unknown>
      | undefined
    if (!tr) return null
    const msgs = db
      .prepare('SELECT * FROM messages WHERE threadId = ? ORDER BY dateMs ASC')
      .all(id) as Record<string, unknown>[]
    return { thread: rowToThread(tr), messages: msgs.map(rowToMessage) }
  }

  const listRecent: Cache['listRecent'] = ({ limit, label }) => {
    const rows = label
      ? (db
          .prepare(
            `SELECT * FROM threads WHERE labelIds LIKE @label ORDER BY lastDateMs DESC LIMIT @limit`,
          )
          .all({ label: `%"${label}"%`, limit }) as Record<string, unknown>[])
      : (db
          .prepare('SELECT * FROM threads ORDER BY lastDateMs DESC LIMIT @limit')
          .all({ limit }) as Record<string, unknown>[])
    return rows.map(rowToThread)
  }

  const stats: Cache['stats'] = () => {
    const get = (k: string): number => {
      const r = db.prepare('SELECT value FROM sync_state WHERE key = ?').get(k) as
        | { value?: string }
        | undefined
      return r?.value ? Number(r.value) : 0
    }
    return { messageCount: get('messageCount'), lastSyncAt: get('lastSyncAt') }
  }
  const setStats: Cache['setStats'] = (s) => {
    const set = db.prepare(
      'INSERT INTO sync_state (key, value) VALUES (@k, @v) ON CONFLICT(key) DO UPDATE SET value=@v',
    )
    set.run({ k: 'messageCount', v: String(s.messageCount) })
    set.run({ k: 'lastSyncAt', v: String(s.lastSyncAt) })
  }

  return { upsertThreads, upsertMessages, search, getThread, listRecent, stats, setStats, close: () => db.close() }
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npm test -- src/main/gmail/cache.test.ts`
Expected: PASS (5 tests).

- [ ] **Step 5: Commit**

```bash
git add src/main/gmail/cache.ts src/main/gmail/cache.test.ts
git commit -m "feat(gmail): add sqlite thread/message cache"
```

---

## Task 5: Gmail REST client + MIME body extraction

**Files:**
- Create: `src/main/gmail/api.ts`
- Test: `src/main/gmail/api.test.ts`

**Interfaces:**
- Consumes: `GmailThread`, `GmailMessage` from Task 1.
- Produces:
  - `createGmailApi({ getAccessToken, refreshAccessToken }): GmailApi`
  - `GmailApi.getProfile(): Promise<{ emailAddress: string }>`
  - `GmailApi.listThreads(input?: { label?: string; max?: number }): Promise<{ threadIds: string[] }>` (page-limited; cap `MAX_THREADS = 200`)
  - `GmailApi.fetchThread(id: string): Promise<{ thread: GmailThread; messages: GmailMessage[] }>`
  - Pure helpers exported for testing: `pickBodyText(payload)`, `decodeBase64Url(s)`.

- [ ] **Step 1: Write the failing test**

```ts
// src/main/gmail/api.test.ts
import { afterEach, describe, expect, it, vi } from 'vitest'
import { createGmailApi, decodeBase64Url, pickBodyText } from './api'

const okJson = (body: unknown, status = 200): Response =>
  ({ ok: status >= 200 && status < 300, status, json: async () => body }) as Response

afterEach(() => vi.restoreAllMocks())

describe('gmail api helpers', () => {
  it('decodeBase64Url decodes url-safe base64', () => {
    expect(decodeBase64Url('SGVsbG8')).toBe('Hello') // "Hello" -> SGVsbG8=
  })

  it('pickBodyText prefers text/plain part', () => {
    const payload = {
      mimeType: 'multipart/alternative',
      parts: [
        { mimeType: 'text/plain', body: { data: 'SGVsbG8=' } }, // "Hello"
        { mimeType: 'text/html', body: { data: 'PGI+aGk8L2I+' } },
      ],
    }
    expect(pickBodyText(payload as never)).toBe('Hello')
  })

  it('pickBodyText recurses into multipart', () => {
    const payload = {
      mimeType: 'multipart/mixed',
      parts: [
        { mimeType: 'multipart/alternative', parts: [{ mimeType: 'text/plain', body: { data: 'SGk=' } }] },
      ],
    }
    expect(pickBodyText(payload as never)).toBe('Hi')
  })

  it('pickBodyText returns "" when no text part', () => {
    expect(pickBodyText({ mimeType: 'application/pdf', body: {} } as never)).toBe('')
  })
})

describe('gmail api client', () => {
  it('listThreads + fetchThread normalize', async () => {
    const fetchMock = vi
      .spyOn(globalThis, 'fetch')
      .mockResolvedValueOnce(
        okJson({ threads: [{ id: 't1' }, { id: 't2' }] }),
      )
      .mockResolvedValueOnce(
        okJson({
          id: 't1',
          snippet: 'snip',
          labelIds: ['INBOX'],
          messages: [
            {
              id: 'm1',
              threadId: 't1',
              snippet: 'ms',
              labelIds: ['INBOX'],
              internalDate: '1000',
              payload: {
                headers: [
                  { name: 'From', value: 'a@x.com' },
                  { name: 'To', value: 'c@d.com' },
                  { name: 'Subject', value: 'Hi' },
                ],
                mimeType: 'text/plain',
                body: { data: 'SGVsbG8=' },
              },
            },
          ],
        }),
      )
    const api = createGmailApi({
      getAccessToken: async () => 'AT',
      refreshAccessToken: async () => {},
    })
    const listed = await api.listThreads({ max: 10 })
    expect(listed.threadIds).toEqual(['t1', 't2'])
    const full = await api.fetchThread('t1')
    expect(full.thread.id).toBe('t1')
    expect(full.messages[0].bodyText).toBe('Hello')
    expect(full.messages[0].fromAddr).toBe('a@x.com')
    expect(fetchMock).toHaveBeenCalledTimes(2)
    // Authorization header carried.
    const init = fetchMock.mock.calls[0][1] as RequestInit
    expect((init.headers as Record<string, string>).authorization).toBe('Bearer AT')
  })

  it('on 401 refreshes and retries once', async () => {
    const fetchMock = vi
      .spyOn(globalThis, 'fetch')
      .mockResolvedValueOnce({ ok: false, status: 401, json: async () => ({}) } as Response)
      .mockResolvedValueOnce(okJson({ threads: [] }))
    const refresh = vi.fn(async () => {})
    const api = createGmailApi({ getAccessToken: async () => 'AT', refreshAccessToken: refresh })
    await api.listThreads({ max: 5 })
    expect(refresh).toHaveBeenCalledTimes(1)
    expect(fetchMock).toHaveBeenCalledTimes(2)
  })

  it('on 429 backs off then succeeds', async () => {
    const fetchMock = vi
      .spyOn(globalThis, 'fetch')
      .mockResolvedValueOnce({ ok: false, status: 429, json: async () => ({}) } as Response)
      .mockResolvedValueOnce(okJson({ threads: [] }))
    const api = createGmailApi({ getAccessToken: async () => 'AT', refreshAccessToken: async () => {} })
    await api.listThreads({ max: 5 })
    expect(fetchMock).toHaveBeenCalledTimes(2)
  })
})
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npm test -- src/main/gmail/api.test.ts`
Expected: FAIL — `./api` not found.

- [ ] **Step 3: Write minimal implementation**

```ts
// src/main/gmail/api.ts
//
// Thin Gmail REST client. Hand-rolled fetch (no `googleapis` dep) to match
// bilibili/api.ts. Each call sets Authorization: Bearer <token>; on 401 it asks
// the caller to refresh and retries once. 429/5xx use bounded backoff.
import { createLogger } from '@shared/logger'
import type { GmailMessage, GmailThread } from '@shared/types/gmail'

const log = createLogger({ process: 'main' }).child({ component: 'gmail-api' })

const BASE = 'https://gmail.googleapis.com/gmail/v1'
export const MAX_THREADS = 200

export type GmailApi = {
  getProfile(): Promise<{ emailAddress: string }>
  listThreads(input?: { label?: string; max?: number }): Promise<{ threadIds: string[] }>
  fetchThread(id: string): Promise<{ thread: GmailThread; messages: GmailMessage[] }>
}

export type GmailApiDeps = {
  getAccessToken(): Promise<string>
  refreshAccessToken(): Promise<void>
}

// URL-safe base64 → UTF-8 string (Gmail uses base64url for message bodies).
export function decodeBase64Url(s: string): string {
  const pad = s.length % 4 === 0 ? '' : '='.repeat(4 - (s.length % 4))
  const b64 = s.replace(/-/g, '+').replace(/_/g, '/') + pad
  return Buffer.from(b64, 'base64').toString('utf8')
}

type Payload = {
  mimeType?: string
  body?: { data?: string }
  parts?: Payload[]
}

// Walk the MIME tree; prefer the first text/plain part, fall back to text/html
// (tags stripped). Returns '' when no textual part exists.
export function pickBodyText(payload: Payload): string {
  if (!payload) return ''
  if (payload.mimeType === 'text/plain' && payload.body?.data) {
    return decodeBase64Url(payload.body.data)
  }
  if (payload.mimeType === 'text/html' && payload.body?.data) {
    return decodeBase64Url(payload.body.data).replace(/<[^>]*>/g, ' ').replace(/\s+/g, ' ').trim()
  }
  if (payload.parts) {
    for (const p of payload.parts) {
      const t = pickBodyText(p)
      if (t) return t
    }
  }
  return ''
}

function header(payload: Payload, name: string): string {
  const hs = (payload as { headers?: { name: string; value: string }[] }).headers ?? []
  return hs.find((h) => h.name.toLowerCase() === name.toLowerCase())?.value ?? ''
}

// 429/5xx: bounded exponential backoff (max 3 attempts). 401: refresh once.
const MAX_ATTEMPTS = 3
const BACKOFF_BASE_MS = 200

async function getJson(url: string, deps: GmailApiDeps): Promise<unknown> {
  for (let attempt = 0; ; attempt++) {
    const token = await deps.getAccessToken()
    const res = await fetch(url, { headers: { authorization: `Bearer ${token}` } })
    if (res.status === 401) {
      log.warn({ msg: 'gmail 401; refreshing and retrying once' })
      await deps.refreshAccessToken()
      const token2 = await deps.getAccessToken()
      const res2 = await fetch(url, { headers: { authorization: `Bearer ${token2}` } })
      if (!res2.ok) throw new Error(`gmail api ${res2.status}`)
      return res2.json()
    }
    if ((res.status === 429 || res.status >= 500) && attempt < MAX_ATTEMPTS - 1) {
      const delayMs = BACKOFF_BASE_MS * 2 ** attempt
      log.warn({ msg: 'gmail retryable status; backing off', status: res.status, attempt, delayMs })
      await new Promise((r) => setTimeout(r, delayMs))
      continue
    }
    if (!res.ok) throw new Error(`gmail api ${res.status}`)
    return res.json()
  }
}

export function createGmailApi(deps: GmailApiDeps): GmailApi {
  return {
    async getProfile() {
      const j = (await getJson(`${BASE}/users/me/profile`, deps)) as { emailAddress?: string }
      return { emailAddress: j.emailAddress ?? '' }
    },

    async listThreads(input) {
      const max = Math.min(input?.max ?? MAX_THREADS, MAX_THREADS)
      const label = input?.label ?? 'INBOX'
      const u = new URL(`${BASE}/users/me/threads`)
      u.searchParams.set('labelIds', label)
      u.searchParams.set('maxResults', String(max))
      const j = (await getJson(u.toString(), deps)) as { threads?: { id: string }[]; nextPageToken?: string }
      const threadIds = (j.threads ?? []).map((t) => t.id)
      return { threadIds }
    },

    async fetchThread(id) {
      const j = (await getJson(`${BASE}/users/me/threads/${id}`, deps)) as {
        id: string
        snippet?: string
        labelIds?: string[]
        messages?: Array<{
          id: string
          threadId: string
          snippet?: string
          labelIds?: string[]
          internalDate?: string
          payload?: Payload
        }>
      }
      const msgs = j.messages ?? []
      const messages: GmailMessage[] = msgs.map((m) => {
        const from = header(m.payload ?? {}, 'From')
        const to = header(m.payload ?? {}, 'To')
          .split(',')
          .map((s) => s.trim())
          .filter(Boolean)
        return {
          id: m.id,
          threadId: m.threadId,
          fromAddr: from,
          toAddrs: to,
          subject: header(m.payload ?? {}, 'Subject'),
          snippet: m.snippet ?? '',
          bodyText: pickBodyText(m.payload ?? {}),
          dateMs: m.internalDate ? Number(m.internalDate) : 0,
          labelIds: m.labelIds ?? [],
        }
      })
      const last = messages[messages.length - 1]
      const thread: GmailThread = {
        id: j.id,
        snippet: j.snippet ?? '',
        fromAddr: last?.fromAddr ?? '',
        subject: last?.subject ?? '',
        lastDateMs: last?.dateMs ?? 0,
        labelIds: j.labelIds ?? [],
        unread: (j.labelIds ?? []).includes('UNREAD'),
      }
      return { thread, messages }
    },
  }
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npm test -- src/main/gmail/api.test.ts`
Expected: PASS (7 tests).

- [ ] **Step 5: Commit**

```bash
git add src/main/gmail/api.ts src/main/gmail/api.test.ts
git commit -m "feat(gmail): add REST client with MIME body extraction"
```

---

## Task 6: OAuth loopback auth + token refresh

**Files:**
- Create: `src/main/gmail/auth.ts`
- Test: `src/main/gmail/auth.test.ts`

**Interfaces:**
- Consumes: `Store` from Task 3, `GmailConfigOnDisk`, `GmailConfigView` from Task 1.
- Produces:
  - `createAuth({ store, onProfile }): Auth` where `onProfile` fetches the profile after tokens land (injectable for tests; production wires `api.getProfile`).
  - `Auth.login(): Promise<void>` — runs loopback OAuth; rejects on timeout/missing-creds.
  - `Auth.logout(): Promise<void>`
  - `Auth.getAccessToken(): Promise<string>` — refresh-on-expiry; throws if not linked.
  - `Auth.refreshAccessToken(): Promise<void>` — force refresh.
  - Pure helpers exported for testing: `exchangeCode(...)`, `refreshTokens(...)`, `extractCode(callbackUrl)`.

- [ ] **Step 1: Write the failing test**

```ts
// src/main/gmail/auth.test.ts
import { afterEach, describe, expect, it, vi } from 'vitest'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createStore } from './store'
import { createAuth, exchangeCode, extractCode, refreshTokens } from './auth'

vi.mock('electron', () => ({
  safeStorage: {
    encryptString: (s: string) => Buffer.from(s, 'utf8'),
    decryptString: (b: Buffer) => b.toString('utf8'),
    isEncryptionAvailable: () => true,
  },
}))

let dir: string
afterEach(() => dir && rmSync(dir, { recursive: true, force: true }))

const creds = { clientId: 'cid', clientSecret: 'sec' }

describe('gmail auth helpers', () => {
  it('extractCode pulls code from callback query', () => {
    expect(extractCode('/?code=4/0abc&scope=foo')).toBe('4/0abc')
    expect(extractCode('/?error=access_denied')).toBeNull()
  })

  it('exchangeCode posts and returns tokens', async () => {
    const fetchMock = vi.spyOn(globalThis, 'fetch').mockResolvedValueOnce(
      ({ ok: true, json: async () => ({ access_token: 'AT', refresh_token: 'RT', expires_in: 3600 }) }) as Response,
    )
    const r = await exchangeCode({
      creds,
      code: 'C',
      redirectUri: 'http://127.0.0.1:3999',
    })
    expect(r).toEqual({ accessToken: 'AT', refreshToken: 'RT', expiresAt: expect.any(Number) })
    expect(r.expiresAt).toBeGreaterThan(Date.now())
    const init = fetchMock.mock.calls[0][1] as RequestInit
    expect(init.method).toBe('POST')
  })

  it('refreshTokens returns refreshed accessToken', async () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValueOnce(
      ({ ok: true, json: async () => ({ access_token: 'AT2', expires_in: 100 }) }) as Response,
    )
    const r = await refreshTokens({ creds, refreshToken: 'RT' })
    expect(r.accessToken).toBe('AT2')
  })
})

describe('createAuth token handling', () => {
  it('getAccessToken refreshes when expired', async () => {
    dir = mkdtempSync(join(tmpdir(), 'gmail-'))
    const store = createStore({ filePath: join(dir, 'gmail.enc') })
    await store.save({
      clientCreds: creds,
      tokens: { accessToken: 'old', refreshToken: 'RT', expiresAt: Date.now() - 1000 },
      accountEmail: 'me@x.com',
    })
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(
      ({ ok: true, json: async () => ({ access_token: 'fresh', expires_in: 3600 }) }) as Response,
    )
    const auth = createAuth({ store, onProfile: async () => ({ emailAddress: 'me@x.com' }) })
    const at = await auth.getAccessToken()
    expect(at).toBe('fresh')
    const after = await store.load()
    expect(after.tokens?.accessToken).toBe('fresh')
  })

  it('getAccessToken throws when not linked', async () => {
    dir = mkdtempSync(join(tmpdir(), 'gmail-'))
    const store = createStore({ filePath: join(dir, 'gmail.enc') })
    const auth = createAuth({ store, onProfile: async () => ({ emailAddress: '' }) })
    await expect(auth.getAccessToken()).rejects.toThrow(/not linked/i)
  })
})
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npm test -- src/main/gmail/auth.test.ts`
Expected: FAIL — `./auth` not found.

- [ ] **Step 3: Write minimal implementation**

```ts
// src/main/gmail/auth.ts
//
// Gmail OAuth via a loopback HTTP server (Google's installed-app flow). Opens
// the consent URL in the system browser; the loopback server captures the
// ?code= redirect, exchanges it for tokens, and persists them (encrypted).
// Token refresh runs on-demand when getAccessToken sees an expired token.
import { createServer, type Server } from 'node:http'
import { AddressInfo } from 'node:net'
import { shell } from 'electron'
import { createLogger } from '@shared/logger'
import type { GmailClientCreds, GmailConfigOnDisk, GmailTokens } from '@shared/types/gmail'

import type { Store } from './store'

const log = createLogger({ process: 'main' }).child({ component: 'gmail-auth' })

const SCOPE = 'https://www.googleapis.com/auth/gmail.readonly'
const TOKEN_ENDPOINT = 'https://oauth2.googleapis.com/token'
const CONSENT_URL = 'https://accounts.google.com/o/oauth2/v2/auth'
const LOGIN_TIMEOUT_MS = 5 * 60 * 1000

export type CodeExchangeResult = { accessToken: string; refreshToken: string; expiresAt: number }

export function extractCode(callbackPath: string): string | null {
  try {
    const idx = callbackPath.indexOf('?')
    const qs = new URLSearchParams(idx >= 0 ? callbackPath.slice(idx + 1) : callbackPath)
    return qs.get('code')
  } catch {
    return null
  }
}

export async function exchangeCode(input: {
  creds: GmailClientCreds
  code: string
  redirectUri: string
}): Promise<CodeExchangeResult> {
  const body = new URLSearchParams({
    code: input.code,
    client_id: input.creds.clientId,
    client_secret: input.creds.clientSecret,
    redirect_uri: input.redirectUri,
    grant_type: 'authorization_code',
  })
  const res = await fetch(TOKEN_ENDPOINT, { method: 'POST', body })
  if (!res.ok) {
    const t = await res.text()
    throw new Error(`token exchange failed: ${res.status} ${t}`)
  }
  const j = (await res.json()) as { access_token: string; refresh_token?: string; expires_in: number }
  if (!j.refresh_token) throw new Error('no refresh_token returned (re-link with prompt=consent)')
  return {
    accessToken: j.access_token,
    refreshToken: j.refresh_token,
    expiresAt: Date.now() + j.expires_in * 1000,
  }
}

export async function refreshTokens(input: {
  creds: GmailClientCreds
  refreshToken: string
}): Promise<{ accessToken: string; expiresAt: number }> {
  const body = new URLSearchParams({
    refresh_token: input.refreshToken,
    client_id: input.creds.clientId,
    client_secret: input.creds.clientSecret,
    grant_type: 'refresh_token',
  })
  const res = await fetch(TOKEN_ENDPOINT, { method: 'POST', body })
  if (!res.ok) throw new Error(`refresh failed: ${res.status}`)
  const j = (await res.json()) as { access_token: string; expires_in: number }
  return { accessToken: j.access_token, expiresAt: Date.now() + j.expires_in * 1000 }
}

export type Auth = {
  login(): Promise<void>
  logout(): Promise<void>
  getAccessToken(): Promise<string>
  refreshAccessToken(): Promise<void>
}

export type AuthDeps = {
  store: Store
  /** Fetch the Gmail profile once tokens land; returns { emailAddress }. */
  onProfile: (token: string) => Promise<{ emailAddress: string }>
}

export function createAuth(deps: AuthDeps): Auth {
  const { store } = deps

  const persistTokens = async (next: GmailTokens, email?: string): Promise<void> => {
    const cur = await store.load()
    const state: GmailConfigOnDisk = {
      clientCreds: cur.clientCreds,
      tokens: next,
      accountEmail: email ?? cur.accountEmail,
    }
    await store.save(state)
  }

  const getAccessToken: Auth['getAccessToken'] = async () => {
    const cfg = await store.load()
    if (!cfg.tokens) throw new Error('Gmail not linked')
    const skew = 60_000
    if (cfg.tokens.expiresAt - skew > Date.now()) return cfg.tokens.accessToken
    await refreshAccessToken()
    const after = await store.load()
    if (!after.tokens) throw new Error('Gmail not linked after refresh')
    return after.tokens.accessToken
  }

  const refreshAccessToken: Auth['refreshAccessToken'] = async () => {
    const cfg = await store.load()
    if (!cfg.clientCreds || !cfg.tokens) throw new Error('Gmail not linked')
    log.info({ msg: 'refreshing gmail access token' })
    const r = await refreshTokens({ creds: cfg.clientCreds, refreshToken: cfg.tokens.refreshToken })
    await persistTokens({ refreshToken: cfg.tokens.refreshToken, ...r })
  }

  const login: Auth['login'] = () =>
    new Promise<void>((resolve, reject) => {
      store.load().then((cfg) => {
        if (!cfg.clientCreds) {
          reject(new Error('missing OAuth client credentials'))
          return
        }
        const creds = cfg.clientCreds
        let server: Server | null = null
        let settled = false
        const finish = (fn: () => void): void => {
          if (settled) return
          settled = true
          clearTimeout(deadline)
          server?.close()
          fn()
        }
        const deadline = setTimeout(() => {
          log.warn({ msg: 'gmail login timed out' })
          finish(() => reject(new Error('login timed out')))
        }, LOGIN_TIMEOUT_MS)

        server = createServer(async (req, res) => {
          const url = req.url ?? '/'
          const code = extractCode(url)
          if (!code) {
            res.writeHead(400, { 'content-type': 'text/plain; charset=utf-8' })
            res.end('Missing code parameter.')
            return
          }
          try {
            const tokens = await exchangeCode({ creds, code, redirectUri: redirectUriHeld! })
            const profile = await deps.onProfile(tokens.accessToken)
            await persistTokens(tokens, profile.emailAddress)
            log.info({ msg: 'gmail login captured', email: profile.emailAddress })
            res.writeHead(200, { 'content-type': 'text/plain; charset=utf-8' })
            res.end('Linked. You can close this tab.')
            finish(() => resolve())
          } catch (err) {
            log.error({ msg: 'gmail login exchange failed', err: err instanceof Error ? err.message : String(err) })
            res.writeHead(500, { 'content-type': 'text/plain; charset=utf-8' })
            res.end('Link failed. Check the app.')
            finish(() => reject(err instanceof Error ? err : new Error(String(err))))
          }
        })
        server.on('error', (err) => finish(() => reject(err)))
        // Hold the redirect URI so the handler closes over the actual port.
        let redirectUriHeld: string | null = null
        server.listen(0, '127.0.0.1', () => {
          const port = (server!.address() as AddressInfo).port
          redirectUriHeld = `http://127.0.0.1:${port}`
          const u = new URL(CONSENT_URL)
          u.searchParams.set('client_id', creds.clientId)
          u.searchParams.set('redirect_uri', redirectUriHeld)
          u.searchParams.set('response_type', 'code')
          u.searchParams.set('scope', SCOPE)
          u.searchParams.set('access_type', 'offline')
          u.searchParams.set('prompt', 'consent')
          log.info({ msg: 'gmail consent opening', redirectUri: redirectUriHeld })
          void shell.openExternal(u.toString())
        })
      })
    })

  const logout: Auth['logout'] = async () => {
    const cur = await store.load()
    await store.save({ ...cur, tokens: null, accountEmail: null })
    log.info({ msg: 'gmail logged out' })
  }

  return { login, logout, getAccessToken, refreshAccessToken }
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npm test -- src/main/gmail/auth.test.ts`
Expected: PASS (5 tests).

- [ ] **Step 5: Commit**

```bash
git add src/main/gmail/auth.ts src/main/gmail/auth.test.ts
git commit -m "feat(gmail): add OAuth loopback auth and token refresh"
```

---

## Task 7: Resident sync daemon

**Files:**
- Create: `src/main/gmail/daemon.ts`
- Test: `src/main/gmail/daemon.test.ts`

**Interfaces:**
- Consumes: `GmailApi` from Task 5, `Cache` from Task 4.
- Produces: `createDaemon({ api, cache, onSynced, intervalMs? }): Daemon` where:
  - `Daemon.start(): void` — interval (default 5 min) + immediate poll. Only called by the service when an account is linked, so the daemon trusts its start/stop lifecycle (no `isLinked` guard).
  - `Daemon.stop(): void`
  - `Daemon.pollOnce(): Promise<void>` — exported for testing.
  - `onSynced(payload: { count: number; ts: number; deletionsNotTracked: true; error?: string }): void`

- [ ] **Step 1: Write the failing test**

```ts
// src/main/gmail/daemon.test.ts
import { describe, expect, it, vi } from 'vitest'
import { createCache } from './cache'
import { createDaemon } from './daemon'

function fakeApi(threadIds: string[]) {
  return {
    getProfile: async () => ({ emailAddress: 'me@x.com' }),
    listThreads: async () => ({ threadIds }),
    fetchThread: async (id: string) => ({
      thread: { id, snippet: `s${id}`, fromAddr: 'a@x.com', subject: `Sub ${id}`, lastDateMs: Number(id), labelIds: ['INBOX'], unread: true },
      messages: [{ id: `m-${id}`, threadId: id, fromAddr: 'a@x.com', toAddrs: [], subject: `Sub ${id}`, snippet: 'sn', bodyText: 'body', dateMs: Number(id), labelIds: ['INBOX'] }],
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
    const api = { ...fakeApi([]), listThreads: async () => { throw new Error('boom') } }
    const synced = vi.fn()
    const d = createDaemon({ api, cache, intervalMs: 60_000, onSynced: synced })
    await expect(d.pollOnce()).resolves.toBeUndefined()
    expect(synced).toHaveBeenCalledWith(expect.objectContaining({ error: expect.stringContaining('boom') }))
    d.stop()
    cache.close()
  })
})
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npm test -- src/main/gmail/daemon.test.ts`
Expected: FAIL — `./daemon` not found.

- [ ] **Step 3: Write minimal implementation**

```ts
// src/main/gmail/daemon.ts
//
// Resident Gmail sync daemon. Polls the inbox on a fixed interval and upserts
// the threads/messages into the cache. v1 uses re-list + UPSERT (idempotent):
// it does NOT track deletions or older-thread updates — the `gmail.synced`
// event carries `deletionsNotTracked: true` so the limitation is visible.
import { createLogger } from '@shared/logger'

import type { Cache } from './cache'
import type { GmailApi } from './api'

const log = createLogger({ process: 'main' }).child({ component: 'gmail-daemon' })

const DEFAULT_INTERVAL_MS = 5 * 60 * 1000

export type SyncedPayload = { count: number; ts: number; deletionsNotTracked: true; error?: string }

export type Daemon = {
  start(): void
  stop(): void
  pollOnce(): Promise<void>
}

export type DaemonDeps = {
  api: GmailApi
  cache: Cache
  onSynced?(payload: SyncedPayload): void
  intervalMs?: number
}

export function createDaemon(deps: DaemonDeps): Daemon {
  const intervalMs = deps.intervalMs ?? DEFAULT_INTERVAL_MS
  let timer: ReturnType<typeof setInterval> | null = null

  const pollOnce: Daemon['pollOnce'] = async () => {
    const ts = Date.now()
    try {
      const { threadIds } = await deps.api.listThreads({ max: 200 })
      const threads = []
      const messages = []
      for (const id of threadIds) {
        const full = await deps.api.fetchThread(id)
        threads.push(full.thread)
        messages.push(...full.messages)
      }
      deps.cache.upsertThreads(threads)
      deps.cache.upsertMessages(messages)
      deps.cache.setStats({ messageCount: messages.length, lastSyncAt: ts })
      log.info({ msg: 'gmail synced', count: threads.length })
      deps.onSynced?.({ count: threads.length, ts, deletionsNotTracked: true })
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err)
      log.error({ msg: 'gmail sync failed', err: msg })
      deps.onSynced?.({ count: 0, ts, deletionsNotTracked: true, error: msg })
    }
  }

  return {
    start() {
      if (timer) return
      void pollOnce()
      timer = setInterval(() => void pollOnce(), intervalMs)
      log.info({ msg: 'gmail daemon started', intervalMs })
    },
    stop() {
      if (timer) clearInterval(timer)
      timer = null
      log.info({ msg: 'gmail daemon stopped' })
    },
    pollOnce,
  }
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npm test -- src/main/gmail/daemon.test.ts`
Expected: PASS (2 tests).

- [ ] **Step 5: Commit**

```bash
git add src/main/gmail/daemon.ts src/main/gmail/daemon.test.ts
git commit -m "feat(gmail): add resident sync daemon"
```

---

## Task 8: Config state machine + query service

**Files:**
- Create: `src/main/gmail/service.ts`
- Test: `src/main/gmail/service.test.ts`

**Interfaces:**
- Consumes: `Store` (Task 3), `Cache` (Task 4), `Auth` (Task 6), `Daemon` (Task 7).
- Produces:
  - `createService({ store, cache, auth, daemon }): Service`
  - `Service.setClientCreds(creds): Promise<SetResult>` / `clearClientCreds()`
  - `Service.linkAccount(): Promise<SetResult>` (calls `auth.login`, starts daemon)
  - `Service.unlinkAccount(): Promise<SetResult>` (logout, stop daemon)
  - `Service.getView(): GmailConfigView`
  - `Service.search(q, limit): GmailThread[]` / `getThread(id)` / `listRecent({limit,label})`
  - `Service.syncNow(): Promise<void>` (calls `daemon.pollOnce`)
  - `Service.onStateChanged(cb): () => void`

- [ ] **Step 1: Write the failing test**

```ts
// src/main/gmail/service.test.ts
import { afterEach, describe, expect, it, vi } from 'vitest'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createStore } from './store'
import { createCache } from './cache'
import { createService } from './service'

vi.mock('electron', () => ({
  safeStorage: {
    encryptString: (s: string) => Buffer.from(s, 'utf8'),
    decryptString: (b: Buffer) => b.toString('utf8'),
    isEncryptionAvailable: () => true,
  },
  shell: { openExternal: async () => {} },
}))

let dir: string
afterEach(() => dir && rmSync(dir, { recursive: true, force: true }))

function fakeAuth(overrides: Partial<{ login: () => Promise<void>; logout: () => Promise<void> }> = {}) {
  return {
    login: overrides.login ?? async () => {},
    logout: overrides.logout ?? async () => {},
    getAccessToken: async () => 'AT',
    refreshAccessToken: async () => {},
  }
}

describe('gmail service', () => {
  it('setClientCreds persists and updates view', async () => {
    dir = mkdtempSync(join(tmpdir(), 'gmail-'))
    const store = createStore({ filePath: join(dir, 'gmail.enc') })
    const cache = createCache({ filePath: ':memory:' })
    const daemon = { start: vi.fn(), stop: vi.fn(), pollOnce: vi.fn() }
    const svc = createService({ store, cache, auth: fakeAuth(), daemon })
    const r = await svc.setClientCreds({ clientId: 'cid', clientSecret: 'sec' })
    expect(r.ok).toBe(true)
    expect(svc.getView().hasClientCreds).toBe(true)
    expect(svc.getView().loggedIn).toBe(false)
    cache.close()
  })

  it('linkAccount starts daemon; unlink stops it', async () => {
    dir = mkdtempSync(join(tmpdir(), 'gmail-'))
    const store = createStore({ filePath: join(dir, 'gmail.enc') })
    await store.save({ clientCreds: { clientId: 'cid', clientSecret: 'sec' }, tokens: null, accountEmail: null })
    const cache = createCache({ filePath: ':memory:' })
    const daemon = { start: vi.fn(), stop: vi.fn(), pollOnce: vi.fn() }
    const auth = fakeAuth({ login: async () => {} })
    const svc = createService({ store, cache, auth, daemon })
    await svc.linkAccount()
    expect(daemon.start).toHaveBeenCalledTimes(1)
    await svc.unlinkAccount()
    expect(daemon.stop).toHaveBeenCalledTimes(1)
    cache.close()
  })

  it('query methods read cache', async () => {
    dir = mkdtempSync(join(tmpdir(), 'gmail-'))
    const store = createStore({ filePath: join(dir, 'gmail.enc') })
    const cache = createCache({ filePath: ':memory:' })
    cache.upsertThreads([{ id: 't1', snippet: 'invoice', fromAddr: '', subject: '', lastDateMs: 1, labelIds: ['INBOX'], unread: false }])
    const svc = createService({ store, cache, auth: fakeAuth(), daemon: { start: vi.fn(), stop: vi.fn(), pollOnce: vi.fn() } })
    expect(svc.search('invoice', 10).map((t) => t.id)).toEqual(['t1'])
    expect(svc.getThread('t1')?.thread.id).toBe('t1')
    expect(svc.listRecent({ limit: 5 }).map((t) => t.id)).toEqual(['t1'])
    cache.close()
  })
})
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npm test -- src/main/gmail/service.test.ts`
Expected: FAIL — `./service` not found.

- [ ] **Step 3: Write minimal implementation**

```ts
// src/main/gmail/service.ts
//
// Config state machine over the encrypted store + query facade over the cache.
// Mirrors budgets/web-search service. Link/unlink drive daemon lifecycle. The
// async store is mirrored into `cachedConfig` on every mutation so getView()
// stays a synchronous snapshot for ipcMain.handle.
import { createLogger } from '@shared/logger'
import type { GmailClientCreds, GmailConfigOnDisk, GmailConfigView } from '@shared/types/gmail'

import type { Cache } from './cache'
import type { Daemon } from './daemon'
import type { Auth } from './auth'
import type { Store } from './store'

const log = createLogger({ process: 'main' }).child({ component: 'gmail-service' })

export type SetResult = { ok: true } | { ok: false; code: 'invalid' | 'persist_failed' | 'not_linked'; message: string }

export type Service = {
  setClientCreds(creds: GmailClientCreds): Promise<SetResult>
  clearClientCreds(): Promise<SetResult>
  linkAccount(): Promise<SetResult>
  unlinkAccount(): Promise<SetResult>
  getView(): GmailConfigView
  syncNow(): Promise<void>
  search(query: string, limit: number): ReturnType<Cache['search']>
  getThread(id: string): ReturnType<Cache['getThread']>
  listRecent(input: { limit: number; label?: string }): ReturnType<Cache['listRecent']>
  onStateChanged(cb: (view: GmailConfigView) => void): () => void
}

export type ServiceDeps = {
  store: Store
  cache: Cache
  auth: Auth
  daemon: Daemon
}

export async function createService(deps: ServiceDeps): Promise<Service> {
  const listeners = new Set<(v: GmailConfigView) => void>()
  let cachedConfig: GmailConfigOnDisk = await deps.store.load()
  let syncError: string | null = null

  const snapshot = (): GmailConfigView => {
    const stats = deps.cache.stats()
    return {
      hasClientCreds: !!cachedConfig.clientCreds,
      loggedIn: !!cachedConfig.tokens,
      accountEmail: cachedConfig.accountEmail,
      lastSyncAt: stats.lastSyncAt || null,
      messageCount: stats.messageCount || null,
      syncError,
    }
  }
  const emit = (): void => {
    const v = snapshot()
    for (const cb of listeners) cb(v)
  }

  // If already linked at boot (tokens present), keep the daemon running.
  if (cachedConfig.tokens) deps.daemon.start()

  return {
    async setClientCreds(creds) {
      try {
        const next = { ...cachedConfig, clientCreds: creds }
        await deps.store.save(next)
        cachedConfig = next
      } catch (e) {
        return { ok: false, code: 'persist_failed', message: e instanceof Error ? e.message : String(e) }
      }
      emit()
      return { ok: true }
    },
    async clearClientCreds() {
      const next = { ...cachedConfig, clientCreds: null }
      await deps.store.save(next)
      cachedConfig = next
      emit()
      return { ok: true }
    },
    async linkAccount() {
      if (!cachedConfig.clientCreds) return { ok: false, code: 'not_linked', message: 'missing OAuth client credentials' }
      try {
        await deps.auth.login()
      } catch (e) {
        const msg = e instanceof Error ? e.message : String(e)
        log.error({ msg: 'link account failed', err: msg })
        syncError = msg
        emit()
        return { ok: false, code: 'persist_failed', message: msg }
      }
      cachedConfig = await deps.store.load()
      syncError = null
      deps.daemon.start()
      emit()
      return { ok: true }
    },
    async unlinkAccount() {
      deps.daemon.stop()
      await deps.auth.logout()
      cachedConfig = await deps.store.load()
      emit()
      return { ok: true }
    },
    async syncNow() {
      await deps.daemon.pollOnce()
      syncError = null
      emit()
    },
    getView: () => snapshot(),
    search: (q, limit) => deps.cache.search(q, limit),
    getThread: (id) => deps.cache.getThread(id),
    listRecent: (input) => deps.cache.listRecent(input),
    onStateChanged(cb) {
      listeners.add(cb)
      return () => listeners.delete(cb)
    },
  }
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npm test -- src/main/gmail/service.test.ts`
Expected: PASS (3 tests).

- [ ] **Step 5: Commit**

```bash
git add src/main/gmail/service.ts src/main/gmail/service.test.ts
git commit -m "feat(gmail): add config state machine and query service"
```

---

## Task 9: paths + IPC + slice wiring

**Files:**
- Modify: `src/main/constants.ts`
- Create: `src/main/gmail/ipc.ts` (+ test)
- Create: `src/main/gmail/index.ts`

**Interfaces:**
- Consumes: `Service` from Task 8, `ServiceClient` type from `src/main/service-client.ts`.
- Produces: `paths.gmail()` / `paths.gmailDb()`; `wireGmailIpc({ service })`; `initGmail(opts): Promise<GmailHandle>` where `GmailHandle = { service: Service; registerMainRpc(client): void; dispose(): void }`.

- [ ] **Step 1: Add paths**

Edit `src/main/constants.ts` — inside the `paths` object, after the `budgets` entry:

```ts
  gmail: () => join(app.getPath('userData'), 'gmail.enc'),
  gmailDb: () => join(app.getPath('userData'), 'gmail.db'),
```

- [ ] **Step 2: Write the failing IPC test**

```ts
// src/main/gmail/ipc.test.ts
import { describe, expect, it, vi } from 'vitest'
import { wireGmailIpc } from './ipc'

// Minimal electron ipcMain stub capturing handlers.
const handlers = new Map<string, (...args: unknown[]) => unknown>()
vi.mock('electron', () => ({
  ipcMain: {
    handle: (channel: string, fn: (...args: unknown[]) => unknown) => handlers.set(channel, fn),
    removeHandler: (channel: string) => handlers.delete(channel),
  },
  BrowserWindow: { getAllWindows: () => [] },
}))

describe('gmail ipc', () => {
  it('getStatus delegates to service.getView', async () => {
    const view = { hasClientCreds: true, loggedIn: false, accountEmail: null, lastSyncAt: null, messageCount: null, syncError: null }
    const service = { getView: () => view, onStateChanged: () => () => {} } as unknown as Parameters<typeof wireGmailIpc>[0]['service']
    const { dispose } = wireGmailIpc({ service })
    const r = await handlers.get('gmail:getStatus')!()
    expect(r).toEqual(view)
    dispose()
  })

  it('setClientCreds delegates and returns SetResult', async () => {
    const service = { setClientCreds: vi.fn(async () => ({ ok: true as const })), getView: () => null, onStateChanged: () => () => {} } as unknown as Parameters<typeof wireGmailIpc>[0]['service']
    const { dispose } = wireGmailIpc({ service })
    const r = await handlers.get('gmail:setClientCreds')!({}, { clientId: 'c', clientSecret: 's' })
    expect(r).toEqual({ ok: true })
    expect(service.setClientCreds).toHaveBeenCalledWith({ clientId: 'c', clientSecret: 's' })
    dispose()
  })

  it('main-rpc handlers map gmail.search → service.search', async () => {
    const service = { search: vi.fn(() => [{ id: 't1' }]), getView: () => null, onStateChanged: () => () => {} } as unknown as Parameters<typeof wireGmailIpc>[0]['service']
    const { dispose, mainRpcHandlers } = wireGmailIpc({ service })
    const r = await mainRpcHandlers['gmail.search']('inv', 10)
    expect(r).toEqual([{ id: 't1' }])
    expect(service.search).toHaveBeenCalledWith('inv', 10)
    dispose()
  })
})
```

- [ ] **Step 3: Run test to verify it fails**

Run: `npm test -- src/main/gmail/ipc.test.ts`
Expected: FAIL — `./ipc` not found.

- [ ] **Step 4: Write minimal implementation**

```ts
// src/main/gmail/ipc.ts
//
// Wires the Gmail service to Electron IPC (renderer-facing handlers) and
// exposes the main-rpc query handlers the service→main bridge dispatches to.
// Mirrors budgets/ipc.ts; broadcasts gmail:stateChanged to all windows.
import type { GmailClientCreds } from '@shared/types/gmail'
import type { MainMethod } from '@shared/types/service-ipc'
import { BrowserWindow, ipcMain } from 'electron'

import type { Service } from './service'

const STATE_CHANGED = 'gmail:stateChanged'

export type MainRpcHandlers = Record<MainMethod, (...args: unknown[]) => Promise<unknown>>

export function wireGmailIpc(args: { service: Service }): {
  dispose: () => void
  mainRpcHandlers: MainRpcHandlers
} {
  const { service } = args

  const unsubscribe = service.onStateChanged((view) => {
    for (const w of BrowserWindow.getAllWindows()) {
      if (!w.isDestroyed()) w.webContents.send(STATE_CHANGED, view)
    }
  })

  ipcMain.handle('gmail:getStatus', () => service.getView())
  ipcMain.handle('gmail:setClientCreds', (_e, creds: GmailClientCreds) => service.setClientCreds(creds))
  ipcMain.handle('gmail:clearClientCreds', () => service.clearClientCreds())
  ipcMain.handle('gmail:linkAccount', () => service.linkAccount())
  ipcMain.handle('gmail:unlinkAccount', () => service.unlinkAccount())
  ipcMain.handle('gmail:syncNow', () => service.syncNow())

  const mainRpcHandlers: MainRpcHandlers = {
    'gmail.search': (q, limit) => Promise.resolve(service.search(String(q), Number(limit ?? 20))),
    'gmail.get_thread': (id) => Promise.resolve(service.getThread(String(id))),
    'gmail.list_recent': (input) =>
      Promise.resolve(service.listRecent((input as { limit?: number; label?: string }) ?? { limit: 20 })),
  }

  return {
    dispose() {
      unsubscribe()
      for (const ch of [
        'gmail:getStatus',
        'gmail:setClientCreds',
        'gmail:clearClientCreds',
        'gmail:linkAccount',
        'gmail:unlinkAccount',
        'gmail:syncNow',
      ]) {
        ipcMain.removeHandler(ch)
      }
    },
    mainRpcHandlers,
  }
}
```

- [ ] **Step 5: Run test to verify it passes**

Run: `npm test -- src/main/gmail/ipc.test.ts`
Expected: PASS (3 tests).

- [ ] **Step 6: Write the slice wiring**

```ts
// src/main/gmail/index.ts
//
// Entry point for the Gmail subsystem. Wires the encrypted store, sqlite
// cache, REST client, OAuth auth, daemon, service, and IPC. Runs after
// app.whenReady(). registerMainRpc is called from main wiring once the
// ServiceClient exists.
import type { ServiceClient } from '../service-client'
import { paths } from '../constants'
import { createGmailApi } from './api'
import { createAuth } from './auth'
import { createCache } from './cache'
import { createDaemon } from './daemon'
import { wireGmailIpc } from './ipc'
import { createService, type Service } from './service'
import { createStore } from './store'

export type GmailHandle = {
  service: Service
  registerMainRpc(client: ServiceClient): void
  dispose(): void
}

export async function initGmail(): Promise<GmailHandle> {
  const store = createStore({ filePath: paths.gmail() })
  const cache = createCache({ filePath: paths.gmailDb() })
  const auth = createAuth({
    store,
    onProfile: async (token) => {
      const api = createGmailApi({
        getAccessToken: async () => token,
        refreshAccessToken: async () => {},
      })
      return api.getProfile()
    },
  })
  const api = createGmailApi(auth)
  const daemon = createDaemon({ api, cache })
  const service = await createService({ store, cache, auth, daemon })
  const wired = wireGmailIpc({ service })

  return {
    service,
    registerMainRpc(client) {
      ;(Object.keys(wired.mainRpcHandlers) as Array<keyof typeof wired.mainRpcHandlers>).forEach((method) => {
        client.registerMainRpc(method, wired.mainRpcHandlers[method])
      })
    },
    dispose() {
      wired.dispose()
      daemon.stop()
      cache.close()
    },
  }
}
```

- [ ] **Step 7: Commit**

```bash
git add src/main/constants.ts src/main/gmail/ipc.ts src/main/gmail/ipc.test.ts src/main/gmail/index.ts
git commit -m "feat(gmail): add IPC handlers and slice wiring"
```

---

## Task 10: Main-side mainRequest routing

**Files:**
- Modify: `src/main/service-client.ts`

**Interfaces:**
- Consumes: `MainRequest`, `MainResponse`, `MainMethod` from Task 2.
- Produces: `ServiceClient.registerMainRpc(method, fn)`; the `handle(message)` branch that routes `mainRequest` → handler → posts `mainResponse`.

- [ ] **Step 1: Write the failing test**

```ts
// src/main/service-client.mainrpc.test.ts
import { describe, expect, it, vi } from 'vitest'
import { createServiceClient, type ServiceTransport } from './service-client'

function fakeTransport(): { t: ServiceTransport; sent: unknown[] } {
  const sent: unknown[] = []
  let listener: ((m: unknown) => void) | null = null
  return {
    sent,
    t: {
      postMessage: (m: unknown) => sent.push(m),
      on: (_c: 'message', l: (m: unknown) => void) => {
        listener = l
      },
      off: () => {
        listener = null
      },
    } as unknown as ServiceTransport,
    deliver(m: unknown) {
      listener?.(m)
    },
  }
}

describe('service-client mainRequest routing', () => {
  it('routes mainRequest to a registered handler and posts mainResponse', async () => {
    const { t, sent, deliver } = fakeTransport()
    const client = createServiceClient({ transport: t })
    await client.connect()
    client.registerMainRpc('gmail.search', async (q, limit) => [{ id: 't1', q, limit }])

    deliver({ kind: 'mainRequest', id: 77, method: 'gmail.search', args: ['inv', 5] })
    // Let the promise resolve.
    await Promise.resolve()
    await Promise.resolve()

    expect(sent).toEqual([
      { kind: 'mainResponse', id: 77, ok: true, result: [{ id: 't1', q: 'inv', limit: 5 }] },
    ])
  })

  it('posts an error response when the handler throws', async () => {
    const { t, sent, deliver } = fakeTransport()
    const client = createServiceClient({ transport: t })
    await client.connect()
    client.registerMainRpc('gmail.get_thread', async () => {
      throw new Error('boom')
    })

    deliver({ kind: 'mainRequest', id: 9, method: 'gmail.get_thread', args: ['x'] })
    await Promise.resolve()
    await Promise.resolve()

    expect(sent).toEqual([{ kind: 'mainResponse', id: 9, ok: false, error: 'boom' }])
  })

  it('warns on mainRequest with no handler', async () => {
    const { t, sent, deliver } = fakeTransport()
    const client = createServiceClient({ transport: t })
    await client.connect()
    deliver({ kind: 'mainRequest', id: 3, method: 'gmail.list_recent', args: [] })
    await Promise.resolve()
    await Promise.resolve()
    // No handler registered → error response, not a crash.
    expect(sent).toEqual([{ kind: 'mainResponse', id: 3, ok: false, error: expect.stringContaining('no handler') }])
  })
})
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npm test -- src/main/service-client.mainrpc.test.ts`
Expected: FAIL — `registerMainRpc` not a function.

- [ ] **Step 3: Write minimal implementation**

In `src/main/service-client.ts`:

3a. Add the imports — change line 7 from:

```ts
import type { ServiceMethod, ServiceToMain } from '@shared/types/service-ipc'
```

to:

```ts
import type { MainMethod, MainRequest, ServiceMethod, ServiceToMain } from '@shared/types/service-ipc'
```

3b. Extend the `ServiceClient` type — add this line immediately after `cancelCronJob(id: string): Promise<void>` (the last method in the type, around line 69):

```ts
  registerMainRpc(method: MainMethod, fn: (...args: unknown[]) => Promise<unknown> | unknown): void
```

3c. Inside `createServiceClient`, after `const pending = new Map<...>()` (line 75), add the handler registry:

```ts
  const mainRpcHandlers = new Map<MainMethod, (...args: unknown[]) => Promise<unknown> | unknown>()
```

3d. Extend `handle` — after the `else if (msg.kind === 'event')` block (line 89-91), add:

```ts
    } else if (msg.kind === 'mainRequest') {
      const req = msg as MainRequest
      const handler = mainRpcHandlers.get(req.method)
      if (!handler) {
        log.warn({ msg: 'no main-rpc handler', method: req.method, id: req.id })
        transport.postMessage({ kind: 'mainResponse', id: req.id, ok: false, error: `no handler for ${req.method}` })
        return
      }
      Promise.resolve()
        .then(() => handler(...req.args))
        .then(
          (result) => transport.postMessage({ kind: 'mainResponse', id: req.id, ok: true, result }),
          (err: unknown) => {
            const message = err instanceof Error ? err.message : String(err)
            log.error({ msg: 'main-rpc handler threw', method: req.method, id: req.id, err: message })
            transport.postMessage({ kind: 'mainResponse', id: req.id, ok: false, error: message })
          },
        )
    }
```

3e. Return `registerMainRpc` from the client object — add to the returned object (e.g. after `disconnect()`):

```ts
    registerMainRpc(method, fn) {
      mainRpcHandlers.set(method, fn)
    },
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npm test -- src/main/service-client.mainrpc.test.ts`
Expected: PASS (3 tests).

- [ ] **Step 5: Run the full main-side test suite to confirm no regression**

Run: `npm test -- src/main/service-client`
Expected: PASS (existing + new tests).

- [ ] **Step 6: Commit**

```bash
git add src/main/service-client.ts src/main/service-client.mainrpc.test.ts
git commit -m "feat(ipc): route service→main mainRequest to registered handlers"
```

---

## Task 11: Service-side main-rpc client

**Files:**
- Create: `src/service/gmail/main-rpc.ts` (+ test)
- Modify: `src/service/index.ts`

**Interfaces:**
- Consumes: `MainMethod` from Task 2; the service-side `parentPort`.
- Produces: `createMainRpc(post, subscribe): { mainRpc(method, args): Promise<unknown> }`. Production wiring posts on `parentPort` and resolves on incoming `mainResponse`.

- [ ] **Step 1: Write the failing test**

```ts
// src/service/gmail/main-rpc.test.ts
import { describe, expect, it, vi } from 'vitest'
import { createMainRpc } from './main-rpc'

describe('service main-rpc client', () => {
  it('posts mainRequest and resolves on matched mainResponse', async () => {
    const posted: unknown[] = []
    const listeners = new Set<(m: unknown) => void>()
    const rpc = createMainRpc({
      post: (m: unknown) => posted.push(m),
      subscribe: (fn) => {
        listeners.add(fn)
        return () => listeners.delete(fn)
      },
    })
    const p = rpc.mainRpc('gmail.search', ['inv', 5])
    expect(posted).toHaveLength(1)
    const req = posted[0] as { kind: string; id: number; method: string; args: unknown[] }
    expect(req.kind).toBe('mainRequest')
    expect(req.method).toBe('gmail.search')
    // Simulate main replying with the matching id.
    for (const l of listeners) l({ kind: 'mainResponse', id: req.id, ok: true, result: [{ id: 't1' }] })
    await expect(p).resolves.toEqual([{ id: 't1' }])
  })

  it('rejects on an error mainResponse', async () => {
    const posted: unknown[] = []
    const listeners = new Set<(m: unknown) => void>()
    const rpc = createMainRpc({
      post: (m: unknown) => posted.push(m),
      subscribe: (fn) => {
        listeners.add(fn)
        return () => listeners.delete(fn)
      },
    })
    const p = rpc.mainRpc('gmail.get_thread', ['x'])
    const req = posted[0] as { id: number }
    for (const l of listeners) l({ kind: 'mainResponse', id: req.id, ok: false, error: 'nope' })
    await expect(p).rejects.toThrow('nope')
  })
})
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npm test -- src/service/gmail/main-rpc.test.ts`
Expected: FAIL — `./main-rpc` not found.

- [ ] **Step 3: Write minimal implementation**

```ts
// src/service/gmail/main-rpc.ts
//
// Service-side client for the symmetric mainRequest/mainResponse channel.
// mainRpc(method, args) posts a mainRequest on the parentPort and resolves
// when the matching mainResponse (by id) arrives. Mirrors the request side of
// the main-side ServiceClient.
import type { MainMethod } from '@shared/types/service-ipc'

export type MainRpc = {
  mainRpc(method: MainMethod, args: unknown[]): Promise<unknown>
}

export type MainRpcDeps = {
  post(message: unknown): void
  subscribe(fn: (message: unknown) => void): () => void
}

export function createMainRpc(deps: MainRpcDeps): MainRpc {
  let nextId = 1
  const pending = new Map<number, { resolve: (v: unknown) => void; reject: (e: unknown) => void }>()

  deps.subscribe((message) => {
    const msg = message as { kind?: string; id?: number; ok?: boolean; result?: unknown; error?: string }
    if (msg.kind !== 'mainResponse') return
    const p = msg.id != null ? pending.get(msg.id) : undefined
    if (!p) return
    pending.delete(msg.id)
    if (msg.ok) p.resolve(msg.result)
    else p.reject(new Error(msg.error ?? 'main rpc failed'))
  })

  return {
    mainRpc(method, args) {
      const id = nextId++
      return new Promise<unknown>((resolve, reject) => {
        pending.set(id, { resolve, reject })
        deps.post({ kind: 'mainRequest', id, method, args })
      })
    },
  }
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npm test -- src/service/gmail/main-rpc.test.ts`
Expected: PASS (2 tests).

- [ ] **Step 5: Wire into `src/service/index.ts`**

5a. Add imports near the top (after the `ServiceRequest` import on line 7):

```ts
import { createMainRpc } from './gmail/main-rpc'
```

5b. Construct the main-rpc client and feed `mainResponse` messages to it. The current `parentPort.on('message', ...)` handler dispatches `ServiceRequest`. Add a second subscriber so `mainResponse` messages reach the rpc client. Immediately after the existing `parentPort.on('message', (e) => {...})` block (before `parentPort.postMessage({ kind: 'ready' })`), insert:

```ts
// main-rpc: main answers a mainRequest with a mainResponse. The client
// resolves the pending promise for each matched id.
const mainRpc = createMainRpc({
  post: (m) => parentPort.postMessage(m),
  // utilityProcess parentPort has no off(); the listener lives for the process
  // lifetime, so subscribe is fire-and-forget and unsubscribe is a no-op.
  subscribe: (fn) => {
    const listener = (e: { data: unknown }): void => fn(e.data)
    parentPort.on('message', listener)
    return () => {}
  },
})
```

5c. Pass `mainRpc` into `registerBuiltinTools`. Find the existing `registerBuiltinTools(...)` call and add `gmailMainRpc: mainRpc.mainRpc` to its deps object:

```ts
registerBuiltinTools(toolRegistry, {
  memoryStore,
  skillStore,
  scheduler,
  claudeCode: claudeCode,
  taskWaiters,
  getWebSearchConfig: () => webSearchConfig,
  isSkillEnabled: (name) => toolToggles.isSkillEnabled(name),
  gmailMainRpc: mainRpc.mainRpc,
})
```

> If the existing call uses different field names, keep them and only add `gmailMainRpc`. Match the surrounding object literal style.

- [ ] **Step 6: Run the service index-related tests + typecheck**

Run: `npm test -- src/service/gmail/` then `npm run typecheck:node`
Expected: tests PASS; typecheck clean.

- [ ] **Step 7: Commit**

```bash
git add src/service/gmail/main-rpc.ts src/service/gmail/main-rpc.test.ts src/service/index.ts
git commit -m "feat(service): wire service-side main-rpc client"
```

---

## Task 12: `gmail.*` tools

**Files:**
- Create: `src/service/gmail/tools.ts` (+ test)
- Modify: `src/service/tools/builtins.ts`

**Interfaces:**
- Consumes: `mainRpc` fn (the `MainRpc['mainRpc']` signature) injected from Task 11; typebox `Type` from `@earendil-works/pi-ai`; `AgentTool` from `@earendil-works/pi-agent-core`; `ToolSpec` from `../tools/registry`.
- Produces: `gmailSpecs(mainRpc: (method, args) => Promise<unknown>): ToolSpec[]` — three specs (`search`, `get_thread`, `list_recent`), group `'gmail'`, risk `'low'`, source `'builtin'`.

- [ ] **Step 1: Write the failing test**

```ts
// src/service/gmail/tools.test.ts
import { describe, expect, it, vi } from 'vitest'
import { gmailSpecs } from './tools'

describe('gmail tools', () => {
  it('search returns formatted rows and details', async () => {
    const mainRpc = vi.fn(async () => [
      { id: 't1', snippet: 'inv', fromAddr: 'a@b', subject: 'Inv', lastDateMs: 1, labelIds: ['INBOX'], unread: true },
    ])
    const spec = gmailSpecs(mainRpc).find((s) => s.name === 'search')!
    const tool = spec.build({} as never)
    const out = (await tool.execute('id1', { query: 'inv' })) as { content: { text: string }[]; details: { count: number } }
    expect(mainRpc).toHaveBeenCalledWith('gmail.search', ['inv', 20])
    expect(out.details.count).toBe(1)
    expect(out.content[0].text).toContain('Inv')
  })

  it('search errors on empty query', async () => {
    const mainRpc = vi.fn(async () => [])
    const spec = gmailSpecs(mainRpc).find((s) => s.name === 'search')!
    const tool = spec.build({} as never)
    const out = (await tool.execute('id1', { query: '' })) as { details: { error: string } }
    expect(out.details.error).toBeTruthy()
    expect(mainRpc).not.toHaveBeenCalled()
  })

  it('get_thread calls gmail.get_thread with id', async () => {
    const mainRpc = vi.fn(async () => ({ thread: { id: 't1' }, messages: [] }))
    const spec = gmailSpecs(mainRpc).find((s) => s.name === 'get_thread')!
    await spec.build({} as never).execute('id1', { id: 't1' })
    expect(mainRpc).toHaveBeenCalledWith('gmail.get_thread', ['t1'])
  })

  it('list_recent passes limit + label', async () => {
    const mainRpc = vi.fn(async () => [])
    const spec = gmailSpecs(mainRpc).find((s) => s.name === 'list_recent')!
    await spec.build({} as never).execute('id1', { limit: 5, label: 'INBOX' })
    expect(mainRpc).toHaveBeenCalledWith('gmail.list_recent', [{ limit: 5, label: 'INBOX' }])
  })

  it('surfaces main-rpc errors as tool errors', async () => {
    const mainRpc = vi.fn(async () => { throw new Error('boom') })
    const spec = gmailSpecs(mainRpc).find((s) => s.name === 'list_recent')!
    const out = (await spec.build({} as never).execute('id1', {})) as { details: { error: string } }
    expect(out.details.error).toContain('boom')
  })
})
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npm test -- src/service/gmail/tools.test.ts`
Expected: FAIL — `./tools` not found.

- [ ] **Step 3: Write minimal implementation**

```ts
// src/service/gmail/tools.ts
//
// gmail.* built-in tools. Each tool is a thin client over the local cache via
// the service→main rpc: search/get_thread/list_recent. Read-only ⇒ risk 'low'.
import type { AgentTool } from '@earendil-works/pi-agent-core'
import { Type } from '@earendil-works/pi-ai'
import type { MainMethod } from '@shared/types/service-ipc'

import type { ToolSpec } from '../tools/registry'

type MainRpcFn = (method: MainMethod, args: unknown[]) => Promise<unknown>

type Result = { content: [{ type: 'text'; text: string }]; details: Record<string, unknown> }
const ok = (text: string, details: Record<string, unknown> = {}): Result => ({
  content: [{ type: 'text', text }],
  details,
})
const err = (message: string): Result => ok(`error: ${message}`, { error: message })

const SearchParams = Type.Object({
  query: Type.String({ description: 'Substring to search for in subject/snippet/from/body (case-insensitive).' }),
  limit: Type.Optional(Type.Number({ description: 'Max threads to return (default 20).' })),
})
const GetThreadParams = Type.Object({
  id: Type.String({ description: 'Gmail thread id.' }),
})
const ListRecentParams = Type.Object({
  limit: Type.Optional(Type.Number({ description: 'Max threads (default 20).' })),
  label: Type.Optional(Type.String({ description: 'Gmail label to filter by (default INBOX).' })),
})

function searchSpec(mainRpc: MainRpcFn): ToolSpec {
  return {
    group: 'gmail',
    name: 'search',
    risk: 'low',
    source: 'builtin',
    build: () => ({
      name: 'search',
      label: 'Search Gmail',
      description:
        'Search the locally-cached Gmail mailbox by substring (subject/snippet/from/body) and return matching threads. Cache is kept fresh by a background sync; for very recent mail call gmail.list_recent.',
      parameters: SearchParams,
      execute: async (_id, params) => {
        const p = params as { query?: string; limit?: number }
        const query = (p.query ?? '').trim()
        if (!query) return err('empty query')
        const limit = p.limit ?? 20
        try {
          const rows = (await mainRpc('gmail.search', [query, limit])) as unknown[]
          if (rows.length === 0) return ok('(no matching threads)', { count: 0, query })
          const text = rows
            .map((r, i) => {
              const t = r as { subject?: string; fromAddr?: string; snippet?: string; id?: string }
              return `${i + 1}. ${t.subject ?? '(no subject)'} — ${t.fromAddr ?? ''}\n   [${t.id ?? ''}] ${t.snippet ?? ''}`
            })
            .join('\n\n')
          return ok(text, { count: rows.length, query })
        } catch (e) {
          return err(e instanceof Error ? e.message : String(e))
        }
      },
    }),
  }
}

function getThreadSpec(mainRpc: MainRpcFn): ToolSpec {
  return {
    group: 'gmail',
    name: 'get_thread',
    risk: 'low',
    source: 'builtin',
    build: () => ({
      name: 'get_thread',
      label: 'Get Gmail thread',
      description: 'Return a single Gmail thread with its full message bodies (plain text) from the local cache.',
      parameters: GetThreadParams,
      execute: async (_id, params) => {
        const p = params as { id?: string }
        const id = (p.id ?? '').trim()
        if (!id) return err('missing id')
        try {
          const r = (await mainRpc('gmail.get_thread', [id])) as
            | { thread: { subject?: string }; messages: { bodyText?: string; fromAddr?: string }[] }
            | null
          if (!r) return ok('(thread not in cache)', { id })
          const text = r.messages
            .map((m, i) => `${i + 1}. ${m.fromAddr ?? ''}\n${m.bodyText ?? ''}`)
            .join('\n\n---\n\n')
          return ok(text || '(empty thread)', { id, subject: r.thread.subject, messages: r.messages.length })
        } catch (e) {
          return err(e instanceof Error ? e.message : String(e))
        }
      },
    }),
  }
}

function listRecentSpec(mainRpc: MainRpcFn): ToolSpec {
  return {
    group: 'gmail',
    name: 'list_recent',
    risk: 'low',
    source: 'builtin',
    build: () => ({
      name: 'list_recent',
      label: 'List recent Gmail',
      description: 'List the most recent threads in the local cache (optionally filtered by Gmail label). Use this to see what just arrived.',
      parameters: ListRecentParams,
      execute: async (_id, params) => {
        const p = (params as { limit?: number; label?: string }) ?? {}
        const input = { limit: p.limit ?? 20, label: p.label }
        try {
          const rows = (await mainRpc('gmail.list_recent', [input])) as unknown[]
          if (rows.length === 0) return ok('(mailbox cache is empty — is Gmail linked?)', { count: 0 })
          const text = rows
            .map((r, i) => {
              const t = r as { subject?: string; fromAddr?: string; id?: string }
              return `${i + 1}. ${t.subject ?? '(no subject)'} — ${t.fromAddr ?? ''} [${t.id ?? ''}]`
            })
            .join('\n')
          return ok(text, { count: rows.length })
        } catch (e) {
          return err(e instanceof Error ? e.message : String(e))
        }
      },
    }),
  }
}

export function gmailSpecs(mainRpc: MainRpcFn): ToolSpec[] {
  return [searchSpec(mainRpc), getThreadSpec(mainRpc), listRecentSpec(mainRpc)]
}

// Re-export AgentTool type use for callers that build tool objects manually.
export type { AgentTool }
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npm test -- src/service/gmail/tools.test.ts`
Expected: PASS (5 tests).

- [ ] **Step 5: Register in `builtins.ts`**

5a. In `src/service/tools/builtins.ts`, add the import (after the `web` import on line 27):

```ts
import { gmailSpecs } from '../gmail/tools'
```

5b. Add the dep to the `deps` parameter type. After `isSkillEnabled?: (name: string) => boolean` (line 67):

```ts
  /** Service→main rpc fn; required for the gmail.* tools to query the cache. */
  gmailMainRpc?: (method: import('@shared/types/service-ipc').MainMethod, args: unknown[]) => Promise<unknown>
```

5c. Register the specs at the end of `registerBuiltinTools` (after the `claudeCode` block, line 103):

```ts
  if (deps?.gmailMainRpc) for (const spec of gmailSpecs(deps.gmailMainRpc)) registry.register(spec)
```

- [ ] **Step 6: Run the tools tests + typecheck**

Run: `npm test -- src/service/gmail/tools.test.ts src/service/tools` then `npm run typecheck:node`
Expected: PASS; typecheck clean.

- [ ] **Step 7: Commit**

```bash
git add src/service/gmail/tools.ts src/service/gmail/tools.test.ts src/service/tools/builtins.ts
git commit -m "feat(gmail): add gmail.{search,get_thread,list_recent} tools"
```

---

## Task 13: Main-process wiring

**Files:**
- Modify: `src/main/index.ts`

**Interfaces:**
- Consumes: `initGmail` / `GmailHandle` from Task 9; `ServiceClient` from Task 10.

- [ ] **Step 1: Wire the slice into app-ready**

In `src/main/index.ts`:

1a. Add the import near the other feature imports (after `initWebSearch`, line 19):

```ts
import { initGmail } from './gmail'
```

1b. Construct + dispose. After the `bilibili` block (line 68-69) insert:

```ts
  const gmail = await initGmail()
  log.info({ msg: 'gmail sidecar initialised' })
```

1c. Add `gmail.dispose()` to the **first** `app.on('before-quit', ...)` block (lines 71-78), alongside the other disposes:

```ts
    gmail.dispose()
```

1d. Register the main-rpc handlers once the `serviceClient` is connected. Immediately after `await serviceClient.connect()` (line 124), add:

```ts
    gmail.registerMainRpc(serviceClient)
```

- [ ] **Step 2: Verify the app boots and the typecheck is clean**

Run: `npm run typecheck:node`
Expected: clean (no errors).

- [ ] **Step 3: Commit**

```bash
git add src/main/index.ts
git commit -m "feat(gmail): wire sidecar into app boot and main-rpc"
```

---

## Task 14: Preload bridge

**Files:**
- Modify: `src/preload/index.ts`

**Interfaces:**
- Produces: a `gmail` bridge on the preload API with: `getStatus`, `setClientCreds(creds)`, `clearClientCreds`, `linkAccount`, `unlinkAccount`, `syncNow`, `onStateChanged(cb)`.

- [ ] **Step 1: Add the bridge**

In `src/preload/index.ts`, mirror the `bilibili` bridge. Add the type import alongside the others (near the existing `BilibiliBridge` import) and define the bridge object next to the `bilibili` constant (around line 216):

```ts
import type { GmailClientCreds, GmailConfigView } from '@shared/types/gmail'

type SetResult = { ok: true } | { ok: false; code: string; message: string }

type GmailBridge = {
  getStatus(): Promise<GmailConfigView>
  setClientCreds(creds: GmailClientCreds): Promise<SetResult>
  clearClientCreds(): Promise<unknown>
  linkAccount(): Promise<SetResult>
  unlinkAccount(): Promise<unknown>
  syncNow(): Promise<void>
  onStateChanged(cb: (view: GmailConfigView) => void): () => void
}

const gmail: GmailBridge = {
  getStatus: () => ipcRenderer.invoke('gmail:getStatus') as Promise<GmailConfigView>,
  setClientCreds: (creds: GmailClientCreds) =>
    ipcRenderer.invoke('gmail:setClientCreds', creds) as Promise<SetResult>,
  clearClientCreds: () => ipcRenderer.invoke('gmail:clearClientCreds') as Promise<unknown>,
  linkAccount: () => ipcRenderer.invoke('gmail:linkAccount') as Promise<SetResult>,
  unlinkAccount: () => ipcRenderer.invoke('gmail:unlinkAccount') as Promise<unknown>,
  syncNow: () => ipcRenderer.invoke('gmail:syncNow') as Promise<void>,
  onStateChanged: (cb: (view: GmailConfigView) => void) => {
    const listener = (_e: unknown, view: GmailConfigView): void => cb(view)
    ipcRenderer.on('gmail:stateChanged', listener)
    return () => {
      ipcRenderer.removeListener('gmail:stateChanged', listener)
    }
  },
}
```

Define `GmailBridge` and `gmail` next to the `bilibili` constant (around line 216), then expose `gmail` via the same `contextBridge`/expose call the other bridges (`bilibili`, `swarm`) use — search for where `bilibili` is exposed and add `gmail` next to it.

> If the file exposes bridges via a single `exposeMainWorld('api', { bilibili, swarm, ... })`-style call, add `gmail` to that object literal. If each bridge is exposed individually, add the matching expose call for `gmail`.

- [ ] **Step 2: Run typecheck**

Run: `npm run typecheck:web`
Expected: clean.

- [ ] **Step 3: Commit**

```bash
git add src/preload/index.ts
git commit -m "feat(preload): expose gmail bridge to the renderer"
```

---

## Task 15: Settings panel (renderer)

**Files:**
- Create: `src/renderer/src/components/views/gmail-view.tsx`
- Modify: `src/renderer/src/stores/settings-dialog.ts` (+ the dialog component `src/renderer/src/components/settings-dialog.tsx`) to add the Gmail nav entry, mirroring the existing `web-search` entry.

**Interfaces:**
- Consumes: the preload `gmail` bridge (Task 14); the `settings-primitives.tsx` field components used by `web-search-view.tsx`.

- [ ] **Step 1: Read the template**

Open `src/renderer/src/components/views/web-search-view.tsx` and `src/renderer/src/stores/settings-dialog.ts`. Mirror the structure: a view component with form fields, a status line, and action buttons; a nav entry registered in the settings dialog store + rendered in the dialog component.

- [ ] **Step 2: Write the view component**

```tsx
// src/renderer/src/components/views/gmail-view.tsx
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { useState } from 'react'

import { gmail } from '@.renderer/preload-api' // ← adjust to the actual preload import path used by web-search-view.tsx

export function GmailSettingsView(): React.JSX.Element {
  const qc = useQueryClient()
  const { data: status } = useQuery({
    queryKey: ['gmail', 'status'],
    queryFn: () => gmail.getStatus(),
  })
  const [clientId, setClientId] = useState('')
  const [clientSecret, setClientSecret] = useState('')

  const setCreds = useMutation({
    mutationFn: () => gmail.setClientCreds({ clientId: clientId.trim(), clientSecret: clientSecret.trim() }),
    onSuccess: () => qc.invalidateQueries({ queryKey: ['gmail', 'status'] }),
  })
  const link = useMutation({
    mutationFn: () => gmail.linkAccount(),
    onSuccess: () => qc.invalidateQueries({ queryKey: ['gmail', 'status'] }),
  })
  const unlink = useMutation({
    mutationFn: () => gmail.unlinkAccount(),
    onSuccess: () => qc.invalidateQueries({ queryKey: ['gmail', 'status'] }),
  })
  const sync = useMutation({
    mutationFn: () => gmail.syncNow(),
    onSuccess: () => qc.invalidateQueries({ queryKey: ['gmail', 'status'] }),
  })

  return (
    <div className="space-y-4">
      <p className="text-muted-foreground text-sm">
        Link a Google account (read-only). Create a Desktop-app OAuth client in Google Cloud Console, keep it in
        Testing mode, and add yourself as a test user. Scope: gmail.readonly.
      </p>

      <Field label="OAuth Client ID">
        <input className="w-full rounded border px-2 py-1" value={clientId} onChange={(e) => setClientId(e.target.value)} placeholder="xxxxxxxx.apps.googleusercontent.com" />
      </Field>
      <Field label="OAuth Client Secret">
        <input className="w-full rounded border px-2 py-1" type="password" value={clientSecret} onChange={(e) => setClientSecret(e.target.value)} placeholder="GOCSPX-…" />
      </Field>
      <button
        type="button"
        className="rounded bg-primary px-3 py-1 text-primary-foreground disabled:opacity-50"
        disabled={!clientId.trim() || !clientSecret.trim() || setCreds.isPending}
        onClick={() => setCreds.mutate()}
      >
        Save credentials
      </button>

      <div className="rounded border p-3 text-sm">
        <div>Status: {status?.loggedIn ? 'Linked' : 'Not linked'}</div>
        <div>Account: {status?.accountEmail ?? '—'}</div>
        <div>Cached messages: {status?.messageCount ?? '—'}</div>
        <div>Last sync: {status?.lastSyncAt ? new Date(status.lastSyncAt).toLocaleString() : '—'}</div>
        {status?.syncError ? <div className="text-destructive">Error: {status.syncError}</div> : null}
      </div>

      <div className="flex gap-2">
        <button type="button" className="rounded border px-3 py-1" disabled={!status?.hasClientCreds || link.isPending} onClick={() => link.mutate()}>
          Link account
        </button>
        <button type="button" className="rounded border px-3 py-1" disabled={!status?.loggedIn || sync.isPending} onClick={() => sync.mutate()}>
          Sync now
        </button>
        <button type="button" className="rounded border px-3 py-1" disabled={!status?.loggedIn || unlink.isPending} onClick={() => unlink.mutate()}>
          Unlink
        </button>
      </div>
    </div>
  )
}

function Field({ label, children }: { label: string; children: React.ReactNode }): React.JSX.Element {
  return (
    <label className="block space-y-1">
      <span className="text-muted-foreground text-xs uppercase tracking-wide">{label}</span>
      {children}
    </label>
  )
}
```

> Adjust the `gmail` import to match the preload API import path actually used by `web-search-view.tsx` (it may be `@renderer/preload-api`, `@/preload`, or `window.gmail` — copy whatever `web-search-view.tsx` uses for its own bridge). Use the same UI primitives (`settings-primitives.tsx` field components) if `web-search-view.tsx` uses them, instead of raw `<input>`/`<button>`, so the panel matches the existing look.

- [ ] **Step 3: Register the nav entry**

Mirror the `web-search` entry in `src/renderer/src/stores/settings-dialog.ts` (add a `gmail` view id) and render `<GmailSettingsView />` in `src/renderer/src/components/settings-dialog.tsx` for that id, exactly as `web-search` is wired.

- [ ] **Step 4: Verify the renderer builds + typechecks**

Run: `npm run typecheck:web`
Expected: clean.

- [ ] **Step 5: Commit**

```bash
git add src/renderer/src/components/views/gmail-view.tsx src/renderer/src/stores/settings-dialog.ts src/renderer/src/components/settings-dialog.tsx
git commit -m "feat(gmail): add Settings panel for OAuth + sync status"
```

---

## Verification (final)

- [ ] **Run the full test suite**

Run: `npm test`
Expected: all PASS (existing + new gmail/* + ipc + tools tests).

- [ ] **Typecheck + lint**

Run: `npm run typecheck` then `npx biome check --write src/main/gmail src/service/gmail src/shared/types/gmail.ts src/shared/types/service-ipc.ts`
Expected: clean.

- [ ] **Manual smoke (real account)**

Set up a Google Cloud OAuth Desktop client (Testing mode, self as test user), paste credentials into Settings → Gmail, click Link account, consent in the browser, return and click Sync now. Then run a chat goal that exercises the tools, e.g.:

> Use gmail.list_recent to show my latest 5 inbox threads, then gmail.get_thread on the most recent one and summarise it.

Expected: the tools return cached rows; the log file (`~/.swarm-agents/swarm-dev.log`) shows `gmail-daemon: gmail synced` and `gmail-api` calls; the Settings panel shows a non-zero Cached-messages count and a Last-sync timestamp.

- [ ] **Final commit (if any formatting changes)**

```bash
git add -A
git commit -m "chore(gmail): format and final verification"
```
