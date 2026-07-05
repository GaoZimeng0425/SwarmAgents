# Run-Engine W4 — Rename, Migration, Switchover Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Complete the rewrite: the wire speaks `run.*` end-to-end, persisted history is migrated, the app runs on `SessionService`/`launchRun`, the old manager execution half and `agent-runner.ts` are DELETED, `create_task` becomes `delegate` (child status surfaced), and the two spec-§6 dead knobs die.

**Architecture:** Per spec §4/§5/§6/§8 W4 + the carry-overs in `.superpowers/sdd/progress.md` ("W4 carry-overs") and the spec §7 footnotes. ATOMICITY NOTE: production atomicity comes from the ff-only merge of the WHOLE branch — individual commits on this branch may be transiently inconsistent in runtime semantics (e.g. protocol renamed before the dispatcher switches) but every commit MUST compile, typecheck, and pass the full suite (tests updated in the same commit). Task order optimizes review clarity: (1) protocol+renderer rename, (2) DB migration + store widening, (3) the switchover (dispatcher/index → SessionService; old engine deleted; gmail/analyze on launchRun; e2e ports), (4) `delegate` tool + context contract final shape + prompt sweep, (5) dead knobs, (6) final gates + delegate-tree e2e + run-desktop smoke.

**Tech Stack:** TypeScript, better-sqlite3 migration SQL, vitest via Electron-node.

## Global Constraints

- Worktree branch `worktree-run-engine-w4`, cut from `develop` at or after 9a52bc7. Integrate via rebase + ff-only. Teardown: delete node_modules symlinks BEFORE `git worktree remove`; verify `readlink <main>/apps/desktop/node_modules/cross-env` stays in main.
- Tests: `cd apps/desktop && npm test -- <filter>`; full gate = full desktop suite via npm in apps/desktop. Typecheck gates on EVERY task: `npx tsc --noEmit -p tsconfig.node.json --composite false && npx tsc --noEmit -p tsconfig.web.json --composite false` (apps/desktop) plus `npx tsc --noEmit -p packages/protocol/tsconfig.json` when protocol changes. Format: `./node_modules/.bin/biome check --write` (npx trips pnpm in worktrees). Never pnpm/turbo anywhere in the worktree.
- `git add` exact paths. Comments/commits in English. No new dependencies. No runtime flag, no compat shims (spec D3/D5) — the DB migration is the ONLY backward-compat machinery.
- NO-REGRESSION INVARIANTS (every task): exactly one terminal event per run; seq ordering created < user-progress < dispatched; abort-before-waits; launchRun never rejects; the permission flow round-trips.
- Naming: wire kinds and payload keys per `packages/protocol/src/types/run.ts` (`RunWireEvent`, runId/parentRunId). The INNER progress payload union `TaskEvent` (llm.message/reasoning/tool.call/tool.result/error kinds) KEEPS its name and shape — it is orthogonal to the task→run rename and pervasive; renaming it is churn without information (spec §5 scopes the rename to wire kinds/keys/IPC/tool names).

---

### Task 1: Protocol v2 integration + renderer/IPC rename

**Files:**
- Modify: `packages/protocol/src/types/ui.ts` (UIEvent union + SubmitGoalResult + SwarmBridge), `packages/protocol/src/types/task.ts` (TaskOptions→RunOptions, TaskResult→DelegateResult), `packages/protocol/src/types/ipc.ts` (drop the task.* Outbound members — verify zero references first), `packages/protocol/src/types/permission.ts` (taskId→runId), `packages/protocol/src/service-client.ts` (cancelTask→cancelRun; submitGoal returns { runId })
- Modify (renderer, from the recorded inventory): `apps/desktop/src/shared/lib/apply-event.ts` (+test), `src/hooks/use-tasks.ts`→`use-runs.ts`, `src/hooks/use-events-subscription.ts`, `src/lib/task-segments.ts`, `build-timeline-items.ts`, `composer-turns.ts`, `minimap-items.ts`, `session-usage.ts`, `scheduled-rows.ts`, `choice-notification.ts` (+tests), `src/lib/api.ts`, `src/stores/permission.ts`, and the ~12 components consuming taskId/parentTaskId/task.* (`task-transcript.tsx`, `task-timeline.tsx`, `task-list-item.tsx`, `conversation-thread.tsx`, `composer-overlay.tsx`, `plan-panel.tsx`, `permission-card.tsx`, `conversation-minimap.tsx`, `views/tasks-view.tsx`, `views/scheduled-calendar-view.tsx`, `views/scheduled-results-view.tsx`, `session-list.tsx`) — rename what they READ (fields/kinds/handler names); do NOT redesign UI
- Modify: `apps/desktop/src/main/ipc/swarm-ipc.ts` + preload bridge (`swarm:cancelTask`→`swarm:cancelRun`) and `apps/desktop/src/main/ipc/forward-event.test.ts` etc. as the compiler demands
- Modify: `apps/desktop/src/service/ipc/dispatcher.ts` — the `cancelTask` case becomes `cancelRun` (ServiceMethod union in protocol follows); it still calls the OLD manager in this task (`manager.cancelTask` keeps its name until Task 3 deletes it — adapt at the dispatcher boundary)

