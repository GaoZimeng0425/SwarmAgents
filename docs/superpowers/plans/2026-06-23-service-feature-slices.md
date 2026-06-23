# Restructure `src/service` into Feature Slices — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Reorganize the flat `src/service` root into cohesive feature folders (`ipc/`, `actor/`, `session/`, `conversation/`, `memory/`, `cron/`, `e2e/`) with zero behavior change, and delete one dead stub.

**Architecture:** Pure structural move. Each slice = `git mv` the source + its colocated tests into a folder (dropping the redundant filename prefix, per the existing `mcp/manager.ts` convention), then fix relative import specifiers. The TypeScript compiler is the ground truth for "which imports broke" — after every move, `npm run typecheck:node` must report zero errors before committing.

**Tech Stack:** Electron utilityProcess service, TypeScript, Vitest (run via Electron node), Biome.

## Global Constraints

- **Scope is `src/service` only.** No file outside it imports a service internal (verified); `@service` alias and the build entry touch only `src/service/index.ts`. Do not edit anything outside `src/service`.
- **No behavior change.** The test pass/fail set after the refactor must equal the pre-refactor baseline (captured in Task 0).
- **Use `git mv`** for every move so history follows the rename.
- **Verification gate per task:** `npm run typecheck:node` reports 0 errors, AND the slice's tests pass. Run tests with the project's Electron-node runner — never bare `npx vitest`, never `pnpm rebuild better-sqlite3`.
  - Full suite: `npm test`
  - Single dir: `cross-env ELECTRON_RUN_AS_NODE=1 electron node_modules/vitest/vitest.mjs run src/service/<dir>`
- **Convention inside a feature folder:** drop the redundant prefix — the folder is the namespace (`session-manager.ts` → `session/manager.ts`, `actor-mailbox.ts` → `actor/mailbox.ts`). Tests stay colocated and rename to match (`session-manager.actors.test.ts` → `session/manager.actors.test.ts`).
- **How to fix imports each task:** after `git mv`, run `npm run typecheck:node`. It lists every unresolved specifier. Fix each to point at the file's *current* location. The per-task "Expected edits" lists are a guide — `tsc` output is the authority. Same-folder edges (e.g. `conversation/store.ts` importing `./usage-stats`) need no change.

---

### Task 0: Baseline + delete dead code

**Files:**
- Delete: `src/service/tool-state-manager.ts` (17-line Playwright stub, zero references, commit `b774eed`)

- [ ] **Step 1: Capture the test baseline**

Run: `npm test 2>&1 | tail -30`
Record the final summary line (e.g. "Test Files N passed | M skipped", "Tests X passed"). This is the baseline the refactor must preserve.

- [ ] **Step 2: Confirm the stub is truly unreferenced**

Run: `grep -rn "tool-state-manager\|ToolStateManager\|createToolStateManager" src/ | grep -v "src/service/tool-state-manager.ts"`
Expected: no output (exit 1). If anything prints, STOP — it is not dead; report it.

- [ ] **Step 3: Delete it**

```bash
git rm src/service/tool-state-manager.ts
```

- [ ] **Step 4: Verify typecheck still clean**

Run: `npm run typecheck:node`
Expected: 0 errors.

- [ ] **Step 5: Commit**

```bash
git add -A
git commit -m "refactor(service): remove unused ToolStateManager stub"
```

---

### Task 1: `actor/` slice

**Files (git mv):**
- `actor-mailbox.ts` → `actor/mailbox.ts`
- `actor-mailbox.test.ts` → `actor/mailbox.test.ts`
- `actor-state.ts` → `actor/state.ts`
- `actor-state.test.ts` → `actor/state.test.ts`

**Interfaces:** No exported symbols change. Only the module path changes: importers that wrote `./actor-mailbox` / `./actor-state` now resolve `mailbox` / `state` under `actor/`.

- [ ] **Step 1: Move the files**

```bash
cd src/service
mkdir -p actor
git mv actor-mailbox.ts actor/mailbox.ts
git mv actor-mailbox.test.ts actor/mailbox.test.ts
git mv actor-state.ts actor/state.ts
git mv actor-state.test.ts actor/state.test.ts
cd -
```

