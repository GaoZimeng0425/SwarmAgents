# Runner / Task Decoupling (Phase 1) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Remove `task: Task` from `AgentRunnerDeps` so `AgentRunner` is a pure agent-execution engine that does not depend on the `Task` domain concept — behavior-preserving.

**Architecture:** Expand-then-contract. Make `task` optional and add 9 explicit run-context fields; introduce a `resolveRunContext(deps)` adapter that the runner body reads from (so the 73 `task.X` references keep working unchanged, sourced from the new fields with a temporary fallback to `task`); migrate every caller and sub-run to pass the new fields; then contract — delete `task`, make the new fields required, drop the fallback. Each task leaves the full suite green.

**Tech Stack:** TypeScript, `vitest`, `better-sqlite3`, Electron (test runner), `@earendil-works/pi-agent-core`, `@swarm/protocol`.

## Global Constraints

- **Spec:** `docs/superpowers/specs/2026-07-02-runner-task-decoupling-design.md` (the authoritative design; this plan implements it).
- **Run tests via `npm test`** (Electron node runner). NEVER bare `npx vitest`, NEVER `pnpm rebuild better-sqlite3` (breaks app ABI; restore with `npm run postinstall`).
- **Behavior must not change.** Every task ends with the full suite green — the existing tests are the safety net (this is refactor-under-test, not new-feature TDD). No new behavioral tests except the decoupling guard in Task 7.
- **Comments and commit messages in English.**
- **Scoped formatting:** `npx biome check --write <file>` (the repo's `pnpm check`/`format` rewrite the whole tree).
- **Pre-commit in the worktree** needs `node_modules` symlinked to the main checkout (already done in this worktree; if a fresh worktree, run `ln -s /Users/gaozimeng/Learn/macOS/SwarmAgents/node_modules node_modules` first).
- **One commit per task**, on branch `worktree-runner-task-decouple`. Integrate to `develop` via `git rebase develop` + `git merge --ff-only`.

## File Structure

- **Modify** `apps/desktop/src/service/session/agent-runner.ts` — remove `task` from `AgentRunnerDeps`; add `RunContext` + `resolveRunContext`; re-source all `task.X` reads via the resolver; rewrite the two sub-runs (vision, verify) to construct deps explicitly.
- **Modify** `apps/desktop/src/service/session/manager.ts` — 3 call sites (top-level :878, `spawnChild` :598, resident :422) pass the new fields instead of `task`.
- **Modify** the 5 runner test files — replace `task: mkTask(...)` with the new fields.
- **Add** one decoupling-guard test.

No new files except the guard test (folded into an existing test file).

---

### Task 1: Make `task` optional, add run-context fields + resolver, wire `buildAgentSession`

**Files:**
- Modify: `apps/desktop/src/service/session/agent-runner.ts` (the `AgentRunnerDeps` type ~:186-270; `buildAgentSession` ~:584-585).

**Interfaces:**
- Produces: `RunContext` type, `resolveRunContext(deps)` helper, and 9 new optional fields on `AgentRunnerDeps`. `task` becomes optional. Later tasks rely on `resolveRunContext` existing and `task` being optional.

- [ ] **Step 1: Add the 9 optional run-context fields and make `task` optional**

In `AgentRunnerDeps`, change `task: Task` → `task?: Task` and add these fields (place them right after `task`):

```ts
export type AgentRunnerDeps = {
  /** @deprecated being removed — pass the explicit fields below instead. */
  task?: Task
  /** Opaque run id: emitted as `taskId` on every event, used as the spawnChild
   *  parent id. Replaces task.id. The runner does NOT interpret it. */
  correlationId?: string
  /** Working directory. Replaces task.cwd. */
  cwd?: string
  /** Objective text — seeds the first user turn and the verify/criteria prompts.
   *  Replaces task.goal. (Phase-3 folds this into initialMessages.) */
  goal?: string
  /** Replaces task.executionMode. */
  executionMode?: 'goal' | 'plan'
  /** Replaces task.budget. */
  budget?: BudgetConfig
  /** Per-invocation tool override. Replaces task.toolAllowlist. */
  toolAllowlist?: string[]
  /** Replaces task.attachments. */
  attachments?: Attachment[]
  /** Fallback when getPermissionMode is absent. Replaces task.permissionMode. */
  permissionMode?: PermissionMode
  /** Replaces task.acceptanceCriteria. */
  acceptanceCriteria?: AcceptanceCriterion[]
  // ...all existing fields unchanged below (provider, agentDefinition, sessionId, emit, ...)
```

- [ ] **Step 2: Add the `RunContext` type and `resolveRunContext` helper**

Add just above `buildAgentSession` (~:584):

```ts
// The subset of the legacy Task the runner body reads. Resolved once per entry
// point from the explicit deps (preferred) with a temporary fallback to the
// deprecated `task` field. Task 7 removes the fallback and makes the fields
// required. Keeping the resolved local named `task` means the body's ~73
// `task.id` / `task.goal` / `task.budget` references need no edits.
type RunContext = {
  id: string
  cwd?: string
  goal: string
  executionMode?: 'goal' | 'plan'
  budget: BudgetConfig
  toolAllowlist?: string[]
  attachments?: Attachment[]
  permissionMode?: PermissionMode
  acceptanceCriteria?: AcceptanceCriterion[]
}

function resolveRunContext(deps: AgentRunnerDeps): RunContext {
  const t = deps.task
  return {
    id: (deps.correlationId ?? t?.id) as string,
    cwd: deps.cwd ?? t?.cwd,
    goal: (deps.goal ?? t?.goal) as string,
    executionMode: deps.executionMode ?? t?.executionMode,
    budget: (deps.budget ?? t?.budget) as BudgetConfig,
    toolAllowlist: deps.toolAllowlist ?? t?.toolAllowlist,
    attachments: deps.attachments ?? t?.attachments,
    permissionMode: deps.permissionMode ?? t?.permissionMode,
    acceptanceCriteria: deps.acceptanceCriteria ?? t?.acceptanceCriteria,
  }
}
```

The `as` casts are safe during the migration: every caller passes either `task` or the explicit fields. They are removed in Task 7.

- [ ] **Step 3: Wire `buildAgentSession` to read via the resolver**

At `buildAgentSession` (~:585), replace:

```ts
const { task, provider, agentDefinition, sessionId, emit, permissionRegistry, initialMessages, toolRegistry } = deps
```

with:

```ts
const { provider, agentDefinition, sessionId, emit, permissionRegistry, initialMessages, toolRegistry } = deps
const task = resolveRunContext(deps)
```

The body below still reads `task.id`, `task.goal`, `task.budget` — now sourced from the resolver. No other body edits.

- [ ] **Step 4: Typecheck + test**

Run: `npm test -- agent-runner.test`
Expected: PASS (callers still pass `task`, so the resolver falls back to it; behavior identical).

Run: `npx biome check --write apps/desktop/src/service/session/agent-runner.ts`

- [ ] **Step 5: Commit**

```bash
git add apps/desktop/src/service/session/agent-runner.ts
git commit -m "refactor(runner): add run-context resolver, make task optional

Introduces resolveRunContext(deps) + RunContext; buildAgentSession reads
via the resolver with a temporary fallback to the now-optional task.
Behavior unchanged. First step of task decoupling."
```

---

### Task 2: Wire `createAgentRunner.run`, `runResident`, `buildToolContext` to the resolver

**Files:**
- Modify: `apps/desktop/src/service/session/agent-runner.ts` — `createAgentRunner.run` (:1347-1407), `runResident` (:1429-1437), `buildToolContext` (:308-334).

**Interfaces:**
- Consumes: `resolveRunContext` from Task 1.
- Produces: all runner entry points source `task.X` via the resolver (not `deps.task.X`).

- [ ] **Step 1: Wire `createAgentRunner.run`**

At the top of `run()` (right after `async run() {`, ~:1349) add:

```ts
const task = resolveRunContext(deps)
```

Then in the `run()` body replace every `deps.task.X` with `task.X`:
- `deps.task.attachments` → `task.attachments` (:1350)
- `deps.task.id` → `task.id` (:1356, :1372, :1376, :1403)
- `deps.task.executionMode` → `task.executionMode` (:1360)
- `deps.task.goal` → `task.goal` (:1362, :1386, :1389, :1396)
- `deps.task.acceptanceCriteria` → `task.acceptanceCriteria` (:1367)
- `deps.task.cwd` → `task.cwd` (:1401)

Leave `deps.emit`, `deps.maxVerifyRounds`, `deps.onAcceptanceCriteria`, `deps.verifyCompletion` etc. untouched.

- [ ] **Step 2: Wire `runResident`**

At `runResident` (~:1435) add `const task = resolveRunContext(deps)` after the `residentLog` line, and change :1437 `taskId: deps.task.id` → `taskId: task.id`.

- [ ] **Step 3: Wire `buildToolContext`**

In `buildToolContext` (:308-334) add `const ctx = resolveRunContext(deps)` at the top and replace:
- `deps.task?.id` → `ctx.id` (:311)
- `deps.task?.cwd` → `ctx.cwd` (:312)
- `deps.spawnChild(deps.task.id, …)` → `deps.spawnChild(ctx.id, …)` (:314)

- [ ] **Step 4: Typecheck + test**

Run: `npm test -- agent-runner`
Expected: PASS.

Run: `npx biome check --write apps/desktop/src/service/session/agent-runner.ts`

- [ ] **Step 5: Commit**

```bash
git add apps/desktop/src/service/session/agent-runner.ts
git commit -m "refactor(runner): source all task.X reads via resolveRunContext

run(), runResident, and buildToolContext no longer read deps.task
directly. Behavior unchanged."
```

---

### Task 3: Rewrite the verify sub-run without `...deps.task`

**Files:**
- Modify: `apps/desktop/src/service/session/agent-runner.ts` — `defaultVerifyCompletion` (:1200-1251).

**Interfaces:** Consumes `resolveRunContext` (Task 1). After this, the verify sub-run passes explicit fields and omits `task`.

- [ ] **Step 1: Replace the verifier sub-run construction**

In `defaultVerifyCompletion`, replace the block at :1204-1234 (the `verifierTask` + `createAgentRunner({ task: verifierTask, … })`) with:

```ts
const ctx = resolveRunContext(deps)
const runner = createAgentRunner({
  correlationId: `${ctx.id}:verify`,
  cwd: ctx.cwd,
  goal: buildJudgePrompt(ctx.goal, soft, sum),
  executionMode: 'goal',
  budget: ctx.budget,
  toolAllowlist: [],
  attachments: [],
  acceptanceCriteria: undefined,
  permissionMode: ctx.permissionMode,
  provider: deps.provider,
  agentDefinition: {
    id: 'verifier',
    name: 'Verifier',
    description: 'Independent completion verifier.',
    systemPrompt: VERIFIER_SYSTEM_PROMPT,
    toolScope: 'all',
    maxIterations: 2,
  },
  sessionId: deps.sessionId,
  emit: () => undefined,
  permissionRegistry: deps.permissionRegistry,
  toolRegistry: deps.toolRegistry,
  initialMessages: [],
  spawnChild: deps.spawnChild,
  signal: deps.signal,
  fallbackProviders: deps.fallbackProviders,
  maxVerifyRounds: 0, // never recurse
})
```

- [ ] **Step 2: Replace the remaining `deps.task` reads in this function**

- :1239 `taskId: deps.task.id` → `taskId: ctx.id` (move the `const ctx` declaration above the `judge` arrow if needed so `ctx` is in scope at the `parseVerdict` warning).
- :1247 `deps.getPermissionMode?.() ?? deps.task.permissionMode ?? 'ask'` → `deps.getPermissionMode?.() ?? ctx.permissionMode ?? 'ask'`.

Put `const ctx = resolveRunContext(deps)` at the top of the returned async fn (before `judge`), so it's in scope everywhere.

- [ ] **Step 3: Typecheck + test**

Run: `npm test -- agent-runner`
Expected: PASS.

Run: `npx biome check --write apps/desktop/src/service/session/agent-runner.ts`

- [ ] **Step 4: Commit**

```bash
git add apps/desktop/src/service/session/agent-runner.ts
git commit -m "refactor(runner): verify sub-run constructs deps explicitly

Drops the ...deps.task spread; passes the explicit run-context fields.
Behavior unchanged."
```

---

### Task 4: Rewrite the vision sub-run without `...deps.task`

**Files:**
- Modify: `apps/desktop/src/service/session/agent-runner.ts` — `buildAnalyzeImage` (:343-385).

**Interfaces:** After this, the vision sub-run also omits `task`.

- [ ] **Step 1: Replace the vision sub-run construction**

In `buildAnalyzeImage`, replace the `visionTask` + `createAgentRunner({ task: visionTask, … })` block (:352-381) with explicit fields. Use the parent's resolved context for `cwd`/`budget`/`permissionMode`:

```ts
const ctx = resolveRunContext(deps)
const runner = createAgentRunner({
  correlationId: `${ctx.id}:vision`,
  cwd: ctx.cwd,
  goal: prompt,
  executionMode: 'goal',
  budget: ctx.budget,
  toolAllowlist: [],
  attachments: [{ data: image.data, mimeType: image.mimeType }],
  permissionMode: ctx.permissionMode,
  provider: vision,
  agentDefinition: {
    id: 'vision',
    name: 'Vision',
    description: 'One-shot vision/OCR sub-call.',
    systemPrompt: VISION_SYSTEM_PROMPT,
    toolScope: 'all',
    maxIterations: 2,
  },
  sessionId: deps.sessionId,
  emit: () => undefined,
  permissionRegistry: deps.permissionRegistry,
  toolRegistry: deps.toolRegistry,
  initialMessages: [],
  spawnChild: deps.spawnChild,
  signal: deps.signal,
})
```

- [ ] **Step 2: Typecheck + test**

Run: `npm test -- agent-runner`
Expected: PASS.

Run: `npx biome check --write apps/desktop/src/service/session/agent-runner.ts`

- [ ] **Step 3: Commit**

```bash
git add apps/desktop/src/service/session/agent-runner.ts
git commit -m "refactor(runner): vision sub-run constructs deps explicitly

Drops the ...deps.task spread. No call site inside the runner now
references deps.task."
```

---

### Task 5: Migrate the three `manager.ts` call sites

**Files:**
- Modify: `apps/desktop/src/service/session/manager.ts` — top-level run (:878-899), `spawnChild` (:598-619), resident deps (:422-441).

**Interfaces:** Consumes the new optional fields from Task 1. Each site passes them and drops `task:`. `manager.test` stays green.

- [ ] **Step 1: Migrate the top-level run (:878)**

Replace `task,` with the explicit fields. Change:

```ts
const runner = createAgentRunner({
  task,
  provider: session.provider,
```

to:

```ts
const runner = createAgentRunner({
  correlationId: task.id,
  cwd: task.cwd,
  goal: task.goal,
  executionMode: task.executionMode,
  budget: task.budget,
  toolAllowlist: task.toolAllowlist,
  attachments: task.attachments,
  permissionMode: task.permissionMode,
  acceptanceCriteria: task.acceptanceCriteria,
  provider: session.provider,
```

(Leave the rest of the object — `agentDefinition`, `sessionId`, `emit`, `initialMessages`, `saveSnapshot`, `spawnChild`, etc. — unchanged.)

- [ ] **Step 2: Migrate `spawnChild` (:598)**

Same pattern: replace `task: childTask,` with:

```ts
correlationId: childTask.id,
cwd: childTask.cwd,
goal: childTask.goal,
executionMode: childTask.executionMode,
budget: childTask.budget,
toolAllowlist: childTask.toolAllowlist,
attachments: childTask.attachments,
permissionMode: childTask.permissionMode,
acceptanceCriteria: childTask.acceptanceCriteria,
```

- [ ] **Step 3: Migrate the resident deps (:422)**

Replace `task,` with:

```ts
correlationId: task.id,
cwd: task.cwd,
goal: task.goal,
executionMode: task.executionMode,
budget: task.budget,
toolAllowlist: task.toolAllowlist,
attachments: task.attachments,
permissionMode: task.permissionMode,
acceptanceCriteria: task.acceptanceCriteria,
```

- [ ] **Step 4: Typecheck + test**

Run: `npm test -- manager.test`
Expected: PASS (manager constructs tasks internally and now passes the fields; the runner resolver still falls back to `task` only if passed — none of these pass it now, but tests that call `createAgentRunner` directly still pass `task`, so the fallback path remains covered).

Run: `npx biome check --write apps/desktop/src/service/session/manager.ts`

- [ ] **Step 5: Commit**

```bash
git add apps/desktop/src/service/session/manager.ts
git commit -m "refactor(manager): pass explicit run-context fields to runner

The three call sites (top-level, spawnChild, resident) no longer pass
task; they pass the 9 explicit fields. Behavior unchanged."
```

---

### Task 6: Migrate the five runner test files

**Files:**
- Modify: `apps/desktop/src/service/session/agent-runner.test.ts`, `agent-runner.prompt-error.test.ts`, `agent-runner.retry.test.ts`, `agent-runner.fallback.test.ts`, `agent-runner.resident.test.ts`.

**Interfaces:** Tests stop passing `task`; they pass the explicit fields. After this, no caller passes `task` anywhere.

- [ ] **Step 1: Add a shared run-context helper to `agent-runner.test.ts`**

Each test file has a `mkTask(id)` builder (e.g. `agent-runner.test.ts:43-60`). Add a sibling helper that expands a `Task` into the explicit fields, so the diff per test is one line:

```ts
// Spread onto the createAgentRunner(...) arg instead of passing task: mkTask(id).
const runCtxFrom = (t: Task) => ({
  correlationId: t.id,
  cwd: t.cwd,
  goal: t.goal,
  executionMode: t.executionMode,
  budget: t.budget,
  toolAllowlist: t.toolAllowlist,
  attachments: t.attachments,
  permissionMode: t.permissionMode,
  acceptanceCriteria: t.acceptanceCriteria,
})
```

(`mkTask` is kept for now; it is removed in Task 7.)

- [ ] **Step 2: Replace `task: mkTask(...)` in every test**

In each of the 5 files, every `createAgentRunner({ task: mkTask('…'), … })` becomes `createAgentRunner({ ...runCtxFrom(mkTask('…')), … })`. Run a scoped search to find them all:

```bash
rg -n "task: mkTask" apps/desktop/src/service/session/agent-runner*.test.ts
```

Replace each occurrence. Do NOT change any assertion — only the deps construction.

- [ ] **Step 3: Test**

Run: `npm test -- agent-runner`
Expected: PASS (all 5 files).

Run: `npx biome check --write apps/desktop/src/service/session/agent-runner*.test.ts`

- [ ] **Step 4: Commit**

```bash
git add apps/desktop/src/service/session/agent-runner*.test.ts
git commit -m "test(runner): pass explicit run-context fields instead of task

All runner tests use ...runCtxFrom(mkTask(...)). No caller anywhere
now passes the deprecated task field."
```

---

### Task 7: Contract — remove `task`, make the new fields required, add the decoupling guard

**Files:**
- Modify: `apps/desktop/src/service/session/agent-runner.ts` — `AgentRunnerDeps`, `resolveRunContext`, `RunContext`.
- Modify: the 5 test files — drop `mkTask` + the `Task` import where no longer used.
- Modify: `apps/desktop/src/service/session/agent-runner.decouple.test.ts` (new guard, or fold into the existing test file).

**Interfaces:** Completes the decoupling. `AgentRunnerDeps` has no `task`; TypeScript enforces that no `deps.task` reference can survive.

- [ ] **Step 1: Remove `task` and make the run-context fields required**

In `AgentRunnerDeps`, delete the `task?: Task` line (and its doc comment). Change the 9 fields from optional to required (drop the `?`):

```ts
export type AgentRunnerDeps = {
  correlationId: string
  cwd?: string             // stays optional — matches the old task.cwd?: string
  goal: string
  executionMode?: 'goal' | 'plan'  // stays optional (runner defaults to 'goal')
  budget: BudgetConfig
  toolAllowlist?: string[]         // stays optional
  attachments?: Attachment[]       // stays optional
  permissionMode?: PermissionMode  // stays optional
  acceptanceCriteria?: AcceptanceCriterion[]  // stays optional
  // ...existing fields unchanged
```

(Only `correlationId`, `goal`, `budget` become required — they were non-optional on `Task` too. The rest mirror `Task`'s optionality.)

- [ ] **Step 2: Simplify `resolveRunContext` (drop the fallback + casts)**

```ts
function resolveRunContext(deps: AgentRunnerDeps): RunContext {
  return {
    id: deps.correlationId,
    cwd: deps.cwd,
    goal: deps.goal,
    executionMode: deps.executionMode,
    budget: deps.budget,
    toolAllowlist: deps.toolAllowlist,
    attachments: deps.attachments,
    permissionMode: deps.permissionMode,
    acceptanceCriteria: deps.acceptanceCriteria,
  }
}
```

- [ ] **Step 3: Drop the now-unused `Task` import and `mkTask` from tests**

If `agent-runner.ts` no longer references the `Task` type (the two sub-runs were rewritten in Tasks 3-4), remove `Task` from its `@swarm/protocol` import. In each test file, `mkTask` and the `Task` import are now unused (`runCtxFrom` can build the object literal directly) — remove them, and inline the fields. Concretely, replace `...runCtxFrom(mkTask('t-1'))` with a small inline literal per test (or keep `runCtxFrom` taking a minimal `{ id, goal, budget }`). Simplest: keep `runCtxFrom` but change it to take `{ id = 't-1', goal = 'test goal', budget = … }`.

- [ ] **Step 4: Add the decoupling guard test**

Add to `agent-runner.test.ts`:

```ts
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'

it('agent-runner.ts no longer references the Task domain concept', () => {
  const src = readFileSync(
    resolve(__dirname, 'agent-runner.ts'),
    'utf8'
  )
  expect(src).not.toMatch(/deps\.task\b/)
  expect(src).not.toMatch(/\btask: Task\b/)
})
```

This prevents any future change from re-introducing a `task` dependency.

- [ ] **Step 5: Full suite**

Run: `npm test`
Expected: PASS (full suite — this is the phase-1 acceptance gate).

Run: `npx biome check --write apps/desktop/src/service/session/agent-runner.ts apps/desktop/src/service/session/agent-runner*.test.ts`

- [ ] **Step 6: Commit**

```bash
git add apps/desktop/src/service/session/
git commit -m "refactor(runner): remove task from AgentRunnerDeps (Phase 1 complete)

task is gone; correlationId/goal/budget are required, the rest mirror
Task optionality. Adds a guard test asserting agent-runner.ts never
references deps.task or 'task: Task'. AgentRunner is now a pure agent
engine with no Task dependency."
```

---

## Self-Review

**Spec coverage** (against `2026-07-02-runner-task-decoupling-design.md`):
- §4 new `AgentRunnerDeps` (task removed, 9 fields) → Tasks 1 + 7. ✓
- §4 mapping (compiler-enforced) → Task 7 step 1 (removing the type flags every survivor). ✓
- §5 sub-run construction (vision/verify, no spread) → Tasks 3 + 4. ✓
- §6 call-site migration (3 manager sites) → Task 5. ✓
- §7 behavior preservation (verify loop stays, param-driven) → Task 2 wires `run()` to read `task.executionMode`/`task.acceptanceCriteria`/`task.goal` from the resolver; logic untouched. ✓
- §8 test strategy (5 files updated; guard test) → Tasks 6 + 7. ✓
- §9 verification (`npm test` green) → every task's gate + Task 7 step 5 full suite. ✓
- §10 rollback (single-branch, ff-only) → Global Constraints. ✓

**Placeholder scan:** none — every step has concrete code or an exact search-and-replace with line refs.

**Type consistency:** `resolveRunContext` returns `RunContext` with fields `id / cwd / goal / executionMode / budget / toolAllowlist / attachments / permissionMode / acceptanceCriteria`; the body reads exactly those names (`task.id`, `task.goal`, `task.budget`, …), so the `const task = resolveRunContext(deps)` substitution typechecks. The new deps fields use `correlationId` (mapped to `id` by the resolver) — the only rename, applied consistently in Tasks 1, 3, 4, 5, 6, 7.

**One risk noted:** Task 5 step 4 — after migrating the 3 manager sites, the runner's `task`-fallback path is only exercised by tests that still pass `task` (until Task 6). That is fine: the fallback exists precisely for the transition, and Task 6 removes the last `task`-passing callers. The full suite stays green throughout.
