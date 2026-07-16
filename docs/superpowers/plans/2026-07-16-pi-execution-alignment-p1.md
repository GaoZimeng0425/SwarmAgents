# P1: pi-Native Execution Core Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace the message-engine/wire/persistence stack with a pi-native model: `session_entries` single source of truth, per-session `SessionAgent` runtime, pi AgentEvent pass-through on the wire, renderer transcript rebuilt on entries.

**Architecture:** One `SessionAgent` per session (lazy, disposable) drives the pi-agent-core `Agent` via `continue()` over a context rebuilt from `session_entries`. Finalized messages persist as entries (`entry_appended`, persist-then-broadcast); streaming deltas are broadcast-only, frame-coalesced. Renderer state is a per-session `SessionView` reducer over entries + live events. Spec: `docs/superpowers/specs/2026-07-16-pi-execution-alignment-design.md`.

**Tech Stack:** TypeScript, Electron (utilityProcess service), `@earendil-works/pi-agent-core@0.80.6` (pinned), better-sqlite3, zod, React 19 + TanStack Query, vitest.

## Global Constraints

- pi-agent-core is pinned at **0.80.6**; every pi import in this plan is from the package root `@earendil-works/pi-agent-core` (all symbols re-exported there — verified against `dist/index.d.ts`).
- **No data migration** (spec D1): old tables are dropped at startup; old wire kinds disappear entirely. No legacy render path.
- **pi-native vocabulary** (spec D2): wire kinds are `agent_start`, `agent_end`, `turn_start`, `turn_end`, `message_start`, `message_update`, `message_end`, `tool_execution_start|update|end`, `entry_appended`, `permission_request`. Never reintroduce `message.*`/`task.*`/`run.*` dotted kinds.
- **Comments and commit messages in English** (project CLAUDE.md §0).
- Execute in a fresh worktree (superpowers:using-git-worktrees). After creating it run `bash scripts/wt-setup.sh` to symlink node_modules (never `pnpm install` in a worktree).
- Run tests with `npm test -- <path>` from `apps/desktop` (or the package dir) — never bare `npx vitest`. Never `pnpm rebuild better-sqlite3`.
- Before any `typecheck` run: `find . -name '*.tsbuildinfo' -delete` (stale build info reports phantom errors).
- Renderer test files need the `// @vitest-environment jsdom` pragma.
- Scoped formatting only: `npx biome check --write <file>` (repo-wide `pnpm check` reformats everything).
- Logging per CLAUDE.md §5: every new business path logs entry/outcome at `info`, every catch at `error`, with `sessionId`/`runId` correlation fields.
- **Accepted P1 regressions** (restored in P2/P4, per spec §3.6): no queued-prompt promotion (steering lands in P2), OrchestrationGraph hidden (delegation data IS persisted as custom entries; graph UI returns in P4), no model-fallback chain mid-run (returns with retry in P3).

---

### Task 1: Protocol v3 — session entries + agent wire events

**Files:**
- Create: `packages/protocol/src/types/session-entry.ts`
- Create: `packages/protocol/src/types/agent-events.ts`
- Modify: `packages/protocol/src/types/ui.ts` (UIEvent union: remove `MessageWireEvent`, add `AgentWireEvent`)
- Modify: `packages/protocol/src/index.ts` (export new modules; keep old exports until Task 9 deletes them)
- Test: `packages/protocol/src/types/session-entry.test.ts`, `packages/protocol/src/types/agent-events.test.ts`

**Interfaces:**
- Produces: `SessionEntry` union + `SessionEntrySchema` (zod), `EntryRow = { rowId: number; entry: SessionEntry }`, `AgentWireEvent` union, `runStatusValues`/`RunStatus = 'completed'|'failed'|'cancelled'`. All later tasks import these from `@swarm/protocol`.
- Consumes: nothing (leaf task). Types structurally mirror pi 0.80.6 (`SessionTreeEntryBase{type,id,parentId,timestamp}`); protocol does NOT depend on pi-agent-core (web/mobile stay pi-free). A service-side type assertion (Task 2) pins compatibility.

- [ ] **Step 1: Write failing type/schema tests**

```ts
// packages/protocol/src/types/session-entry.test.ts
import { describe, expect, it } from 'vitest'
import { SessionEntrySchema } from './session-entry'

describe('SessionEntrySchema', () => {
  it('parses a message entry', () => {
    const e = {
      type: 'message', id: '018f-aaa', parentId: null, timestamp: '2026-07-16T00:00:00Z',
      message: { role: 'user', content: 'hello', timestamp: '2026-07-16T00:00:00Z' },
    }
    expect(SessionEntrySchema.parse(e)).toEqual(e)
  })
  it('parses a custom entry with arbitrary data', () => {
    const e = {
      type: 'custom', id: '018f-bbb', parentId: '018f-aaa', timestamp: '2026-07-16T00:00:01Z',
      customType: 'delegation', data: { childSessionId: 's2', agentDefId: 'engineer' },
    }
    expect(SessionEntrySchema.parse(e)).toEqual(e)
  })
  it('rejects unknown entry types', () => {
    expect(() => SessionEntrySchema.parse({ type: 'nope', id: 'x', parentId: null, timestamp: 't' })).toThrow()
  })
})
```

```ts
// packages/protocol/src/types/agent-events.test.ts
import { describe, expect, it } from 'vitest'
import type { AgentWireEvent } from './agent-events'

describe('AgentWireEvent', () => {
  it('narrows by kind', () => {
    const e: AgentWireEvent = { kind: 'agent_end', sessionId: 's1', runId: 'r1', status: 'completed' }
    if (e.kind === 'agent_end') expect(e.status).toBe('completed')
  })
  it('entry_appended carries rowId cursor', () => {
    const e: AgentWireEvent = {
      kind: 'entry_appended', sessionId: 's1', rowId: 42,
      entry: { type: 'message', id: 'e1', parentId: null, timestamp: 't', message: { role: 'user', content: 'hi' } },
    }
    expect(e.rowId).toBe(42)
  })
})
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `cd packages/protocol && npm test -- src/types/session-entry.test.ts src/types/agent-events.test.ts`
Expected: FAIL — modules not found.

- [ ] **Step 3: Implement the types**

```ts
// packages/protocol/src/types/session-entry.ts
import { z } from 'zod'

/**
 * Wire/persistence entry model. Structurally mirrors pi-agent-core 0.80.6
 * SessionTreeEntry (harness/types.d.ts:230-293) WITHOUT importing it, so web
 * and mobile clients stay free of the pi dependency. The service asserts
 * assignability in a type test (see service sqlite-storage.test.ts).
 */
const base = { id: z.string().min(1), parentId: z.string().nullable(), timestamp: z.string() }

// AgentMessage payloads are provider-shaped and open-ended; the store treats
// them as opaque JSON. Validation of message internals belongs to pi.
const MessagePayload = z.looseObject({ role: z.string() })

export const SessionEntrySchema = z.discriminatedUnion('type', [
  z.object({ ...base, type: z.literal('message'), message: MessagePayload }),
  z.object({ ...base, type: z.literal('model_change'), provider: z.string(), modelId: z.string() }),
  z.object({ ...base, type: z.literal('thinking_level_change'), thinkingLevel: z.string() }),
  z.object({
    ...base, type: z.literal('compaction'),
    summary: z.string(), firstKeptEntryId: z.string(), tokensBefore: z.number(),
    details: z.unknown().optional(), fromHook: z.boolean().optional(),
  }),
  z.object({ ...base, type: z.literal('custom'), customType: z.string(), data: z.unknown().optional() }),
  z.object({
    ...base, type: z.literal('custom_message'),
    customType: z.string(), content: z.unknown(), details: z.unknown().optional(), display: z.boolean(),
  }),
])
export type SessionEntry = z.infer<typeof SessionEntrySchema>
export type MessageEntry = Extract<SessionEntry, { type: 'message' }>
export type CustomEntry = Extract<SessionEntry, { type: 'custom' }>