- [ ] **Step 2: Run typecheck to see what broke**

Run: `npm run typecheck:node`
Expected: errors for unresolved `./actor-mailbox` / `./actor-state` in the files below.

- [ ] **Step 3: Fix imports**

Expected edits (verify against tsc output):
- `actor/mailbox.test.ts`: `./actor-mailbox` → `./mailbox`
- `actor/state.test.ts`: `./actor-state` → `./state`
- `agent-runner.ts`: `./actor-mailbox` → `./actor/mailbox`, `./actor-state` → `./actor/state`
- `session-manager.ts`: `./actor-mailbox` → `./actor/mailbox`, `./actor-state` → `./actor/state`
- `agent-runner.resident.test.ts`: `./actor-mailbox` → `./actor/mailbox`
- `session-manager.cross-dormancy.test.ts`: `./actor-state` → `./actor/state`

- [ ] **Step 4: Verify**

Run: `npm run typecheck:node` → 0 errors.
Run: `cross-env ELECTRON_RUN_AS_NODE=1 electron node_modules/vitest/vitest.mjs run src/service/actor` → pass.

- [ ] **Step 5: Commit**

```bash
git add -A
git commit -m "refactor(service): extract actor/ slice (mailbox, state)"
```

---

### Task 2: `ipc/` slice

**Files (git mv):**
- `broadcaster.ts` → `ipc/broadcaster.ts`
- `broadcaster.test.ts` → `ipc/broadcaster.test.ts`
- `dispatcher.ts` → `ipc/dispatcher.ts`
- `dispatcher.test.ts` → `ipc/dispatcher.test.ts`

**Interfaces:** `createBroadcaster`, `createDispatcher` unchanged.

- [ ] **Step 1: Move the files**

```bash
cd src/service
mkdir -p ipc
git mv broadcaster.ts ipc/broadcaster.ts
git mv broadcaster.test.ts ipc/broadcaster.test.ts
git mv dispatcher.ts ipc/dispatcher.ts
git mv dispatcher.test.ts ipc/dispatcher.test.ts
cd -
```

- [ ] **Step 2: Run typecheck**

Run: `npm run typecheck:node`

- [ ] **Step 3: Fix imports**

Expected edits (verify against tsc output):
- `ipc/broadcaster.test.ts`: `./broadcaster` → `./broadcaster` (same folder — no change)
- `ipc/dispatcher.ts`: `./session-manager` → `../session-manager` (session-manager still at root at this point)
- `ipc/dispatcher.test.ts`: `./dispatcher` → `./dispatcher` (no change); `./session-manager` → `../session-manager`
- `index.ts`: `./broadcaster` → `./ipc/broadcaster`, `./dispatcher` → `./ipc/dispatcher`
- `session-manager.ts`: `./broadcaster` → `./ipc/broadcaster`
- `session-manager.test.ts`: `./broadcaster` → `./ipc/broadcaster`

- [ ] **Step 4: Verify**

Run: `npm run typecheck:node` → 0 errors.
Run: `cross-env ELECTRON_RUN_AS_NODE=1 electron node_modules/vitest/vitest.mjs run src/service/ipc` → pass.

- [ ] **Step 5: Commit**

```bash
git add -A
git commit -m "refactor(service): extract ipc/ slice (dispatcher, broadcaster)"
```

---

### Task 3: `conversation/` slice

**Files (git mv):**
- `conversation-store.ts` → `conversation/store.ts`
- `conversation-store.test.ts` → `conversation/store.test.ts`
- `conversation-store.actor-state.test.ts` → `conversation/store.actor-state.test.ts`
- `conversation-store.actors.test.ts` → `conversation/store.actors.test.ts`
- `usage-stats.ts` → `conversation/usage-stats.ts`
- `usage-stats.test.ts` → `conversation/usage-stats.test.ts`

**Interfaces:** `createConversationStore`, usage-stats exports unchanged.

