# Conversation / Task Separation — Phase 3b: Agent-Driven Verify (Verify Loop Removal)

- **Date:** 2026-07-03
- **Status:** Design (pending review)
- **Branch:** worktree `phase3b-agent-driven-verify` off `develop` (this worktree).
- **Scope:** `apps/desktop/src/service/session/agent-runner.ts` (delete verify loop + Phase A + criteria/verify deps; runner becomes single-shot); `apps/desktop/src/service/session/verify.ts` (delete file); `apps/desktop/src/service/session/manager.ts` (drop `maxVerifyRounds`/`acceptanceCriteria`/criteria+verification persistence); `apps/desktop/src/service/tools/{spawn,create-task,acceptance-criteria,delegation-plan,builtins,registry}.ts`; `packages/protocol/src/types/task.ts` (delete `AcceptanceCriterion`/`ExecutableCheck`/`VerificationRound` + `SpawnChildOptions`/`DelegationItem`/`Task` criteria fields); `packages/shared/src/constants/agents.ts` (prompt updates); renderer (`verify-panel.tsx`, `tasks-view.tsx` verify groups, `apply-event.ts` handlers, `right-panel.tsx` mount).
- **Predecessors:** Phase 1 (runner decoupled from `Task`), Phase 2 (user message = real event), Phase 3a (conversation off Task) — all on `develop`.
- **Hard guardrail (user-stated):** Phase 4 must be able to remove the entire task + verify execution flow, with the agent making autonomous judgments. This spec removes the system verify loop and the criteria/verification machinery: every run becomes single-shot, and verifying completeness becomes the agent's own job (done with its existing tools, guided by prompt).

## 1. Background & goal

Phase 3a took conversation off the Task execution unit: a conversation turn is a
single-shot run with no verify loop, while real work (`create_task`) still runs the
system verify loop (`define → execute → verify → rework`, up to 3 rounds). Delegated
children spawned via `spawn_sub_agent` with `verify: true` (e.g. Leaders) also run the
verify loop.

**Phase 3b removes the system verify loop entirely.** Every run — conversation turn,
`create_task` work task, delegated Leader, leaf engineer — is single-shot. Verifying
completeness becomes the agent's responsibility: it self-checks using its existing tools
(shell, fs, tests), guided by its system prompt. There is **no `verify` tool and no
system-forced reviewer**; the agent autonomously judges when its work is done.

This deletes `runGoalVerifyLoop`, `defaultVerifyCompletion`, Phase A criteria derivation,
the `verifyCompletion` dep, the `verify.ts` module, the `AcceptanceCriterion` type and
everything that consumes it (the `set_acceptance_criteria` tool, `task.criteria`/
`task.verification` events, the verification panel, and the `acceptanceCriteria` field on
`DelegationItem` / `SpawnChildOptions` / `Task`).

## 2. How the guardrail is satisfied (removal path)

| Stage | Conversation | Work | System task + verify flow |
|---|---|---|---|
| after 3a | session-level events, single-shot, no Task, no verify | `create_task` → Task + verify loop | removed from conversation; still on work |
| **after 3b (this spec)** | (unchanged) | single-shot; **verify is agent-driven** (agent self-checks with its tools, prompt-guided) | verify flow **fully removed**; `verify.ts`, criteria, verification panel deleted |
| after Phase 4 | (unchanged) | "task" is agent-authored data, not an execution unit | Task-as-execution-unit deleted; conversation gets first-class rendering; `create_task`/`spawn_sub_agent` merge decided |

## 3. Non-goals

- **Removing the Task execution unit** (Phase 4) — `create_task` work tasks still execute as Task-anchored runner runs.
- **`create_task` / `spawn_sub_agent` merge** (Phase 4) — both tools stay distinct in 3b; only the prompt policy is defined here.
- **`goal` folds into `initialMessages`** (3c) — deferred.
- **Resident actor path** (`spawnResident`), cron, gmail sidecar — unaffected (they already run single-shot or do not use the verify path).
- **Migration of old sessions** — old tasks' persisted `criteria`/`verifications` simply stop rendering (the panel is gone). No data migration.

