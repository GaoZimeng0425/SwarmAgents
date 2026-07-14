# Phase 4a — Unified Run Rendering (Implementation Plan)

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make a single `run_events` stream (UIEvent-shaped) the renderer's only source of run activity — conversation, work, spawn, cron all emit their full lifecycle there; the transcript replays via `applyEvent` over UIEvents; the `conversationTurnsToRecords`/`tasksToRecords` adapter and the `isConversation` marker are gone; `TaskRecord` → `RunRecord`. The `Task`/`task_events` tables stay (dual-written by work/spawn/cron for `wait_for_task`/listener/cron; not read by the renderer) — 4b removes them.

**Architecture:** Layered, app stays green at each commit. (1) Add a fresh `run_events` table + store API (UIEvent-shaped). (2) `makeRunEmit` persists the full lifecycle (every event kind, as a UIEvent) and conversation emits `task.created`. (3) Work/spawn/cron/resident/gmail tee into `run_events` (dual-write alongside their existing `task_events` writes). (4) IPC `getRunEvents`. (5) Rename `TaskRecord`→`RunRecord`. (6) Renderer replays via `applyEvent` over `run_events`; drop the adapter. (7) e2e + smoke.

**Design refinement over spec §4.1/§5.4 (first-principles, per user's "don't be lazy"):** `run_events` is a FRESH table storing UIEvents (`{ kind, ...payload }`), NOT a rename of `conversation_events` (which stored inner `TaskEvent`s — incompatible shape). Replay is `getRunEvents → UIEvent[] → reduce(applyEvent) → RunRecord[]` — pure event sourcing, no `runEventsToRecords`/adapter. Old conversation/task history is NOT carried (disposable per user). `conversation_events`/`task_events` tables are retained and dual-written (4b drops them).

**Tech Stack:** TypeScript, `vitest`, `better-sqlite3`, Electron (test runner), `@swarm/protocol`.

## Global Constraints

- **Spec:** `docs/superpowers/specs/2026-07-03-phase4a-unified-runs-design.md` (authoritative, modulo the refinement above).
- **Run tests via `npm test`** (Electron node runner). NEVER bare `npx vitest`, NEVER `pnpm rebuild better-sqlite3`. Single-file: `npm --prefix apps/desktop test -- <filter>`.
- **Behavior green at every commit** (full suite, modulo known pre-existing `gmail.test` htmlBody + `host.test` EADDRINUSE :47777).
- **Typecheck clean at every commit**; delete stale `**/*.tsbuildinfo` before trusting `npx tsc -b` (composite cache).
- **Comments and commit messages in English.**
- **Scoped formatting:** `npx biome check --write <file>`.
- **Build-artifact hazard:** `turbo typecheck` emits untracked `.js`/`.d.ts` next to every `.ts` (NOT gitignored). Delete `**/*.tsbuildinfo` before typecheck; `git add <exact paths>`, NEVER `git add -A`.
- **Pre-commit in this worktree** needs ALL workspace `node_modules` symlinked to main (root + `apps/desktop` + `apps/extension` + `apps/mobile` + `packages/{protocol,shared,ui}`). Already done on this worktree.
- **One commit per task**, on `worktree-phase4a-unified-runs`. Integrate to `develop` via `git rebase develop` + `git merge --ff-only`.

## File Structure

- **Modify** `apps/desktop/src/service/conversation/store.ts` — fresh `run_events` table; `appendRunEvent`/`getRunEvents` (UIEvent-shaped); keep `tasks`/`task_events` API as-is.
- **Modify** `apps/desktop/src/service/session/manager.ts` — `makeRunEmit` (full lifecycle, UIEvent); conversation emits `task.created`; work/spawn/cron/resident/gmail tee into `run_events`.
- **Modify** `apps/desktop/src/service/session/seq-counter.ts` — inits from `run_events` (was `conversation_events`).
- **Modify** `packages/protocol/src/types/task.ts` — add `RunEvent` type (UIEvent-shaped row).
- **Modify IPC:** `service/ipc/dispatcher.ts`, `main/ipc/swarm-ipc.ts`, `preload/index.ts`, `packages/protocol/src/service-client.ts`, `renderer/src/lib/api.ts` — add `getRunEvents`.
- **Modify renderer:** `shared/lib/apply-event.ts` (`TaskRecord`→`RunRecord`; drop `isConversation`), `renderer/src/lib/replay.ts` (drop `conversationTurnsToRecords` + `tasksToRecords`; replay via `applyEvent`), `renderer/src/hooks/use-tasks.ts` (`hydrateSession` reads `getRunEvents` + reduces via `applyEvent`), plus the ~59 `TaskRecord` callers (rename).
- **Adapt tests:** `store.test.ts`, `manager.test.ts`, `replay.test.ts`, `apply-event.test.ts`, `use-tasks.test.tsx`, e2e.

---

### Task 1: `run_events` table + store API + `RunEvent` type (additive)

**Files:**
- Modify: `apps/desktop/src/service/conversation/store.ts` (schema ~`:190`; add prepared statements near `:557`; add interface entries ~`:76`; add impls near `:805`).
- Modify: `packages/protocol/src/types/task.ts` (add `RunEvent` after `ConversationEvent` ~`:150`).
- Test: `apps/desktop/src/service/conversation/store.test.ts`.

**Interfaces:**
- Produces: `ConversationStore.appendRunEvent(sessionId, runId, parentRunId, event: UIEvent)` and `getRunEvents(sessionId): { runId, parentRunId, seq, ts, event: UIEvent }[]`; `RunEvent` protocol type.

**Note:** Fresh table (NOT a rename of `conversation_events`). The old `conversation_events` table + its `appendConversationEvent`/`getConversationEvents` API stay for now (still called by `makeConversationEmit`/seq-counter until Task 2; dropped in 4b). Additive — existing tests untouched.

- [ ] **Step 1: Write the failing store test**

In `store.test.ts`:

```ts
import type { UIEvent } from '@swarm/protocol'

it('appendRunEvent persists UIEvents and re-reads them with runId/parentRunId', () => {
  const store = createConversationStore(tmpDb())
  const ev: UIEvent = { kind: 'task.progress', sessionId: 's1', taskId: 'r1', event: { kind: 'llm.message', role: 'user', content: 'hi', ts: 1 }, ts: 1, seq: 1 }
  store.appendRunEvent('s1', 'r1', null, ev)
  store.appendRunEvent('s1', 'r1', null, { kind: 'task.complete', sessionId: 's1', taskId: 'r1', summary: 'done', ts: 2, seq: 2 })
  store.appendRunEvent('s1', 'r2', 'r1', { kind: 'task.created', sessionId: 's1', taskId: 'r2', goal: 'child', parentTaskId: 'r1', ts: 3, seq: 3 })
  const rows = store.getRunEvents('s1')
  expect(rows).toHaveLength(3)
  expect(rows.map((r) => r.runId)).toEqual(['r1', 'r1', 'r2'])
  expect(rows[2].parentRunId).toBe('r1')
  expect((rows[0].event as UIEvent).kind).toBe('task.progress')
})
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `npm --prefix apps/desktop test -- store.test`
Expected: FAIL — `appendRunEvent` is not a function.

- [ ] **Step 3: Add the schema + prepared statements**

In `store.ts`, inside the `CREATE TABLE` block (after `conversation_events`, ~line 198), add:

```sql
CREATE TABLE IF NOT EXISTS run_events (
  id            INTEGER PRIMARY KEY AUTOINCREMENT,
  session_id    TEXT NOT NULL,
  run_id        TEXT NOT NULL,
  parent_run_id TEXT,
  seq           INTEGER NOT NULL,
  ts            INTEGER NOT NULL,
  event         TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_run_events_session ON run_events(session_id, id);
```

Near the other prepared statements (~line 557), add:

```ts
const stmtInsertRunEvent = db.prepare(
  'INSERT INTO run_events (session_id, run_id, parent_run_id, seq, ts, event) VALUES (?, ?, ?, ?, ?, ?)'
)
const stmtGetRunEvents = db.prepare(
  'SELECT run_id AS runId, parent_run_id AS parentRunId, seq, ts, event FROM run_events WHERE session_id = ? ORDER BY id'
)
```

- [ ] **Step 4: Add the interface entries + impls**

In the `ConversationStore` type (~line 76, after `getConversationEvents`), add:

```ts
/** Persist a run-lifecycle UIEvent on the session run stream. */
appendRunEvent(sessionId: string, runId: string, parentRunId: string | null, event: import('@swarm/protocol').UIEvent): void
/** Read a session's run events in insertion order. */
getRunEvents(sessionId: string): { runId: string; parentRunId: string | null; seq: number; ts: number; event: import('@swarm/protocol').UIEvent }[]
```

In the returned object (near `appendConversationEvent` ~line 805), add:

```ts
appendRunEvent(sessionId, runId, parentRunId, event) {
  const seq = typeof (event as { seq?: number }).seq === 'number' ? (event as { seq: number }).seq : 0
  stmtInsertRunEvent.run(sessionId, runId, parentRunId, seq, event.ts ?? Date.now(), JSON.stringify(event))
},
getRunEvents(sessionId) {
  return (stmtGetRunEvents.all(sessionId) as { runId: string; parentRunId: string | null; seq: number; ts: number; event: string }[]).map((r) => ({
    runId: r.runId,
    parentRunId: r.parentRunId,
    seq: r.seq,
    ts: r.ts,
    event: JSON.parse(r.event) as import('@swarm/protocol').UIEvent,
  }))
},
```

Extend the session-delete cascade (~line 678) so session deletion cleans up:

```ts
db.prepare('DELETE FROM run_events WHERE session_id = ?').run(id)
```

- [ ] **Step 5: Add the `RunEvent` protocol type**

In `packages/protocol/src/types/task.ts`, after `ConversationEvent` (~line 150), add:

```ts
/** One row of a session's run-event stream (UIEvent-shaped; the renderer's replay source). */
export type RunEvent = {
  runId: string
  parentRunId: string | null
  seq: number
  ts: number
  event: UIEvent
}
```

(`UIEvent` is imported from `./ui` — add it to the existing import if not present.)

- [ ] **Step 6: Run the store test + typecheck + format + commit**

```bash
find . -name "*.tsbuildinfo" -delete
npm --prefix apps/desktop test -- store.test
npm --prefix apps/desktop run typecheck
npx biome check --write apps/desktop/src/service/conversation/store.ts packages/protocol/src/types/task.ts apps/desktop/src/service/conversation/store.test.ts
git add apps/desktop/src/service/conversation/store.ts packages/protocol/src/types/task.ts apps/desktop/src/service/conversation/store.test.ts
git commit -m "feat(store): add run_events table + appendRunEvent/getRunEvents (UIEvent-shaped)"
```

---

### Task 2: `makeRunEmit` (full lifecycle) + conversation emits `task.created`

**Files:**
- Modify: `apps/desktop/src/service/session/manager.ts` (`makeConversationEmit` ~`:308`; `submitGoal` conversation path ~`:951`).
- Test: `apps/desktop/src/service/session/manager.test.ts`.

**Interfaces:**
- Produces: `makeRunEmit(sessionId, runId, parentRunId?)` that persists every emitted event as a UIEvent to `run_events`. Conversation turns emit `task.created` then run with `makeRunEmit`.

**Note:** This task does NOT yet touch work/spawn/cron (they still use `makeEmit` → `task_events`; Task 3 tees them into `run_events`). Conversation turns stop writing `conversation_events` (they write `run_events`); the old `conversation_events` table + `makeConversationEmit` are removed here.

- [ ] **Step 1: Write the failing manager test**

In `manager.test.ts`:

```ts
it('a conversation turn writes task.created + a terminal event to run_events', async () => {
  mockCreate.mockImplementation(() => runner(vi.fn().mockResolvedValue(runnerReturn('completed', 'hi'))))
  const store = createConversationStore(dbPath)
  const manager = createSessionManager({ store, broadcaster: createBroadcaster(), maxConcurrent: 1, getProvider: () => undefined })
  const { sessionId } = manager.createSession(providerA)
  manager.submitGoal(sessionId, '你好')
  await flush()
  const rows = store.getRunEvents(sessionId)
  // task.created (with the goal) + at least one progress + task.complete all persist.
  expect(rows.some((r) => (r.event as { kind?: string }).kind === 'task.created')).toBe(true)
  expect(rows.some((r) => (r.event as { kind?: string }).kind === 'task.complete')).toBe(true)
  const created = rows.find((r) => (r.event as { kind?: string }).kind === 'task.created')?.event as { goal?: string }
  expect(created?.goal).toBe('你好')
  store.close()
})
```

(`flush`, `mockCreate`, `runner`, `runnerReturn`, `providerA`, `createConversationStore`, `dbPath`, `createBroadcaster` are the existing manager.test fixtures.)

- [ ] **Step 2: Run to verify it fails**

Run: `npm --prefix apps/desktop test -- manager.test`
Expected: FAIL — no `task.created`/`task.complete` rows (3a's `makeConversationEmit` persisted only `task.progress`).

- [ ] **Step 3: Replace `makeConversationEmit` with `makeRunEmit`**

In `manager.ts`, replace the `makeConversationEmit` definition (~line 308) with:

```ts
// Emit wrapper for a run (conversation/work/spawn). Persists the FULL lifecycle
// to run_events as UIEvents (so replayed runs reach terminal status), stamps the
// shared seq, and tags the wire event with taskId: runId so the renderer's
// applyEvent (keyed by taskId) picks it up live.
const makeRunEmit =
  (sessionId: string, runId: string, parentRunId: string | null = null) =>
  (event: string, data: unknown): void => {
    const obj = data && typeof data === 'object' ? (data as Record<string, unknown>) : undefined
    const seq = seqCounter.nextSeq(sessionId)
    const ts = Date.now()
    if (obj?.event && typeof obj.event === 'object') (obj.event as { seq?: number }).seq = seq
    const uiEvent = { kind: event, ...(obj ?? {}), sessionId, taskId: runId, seq, ts } as import('@swarm/protocol').UIEvent
    store.appendRunEvent(sessionId, runId, parentRunId, uiEvent)
    broadcaster.broadcast(event, { ...(obj ?? {}), sessionId, taskId: runId, seq, ts })
  }
```

Update the call site in `submitGoal` (~line 1012, was `emit: makeConversationEmit(sessionId, turnId)`) to `emit: makeRunEmit(sessionId, turnId)`, and the user-message emit + error emit (~lines 969, 1038) to use `makeRunEmit(sessionId, turnId)`.

- [ ] **Step 4: Conversation emits `task.created` at turn submit**

In `submitGoal` (~line 969, right before/after the user-message `task.progress` emit), emit `task.created` so the run-record is created with the goal + agentDefId:

```ts
makeRunEmit(sessionId, turnId)('task.created', {
  taskId: turnId,
  goal,
  attachments,
  agentDefId: agentDef.id,
})
```

(Remove the now-redundant user-message `task.progress` emit ONLY if Phase-2's user-message-as-real-event test still passes — keep it; `task.created` carries the goal for the run-record, the `task.progress` user message still renders the user bubble via `taskSegments`.)

- [ ] **Step 5: Update `seq-counter.ts` + remove `makeConversationEmit`**

`seq-counter.ts` (~line 256 in manager) initializes from `store.getSessionTasks` + `store.getConversationEvents`. Add `store.getRunEvents` as a third source (count run_events seqs too). Then delete the `makeConversationEmit` definition entirely (no callers remain). The `appendConversationEvent`/`getConversationEvents` store methods become unused by the manager — leave them on the store for now (4b drops them with the table); remove the import if now unused.

- [ ] **Step 6: Run manager tests + typecheck + format + commit**

```bash
find . -name "*.tsbuildinfo" -delete
npm --prefix apps/desktop test -- manager.test
npm --prefix apps/desktop run typecheck
npx biome check --write apps/desktop/src/service/session/manager.ts apps/desktop/src/service/session/seq-counter.ts apps/desktop/src/service/session/manager.test.ts
git add apps/desktop/src/service/session/manager.ts apps/desktop/src/service/session/seq-counter.ts apps/desktop/src/service/session/manager.test.ts
git commit -m "feat(session): makeRunEmit persists full lifecycle; conversation emits task.created"
```

---

### Task 3: Work/spawn/cron/resident/gmail tee into `run_events` (dual-write)

**Files:**
- Modify: `apps/desktop/src/service/session/manager.ts` (`makeEmit` ~`:260`; `runResident` deps ~`:453`; cron-fired path; gmail analyze already uses a one-shot runner).
- Test: `apps/desktop/src/service/session/manager.test.ts`.

**Interfaces:**
- Produces: every run (not just conversation) writes its full lifecycle to `run_events`. The existing `task_events` writes (for `wait_for_task`/listener/cron) are unchanged.

- [ ] **Step 1: Write the failing test (work task dual-writes run_events)**

```ts
it('a create_task work run writes its full lifecycle to run_events (dual-write)', async () => {
  mockCreate.mockImplementation(() => runner(vi.fn().mockResolvedValue(runnerReturn('completed', 'built it'))))
  const store = createConversationStore(dbPath)
  const manager = createSessionManager({ store, broadcaster: createBroadcaster(), maxConcurrent: 2, getProvider: () => undefined })
  const { sessionId } = manager.createSession(providerA)
  const out = await (manager as unknown as { __runWorkTaskForTest: (s: string, g: string) => Promise<{ taskId: string }> }).__runWorkTaskForTest(sessionId, 'build feature X')
  await flush()
  const rows = store.getRunEvents(sessionId).filter((r) => r.runId === out.taskId)
  expect(rows.some((r) => (r.event as { kind?: string }).kind === 'task.created')).toBe(true)
  expect(rows.some((r) => (r.event as { kind?: string }).kind === 'task.complete')).toBe(true)
  // task_events still written too (wait_for_task/listener consumers).
  const task = store.getSessionTasks(sessionId).find((t) => t.id === out.taskId)
  expect(task).toBeDefined()
  store.close()
})
```

- [ ] **Step 2: Run to verify it fails**

Run: `npm --prefix apps/desktop test -- manager.test`
Expected: FAIL — work runs write `task_events` but not `run_events`.

- [ ] **Step 3: Tee `makeEmit` into `run_events`**

`makeEmit` (~line 260) is the emit for work/spawn (keyed by `taskId`). Add a `run_events` write alongside each persist. The cleanest: at the TOP of `makeEmit` (after seq/ts are computed), tee every event to `run_events`. Since `makeEmit` is keyed by the task whose `id` IS the runId, and the parent (for spawns) is the task's `parentId`, persist:

In `makeEmit`, after `const ts = Date.now()` and the seq-stamping, add (for the `taskId` branch — `makeEmit` is per-session, keyed by the event's `taskId`):

```ts
// Dual-write: tee the full lifecycle into run_events (the renderer's source).
// parentRunId = the task's parentId if it's a spawned child, else null. Look it
// up from the just-built obj.parentTaskId (task.created carries it) or remember
// it per runId via a small map; simplest: read from obj.parentTaskId when present
// and otherwise null (subsequent events for the same runId don't restate it, but
// parentRunId is only needed at task.created for the renderer to nest the block).
if (taskId) {
  const parentRunId = (obj?.parentTaskId as string | undefined) ?? null
  store.appendRunEvent(sessionId, taskId, parentRunId, { kind: event, ...(obj ?? {}), sessionId, taskId, seq, ts } as import('@swarm/protocol').UIEvent)
}
```

(Place this inside `makeEmit` so it runs for every event that has a `taskId`. The `parentRunId` is carried by `task.created`'s `parentTaskId`; for later events it's `null`, which is fine — the renderer nests the block from the `task.created` event it already saw.)

- [ ] **Step 4: Resident + cron-fired + gmail paths use the same tee**

`runResident` (manager ~`:453`) and cron-fired runs construct their own `createAgentRunner` deps with `emit: makeEmit(sessionId)` (or similar) — they already go through `makeEmit`, so the tee in Step 3 covers them. Verify by grep that every `createAgentRunner` call site in `manager.ts` passes `emit: makeEmit(sessionId)` (the conversation one is `makeRunEmit`; all others are `makeEmit`). Gmail analyze (`gmail/analyze.ts`) uses its own emit — if it passes `emit: () => undefined` (a one-shot silent run), it does NOT tee; that's fine (gmail analyze is a tool-internal sub-run, not a rendered run — it surfaces via its tool result). No change needed there; note it.

- [ ] **Step 5: Run tests + typecheck + format + commit**

```bash
find . -name "*.tsbuildinfo" -delete
npm --prefix apps/desktop test -- manager.test
npm --prefix apps/desktop run typecheck
npx biome check --write apps/desktop/src/service/session/manager.ts apps/desktop/src/service/session/manager.test.ts
git add apps/desktop/src/service/session/manager.ts apps/desktop/src/service/session/manager.test.ts
git commit -m "feat(session): tee work/spawn/cron/resident lifecycle into run_events (dual-write)"
```

---

### Task 4: IPC `getRunEvents`

**Files:**
- Modify: `apps/desktop/src/service/ipc/dispatcher.ts` (add case ~`:83`).
- Modify: `apps/desktop/src/main/ipc/swarm-ipc.ts` (add handler ~`:163`; register ~`:249`; dispose ~`:378`).
- Modify: `apps/desktop/src/preload/index.ts` (add `getRunEvents` ~`:305`).
- Modify: `packages/protocol/src/service-client.ts` (add method ~`:43` + impl ~`:155`).
- Modify: `apps/desktop/src/renderer/src/lib/api.ts` (add `getRunEvents` ~`:51`).
- Test: none new (covered by the renderer integration in Task 6).

**Interfaces:**
- Produces: `swarmApi.getRunEvents(sessionId): Promise<RunEvent[]>` end-to-end (preload → main IPC → service-client → dispatcher → `manager.getRunEvents`).

- [ ] **Step 1: Service-side method + dispatcher case**

In `manager.ts`, alongside `getConversationEvents` (~line 131), add to the returned manager object:

```ts
getRunEvents(sessionId: string): import('@swarm/protocol').RunEvent[] {
  return store.getRunEvents(sessionId)
},
```

In `dispatcher.ts` (~line 83, after `getConversationEvents`), add:

```ts
case 'getRunEvents': {
  const [sessionId] = args as [string]
  return manager.getRunEvents(sessionId)
}
```

- [ ] **Step 2: Service-client method**

In `packages/protocol/src/service-client.ts` (~line 43, after `getConversationEvents`), add the type entry:

```ts
getRunEvents(sessionId: string): Promise<import('./types/task').RunEvent[]>
```

and the impl (~line 155):

```ts
getRunEvents(sessionId) {
  return call('getRunEvents', [sessionId])
},
```

- [ ] **Step 3: Main IPC handler + preload + renderer api**

In `swarm-ipc.ts` (~line 163), add:

```ts
const getRunEvents = (_e: Electron.IpcMainInvokeEvent, sessionId: string) =>
  serviceClient.getRunEvents(sessionId)
```

Register (~line 249): `ipcMain.handle('swarm:getRunEvents', getRunEvents)`. Dispose (~line 378): `ipcMain.removeHandler('swarm:getRunEvents')`.

In `preload/index.ts` (~line 307, after `getConversationEvents`), add:

```ts
getRunEvents: (sessionId: string) =>
  ipcRenderer.invoke('swarm:getRunEvents', sessionId) as Promise<import('@swarm/protocol').RunEvent[]>,
```

In `renderer/src/lib/api.ts` (~line 52, after `getConversationEvents`), add:

```ts
getRunEvents: (sessionId: string): Promise<import('@swarm/protocol').RunEvent[]> =>
  window.swarm.sessions.getRunEvents(sessionId),
```

- [ ] **Step 4: Typecheck + format + commit**

```bash
find . -name "*.tsbuildinfo" -delete
npm --prefix apps/desktop run typecheck
npx biome check --write apps/desktop/src/service/ipc/dispatcher.ts apps/desktop/src/main/ipc/swarm-ipc.ts apps/desktop/src/preload/index.ts packages/protocol/src/service-client.ts apps/desktop/src/renderer/src/lib/api.ts apps/desktop/src/service/session/manager.ts
git add -A apps/desktop/src/service/ipc/dispatcher.ts apps/desktop/src/main/ipc/swarm-ipc.ts apps/desktop/src/preload/index.ts packages/protocol/src/service-client.ts apps/desktop/src/renderer/src/lib/api.ts apps/desktop/src/service/session/manager.ts
git commit -m "feat(ipc): add getRunEvents end-to-end"
```

---

### Task 5: `TaskRecord` → `RunRecord` rename (mechanical sweep)

**Files:**
- Modify: `apps/desktop/src/shared/lib/apply-event.ts` (type rename `:5`, `setStatus` `:27`, `applyEvent` `:31`).
- Modify: every `TaskRecord` caller — `grep -rn "TaskRecord" apps/desktop/src` (~59 sites: `task-list.tsx`, `use-events-subscription.ts`, `build-timeline-items.ts`, `composer-turns.ts`, `task-transcript.tsx`, `conversation-thread.tsx`, `conversation-minimap.tsx`, `minimap-items.ts`, `replay.ts`, `use-tasks.ts`, `scheduled-rows.ts`, `tasks-view.tsx`, etc.).
- Test: existing renderer tests (rename-only; no behavior change).

**Interfaces:**
- Produces: `RunRecord` (was `TaskRecord`) — same shape, same fields (incl. `parentTaskId` — kept as-is, mirrors `UIEvent.task.created.parentTaskId`). No behavior change.

**Note:** Pure rename. `applyEvent`'s logic is unchanged (it already keys by `taskId`/runId and handles the full lifecycle). The `isConversation` field stays for now (dropped in Task 6). Do NOT rename `parentTaskId` (it mirrors the wire field).

- [ ] **Step 1: Rename the type + its self-references**

In `apply-event.ts`, rename `export type TaskRecord = {...}` → `export type RunRecord = {...}`, and the `setStatus(task: TaskRecord, ...)` / `applyEvent(tasks: TaskRecord[], ...): TaskRecord[]` / stub/created/updated locals → `RunRecord`.

- [ ] **Step 2: Sweep all callers**

```bash
grep -rln "TaskRecord" apps/desktop/src
```

For each file, rename `TaskRecord` → `RunRecord` (type references + imports). The import `import type { TaskRecord } from '@shared/lib/apply-event'` → `import type { RunRecord } from '@shared/lib/apply-event'`. (Use `replace-all` per file; the symbol is unique.)

- [ ] **Step 3: Typecheck + run a renderer test + format + commit**

```bash
find . -name "*.tsbuildinfo" -delete
npm --prefix apps/desktop run typecheck
npm --prefix apps/desktop test -- apply-event build-timeline composer-turns
npx biome check --write $(grep -rln "RunRecord" apps/desktop/src)
git add $(grep -rln "RunRecord" apps/desktop/src)
git commit -m "refactor(renderer): rename TaskRecord -> RunRecord"
```

---

### Task 6: Renderer replays from `run_events` via `applyEvent`; drop the adapter

**Files:**
- Modify: `apps/desktop/src/renderer/src/lib/replay.ts` (delete `conversationTurnsToRecords` + `tasksToRecords`; keep `STORED_TO_UI_STATUS` only if still referenced — it won't be).
- Modify: `apps/desktop/src/renderer/src/hooks/use-tasks.ts` (`hydrateSession` reads `getRunEvents` + reduces via `applyEvent`).
- Modify: `apps/desktop/src/shared/lib/apply-event.ts` (drop the `isConversation` field).
- Test: `apps/desktop/src/renderer/src/hooks/use-tasks.test.tsx`, `apps/desktop/src/renderer/src/lib/replay.test.ts`, `apps/desktop/src/shared/lib/apply-event.test.ts`.

**Interfaces:**
- Produces: replay = `getRunEvents → UIEvent[] → reduce(applyEvent, []) → RunRecord[]`. The adapter (`conversationTurnsToRecords`, `tasksToRecords`) and `isConversation` are gone.

- [ ] **Step 1: Write the failing hydrate test**

In `use-tasks.test.tsx` (mirror the existing hydrate test shape):

```ts
it('hydrateSession replays run_events into RunRecords via applyEvent', async () => {
  const rows: import('@swarm/protocol').RunEvent[] = [
    { runId: 'r1', parentRunId: null, seq: 1, ts: 1, event: { kind: 'task.created', sessionId: 's', taskId: 'r1', goal: 'hi', ts: 1, seq: 1 } },
    { runId: 'r1', parentRunId: null, seq: 2, ts: 2, event: { kind: 'task.complete', sessionId: 's', taskId: 'r1', summary: 'done', ts: 2, seq: 2 } },
  ]
  // stub swarmApi.getRunEvents to return rows; call hydrateSession; assert the cache has one RunRecord r1 with status 'completed' and goal 'hi'.
  const qc = /* existing queryClient fixture */
  swarmApi.getRunEvents = vi.fn().mockResolvedValue(rows) as never
  await hydrateSession(qc, 's')
  const records = qc.getQueryData<RunRecord[]>(RUNS_KEY) ?? []
  expect(records.find((r) => r.id === 'r1')?.status).toBe('completed')
  expect(records.find((r) => r.id === 'r1')?.goal).toBe('hi')
})
```

(`RUNS_KEY` is added in Step 2; import it. Adjust the fixture to the file's existing pattern.)

- [ ] **Step 2: Run to verify it fails**

Run: `npm --prefix apps/desktop test -- use-tasks`
Expected: FAIL — `hydrateSession` still reads `getConversationEvents`/`getSessionTasks`, not `getRunEvents`.

- [ ] **Step 3: Rewrite `hydrateSession` to replay via `applyEvent`**

In `use-tasks.ts`, replace `TASKS_KEY` → `RUNS_KEY` (rename the const) and rewrite `hydrateSession`:

```ts
import { applyEvent, type RunRecord } from '@shared/lib/apply-event'
import type { RunEvent } from '@swarm/protocol'

export const RUNS_KEY = ['tasks'] as const // keep the same cache key so live + replay merge; rename the symbol

/** Replay a session's run_events into RunRecords by reducing UIEvents through applyEvent. */
export async function hydrateSession(qc: ReturnType<typeof useQueryClient>, sessionId: string): Promise<void> {
  const rows = await swarmApi.getRunEvents(sessionId)
  const ordered = [...rows].sort((a, b) => a.seq - b.seq)
  const records = ordered.reduce<RunRecord[]>((acc, r) => applyEvent(acc, r.event), [])
  qc.setQueryData<RunRecord[]>(RUNS_KEY, (prev = []) => {
    const known = new Set(prev.map((t) => t.id))
    const fresh = records.filter((r) => !known.has(r.id))
    return [...fresh, ...prev]
  })
}
```

Drop the `conversationTurnsToRecords`/`tasksToRecords` imports from `use-tasks.ts`.

- [ ] **Step 4: Delete the adapter functions + `isConversation`**

In `replay.ts`, delete `conversationTurnsToRecords` and `tasksToRecords` (and `STORED_TO_UI_STATUS` if now unused — grep confirms). The file may become near-empty (keep it only if other exports remain; otherwise delete it and remove the import everywhere).

In `apply-event.ts`, delete the `isConversation?: boolean` field from `RunRecord`. (The `tasks-view.tsx` `isConversation` guard on `planGroups`/`verifyGroups` — verifyGroups is already gone (3b); the planGroups guard referenced it — drop the guard too, since run-events-sourced records never carry a stale plan.)

In `tasks-view.tsx`, drop any `!t.isConversation` filter (the field is gone). `planGroups` filters top-level runs with `plan` — unchanged otherwise.

- [ ] **Step 5: Run renderer tests + typecheck + format + commit**

```bash
find . -name "*.tsbuildinfo" -delete
npm --prefix apps/desktop test -- use-tasks apply-event replay tasks-view
npm --prefix apps/desktop run typecheck
npx biome check --write apps/desktop/src/renderer/src/hooks/use-tasks.ts apps/desktop/src/renderer/src/lib/replay.ts apps/desktop/src/shared/lib/apply-event.ts apps/desktop/src/renderer/src/components/views/tasks-view.tsx apps/desktop/src/renderer/src/hooks/use-tasks.test.tsx
git add -A apps/desktop/src/renderer/src/hooks/use-tasks.ts apps/desktop/src/renderer/src/lib/replay.ts apps/desktop/src/shared/lib/apply-event.ts apps/desktop/src/renderer/src/components/views/tasks-view.tsx apps/desktop/src/renderer/src/hooks/use-tasks.test.tsx
git commit -m "refactor(renderer): replay run_events via applyEvent; drop adapter + isConversation"
```

---

### Task 7: e2e + full suite + smoke

**Files:**
- Add: `apps/desktop/src/service/e2e/unified-runs.e2e.test.ts`. Adapt any existing e2e that asserted `getConversationEvents`/`getSessionTasks` shapes.

- [ ] **Step 1: Write the e2e**

```ts
it('a work run + conversation turn both replay to terminal status from run_events', async () => {
  const store = createConversationStore(tmpDb())
  const manager = createManagerWithStubbedRunner({ store, reply: 'done' })
  const { sessionId } = manager.createSession(providerA)

  manager.submitGoal(sessionId, '你好')
  await flush()
  const work = await (manager as unknown as { __runWorkTaskForTest: (s: string, g: string) => Promise<{ taskId: string }> }).__runWorkTaskForTest(sessionId, 'build it')
  await flush()

  const rows = store.getRunEvents(sessionId)
  // Both runs reached a terminal event in run_events.
  const term = (r: { event: { kind?: string } }) => (r.event.kind === 'task.complete' || r.event.kind === 'task.error')
  expect(rows.filter((r) => r.runId !== work.taskId).some(term)).toBe(true) // conversation
  expect(rows.filter((r) => r.runId === work.taskId).some(term)).toBe(true) // work
  // task_events still written for the work run (dual-write; wait_for_task/listener).
  expect(store.getSessionTasks(sessionId).find((t) => t.id === work.taskId)).toBeDefined()
  store.close()
})
```

(`createManagerWithStubbedRunner`, `flush`, `providerA`, `tmpDb` mirror the existing e2e scaffolding.)

- [ ] **Step 2: Run the full suite**

Run: `npm --prefix apps/desktop test`
Expected: PASS (modulo the known `gmail.test` htmlBody + `host.test` EADDRINUSE :47777).

- [ ] **Step 3: Format + commit**

```bash
npx biome check --write apps/desktop/src/service/e2e/unified-runs.e2e.test.ts
git add apps/desktop/src/service/e2e/unified-runs.e2e.test.ts
git commit -m "test(e2e): run_events is the replay source; work runs dual-write task_events"
```

- [ ] **Step 4: Manual smoke**

`pnpm dev` (quit any running instance first — single-instance lock). With a configured provider:
- Send "你好" → direct reply; on session switch away + back, the turn replays to **completed** (not stuck running).
- Send a substantial goal the agent turns into `create_task` → the work run renders inline + plan panel; replays to completed.
- Run a CEO delegation ("在 /tmp 建个 demo 项目") → sub-agent blocks render via `parentTaskId`; replays correctly.
- A `wait_for_task` dependent on a work run still resolves (Task table intact).
Record outcomes; do not commit.

- [ ] **Step 5: Integrate to develop**

```bash
git rebase develop
git checkout develop
git merge --ff-only worktree-phase4a-unified-runs
```

---

## Self-Review

**Spec coverage:**
- §4.1 run_events table (fresh, UIEvent-shaped) → Task 1. (Refinement: fresh table, not rename — noted in the Architecture block.) ✓
- §5.1 makeRunEmit full lifecycle + conversation task.created → Task 2. ✓
- §5.1 work/spawn/cron/resident tee into run_events → Task 3. ✓
- §5.2 store appendRunEvent/getRunEvents → Task 1. ✓
- §5.3 IPC getRunEvents → Task 4. ✓
- §5.4 renderer RunRecord derived from run_events → Tasks 5 (rename) + 6 (replay via applyEvent; drop adapter + isConversation). (Refinement: replay via `applyEvent` over UIEvents, no `runEventsToRecords` — noted.) ✓
- §7 invariants (run_events is the only rendering source; full lifecycle persists; Task/task_events retained + dual-written; no wire change) → Tasks 1-6. ✓
- §10 test strategy (store/manager/renderer/e2e) → every task gate + Task 7. ✓
- §11 verification (npm test, biome, typecheck, smoke) → every task + Task 7. ✓
- §13 forward pointers (4b: drop Task table + migrate cron/waiters + merge + 3c) — explicitly out of scope; no task touches them. ✓

**Placeholder scan:** No "TBD"/"implement later". Deletion steps name exact symbols; replacement code (makeRunEmit, the tee, hydrateSession replay) is shown in full. The grep-driven sweeps (Task 5 rename; Task 6 adapter deletion) give the authoritative grep + the exact target names.

**Type consistency:** `RunEvent` (Task 1) is used in `swarmApi.getRunEvents` (Task 4) + `hydrateSession` (Task 6). `RunRecord` (Task 5) is used in `hydrateSession` (Task 6) + across the renderer. `appendRunEvent(sessionId, runId, parentRunId, uiEvent)` (Task 1) matches the `makeRunEmit`/tee call sites (Tasks 2-3). `parentRunId` (DB column / store API) maps to `parentTaskId` on the UIEvent/RunRecord (the wire field name is kept).

**Green-at-each-commit check:** Task 1 additive (new table/API). Task 2 swaps conversation onto run_events (conversation_events becomes dead-written but retained). Task 3 adds the dual-write tee. Task 4 adds IPC (additive). Task 5 is a pure rename. Task 6 is the renderer cutover (run_events now has all data from Tasks 2-3). Task 7 e2e. The renderer reads run_events only after Task 6; until then it still reads the old tables (adapter intact), so the tree stays green throughout.

**One risk noted:** Task 6's cutover is the largest renderer edit (delete the adapter + replay via applyEvent + drop isConversation). The pre-existing `replay.test.ts`/`use-tasks.test.tsx`/`apply-event.test.ts` fixtures assert the OLD adapter shape — Task 6 step 1 rewrites the hydrate test; the plan should budget for updating the sibling replay/apply-event tests too (run the filtered suite before committing). If `replay.ts` becomes empty after deleting the two functions, delete the file and remove its imports.