/** A persisted entry with its sqlite AUTOINCREMENT id — the order key and replay cursor. */
export type EntryRow = { rowId: number; entry: SessionEntry }
```

```ts
// packages/protocol/src/types/agent-events.ts
import type { Risk } from './ipc'
import type { ConsumedResources } from './task'
import type { SessionEntry } from './session-entry'

export const runStatusValues = ['completed', 'failed', 'cancelled'] as const
export type RunStatus = (typeof runStatusValues)[number]

type RunScope = { sessionId: string; runId: string }

/**
 * Wire protocol v3: pi AgentEvents pass through with sessionId/runId scope
 * attached, plus SwarmAgents-owned events (entry_appended, permission_request).
 * Delta-class events (message_update, tool_execution_update) are broadcast-only
 * and frame-coalesced; entry_appended is persist-then-broadcast.
 */
export type AgentWireEvent =
  | (RunScope & { kind: 'agent_start' })
  | (RunScope & { kind: 'agent_end'; status: RunStatus; errorMessage?: string })
  | (RunScope & { kind: 'turn_start' })
  | (RunScope & {
      kind: 'turn_end'
      used: ConsumedResources
      contextTokens?: number
      contextWindow?: number
      model?: string
    })
  | (RunScope & { kind: 'message_start'; message: unknown })
  | (RunScope & { kind: 'message_update'; message: unknown })
  | (RunScope & { kind: 'message_end'; message: unknown })
  | (RunScope & { kind: 'tool_execution_start'; toolCallId: string; toolName: string; args: unknown })
  | (RunScope & { kind: 'tool_execution_update'; toolCallId: string; toolName: string; partialResult: unknown })
  | (RunScope & { kind: 'tool_execution_end'; toolCallId: string; toolName: string; result: unknown; isError: boolean })
  | { kind: 'entry_appended'; sessionId: string; rowId: number; entry: SessionEntry }
  | (RunScope & { kind: 'permission_request'; actionId: string; risk: Risk; summary: string; payload: unknown })

export const AGENT_WIRE_KINDS = new Set<AgentWireEvent['kind']>([
  'agent_start', 'agent_end', 'turn_start', 'turn_end',
  'message_start', 'message_update', 'message_end',
  'tool_execution_start', 'tool_execution_update', 'tool_execution_end',
  'entry_appended', 'permission_request',
])
export function isAgentWireEvent(e: { kind: string }): e is AgentWireEvent {
  return AGENT_WIRE_KINDS.has(e.kind as AgentWireEvent['kind'])
}
```

In `packages/protocol/src/types/ui.ts`: add `AgentWireEvent` to the `UIEvent` union and remove `MessageWireEvent` from it (the type stays exported from `message.ts` until Task 9 so untouched code still compiles):

```ts
import type { AgentWireEvent } from './agent-events'
// in the UIEvent union: replace the MessageWireEvent member with:
  | AgentWireEvent
```

In `packages/protocol/src/index.ts` add:

```ts
export * from './types/session-entry'
export * from './types/agent-events'
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `cd packages/protocol && npm test -- src/types/`
Expected: new tests PASS. (`message.test.ts`/`task.test.ts` still pass — nothing removed yet.)

- [ ] **Step 5: Commit**

```bash
git add packages/protocol/src/types/session-entry.ts packages/protocol/src/types/agent-events.ts \
  packages/protocol/src/types/session-entry.test.ts packages/protocol/src/types/agent-events.test.ts \
  packages/protocol/src/types/ui.ts packages/protocol/src/index.ts
git commit -m "feat(protocol): add pi-native session entries and agent wire events (v3)"
```

---

### Task 2: SqliteSessionStorage + `session_entries` table

**Files:**
- Create: `apps/desktop/src/service/session-agent/sqlite-storage.ts`
- Modify: `apps/desktop/src/service/conversation/store.ts` (create table; drop `message_events`; expose raw db handle or entry statements)
- Test: `apps/desktop/src/service/session-agent/sqlite-storage.test.ts`

**Interfaces:**
- Consumes: `SessionEntry`, `SessionEntrySchema`, `EntryRow` from `@swarm/protocol`; `uuidv7` and `type SessionStorage, type SessionTreeEntry` from `@earendil-works/pi-agent-core`.
- Produces:
  - `createEntryStore(db: Database): EntryStore` where
    `EntryStore = { append(sessionId: string, entry: SessionEntry): number; list(sessionId: string, afterRowId?: number): EntryRow[]; forSession(sessionId: string): SqliteSessionStorage; deleteSession(sessionId: string): void; copyUpTo(sourceSessionId: string, targetSessionId: string, upToRowId: number): void }`
  - `SqliteSessionStorage` implements pi's `SessionStorage` (bound to one sessionId).

- [ ] **Step 1: Write failing tests**

```ts
// apps/desktop/src/service/session-agent/sqlite-storage.test.ts
import Database from 'better-sqlite3'
import { beforeEach, describe, expect, it } from 'vitest'
import type { SessionEntry } from '@swarm/protocol'
import type { SessionStorage, SessionTreeEntry } from '@earendil-works/pi-agent-core'
import { createEntryStore, ensureEntriesSchema, type EntryStore } from './sqlite-storage'

const userEntry = (id: string, parentId: string | null, text: string): SessionEntry => ({
  type: 'message', id, parentId, timestamp: new Date().toISOString(),
  message: { role: 'user', content: text },
})

describe('EntryStore', () => {
  let store: EntryStore
  beforeEach(() => {
    const db = new Database(':memory:')
    ensureEntriesSchema(db)
    store = createEntryStore(db)
  })

  it('append returns a monotonically increasing rowId', () => {
    const a = store.append('s1', userEntry('e1', null, 'a'))
    const b = store.append('s1', userEntry('e2', 'e1', 'b'))
    expect(b).toBeGreaterThan(a)
  })

  it('list is ordered by rowId and respects the afterRowId cursor', () => {
    const a = store.append('s1', userEntry('e1', null, 'a'))
    store.append('s2', userEntry('x1', null, 'other session'))
    store.append('s1', userEntry('e2', 'e1', 'b'))
    const all = store.list('s1')
    expect(all.map((r) => r.entry.id)).toEqual(['e1', 'e2'])
    const tail = store.list('s1', a)
    expect(tail.map((r) => r.entry.id)).toEqual(['e2'])
  })

  it('copyUpTo forks full-fidelity history into a new session', () => {
    const a = store.append('s1', userEntry('e1', null, 'a'))
    store.append('s1', userEntry('e2', 'e1', 'b'))
    store.copyUpTo('s1', 's3', a)
    expect(store.list('s3').map((r) => r.entry.id)).toEqual(['e1'])
  })

  it('rejects entries that fail schema validation', () => {
    expect(() => store.append('s1', { type: 'nope' } as unknown as SessionEntry)).toThrow()
  })
})

describe('SqliteSessionStorage (pi SessionStorage contract)', () => {
  it('implements the pi interface and round-trips entries', async () => {
    const db = new Database(':memory:')
    ensureEntriesSchema(db)
    const store = createEntryStore(db)
    // Type-level pin: our storage satisfies pi 0.80.6 SessionStorage, and our
    // wire SessionEntry is assignable to pi's SessionTreeEntry.
    const storage: SessionStorage = store.forSession('s1')
    const _pin: SessionTreeEntry = userEntry('t', null, 'x') as SessionTreeEntry
    void _pin
    const id = await storage.createEntryId()
    await storage.appendEntry({ type: 'message', id, parentId: null, timestamp: 't', message: { role: 'user', content: 'hi' } })
    expect((await storage.getEntries()).map((e) => e.id)).toEqual([id])
    expect(await storage.getLeafId()).toBe(id)
    expect((await storage.getPathToRoot(id)).length).toBe(1)
    expect((await storage.findEntries('message')).length).toBe(1)
    expect(await storage.getEntry(id)).toBeDefined()
    expect((await storage.getMetadata()).id).toBe('s1')
  })
})
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `cd apps/desktop && npm test -- src/service/session-agent/sqlite-storage.test.ts`
Expected: FAIL — module not found.

- [ ] **Step 3: Implement**

```ts
// apps/desktop/src/service/session-agent/sqlite-storage.ts
import type { Database } from 'better-sqlite3'
import { uuidv7 } from '@earendil-works/pi-agent-core'
import type { SessionMetadata, SessionStorage, SessionTreeEntry } from '@earendil-works/pi-agent-core'
import { type EntryRow, type SessionEntry, SessionEntrySchema } from '@swarm/protocol'