## 4. The verify model (agent-driven, no tool)

There is no `verify` tool and no system-forced reviewer. The agent verifies its own work
using capabilities it already has:

- **Deterministic checks** — the agent runs its shell/fs/test tools directly (`npm test`,
  `ls`, `grep`, etc.). The prior `verify.ts` hard checks (`file_exists`, `command`) were a
  wrapper around these; the wrapper is removed because the agent already owns the
  underlying tools.
- **Soft judgment** — the agent self-reviews its output before reporting done. No
  independent verifier sub-run is spawned by the system. (A worker that wants a second
  opinion may delegate a reviewer via the existing `spawn_sub_agent`; that is the agent's
  choice, not system policy.)
- **Leader review of delegated work** — Leaders self-judge their engineers' output from
  the returned summaries, using their own tools to check when warranted. No forced
  reviewer; no system verify on the Leader's own run.

Worker system prompts gain a one-line self-verify expectation (see §5.6).

## 5. Changes

### 5.1 `agent-runner.ts` — runner becomes unconditionally single-shot

`createAgentRunner.run` loses its verify branch entirely. Today:

```ts
if (task.executionMode === 'plan' || maxRounds === 0) { /* single-shot */ }
else { /* Phase A derive criteria + runGoalVerifyLoop */ }
```

After 3b the `else` branch is deleted and the single-shot path is the only path. `run`
becomes: resolve context → `buildAgentSession` → `session.promptOnce(goal, images)` →
return `{ status, summary, messages, used }`.

Deleted from this file:
- `runGoalVerifyLoop`, `defaultVerifyCompletion`, and their helpers (`reworkPrompt`,
  `sameGaps`, `deriveCriteriaPrompt`, `buildJudgePrompt`, `VERIFIER_SYSTEM_PROMPT`, and
  the `parseVerdict`/`verifyTask` import).
- `DEFAULT_MAX_VERIFY_ROUNDS`.
- The Phase A block (`criteriaRef`, the `wrappedDeps` criteria wiring, the
  `deriveCriteriaPrompt` call, the goal-as-single-criterion fallback). The
  `onDelegationPlan` emit wiring is **preserved** (the delegation DAG stays).
- `AgentRunnerDeps` fields: `maxVerifyRounds`, `verifyCompletion`, `acceptanceCriteria`,
  `onAcceptanceCriteria`. `RunContext.acceptanceCriteria` removed.

`executionMode` is **kept** — it still drives the tool allowlist (manager) and the
plan-mode system-prompt prefix (`composeSystemPrompt`). It no longer selects a runner
branch.

### 5.2 `verify.ts` — deleted

The entire file (`verifyTask`, `runHardChecks`, `runCheck`, `parseVerdict`, and the
`Judge`/`Verdict`/`CheckResult` types). Its only importer was `agent-runner.ts` (§5.1).

### 5.3 `manager.ts` — drop verify/criteria wiring

- Delete the `MAX_VERIFY_ROUNDS` const and the three `maxVerifyRounds` sites:
  `spawnChild` (~661), `runTaskTurn` (~807), and the conversation turn (~1029).
- Delete `acceptanceCriteria` from every `createAgentRunner` call and from the work-`Task`
  construction (~884). The `createTask` dep wiring (~1023) drops its `criteria` param:
  `createTask: (g) => runWorkTask(sessionId, g, [])`.
- Delete the `task.criteria` (~287–291) and `task.verification` (~292–299) persistence
  blocks in `makeEmit`.
- `runTaskTurn` and `spawnChild` no longer branch on verify; every task runs single-shot.

### 5.4 Tools — criteria tool removed, spawn/create_task slimmed

- **Delete** `set_acceptance_criteria` (`acceptance-criteria.ts`) and its registration in
  `builtins.ts`.
