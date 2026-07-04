# Run-Engine W0 — Hotfixes Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Land the three production bug fixes from the run-engine rewrite spec (§8 W0) on the OLD engine, so the app stays usable while the rewrite proceeds: gmail-analyze crash, aborted-run double terminal, and the forever-empty `task.complete` summary.

**Architecture:** Three surgical fixes inside `apps/desktop/src/service/session/agent-runner.ts` (plus its direct consumers/tests). No structural change — the new run-engine is built separately in W1+. Spec: `docs/superpowers/specs/2026-07-04-run-engine-rewrite-design.md` (Bug ledger items 1, 2, 3).

**Tech Stack:** TypeScript (Electron main-side service), vitest (run through Electron's node), pi-agent-core mocked in tests.

## Global Constraints

- Work in a dedicated worktree on branch `worktree-w0-runner-hotfixes`, cut from `develop` (use superpowers:using-git-worktrees; verify `git log -1` shows develop's HEAD after entering). Integrate at the end via `git rebase develop` + ff-only merge (house rule).
- Run tests as `cd apps/desktop && npm test -- <path-filter>` — this uses Electron-as-node vitest. NEVER run `npx vitest` or `pnpm vitest` directly (better-sqlite3 ABI mismatch) and NEVER `pnpm rebuild better-sqlite3`.
- Full gate before merge: `npm test` at the repo root (turbo).
- Format only touched files: `npx biome check --write <file>` (never `pnpm check` — it reformats the whole repo).
- `git add` exact paths only; never `git add -A` (turbo typecheck can leave stray `.js`/`.d.ts` next to `.ts` sources).
- Code comments and commit messages in English.
- No new dependencies.

---

### Task 1: Default absent `attachments` to `[]` (gmail-analyze crash)

`createAgentRunner().run()` does `task.attachments!.map(...)` while `AgentRunnerDeps.attachments` is optional. `gmail/analyze.ts` builds deps WITHOUT `attachments`, so every email analysis crashes with `TypeError: Cannot read properties of undefined (reading 'map')` at run start (its test injects a fake runner, so the real path is never covered).

**Files:**
- Modify: `apps/desktop/src/service/session/agent-runner.ts:1208`
- Test: `apps/desktop/src/service/session/agent-runner.test.ts`

**Interfaces:**
- Consumes: existing `createAgentRunner(deps).run()`, test helpers `baseDeps`/`mkTask`/`MockAgent` already defined in `agent-runner.test.ts`.
- Produces: `run()` tolerates `attachments: undefined` (no signature change). Later tasks rely on nothing new here.

- [ ] **Step 1: Write the failing test**

Add inside the `describe('AgentRunner', ...)` block of `apps/desktop/src/service/session/agent-runner.test.ts`, right after the `'blocks the tool call and aborts the run when the call budget is exhausted'` test (the helpers `baseDeps`/`mkTask` are declared just above it and must be in scope):

```ts
  it('run() tolerates absent attachments (gmail-analyze regression)', async () => {
    // gmail/analyze.ts builds AgentRunnerDeps without `attachments`; run() must
    // not crash on the optional field.
    MockAgent.mockImplementation(function (
      this: Record<string, unknown>,
      opts: { initialState?: { messages?: unknown } }
    ) {
      this.state = { messages: [...((opts.initialState?.messages as unknown[]) ?? [])] }
      this.subscribe = () => undefined
      this.abort = () => undefined
      this.prompt = async () => undefined
    })
    const runner = createAgentRunner({ ...baseDeps(mkTask('t-no-attach')), attachments: undefined })
    const out = await runner.run()
    expect(out.status).toBe('completed')
  })
```

Note: `baseDeps` is declared inside the describe below this point — place the test AFTER `baseDeps`'s definition (e.g. right after the `'blocks the tool call and aborts...'` test) so the helper is in scope.

- [ ] **Step 2: Run test to verify it fails**

Run: `cd apps/desktop && npm test -- src/service/session/agent-runner.test.ts`
Expected: FAIL — `TypeError: Cannot read properties of undefined (reading 'map')` from `run()`.

- [ ] **Step 3: Write minimal implementation**

In `apps/desktop/src/service/session/agent-runner.ts` line 1208, change:

```ts
      const images: ImageContent[] = task.attachments!.map((a) => ({
```

to:

```ts
      const images: ImageContent[] = (task.attachments ?? []).map((a) => ({
```

- [ ] **Step 4: Run test to verify it passes**

Run: `cd apps/desktop && npm test -- src/service/session/agent-runner.test.ts`
Expected: PASS (all tests in the file).

- [ ] **Step 5: Format and commit**

```bash
npx biome check --write apps/desktop/src/service/session/agent-runner.ts apps/desktop/src/service/session/agent-runner.test.ts
git add apps/desktop/src/service/session/agent-runner.ts apps/desktop/src/service/session/agent-runner.test.ts
git commit -m "fix(runner): default absent attachments to [] in one-shot run

gmail-analyze builds AgentRunnerDeps without attachments; the non-null
assertion crashed every real analysis run at start (masked in tests by a
fake runner). Spec: run-engine rewrite bug ledger #3."
```

---

### Task 2: Emit `task.complete` with a flat `summary` (protocol/reducer mismatch)

The only production emitter nests the summary — `emit('task.complete', { taskId, result: { summary, artifacts: [] }, ts })` — while the protocol type (`ui.ts:103`) and the renderer reducer (`apply-event.ts:81`, reads `e.summary`) expect a FLAT `summary`. Result: `RunRecord.summary` is always `undefined` in production; the UI's completion summary never renders. Existing tests fabricate the typed (flat) shape instead of the real emitted shape, so they can't catch it.

**Files:**
- Modify: `apps/desktop/src/service/session/agent-runner.ts:524-525` (translator `agent_end`)
- Modify: `apps/desktop/src/service/gmail/analyze.ts:59-61` (the one consumer reading the nested shape)
- Modify: `apps/desktop/src/service/gmail/analyze.test.ts:40` (fixture → real shape)
- Modify: `apps/desktop/src/service/session/manager.test.ts:569` (fixture → real shape)
- Modify: `apps/desktop/src/service/e2e/unified-runs.e2e.test.ts:20`, `apps/desktop/src/service/e2e/agent-driven-verify.e2e.test.ts:25`, `apps/desktop/src/service/e2e/multi-level-verify.e2e.test.ts:64` (fixtures, ONLY where the payload is passed to `emit('task.complete', …)` — see Step 4's decision rule)
- Test (new): `apps/desktop/src/service/session/agent-runner.complete-shape.test.ts`

**Interfaces:**
- Consumes: `createEventTranslator` internals (agent-runner.ts), `applyEvent`/`RunRecord` from `@shared/lib/apply-event`, `UIEvent` from `@swarm/protocol`.
- Produces: the wire payload `{ taskId, summary: string, ts }` for `task.complete`. Task 3 edits the same `agent_end` block AFTER this task — its "old code" snippets assume this task landed. NOTE: `spawnChild`/`createTask` RETURN values (`{ childTaskId, result: TaskResult }`) are a different contract and MUST NOT change.

- [ ] **Step 1: Write the failing test (new file)**

Create `apps/desktop/src/service/session/agent-runner.complete-shape.test.ts`:

```ts
import { describe, expect, it, vi } from 'vitest'

// Self-contained pi mock (same pattern as agent-runner.retry.test.ts): prompt()
// streams a text delta then ends the run, so the translator's agent_end path —
// the only production task.complete emitter — is exercised for real.
vi.mock('@earendil-works/pi-agent-core', () => {
  class Agent {
    state = { messages: [] as Array<Record<string, unknown>> }
    private sub: ((e: unknown) => void) | null = null
    constructor(_c: unknown) {}
    subscribe(fn: (e: unknown) => void) {
      this.sub = fn
    }
    abort() {}
    async prompt(goal: string) {
      this.state.messages.push({ role: 'user', content: goal })
      const ok = { role: 'assistant', content: [{ type: 'text', text: 'done' }], stopReason: 'end_turn' }
      this.state.messages.push(ok)
      this.sub?.({ type: 'message_update', assistantMessageEvent: { type: 'text_delta', delta: 'done.' } })
      this.sub?.({ type: 'turn_end', message: ok, toolResults: [] })
      this.sub?.({ type: 'agent_end', messages: [ok] })
    }
  }
  return { Agent, shouldCompact: () => false, DEFAULT_COMPACTION_SETTINGS: {} }
})

import type { UIEvent } from '@swarm/protocol'
import { applyEvent } from '@shared/lib/apply-event'
import type { AgentRunnerDeps } from './agent-runner'
import { createAgentRunner } from './agent-runner'

const deps = (emit: (event: string, data: unknown) => void): AgentRunnerDeps =>
  ({
    correlationId: 'r-shape',
    attachments: [],
    budget: { calls: 100, wallMs: 60000, usdCents: 1000, tokens: 1e9 },
    permissionMode: 'full',
    provider: { model: 'test', apiStyle: 'anthropic', apiKey: 'k' } as never,
    agentDefinition: { id: 'default', systemPrompt: 'sys', toolScope: 'all', maxIterations: 25 } as never,
    sessionId: 'ses-shape',
    emit,
    permissionRegistry: { request: async () => 'grant', resolve: () => {} } as never,
    toolRegistry: { resolve: () => ({ tools: [], riskOf: () => 'low' }) } as never,
    initialMessages: [{ role: 'user', content: 'do it' }] as never,
    spawnChild: async () => ({ childTaskId: 'c', result: { summary: '', artifacts: [] } }),
  }) as AgentRunnerDeps

describe('task.complete wire shape', () => {
  it('emits a flat summary that the real renderer reducer stores on the RunRecord', async () => {
    const emitted: Array<{ event: string; data: Record<string, unknown> }> = []
    const runner = createAgentRunner(deps((event, data) => emitted.push({ event, data: data as Record<string, unknown> })))
    await runner.run()

    const complete = emitted.find((e) => e.event === 'task.complete')
    expect(complete).toBeDefined()
    // Flat shape per protocol ui.ts — no nested result.*.
    expect(complete!.data.summary).toBe('done.')
    expect('result' in complete!.data).toBe(false)

    // Round-trip the REAL emitted payload through the REAL reducer: this is the
    // cross-layer drift the old fabricated-shape tests missed.
    const created: UIEvent = {
      kind: 'task.created',
      sessionId: 'ses-shape',
      taskId: 'r-shape',
      goal: 'do it',
      ts: 1,
    }
    const wire = { kind: 'task.complete', sessionId: 'ses-shape', ...complete!.data } as UIEvent
    const rows = applyEvent(applyEvent([], created), wire)
    expect(rows[0].status).toBe('completed')
    expect(rows[0].summary).toBe('done.')
  })
})
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd apps/desktop && npm test -- src/service/session/agent-runner.complete-shape.test.ts`
Expected: FAIL — `complete.data.summary` is `undefined` (payload has nested `result` instead), and `rows[0].summary` is `undefined`.

- [ ] **Step 3: Fix the emitter**

In `apps/desktop/src/service/session/agent-runner.ts` (translator `agent_end`, lines 524-525), change:

```ts
        const summary = assembledSummary.trim() || `Completed task ${taskId}.`
        emit('task.complete', { taskId, result: { summary, artifacts: [] }, ts: Date.now() })
```

to:

```ts
        const summary = assembledSummary.trim() || `Completed task ${taskId}.`
        emit('task.complete', { taskId, summary, ts: Date.now() })
```

- [ ] **Step 4: Update the one nested-shape consumer and the fixtures**

4a. `apps/desktop/src/service/gmail/analyze.ts:59-61` — change:

```ts
      } else if (event === 'task.complete') {
        const markdown = (obj.result as { summary?: string } | undefined)?.summary ?? ''
```

to:

```ts
      } else if (event === 'task.complete') {
        const markdown = typeof obj.summary === 'string' ? obj.summary : ''
```

4b. Fixtures. Decision rule: update ONLY object literals passed as the payload of `emit('task.complete', …)` / event-list entries with `event: 'task.complete'`. Do NOT touch `spawnChild`/`createTask` mock RETURN values (`{ childTaskId: …, result: { summary … } }` — that is the TaskResult contract, unchanged). Locate candidates first:

```bash
grep -rn "task.complete" apps/desktop/src --include="*.test.ts"
```

Exact edits:

- `apps/desktop/src/service/gmail/analyze.test.ts:40`:
  old: `{ event: 'task.complete', data: { taskId: 'm1', result: { summary: '## 摘要\n测试', artifacts: [] }, ts: 3 } },`
  new: `{ event: 'task.complete', data: { taskId: 'm1', summary: '## 摘要\n测试', ts: 3 } },`
- `apps/desktop/src/service/session/manager.test.ts:569`:
  old: `deps.emit('task.complete', { result: { summary: 'hi', artifacts: [] }, ts: 2 })`
  new: `deps.emit('task.complete', { summary: 'hi', ts: 2 })`
- `apps/desktop/src/service/e2e/unified-runs.e2e.test.ts:20` — inside its fake runner's `emit('task.complete', …)` payload:
  old: `result: { summary: 'done', artifacts: [] },`
  new: `summary: 'done',`
- `apps/desktop/src/service/e2e/agent-driven-verify.e2e.test.ts:25` — same pattern:
  old: `result: { summary: 'done', artifacts: [] },`
  new: `summary: 'done',`
- `apps/desktop/src/service/e2e/multi-level-verify.e2e.test.ts:64` — same pattern:
  old: `result: { summary: \`${deps.agentDefinition.id}: done\`, artifacts: [] },`
  new: `summary: \`${deps.agentDefinition.id}: done\`,`

For each of the three e2e lines, confirm the enclosing expression is an `emit('task.complete', …)` call before editing; if a line is actually a spawnChild return value, leave it and note it in the commit body.

- [ ] **Step 5: Run the affected suites, then the full desktop suite**

Run: `cd apps/desktop && npm test -- src/service/session src/service/gmail src/service/e2e src/shared`
Expected: PASS. If any test still asserts the nested shape, it is a missed fixture from Step 4's grep — fix it with the same rule.

- [ ] **Step 6: Format and commit**

```bash
npx biome check --write apps/desktop/src/service/session/agent-runner.ts apps/desktop/src/service/session/agent-runner.complete-shape.test.ts apps/desktop/src/service/gmail/analyze.ts apps/desktop/src/service/gmail/analyze.test.ts apps/desktop/src/service/session/manager.test.ts apps/desktop/src/service/e2e/unified-runs.e2e.test.ts apps/desktop/src/service/e2e/agent-driven-verify.e2e.test.ts apps/desktop/src/service/e2e/multi-level-verify.e2e.test.ts
git add apps/desktop/src/service/session/agent-runner.ts apps/desktop/src/service/session/agent-runner.complete-shape.test.ts apps/desktop/src/service/gmail/analyze.ts apps/desktop/src/service/gmail/analyze.test.ts apps/desktop/src/service/session/manager.test.ts apps/desktop/src/service/e2e/unified-runs.e2e.test.ts apps/desktop/src/service/e2e/agent-driven-verify.e2e.test.ts apps/desktop/src/service/e2e/multi-level-verify.e2e.test.ts
git commit -m "fix(runner): emit task.complete with flat summary matching protocol + reducer

The emitter nested summary under result.* while ui.ts declares it flat
and applyEvent reads e.summary — RunRecord.summary was always empty in
production. Fixtures updated to the real emitted shape; new regression
test round-trips the real payload through the real reducer. Spec: bug
ledger #2."
```

---

### Task 3: One terminal event per run — suppress the translator's terminal on aborted runs

pi ALWAYS ends with `agent_end`; on abort (cancel/budget/max-iterations/context) its messages carry `stopReason: 'aborted'`, which the translator ignores — so it emits `task.complete`, and then `promptOnce`'s stopCause branch emits `task.error`. Two terminals per aborted run: the first-wins live `terminalRegistry` records `completed` while the UI and post-restart replay record `cancelled`/`failed`.

All abort causes route through `stopCause` (every `agent.abort()` caller sets it; the manager cancels via AbortController → the signal listener sets `'cancelled'`), so `promptOnce` owns the terminal for every aborted run — the translator just needs to stand down. No fallback branch is needed in `promptOnce`: `AgentSession.abort()` (the only cause-less abort) has no production caller.

**Files:**
- Modify: `apps/desktop/src/service/session/agent-runner.ts` (translator: ~434-438 `captureFailure`, ~505-527 `agent_end`, ~537-539 `resetError`)
- Test: `apps/desktop/src/service/session/agent-runner.test.ts`

**Interfaces:**
- Consumes: `installAgent()` helper and `baseDeps`/`mkTask` in `agent-runner.test.ts`; Task 2's flat `task.complete` emit (this task's snippets show the post-Task-2 code).
- Produces: invariant "exactly one terminal (`task.complete` XOR `task.error`) per run attempt". W1's new translator inherits this contract (it never emits terminals at all).

- [ ] **Step 1: Write the failing test**

Add inside the `describe('AgentRunner', ...)` block of `agent-runner.test.ts`, right after the `'aborts the agent and returns status cancelled when the provided signal fires'` test:

```ts
  it('emits exactly one terminal event when the run is aborted (no task.complete before task.error)', async () => {
    const h = installAgent()
    const emitted: Array<{ event: string; data: unknown }> = []
    const ac = new AbortController()
    const runner = createAgentRunner({
      ...baseDeps(mkTask('t-abort-once')),
      signal: ac.signal,
      emit: (event, data) => emitted.push({ event, data }),
    })
    const p = runner.run()
    await Promise.resolve()

    ac.abort()
    // Real pi ends an aborted run with agent_end whose messages carry
    // stopReason 'aborted' (agent-loop.js) — the mock must reproduce that,
    // because this is exactly what production sees and the old tests never
    // simulated.
    h.emitEvent({ type: 'agent_end', messages: [{ role: 'assistant', content: [], stopReason: 'aborted' }] })
    h.resolvePrompt()

    const out = await p
    expect(out.status).toBe('cancelled')
    const terminals = emitted.filter((e) => e.event === 'task.complete' || e.event === 'task.error')
    expect(terminals).toHaveLength(1)
    expect(terminals[0].event).toBe('task.error')
    expect((terminals[0].data as { error: { code: string } }).error.code).toBe('cancelled')
  })
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd apps/desktop && npm test -- src/service/session/agent-runner.test.ts`
Expected: FAIL — `terminals` has length 2 (`task.complete` then `task.error`).

- [ ] **Step 3: Implement the suppression**

All edits in `apps/desktop/src/service/session/agent-runner.ts`, inside `createEventTranslator`:

3a. Add the flag next to `errorMessage` (after line ~412):

```ts
  let errorMessage: string | null = null
  // pi stamps aborted runs' messages with stopReason 'aborted'. The terminal
  // for every abort cause (cancel/budget/iterations/context) is owned by
  // promptOnce's stopCause branches — the translator must emit NEITHER
  // task.complete NOR task.error for an aborted turn.
  let sawAborted = false
```

3b. Extend `captureFailure` (lines ~434-438):

```ts
  const captureFailure = (m: { stopReason?: string; errorMessage?: string } | undefined): void => {
    if (m?.stopReason === 'error') {
      errorMessage = m.errorMessage ?? 'The model request failed without a message.'
    } else if (m?.stopReason === 'aborted') {
      sawAborted = true
    }
  }
```

3c. In the `agent_end` case, after the `if (errorMessage) { ... return }` block and before the `const summary = ...` line, add:

```ts
        // An aborted run's terminal is emitted by promptOnce (with the real
        // cause); emitting a completion here double-terminates the run and
        // poisons the first-wins terminal registry.
        if (sawAborted) return
```

3d. Reset the flag per turn in `resetError` (lines ~537-539):

```ts
  const resetError = (): void => {
    errorMessage = null
    sawAborted = false
  }
```

- [ ] **Step 4: Run the session suites to verify pass + no regression**

Run: `cd apps/desktop && npm test -- src/service/session`
Expected: PASS — the new test, plus all existing runner/manager/retry/fallback/resident tests (completed runs still emit `task.complete` exactly once; the retry suite's suppress-error behavior is untouched).

- [ ] **Step 5: Format and commit**

```bash
npx biome check --write apps/desktop/src/service/session/agent-runner.ts apps/desktop/src/service/session/agent-runner.test.ts
git add apps/desktop/src/service/session/agent-runner.ts apps/desktop/src/service/session/agent-runner.test.ts
git commit -m "fix(runner): suppress translator terminal on aborted runs

pi ends aborted runs with agent_end + stopReason 'aborted'; the
translator emitted task.complete before promptOnce's task.error, so
cancelled/budget/max-iterations runs double-terminated and the live
terminal registry recorded 'completed' for them. promptOnce owns the
terminal for every abort cause. Spec: bug ledger #1."
```

---

### Task 4: Full gate and integration

**Files:** none (verification + merge).

**Interfaces:**
- Consumes: the three commits above.
- Produces: `worktree-w0-runner-hotfixes` merged into `develop` (ff-only), worktree removed.

- [ ] **Step 1: Full test gate**

Run at the repo root: `npm test`
Expected: all packages green. If turbo typecheck ran earlier and left stray artifacts, delete `**/*.tsbuildinfo` before re-running typecheck.

- [ ] **Step 2: Verify end-to-end behavior (superpowers:verification-before-completion)**

The reducer round-trip test (Task 2) covers summary rendering; run the desktop app only if a manual smoke is requested. Confirm with evidence: paste the passing test-run summary into the completion report.

- [ ] **Step 3: Integrate (superpowers:finishing-a-development-branch)**

```bash
git -C <main-checkout> status   # must be clean before ff-only merge (house rule)
git rebase develop
git checkout develop && git merge --ff-only worktree-w0-runner-hotfixes
```

Then remove the worktree. If `pnpm install` ever ran inside the worktree, repair main's symlinks: `CI=true pnpm --dir <main-checkout> install --frozen-lockfile`.
