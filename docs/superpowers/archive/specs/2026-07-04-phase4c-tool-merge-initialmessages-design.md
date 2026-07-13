# Conversation / Task Separation — Phase 4c: Tool Merge + `initialMessages` Seeding + Cleanup

- **Date:** 2026-07-04
- **Status:** Design (awaiting user review).
- **Branch:** worktree `phase4c-merge` off `develop` (`4ba398b`, post-4b).
- **Scope:** service/tools (`create-task.ts` + delete `spawn.ts`; `builtins.ts`), service/session (`agent-runner.ts` — drop `goal`, seed from `initialMessages` on the one-shot path; `manager.ts` — bake goal into initialMessages at every one-shot caller), protocol (`ToolRunContext.createTask` signature), and a Minor-cleanup sweep.
- **Predecessors:** Phase 4b on `develop` (`4ba398b`) — the `Task`/`task_events`/`conversation_events` tables + `Task` type are gone; every run lives in `run_events`.
- **Hard guardrail (user-stated, inherited):** first-principles, best practice, no lazy compat shims. Comments + commits in English.

## 1. Background & goal

Phase 4a unified rendering onto `run_events`. Phase 4b dropped the `Task` table + migrated every consumer (terminal signal → emit-path registry; usage → `run_events.task.usage`). Two deferred items remain, plus a cleanup batch:

1. **`create_task` / `spawn_sub_agent` merge.** Post-4b the two tools differ ONLY in `parentId` (`null` for `create_task` → `runWorkTask`; current-run for `spawn_sub_agent` → `spawnChild`) plus the spawn-only overrides (`agentType`/`suggestedTools`/`providerKey`). The backends already diverged for good reason (top-level vs child is a real distinction); the duplication is at the agent-facing API. 4c merges them into one tool.
2. **`goal` → `initialMessages` (the "3c" change, planned since Phase 3 — see `agent-runner.ts:190`'s `// Phase-3 folds this into initialMessages`).** The runner takes two seeding inputs (`goal` for the first turn + `initialMessages` for prior history). Folding `goal` into `initialMessages` leaves one seeding mechanism.
3. **Cleanup batch** — the Minor findings rolled up during 4b's whole-branch review (rename `ConversationEventRow` → `RunEventRow`; drop the dead `saveSnapshot` 'session' branch in `runTaskTurn` + narrow its signature; clear stale `makeEmit` comments; drop the `as UIEvent` cast on the synthetic interrupted event; minor test-hygiene nits).

**Goal:** after 4c, there is ONE agent tool for creating a run (`create_task`, with an `asTopLevel` flag); the runner has one seeding input for one-shot runs (`initialMessages`, goal baked in); and the 4b Minors are cleared. This completes the conversation/task-separation redesign.

**Non-goals:**
- Resident-actor seeding (long-lived actors call `promptOnce(goal)` per delivered message — 3c does NOT apply; the per-turn `goal` stays).
- Any further table/type removal (4b is done) or wire change.

## 2. Architecture

### 2.1 Tool merge — one `create_task` with `asTopLevel`

`create_task` becomes the single tool for creating a run. Parameters:

```ts
{
  goal: string                                  // required
  asTopLevel?: boolean                          // default false
  agentType?: string                            // optional, both paths
  suggestedTools?: string[]                     // optional, spawn path only
  providerKey?: string                          // optional, spawn path only
}
```

Dispatch in the tool's `execute`:
- `asTopLevel: true` → `ctx.createTask(goal, agentType?)` → `runWorkTask` (top-level run, `parentId = null`). This is the former `create_task` semantics ("substantial work I do myself, tracked at the top level").
- `asTopLevel: false` (default) → `ctx.spawnChild(goal, suggestedTools, providerKey, agentType)` → `spawnChild` (child run, `parentId = current`). This is the former `spawn_sub_agent` semantics ("delegate to a sub-agent").

`agentType` is orthogonal to `asTopLevel` — a top-level run may also specify a non-default agent. `suggestedTools`/`providerKey` apply to the spawn path (ignored on `asTopLevel`).

`ToolRunContext.createTask` gains an optional `agentType` arg: `createTask?(goal: string, agentType?: string)`. The manager wires it to `runWorkTask(sessionId, goal, [], agentType ? { agentType } : {})`.

`spawn_sub_agent` is DELETED: remove `apps/desktop/src/service/tools/spawn.ts` (+ its test), drop `spawnAgentSpec()` from `builtins.ts`. The `create_task` description is rewritten to guide the agent: substantial own-work → `asTopLevel: true`; delegation to a specialized sub-agent → `asTopLevel: false` (default) + `agentType`.

The backends (`runWorkTask` vs `spawnChild`) are unchanged — top-level vs child is a real distinction worth keeping at the run layer.

### 2.2 `goal` → `initialMessages` (one-shot path only)

`AgentRunnerDeps` drops `goal`. One-shot callers construct `initialMessages` whose LAST message is the goal as a user turn:

- `submitGoal` (conversation): `initialMessages = [...session.messages, { role: 'user', content: goal, ts }]` (the user message is already emitted as a `task.progress` event; it also seeds the run).
- `runWorkTask` (top-level work): `initialMessages = [{ role: 'user', content: goal }]` (fresh).
- `spawnChild` (delegation): `initialMessages = [{ role: 'user', content: newGoal }]`.
- `buildAnalyzeImage` (vision sub-call): `initialMessages = [{ role: 'user', content: prompt }]` (was `goal: prompt` + `initialMessages: []`).

The runner's one-shot `run()` path extracts the goal from the last `initialMessages` user turn, **strips it from the pi seed** (so pi's append-prompt doesn't double it — `[...prior, {user, goal}, {user, goal}]`), and calls `promptOnce(goal)` to run one turn. `AgentSession.promptOnce(goal, images?)` stays REQUIRED — pi's `agent.prompt(goal)` needs a goal; the one-shot path passes the extracted goal, the resident loop passes the delivered message per turn. (The plan corrected the spec's earlier "goal becomes optional" framing — the goal is always passed to `promptOnce`; only its SOURCE changed from a separate `deps.goal` field to the last `initialMessages` entry.)

**Resident actors are unchanged in behavior:** `runResident` still calls `promptOnce(goal)` once per delivered message (each message is a new turn's goal). `promptOnce(goal, images?)`'s `goal` stays required (pi needs it); 3c only changes one-shot seeding (the goal's source + the seed-strip), not the resident run-loop.

### 2.3 Cleanup batch (4b Minors)

- `seq-counter.ts`: rename the exported type `ConversationEventRow` → `RunEventRow` (it describes run-event rows now; the `ConversationEvent` type is gone).
- `manager.ts` `runTaskTurn`: delete the dead `'session'` branch of `saveSnapshot` (only the `'isolated'` messageSource reaches it) and narrow `saveSnapshot`'s signature (the manager's lambdas no longer pass `used`/`contextWindow`).
- Clear stale `makeEmit` references in comments/docstrings: `task-segments.ts:90`, `unified-runs.e2e.test.ts:15`, `manager.ts` `makeRunEmit` docstring, `manager.test.ts`, `seq-counter.ts` header.
- `manager.ts` `markInterruptedRunsTerminal`: construct the synthetic `task.error` as a typed object (drop the `as import('@swarm/protocol').UIEvent` cast).
- Test hygiene: drop the redundant `?? undefined` on `getStatus`; make the `terminalStatus as TerminalStatus` cast consistent (or remove it).

## 3. Migration ordering (green at every commit)

1. **Cleanup batch** (§2.3) — pure refactors/no-ops; safe foundation. → verify full suite.
2. **`goal` → `initialMessages`** (§2.2) — runner interface + all one-shot callers. → verify runner/manager/e2e.
3. **Tool merge** (§2.1) — collapse `spawn_sub_agent` into `create_task`. → verify tool tests + e2e.

Each is a commit; each leaves the suite green.

## 4. Testing

- **Cleanup:** full suite stays green (mechanical); a focused check that `RunEventRow` rename + `saveSnapshot` narrowing don't break callers.
- **3c:** one-shot runs still emit `task.created` + reach terminal in `run_events` (the `unified-runs.e2e.test` + manager tests); a new unit test that a one-shot run seeded with `initialMessages = [{user, goal}]` produces the same turn the old `goal` arg did.
- **Tool merge:** rewrite `create-task.test` + (deleted) `spawn.test` into a single suite covering both `asTopLevel` branches + `agentType` routing + the spawn-only overrides on the child path. An e2e that a delegated sub-agent run (`asTopLevel: false` + `agentType`) still nests via `parentTaskId`.

## 5. Risks

- **3c rippling:** dropping `AgentRunnerDeps.goal` touches every caller + the runner body (`resolveRunContext`, `buildAgentSession` logging, the one-shot `run()`). The plan must enumerate all call sites (grep `goal:` in `manager.ts` + `agent-runner.ts`); a missed caller fails typecheck (catchable), but a semantically-wrong rewrite (e.g., double-seeding the goal) is the real risk — the e2e + a focused one-shot test guard it.
- **Tool-merge agent behavior:** existing agent prompts/system messages may reference `spawn_sub_agent` by name. Grep the agent definitions + builtin prompts for `spawn_sub_agent` and update them to `create_task` (with `asTopLevel` guidance). If a custom agent authored by the user calls `spawn_sub_agent`, it will get a "tool not found" — acceptable per history-disposable/no-compat guardrail, but call it out.
- **Resident `promptOnce(goal)` preserved:** the 3c change must NOT touch the resident path; a regression there breaks long-lived actors. The resident tests (`agent-runner.resident.test`) guard it.

## 6. Forward pointers

None — 4c completes the conversation/task-separation redesign (4a unified rendering, 4b dropped the Task table, 4c merges the tools + simplifies seeding + cleans up).