- **`spawn_sub_agent`** (`spawn.ts`): drop the `verify` param and the `acceptanceCriteria`
  param. With both gone, `SpawnChildOptions` is empty, so stop constructing it and drop the
  `options` arg from the `spawnChild` signatures (`AgentRunnerDeps.spawnChild` and
  `ToolRunContext.spawnChild`). Children are always single-shot.
- **`create_task`** (`create-task.ts`): drop the `criteria` input; output is the
  single-shot result summary.
- **`set_delegation_plan`** (`delegation-plan.ts`): **kept**, but drop the
  `acceptanceCriteria` field from each `DelegationItem` (and the `AcceptanceCriterionSchema`
  import). The DAG (goals + dependency waves) remains for UI/audit; expectations are
  conveyed in the delegated goal text.
- `registry.ts` `ToolRunContext`: drop `setAcceptanceCriteria`; keep `setDelegationPlan`.

### 5.5 Protocol & store — criteria types removed

- `packages/protocol/src/types/task.ts`: delete `AcceptanceCriterion` /
  `AcceptanceCriterionSchema`, `ExecutableCheck` / `ExecutableCheckSchema`,
  `VerificationRound` / `VerificationRoundSchema`, `VerificationResult` /
  `VerificationResultSchema`. `SpawnChildOptions` loses `maxVerifyRounds` +
  `acceptanceCriteria` — the type is then empty, so delete it outright (and its call-site
  threading, per §5.4). `DelegationItem` loses `acceptanceCriteria`. `Task` loses
  `acceptanceCriteria` + `verifications`.
- `conversation/store.ts`: delete the `saveTaskCriteria` / `saveTaskVerifications`
  methods and stop selecting those columns when hydrating tasks. **The DB columns
  (`task_criteria`, `task_verifications`) are left in place** — dropping them is a
  migration not worth the risk; they become harmless dead columns and a revert needs no
  schema change.

### 5.6 Builtin agent prompts — remove criteria/verify-loop references

`packages/shared/src/constants/agents.ts` references "acceptance criteria" and "verify"
throughout (CEO, Leader, Engineer, Reviewer, QA, etc.). These are updated:
- Remove instructions to *define/derive acceptance criteria* (Phase A is gone) and to
  *attach criteria* to delegation items.
- Remove phrasing that implies a system verify loop will check the work.
- Add a one-line self-verify expectation to worker prompts: verify your work with your
  own tools (run the tests, check the files) before reporting done.
- Leader prompts: review delegated work from the returned summaries; re-spawn or fix when
  gaps are found (trust-based, tool-checked).

Exact wording is an implementation detail; this spec requires only that no prompt
references the removed criteria/verify machinery, and that workers know they own
verification.

### 5.7 Renderer — verification panel removed

- Delete `VerifyPanel` (`verify-panel.tsx`) and its mount in `right-panel.tsx`.
- Remove the verify groups from `tasks-view.tsx` (the plan panel stays — plan ≠ verify).
- Remove the `task.criteria` / `task.verification` handlers from `apply-event.ts`.

## 6. Data flow (create_task work task, post-3b)

1. Conversation turn calls `create_task(goal)`.
2. Manager: `runWorkTask` creates a top-level `Task` (parentId `null`), saves it,
   broadcasts `task.created` + `task.dispatched`, and runs `runTaskTurn`
   (messageSource `'isolated'`).
3. `runTaskTurn` constructs `createAgentRunner` (no `maxVerifyRounds`, no
   `acceptanceCriteria`) and runs it.
4. Runner: single-shot — `session.promptOnce(goal)`. The agent does the work, self-checks
   with its tools, streams events to `task_events`, and returns its summary.
5. No `task.verification` events, no criteria, no verify-panel entry. The task card shows
   plan (if any) + transcript, marked completed/failed.

## 7. OPEN DESIGN Q resolution (create_task vs delegate vs inline)

3a made the conversation turn a single-shot run with full tools, so the agent can do work
inline. The three paths overlap; 3b defines the prompt policy and **keeps both tools
distinct** (the merge question is Phase 4):

