# Phase 3a — Conversation Off Task (Implementation Plan)

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Take conversation off the Task execution unit — a conversation turn becomes a single-shot agent run with no `Task` row and no verify loop, its events on a session-level stream; real work is agent-authored via a new `create_task` tool. Fixes "every message creates a task."

**Architecture:** Layered, app stays green at each commit. (1) Add session-level `conversation_events` storage + shared seq. (2) Add `create_task` (extract `runWorkTask` from `submitGoal`) — dormant while `submitGoal` still uses the old task path. (3) Add the transcript adapter that renders conversation events as pseudo-`TaskRecord`s. (4) Flip `submitGoal` to the conversation path — the cutover that fixes the bug. (5) Cancel/usage polish. (6) e2e + smoke. Runner code is unchanged (Phase 1 already decoupled it; its single-shot path already exists).

**Tech Stack:** TypeScript, `vitest`, `better-sqlite3`, Electron (test runner), `@swarm/protocol`, `@earendil-works/pi-agent-core`.

## Global Constraints

- **Spec:** `docs/superpowers/specs/2026-07-03-conversation-off-task-design.md` (authoritative).
- **Run tests via `npm test`** (Electron node runner). NEVER bare `npx vitest`, NEVER `pnpm rebuild better-sqlite3` (breaks app ABI; restore with `npm run postinstall`). Single-file: `npm --prefix apps/desktop test -- <filter>`.
- **Behavior must stay green at every commit** (full suite, modulo the known environmental `host.test` EADDRINUSE on port 47777 when the desktop app is running — unrelated).
- **Comments and commit messages in English.**
- **Scoped formatting:** `npx biome check --write <file>` (the repo's `pnpm check`/`format` rewrite the whole tree).
- **Pre-commit in a worktree** needs `node_modules` symlinked to the main checkout: `ln -s /Users/gaozimeng/Learn/macOS/SwarmAgents/node_modules node_modules`.
- **One commit per task**, on the impl branch. Integrate to `develop` via `git rebase develop` + `git merge --ff-only`.
- **Implement on a new worktree** `worktree-conversation-off-task` off `develop` (after spec+plan are merged to `develop`). Do NOT implement in `worktree-runner-task-decouple`.

## File Structure

- **Modify** `apps/desktop/src/service/conversation/store.ts` — new `conversation_events` table, `appendConversationEvent`, `getConversationEvents`; extend `getUsageStats`/delete cascade for the new table.
- **Modify** `apps/desktop/src/service/session/manager.ts` — extract `runWorkTask`; rewrite `submitGoal` to the conversation path; add `makeConversationEmit`; wire `createTask` dep; cancel-by-turnId; session-level usage.
- **Modify** `apps/desktop/src/service/session/seq-counter.ts` — init from both `task.history` and `conversation_events`.
- **Modify** `apps/desktop/src/service/session/seq-counter.test.ts` — cover the two-source init.
- **Create** `apps/desktop/src/service/tools/create-task.ts` — the `create_task` tool spec (mirrors `spawn.ts`).
- **Modify** `apps/desktop/src/service/tools/builtins.ts` (or the registry entry point) — register `create_task`.
- **Modify** `apps/desktop/src/service/tools/registry.ts` — add `createTask?: (...) => ...` to `ToolRunContext`.
- **Modify** `apps/desktop/src/service/session/agent-runner.ts` — add optional `createTask?` to `AgentRunnerDeps`; wire into `buildToolContext`.
- **Modify** `apps/desktop/src/renderer/src/lib/replay.ts` — add `conversationTurnsToRecords`.
- **Modify** `apps/desktop/src/renderer/src/hooks/use-tasks.ts` — `hydrateSession`/`useTasks` merge conversation turns.
- **Modify** `apps/desktop/src/shared/lib/apply-event.ts` — handle turn-keyed conversation events (live + replay).
- **Modify** `apps/desktop/src/conversation/store.test.ts`, `manager.test.ts`, `replay.test.ts`, `apply-event.test.ts`, `use-tasks.test.tsx` — tests.

---

### Task 1: Session-level conversation event storage + shared seq

**Files:**
- Modify: `apps/desktop/src/service/conversation/store.ts` (schema ~`:132-240`; add methods near `appendTaskEvent` ~`:74`, `:524-526`).
- Modify: `apps/desktop/src/service/session/seq-counter.ts`.
- Test: `apps/desktop/src/service/conversation/store.test.ts`, `apps/desktop/src/service/session/seq-counter.test.ts`.

**Interfaces:**
- Produces: `ConversationStore.appendConversationEvent(sessionId, turnId, event)` and `getConversationEvents(sessionId): { turnId, seq, ts, event }[]`; `createSeqCounter` now inits from both tasks and conversation events.

- [ ] **Step 1: Add the table + statements (TDD — write the store test first)**

In `store.test.ts`, add:

```ts
it('appendConversationEvent persists and re-reads session conversation events', () => {
  const store = createConversationStore(tmpDb())
  const ev = { kind: 'llm.message', role: 'user', content: 'hi', ts: 1, seq: 1 }
  store.appendConversationEvent('s1', 'turn-1', ev as never)
  store.appendConversationEvent('s1', 'turn-1', { kind: 'llm.message', role: 'assistant', content: 'yo', ts: 2, seq: 2 } as never)
  store.appendConversationEvent('s1', 'turn-2', { kind: 'llm.message', role: 'user', content: 'again', ts: 3, seq: 3 } as never)
  const rows = store.getConversationEvents('s1')
  expect(rows).toHaveLength(3)
  expect(rows.map((r) => r.turnId)).toEqual(['turn-1', 'turn-1', 'turn-2'])
  expect(rows.map((r) => (r.event as { seq: number }).seq)).toEqual([1, 2, 3])
})
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `npm --prefix apps/desktop test -- store.test`
Expected: FAIL — `appendConversationEvent` is not a function.

- [ ] **Step 3: Add the schema + prepared statements**

In `store.ts`, inside the `CREATE TABLE` block (after `task_events`, ~line 176), add:

```sql
CREATE TABLE IF NOT EXISTS conversation_events (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  session_id TEXT NOT NULL,
  turn_id    TEXT NOT NULL,
  seq        INTEGER NOT NULL,
  ts         INTEGER NOT NULL,
  event      TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_conversation_events_session
  ON conversation_events(session_id, id);
```

Near the other prepared statements (~line 524), add:

```ts
const stmtInsertConversationEvent = db.prepare(
  'INSERT INTO conversation_events (session_id, turn_id, seq, ts, event) VALUES (?, ?, ?, ?, ?)'
)
const stmtGetConversationEvents = db.prepare(
  'SELECT turn_id AS turnId, seq, ts, event FROM conversation_events WHERE session_id = ? ORDER BY id'
)
```

- [ ] **Step 4: Add the interface entries + implementations**

In the `ConversationStore` type (~line 74), add:

```ts
appendConversationEvent(sessionId: string, turnId: string, event: import('@swarm/protocol').TaskEvent): void
getConversationEvents(sessionId: string): { turnId: string; seq: number; ts: number; event: import('@swarm/protocol').TaskEvent }[]
```

In the returned object (near `appendTaskEvent`'s impl), add:

```ts
appendConversationEvent: (sessionId, turnId, event) => {
  const seq = typeof (event as { seq?: number }).seq === 'number'
    ? (event as { seq: number }).seq
    : 0
  stmtInsertConversationEvent.run(sessionId, turnId, seq, event.ts ?? Date.now(), JSON.stringify(event))
},
getConversationEvents: (sessionId) =>
  (stmtGetConversationEvents.all(sessionId) as { turnId: string; seq: number; ts: number; event: string }[]).map((r) => ({
    turnId: r.turnId,
    seq: r.seq,
    ts: r.ts,
    event: JSON.parse(r.event) as import('@swarm/protocol').TaskEvent,
  })),
```

Also extend the delete cascade (~line 642) so session deletion cleans up:

```ts
db.prepare('DELETE FROM conversation_events WHERE session_id = ?').run(id)
```

- [ ] **Step 5: Run the store test to verify pass**

Run: `npm --prefix apps/desktop test -- store.test`
Expected: PASS.

- [ ] **Step 6: Extend the seq counter to init from both sources**

In `seq-counter.test.ts`, add:

```ts
it('inits the seq from both task history and conversation events', () => {
  // A session whose max task-event seq is 5 and max conversation-event seq is 9
  // must continue from 10 (the shared counter takes the max of both).
  const tasks = [{ history: [{ seq: 5 }] }] as never
  const conv = [{ seq: 9 }] as never
  const c = createSeqCounter(
    () => tasks,
    () => conv,
  )
  expect(c.nextSeq('s')).toBe(10)
})
```

Then update `seq-counter.ts`:

```ts
import type { Task, TaskEvent } from '@swarm/protocol'

export type ConversationEventRow = { seq: number }

export function createSeqCounter(
  getSessionTasks: (sessionId: string) => Task[],
  getConversationEvents: (sessionId: string) => ConversationEventRow[] = () => [],
): SeqCounter {
  const counters = new Map<string, number>()

  const initMax = (sessionId: string): number => {
    let max = 0
    for (const t of getSessionTasks(sessionId)) {
      for (const ev of t.history) {
        if (typeof ev.seq === 'number' && ev.seq > max) max = ev.seq
      }
    }
    for (const r of getConversationEvents(sessionId)) {
      if (typeof r.seq === 'number' && r.seq > max) max = r.seq
    }
    return max
  }

  return {
    nextSeq: (sessionId) => {
      if (!counters.has(sessionId)) counters.set(sessionId, initMax(sessionId))
      const n = (counters.get(sessionId) as number) + 1
      counters.set(sessionId, n)
      return n
    },
  }
}
```

- [ ] **Step 7: Wire the new arg in `manager.ts` (no behavior change yet)**

In `manager.ts` where `createSeqCounter` is constructed (~line 248):

```ts
const seqCounter = createSeqCounter(
  (sid: string) => store.getSessionTasks(sid),
  (sid: string) => store.getConversationEvents(sid),
)
```

- [ ] **Step 8: Run tests + format + commit**

Run: `npm --prefix apps/desktop test -- seq-counter store.test`
Expected: PASS.

```bash
npx biome check --write apps/desktop/src/service/conversation/store.ts apps/desktop/src/service/session/seq-counter.ts apps/desktop/src/service/session/manager.ts apps/desktop/src/service/conversation/store.test.ts apps/desktop/src/service/session/seq-counter.test.ts
git add apps/desktop/src/service/conversation/store.ts apps/desktop/src/service/session/seq-counter.ts apps/desktop/src/service/session/manager.ts apps/desktop/src/service/conversation/store.test.ts apps/desktop/src/service/session/seq-counter.test.ts
git commit -m "feat(store): add session-level conversation_events storage + shared seq"
```

---

### Task 2: `runWorkTask` + `create_task` tool (dormant)

**Files:**
- Modify: `apps/desktop/src/service/session/manager.ts` (extract `runWorkTask` from `submitGoal`'s new-task path ~`:820-957`).
- Create: `apps/desktop/src/service/tools/create-task.ts`.
- Modify: `apps/desktop/src/service/tools/builtins.ts` (register), `apps/desktop/src/service/tools/registry.ts` (`ToolRunContext.createTask`), `apps/desktop/src/service/session/agent-runner.ts` (`AgentRunnerDeps.createTask` + `buildToolContext`).
- Test: `apps/desktop/src/service/session/manager.test.ts`, `apps/desktop/src/service/tools/create-task.test.ts` (new).

**Interfaces:**
- Produces: `manager.runWorkTask(sessionId, goal, criteria?)` — creates a top-level work Task, runs the verify runner, returns `{ taskId, result }`; `AgentRunnerDeps.createTask?` and `ToolRunContext.createTask?`; the `create_task` tool.

**Note:** `submitGoal` is unchanged in this task — it still creates a task the old way. `create_task` is wired but unused by the agent until its prompt encourages it. This keeps the app green.

- [ ] **Step 1: Write the failing manager test**

In `manager.test.ts`:

```ts
it('runWorkTask creates a top-level work task and runs the verify runner', async () => {
  const seen: { max: number }[] = []
  mockCreate.mockImplementation((deps) => {
    seen.push({ max: deps.maxVerifyRounds ?? -1 })
    return runner(vi.fn().mockResolvedValue(runnerReturn('completed', 'done')))
  })
  const store = createConversationStore(dbPath)
  const broadcaster = createBroadcaster()
  const manager = createSessionManager({ store, broadcaster, maxConcurrent: 2, getProvider: () => undefined })
  const { sessionId } = manager.createSession(providerA)

  // Access the internal runWorkTask via the test hook we expose (see step 3).
  const out = await (manager as unknown as { __runWorkTaskForTest: (sid: string, goal: string) => Promise<{ taskId: string; result: { summary: string } }> }).__runWorkTaskForTest(sessionId, 'build feature X')
  expect(out.taskId).toMatch(/^[0-9A-Z]{26}$/)
  expect(out.result.summary).toBe('done')
  // The work task runs the verify loop (maxVerifyRounds > 0), not single-shot.
  expect(seen.some((s) => s.max > 0)).toBe(true)
  // A Task row was persisted with parentId null.
  const task = store.getSessionTasks(sessionId).find((t) => t.id === out.taskId)
  expect(task).toBeDefined()
  expect(task?.parentId).toBeNull()
  store.close()
})
```

- [ ] **Step 2: Run to verify it fails**

Run: `npm --prefix apps/desktop test -- manager.test`
Expected: FAIL — `__runWorkTaskForTest` is undefined.

- [ ] **Step 3: Extract `runWorkTask` from `submitGoal`**

In `manager.ts`, factor the new-task creation+run out of `submitGoal` into a module-private function. `submitGoal`'s `else` branch continues to call the same logic (behavior unchanged). Add the function:

```ts
// Create a top-level work Task (parentId null) and run the verify runner. Used by
// create_task (agent-authored work) and — until the conversation cutover — by
// submitGoal's legacy new-task path.
const runWorkTask = async (
  sessionId: string,
  goal: string,
  attachments: import('@swarm/protocol').Attachment[] = [],
  options: import('@swarm/protocol').TaskOptions = {},
  agentDefOverride?: AgentDefinition,
): Promise<{ taskId: string; result: TaskResult }> => {
  const session = sessions.get(sessionId)
  if (!session) throw new Error(`session ${sessionId} not found`)
  const agentDef = agentDefOverride ?? resolveAgentDef(sessionId, options)
  const task = buildWorkTask(sessionId, goal, attachments, options, agentDef) // the existing new-task object literal (~:831-852), parentId null
  store.saveTask(task, sessionId)
  broadcaster.broadcast('task.created', { sessionId, taskId: task.id, goal, attachments, ts: Date.now() })
  return { taskId: task.id, result: await runTaskQueueTurn(sessionId, task, agentDef) }
}
```

(`runTaskQueueTurn` is the existing queue+pump+run closure body from `submitGoal` — extract the `runTurn` async fn + enqueue/pump into a reusable helper that takes the already-built `task` and `agentDef`. `resolveAgentDef` and `buildWorkTask` are similarly factored from the existing `submitGoal` code; their bodies are the lines that today compute `agentDef` and the `task` literal.)

Wire the test hook near the other `__`-prefixed hooks on the returned manager object:

```ts
__runWorkTaskForTest: (sid: string, goal: string) => runWorkTask(sid, goal),
```

Refactor `submitGoal`'s new-task `else` branch to call the same helpers (no behavior change — pure extraction). The continuation branch and the `runTurn` closure become shared.

- [ ] **Step 4: Run the manager test to verify pass**

Run: `npm --prefix apps/desktop test -- manager.test`
Expected: PASS (existing submitGoal tests still green — behavior unchanged).

- [ ] **Step 5: Add `createTask` to `AgentRunnerDeps` + `ToolRunContext`**

In `agent-runner.ts` `AgentRunnerDeps` (~after `spawnChild`, ~line 234):

```ts
/** Agent-authored work: create a top-level work Task (verify loop), await, return result. */
createTask?(goal: string, criteria?: import('@swarm/protocol').AcceptanceCriterion[]): Promise<{ taskId: string; result: TaskResult }>
```

In `buildToolContext` (~line 308), add:

```ts
createTask: (goal, criteria) =>
  deps.createTask ? deps.createTask(goal, criteria) : Promise.reject(new Error('create_task not wired')),
```

In `tools/registry.ts` `ToolRunContext`, add the matching field.

- [ ] **Step 6: Create the `create_task` tool**

Create `apps/desktop/src/service/tools/create-task.ts` (mirroring `spawn.ts`):

```ts
import type { AgentTool } from '@earendil-works/pi-agent-core'
import { Type } from '@earendil-works/pi-ai'
import type { AcceptanceCriterion } from '@swarm/protocol'

import type { ToolRunContext, ToolSpec } from './registry'

const CreateTaskParams = Type.Object({
  goal: Type.String({ description: 'The concrete goal of the work task.' }),
  acceptanceCriteria: Type.Optional(
    Type.Array(
      Type.Object({
        description: Type.String({ description: 'A checkable done-condition for the task.' }),
        check: Type.Optional(
          Type.Object({
            kind: Type.String({ description: "'command' or 'file_exists'." }),
            command: Type.Optional(Type.String()),
            expectExitCode: Type.Optional(Type.Number()),
            expectStdout: Type.Optional(Type.String()),
            path: Type.Optional(Type.String()),
          }),
        ),
      }),
    ),
  ),
})

export function createTaskSpec(): ToolSpec {
  return {
    group: 'agent',
    name: 'create_task',
    risk: 'medium',
    source: 'builtin',
    build: (ctx: ToolRunContext): AgentTool => ({
      name: 'create_task',
      label: 'Create task',
      description:
        'Create a real work task that runs the verify loop and appears in the task panel. Use this when the user’s request is substantial work needing its own task tracking — NOT for trivial questions you can answer directly in the conversation. Returns the task’s result.',
      parameters: CreateTaskParams,
      execute: async (_toolCallId, params) => {
        const p = params as { goal: string; acceptanceCriteria?: AcceptanceCriterion[] }
        const { taskId, result } = await ctx.createTask(p.goal, p.acceptanceCriteria)
        return JSON.stringify({ taskId, summary: result.summary, artifacts: result.artifacts })
      },
    }),
  }
}
```

Register in `builtins.ts` (next to the spawn spec registration): add `r.register(createTaskSpec())` and the import.

Add a `createTask` tool unit test (`create-task.test.ts`) that builds the spec with a stubbed `ctx.createTask` and asserts the execute output shape.

- [ ] **Step 7: Run tests + format + commit**

Run: `npm --prefix apps/desktop test -- manager.test create-task`
Expected: PASS.

```bash
npx biome check --write apps/desktop/src/service/session/manager.ts apps/desktop/src/service/session/agent-runner.ts apps/desktop/src/service/tools/registry.ts apps/desktop/src/service/tools/builtins.ts apps/desktop/src/service/tools/create-task.ts
git add apps/desktop/src/service/session/manager.ts apps/desktop/src/service/session/agent-runner.ts apps/desktop/src/service/tools/ apps/desktop/src/service/session/manager.test.ts
git commit -m "feat(tools): add create_task tool + runWorkTask extraction (dormant)"
```

---

### Task 3: Transcript adapter — render conversation events as pseudo-TaskRecords

**Files:**
- Modify: `apps/desktop/src/renderer/src/lib/replay.ts` (`conversationTurnsToRecords`).
- Modify: `apps/desktop/src/renderer/src/hooks/use-tasks.ts` (`hydrateSession` loads conversation turns; `useTasks` merges).
- Modify: `apps/desktop/src/shared/lib/apply-event.ts` (handle turn-keyed live events).
- Modify: `apps/desktop/src/renderer/src/hooks/use-events-subscription.ts` (route conversation events).
- Test: `replay.test.ts`, `apply-event.test.ts`, `use-tasks.test.tsx`.

**Interfaces:**
- Produces: `conversationTurnsToRecords(sessionId, rows)` — groups conversation events by `turnId` into `TaskRecord`s; `applyEvent` (and the live subscription) handle events carrying a `turnId` (and no `taskId`) by upserting a conversation-turn record keyed by `turnId`.

**Note:** No conversation events exist yet (submitGoal still uses the old path), so this task is inert until Task 4 — but it is independently testable with fixtures.

- [ ] **Step 1: Write the replay test**

In `replay.test.ts`:

```ts
it('conversationTurnsToRecords groups conversation events by turnId into TaskRecords', () => {
  const rows = [
    { turnId: 't1', seq: 1, ts: 1, event: { kind: 'llm.message', role: 'user', content: 'hi', ts: 1 } },
    { turnId: 't1', seq: 2, ts: 2, event: { kind: 'llm.message', role: 'assistant', content: 'yo', ts: 2 } },
    { turnId: 't2', seq: 3, ts: 3, event: { kind: 'llm.message', role: 'user', content: 'again', ts: 3 } },
  ] as never[]
  const recs = conversationTurnsToRecords('s', rows)
  expect(recs).toHaveLength(2)
  expect(recs[0].id).toBe('t1')
  expect(recs[0].events.map((e) => e.seq)).toEqual([1, 2])
})
```

- [ ] **Step 2: Run to verify it fails**

Run: `npm --prefix apps/desktop test -- replay.test`
Expected: FAIL — `conversationTurnsToRecords` is not exported.

- [ ] **Step 3: Implement `conversationTurnsToRecords`**

In `replay.ts`:

```ts
import type { TaskEvent, UIEvent } from '@swarm/protocol'

export type ConversationEventRow = { turnId: string; seq: number; ts: number; event: TaskEvent }

/** Group session-conversation events by turnId into TaskRecord-shaped turns the
 *  existing taskSegments/buildTimelineItems pipeline can render unchanged. */
export function conversationTurnsToRecords(sessionId: string, rows: ConversationEventRow[]): TaskRecord[] {
  const byTurn = new Map<string, { events: ConversationEventRow[] }>()
  for (const r of rows) {
    const t = byTurn.get(r.turnId) ?? { events: [] }
    t.events.push(r)
    byTurn.set(r.turnId, t)
  }
  const records: TaskRecord[] = []
  for (const [turnId, { events: evs }] of byTurn) {
    const first = evs[0]
    const firstUser = evs.find((e) => (e.event as { kind?: string; role?: string }).kind === 'llm.message' && (e.event as { role?: string }).role === 'user')
    const uiEvents: UIEvent[] = evs.map((e) => ({
      kind: 'task.progress',
      sessionId,
      taskId: turnId,
      event: e.event,
      ts: e.ts,
      seq: e.seq,
    } as UIEvent))
    // Derive status: an error/end event ⇒ ended; else running (live turn).
    const last = evs[evs.length - 1].event as { kind?: string }
    const status: TaskStatus = last?.kind === 'error' ? 'failed' : 'running'
    records.push({
      id: turnId,
      sessionId,
      goal: firstUser ? String((firstUser.event as { content?: unknown }).content ?? '') : '',
      status,
      workerId: null,
      summary: null,
      startedAt: first?.ts ?? 0,
      attachments: [],
      events: uiEvents,
      // marker so planGroups/verifyGroups filters (tasks-view.tsx) can exclude
      // conversation turns — they never have plan/criteria.
      isConversation: true,
    } as TaskRecord & { isConversation: boolean })
  }
  return orderBy(records, ['startedAt'], ['desc'])
}
```

Extend the `TaskRecord` type in `apply-event.ts` with an optional `isConversation?: boolean` marker.

- [ ] **Step 4: Run the replay test to verify pass**

Run: `npm --prefix apps/desktop test -- replay.test`
Expected: PASS.

- [ ] **Step 5: Merge conversation turns in `useTasks` / `hydrateSession`**

In `use-tasks.ts`, add a sibling query key `CONVERSATION_KEY = ['conversation'] as const` and a `useConversationTurns(sessionId)` hook, OR fold both into `TASKS_KEY`. Simpler (one merged list): extend `hydrateSession` to also fetch conversation events and merge:

```ts
export async function hydrateSession(qc, sessionId) {
  const [tasks, convRows] = await Promise.all([
    swarmApi.getSessionTasks(sessionId),
    swarmApi.getConversationEvents(sessionId),
  ])
  const records = [...conversationTurnsToRecords(sessionId, convRows), ...tasksToRecords(sessionId, tasks)]
  qc.setQueryData<TaskRecord[]>(TASKS_KEY, (prev = []) => {
    const known = new Set(prev.map((t) => t.id))
    return [...records.filter((r) => !known.has(r.id)), ...prev]
  })
}
```

Add `swarmApi.getConversationEvents(sessionId)` (IPC handler wired in `service/index.ts`/dispatcher to `store.getConversationEvents`). Mirror an existing read IPC like `getSessionTasks`.

- [ ] **Step 6: Handle live conversation events in the subscription**

Conversation events arrive as `task.progress`-shape with a `turnId` and no `taskId` (see Task 4's `makeConversationEmit`). Extend `apply-event.ts` so that when an event carries `turnId` (not `taskId`), it upserts a conversation-turn record keyed by `turnId` (appending the inner event to that turn's `events`). Add a focused test in `apply-event.test.ts` (a `task.progress` event with `turnId` creates/updates a record with that id).

In `use-events-subscription.ts`, the existing `applyEvent(prev, e)` call now also handles turn-keyed events — no change needed once `applyEvent` covers them.

- [ ] **Step 7: Exclude conversation turns from the task panel**

In `tasks-view.tsx`, the `planGroups`/`verifyGroups` filters already require `t.plan`/`t.acceptanceCriteria`, which conversation turns lack — so they're naturally excluded. Add a belt-and-braces guard: `sessionTasks.filter((t) => !t.isConversation)` for those two groupings.

- [ ] **Step 8: Run tests + format + commit**

Run: `npm --prefix apps/desktop test -- replay apply-event use-tasks`
Expected: PASS.

```bash
npx biome check --write apps/desktop/src/renderer/src/lib/replay.ts apps/desktop/src/renderer/src/hooks/use-tasks.ts apps/desktop/src/renderer/src/hooks/use-events-subscription.ts apps/desktop/src/shared/lib/apply-event.ts apps/desktop/src/renderer/src/components/views/tasks-view.tsx
git commit -m "feat(renderer): transcript adapter for conversation turns (inert until submitGoal cutover)"
```

---

### Task 4: Flip `submitGoal` to the conversation path (the cutover)

**Files:**
- Modify: `apps/desktop/src/service/session/manager.ts` (`submitGoal` rewrite; add `makeConversationEmit`; wire `createTask` dep on conversation runs).
- Modify: `apps/desktop/src/service/ipc/dispatcher.ts` or `service/index.ts` — expose `getConversationEvents` (if not done in Task 3).
- Test: `apps/desktop/src/service/session/manager.test.ts` (update existing submitGoal assertions; add conversation-path assertions).

**Interfaces:** After this task, `submitGoal` creates NO `Task`; conversation events flow to `conversation_events`; `create_task` (Task 2) is the only path that creates a work Task.

- [ ] **Step 1: Add `makeConversationEmit`**

In `manager.ts`, near `makeEmit` (~line 250), add:

```ts
const makeConversationEmit =
  (sessionId: string, turnId: string) =>
  (event: string, data: unknown): void => {
    const obj = data && typeof data === 'object' ? (data as Record<string, unknown>) : undefined
    const seq = seqCounter.nextSeq(sessionId)
    const ts = Date.now()
    if (obj?.event && typeof obj.event === 'object') (obj.event as { seq?: number }).seq = seq
    const payload = obj ? { ...obj, sessionId, turnId, seq, ts } : data
    if (event === 'task.progress' && obj?.event) {
      store.appendConversationEvent(sessionId, turnId, obj.event as import('@swarm/protocol').TaskEvent)
    }
    broadcaster.broadcast(event, payload)
  }
```

- [ ] **Step 2: Rewrite `submitGoal` to the conversation path**

Replace the `submitGoal` body. It no longer builds a `Task` or calls `saveTask`/`task.created`. Sketch:

```ts
submitGoal(sessionId, goal, attachmentsArg, _agentDefArg, onComplete, options) {
  const session = getOrRehydrate(sessionId)
  if (!session) throw new Error(`session ${sessionId} not found`)
  const attachments = attachmentsArg ?? []
  const turnId = ulid()
  // The user message is a first-class, seq'd event on the session-conversation
  // stream (Phase 2 made it real; 3a routes it to conversation_events).
  makeConversationEmit(sessionId, turnId)('task.progress', {
    event: { kind: 'llm.message', role: 'user', content: goal, ts: Date.now() },
  })
  store.updateSessionLastActive(sessionId)

  const runTurn = async () => {
    const abort = new AbortController()
    oneShotHandles.set(turnId, abort)
    await acquireSlot()
    const agentDef = resolveAgentDef(sessionId, options ?? {})
    const runner = createAgentRunner({
      correlationId: turnId,
      cwd: options?.cwd,
      goal,                                  // still seeds agent.prompt(goal); folds into initialMessages in 3c
      executionMode: options?.executionMode,
      budget: budgets().sub,
      toolAllowlist: undefined,              // full session-agent scope
      attachments,
      permissionMode: options?.permissionMode,
      acceptanceCriteria: undefined,         // conversation never runs the verify loop
      provider: session.provider,
      agentDefinition: withPrompt(agentDef),
      sessionId,
      getPermissionMode: () => resolvePermissionMode(sessionId),
      emit: makeConversationEmit(sessionId, turnId),
      permissionRegistry: session.permissionRegistry,
      toolRegistry,
      initialMessages: session.messages,
      saveSnapshot: (messages, used, ctx) => {
        session.messages = messages
        store.saveAgentSnapshot(sessionId, messages)
        saveSessionUsage(sessionId, used, ctx)   // see Task 5
      },
      signal: abort.signal,
      spawnChild: (pt, ng, st, pk, at, opt) => spawnChild(sessionId, pt, ng, st, pk, at, opt),
      createTask: (g, criteria) => runWorkTask(sessionId, g, [], criteria ? { acceptanceCriteria: criteria } : {}),
      findPeers: (q) => directory.find(sessionId, q),
      writeAgent: (def) => cfg.agentStore?.save(def) ?? { ok: false, code: 'no_store', message: 'agent store unavailable' },
      writeSkill: (skill) => cfg.skillStore?.save(skill) ?? { ok: false, code: 'no_store', message: 'skill store unavailable' },
      maxVerifyRounds: 0,                    // single-shot — the cutover's key line
      maxIterationsOverride: budgets().maxIterations,
    })
    try {
      const { status } = await runner.run()
      onComplete?.(status)
    } catch (err) {
      log.error({ msg: 'conversation turn failed', turnId, err: err instanceof Error ? err.message : String(err) })
      makeConversationEmit(sessionId, turnId)('task.error', {
        turnId, error: { code: 'run_failed', message: err instanceof Error ? err.message : String(err), tier: 'fatal' },
      })
      onComplete?.('failed', err instanceof Error ? err.message : String(err))
    } finally {
      oneShotHandles.delete(turnId)
      releaseSlot()
    }
  }

  session.pending.push({ taskId: turnId, runTurn })
  pump(session)
  return { taskId: turnId } as { taskId: string }
}
```

(The `session.messages` continuity carries conversation context across turns; `acquireSlot`/`pump`/`oneShotHandles` are unchanged — they're keyed by the string id, now `turnId`.)

**Keep the existing `submitGoal` signature** returning `{ taskId: string }` (it's `turnId` now) so IPC callers are unchanged.

- [ ] **Step 3: Update the existing `manager.test.ts` submitGoal assertions**

Several existing tests assert `submitGoal` → a `Task` row, `task.created`, the verify loop, etc. Update them to the new model:
- The Phase 2 test `'emits the user message as a real seq event on a new task'` → rename to `'emits the user message as a real seq event on a conversation turn'`; assert the event lands in `store.getConversationEvents(sid)` (not task history), and NO `Task` is saved (`store.getSessionTasks(sid)` is empty).
- `'injects sessionId into broadcasts and persists task history on completion'` → split: the conversation path persists to `conversation_events` (not task history); the work-task path (via `runWorkTask`) persists to task history. Update accordingly.
- Any test that drove the verify loop via `submitGoal` → move to driving `runWorkTask` (the verify loop now lives only behind `create_task`).
- The concurrency/queue/cancel tests → still pass (keyed by the string id, now turnId).

Add a new test: `submitGoal` does NOT save a `Task`; `runner.run` is constructed with `maxVerifyRounds: 0`.

- [ ] **Step 4: Run manager tests**

Run: `npm --prefix apps/desktop test -- manager.test`
Expected: PASS (after updating the assertions above).

- [ ] **Step 5: Format + commit**

```bash
npx biome check --write apps/desktop/src/service/session/manager.ts apps/desktop/src/service/session/manager.test.ts
git commit -m "feat(session): submitGoal conversation path — no Task, single-shot, session events

The cutover: a conversation turn no longer saves a Task or runs the verify
loop. Its events stream to conversation_events. create_task (Task 2) is now
the only path that creates a work Task. Fixes 'every message creates a task'."
```

---

### Task 5: Cancel-by-turnId + session-level usage

**Files:**
- Modify: `apps/desktop/src/service/session/manager.ts` (`cancelTask`/`interruptWith` already opaque to id; verify and add a test); add `saveSessionUsage`.
- Modify: `apps/desktop/src/service/conversation/store.ts` — `saveSessionUsage`/`getSessionUsage` (or fold into the session row).
- Test: `manager.test.ts`, `store.test.ts`.

- [ ] **Step 1: Confirm cancel works for a conversation turn (failing test)**

```ts
it('cancelTask aborts an in-flight conversation turn by turnId', async () => {
  let release: () => void = () => {}
  mockCreate.mockImplementation(() =>
    runner(() => new Promise<RunReturn>((r) => { release = () => r(runnerReturn('cancelled')) })))
  const store = createConversationStore(dbPath)
  const manager = createSessionManager({ store, broadcaster: createBroadcaster(), maxConcurrent: 1, getProvider: () => undefined })
  const { sessionId } = manager.createSession(providerA)
  const { taskId: turnId } = manager.submitGoal(sessionId, 'hi')
  await new Promise((r) => setTimeout(r, 0))
  manager.cancelTask(sessionId, turnId)   // turnId, not a Task id
  release()
  await new Promise((r) => setTimeout(r, 0))
  expect(oneShotHandlesSizeForTest()).toBe(0)   // handle cleared
  store.close()
})
```

- [ ] **Step 2: Run + (expect PASS — cancel is id-opaque) + fix if needed**

Run: `npm --prefix apps/desktop test -- manager.test`
Expected: PASS. If FAIL, the only likely cause is `interruptWith`/`cancelTask` referencing `store.getTask(id)` — wrap that in an optional check so a turnId (no Task) is tolerated.

- [ ] **Step 3: Add session-level usage persistence**

Add `saveSessionUsage(sessionId, used, contextWindow?)` and `getSessionUsage(sessionId)` to the store (a `session_usage` column on `sessions` or a small table; mirror `saveTaskUsage`). Wire `saveSessionUsage` in the conversation turn's `saveSnapshot` (Step 2 of Task 4 references it). The session-list usage rollup (`getUsageStats`) keeps summing task usage for work tasks; add conversation usage to the rollup so totals stay correct.

- [ ] **Step 4: Run + format + commit**

```bash
npm --prefix apps/desktop test -- manager.test store.test
npx biome check --write apps/desktop/src/service/session/manager.ts apps/desktop/src/service/conversation/store.ts
git commit -m "feat(session): cancel-by-turnId + session-level usage for conversation"
```

---

### Task 6: e2e regression + full suite + smoke

**Files:**
- Modify: `apps/desktop/src/service/e2e/conversation-off-task.e2e.test.ts` (new).

- [ ] **Step 1: Write the e2e test**

```ts
it('a trivial message creates no Task and no verify; create_task makes a work Task', async () => {
  // stubbed-runner manager: the conversation run emits an assistant message;
  // a create_task call (simulated via __runWorkTaskForTest) makes a work task.
  const store = createConversationStore(tmpDb())
  const manager = createManagerWithStubbedRunner({ store, assistantReply: 'hi there' })
  const { sessionId } = manager.createSession(providerA)

  const { taskId: turnId } = manager.submitGoal(sessionId, '你好')
  await flush()
  // No Task row; the conversation event stream has the user + assistant messages.
  expect(store.getSessionTasks(sessionId)).toHaveLength(0)
  const conv = store.getConversationEvents(sessionId)
  expect(conv.some((r) => (r.event as { role?: string }).role === 'user')).toBe(true)
  expect(conv.some((r) => (r.event as { role?: string }).role === 'assistant')).toBe(true)
  // No verification events (single-shot).
  expect(conv.some((r) => (r.event as { kind?: string }).kind === 'verification')).toBe(false)

  // Agent-authored work via create_task DOES make a Task.
  const work = await (manager as unknown as { __runWorkTaskForTest: (s: string, g: string) => Promise<{ taskId: string }> }).__runWorkTaskForTest(sessionId, 'build it')
  expect(store.getSessionTasks(sessionId).find((t) => t.id === work.taskId)).toBeDefined()
  store.close()
})
```

(`createManagerWithStubbedRunner` and `flush` are local helpers mirroring the existing e2e test scaffolding in `multi-level-verify.e2e.test.ts`.)

- [ ] **Step 2: Run the e2e + full suite**

Run: `npm --prefix apps/desktop test`
Expected: PASS (full suite, modulo the known `host.test` EADDRINUSE when the app is running).

- [ ] **Step 3: Format + commit**

```bash
npx biome check --write apps/desktop/src/service/e2e/conversation-off-task.e2e.test.ts
git commit -m "test(e2e): conversation creates no task; create_task makes a work task"
```

- [ ] **Step 4: Manual smoke**

`pnpm dev` (quit any running instance first — single-instance lock). In a fresh session send "你好" — expect a direct reply, **no task card, no task-panel entry, no verify spinner**. Then send a substantial goal that the agent turns into `create_task` — expect a work task to appear in the right-hand panel with a plan and a verify round. Cancel a mid-flight turn — expect it stops. Record outcomes; do not commit.

---

## Self-Review

**Spec coverage:**
- §4.1 conversation_events table + methods → Task 1. ✓
- §4.2 shared seq → Task 1 (seq-counter + manager wiring). ✓
- §5.1 submitGoal conversation path (no Task, single-shot, makeConversationEmit, continuation) → Task 4. ✓
- §5.2 create_task + runWorkTask + createTask dep → Task 2. ✓
- §5.3 runner unchanged (single-shot path) → no runner edits in any task (only the optional `createTask` dep); confirmed in Task 2 step 5 + Task 4 (maxVerifyRounds: 0 uses the existing path). ✓
- §5.4 transcript adapter (group by turnId, merge, taskSegments unchanged) → Task 3. ✓
- §5.5 task-panel filter (isConversation guard) → Task 3 step 7. ✓
- §8 concurrency (runWorkTask nests under the turn's slot, like spawnChild) → Task 2 (`runWorkTask` calls the extracted `runTaskQueueTurn` which runs under the caller's slot; the verify runner is awaited synchronously, not re-pumped). ✓
- §9 cancel/interrupt by turnId → Task 5. ✓
- §10 session-level usage → Task 5. ✓
- §12 test strategy (store/manager/adapter/e2e) → Tasks 1, 2, 3, 4, 5, 6. ✓
- §13 verification (npm test, biome, smoke) → every task gate + Task 6. ✓
- §15 forward pointers (3b/3c/Phase 4) — explicitly out of scope; no task touches them. ✓

**Placeholder scan:** Task 2 step 3 references factoring `resolveAgentDef`/`buildWorkTask`/`runTaskQueueTurn` out of the existing `submitGoal` code without showing the full extraction body — this is intentional (the bodies are the verbatim existing lines, relocated), and the test in step 1 + the existing-suite gate in step 4 lock the behavior. If the reviewer wants the full extracted bodies inline, they can be expanded; the locator (~`:820-957`) is exact.

**Type consistency:** `conversationTurnsToRecords` returns `TaskRecord[]` with an added optional `isConversation` marker, declared on `TaskRecord` in `apply-event.ts` (Task 3 step 3). `appendConversationEvent`/`getConversationEvents` signatures match between the store interface (Task 1 step 4), the seq-counter (Task 1 step 6), and the manager wiring (Task 1 step 7, Task 4 step 1). `createTask(goal, criteria?)` is consistent across `AgentRunnerDeps` (Task 2 step 5), `ToolRunContext` (Task 2 step 5), the tool (Task 2 step 6), and the manager wiring (Task 4 step 2). `runWorkTask` is consistent between its definition (Task 2 step 3), its test hook (Task 2 step 3), and its `createTask` use (Task 4 step 2).

**Green-at-each-commit check:** Task 1 additive (store+seq). Task 2 dormant (submitGoal unchanged; create_task wired but unused). Task 3 inert (no conversation events yet; adapter tested with fixtures). Task 4 the cutover (biggest test churn, all within manager.test.ts). Task 5 polish. Task 6 e2e. The suite stays green at each commit; the app only changes behavior at Task 4.

**One risk noted:** Task 4's `submitGoal` rewrite is the largest edit and breaks several existing manager tests (they assumed submitGoal → Task). Task 4 step 3 enumerates the test updates; the plan-impl should budget for that churn and run the full manager suite after.