/** Single source of truth (spec §3.2): finalized entries only; AUTOINCREMENT id is order + cursor. */
export function ensureEntriesSchema(db: Database): void {
  db.exec(`
    CREATE TABLE IF NOT EXISTS session_entries (
      id              INTEGER PRIMARY KEY AUTOINCREMENT,
      entry_id        TEXT NOT NULL UNIQUE,
      session_id      TEXT NOT NULL,
      parent_entry_id TEXT,
      type            TEXT NOT NULL,
      entry           TEXT NOT NULL,
      ts              INTEGER NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_entries_session ON session_entries(session_id, id);
  `)
}

export type EntryStore = {
  append(sessionId: string, entry: SessionEntry): number
  list(sessionId: string, afterRowId?: number): EntryRow[]
  forSession(sessionId: string): SqliteSessionStorage
  deleteSession(sessionId: string): void
  copyUpTo(sourceSessionId: string, targetSessionId: string, upToRowId: number): void
}

export function createEntryStore(db: Database): EntryStore {
  const insert = db.prepare(
    `INSERT INTO session_entries (entry_id, session_id, parent_entry_id, type, entry, ts)
     VALUES (@entryId, @sessionId, @parentId, @type, @entry, @ts)`
  )
  const selectAfter = db.prepare(
    `SELECT id, entry FROM session_entries WHERE session_id = ? AND id > ? ORDER BY id`
  )
  const del = db.prepare(`DELETE FROM session_entries WHERE session_id = ?`)
  const copy = db.prepare(
    `INSERT INTO session_entries (entry_id, session_id, parent_entry_id, type, entry, ts)
     SELECT entry_id || '-' || @target, @target, parent_entry_id, type, entry, ts
     FROM session_entries WHERE session_id = @source AND id <= @upTo ORDER BY id`
  )

  const append = (sessionId: string, entry: SessionEntry): number => {
    const parsed = SessionEntrySchema.parse(entry)
    const info = insert.run({
      entryId: parsed.id, sessionId, parentId: parsed.parentId,
      type: parsed.type, entry: JSON.stringify(parsed), ts: Date.now(),
    })
    return Number(info.lastInsertRowid)
  }
  const list = (sessionId: string, afterRowId = 0): EntryRow[] =>
    (selectAfter.all(sessionId, afterRowId) as Array<{ id: number; entry: string }>).map((r) => ({
      rowId: r.id, entry: SessionEntrySchema.parse(JSON.parse(r.entry)),
    }))

  return {
    append, list,
    forSession: (sessionId) => new SqliteSessionStorage(sessionId, { append, list }),
    deleteSession: (sessionId) => void del.run(sessionId),
    copyUpTo: (source, target, upTo) => void copy.run({ source, target, upTo }),
  }
}

/**
 * pi SessionStorage contract over sqlite, bound to one session. Linear history
 * (spec D5): leaf = last entry; setLeafId is a no-op until branching lands.
 * Free insurance: adopting the real AgentHarness later needs no storage change.
 */
export class SqliteSessionStorage implements SessionStorage {
  constructor(
    private readonly sessionId: string,
    private readonly ops: Pick<EntryStore, 'append' | 'list'>
  ) {}

  async getMetadata(): Promise<SessionMetadata> {
    return { id: this.sessionId, createdAt: new Date(0).toISOString() }
  }
  async getLeafId(): Promise<string | null> {
    const rows = this.ops.list(this.sessionId)
    return rows.length ? rows[rows.length - 1].entry.id : null
  }
  async setLeafId(_leafId: string | null): Promise<void> {
    /* linear history: leaf is always the last entry (spec D5) */
  }
  async createEntryId(): Promise<string> {
    return uuidv7()
  }
  async appendEntry(entry: SessionTreeEntry): Promise<void> {
    this.ops.append(this.sessionId, entry as SessionEntry)
  }
  async getEntry(id: string): Promise<SessionTreeEntry | undefined> {
    return (await this.getEntries()).find((e) => e.id === id)
  }
  async findEntries<TType extends SessionTreeEntry['type']>(type: TType) {
    return (await this.getEntries()).filter((e) => e.type === type) as Array<
      Extract<SessionTreeEntry, { type: TType }>
    >
  }
  async getLabel(_id: string): Promise<string | undefined> {
    return undefined
  }
  async getPathToRoot(_leafId: string | null): Promise<SessionTreeEntry[]> {
    return this.getEntries() // linear: path-to-root === full ordered log
  }
  async getEntries(): Promise<SessionTreeEntry[]> {
    return this.ops.list(this.sessionId).map((r) => r.entry as SessionTreeEntry)
  }
}
```

In `apps/desktop/src/service/conversation/store.ts`:
- Call `ensureEntriesSchema(db)` where tables are created.
- Add `DROP TABLE IF EXISTS message_events;` next to the existing legacy `DROP` block (store.ts:104-115 pattern).
- Export the raw `db` (or add `entries: createEntryStore(db)` to the store object) so the service can construct the EntryStore.

- [ ] **Step 4: Run tests to verify they pass**

Run: `cd apps/desktop && npm test -- src/service/session-agent/sqlite-storage.test.ts`
Expected: PASS (6 tests).

- [ ] **Step 5: Commit**

```bash
git add apps/desktop/src/service/session-agent/ apps/desktop/src/service/conversation/store.ts
git commit -m "feat(service): session_entries table + sqlite SessionStorage implementing pi contract"
```

---

### Task 3: SessionAgent core run loop

**Files:**
- Create: `apps/desktop/src/service/session-agent/session-agent.ts`
- Create: `apps/desktop/src/service/session-agent/context.ts` (entries → AgentMessage[])
- Test: `apps/desktop/src/service/session-agent/session-agent.test.ts`

**Interfaces:**
- Consumes: `EntryStore` (Task 2); `AgentWireEvent`, `SessionEntry`, `RunStatus` (Task 1); from pi-agent-core: `Agent`, `type AgentEvent`, `type AgentMessage`, `type StreamFn`, `convertToLlm`, `uuidv7`; existing `resolveModel` (`message-engine/models.ts` — file moves in Task 9), `composeSystemPrompt`, `clampThinkingLevel` (port from `message-engine/engine.ts`).
- Produces:

```ts
export type SessionAgentDeps = {
  sessionId: string
  entries: EntryStore
  broadcast: (e: AgentWireEvent) => void
  acquireSlot: (signal: AbortSignal) => Promise<() => void>
  buildAgentConfig: () => {           // resolved fresh per run by SessionService
    systemPrompt: string
    model: ReturnType<typeof resolveModel>
    thinkingLevel: ThinkingLevel
    tools: AgentTool[]                // Task 4 supplies real tools; [] until then
    maxTurns: number
    streamFn?: StreamFn               // tests inject a fake here
  }
  hooks?: {                           // Task 4 fills these
    beforeToolCall?: Agent['beforeToolCall']
  }
  log: Logger
}
export type RunResult = { runId: string; status: RunStatus; summary: string }
export class SessionAgent {
  constructor(deps: SessionAgentDeps)
  readonly phase: 'idle' | 'turn'
  submitUserMessage(text: string, attachments?: Attachment[]): { entryRowId: number }
  /** Resolves when the session goes idle with no unanswered user entries left. */
  waitForCompletion(): Promise<RunResult>
  cancel(): void
  dispose(): void
}
```

Semantics (each is a test case):
1. `submitUserMessage` appends the user `message` entry immediately (persist-then-broadcast `entry_appended`) — the transcript shows it in causal position forever. If `phase === 'idle'`, start a run; if busy, do nothing (the running loop picks trailing user entries up when it finishes).
2. A run: `runId = uuidv7()` → broadcast `agent_start` → acquire slot (abortable) → rebuild `agent.state.messages` from entries → `agent.continue()` (pi requires last message user/toolResult — guaranteed by 1).
3. Every pi `AgentEvent` maps to its wire twin with `{sessionId, runId}` attached. `message_update` is coalesced: at most one broadcast per 40ms per run (trailing edge, latest wins).
4. **Persistence invariant: every transcript message is appended exactly once.** Append on `message_end` and on `turn_end.toolResults`, deduped via a `WeakSet<object>` of already-appended message objects; on `agent_end`, diff `e.messages` against the WeakSet and append any stragglers. (pi's event emission points for toolResult messages are an implementation detail — the WeakSet makes the invariant hold regardless.)
5. Terminal: after `continue()` settles, status = last assistant `stopReason === 'error'` → `failed` (+`errorMessage`), `'aborted'` → `cancelled`, else `completed`. Broadcast `agent_end`. If entries gained NEW trailing user messages during the run, start another run instead of resolving.
6. `cancel()` aborts slot-wait or `agent.abort()`. `maxTurns` guard via `prepareNextTurn` counter → `agent.abort()` + status forced `cancelled` with `errorMessage: 'max iterations reached'`.
7. After a `failed` run the pi `Agent` instance is discarded (rebuilt from entries next run — bad in-memory state lives ≤ 1 run, spec §3.3). After `completed`/`cancelled` it is reused.

- [ ] **Step 1: Write failing tests with a deterministic fake streamFn**

The fake follows pi's StreamFn contract (never throws; failure rides the final assistant message). Model it on pi's own faux-provider trick:

```ts
// apps/desktop/src/service/session-agent/session-agent.test.ts
import Database from 'better-sqlite3'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { AgentWireEvent } from '@swarm/protocol'
import { createEntryStore, ensureEntriesSchema } from './sqlite-storage'
import { SessionAgent } from './session-agent'