- [ ] **Step 1: Move the files**

```bash
cd src/service
mkdir -p conversation
git mv conversation-store.ts conversation/store.ts
git mv conversation-store.test.ts conversation/store.test.ts
git mv conversation-store.actor-state.test.ts conversation/store.actor-state.test.ts
git mv conversation-store.actors.test.ts conversation/store.actors.test.ts
git mv usage-stats.ts conversation/usage-stats.ts
git mv usage-stats.test.ts conversation/usage-stats.test.ts
cd -
```

- [ ] **Step 2: Run typecheck**

Run: `npm run typecheck:node`

- [ ] **Step 3: Fix imports**

Note: `conversation/store.ts` imports `./usage-stats` and `conversation/usage-stats.test.ts` imports `./usage-stats` — both same-folder now, **no change**.

Expected edits (verify against tsc output):
- `conversation/store.test.ts`: `./conversation-store` → `./store`
- `conversation/store.actor-state.test.ts`: `./conversation-store` → `./store`
- `conversation/store.actors.test.ts`: `./conversation-store` → `./store`
- `index.ts`: `./conversation-store` → `./conversation/store`
- `cron-scheduler.ts`: `./conversation-store` → `./conversation/store`
- `cron-scheduler.test.ts`: `./conversation-store` → `./conversation/store`
- `session-manager.ts`: `./conversation-store` → `./conversation/store`
- `ipc/dispatcher.test.ts`: `./session-manager` already fixed in Task 2; no conversation import here.
- All root `session-manager.*.test.ts` that import `./conversation-store` → `./conversation/store`: `session-manager.test.ts`, `session-manager.actors.test.ts`, `session-manager.cross-dormancy.test.ts`, `session-manager.deadlock.test.ts`, `session-manager.messaging.test.ts`, `session-manager.redrain.test.ts`, `session-manager.resident.test.ts`, `session-manager.turnslot.test.ts`
- All root e2e tests importing `./conversation-store` → `./conversation/store`: `agent-cluster.e2e.test.ts`, `agent-cluster-runloop.e2e.test.ts`, `company.e2e.test.ts`, `company.startup.test.ts`

- [ ] **Step 4: Verify**

Run: `npm run typecheck:node` → 0 errors.
Run: `cross-env ELECTRON_RUN_AS_NODE=1 electron node_modules/vitest/vitest.mjs run src/service/conversation` → pass.

- [ ] **Step 5: Commit**

```bash
git add -A
git commit -m "refactor(service): extract conversation/ slice (store, usage-stats)"
```

---

### Task 4: `memory/` slice

**Files (git mv):**
- `memory-store.ts` → `memory/store.ts`
- `memory-store.test.ts` → `memory/store.test.ts`

**Interfaces:** `createMemoryStore`, type `MemoryStore` unchanged.

- [ ] **Step 1: Move the files**

```bash
cd src/service
mkdir -p memory
git mv memory-store.ts memory/store.ts
git mv memory-store.test.ts memory/store.test.ts
cd -
```

- [ ] **Step 2: Run typecheck**

Run: `npm run typecheck:node`

- [ ] **Step 3: Fix imports**

Expected edits (verify against tsc output):
- `memory/store.test.ts`: `./memory-store` → `./store`
- `index.ts`: `./memory-store` → `./memory/store`
- `tools/memory.ts`: `../memory-store` → `../memory/store`
- `tools/memory.test.ts`: `../memory-store` → `../memory/store`
- `tools/builtins.ts`: `../memory-store` → `../memory/store`
- `tools/builtins.test.ts`: `../memory-store` → `../memory/store`

- [ ] **Step 4: Verify**

Run: `npm run typecheck:node` → 0 errors.
Run: `cross-env ELECTRON_RUN_AS_NODE=1 electron node_modules/vitest/vitest.mjs run src/service/memory` → pass.

- [ ] **Step 5: Commit**

```bash
git add -A
git commit -m "refactor(service): extract memory/ slice"
```

---

### Task 5: `cron/` slice