**Interfaces:**
- Produces the FINAL wire vocabulary: `UIEvent = RunWireEvent | session.created | session.updated | memory.changed | skills.changed | agents.changed | gmail.analysisDelta/Complete/Error` (the eleven run.* members come from `./run` — do not redeclare them). `RunRecord` keys `id/parentRunId`, reducer switches on run.* kinds INCLUDING `run.spawned` (migrated rows: linkage only, no status change) and treats `run.created`'s `parentRunId` as the child marker. `SubmitGoalResult = { runId: string }`. `RunOptions`/`DelegateResult` (DelegateResult = `{ summary: string; artifacts: Artifact[]; status?: 'completed' | 'failed' | 'cancelled' }`).
- CRITICAL transitional note: the OLD manager/agent-runner still emit `task.*` STRINGS at runtime after this task (deleted in Task 3). That is acceptable mid-branch: their suites assert those strings and continue passing (their emit calls are untyped `EmitFn(event: string, data: unknown)`); anything TYPED against UIEvent moves to run.*. The reducer NO LONGER understands task.* — renderer tests feed run.* fixtures. Do not "fix" the old runner's emits; it dies in Task 3.
- The reducer rewrite is normative:

```ts
// apply-event.ts — target shape (complete)
export type RunStatus = 'pending' | 'running' | 'completed' | 'failed' | 'awaiting_user' | 'cancelled'
export type RunRecord = {
  id: string
  sessionId: string
  goal: string
  status: RunStatus
  summary: string | null
  startedAt: number
  attachments: Attachment[]
  used?: ConsumedResources
  contextTokens?: number
  contextWindow?: number
  plan?: PlanTodo[]
  parentRunId?: string
  agentDefId?: string
  events: UIEvent[]
}
// applyEvent keys on e.runId; run.created builds the record (goal/attachments/parentRunId/agentDefId);
// unknown-run stub fallthrough preserved (status 'running'); switch:
//   run.dispatched → 'running'   (no workerId anymore)
//   run.complete   → summary = e.summary, 'completed'
//   run.error      → code === 'cancelled' ? 'cancelled' : 'failed'
//   run.usage      → used/contextTokens/contextWindow merge
//   run.plan       → plan = e.todos
//   run.permission_request → 'awaiting_user'
//   run.progress   → awaiting_user → 'running' resume rule (verbatim port)
//   run.spawned    → append-only (linkage rides parentRunId on the child's run.created)
```

- Sweep contract (end of task): `grep -rn "'task\.\|\"task\.\|taskId\|parentTaskId\|workerId" apps/desktop/src/renderer apps/desktop/src/shared apps/desktop/src/main packages/protocol/src --include="*.ts" --include="*.tsx"` → zero hits EXCEPT (a) `apps/desktop/src/service/**` (old engine, dies in Task 3), (b) the permission registry's emit string (service, Task 3), (c) protocol mentions inside `types/run.ts` comments. Record the exact residual list in the report.

- [ ] **Step 1:** Rewrite the protocol types (ui.ts/task.ts/ipc.ts/permission.ts/service-client.ts) as specified; `npx tsc --noEmit -p packages/protocol/tsconfig.json` clean.
- [ ] **Step 2:** Rewrite apply-event.ts + its test (fixtures become run.*; port every existing behavioral assertion — stub fallthrough, terminal-on-stub, awaiting_user resume — to the new kinds; keep the real-shape discipline).
- [ ] **Step 3:** Compiler-guided rename across hooks/libs/components/IPC/preload/dispatcher. Rename `use-tasks.ts`→`use-runs.ts` (`useTasks`→`useRuns`, `RUNS_KEY` stays `['runs']`… set it to `['runs']`), update imports. Internal helper names (task-segments etc.) follow (`TaskSegment`→`RunSegment` etc. where the compiler touches them — file renames beyond use-tasks are OPTIONAL; identifier renames are required).
- [ ] **Step 4:** Gates: full desktop suite green (old-engine suites untouched and passing; renderer suites on run.*), both typechecks + protocol typecheck clean, sweep contract satisfied. Format; commit `refactor(protocol,renderer)!: task.* → run.* wire v2 end-to-end (reducer, hooks, IPC, bridge)`.

