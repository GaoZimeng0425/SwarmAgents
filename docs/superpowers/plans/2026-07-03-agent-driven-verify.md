# Phase 3b — Agent-Driven Verify (Implementation Plan)

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Remove the system verify loop and the criteria/verification machinery. Every run becomes single-shot; the agent self-verifies with its own tools (no `verify` tool, no system reviewer). Delete `runGoalVerifyLoop` / `defaultVerifyCompletion` / `verify.ts` / `AcceptanceCriterion` / the verification panel.

**Architecture:** A deletion refactor, ordered so the tree stays green at every commit — consumers are removed before the types they consume. (1) Runner collapses to single-shot; `verify.ts` and the `set_acceptance_criteria` tool go; all `createAgentRunner` call sites drop the removed fields. (2) `spawn_sub_agent` / `set_delegation_plan` slimmed; `SpawnChildOptions` options param removed. (3) Criteria/verification persistence removed from manager + store (DB columns kept). (4) Renderer verification panel + handlers deleted. (5) Protocol criteria/verify types deleted (now unused). (6) Builtin agent prompts de-criteriated. (7) e2e + smoke.

**Tech Stack:** TypeScript, `vitest`, `better-sqlite3`, Electron (test runner), `@swarm/protocol`, `@earendil-works/pi-agent-core`.

## Global Constraints