/** Builds a StreamFn that replies with the queued assistant messages, one per LLM call. */
function fakeStream(replies: Array<{ text: string; stopReason?: 'stop' | 'error' | 'aborted'; errorMessage?: string }>) {
  let call = 0
  return () => {
    const r = replies[Math.min(call++, replies.length - 1)]
    const message = {
      role: 'assistant', content: [{ type: 'text', text: r.text }],
      stopReason: r.stopReason ?? 'stop', errorMessage: r.errorMessage,
      usage: { input: 10, output: 5 }, timestamp: new Date().toISOString(),
    }
    return (async function* () {
      yield { type: 'start', partial: message }
      yield { type: 'text_delta', delta: r.text, partial: message }
      yield { type: 'done', message }
    })() as any // satisfies AssistantMessageEventStream for the loop's purposes
  }
}

const makeAgent = (streamReplies: Parameters<typeof fakeStream>[0]) => {
  const db = new Database(':memory:')
  ensureEntriesSchema(db)
  const entries = createEntryStore(db)
  const events: AgentWireEvent[] = []
  const agent = new SessionAgent({
    sessionId: 's1', entries,
    broadcast: (e) => events.push(e),
    acquireSlot: async () => () => {},
    buildAgentConfig: () => ({
      systemPrompt: 'test', model: FAKE_MODEL, thinkingLevel: 'off',
      tools: [], maxTurns: 5, streamFn: fakeStream(streamReplies),
    }),
    log: silentLogger(),
  })
  return { agent, entries, events }
}

describe('SessionAgent', () => {
  it('persists the user entry at submit, in causal position', () => {
    const { agent, entries, events } = makeAgent([{ text: 'hi!' }])
    agent.submitUserMessage('hello')
    const rows = entries.list('s1')
    expect(rows[0].entry.type).toBe('message')
    expect(events[0].kind).toBe('entry_appended')
  })

  it('runs to completion: assistant entry persisted exactly once, agent_end completed', async () => {
    const { agent, entries, events } = makeAgent([{ text: 'answer' }])
    agent.submitUserMessage('question')
    const result = await agent.waitForCompletion()
    expect(result.status).toBe('completed')
    const msgs = entries.list('s1').filter((r) => r.entry.type === 'message')
    expect(msgs).toHaveLength(2) // user + assistant, no duplicates
    expect(events.filter((e) => e.kind === 'agent_end')).toHaveLength(1)
  })

  it('maps provider failure to agent_end failed and discards the pi agent', async () => {
    const { agent } = makeAgent([{ text: '', stopReason: 'error', errorMessage: 'boom' }])
    agent.submitUserMessage('q')
    const result = await agent.waitForCompletion()
    expect(result.status).toBe('failed')
  })

  it('coalesces message_update broadcasts to ≤1 per 40ms window', async () => {
    vi.useFakeTimers()
    // fake stream yields 10 text_deltas in one tick; expect a single message_update broadcast
    // (assert events.filter(kind==='message_update').length === 1 after advancing timers)
  })

  it('a prompt submitted mid-run is answered by a follow-up run, not dropped', async () => {
    // submit A; while running, submit B; waitForCompletion resolves only after
    // both trailing user entries have assistant answers (2 agent_start events).
  })

  it('cancel() while waiting for a slot resolves cancelled without an LLM call', async () => {
    // acquireSlot returns a never-resolving promise racing the signal; cancel();
    // expect status 'cancelled' and zero message entries beyond the user prompt.
  })
})
```

(The three sketched cases are full tests in the implementation — write them out with the same fake-stream/fake-timer helpers shown above.)

- [ ] **Step 2: Run tests to verify they fail**

Run: `cd apps/desktop && npm test -- src/service/session-agent/session-agent.test.ts`
Expected: FAIL — `session-agent` not found.

- [ ] **Step 3: Implement `context.ts`**

```ts
// apps/desktop/src/service/session-agent/context.ts
import type { AgentMessage } from '@earendil-works/pi-agent-core'
import type { EntryRow } from '@swarm/protocol'

/**
 * entries → pi AgentMessage[] (spec §3.2). Linear history: table order IS the
 * path. P1 projects `message` entries only; `custom` entries are app-data
 * (model-invisible by default, pi semantics); `compaction`/`custom_message`
 * projection lands in P4 with transformContext.
 */
export function messagesFromEntries(rows: EntryRow[]): AgentMessage[] {
  const out: AgentMessage[] = []
  for (const { entry } of rows) {
    if (entry.type === 'message') out.push(entry.message as AgentMessage)
  }
  return out
}

/** True when the transcript ends with user message(s) no run has answered yet. */
export function hasUnansweredUserTail(rows: EntryRow[]): boolean {
  const msgs = messagesFromEntries(rows)
  const last = msgs[msgs.length - 1] as { role?: string } | undefined
  return last?.role === 'user'
}
```

- [ ] **Step 4: Implement `session-agent.ts`**

Core shape (complete the mechanical parts — imports, logger fields — matching existing service style):

```ts
// apps/desktop/src/service/session-agent/session-agent.ts
import { Agent, type AgentEvent, type AgentMessage, uuidv7 } from '@earendil-works/pi-agent-core'
import { convertToLlm } from '@earendil-works/pi-agent-core'
import type { AgentWireEvent, RunStatus } from '@swarm/protocol'
import { hasUnansweredUserTail, messagesFromEntries } from './context'

const UPDATE_COALESCE_MS = 40