**Files (git mv):**
- `cron-scheduler.ts` → `cron/scheduler.ts`
- `cron-scheduler.test.ts` → `cron/scheduler.test.ts`

**Interfaces:** `createCronScheduler`, type `CronScheduler` unchanged.

- [ ] **Step 1: Move the files**

```bash
cd src/service
mkdir -p cron
git mv cron-scheduler.ts cron/scheduler.ts
git mv cron-scheduler.test.ts cron/scheduler.test.ts
cd -
```

- [ ] **Step 2: Run typecheck**

Run: `npm run typecheck:node`

- [ ] **Step 3: Fix imports**

Note: `cron/scheduler.ts` and `cron/scheduler.test.ts` import `./conversation-store` — already rewritten to `./conversation/store` in Task 3; now one folder deeper, so → `../conversation/store`.

Expected edits (verify against tsc output):
- `cron/scheduler.ts`: `./conversation/store` → `../conversation/store`
- `cron/scheduler.test.ts`: `./cron-scheduler` → `./scheduler`; `./conversation/store` → `../conversation/store`
- `index.ts`: `./cron-scheduler` → `./cron/scheduler`
- `tools/cron.ts`: `../cron-scheduler` → `../cron/scheduler`
- `tools/cron.test.ts`: `../cron-scheduler` → `../cron/scheduler`
- `tools/builtins.ts`: `../cron-scheduler` → `../cron/scheduler`
- `tools/builtins.test.ts`: `../cron-scheduler` → `../cron/scheduler`

- [ ] **Step 4: Verify**

Run: `npm run typecheck:node` → 0 errors.
Run: `cross-env ELECTRON_RUN_AS_NODE=1 electron node_modules/vitest/vitest.mjs run src/service/cron` → pass.

- [ ] **Step 5: Commit**

```bash
git add -A
git commit -m "refactor(service): extract cron/ slice"
```

---

### Task 6: `session/` slice

**Files (git mv):**
- `session-manager.ts` → `session/manager.ts`
- `session-manager.test.ts` → `session/manager.test.ts`
- `session-manager.actors.test.ts` → `session/manager.actors.test.ts`
- `session-manager.cross-dormancy.test.ts` → `session/manager.cross-dormancy.test.ts`
- `session-manager.deadlock.test.ts` → `session/manager.deadlock.test.ts`
- `session-manager.messaging.test.ts` → `session/manager.messaging.test.ts`
- `session-manager.redrain.test.ts` → `session/manager.redrain.test.ts`
- `session-manager.resident.test.ts` → `session/manager.resident.test.ts`
- `session-manager.turnslot.test.ts` → `session/manager.turnslot.test.ts`
- `agent-runner.ts` → `session/agent-runner.ts`
- `agent-runner.test.ts` → `session/agent-runner.test.ts`
- `agent-runner.context.test.ts` → `session/agent-runner.context.test.ts`
- `agent-runner.prompt-error.test.ts` → `session/agent-runner.prompt-error.test.ts`
- `agent-runner.resident.test.ts` → `session/agent-runner.resident.test.ts`
- `agent-runner.session.test.ts` → `session/agent-runner.session.test.ts`
- `permission-registry.ts` → `session/permission-registry.ts`
- `permission-registry.test.ts` → `session/permission-registry.test.ts`
- `reply-registry.ts` → `session/reply-registry.ts`
- `reply-registry.test.ts` → `session/reply-registry.test.ts`

**Interfaces:** `createSessionManager`, `createAgentRunner`/`buildToolContext`, `createPermissionRegistry`, `createReplyRegistry` unchanged. After this task, the only files left at the service root are `index.ts` plus the `agents/ skills/ tools/ mcp/ actor/ ipc/ conversation/ memory/ cron/` folders and the four e2e tests (moved in Task 7).

- [ ] **Step 1: Move the files**

