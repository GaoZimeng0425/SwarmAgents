# User Message as a Real Event (Phase 2) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make the user's message a real seq'd event emitted at submit time, so the first user message renders at the top of the transcript (fixes the first-message-renders-last bug structurally).

**Architecture:** Renderer-first, two-step. (1) `taskSegments` stops unconditionally synthesizing a goal bubble from `task.goal`; it renders the user message from a real `llm.message role:'user'` event when one exists, and keeps the synthetic bubble only for tasks with no user event (sub-agent / resident). (2) `submitGoal` emits that real user-message event on the new-task path (the continuation path already does). Order is renderer-first so no intermediate state ever shows duplicate user bubbles. The Task row stays the turn anchor; the LLM buffer (`session.messages`) is untouched.

**Tech Stack:** TypeScript, `vitest`, `better-sqlite3`, Electron (test runner), `@swarm/protocol`.

## Global Constraints

- **Spec:** `docs/superpowers/specs/2026-07-02-user-message-real-event-design.md` (authoritative; this plan implements it).
- **Run tests via `npm test`** (Electron node runner). NEVER bare `npx vitest`, NEVER `pnpm rebuild better-sqlite3` (breaks app ABI; restore with `npm run postinstall`).
- **Behavior preserved** except the intended fix (first user message renders first). Existing tests are the safety net where they still apply; updated/added tests lock the new behavior.
- **Comments and commit messages in English.**
- **Scoped formatting:** `npx biome check --write <file>` (the repo's `pnpm check`/`format` rewrite the whole tree).
- **Pre-commit in the worktree** needs `node_modules` symlinked to the main checkout (already done in this worktree; if fresh, `ln -s /Users/gaozimeng/Learn/macOS/SwarmAgents/node_modules node_modules` first).
- **One commit per task**, on branch `worktree-runner-task-decouple`. Integrate to `develop` via `git rebase develop` + `git merge --ff-only`.

## File Structure

- **Modify** `apps/desktop/src/renderer/src/lib/task-segments.ts` — conditional synthetic goal bubble; first user segment carries `task.attachments`.
- **Modify** `apps/desktop/src/service/session/manager.ts` — `submitGoal` new-task path emits a real user-message event (after the `task.created` broadcast, ~`:866`).
- **Modify** `apps/desktop/src/renderer/src/lib/task-segments.test.ts` — update the follow-up fixture to the new model; add real-event + attachment tests; recaption the two fallback tests.
- **Modify** `apps/desktop/src/renderer/src/lib/build-timeline-items.test.ts` — regression: first user message (smallest seq) renders before the assistant reply.
- **Modify** `apps/desktop/src/service/session/manager.test.ts` — assert the new-task user-message event is emitted with a real seq.

No new files.

---

### Task 1: `taskSegments` — render the user message from its real event; keep synthetic bubble only as the sub-agent fallback

**Files:**
- Modify: `apps/desktop/src/renderer/src/lib/task-segments.ts` (`taskSegments` body ~`:39-95`).
- Test: `apps/desktop/src/renderer/src/lib/task-segments.test.ts`.

**Interfaces:**
- Consumes: the existing `TaskRecord` shape (`events: UIEvent[]`, `attachments`, `goal`, `startedAt`) — unchanged.
- Produces: `taskSegments` now omits the synthetic goal bubble when `task.events` contains a `task.progress` whose inner event is `{ kind: 'llm.message', role: 'user' }`; the first user segment (event-derived) carries `task.attachments`. The `Segment` type and the function signature are unchanged.

- [ ] **Step 1: Update the follow-up fixture test to the new model**

In `task-segments.test.ts`, replace the test at ~lines 60-71 (`'renders a follow-up user message (role:user) as its own user segment'`) with a fixture whose first user message is itself a real event (the new model), so the assertion is two event-derived user bubbles:

```ts
  it('renders a follow-up user message (role:user) as its own user segment', () => {
    const segs = taskSegments(
      rec([
        prog({ kind: 'llm.message', role: 'user', content: 'do x', ts: 1 }),
        prog({ kind: 'llm.message', role: 'assistant', content: 'done', ts: 2 }),
        prog({ kind: 'llm.message', role: 'user', content: '继续', ts: 3 }),
      ])
    )
    const users = segs.filter((s) => s.kind === 'user')
    // Both user messages come from real events (no synthetic goal bubble).
    expect(users).toHaveLength(2)
    expect(users[1]).toMatchObject({ kind: 'user', text: '继续' })
  })
```

- [ ] **Step 2: Add the real-event test (no synthetic bubble; seq from the event)**

Add this test inside the `describe('taskSegments', ...)` block (after the follow-up test):

```ts
  it('renders the first user message from its real event, not a synthetic goal bubble', () => {
    const segs = taskSegments(
      rec([
        {
          kind: 'task.progress',
          sessionId: 's1',
          taskId: 't1',
          event: { kind: 'llm.message', role: 'user', content: 'hello', ts: 5 },
          ts: 5,
          seq: 7,
        } as TaskRecord['events'][number],
      ])
    )
    const users = segs.filter((s) => s.kind === 'user')
    // No synthetic goal bubble (task.goal is 'do x'); the single user segment is
    // the real event, carrying the event's seq (7), not the startedAt fallback (1).
    expect(users).toHaveLength(1)
    expect(users[0]).toMatchObject({ kind: 'user', text: 'hello' })
    expect((users[0] as unknown as { seq: number }).seq).toBe(7)
  })
```

- [ ] **Step 3: Add the attachments-on-first-user-segment test**

Add this test inside the same `describe` block:

```ts
  it('carries task attachments on the first (event-derived) user segment', () => {
    const segs = taskSegments({
      ...rec([prog({ kind: 'llm.message', role: 'user', content: 'hi', ts: 1 })]),
      attachments: [{ data: 'AAAA', mimeType: 'image/png', name: 'a.png' }],
    })
    const users = segs.filter((s) => s.kind === 'user')
    // One user segment (from the event), and it carries the task's attachments
    // (preserves image rendering now that the bubble comes from the event).
    expect(users).toHaveLength(1)
    expect(users[0] && 'attachments' in users[0] && users[0].attachments).toEqual([
      { data: 'AAAA', mimeType: 'image/png', name: 'a.png' },
    ])
  })
```

- [ ] **Step 4: Recaption the two fallback tests (sub-agent path)**

The tests at ~lines 23-26 (`'emits the goal as the first user segment'`) and ~lines 28-34 (`'carries attachments on the user segment'`) now exercise the no-user-event fallback (sub-agent / resident). Update only their `it(...)` strings so the intent is clear — do NOT change their bodies or fixtures:

```ts
  it('emits the goal as the first user segment when there is no user-message event (sub-agent path)', () => {
    // ...body unchanged...
  })

  it('carries attachments on the synthetic goal segment (sub-agent path)', () => {
    // ...body unchanged...
  })
```

(The seq test at ~lines 262-276, `'gives the goal segment the task.created seq'`, stays unchanged — its fixture has no user event, so it still hits the synthetic-bubble branch.)

- [ ] **Step 5: Run the tests to verify the new ones fail**

Run: `npm test -- task-segments.test`
Expected: FAIL — the follow-up test sees 3 user segments (synthetic + 2 events), the real-event test sees 2 (synthetic + event) with the wrong seq, and the attachments test sees 2 user segments. (The two recaptioned fallback tests still PASS.)

- [ ] **Step 6: Make the synthetic goal bubble conditional**

In `task-segments.ts`, replace the unconditional prepend at the top of `taskSegments` (~lines 39-52):

```ts
export function taskSegments(task: TaskRecord): Segment[] {
  const out: Segment[] = [
    {
      kind: 'user',
      text: task.goal,
      attachments: task.attachments ?? [],
      key: `${task.id}-goal`,
      taskId: task.id,
      ts: task.startedAt,
      // The goal bubble takes task.created's seq (events[0]) so it sorts at the
      // task's true position; fall back to startedAt when no events are present.
      seq: task.events[0]?.seq ?? task.startedAt,
    },
  ]
```

with a conditional prepend (kept byte-for-byte for the fallback case):

```ts
export function taskSegments(task: TaskRecord): Segment[] {
  const out: Segment[] = []

  // A top-level conversation turn carries its user message as a real seq'd event
  // (manager.submitGoal), rendered by the loop below — no synthetic bubble. A
  // sub-agent / resident task has no human user event; its objective is shown
  // via the synthetic goal bubble here (SubagentBlock does not render the goal).
  const hasUserMessage = task.events.some(
    (e) => e.kind === 'task.progress' && e.event.kind === 'llm.message' && e.event.role === 'user',
  )
  if (!hasUserMessage) {
    out.push({
      kind: 'user',
      text: task.goal,
      attachments: task.attachments ?? [],
      key: `${task.id}-goal`,
      taskId: task.id,
      ts: task.startedAt,
      // The goal bubble takes task.created's seq (events[0]) so it sorts at the
      // task's true position; fall back to startedAt when no events are present.
      seq: task.events[0]?.seq ?? task.startedAt,
    })
  }
```

- [ ] **Step 7: Carry task attachments on the first event-derived user segment**

In the same function, declare a flag next to `skipNextToolResult` (just before the `pendingByCallId` / `pendingFifo` declarations, ~line 68):

```ts
  // The first event-derived user segment carries task.attachments so a request
  // submitted with images still shows them (the bubble now comes from the event,
  // not a synthetic goal bubble). Unused on the sub-agent fallback path above.
  let firstUserSegment = true
```

Then, in the event loop, replace the `llm.message role:'user'` branch (~lines 84-95):

```ts
      } else if (ev.kind === 'llm.message' && ev.role === 'user') {
        // A follow-up turn on the same task: render the user's message as its own
        // bubble (the task.goal user bubble above is the original request).
        out.push({
          kind: 'user',
          text: typeof ev.content === 'string' ? ev.content : JSON.stringify(ev.content),
          attachments: [],
          key,
          taskId: task.id,
          ts: e.ts,
          seq,
        })
      }
```

with:

```ts
      } else if (ev.kind === 'llm.message' && ev.role === 'user') {
        // The user's message — the original request on a top-level turn, or a
        // follow-up. The first user segment carries task.attachments (see above).
        out.push({
          kind: 'user',
          text: typeof ev.content === 'string' ? ev.content : JSON.stringify(ev.content),
          attachments: firstUserSegment ? task.attachments ?? [] : [],
          key,
          taskId: task.id,
          ts: e.ts,
          seq,
        })
        firstUserSegment = false
      }
```

- [ ] **Step 8: Run the tests to verify they pass**

Run: `npm test -- task-segments.test`
Expected: PASS (all tests, including the recaptioned fallbacks and the existing seq tests).

Run: `npx biome check --write apps/desktop/src/renderer/src/lib/task-segments.ts apps/desktop/src/renderer/src/lib/task-segments.test.ts`

- [ ] **Step 9: Commit**

```bash
git add apps/desktop/src/renderer/src/lib/task-segments.ts apps/desktop/src/renderer/src/lib/task-segments.test.ts
git commit -m "refactor(renderer): render user message from its real event

taskSegments no longer unconditionally synthesizes a goal bubble from
task.goal; it renders the user message from a real llm.message role:'user'
event when one exists, keeping the synthetic bubble only as the sub-agent
fallback. The first event-derived user segment carries task.attachments.
No behavior change yet for top-level turns (manager does not emit the event
until the next commit)."
```

---

### Task 2: `submitGoal` — emit the user-message event on the new-task path

**Files:**
- Modify: `apps/desktop/src/service/session/manager.ts` (`submitGoal`, new-task `else` branch ~`:864-883`).
- Test: `apps/desktop/src/service/session/manager.test.ts`.

**Interfaces:**
- Consumes: `makeEmit` (the existing session emit fn that assigns seq via `seqCounter` and persists `task.progress` events to `task.history` through `appendTaskEvent`) — unchanged.
- Produces: every new top-level turn now has a real `llm.message role:'user'` event as its first seq'd event, so the renderer (Task 1) renders it in true causal position. End-to-end bug fix.

- [ ] **Step 1: Write the failing test**

In `manager.test.ts`, add this test inside the `describe('SessionManager', ...)` block (it mirrors the scaffolding at ~lines 393-407 — real store, real broadcaster, mocked runner):

```ts
  it('emits the user message as a real seq’d event on a new task', async () => {
    mockCreate.mockImplementationOnce(() => runner(vi.fn().mockResolvedValue(runnerReturn('completed', ''))))
    const store = createConversationStore(dbPath)
    const broadcaster = createBroadcaster()
    const manager = createSessionManager({ store, broadcaster, maxConcurrent: 2, getProvider: () => undefined })
    const { sessionId } = manager.createSession(providerA)

    manager.submitGoal(sessionId, 'hello world')
    await new Promise((resolve) => setTimeout(resolve, 0))

    const [task] = store.getSessionTasks(sessionId)
    const userEvent = task.history.find(
      (e) => e.kind === 'llm.message' && (e as { role?: string }).role === 'user',
    ) as { content?: unknown; seq?: number } | undefined
    // The user message is a first-class event with a real seq (not just task.goal).
    expect(userEvent).toBeDefined()
    expect(userEvent!.content).toBe('hello world')
    expect(userEvent!.seq).toBeTypeOf('number')
    expect(userEvent!.seq!).toBeGreaterThan(0)

    store.close()
  })
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `npm test -- manager.test`
Expected: FAIL — `userEvent` is `undefined` (the new-task path does not yet emit a user-message event; only the continuation path does).

- [ ] **Step 3: Emit the user-message event on the new-task path**

In `manager.ts` `submitGoal`, inside the `else` branch (the new-task path), insert the emission immediately after the `task.created` broadcast (`broadcaster.broadcast('task.created', { ... })` at ~line 866) and before the `store.updateSessionLastActive(sessionId)` call that follows it. The surrounding code becomes:

```ts
      } else {
        store.saveTask(task, sessionId)
        broadcaster.broadcast('task.created', { sessionId, taskId, goal, attachments, ts: now })
        // The user's message is a first-class event with a real seq, so it renders
        // in true causal position (fixes first-message-renders-last). Symmetric with
        // the continuation path above.
        makeEmit(sessionId)('task.progress', {
          taskId,
          event: { kind: 'llm.message', role: 'user', content: goal, ts: now },
        })
        store.updateSessionLastActive(sessionId)
        log.info({
          msg: 'goal submitted',
```

(Leave the rest of the `else` branch — the `log.info`, the `isFirst` title block — unchanged.)

- [ ] **Step 4: Run the test to verify it passes**

Run: `npm test -- manager.test`
Expected: PASS.

Run: `npx biome check --write apps/desktop/src/service/session/manager.ts apps/desktop/src/service/session/manager.test.ts`

- [ ] **Step 5: Commit**

```bash
git add apps/desktop/src/service/session/manager.ts apps/desktop/src/service/session/manager.test.ts
git commit -m "feat(session): emit user message as a real seq'd event on new tasks

submitGoal's new-task path now emits a task.progress llm.message role:'user'
event right after task.created (the continuation path already did). Combined
with the renderer change, the first user message carries a real seq and
renders at the top of the transcript instead of last."
```

---

### Task 3: Integration regression test + full suite + manual smoke

**Files:**
- Modify: `apps/desktop/src/renderer/src/lib/build-timeline-items.test.ts` (add one regression test).

**Interfaces:**
- Consumes: Task 1's `taskSegments` (via `buildTimelineItems`) and Task 2's emitted event.
- Produces: an end-to-end regression guard that the first user message (smallest seq) sorts ahead of the assistant reply.

- [ ] **Step 1: Write the failing regression test**

In `build-timeline-items.test.ts`, add this test inside the `describe('buildTimelineItems', ...)` block. (It uses the existing `task(...)` and `render` helpers at the top of the file. The `render.segment` stub tags assistant segments `A:<text>` and tool segments `T:<tool>`, returning `null` for user segments — so the assertion is by `seq`.)

```ts
  it('renders the first user message before the assistant reply (first-message-order bug)', () => {
    // A top-level turn: the user message is a real event with the smallest seq.
    const t = task('t1', [
      { kind: 'task.created', sessionId: 's', taskId: 't1', goal: 'hi', ts: 1 } as TaskRecord['events'][number],
      {
        kind: 'task.progress',
        sessionId: 's',
        taskId: 't1',
        event: { kind: 'llm.message', role: 'user', content: 'hi', ts: 1 },
        ts: 1,
        seq: 1,
      } as TaskRecord['events'][number],
      {
        kind: 'task.progress',
        sessionId: 's',
        taskId: 't1',
        event: { kind: 'llm.message', role: 'assistant', content: 'hello there', ts: 2 },
        ts: 2,
        seq: 10,
      } as TaskRecord['events'][number],
    ])
    const items = buildTimelineItems([t], render, { busy: false, showDayDividers: false })
    // task.created renders no segment, so items are [user(seq 1), assistant(seq 10)].
    // The user message (smallest seq) is first — the bug was it sorted last.
    expect(items.map((i) => i.seq)).toEqual([1, 10])
  })
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `npm test -- build-timeline-items.test`
Expected: PASS. Tasks 1 and 2 already make the event-derived user segment carry the smallest seq, so it sorts first; this test is the regression guard for the fix. (If it FAILS, the fixture's user event is not rendering ahead of the assistant — re-check Task 1's `hasUserMessage` branch.)

- [ ] **Step 3: Run the full suite**

Run: `npm test`
Expected: PASS (full suite — this is the Phase-2 acceptance gate).

Run: `npx biome check --write apps/desktop/src/renderer/src/lib/build-timeline-items.test.ts`

- [ ] **Step 4: Commit**

```bash
git add apps/desktop/src/renderer/src/lib/build-timeline-items.test.ts
git commit -m "test(renderer): guard first-user-message renders before the reply

Regression test for the first-message-renders-last bug: a top-level turn
whose user message is a real event (smallest seq) sorts ahead of the
assistant reply in buildTimelineItems."
```

- [ ] **Step 5: Manual smoke**

Run the app (`pnpm dev`, or the project's run skill). In a **fresh** session, submit a goal; confirm the user's message renders at the **top** of the transcript, ahead of the assistant's reply and any tool blocks. Send a follow-up message (continuation); confirm it renders at its true position (after the prior reply). Trigger a sub-agent (e.g. a goal that invokes `spawn_sub_agent`); confirm the sub-agent block still shows its objective. Record the outcome; do not commit smoke results.

---

## Self-Review

**Spec coverage** (against `2026-07-02-user-message-real-event-design.md`):
- §6.1 (manager emits user event on new-task path) → Task 2. ✓
- §6.2 (taskSegments conditional synthetic bubble) → Task 1 steps 6-7. ✓
- §6.2 sub-agent fallback preserved (SubagentBlock does not render goal) → Task 1 step 6 (`if (!hasUserMessage)`) + the recaptioned fallback tests (step 4) keep asserting it. ✓
- §6.3 (build-timeline-items unchanged, defensive fallback kept) → no logic edit; Task 3 adds a regression test only. ✓
- §5 (two-channel invariant — LLM buffer untouched) → no `session.messages` / `agent.prompt(goal)` change in any task. ✓
- §7 (old sessions unaffected — `hasUserMessage === false` keeps the synthetic bubble) → Task 1 step 6 condition; the existing seq test (unchanged) + fallback tests lock it. ✓
- §8 (test strategy — manager test, task-segments fixtures incl. sub-agent, build-timeline-items regression) → Tasks 1-3. ✓
- §9 (verification — `npm test`, scoped biome, manual smoke) → every task's gate + Task 3 steps 3 & 5. ✓
- §10 (rollback — single-branch, ff-only, no schema change) → Global Constraints. ✓

**Placeholder scan:** none — every code step shows the exact code or an exact search-and-replace anchored to current line refs. (Task 3 step 2's "NOTE" is an expected-outcome clarification, not a placeholder.)

**Type consistency:** the `hasUserMessage` predicate reads `e.kind === 'task.progress' && e.event.kind === 'llm.message' && e.event.role === 'user'` — this matches the `UIEvent` discriminant used elsewhere in `taskSegments` (the loop's `e.kind === 'task.progress'` + `ev.kind === 'llm.message' && ev.role === 'user'` at the existing branch). `firstUserSegment` is declared once (step 7) and consumed once. The manager test's cast `(e as { role?: string })` matches the dynamically-stamped `llm.message` event shape persisted to `task.history`.

**Ordering safety:** renderer-first (Task 1) before the manager emit (Task 2). After Task 1 alone, top-level turns still have no user event → `hasUserMessage === false` → synthetic bubble (unchanged, no duplicate, bug not yet fixed). After Task 2, the event is emitted → renderer switches to the event → bug fixed, still no duplicate. At no intermediate commit do new tasks show two user bubbles.

**One risk noted:** Task 3 step 2 may PASS immediately (Task 1 already orders the user event first at the unit level; `buildTimelineItems` re-sorts all segments by seq globally). That is fine — the test is kept as the regression guard, and step 2's expected outcome says so explicitly.