export class SessionAgent {
  private agent: Agent | null = null
  private _phase: 'idle' | 'turn' = 'idle'
  private runId = ''
  private slotAbort: AbortController | null = null
  private appended = new WeakSet<object>()
  private pendingUpdate: AgentWireEvent | null = null
  private updateTimer: ReturnType<typeof setTimeout> | null = null
  private completion: { promise: Promise<RunResult>; resolve: (r: RunResult) => void } | null = null
  private turns = 0
  private maxTurns = 25
  private forcedStatus: RunStatus | null = null

  constructor(private readonly deps: SessionAgentDeps) {}

  get phase() { return this._phase }

  submitUserMessage(text: string, attachments: Attachment[] = []): { entryRowId: number } {
    const message: AgentMessage = {
      role: 'user',
      content: attachments.length
        ? [{ type: 'text', text }, ...attachments.map(toImageContent)]
        : text,
      timestamp: new Date().toISOString(),
    } as AgentMessage
    const rowId = this.appendEntry({ type: 'message', message })
    this.deps.log.info({ msg: 'user message submitted', sessionId: this.deps.sessionId, entryRowId: rowId })
    if (this._phase === 'idle') void this.runLoop()
    return { entryRowId: rowId }
  }

  waitForCompletion(): Promise<RunResult> {
    if (!this.completion) {
      let resolve!: (r: RunResult) => void
      const promise = new Promise<RunResult>((r) => { resolve = r })
      this.completion = { promise, resolve }
    }
    return this.completion.promise
  }

  cancel(): void {
    this.slotAbort?.abort()
    this.agent?.abort()
  }

  dispose(): void {
    this.cancel()
    this.agent = null
  }

  /** Appends (persist) then broadcasts entry_appended — the ONE write path. */
  private appendEntry(partial: { type: 'message'; message: AgentMessage } | Omit<SessionEntry, 'id' | 'parentId' | 'timestamp'>): number {
    const rows = this.deps.entries.list(this.deps.sessionId)
    const entry = {
      ...partial,
      id: uuidv7(),
      parentId: rows.length ? rows[rows.length - 1].entry.id : null,
      timestamp: new Date().toISOString(),
    } as SessionEntry
    const rowId = this.deps.entries.append(this.deps.sessionId, entry)
    this.deps.broadcast({ kind: 'entry_appended', sessionId: this.deps.sessionId, rowId, entry })
    return rowId
  }

  private appendMessageOnce(message: AgentMessage): void {
    if (typeof message !== 'object' || message === null) return
    if (this.appended.has(message)) return
    this.appended.add(message)
    this.appendEntry({ type: 'message', message })
  }

  private buildAgent(cfg: ReturnType<SessionAgentDeps['buildAgentConfig']>): Agent {
    const agent = new Agent({
      initialState: {
        systemPrompt: cfg.systemPrompt, model: cfg.model.model,
        thinkingLevel: cfg.thinkingLevel, tools: cfg.tools, messages: [],
      },
      convertToLlm,
      ...(cfg.streamFn ? { streamFn: cfg.streamFn } : {}),
      getApiKey: () => cfg.model.apiKey,
      beforeToolCall: (ctx, signal) => this.deps.hooks?.beforeToolCall?.(ctx, signal) ?? Promise.resolve(undefined),
      prepareNextTurn: () => {
        this.turns += 1
        if (this.turns >= this.maxTurns) {
          this.forcedStatus = 'cancelled'
          this.deps.log.warn({ msg: 'max iterations reached, aborting', sessionId: this.deps.sessionId, runId: this.runId, turns: this.turns })
          agent.abort()
        }
        return undefined
      },
    })
    agent.subscribe((e) => this.handleAgentEvent(e))
    return agent
  }

  private handleAgentEvent(e: AgentEvent): void {
    const scope = { sessionId: this.deps.sessionId, runId: this.runId }
    switch (e.type) {
      case 'message_update': {
        this.pendingUpdate = { kind: 'message_update', ...scope, message: e.message }
        this.updateTimer ??= setTimeout(() => {
          this.updateTimer = null
          if (this.pendingUpdate) this.deps.broadcast(this.pendingUpdate)
          this.pendingUpdate = null
        }, UPDATE_COALESCE_MS)
        return
      }
      case 'message_start':
        this.deps.broadcast({ kind: 'message_start', ...scope, message: e.message })
        return
      case 'message_end':
        this.flushUpdate()
        this.appendMessageOnce(e.message)
        this.deps.broadcast({ kind: 'message_end', ...scope, message: e.message })
        return
      case 'turn_start':
        this.deps.broadcast({ kind: 'turn_start', ...scope })
        return
      case 'turn_end': {
        for (const tr of e.toolResults) this.appendMessageOnce(tr)
        this.deps.broadcast({ kind: 'turn_end', ...scope, ...this.usageSnapshot(e.message) })
        return
      }
      case 'tool_execution_start':
        this.deps.broadcast({ kind: 'tool_execution_start', ...scope, toolCallId: e.toolCallId, toolName: e.toolName, args: e.args })
        return
      case 'tool_execution_update':
        this.deps.broadcast({ kind: 'tool_execution_update', ...scope, toolCallId: e.toolCallId, toolName: e.toolName, partialResult: e.partialResult })
        return
      case 'tool_execution_end':
        this.deps.broadcast({ kind: 'tool_execution_end', ...scope, toolCallId: e.toolCallId, toolName: e.toolName, result: e.result, isError: e.isError })
        return
      case 'agent_end':
        this.flushUpdate()
        for (const m of e.messages) this.appendMessageOnce(m) // straggler net (invariant #4)
        return
      default:
        return
    }
  }

  private async runLoop(): Promise<void> {
    this._phase = 'turn'
    try {
      while (hasUnansweredUserTail(this.deps.entries.list(this.deps.sessionId))) {
        const result = await this.runOnce()
        if (result.status !== 'completed') { this.settle(result); return }
        if (result.discardAgent) this.agent = null
      }
      this.settle({ runId: this.runId, status: 'completed', summary: this.lastAssistantText() })
    } finally {
      this._phase = 'idle'
    }
  }

  private async runOnce(): Promise<RunResult & { discardAgent?: boolean }> {
    this.runId = uuidv7()
    this.turns = 0
    this.forcedStatus = null
    const cfg = this.deps.buildAgentConfig()
    this.maxTurns = cfg.maxTurns
    this.deps.broadcast({ kind: 'agent_start', sessionId: this.deps.sessionId, runId: this.runId })
    this.deps.log.info({ msg: 'run started', sessionId: this.deps.sessionId, runId: this.runId })

    this.slotAbort = new AbortController()
    let release: (() => void) | null = null
    try {
      release = await this.deps.acquireSlot(this.slotAbort.signal)
    } catch {
      return this.finishRun('cancelled', 'Stopped by user.')
    }
    try {
      this.agent ??= this.buildAgent(cfg)
      this.agent.state.tools = cfg.tools
      this.agent.state.messages = messagesFromEntries(this.deps.entries.list(this.deps.sessionId))
      await this.agent.continue()
      const last = this.lastAssistant()
      if (this.forcedStatus) return this.finishRun(this.forcedStatus, last?.errorMessage ?? 'max iterations reached')
      if (last?.stopReason === 'error') return { ...this.finishRun('failed', last.errorMessage ?? 'request failed'), discardAgent: true }
      if (last?.stopReason === 'aborted') return this.finishRun('cancelled', 'Stopped by user.')
      return this.finishRun('completed', this.lastAssistantText())
    } catch (err) {
      this.deps.log.error({ msg: 'run crashed', sessionId: this.deps.sessionId, runId: this.runId, err: err instanceof Error ? err.message : String(err) })
      return { ...this.finishRun('failed', String(err)), discardAgent: true }
    } finally {
      release?.()
      this.slotAbort = null
    }
  }