```bash
cd src/service
mkdir -p session
git mv session-manager.ts session/manager.ts
git mv session-manager.test.ts session/manager.test.ts
git mv session-manager.actors.test.ts session/manager.actors.test.ts
git mv session-manager.cross-dormancy.test.ts session/manager.cross-dormancy.test.ts
git mv session-manager.deadlock.test.ts session/manager.deadlock.test.ts
git mv session-manager.messaging.test.ts session/manager.messaging.test.ts
git mv session-manager.redrain.test.ts session/manager.redrain.test.ts
git mv session-manager.resident.test.ts session/manager.resident.test.ts
git mv session-manager.turnslot.test.ts session/manager.turnslot.test.ts
git mv agent-runner.ts session/agent-runner.ts
git mv agent-runner.test.ts session/agent-runner.test.ts
git mv agent-runner.context.test.ts session/agent-runner.context.test.ts
git mv agent-runner.prompt-error.test.ts session/agent-runner.prompt-error.test.ts
git mv agent-runner.resident.test.ts session/agent-runner.resident.test.ts
git mv agent-runner.session.test.ts session/agent-runner.session.test.ts
git mv permission-registry.ts session/permission-registry.ts
git mv permission-registry.test.ts session/permission-registry.test.ts
git mv reply-registry.ts session/reply-registry.ts
git mv reply-registry.test.ts session/reply-registry.test.ts
cd -
```

- [ ] **Step 2: Run typecheck**

Run: `npm run typecheck:node`

- [ ] **Step 3: Fix imports**

Within `session/`, sibling edges stay `./` — **no change** to: `manager.ts` → `./agent-runner`, `./permission-registry`, `./reply-registry`; `agent-runner.ts` → `./permission-registry`; and the agent-runner tests' `./agent-runner` (incl. the dynamic `await import('./agent-runner')` in `agent-runner.context.test.ts`).

Cross-slice edges now need one extra `../` (these specifiers were rewritten in earlier tasks to point at the moved folders; the files are now one level deeper):
- `session/manager.ts`: `./actor/mailbox` → `../actor/mailbox`, `./actor/state` → `../actor/state`, `./ipc/broadcaster` → `../ipc/broadcaster`, `./conversation/store` → `../conversation/store`, `./agents/prompt` → `../agents/prompt`, `./agents/store` → `../agents/store`, `./skills/prompt` → `../skills/prompt`, `./skills/store` → `../skills/store`, `./tools/builtins` → `../tools/builtins`, `./tools/registry` → `../tools/registry`
- `session/agent-runner.ts`: `./actor/mailbox` → `../actor/mailbox`, `./actor/state` → `../actor/state`, `./tools/registry` → `../tools/registry`
- `session/manager.test.ts`: `./agent-runner` (no change); `./ipc/broadcaster` → `../ipc/broadcaster`; `./conversation/store` → `../conversation/store`
- `session/manager.actors.test.ts`: `./conversation/store` → `../conversation/store`
- `session/manager.cross-dormancy.test.ts`: `./actor/state` → `../actor/state`; `./conversation/store` → `../conversation/store`
- `session/manager.deadlock.test.ts`: `./conversation/store` → `../conversation/store`
- `session/manager.messaging.test.ts`: `./conversation/store` → `../conversation/store`
- `session/manager.redrain.test.ts`: `./conversation/store` → `../conversation/store`
- `session/manager.resident.test.ts`: `./conversation/store` → `../conversation/store`
- `session/manager.turnslot.test.ts`: `./conversation/store` → `../conversation/store`
- `session/agent-runner.resident.test.ts`: `./actor/mailbox` → `../actor/mailbox`; `./agent-runner` (no change)
- And the importers of session-manager that stayed put: `index.ts`: `./session-manager` → `./session/manager`; `ipc/dispatcher.ts`: `../session-manager` → `../session/manager`; `ipc/dispatcher.test.ts`: `../session-manager` → `../session/manager`

Use `npm run typecheck:node` output as the authority — fix every reported specifier.

- [ ] **Step 4: Verify**

Run: `npm run typecheck:node` → 0 errors.
Run: `cross-env ELECTRON_RUN_AS_NODE=1 electron node_modules/vitest/vitest.mjs run src/service/session` → pass.

- [ ] **Step 5: Commit**