---

### Task 2: DB migration + store widening

**Files:**
- Modify: `apps/desktop/src/service/conversation/store.ts`
- Create: `apps/desktop/src/service/conversation/store.migration.test.ts`

**Interfaces / normative content:**
- `schema_meta(version INTEGER)` table; migration runs once when `version < 2`, inside ONE transaction, then sets version 2. Idempotent by version guard.
- Migration v2 statements (complete, in order):

```sql
-- 1. Orphan sweep (sessions deleted while runs were in flight, pre-guard):
DELETE FROM run_events WHERE session_id NOT IN (SELECT id FROM sessions);
-- 2. task.handoff.completed rows: redundant linkage (terminals + parentRunId carry it) — drop:
DELETE FROM run_events WHERE json_extract(event, '$.kind') = 'task.handoff.completed';
-- 3. Kind renames (handoff.spawned first — its payload keys differ):
UPDATE run_events SET event = json_set(event, '$.kind', 'run.spawned') WHERE json_extract(event, '$.kind') = 'task.handoff.spawned';
UPDATE run_events SET event = json_set(event, '$.kind', 'run.' || substr(json_extract(event, '$.kind'), 6)) WHERE json_extract(event, '$.kind') LIKE 'task.%';
-- 4. Key renames + workerId drop (json_set copies may leave nulls when absent — guard each with a WHERE on the old key):
UPDATE run_events SET event = json_remove(json_set(event, '$.runId', json_extract(event, '$.taskId')), '$.taskId') WHERE json_extract(event, '$.taskId') IS NOT NULL;
UPDATE run_events SET event = json_remove(json_set(event, '$.parentRunId', json_extract(event, '$.parentTaskId')), '$.parentTaskId') WHERE json_extract(event, '$.parentTaskId') IS NOT NULL;
UPDATE run_events SET event = json_remove(json_set(event, '$.childRunId', json_extract(event, '$.childTaskId')), '$.childTaskId') WHERE json_extract(event, '$.childTaskId') IS NOT NULL;
UPDATE run_events SET event = json_remove(event, '$.workerId') WHERE json_extract(event, '$.workerId') IS NOT NULL;
```
- Widen the SQL that reads kinds: `getTerminalRunStatuses` recognizes `run.complete` / `run.error` (+ error.code cancelled rule); the usage/list aggregation reads `run.usage` keys. Post-migration the DB contains ONLY run.* kinds, so single-vocabulary SQL is correct — do NOT keep task.* branches (SessionService's recovery sweep already tolerates both in-memory; the STORE reads post-migration state).
- Add the spec-§4 equivalence test: a unit test that feeds the same event set through `terminalStatusForRunEvent` (TS) and through a store round-trip (`appendRunEvent` + `getTerminalRunStatuses`) and asserts identical classifications.
- `appendRunEvent`'s param type becomes the (now run.*-bearing) `UIEvent` — remove the transitional cast in `session-service.ts` (one-line touch there is sanctioned).
- Migration test (complete scenarios): fixture rows covering every old kind (created/dispatched/progress/complete/error/usage/plan/delegation_plan/handoff.spawned/handoff.completed + an orphan-session row + a workerId payload) → open store → assert: version 2; orphan gone; handoff.completed gone; all kinds run.*; runId/parentRunId/childRunId keys present and old keys absent; second open is a no-op (idempotence); `getTerminalRunStatuses` classifies the migrated terminals correctly.

- [ ] **Step 1:** Write the failing migration test (fixture DB via a temp file, exact assertions above). **Step 2:** RED. **Step 3:** Implement schema_meta + migration + SQL widening + the type widening. **Step 4:** GREEN + store suite + full suite + typechecks. **Step 5:** Format; commit `feat(store): run.* migration v2 + single-vocabulary terminal/usage SQL`.

---

### Task 3: The switchover — SessionService live, old engine deleted

**Files:**
- Modify: `apps/desktop/src/service/index.ts` (createSessionManager→createSessionService; drop dead config), `apps/desktop/src/service/ipc/dispatcher.ts` (methods map to the SessionService surface: submitGoal args→`submitPrompt(sessionId, goal, attachments, onComplete?, options)` returning `{ runId }`; cancelRun; resolvePermission; the rest 1:1), `apps/desktop/src/service/gmail/analyze.ts` (+test) — rebuild on `launchRun` with a private LaunchPorts binding (silent seq, no store append, broadcast adapter translating run.progress llm.message→gmail.analysisDelta, run.complete summary→analysisComplete, run.error→analysisError; no-op slot/abort ports per the vision-run precedent), `apps/desktop/src/service/run-engine/engine.ts` (+test) — port v1's `onPayload`/`onResponse` HTTP logging hooks into the Agent construction (carry-over; onResponse at info), `apps/desktop/src/service/tools/peekaboo.ts` (drop the vestigial local `Deps.send`)
- Delete: `apps/desktop/src/service/session/manager.ts`, `agent-runner.ts`, and their remaining test files (`manager.test.ts`, `manager.turnslot.test.ts`, `agent-runner.test.ts`, `agent-runner.retry.test.ts`, `agent-runner.fallback.test.ts`, `agent-runner.prompt-error.test.ts`, `agent-runner.context.test.ts`, `agent-runner.session.test.ts`, `agent-runner.complete-shape.test.ts` — verify the exact list with `ls`)
- Modify: `apps/desktop/src/service/e2e/*.e2e.test.ts` (unified-runs, agent-driven-verify, multi-level-verify, conversation-off-task + any other survivor) — port from `createSessionManager` to `createSessionService` + run.* assertions
- Modify: `apps/desktop/src/service/session/permission-registry.ts` — its broadcast string becomes `run.permission_request` (the emit adapter in session-service persists it; update its test)

**Interfaces:**
- Consumes Task 1's wire + Task 2's store. Before deleting an old-engine behavior, CHECK it has a new-engine home: the old suites you delete were behavior-parity-ported in W2 (engine/launch tests) and W3 (session-service tests) — for each deleted test FILE, state in the report which new suite covers its subjects (a table). Anything with NO home: port it onto the new units in this task, don't drop coverage silently.
- Dispatcher `submitGoal` case keeps the METHOD name (ServiceMethod stability for the renderer API) but returns `{ runId }` and calls `service.submitPrompt`. Cron's `fire` closure and `ensureSystemSession`/terminal queries in index.ts rebind 1:1.
- Sweep contract (end of task): `grep -rn "'task\.\|\"task\." apps/desktop/src packages --include="*.ts"` → zero hits outside comments/docs; `grep -rn "createSessionManager\|createAgentRunner\|buildAgentSession" apps/desktop/src` → zero.

- [ ] **Step 1:** Coverage-home table FIRST (old test file → new suite), porting any orphan subjects. **Step 2:** Rewire index/dispatcher/permission-registry; delete the old engine + tests; rebuild analyze.ts on launchRun (TDD its adapter: fixture run of the real engine mock → analysisDelta/Complete broadcasts); engine hooks; peekaboo cleanup. **Step 3:** e2e ports. **Step 4:** Gates: full suite, typechecks, sweeps. Format; commit `feat(service)!: switch the app to SessionService/launchRun; delete the v1 engine`.

---

### Task 4: `delegate` tool + final tool-context contract + prompt sweep

**Files:**
- Rename+rewrite: `apps/desktop/src/service/tools/create-task.ts` → `delegate.ts` (+ test rename)
- Modify: `apps/desktop/src/service/tools/registry.ts` (final ctx contract), `apps/desktop/src/service/run-engine/launch.ts` (+test), `apps/desktop/src/service/session/session-service.ts` (+test), `apps/desktop/src/service/tools/builtins.ts`, `packages/shared/src/constants/agents.ts`, `packages/shared/src/agents/default-prompt.ts` (+tests), `apps/desktop/src/service/skills/builtins.ts`, `apps/desktop/src/service/agents/prompt.ts` (withAgentTypes coaching, verify content), `apps/desktop/src/service/tools/delegation-plan.ts` (description mentions create_task? verify)

**Interfaces (final):**
- ToolRunContext: `spawnChild(goal, opts?: { suggestedTools?: string[]; providerKey?: string; agentType?: string }): Promise<DelegateResult & { runId: string }>` (positional telescoping dies — ledger #10-adjacent); `createTask(goal, agentType?): Promise<DelegateResult & { runId: string }>`. launch.ts + session-service adapt (their mappings simplify — no more `{ childTaskId, result: TaskResult }` nesting).
- Tool `delegate`: params `{ goal, topLevel?, agentType?, suggestedTools?, providerKey? }`; description teaches: default = child run under you; `topLevel: true` = a prominent top-level run (main budget). Result content: the summary, PREFIXED with `[failed] `/`[cancelled] ` when status ≠ completed (ledger #6 surfaced); details `{ runId, status, summary }`.
- Prompt sweep: every `create_task` mention in agents.ts / default-prompt.ts / skills/builtins.ts / agents/prompt.ts becomes `delegate` with `topLevel` phrasing (`asTopLevel`→`topLevel`); the LEADER addendum's set_delegation_plan step survives as-is. Sweep: `grep -rn "create_task\|asTopLevel\|spawn_sub_agent" apps/desktop/src packages --include="*.ts"` → zero (tool name, params, prompts, tests all moved).

- [ ] **Step 1:** TDD the tool (new test file: both branches, status prefix, not-wired errors). **Step 2:** Contract change compiler-guided across launch/session-service/tests. **Step 3:** Prompt sweep + test-assertion updates. **Step 4:** Gates + sweeps; format; commit `feat(tools)!: create_task → delegate with child status; options-object spawn contract`.

---

### Task 5: Dead knobs — `budget.tokens` + `toolScope`

**Files:**
- Modify: `packages/protocol/src/types/task.ts` (decouple: `ResourceBudgetSchema` = `{ calls, wallMs, usdCents }`; `ConsumedResourcesSchema` becomes a STANDALONE object schema `{ tokens, calls, wallMs, usdCents, cacheRead, cacheWrite }` — used tokens tracking is NOT the budget knob; update `emptyBudget`), `packages/protocol/src/types/budgets.ts` (defaults drop tokens), `packages/protocol/src/types/agent.ts` (see below) (+tests)
- Modify: the budgets settings UI (locate via `grep -rn "usdCents\|wallMs" apps/desktop/src/renderer` — the Budgets settings view; drop the tokens field), engine/session-service/test fixtures that construct budgets with `tokens:`
- toolScope: in `agent.ts`, add `authoring?: boolean` to AgentDefinition; `allowlistForAgent` keys authoring off `def.authoring === true || def.toolScope === 'authoring'` (back-compat for on-disk user agents); `ToolScopeSchema` stays accepted-but-documented-ignored (`/** Legacy coarse scope; ignored except 'authoring' (see `authoring`). */`); builtin defs in `packages/shared/src/constants/agents.ts` set `authoring: true` on training-head/training-author (keep their toolScope strings or drop them — drop, they're ours); the agent-editor UI keeps accepting old files (no UI change required unless it surfaces toolScope — check `grep -rn "toolScope" apps/desktop/src/renderer`).

- [ ] **Step 1:** Protocol schema changes + tests RED→GREEN (zod defaults keep legacy persisted budget configs parseable — add `.strip()`-tolerant parsing or a defaulting transform for configs that still carry `tokens`; test a legacy on-disk shape). **Step 2:** Compiler-guided fixture sweep (`grep -rn "tokens: " apps/desktop/src packages --include="*.test.ts"` for budget literals). **Step 3:** UI field removal + toolScope/authoring changes. **Step 4:** Gates; commit `refactor(protocol)!: retire budget.tokens knob and collapse toolScope to an authoring gate`.

---

### Task 6: Final gates, delegate-tree e2e, smoke, integration

- [ ] **Step 1:** New e2e `apps/desktop/src/service/e2e/delegate-tree.e2e.test.ts`: a SessionService with a mocked pi agent whose scripted turns call the REAL `delegate` tool (CEO def → delegates to two agentTypes; one child fails) — asserts: parentRunId linkage on children, `[failed]` status surfacing in the parent's tool result, FIFO/slot sanity, all events run.*, replay via getRunEvents reaches terminals.
- [ ] **Step 2:** Full desktop suite + all typechecks + every sweep from Tasks 1-5 re-run. `grep -c "run\." packages/protocol/src/types/ui.ts` sanity.
- [ ] **Step 3:** run-desktop smoke via the `run-desktop` skill from the WORKTREE build: launch the app, submit a real conversation turn (needs a configured provider — if none available headlessly, drive the e2e-style service smoke instead and say so), verify the transcript renders, a delegate child nests, cancel works, and the DB migration ran (check schema_meta + a pre-seeded old-vocabulary row fixture DB if feasible).
- [ ] **Step 4:** Integration: rebase + ff-only merge; safe teardown; update the spec's §8 with a completion note (all four W phases landed, dates + merge commits).

---

## Forward pointer

None — this completes the rewrite. Remaining post-merge follow-ups live in the ledger's minor list (e.g. Montserrat-style repo chores unrelated to this effort).