- **Spec:** `docs/superpowers/specs/2026-07-03-agent-driven-verify-design.md` (authoritative).
- **Run tests via `npm test`** (Electron node runner). NEVER bare `npx vitest`, NEVER `pnpm rebuild better-sqlite3` (breaks app ABI; restore with `npm run postinstall`). Single-file: `npm --prefix apps/desktop test -- <filter>`.
- **Behavior must stay green at every commit** (full suite, modulo the known environmental `gmail.test` htmlBody-fixture failure and `host.test` EADDRINUSE on port 47777 when the desktop app is running — both pre-existing, unrelated).
- **Typecheck must be clean at every commit.** The deletion surface is wide; delete stale `**/*.tsbuildinfo` before trusting a clean `npx tsc -b` (composite refs can report already-fixed errors from cache).
- **Comments and commit messages in English.**
- **Scoped formatting:** `npx biome check --write <file>` (the repo's `pnpm check`/`format` rewrite the whole tree).
- **Pre-commit in this worktree** needs `node_modules` symlinked to the main checkout: `ln -s /Users/gaozimeng/Learn/macOS/SwarmAgents/node_modules node_modules` (already done on this worktree).
- **One commit per task**, on the impl branch `worktree-phase3b-agent-driven-verify`. Integrate to `develop` via `git rebase develop` + `git merge --ff-only`.

## File Structure

- **Modify** `apps/desktop/src/service/session/agent-runner.ts` — delete `runGoalVerifyLoop`, `defaultVerifyCompletion`, verify helpers, Phase A, and the `maxVerifyRounds`/`verifyCompletion`/`acceptanceCriteria`/`onAcceptanceCriteria` deps; collapse `createAgentRunner.run` to single-shot; drop the `options` param of `spawnChild`.
- **Delete** `apps/desktop/src/service/session/verify.ts`.
- **Modify** `apps/desktop/src/service/session/manager.ts` — drop the `maxVerifyRounds`/`acceptanceCriteria` args from every `createAgentRunner` call; drop `MAX_VERIFY_ROUNDS`; slim the `createTask` wiring; delete the `task.criteria`/`task.verification` persist blocks; drop the `spawnChild` `options` param.
- **Modify** `apps/desktop/src/service/gmail/analyze.ts` — drop `maxVerifyRounds: 0`.
- **Delete** `apps/desktop/src/service/tools/acceptance-criteria.ts`; **modify** `builtins.ts` (unregister), `registry.ts` (drop `setAcceptanceCriteria` + the `spawnChild` options param), `create-task.ts` (drop criteria), `spawn.ts` (drop verify/criteria params), `delegation-plan.ts` (drop per-item criteria).
- **Modify** `apps/desktop/src/service/conversation/store.ts` — delete `saveTaskCriteria`/`saveTaskVerifications`; stop selecting/inserting `acceptance_criteria`/`verifications` (columns kept).
- **Modify** `packages/protocol/src/types/task.ts` — delete `AcceptanceCriterion`/`ExecutableCheck`/`VerificationResult`/`VerificationRound` (+schemas), `SpawnChildOptions`, and the criteria/verifications fields on `DelegationItem`/`TaskOptions`/`Task`.
- **Modify** `packages/shared/src/constants/agents.ts` — de-criterion the builtin prompts.
- **Delete** `apps/desktop/src/renderer/src/components/verify-panel.tsx`; **modify** `right-panel.tsx` (drop verify tab), `tasks-view.tsx` (drop `verifyGroups`), `apply-event.ts` (drop criteria/verification handlers).
- **Delete/adapt** tests: `agent-runner.verify.test.ts`, `verify.test.ts`; adapt `manager.test.ts`, `multi-level-verify.e2e.test.ts`.

---

### Task 1: Collapse the runner to single-shot; delete `verify.ts` + the `set_acceptance_criteria` tool

**Files:**
- Modify: `apps/desktop/src/service/session/agent-runner.ts` (verify machinery ~`:1214-1306, 1403-1462`; deps fields `:187-295`; `resolveRunContext`/`buildToolContext`).
- Delete: `apps/desktop/src/service/session/verify.ts`.
- Modify: `apps/desktop/src/service/session/manager.ts` (call-site lines `:661, :807, :1029, :1007, :643, :781, :1023, :54`).
- Modify: `apps/desktop/src/service/gmail/analyze.ts` (`:81`).
- Delete: `apps/desktop/src/service/tools/acceptance-criteria.ts`.
- Modify: `apps/desktop/src/service/tools/builtins.ts`, `registry.ts`, `create-task.ts`.
- Delete: `apps/desktop/src/service/session/agent-runner.verify.test.ts`, `apps/desktop/src/service/session/verify.test.ts`.

**Interfaces:**
- Consumes: nothing (first task).
- Produces: `createAgentRunner.run` is single-shot for every run; `AgentRunnerDeps` no longer has `maxVerifyRounds`/`verifyCompletion`/`acceptanceCriteria`/`onAcceptanceCriteria`. The `set_acceptance_criteria` tool is gone. Later tasks can rely on these fields being absent.

**Note:** After this task the runner no longer knows about verify or criteria. The `AcceptanceCriterion` type itself still exists (consumers in spawn/delegation/store/renderer/protocol are removed in later tasks) so the tree compiles.

- [ ] **Step 1: Collapse `createAgentRunner.run` to single-shot**

In `agent-runner.ts`, replace the body of `createAgentRunner` (`:1403-1463`). The new body keeps only the single-shot path and the **`onDelegationPlan` emit wrapper** (set_delegation_plan still emits `task.delegation_plan`); it drops `maxRounds`, the Phase A criteria derivation, and the `runGoalVerifyLoop` call:

```ts
export function createAgentRunner(deps: AgentRunnerDeps): AgentRunner {
  return {
    async run() {
      const task = resolveRunContext(deps)
      const images: ImageContent[] = task.attachments!.map((a) => ({
        type: 'image',
        data: a.data,
        mimeType: a.mimeType,
      }))
      // Single-shot: one promptOnce, no verify loop. The agent self-verifies
      // with its own tools (3b removed the system verify gate).
      const wrappedDeps: AgentRunnerDeps = {
        ...deps,
        onDelegationPlan: (plan) => {
          deps.emit('task.delegation_plan', { taskId: task.id, plan, ts: Date.now() })
          deps.onDelegationPlan?.(plan)
        },
      }
      const session = buildAgentSession(wrappedDeps)
      const r = await session.promptOnce(task.goal, images.length > 0 ? images : undefined)
      return {
        status: r.status,
        summary: r.summary,
        messages: session.agent.state.messages,
        used: session.getUsed(),
      }
    },
  }
}
```

- [ ] **Step 2: Delete the verify machinery from `agent-runner.ts`**

Delete these symbols/blocks (the runner no longer references them):
- `defaultVerifyCompletion` (`:1257-1306`).
- `runGoalVerifyLoop` (`:1312-1401`).
- `DEFAULT_MAX_VERIFY_ROUNDS` (`:1214`), `VERIFIER_SYSTEM_PROMPT` (`:1216-1220`), `deriveCriteriaPrompt` (`:1222-1226`), `reworkPrompt` (`:1228-1230`), `buildJudgePrompt` (`:1232-1235`), `sameGaps` (`:1248-1252`). Keep `addUsed` if still referenced elsewhere in the file (grep first); otherwise delete it too.
- The verify import at `:41`: `import { type Judge, parseVerdict, type Verdict, verifyTask } from './verify'`.

- [ ] **Step 3: Drop the verify/criteria fields from `AgentRunnerDeps` + `RunContext`**

In `AgentRunnerDeps` (`:187-295`), delete:
- `acceptanceCriteria?: AcceptanceCriterion[]` (`:206-207`) and its doc comment.
- `onAcceptanceCriteria?(...)` (`:268-269`).
- `verifyCompletion?(...)` (`:272-281`) and its doc comment.
- `maxVerifyRounds?: number` (`:282-287`) and its doc comment.

In `RunContext` (`:603-613`), delete `acceptanceCriteria?: AcceptanceCriterion[]` (`:612`).

In `resolveRunContext` (`:615-…`), delete the `acceptanceCriteria: deps.acceptanceCriteria,` line.

In `buildToolContext` (`:333-361`), delete the line `setAcceptanceCriteria: deps.onAcceptanceCriteria,` (`:358`).

- [ ] **Step 4: Delete `verify.ts`**

```bash
git rm apps/desktop/src/service/session/verify.ts
git rm apps/desktop/src/service/session/verify.test.ts
```

- [ ] **Step 5: Drop the removed args from every `createAgentRunner` call site**

`manager.ts` — in each of the three call sites, delete the listed lines:
- `spawnChild` call (`:634-663`): delete `acceptanceCriteria: childTask.acceptanceCriteria,` (`:643`) and `maxVerifyRounds: options?.maxVerifyRounds ?? 0,` (`:661`) plus its 2-line comment (`:659-660`).
- `runTaskTurn` call (`:772-809`): delete `acceptanceCriteria: task.acceptanceCriteria,` (`:781`) and `maxVerifyRounds: MAX_VERIFY_ROUNDS,` (`:807`).
- `submitGoal` conversation-turn call (`:998-1031`): delete `acceptanceCriteria: undefined, // conversation never runs the verify loop` (`:1006-1007`) and `maxVerifyRounds: 0, // single-shot — the cutover's key line` (`:1029`).
- Delete `const MAX_VERIFY_ROUNDS = 3` (`:54`).
- Slim the `createTask` wiring (`:1023`) to drop the `criteria` param:

```ts
createTask: (g) => runWorkTask(sessionId, g, []),
```

`gmail/analyze.ts` — delete `maxVerifyRounds: 0,` (`:81`).

- [ ] **Step 6: Delete the `set_acceptance_criteria` tool + its capture surface**

```bash
git rm apps/desktop/src/service/tools/acceptance-criteria.ts
```

In `builtins.ts`: delete `import { acceptanceCriteriaSpec } from './acceptance-criteria'` (`:10`) and `registry.register(acceptanceCriteriaSpec())` (`:87`).

In `registry.ts` `ToolRunContext` (`:24-87`), delete the `setAcceptanceCriteria?(...)` field (`:77-81`) and its doc comment. (Keep `setDelegationPlan`.)

In `create-task.ts`: drop the `acceptanceCriteria` schema field, the `AcceptanceCriterion` import (`:3`), and pass only the goal. The new file body:

```ts
import type { AgentTool } from '@earendil-works/pi-agent-core'
import { Type } from '@earendil-works/pi-ai'

import type { ToolRunContext, ToolSpec } from './registry'

const CreateTaskParams = Type.Object({
  goal: Type.String({ description: 'The concrete goal of the work task.' }),
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
        "Create a real work task that you will do yourself, appearing in the task panel. Use this when the user's request is substantial work worth its own tracked task — NOT for trivial questions you can answer directly. You own verifying your own work before reporting done. Returns the task's result.",
      parameters: CreateTaskParams,
      execute: async (_toolCallId: string, params: unknown) => {
        const p = params as { goal: string }
        if (!ctx.createTask) {
          return {
            content: [{ type: 'text' as const, text: 'create_task is not available in this context.' }],
            details: { error: 'not_wired' },
          }
        }
        const { taskId, result } = await ctx.createTask(p.goal)
        return {
          content: [{ type: 'text' as const, text: result.summary }],
          details: { taskId, summary: result.summary },
        }
      },
    }),
  }
}
```

- [ ] **Step 7: Update the `AgentRunnerDeps.createTask` type + `ToolRunContext.createTask`**

In `agent-runner.ts` `AgentRunnerDeps.createTask` (`:234-238`), drop the `criteria` param:

```ts
/** Agent-authored work: create a top-level work Task (single-shot), await, return result. */
createTask?(goal: string): Promise<{ taskId: string; result: TaskResult }>
```

In `registry.ts` `ToolRunContext.createTask` (`:41-42`), match it:

```ts
createTask?(goal: string): Promise<{ taskId: string; result: TaskResult }>
```

- [ ] **Step 8: Sweep tests that referenced the removed fields**

```bash
git rm apps/desktop/src/service/session/agent-runner.verify.test.ts
```

In `manager.test.ts`, find the test from 3a that asserts `deps.maxVerifyRounds > 0` on the `runWorkTask` path (the `'runWorkTask creates a top-level work task and runs the verify runner'` test) and rewrite it to the single-shot model — assert the runner is constructed (the stub records one `run()`), no `maxVerifyRounds` is read:

```ts
it('runWorkTask creates a top-level work task and runs it single-shot', async () => {
  const calls: number[] = []
  mockCreate.mockImplementation(() => {
    calls.push(1)
    return runner(vi.fn().mockResolvedValue(runnerReturn('completed', 'done')))
  })
  const store = createConversationStore(dbPath)
  const manager = createSessionManager({ store, broadcaster: createBroadcaster(), maxConcurrent: 2, getProvider: () => undefined })
  const { sessionId } = manager.createSession(providerA)
  const out = await (manager as unknown as { __runWorkTaskForTest: (sid: string, goal: string) => Promise<{ taskId: string; result: { summary: string } }> }).__runWorkTaskForTest(sessionId, 'build feature X')
  expect(calls).toHaveLength(1)
  expect(out.result.summary).toBe('done')
  const task = store.getSessionTasks(sessionId).find((t) => t.id === out.taskId)
  expect(task?.parentId).toBeNull()
  store.close()
})
```

Search for any other test referencing `maxVerifyRounds`, `verifyCompletion`, `acceptanceCriteria`, `runGoalVerifyLoop`, `verifyTask`, `set_acceptance_criteria`, or `defaultVerifyCompletion` and delete/rewrite it:

```bash
grep -rn "maxVerifyRounds\|verifyCompletion\|runGoalVerifyLoop\|verifyTask\|defaultVerifyCompletion\|set_acceptance_criteria" apps --include="*.ts" --include="*.tsx"
```

Each surviving hit must be updated to the single-shot model or deleted. (`multi-level-verify.e2e.test.ts` is rewritten in Task 7.)

- [ ] **Step 9: Typecheck + run tests + format + commit**

```bash
find . -name "*.tsbuildinfo" -delete
npm --prefix apps/desktop run typecheck   # or: npx tsc -b
npm --prefix apps/desktop test
npx biome check --write apps/desktop/src/service/session/agent-runner.ts apps/desktop/src/service/session/manager.ts apps/desktop/src/service/gmail/analyze.ts apps/desktop/src/service/tools/builtins.ts apps/desktop/src/service/tools/registry.ts apps/desktop/src/service/tools/create-task.ts apps/desktop/src/service/session/manager.test.ts
git add -A
git commit -m "refactor(runner): collapse to single-shot, delete verify.ts + set_acceptance_criteria

3b: every run is single-shot (no system verify loop). The agent self-verifies
with its own tools. Removes runGoalVerifyLoop/defaultVerifyCompletion/Phase A,
the maxVerifyRounds/verifyCompletion/acceptanceCriteria/onAcceptanceCriteria
deps, verify.ts, and the set_acceptance_criteria tool. The onDelegationPlan
emit wrapper is preserved."
```

---

### Task 2: Slim `spawn_sub_agent` / `set_delegation_plan`; drop the `spawnChild` options param

**Files:**
- Modify: `apps/desktop/src/service/tools/spawn.ts`, `apps/desktop/src/service/tools/delegation-plan.ts`.
- Modify: `apps/desktop/src/service/session/agent-runner.ts` (`AgentRunnerDeps.spawnChild` signature `:226-233`), `apps/desktop/src/service/tools/registry.ts` (`ToolRunContext.spawnChild` `:34-40`).
- Modify: `apps/desktop/src/service/session/manager.ts` (the `spawnChild` impl signature + the `:601` childTask line).
- Test: `apps/desktop/src/service/tools/spawn.test.ts` (if present), `delegation-plan` tests.

**Interfaces:**
- Produces: `spawn_sub_agent` takes only `{ goal, agentType?, suggestedTools?, providerKey? }`; `set_delegation_plan` items take only `{ goal, ownerAgentType?, dependsOn? }`; `spawnChild` has no `options` param (the `SpawnChildOptions` type is now unused — deleted in Task 5).

- [ ] **Step 1: Slim `spawn_sub_agent`**

Rewrite `apps/desktop/src/service/tools/spawn.ts`. Drop the `acceptanceCriteria` and `verify` params, the `SpawnChildOptions` import, and the `options` construction; call `ctx.spawnChild` without the trailing `options` arg:

```ts
import type { AgentTool } from '@earendil-works/pi-agent-core'
import { Type } from '@earendil-works/pi-ai'

import type { ToolRunContext, ToolSpec } from './registry'

const SpawnParams = Type.Object({
  goal: Type.String({ description: 'The goal for the sub-agent to accomplish.' }),
  agentType: Type.Optional(
    Type.String({
      description:
        'Which sub-agent type to use; see the available types in your prompt. Defaults to "default" (full tool access).',
    })
  ),
  suggestedTools: Type.Optional(
    Type.Array(Type.String(), {
      description: "Override the agent type's default tools with these scopes (e.g. [\"peekaboo\"]).",
    })
  ),
  providerKey: Type.Optional(
    Type.String({
      description: 'Key of a configured provider to use for this sub-agent. Defaults to current session provider.',
    })
  ),
})

export function spawnAgentSpec(): ToolSpec {
  return {
    group: 'agent',
    name: 'spawn_sub_agent',
    risk: 'medium',
    source: 'builtin',
    build: (ctx: ToolRunContext): AgentTool => ({
      name: 'spawn_sub_agent',
      label: 'Spawn sub-agent',
      description:
        'Delegate a focused sub-task to a sub-agent. Delegate when a sub-task is independent, benefits from its own focused context, or should run under a narrower capability boundary; do trivial single-step work yourself. Pick an agentType from the list in your prompt. The sub-agent runs single-shot and returns its result; review the result yourself before reporting done.',
      parameters: SpawnParams,
      execute: async (_toolCallId: string, params: unknown) => {
        const p = params as { goal: string; agentType?: string; suggestedTools?: string[]; providerKey?: string }
        const { childTaskId, result } = await ctx.spawnChild(
          p.goal,
          p.suggestedTools,
          p.providerKey,
          p.agentType
        )
        return {
          content: [{ type: 'text', text: result.summary }],
          details: { childTaskId, summary: result.summary },
        }
      },
    }),
  }
}
```

- [ ] **Step 2: Drop per-item criteria from `set_delegation_plan`**

In `delegation-plan.ts`: drop the `AcceptanceCriterionSchema` import (`:4`), the `acceptanceCriteria` schema field (`:27-42`), the criteria-parsing block (`:92-103`), and the `...(criteria ? { acceptanceCriteria: criteria } : {})` in the entry (`:109`). Update the `description` (`:46`) to drop "Attach acceptanceCriteria…". The tool still records `{ id, goal, ownerAgentType?, dependsOn? }` and routes via `ctx.setDelegationPlan`.

- [ ] **Step 3: Drop the `options` param from the `spawnChild` signatures**

`agent-runner.ts` `AgentRunnerDeps.spawnChild` (`:226-233`):

```ts
spawnChild(
  parentTaskId: string,
  newGoal: string,
  suggestedTools?: string[],
  providerKey?: string,
  agentType?: string
): Promise<{ childTaskId: string; result: TaskResult }>
```

`registry.ts` `ToolRunContext.spawnChild` (`:34-40`):

```ts
spawnChild(
  goal: string,
  suggestedTools?: string[],
  providerKey?: string,
  agentType?: string
): Promise<{ childTaskId: string; result: TaskResult }>
```

`buildToolContext` (`:339-340`) already forwards positionally; drop the trailing `options` arg there:

```ts
spawnChild: (goal, suggestedTools, providerKey, agentType) =>
  deps.spawnChild(ctx.id, goal, suggestedTools, providerKey, agentType),
```

- [ ] **Step 4: Update the manager `spawnChild` impl**

In `manager.ts` `spawnChild`, change the signature to drop the `options?: SpawnChildOptions` param (and the `SpawnChildOptions` import if now unused). Delete `acceptanceCriteria: options?.acceptanceCriteria,` (`:601`) from the `childTask` object literal. The body no longer reads `options` (Task 1 already removed the `maxVerifyRounds` line). The call sites that pass `spawnChild(...)` (the `(pt, ng, st, pk, at, opt) => spawnChild(sessionId, pt, ng, st, pk, at, opt)` adapters in `:653, :801, :1022`) drop their trailing `opt`/`at`... — keep `agentType` (5th param) but drop `options` (6th): `(pt, ng, st, pk, at) => spawnChild(sessionId, pt, ng, st, pk, at)`.

- [ ] **Step 5: Update tool tests + typecheck + run + format + commit**

Update any `spawn.test.ts` / `delegation-plan` test fixtures that pass `acceptanceCriteria`/`verify`/`options` to the new schemas. Then:

```bash
find . -name "*.tsbuildinfo" -delete
npm --prefix apps/desktop run typecheck
npm --prefix apps/desktop test -- spawn delegation plan
npx biome check --write apps/desktop/src/service/tools/spawn.ts apps/desktop/src/service/tools/delegation-plan.ts apps/desktop/src/service/session/agent-runner.ts apps/desktop/src/service/tools/registry.ts apps/desktop/src/service/session/manager.ts
git add -A
git commit -m "refactor(tools): drop criteria from spawn_sub_agent + set_delegation_plan; remove spawnChild options"
```

---

### Task 3: Remove criteria/verification persistence (manager + store)

**Files:**
- Modify: `apps/desktop/src/service/session/manager.ts` (the `makeEmit` persist blocks `:287-299`).
- Modify: `apps/desktop/src/service/conversation/store.ts` (interface `:85-86`; hydration `:335-336`; INSERT `:523, :854-855`; methods `:629, :829-832`).
- Test: `apps/desktop/src/service/conversation/store.test.ts`.

**Interfaces:** Produces: the manager no longer persists `task.criteria` / `task.verification`; the store no longer reads/writes `acceptance_criteria` / `verifications` (the DB columns stay, defaulting to `'[]'`).

- [ ] **Step 1: Delete the `task.criteria` and `task.verification` persist blocks**

In `manager.ts` `makeEmit` (`:260-306`), delete the two `if` blocks:
- `if (event === 'task.criteria' && taskId && Array.isArray(obj?.criteria)) { ... }` (`:287-291`).
- `if (event === 'task.verification' && taskId && obj?.round) { ... }` (`:292-299`).

(Nothing emits these events after Task 1, but removing the blocks also drops the `AcceptanceCriterion`/`VerificationRound` casts here.)

- [ ] **Step 2: Stop reading/writing the columns in `store.ts`**

- Delete the interface entries `saveTaskCriteria` and `saveTaskVerifications` (`:85-86`).
- Delete the prepared statement `stmtSetTaskVerifications` (`:629`) and the method impls `saveTaskCriteria` / `saveTaskVerifications` (`:829-832`).
- In the task-hydration SELECT and mapping, drop `acceptance_criteria` / `verifications`: remove them from the SELECT column list (`:523` area) and from the row mapping (`:335-336`).
- In `saveTask`, drop `acceptance_criteria, verifications` from the INSERT column list (`:523`) and the two `JSON.stringify(task.acceptanceCriteria …)` / `JSON.stringify(task.verifications …)` values (`:854-855`).
- **Keep** the schema column declaration `verifications TEXT NOT NULL DEFAULT '[]'` (`:177`), the `ALTER TABLE … ADD COLUMN verifications` migration (`:281`), and (if present) the `acceptance_criteria` column declaration — they are harmless dead columns; a revert needs no migration.

- [ ] **Step 3: Update store tests + typecheck + run + format + commit**

Drop any `store.test.ts` case that calls `saveTaskCriteria` / `saveTaskVerifications` or asserts hydrated `acceptanceCriteria` / `verifications`. Then:

```bash
find . -name "*.tsbuildinfo" -delete
npm --prefix apps/desktop run typecheck
npm --prefix apps/desktop test -- store
npx biome check --write apps/desktop/src/service/session/manager.ts apps/desktop/src/service/conversation/store.ts
git add -A
git commit -m "refactor(store): drop criteria/verification persistence (columns kept)"
```

---

### Task 4: Renderer — delete the verification panel + handlers

**Files:**
- Delete: `apps/desktop/src/renderer/src/components/verify-panel.tsx`.
- Modify: `apps/desktop/src/renderer/src/components/right-panel.tsx`, `apps/desktop/src/renderer/src/components/views/tasks-view.tsx`, `apps/desktop/src/shared/lib/apply-event.ts`.
- Test: `apps/desktop/src/shared/lib/apply-event.test.ts`, any `verify-panel` test.

**Interfaces:** Produces: no renderer code references `AcceptanceCriterion` / `VerificationRound` / `task.criteria` / `task.verification` / `verifyGroups` / `VerifyPanel`. (The protocol types still exist — deleted in Task 5.)

- [ ] **Step 1: Delete `verify-panel.tsx`**

```bash
git rm apps/desktop/src/renderer/src/components/verify-panel.tsx
```

- [ ] **Step 2: Drop the verify tab from `right-panel.tsx`**

Remove the `VerifyPanel`/`VerifyGroup` import (`:9`), the `verifyGroups` prop (`:14, :17`), the `'verify'` literal from the tab state union + `TabsTrigger`/`TabsContent` (`:19, :99, :107, :128-129`), and the badge/button that opens it (`:81-84`). The component keeps the `plan`/`memory`/`scheduled` tabs.

- [ ] **Step 3: Drop `verifyGroups` from `tasks-view.tsx`**

Delete the `verifyGroups` computation (`:53-63`) and the `verifyGroups={verifyGroups}` prop on `<RightPanel>` (`:176`).

- [ ] **Step 4: Drop the criteria/verification handlers from `apply-event.ts`**

Delete `case 'task.criteria':` (`:111-112`) and `case 'task.verification':` (`:114-117`), the `verifications?: VerificationRound[]` field on the record type (`:26`), and the now-unused `VerificationRound` import.

- [ ] **Step 5: Update renderer tests + typecheck + run + format + commit**

Drop `apply-event.test.ts` cases for `task.criteria` / `task.verification`. Then:

```bash
find . -name "*.tsbuildinfo" -delete
npm --prefix apps/desktop run typecheck
npm --prefix apps/desktop test -- apply-event tasks-view
npx biome check --write apps/desktop/src/renderer/src/components/right-panel.tsx apps/desktop/src/renderer/src/components/views/tasks-view.tsx apps/desktop/src/shared/lib/apply-event.ts
git add -A
git commit -m "refactor(renderer): remove the verification panel + criteria/verification handlers"
```

---

### Task 5: Delete the criteria/verify protocol types + Task fields

**Files:**
- Modify: `packages/protocol/src/types/task.ts`.

**Interfaces:** Produces: `AcceptanceCriterion`, `ExecutableCheck`, `VerificationResult`, `VerificationRound`, and `SpawnChildOptions` are gone; `DelegationItem`, `TaskOptions`, and `Task` no longer carry criteria/verifications fields.

**Note:** This is the "definitions last" task — all consumers were removed in Tasks 1-4, so the types are now unused and the deletion typechecks clean.

- [ ] **Step 1: Delete the type/schema declarations**

In `packages/protocol/src/types/task.ts`, delete:
- `ExecutableCheckSchema` + `ExecutableCheck` (`:71-84`).
- `AcceptanceCriterionSchema` + `AcceptanceCriterion` (`:88-93`).
- `VerificationResultSchema` + `VerificationResult` (`:95-100`).
- `VerificationRoundSchema` + `VerificationRound` (`:103-110`).
- `SpawnChildOptions` (`:128-134`).

- [ ] **Step 2: Drop the criteria/verifications fields**

- `DelegationItemSchema` (`:115-125`): delete the `acceptanceCriteria` field (`:123-124`); update the doc comment (`:112-114`) to drop "passed down … as its contract."
- `TaskOptionsSchema` (`:137-147`): delete the `acceptanceCriteria` field (`:146`) and its doc comment (`:144-145`).
- `TaskSchema` (`:231-265`): delete `acceptanceCriteria` (`:258-260`) and `verifications` (`:261-262`) and their doc comments.

- [ ] **Step 3: Sweep stragglers + typecheck + run + format + commit**

Verify nothing else references the deleted types (the earlier tasks removed the service/renderer consumers; this catches anything missed):

```bash
grep -rn "AcceptanceCriterion\|ExecutableCheck\|VerificationRound\|VerificationResult\|SpawnChildOptions" apps packages --include="*.ts" --include="*.tsx"
find . -name "*.tsbuildinfo" -delete
npm --prefix apps/desktop run typecheck
npm --prefix apps/desktop test
npx biome check --write packages/protocol/src/types/task.ts
git add -A
git commit -m "refactor(protocol): delete AcceptanceCriterion/Verification*/SpawnChildOptions + Task criteria fields"
```

Every grep hit must be resolved (delete or update) before committing.

---

### Task 6: De-criterion the builtin agent prompts

**Files:**
- Modify: `packages/shared/src/constants/agents.ts`.
- Test: any agent-prompt snapshot test.

**Interfaces:** Produces: no builtin prompt references `set_acceptance_criteria`, "acceptance criteria" as a system concept, or a system verify loop. Worker prompts explicitly own self-verification; Leader prompts review delegated work from returned summaries.

- [ ] **Step 1: CEO prompt — drop the criteria/verify sentence**

In `agents.ts`, the CEO prompt's last paragraph (`:21`) currently says: "Before delegating, define checkable acceptance criteria for each task (use set_acceptance_criteria)… verify that critical deliverables passed their acceptance checks — do not report success for unverified work." Replace it with:

```ts
Before producing your final summary, spot-check that critical deliverables actually landed (ask the head for evidence — file paths, a green test run) rather than trusting the report alone. Do not claim success for work you cannot evidence.'
```

- [ ] **Step 2: Engineering Lead prompt — drop criteria references**

In `ENGINEERING_LEAD_SYSTEM_PROMPT`:
- Step 1 (`:31`): change "what to build, where, acceptance criteria" → "what to build, where, and a concrete definition of done".
- The trailing paragraph (`:38`): delete "When delegating to the engineer, include acceptance criteria so the reviewer has clear standards." Keep the self-check and coverage sentences.

- [ ] **Step 3: Reviewer prompt — replace "acceptance criteria"**

In `REVIEWER_SYSTEM_PROMPT` step 2 (`:60`), change "and that the task's acceptance criteria are met" → "and that the task meets its stated requirements (the definition of done the Lead gave)". (The dev team's engineer→reviewer loop stays — it is agent-chosen review via `spawn_sub_agent`, not a system verify loop.)

- [ ] **Step 4: Workers — ensure self-verify guidance is present**

`ENGINEER_SYSTEM_PROMPT` (`:40-54`) already says "Run the relevant tests/build to verify your work" and has a "Pre-submit self-check" block — keep as-is. For any other worker prompt (ops, data, etc.) that lacks it, add one line: "Before reporting done, verify your work with your own tools (run the tests/build, check the files) and report the actual result — never claim success you did not verify."

- [ ] **Step 5: Sweep remaining criteria/verify phrasing**

```bash
grep -n "acceptance criteria\|set_acceptance_criteria\|acceptance check" packages/shared/src/constants/agents.ts
```

Reword each survivor so no prompt treats acceptance criteria as a system mechanism or references the deleted tool.

- [ ] **Step 6: Update snapshot tests + run + format + commit**

Update any agent-prompt snapshot test to the new strings. Then:

```bash
npm --prefix apps/desktop test -- agents
npx biome check --write packages/shared/src/constants/agents.ts
git add -A
git commit -m "refactor(agents): de-criterion builtin prompts; workers own self-verification"
```

---

### Task 7: e2e regression + full suite + smoke

**Files:**
- Modify: `apps/desktop/src/service/e2e/multi-level-verify.e2e.test.ts` (rewrite for single-shot delegation); add `apps/desktop/src/service/e2e/agent-driven-verify.e2e.test.ts`.

- [ ] **Step 1: Rewrite the multi-level-verify e2e for single-shot delegation**

`multi-level-verify.e2e.test.ts` asserts verify rounds / criteria on a CEO→Leader→engineer run. Rewrite it to the agent-driven model: each level runs single-shot, no `task.verification` is persisted, no criteria are derived. Assert: the work task completes in one shot; `store.getTask(taskId).verifications` is absent/empty (the column stays, value `'[]'`); a Leader child runs single-shot and self-reports.

- [ ] **Step 2: Add an agent-driven-verify e2e**

```ts
it('a work task runs single-shot with no verify rounds; delegation is single-shot', async () => {
  const store = createConversationStore(tmpDb())
  const manager = createManagerWithStubbedRunner({ store, reply: 'done' })
  const { sessionId } = manager.createSession(providerA)

  const work = await (manager as unknown as { __runWorkTaskForTest: (s: string, g: string) => Promise<{ taskId: string }> }).__runWorkTaskForTest(sessionId, 'build it')
  const task = store.getSessionTasks(sessionId).find((t) => t.id === work.taskId)
  // No verification audit (single-shot, agent-driven).
  expect((task as { verifications?: unknown }).verifications ?? []).toHaveLength(0)
  expect((task as { acceptanceCriteria?: unknown }).acceptanceCriteria ?? []).toHaveLength(0)
  store.close()
})
```

(`createManagerWithStubbedRunner` mirrors the scaffolding in the existing e2e tests.)

- [ ] **Step 3: Run the full suite**

Run: `npm --prefix apps/desktop test`
Expected: PASS (full suite, modulo the known `gmail.test` htmlBody fixture + `host.test` EADDRINUSE :47777 when the app is running).

- [ ] **Step 4: Format + commit**

```bash
npx biome check --write apps/desktop/src/service/e2e/multi-level-verify.e2e.test.ts apps/desktop/src/service/e2e/agent-driven-verify.e2e.test.ts
git add -A
git commit -m "test(e2e): single-shot work tasks + delegation; no verify rounds"
```

- [ ] **Step 5: Manual smoke**

`pnpm dev` (quit any running instance first — single-instance lock). With a configured provider:
- Send "你好" → expect a direct chat reply, **no task card, no verify spinner**.
- Send a substantial goal the agent turns into `create_task` → expect a work task in the panel that completes in one shot, **no verify rounds, no verification tab**.
- Run a CEO delegation ("在 /tmp 建个 demo 项目") → expect CEO→Leader→engineer to run fully single-shot; the Leader self-reports.
- Cancel a mid-flight turn → expect it stops.
Record outcomes; do not commit.

- [ ] **Step 6: Integrate to develop**

```bash
git rebase develop
git checkout develop
git merge --ff-only worktree-phase3b-agent-driven-verify
```

---

## Self-Review

**Spec coverage:**
- §4 verify model (no tool, agent self-checks, Leader trusts self-judgment) → Task 1 (runner single-shot) + Task 6 (prompts). ✓
- §5.1 agent-runner deletions (loop, Phase A, helpers, deps, run collapse; executionMode kept) → Task 1 steps 1-3. ✓
- §5.2 delete `verify.ts` → Task 1 step 4. ✓
- §5.3 manager call-site + persist cleanup; `runWorkTask` single-shot → Task 1 step 5 (call sites) + Task 3 step 1 (persist). ✓
- §5.4 tools: delete `set_acceptance_criteria`; slim spawn/create_task/set_delegation_plan; drop `setAcceptanceCriteria`, keep `setDelegationPlan` → Task 1 step 6 (acceptance-criteria + create-task) + Task 2 (spawn + delegation + spawnChild options). ✓
- §5.5 protocol deletions; `SpawnChildOptions` emptied→deleted; DB columns kept → Task 3 step 2 (store, columns kept) + Task 5 (protocol types). ✓
- §5.6 builtin prompts → Task 6. ✓
- §5.7 renderer (VerifyPanel, verify groups, apply-event handlers) → Task 4. ✓
- §6 data flow (create_task single-shot, no verification events) → Task 1 + Task 7 e2e. ✓
- §7 OPEN DESIGN Q (create_task stays; inline/create_task/spawn policy in prompt) → Task 6 step 4 (worker self-verify) + the `create_task`/`spawn_sub_agent` descriptions updated in Task 1 step 6 / Task 2 step 1. ✓
- §8 concurrency/cancel/budget unchanged → no task touches them (3a wiring preserved). ✓
- §9 behavior changes (incl. vision/gmail-analyze side benefit) → Task 1 step 5 (gmail/analyze.ts) + run collapse (vision sub-run inherits single-shot). ✓
- §10 test strategy → every task gate + Task 7. ✓
- §11 verification (npm test, biome scoped, typecheck, smoke) → every task + Task 7. ✓
- §12 rollback (deletion; DB columns kept) → Task 3 step 2 (columns kept). ✓
- §13 forward pointers (Phase 4 = Task-as-execution-unit + merge; 3c) — explicitly out of scope; no task touches them. ✓

**Placeholder scan:** No "TBD"/"implement later". Deletion steps name the exact symbol + line range to remove; replacement code (collapsed `run`, slimmed tools, prompt edits) is shown in full. The test-sweep steps (Task 1 step 8, Task 5 step 3) use a grep to enumerate surviving references rather than guessing them — the grep output is the authoritative list, and the step requires every hit resolved before commit.

**Type consistency:** `createTask(goal)` (no criteria) is consistent across `AgentRunnerDeps` (Task 1 step 7), `ToolRunContext` (Task 1 step 7), the tool (Task 1 step 6), and the manager wiring (Task 1 step 5). `spawnChild(goal, suggestedTools?, providerKey?, agentType?)` (no options) is consistent across `AgentRunnerDeps` (Task 2 step 3), `ToolRunContext` (Task 2 step 3), `buildToolContext` (Task 2 step 3), the tool (Task 2 step 1), and the manager impl (Task 2 step 4). `DelegationItem` loses `acceptanceCriteria` consistently in protocol (Task 5) and the tool (Task 2 step 2). `Task` / `TaskOptions` lose their criteria/verifications fields in protocol (Task 5) after the store (Task 3) and renderer (Task 4) stopped touching them.

**Green-at-each-commit check:** Consumers are removed before definitions: runner fields (T1) → spawnChild options + tool params (T2) → store/manager persist (T3) → renderer (T4) → protocol types (T5). `AcceptanceCriterion`/`VerificationRound` stay defined until T5, so T1-T4 compile while they migrate off them. Prompt edits (T6) are text-only and compile-independent. Each task ends with typecheck + test + commit.

**One risk noted:** Task 1 step 8's test sweep is the largest unknown — the number of tests that referenced the verify machinery across `manager.test.ts`, the e2e, and any tool tests. The grep in that step is authoritative; budget time for it, and run the full suite (not just filtered) before the Task 1 commit.