```bash
git add -A
git commit -m "refactor(service): extract session/ slice (manager, agent-runner, registries)"
```

---

### Task 7: `e2e/` slice

**Files (git mv):**
- `agent-cluster.e2e.test.ts` → `e2e/agent-cluster.e2e.test.ts`
- `agent-cluster-runloop.e2e.test.ts` → `e2e/agent-cluster-runloop.e2e.test.ts`
- `company.e2e.test.ts` → `e2e/company.e2e.test.ts`
- `company.startup.test.ts` → `e2e/company.startup.test.ts`

**Interfaces:** Test-only move. These exercise `session/manager` + `conversation/store` together.

- [ ] **Step 1: Move the files**

```bash
cd src/service
mkdir -p e2e
git mv agent-cluster.e2e.test.ts e2e/agent-cluster.e2e.test.ts
git mv agent-cluster-runloop.e2e.test.ts e2e/agent-cluster-runloop.e2e.test.ts
git mv company.e2e.test.ts e2e/company.e2e.test.ts
git mv company.startup.test.ts e2e/company.startup.test.ts
cd -
```

- [ ] **Step 2: Run typecheck**

Run: `npm run typecheck:node`

- [ ] **Step 3: Fix imports**

Each of the four files imported `./conversation/store` and `./session/manager` (rewritten in earlier tasks); now one level deeper:
- `./conversation/store` → `../conversation/store`
- `./session/manager` → `../session/manager`

Apply to all four e2e files. Verify against tsc output.

- [ ] **Step 4: Verify**

Run: `npm run typecheck:node` → 0 errors.
Run: `cross-env ELECTRON_RUN_AS_NODE=1 electron node_modules/vitest/vitest.mjs run src/service/e2e` → pass.

- [ ] **Step 5: Commit**

```bash
git add -A
git commit -m "refactor(service): move cross-subsystem e2e tests into e2e/"
```

---

### Task 8: Final whole-suite verification

**Files:** none (verification only).

- [ ] **Step 1: Confirm the service root is clean**

Run: `ls src/service` → expect only: `index.ts`, and folders `actor/ agents/ conversation/ cron/ e2e/ ipc/ mcp/ memory/ session/ skills/ tools/`. No stray flat `.ts` except `index.ts`.

- [ ] **Step 2: Full typecheck (node + web)**

Run: `npm run typecheck`
Expected: 0 errors.

- [ ] **Step 3: Full test suite vs baseline**

Run: `npm test 2>&1 | tail -30`
Expected: pass/fail/skip counts equal the Task 0 baseline.

- [ ] **Step 4: Confirm diff is moves + import lines only**

Run: `git diff --stat main...HEAD -- src/service | tail -20` and spot-check a couple files with `git log --follow`.
Expected: renames (R) + the one deletion + import-line edits; no behavioral content changes.

- [ ] **Step 5: Scoped format pass (optional)**

If Biome flags the moved files, run scoped only (never repo-wide): `npx biome check --write src/service`. Commit if it changed anything:

```bash
git add -A && git commit -m "chore(service): biome format moved files" || true
```

---

## Self-Review

**Spec coverage:** Every target folder in the spec has a task — `actor/`(T1), `ipc/`(T2), `conversation/`(T3), `memory/`(T4), `cron/`(T5), `session/`(T6), `e2e/`(T7); dead-code deletion (T0); final verification (T8). ✓

**Placeholder scan:** No TBD/TODO; every step has exact `git mv` commands, exact import edits, and exact verify commands. ✓

**Type/path consistency:** Cross-slice import depths account for execution order — earlier tasks rewrite a specifier to its folder (`./conversation/store`), and a later task that moves the *importer* deeper adds the `../` (Tasks 5/6/7). Same-folder sibling edges are explicitly called out as no-change. `tsc` is the authority each task. ✓

**Known acceptable churn:** A few import lines (e.g. `cron`/`session`/`e2e` files' `conversation/store` reference) are touched in two consecutive slice commits — inherent to relocating interdependent files while keeping every commit green. Documented in Global Constraints.