| When | Use | Why |
|---|---|---|
| Trivial / single-step / Q&A | **answer inline** (conversation turn) | not worth a task |
| Substantial work the agent does itself, worth tracking | **`create_task`** | isolated context + task-panel card; conversation stays high-level |
| Needs a specialist agent type / narrower capability / parallel focus | **`spawn_sub_agent`** | delegate to a sub-agent |

A CEO session delegates via `find_agents` + `spawn_sub_agent` and never calls
`create_task` — this is **by design** (a CEO's role is to delegate). `create_task` serves
non-delegating sessions doing their own tracked work. The system prompt conveys this
policy to the conversation agent.

## 8. Concurrency, cancel, budget — unchanged from 3a

- `runWorkTask` still bypasses the session turn pump and runs as a nested run under the
  conversation turn's slot (3a §8).
- Cancel keys off `taskId` (work) / `turnId` (conversation) via `oneShotHandles` (3a §9).
- Usage: work-task usage is still per-task (`saveTaskUsage`); conversation usage is
  session-level (3a §10). No change.

## 9. Behavior changes

- **Intended:** no task ever runs a verify loop; no `task.verification` events; no
  verification panel. Work tasks and delegated Leaders complete in one shot, self-verified.
- **`spawn_sub_agent`** no longer accepts `verify` / `acceptanceCriteria`; Leaders are
  single-shot and self-review.
- **Side benefit:** the internal vision sub-run (`buildAnalyzeImage`) and the gmail
  analyze run — which today risk entering the goal-mode verify path — become cleanly
  single-shot.
- **Old sessions:** their persisted `criteria` / `verifications` stop rendering (panel
  gone). No migration.

## 10. Test strategy

- **Delete** `verify.test.ts`, `agent-runner.verify.test.ts`; adapt the multi-round verify
  e2e (`multi-level-verify.e2e.test.ts`) to single-shot delegation.
- **runner** — `createAgentRunner.run` is single-shot for both `goal` and `plan`; the
  verify branch is gone. Existing single-shot tests still pass.
- **manager** — `create_task` work task: runs single-shot, no `task.verification`
  persisted, no criteria. `spawn_sub_agent`: single-shot child, no verify opts.
- **tools** — `set_acceptance_criteria` removed; `spawn_sub_agent` / `create_task` reject
  the removed params at the schema level.
- **protocol** — `AcceptanceCriterion` / `VerificationRound` / `SpawnChildOptions` field
  removals typecheck clean.
- **e2e** — a goal work task completes in one shot with no verification rounds; a
  CEO→Leader→engineer delegation runs fully single-shot, Leader self-reports.

## 11. Verification

- `npm test` green (full suite, Electron node runner; never bare `npx vitest`; never
  `pnpm rebuild better-sqlite3`). Pre-existing failures: `gmail.test` (`htmlBody` fixture)
  + `host.test` (EADDRINUSE :47777) — unchanged.
- `npx biome check --write <file>` per touched file (scoped; `pnpm check` reformats the
  whole repo).
- `npx tsc -b` (or the project's typecheck) clean — the deletion surface is wide; delete
  stale `**/*.tsbuildinfo` before trusting a clean run.
- Manual smoke (needs a configured provider + no single-instance lock): a real-work goal
  the agent `create_task`-es completes in one shot with no verify spinner; a CEO
  delegation runs single-shot end to end.

## 12. Rollback

3b lands as a series of commits on this worktree branch, integrated via
`git rebase develop` + `git merge --ff-only`. The change is almost entirely deletion; a
revert restores the verify loop, the `verify.ts` module, the criteria types, and the
panel. The DB columns (`task_criteria`, `task_verifications`) are left in place, so a
revert needs no schema migration.

## 13. Forward pointers (what 3b does NOT do)

- **Phase 4:** delete Task-as-execution-unit; give conversation first-class rendering
  (drop the adapter); decide whether `create_task` and `spawn_sub_agent` merge.
  (`verify.ts` deletion, originally Phase 4, is pulled into 3b — it had no consumer once
  the loop was gone.)
- **3c:** `goal` folds into `initialMessages`.