  private finishRun(status: RunStatus, summary: string): RunResult {
    this.deps.broadcast({
      kind: 'agent_end', sessionId: this.deps.sessionId, runId: this.runId, status,
      ...(status !== 'completed' ? { errorMessage: summary } : {}),
    })
    this.deps.log.info({ msg: 'run finished', sessionId: this.deps.sessionId, runId: this.runId, status })
    return { runId: this.runId, status, summary }
  }

  private settle(result: RunResult): void {
    const c = this.completion
    this.completion = null
    c?.resolve(result)
  }
  // flushUpdate / usageSnapshot / lastAssistant(Text) are small private helpers:
  // flushUpdate clears the coalesce timer and broadcasts pendingUpdate;
  // usageSnapshot ports the usage/contextTokens extraction currently in
  // message-engine/engine.ts turn_end handling (engine.ts:256-268);
  // lastAssistant scans agent.state.messages for the last role==='assistant'.
}
```

- [ ] **Step 5: Run tests, fix event-order assumptions against reality**

Run: `cd apps/desktop && npm test -- src/service/session-agent/session-agent.test.ts`
Expected: PASS (7 tests). If the toolResult double-append case fires, the WeakSet dedup absorbs it — the "exactly once" test is the arbiter.

- [ ] **Step 6: Commit**

```bash
git add apps/desktop/src/service/session-agent/
git commit -m "feat(service): SessionAgent core loop — entries-driven pi Agent with wire pass-through"
```

---

### Task 4: Permission gate, budgets, and tool context

**Files:**
- Create: `apps/desktop/src/service/session-agent/run-hooks.ts`
- Modify: `apps/desktop/src/service/session-agent/session-agent.ts` (accept `hooks.afterToolCall`, plan-todo capture)
- Test: `apps/desktop/src/service/session-agent/run-hooks.test.ts`

**Interfaces:**
- Consumes: `permissionRegistry.request(req, signal)` (`session/permission-registry.ts:39`), `toolRegistry.resolve(allowlist, ctx)` + `riskOf` (`tools/registry.ts:190`), `ResourceBudget`/`ConsumedResources` (`@swarm/protocol`).
- Produces: `createRunHooks(opts): { beforeToolCall, afterToolCall, used: ConsumedResources }` where `opts = { sessionId, runId, risk: (tool: string, args: unknown) => Risk, permissionMode: () => PermissionMode, requestPermission: (req) => Promise<'grant'|'deny'>, budget: ResourceBudget, broadcast, log, signal: () => AbortSignal | undefined, onPlanTodos: (todos: PlanTodo[]) => void }`.

Port the gate **verbatim in behavior** from `message-engine/engine.ts:199-236`: abort check → `used.calls += 1` → over-budget check (calls/wallMs/usdCents — tokens stays a dead knob) → risk: `low` auto-allow; `permissionMode() === 'full'` auto-allow; else broadcast `permission_request` + await registry (abort ⇒ deny). `afterToolCall`: when `toolName === 'update_plan'` and the result details carry `todos`, call `onPlanTodos` (SessionAgent appends `{ type:'custom', customType:'plan', data:{ todos } }` — replaces the old `message.plan` wire event).

- [ ] **Step 1: Failing tests** — four cases: low-risk tool passes without permission call; medium risk + mode `ask` broadcasts `permission_request` and blocks on deny; budget `calls` exceeded blocks with reason; abort signal blocks with fail-safe deny. Use a stub registry/permission fn; assert broadcast payloads carry `{sessionId, runId, actionId, risk, summary}`.
- [ ] **Step 2: Run to verify failure** — `npm test -- src/service/session-agent/run-hooks.test.ts`.
- [ ] **Step 3: Implement `run-hooks.ts`** by porting engine.ts:199-236 into the `createRunHooks` factory (the code moves nearly line-for-line; the emit call becomes `broadcast({kind:'permission_request', ...})`).
- [ ] **Step 4: Wire into SessionAgent** — `buildAgentConfig` return gains `hooks` built per run (fresh `used` per run); `afterToolCall` forwarded like `beforeToolCall`.
- [ ] **Step 5: Run tests** — both new files PASS.
- [ ] **Step 6: Commit** — `git commit -m "feat(service): port permission/budget gate and plan capture into SessionAgent hooks"`.

---

### Task 5: SessionService rewiring + IPC surface

**Files:**
- Modify: `apps/desktop/src/service/session/session-service.ts` (the heart of the swap)
- Modify: `apps/desktop/src/service/ipc/dispatcher.ts`, `apps/desktop/src/service/index.ts`
- Modify: `packages/protocol/src/service-client.ts`, `apps/desktop/src/preload/index.ts`, `apps/desktop/src/preload/index.d.ts`
- Modify: `apps/desktop/src/service/tools/delegate.ts` (result shape unchanged; child path changes), `apps/desktop/src/service/cron/scheduler.ts` wiring in `service/index.ts:128-141`
- Test: `apps/desktop/src/service/session/session-service.test.ts` (rewrite), `packages/protocol/src/service-client.test.ts` (adapt)

**Interfaces:**
- Consumes: `SessionAgent` (Task 3), `createRunHooks` (Task 4), `EntryStore` (Task 2).
- Produces (service methods — dispatcher cases and ServiceClient methods must match exactly):
  - `submitPrompt(sessionId, prompt, attachments?, onComplete?, options?) → { runId: string }` (was `{messageId}` — rename ripples to preload + client + callers)
  - `getSessionEntries(sessionId: string, afterRowId?: number) → EntryRow[]` (replaces `getMessageEvents`)
  - `cancelRun(sessionId: string) → void` (replaces `cancelMessage(sessionId, messageId)` — cancel targets the session's active run)
  - REMOVED: `promoteQueuedMessage` (P2 brings steering), `getMessageEvents`, `forkToNewSession`'s lossy reconstruction (see below)
  - `forkSession(sourceSessionId, upToRowId: number) → { sessionId }` — full-fidelity fork via `entries.copyUpTo` (replaces `reconstructHistoryFromEvents`)
  - `delegate` (tool ctx): creates a **child session** (`store.createSession` with `kind:'child'` — add a `kind TEXT DEFAULT 'user'` column to `sessions`; `listSessions` filters `kind='user'`), appends `{type:'custom', customType:'delegation', data:{childSessionId, agentDefId, prompt, itemId?}}` to the parent, runs the child SessionAgent to completion, appends `{customType:'delegation_result', data:{childSessionId, status, summary}}`, returns `DelegateResult` with the same `[failed]`/`[cancelled]` prefix rule (`tools/delegate.ts:34-40` unchanged)
  - `setDelegationPlan`/`mergeDelegationResult` (tool ctx): append `{customType:'delegation_plan', data:{plan}}` / `{customType:'delegation_update', data:{itemId, status, result}}` custom entries (replaces `planStates` + `message.delegation_plan` events)

Key edits inside `session-service.ts`:
1. `SessionState` gains `agent?: SessionAgent`; add `getOrCreateAgent(session)` that wires deps: `entries`, `broadcast: emitPorts→broadcaster`, `acquireSlot`, `buildAgentConfig` (agentDef/provider/tool resolution moved from `launchMessage` spec assembly — `composeSystemPrompt`, `resolveModel`, `clampThinkingLevel`, `toolRegistry.resolve(allowlist, toolCtx)`), `hooks: createRunHooks(...)`.
2. `submitPrompt` (session-service.ts:820) → `getOrCreateAgent(session).submitUserMessage(prompt, attachments)`; `onComplete` chains off `agent.waitForCompletion().then(r => onComplete?.(r.status))` — the cron contract (`service/index.ts:128-141`) keeps working unchanged.
3. Delete: `waitTurn`/`turnQueues`/`pumpTurns`/`settleTurn` (`:456-493`), `aborts` map + `registerAbort` (SessionAgent owns abort), `promoteQueuedMessage` (`:943`), `markInterruptedRunsTerminal` (`:734`), terminal-registry usage, `saveAgentSnapshot`/`getAgentSnapshot` calls, `reconstructHistoryFromEvents` (`:184`). Keep: slot pool (`:402-450`), permission registry, `withSlotReleased` (delegate awaits child → parent must yield its slot exactly as today, `launch.ts:127-139` logic moves into the delegate tool-ctx closure).
4. Cron boot-scan: `scheduler.ts:108-116` orphan finalization — replace `runTerminalStatus(run.taskId)` with unconditional `'failed'` (runs cannot survive a restart; entries persist, live state doesn't).
5. `dispatcher.ts`: rename/replace cases — `submitPrompt` (same name, new return), `getSessionEntries`, `cancelRun`, `forkSession`; delete `getMessageEvents`, `cancelMessage`, `promoteQueuedMessage`, `forkToNewSession`.
6. `service-client.ts` + `preload/index.ts` + `index.d.ts`: mirror the method table 1:1.

- [ ] **Step 1: Rewrite `session-service.test.ts` first** — cases: submit creates entries + broadcasts through the real broadcaster stub; two sessions run concurrently under a 1-slot pool (second queues); cancelRun mid-slot-wait settles cancelled; delegate creates a hidden child session, parent gains `delegation` + `delegation_result` custom entries, result prefixes `[failed]` when child fails; fork copies entries. Use the Task 3 fake streamFn.
- [ ] **Step 2: Run to verify failures.**
- [ ] **Step 3-6: Implement edits 1-6 above, one commit per coherent slice:**

```bash
git commit -m "feat(service): route submitPrompt through SessionAgent; delete FIFO/aborts/terminal machinery"
git commit -m "feat(service): child sessions for delegate; delegation state as custom entries; full-fidelity fork"
git commit -m "feat(ipc): getSessionEntries/cancelRun/forkSession across dispatcher, client, preload"
```

- [ ] **Step 7: Full service test pass** — `cd apps/desktop && npm test -- src/service/`. Expected: PASS except `message-engine/*` suites (deleted in Task 9; skip via the deletion, not by weakening tests).

---

### Task 6: Shared renderer core — SessionView reducer + segments

**Files:**
- Create: `packages/shared/src/entries/session-view.ts`
- Create: `packages/shared/src/entries/segments.ts`
- Create tests: `packages/shared/src/entries/session-view.test.ts`, `segments.test.ts`
- Modify: `packages/shared/src/index.ts` (export)

**Interfaces:**
- Consumes: `AgentWireEvent`, `EntryRow`, `SessionEntry`, `RunStatus` from `@swarm/protocol`.
- Produces:

```ts
export type SessionView = {
  entries: EntryRow[]                     // finalized transcript (ordered by rowId)
  cursor: number                          // max rowId seen; catch-up query key
  running: boolean
  runId?: string
  streaming?: unknown                     // partial assistant message (message_update)
  pendingTools: Record<string, { toolName: string; args: unknown; partialResult?: unknown }>
  lastError?: string
  usage?: { used: ConsumedResources; contextTokens?: number; contextWindow?: number; model?: string }
  gapDetected: boolean                    // true ⇒ client must re-pull from cursor
}
export const emptySessionView: () => SessionView
export function hydrate(view: SessionView, rows: EntryRow[]): SessionView
export function applyWireEvent(view: SessionView, e: AgentWireEvent): SessionView
// segments.ts — Segment union mirrors the existing desktop one
// (apps/desktop/src/renderer/src/lib/task-segments.ts:7-35: user|assistant|reasoning|tool|event|error)
// so TranscriptCard components survive with minimal churn.
export type Segment = /* same member shapes as desktop task-segments.ts Segment */
export function buildSegments(view: SessionView): Segment[]
```

Reducer rules (each is a test): `entry_appended` with `rowId === cursor + 1` (or first) appends + advances cursor; `rowId > cursor + 1` sets `gapDetected` (client re-pulls, then `hydrate` clears it); duplicate/stale `rowId ≤ cursor` ignored (idempotent replay). `agent_start` → running/runId; `agent_end` → running=false, error captured; `message_update` → streaming (cleared on `message_end`/`agent_end`); `tool_execution_start/update/end` maintain `pendingTools`; `turn_end` → usage. `buildSegments`: user message entry → `user` segment; assistant message entry → per content block: `text`→assistant, `thinking`→reasoning, `toolCall`→open `tool` segment; `toolResult` message entry closes the matching tool segment by `toolCallId` (FIFO fallback); `custom` entries → `event` segments (`delegation`/`delegation_result`/`plan` get labeled events; unknown customType → generic label — the open-union bet, spec §3.2); streaming overlay appends a trailing assistant segment; `pendingTools` render as running tool segments.

- [ ] **Step 1: Write the failing tests** (~10 cases enumerated above; use tiny literal entries as in Task 1 tests).
- [ ] **Step 2: Verify failure** — `cd packages/shared && npm test -- src/entries/`.
- [ ] **Step 3: Implement both modules** (pure functions, no React).
- [ ] **Step 4: Verify pass.**
- [ ] **Step 5: Commit** — `git commit -m "feat(shared): SessionView reducer + entry-based segment builder (wire v3)"`.

---

### Task 7: Desktop renderer swap

**Files:**
- Create: `apps/desktop/src/renderer/src/hooks/use-session-view.ts`
- Modify: `apps/desktop/src/renderer/src/hooks/use-events-subscription.ts`, `lib/api.ts`, `stores/permission.ts`
- Modify: `components/conversation-thread.tsx`, `components/task-transcript.tsx`, `components/views/tasks-view.tsx`
- Modify (consumer long tail): `lib/session-usage.ts`, `lib/dashboard-messages.ts`, `components/views/dashboard/running-card{,s}.tsx`, `components/plan-panel.tsx` + `workspace/workspace-panel.tsx`, `session-list.tsx`, `views/home-dashboard.tsx`, `quick-panel/quick-panel-chat.tsx`, `hooks/use-palette-data.ts`, `hooks/use-agent-activity.ts`
- Delete usage of: `hooks/use-messages.ts` (rewrite), `hooks/use-delegation-plan.ts`, `lib/task-segments.ts`, `lib/group-segments.ts` (keep — works on shared Segment), `lib/build-timeline-items.ts`
- Tests: `hooks/use-session-view.test.tsx` (new), adapt `task-transcript.test.tsx`, delete superseded suites in Task 9

**Interfaces:**
- Consumes: `SessionView`/`applyWireEvent`/`hydrate`/`buildSegments` (Task 6); `swarmApi.getSessionEntries(sessionId, afterRowId)`, `subscribeEvents` (Task 5).
- Produces: `useSessionView(sessionId): { view: SessionView; segments: Segment[] }` — TanStack Query cache keyed `['session-view', sessionId]`; live events fold via `qc.setQueryData`; when `view.gapDetected`, effect re-pulls `getSessionEntries(sessionId, view.cursor)` and folds through `hydrate`. Also `useRunningSessions(): Set<string>` (fed by `agent_start`/`agent_end`) for dashboard/session-list.

Consumer adaptations (mechanical, per file):
- `use-events-subscription.ts`: replace `kind.startsWith('message.')` folding with `isAgentWireEvent(e)` → route into the `['session-view', e.sessionId]` cache; permission push keys on `kind === 'permission_request'`; usage-live keys on `turn_end`; unread/toast logic keys on `agent_end`.
- `tasks-view.tsx`: `activeTask/queuedTasks` classification collapses — composer busy state = `view.running`; queued list = trailing unanswered user entries (derive from `view`); remove `usePromoteQueuedMessage` button; `useCancelMessage` → `useCancelRun(sessionId)`.
- `task-transcript.tsx`: `SubagentBlock` re-keys on `customType:'delegation'` entries — lazily `useSessionView(childSessionId)` and render its segments; label from `data.agentDefId`; spinner while child view `running`.
- `plan-panel.tsx` feed: latest `custom` entry with `customType:'plan'` → `PlanGroup`.
- `session-usage.ts`: sum assistant message entries' `usage` field; live ctx tokens from `view.usage`.
- `dashboard-messages.ts`/`running-card`: source from `useRunningSessions()` + per-session `view` (status/summary from last entries).
- OrchestrationGraph: render nothing in P1 (`planState` selector returns empty; file untouched — accepted regression, header note).

- [ ] **Step 1: Write `use-session-view.test.tsx`** (jsdom pragma): hydrates from a mock `getSessionEntries`, folds a live `entry_appended`, re-pulls on gap (mock returns the missed row; assert final entries complete and `gapDetected` false), in-place streaming via `message_update` then finalized by `entry_appended`.
- [ ] **Step 2: Verify failure.**
- [ ] **Step 3: Implement hook + `use-events-subscription` rewire. Commit** — `"feat(renderer): SessionView hook with cursor catch-up and gap self-heal"`.
- [ ] **Step 4: Swap transcript components** (`conversation-thread`, `task-transcript`, `tasks-view`) onto `useSessionView`/`buildSegments`; adapt `task-transcript.test.tsx` fixtures from `MessageRecord` to `SessionView`. Commit — `"feat(renderer): transcript renders from session entries"`.
- [ ] **Step 5: Consumer long tail** (list above, one pass); run `cd apps/desktop && npm test -- src/renderer/`; fix. Commit — `"refactor(renderer): migrate dashboards, plan panel, usage, palette to session views"`.
- [ ] **Step 6: Manual smoke via `run-desktop` skill** — launch app, send a prompt, verify: user message renders instantly, streaming updates in place, tool card opens/closes, transcript identical after app restart. Fix what's broken before committing the smoke fixes.

---

### Task 8: Web + mobile clients

**Files:**
- Modify: `apps/web/src/pages/session.tsx`, `apps/web/src/hooks/use-message-event-source.ts` (rename → `use-session-view-source.ts`)
- Modify: `apps/mobile/app/session/[id].tsx`, `apps/mobile/hooks/use-events.ts`
- Tests: adapt `apps/web/src/stores/__tests__/connection-store.test.ts` fixtures to v3 kinds

**Interfaces:**
- Consumes: shared `SessionView`/`buildSegments` (Task 6), `ServiceClient.getSessionEntries` (Task 5).

Both pages follow the same recipe (they already consume only `message.progress`/`permission_request`/`error`): hydrate = `client.getSessionEntries(id)` → `hydrate(emptySessionView(), rows)`; subscribe = fold `AgentWireEvent`s via `applyWireEvent`; render `buildSegments(view)` with the existing `SegmentView`/RN switch (Segment union unchanged member shapes); permission cards key on `kind === 'permission_request'`; submit unchanged.

- [ ] **Step 1: Adapt web session page + hook; run `cd apps/web && npm test`.** Commit — `"feat(web): session page on entries/SessionView"`.
- [ ] **Step 2: Adapt mobile session screen the same way; typecheck (`cd apps/mobile && npx tsc --noEmit`).** Commit — `"feat(mobile): session screen on entries/SessionView"`.

---

### Task 9: Deletions + repo-wide sweep

**Files (delete):**
- `apps/desktop/src/service/message-engine/` (entire dir: engine, launch, translator, emit, retry, models — **move `models.ts` + `composeSystemPrompt`/`clampThinkingLevel` into `session-agent/` first**, they're consumed by Task 3)
- `apps/desktop/src/service/session/seq-counter.ts`, `terminal-registry.ts` (+ tests)
- `packages/protocol/src/types/message.ts` (+ test); from `task.ts`: `TaskEventSchema`/`TaskEvent`, `MessageEvent`, `TaskStatus` (keep `ResourceBudget`, `ConsumedResources`, `PermissionMode`, `ExecutionMode`, `RunOptions`→rename `SubmitOptions`, `PlanTodo`, `DelegationItem*`, `Artifact`, `Attachment`, `DelegateResult` — move them to fitting modules per the naming spec, delete `task.ts`)
- `packages/shared/src/messages/` (apply-event, task-segments, delegation-reducer + tests), `packages/shared/src/hooks/use-messages.ts`
- Desktop renderer: `lib/task-segments.ts`, `lib/build-timeline-items.ts`, `hooks/use-delegation-plan.ts`, `shared/lib/apply-event.ts` (+ all their tests)
- Store: `appendMessageEvent`/`getMessageEvents`/`saveAgentSnapshot`/`getAgentSnapshot` and the `message_events` DDL

- [ ] **Step 1: Move the survivors** (`models.ts`, prompt helpers) into `session-agent/`; fix imports; commit — `"refactor(service): move model resolution into session-agent"`.
- [ ] **Step 2: Delete the files/exports listed; fix every compile error the deletions surface** (this is the checklist of missed consumers). Grep guards — all must return zero hits in `apps/ packages/` (excluding docs):

```bash
rg -l "MessageWireEvent|TaskEvent|getMessageEvents|promoteQueuedMessage|terminalStatusForMessageEvent|message-engine|seq-counter" apps packages --type ts
rg "'(message|task|run)\.[a-z_]+'" apps packages --type ts -g '!*.md'
```

- [ ] **Step 3: Full verification**

```bash
find . -name '*.tsbuildinfo' -delete
pnpm -w typecheck        # or turbo typecheck per repo scripts — must be clean
cd apps/desktop && npm test        # full suite
cd ../../packages/shared && npm test && cd ../protocol && npm test
```

Expected: all green. Known pre-existing failures (rail/weather, calendar-reauth flake) are the only tolerated reds — anything else gets fixed, not skipped.

- [ ] **Step 4: Commit** — `git commit -m "chore: delete message-engine, v2 wire types, and event-log machinery"`.

---

### Task 10: End-to-end verification

- [ ] **Step 1: `run-desktop` full pass** — build + launch the real app, then verify each flow and capture a screenshot per item:
  1. Send a prompt → user bubble instant, assistant streams in place, finalizes.
  2. Tool-using prompt (e.g. weather/fs tool) → tool card opens with args, closes with result.
  3. Cancel mid-stream → run stops, `agent_end` cancelled, composer re-enabled.
  4. Delegate flow (CEO agent) → child block appears, child transcript streams, `[failed]` prefix honored on a forced child failure.
  5. Permission prompt (medium-risk tool, mode `ask`) → card appears, deny blocks the tool, grant proceeds.
  6. Restart the app → every transcript above replays identically from `session_entries` (no running ghosts).
  7. Cron job fires into its system session and completes (check `~/.swarm-agents/swarm-dev.log` for `run started`/`run finished` with matching `runId`).
- [ ] **Step 2: Log audit** — `grep '"level":\(40\|50\)' ~/.swarm-agents/swarm-dev.log | tail -30`; no unexplained errors from the new paths.
- [ ] **Step 3: Final commit + hand back for merge decision** (superpowers:finishing-a-development-branch).

---

## Self-Review (run after writing, fixed inline)

- **Spec coverage:** §3.1 naming→Tasks 1/9; §3.2 storage/single-source→Task 2; §3.3 SessionAgent (minus retry/compaction = P3/P4 by design)→Tasks 3/4; §3.4 events/delivery/coalescing/gap-heal→Tasks 1/3/6/7; §3.5 turn/work/child→Task 5; §3.6 P1 cut→whole plan; §3.7 testing/logging→every task + Task 10. Steering (§P2), retry (§P3), compaction/projectors (§P4) intentionally absent.
- **Type consistency:** `EntryRow{rowId,entry}`, `getSessionEntries(sessionId, afterRowId)`, `cancelRun(sessionId)`, `submitPrompt→{runId}`, `SessionView.cursor/gapDetected` used identically across Tasks 2/5/6/7/8.
- **Placeholder scan:** Task 3 Step 1 has three prose-sketched test cases — accepted as explicit TODO-with-shape (helpers shown above them); everything else carries code.
