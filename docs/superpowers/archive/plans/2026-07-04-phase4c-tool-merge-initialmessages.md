# Phase 4c — Tool Merge + `initialMessages` Seeding + Cleanup (Implementation Plan)

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Merge `create_task` + `spawn_sub_agent` into one `create_task` tool (with `asTopLevel`), fold the runner's one-shot `goal` into `initialMessages`, and clear the 4b Minors — completing the conversation/task-separation redesign.

**Architecture:** Layered, green at each commit. (1) Cleanup batch (mechanical Minors). (2) `goal` → `initialMessages`: callers bake the goal into `initialMessages`; the runner extracts it (pi's `agent.prompt(goal)` still receives a goal — no pi API change); `AgentRunnerDeps.goal` drops; resident `promptOnce(goal)` unchanged. (3) Tool merge: one `create_task{goal, asTopLevel?, agentType?, suggestedTools?, providerKey?}` dispatching to `runWorkTask` (`asTopLevel`) or `spawnChild` (default); `spawn_sub_agent` deleted.

**Tech Stack:** TypeScript, `vitest`, `@earendil-works/pi-agent-core`, Electron (test runner).

## Global Constraints

- **Spec:** `docs/superpowers/specs/2026-07-04-phase4c-tool-merge-initialmessages-design.md` (authoritative).
- **Run tests via `npm test`** (Electron node runner). Single-file: `npm --prefix apps/desktop test -- <filter>`.
- **Behavior green at every commit** (full suite, modulo the known pre-existing `gmail.test` htmlBody failure).
- **Typecheck clean at every commit**; delete stale `**/*.tsbuildinfo` before trusting `npx tsc -b`.
- **Comments and commit messages in English.**
- **Scoped formatting:** `npx biome check --write <file>`.
- **Precise `git add <paths>`**, NEVER `git add -A`.
- **One commit per task**, on `worktree-phase4c-merge`. Integrate to `develop` via `git rebase develop` + `git merge --ff-only`.
- **Resident actors are untouched by 3c:** `runResident`'s per-turn `promptOnce(goal)` is unchanged.

## File Structure

- **Modify** `apps/desktop/src/service/session/agent-runner.ts` — drop `AgentRunnerDeps.goal`; extract the one-shot goal from `initialMessages` in `resolveRunContext`; narrow `saveSnapshot` signature (cleanup).
- **Modify** `apps/desktop/src/service/session/manager.ts` — bake the goal into `initialMessages` at every one-shot caller (`submitGoal`, `runWorkTask`, `spawnChild`); delete the dead `saveSnapshot` 'session' branch in `runTaskTurn`; drop the `as UIEvent` cast in `markInterruptedRunsTerminal`; clear stale `makeEmit` comments; extend `createTask` wiring to accept `agentType`.
- **Modify** `apps/desktop/src/service/session/seq-counter.ts` — rename `ConversationEventRow` → `RunEventRow`.
- **Modify** `apps/desktop/src/service/tools/create-task.ts` — merged tool with `asTopLevel`.
- **Delete** `apps/desktop/src/service/tools/spawn.ts` (+ `spawn.test.ts`).
- **Modify** `apps/desktop/src/service/tools/builtins.ts` — drop `spawnAgentSpec`.
- **Modify** `packages/protocol/src/types/agent.ts` (or wherever `ToolRunContext` lives — confirm via grep) — `createTask?(goal: string, agentType?: string)`.
- **Adapt tests:** `create-task.test.ts` (merged-suite), `agent-runner.test.ts`, `manager.test.ts`, `seq-counter.test.ts`.

---

### Task 1: Cleanup batch (4b Minors)

**Files:**
- Modify: `apps/desktop/src/service/session/seq-counter.ts` (rename `ConversationEventRow` → `RunEventRow` + all callers).
- Modify: `apps/desktop/src/service/session/manager.ts` (`runTaskTurn` dead `saveSnapshot` 'session' branch ~`:779`; `markInterruptedRunsTerminal` synthetic-event cast ~`:908`; stale `makeEmit` comments).
- Modify: `apps/desktop/src/renderer/src/lib/task-segments.ts:90`, `apps/desktop/src/service/e2e/unified-runs.e2e.test.ts:15`, `apps/desktop/src/service/session/manager.test.ts` (stale `makeEmit` comments).
- Test: existing suite (mechanical; no new tests).

**Interfaces:**
- Produces: `RunEventRow` (renamed from `ConversationEventRow`) — the seq-counter source-row type.

- [ ] **Step 1: Rename `ConversationEventRow` → `RunEventRow`**

In `seq-counter.ts`, rename the exported type + its usages, and update the header comment (it still mentions "conversation events"). Then sweep callers:

```bash
grep -rln "ConversationEventRow" apps/desktop/src
```

Update each to `RunEventRow` (type references + imports). The symbol is unique.

- [ ] **Step 2: Delete the dead `saveSnapshot` 'session' branch in `runTaskTurn`**

In `manager.ts`, `runTaskTurn` is only called by `runWorkTask` with `messageSource: 'isolated'`, so the `'session'` branch of its `saveSnapshot` (and the `messageSource`-conditional `initialMessages`) is dead. Replace:

```ts
saveSnapshot: (messages, used, contextWindow) => {
  // ... both branches
},
```

with the isolated branch only (save the agent snapshot; the `task.usage` event already carries usage — no `saveTaskUsage`/`saveSessionUsage` call needed here):

```ts
saveSnapshot: (messages) => {
  store.saveAgentSnapshot(sessionId, messages)
},
```

Drop the now-unused `messageSource` param from `runTaskTurn`'s signature if it has no other use. (If `submitGoal` has its own `saveSnapshot` in its inline runner construction — confirm it's separate and leave it.)

- [ ] **Step 3: Drop the `as UIEvent` cast on the synthetic interrupted event**

In `manager.ts` `markInterruptedRunsTerminal`, the synthetic event is built as a plain object then cast `as import('@swarm/protocol').UIEvent`. Construct it as a typed `task.error` UIEvent directly so no cast is needed:

```ts
const event: import('@swarm/protocol').UIEvent = {
  kind: 'task.error',
  sessionId: s.id,
  taskId: runId,
  error: { code: 'cancelled', message: 'run interrupted by restart', tier: 'fatal' },
  ts: Date.now(),
  seq: seqCounter.nextSeq(s.id),
}
store.appendRunEvent(s.id, runId, null, event)
```

- [ ] **Step 4: Clear stale `makeEmit` comments**

Update the stale `makeEmit` references in comments/docstrings to `makeRunEmit` (the unified factory from 4b Task 7): `task-segments.ts:90`, `unified-runs.e2e.test.ts:15`, `manager.ts` `makeRunEmit` docstring, `manager.test.ts`, `seq-counter.ts` header. Read each first; if the comment is accurate, leave it.

- [ ] **Step 5: Test hygiene nits**

In `manager.test.ts` (or wherever): drop the redundant `?? undefined` on `terminalRegistry.getStatus(...)` (it returns `undefined` already); make the `terminalStatus as TerminalStatus` cast consistent across the orphan-recovery tests (or remove by typing the fixture).

- [ ] **Step 6: Run suite + typecheck + format + commit**

```bash
find . -name "*.tsbuildinfo" -delete
npm --prefix apps/desktop test
npm --prefix apps/desktop run typecheck
npx biome check --write $(grep -rln "ConversationEventRow\|makeEmit" apps/desktop/src) apps/desktop/src/service/session/manager.ts apps/desktop/src/service/session/seq-counter.ts
git add -u apps/desktop/src
git commit -m "refactor(4c): cleanup batch — rename RunEventRow, drop dead saveSnapshot branch, clear stale comments"
```

---

### Task 2: `goal` → `initialMessages` (one-shot seeding)

**Files:**
- Modify: `apps/desktop/src/service/session/agent-runner.ts` — drop `AgentRunnerDeps.goal` (~`:191`); extract the one-shot goal from `initialMessages` in `resolveRunContext` (~`:572-595`).
- Modify: `apps/desktop/src/service/session/manager.ts` — bake the goal into `initialMessages` at `submitGoal` (~`:1025`), `runWorkTask`/`runTaskTurn` (~`:742-757`), `spawnChild` (~`:597-612`).
- Modify: `apps/desktop/src/service/session/agent-runner.ts` `buildAnalyzeImage` (~`:340-382`) — vision sub-call.
- Test: `apps/desktop/src/service/session/agent-runner.test.ts`, `apps/desktop/src/service/session/manager.test.ts`, `apps/desktop/src/service/e2e/unified-runs.e2e.test.ts`.

**Interfaces:**
- Consumes: none new.
- Produces: `AgentRunnerDeps` has NO `goal` field; one-shot callers pass `initialMessages` whose last entry is the goal as a user message. `AgentSession.promptOnce(goal, images?)` signature UNCHANGED (the runner extracts the goal internally; resident passes per-turn goal as before).

- [ ] **Step 1: Write the failing test — a one-shot run seeded via initialMessages reaches terminal**

In `agent-runner.test.ts`, add (mirror the existing one-shot run fixture, but assert the goal comes from `initialMessages`, not a `goal` field):

```ts
it('one-shot run seeds the goal from the last initialMessages user turn', async () => {
  // Construct a runner with NO `goal`, initialMessages ending in the goal.
  const runner = createAgentRunner({
    correlationId: 'r1',
    cwd: undefined,
    // goal: intentionally omitted
    executionMode: 'goal',
    budget: { tokens: 1000, calls: 10, wallMs: 60000, usdCents: 10 },
    provider: testProvider,
    agentDefinition: { id: 'default', name: 'D', description: '', systemPrompt: '', toolScope: 'all', maxIterations: 5 },
    sessionId: 's',
    emit: () => undefined,
    permissionRegistry,
    toolRegistry,
    initialMessages: [
      { role: 'user', content: 'earlier context' },
      { role: 'user', content: 'do the thing' },
    ] as never,
    spawnChild: async () => ({ childTaskId: 'c', result: { summary: '', artifacts: [] } }),
  })
  const out = await runner.run()
  expect(out.status).toBe('completed')
  // The agent was prompted with "do the thing" (the last user message) — assert
  // via the emit stream or the mocked agent's received prompt.
})
```

(Adapt the fixture to the file's existing `testProvider`/`emit` capture pattern. The assertion: the runner prompted the agent with `'do the thing'` — capture via the mocked `agent.prompt` or the emit stream.)

- [ ] **Step 2: Run to verify it fails**

Run: `npm --prefix apps/desktop test -- agent-runner`
Expected: FAIL — `goal` is required on `AgentRunnerDeps` (type error surfaces when omitted).

- [ ] **Step 3: Drop `AgentRunnerDeps.goal` + extract goal in `resolveRunContext`**

In `agent-runner.ts`:
- Delete the `goal: string` field (~`:191`) + its docstring lines.
- In `resolveRunContext` (~`:572-595`), derive `goal` from `initialMessages` instead of `deps.goal`. Add a helper:

```ts
// The one-shot goal is the last initialMessages user turn (callers bake it in);
// the runner seeds the rest as prior context and prompts the agent with it.
// Resident runs don't use this — they pass a per-turn goal to promptOnce.
function extractOneShotGoal(initialMessages: AgentMessage[]): string {
  const last = initialMessages[initialMessages.length - 1]
  if (last && last.role === 'user') {
    const content = last.content
    return typeof content === 'string' ? content : ''
  }
  return ''
}
```

and in the resolved context object, `goal: extractOneShotGoal(deps.initialMessages)`. (If the resolved `task.goal` is read anywhere besides the one-shot `run()` + logging, this covers it.)

- [ ] **Step 4: Bake the goal into `initialMessages` at the three manager callers**

- `submitGoal` (~`:1015-1037`): drop the `goal,` line from the runner construction; change `initialMessages: session.messages` → `initialMessages: [...session.messages, { role: 'user', content: goal }]` (cast as the `AgentMessage` type the field expects).
- `runWorkTask` → `runTaskTurn` (~`:742-757`): drop `goal`; change `initialMessages: messageSource === 'session' ? session.messages : []` → `initialMessages: [{ role: 'user', content: goal }]` (work runs are fresh — prior history is empty; the goal is the sole seed). If `runTaskTurn` threaded `goal` from `runWorkTask`/`spawnChild`, those now thread it into `initialMessages` instead.
- `spawnChild` (~`:597-612`): drop `goal: newGoal`; change `initialMessages: []` → `initialMessages: [{ role: 'user', content: newGoal }]`.

- [ ] **Step 5: Bake the goal into `initialMessages` in `buildAnalyzeImage` (vision sub-call)**

In `agent-runner.ts` `buildAnalyzeImage` (~`:340-382`): drop `goal: prompt`; change `initialMessages: []` → `initialMessages: [{ role: 'user', content: prompt }]`. (`attachments` stays — it carries the image.)

- [ ] **Step 6: Run tests + typecheck + format + commit**

```bash
find . -name "*.tsbuildinfo" -delete
npm --prefix apps/desktop test -- agent-runner manager.test unified-runs
npm --prefix apps/desktop test
npm --prefix apps/desktop run typecheck
npx biome check --write apps/desktop/src/service/session/agent-runner.ts apps/desktop/src/service/session/manager.ts apps/desktop/src/service/session/agent-runner.test.ts
git add apps/desktop/src/service/session/agent-runner.ts apps/desktop/src/service/session/manager.ts apps/desktop/src/service/session/agent-runner.test.ts
git commit -m "refactor(runner): fold one-shot goal into initialMessages (3c)"
```

---

### Task 3: Merge `create_task` + `spawn_sub_agent` into one `create_task`

**Files:**
- Modify: `apps/desktop/src/service/tools/create-task.ts` — merged tool.
- Delete: `apps/desktop/src/service/tools/spawn.ts` + `spawn.test.ts`.
- Modify: `apps/desktop/src/service/tools/builtins.ts` — drop `spawnAgentSpec` import + registration.
- Modify: `ToolRunContext.createTask` signature (find via `grep -rn "createTask" apps/desktop/src packages/protocol/src`).
- Modify: `apps/desktop/src/service/session/manager.ts` — extend the `createTask` wiring (~`:1037`) to accept `agentType`.
- Test: rewrite `apps/desktop/src/service/tools/create-task.test.ts` (merged suite).

**Interfaces:**
- Produces: ONE tool `create_task` with params `{goal, asTopLevel?, agentType?, suggestedTools?, providerKey?}`. `asTopLevel: true` → `ctx.createTask(goal, agentType?)` → `runWorkTask`; `asTopLevel: false` (default) → `ctx.spawnChild(goal, suggestedTools, providerKey, agentType)` → `spawnChild`. `ToolRunContext.createTask` gains an optional `agentType` arg.

- [ ] **Step 1: Write the failing test — merged tool dispatches on `asTopLevel`**

In `create-task.test.ts`, rewrite the suite (the existing test + the deleted `spawn.test.ts` cases) to cover both branches of the single tool:

```ts
it('create_task asTopLevel=true routes to createTask (top-level work run)', async () => {
  const createTask = vi.fn().mockResolvedValue({ taskId: 'r1', result: { summary: 'done', artifacts: [] } })
  const spec = createTaskSpec().build({ createTask, spawnChild: vi.fn() } as never)
  await spec.execute('c1', { goal: 'build it', asTopLevel: true })
  expect(createTask).toHaveBeenCalledWith('build it', undefined)
})

it('create_task asTopLevel=false (default) routes to spawnChild with overrides', async () => {
  const spawnChild = vi.fn().mockResolvedValue({ childTaskId: 'c1', result: { summary: 'ok', artifacts: [] } })
  const spec = createTaskSpec().build({ createTask: vi.fn(), spawnChild } as never)
  await spec.execute('c1', { goal: 'research', agentType: 'researcher', suggestedTools: ['peekaboo'], providerKey: 'openai' })
  expect(spawnChild).toHaveBeenCalledWith('research', ['peekaboo'], 'openai', 'researcher')
})
```

- [ ] **Step 2: Run to verify it fails**

Run: `npm --prefix apps/desktop test -- create-task`
Expected: FAIL — `asTopLevel` not a recognized param / old tool shape.

- [ ] **Step 3: Rewrite `create-task.ts` as the merged tool**

```ts
import type { AgentTool } from '@earendil-works/pi-agent-core'
import { Type } from '@earendil-works/pi-ai'

import type { ToolRunContext, ToolSpec } from './registry'

const CreateTaskParams = Type.Object({
  goal: Type.String({ description: 'The concrete goal of the run.' }),
  asTopLevel: Type.Optional(
    Type.Boolean({
      description:
        'true = a top-level task you own and do yourself (appears as a prominent top-level card). false (default) = delegate to a sub-agent (a child run nested under the current one).',
    })
  ),
  agentType: Type.Optional(Type.String({ description: 'Sub-agent type (see the list in your prompt). Defaults to "default".' })),
  suggestedTools: Type.Optional(Type.Array(Type.String(), { description: 'Override the agent type\'s default tools (spawn path only).' })),
  providerKey: Type.Optional(Type.String({ description: 'Key of a configured provider for this run (spawn path only).' })),
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
        'Create a run. Use asTopLevel: true for substantial work you will do yourself (tracked as a top-level task); omit it (or asTopLevel: false) to delegate a focused sub-task to a sub-agent (optionally a specialized agentType). Runs single-shot; review the result yourself before reporting done.',
      parameters: CreateTaskParams,
      execute: async (_toolCallId: string, params: unknown) => {
        const p = params as { goal: string; asTopLevel?: boolean; agentType?: string; suggestedTools?: string[]; providerKey?: string }
        if (p.asTopLevel) {
          if (!ctx.createTask) {
            return { content: [{ type: 'text' as const, text: 'create_task is not available in this context.' }], details: { error: 'not_wired' } }
          }
          const { taskId, result } = await ctx.createTask(p.goal, p.agentType)
          return { content: [{ type: 'text' as const, text: result.summary }], details: { taskId, summary: result.summary } }
        }
        if (!ctx.spawnChild) {
          return { content: [{ type: 'text' as const, text: 'spawn is not available in this context.' }], details: { error: 'not_wired' } }
        }
        const { childTaskId, result } = await ctx.spawnChild(p.goal, p.suggestedTools, p.providerKey, p.agentType)
        return { content: [{ type: 'text' as const, text: result.summary }], details: { childTaskId, summary: result.summary } }
      },
    }),
  }
}
```

- [ ] **Step 4: Extend `ToolRunContext.createTask` + the manager wiring**

Find `createTask` on `ToolRunContext` (grep). Change its type to `createTask?(goal: string, agentType?: string): Promise<{ taskId: string; result: TaskResult }>`. In `manager.ts` (~`:1037`):

```ts
createTask: (g, agentType) => runWorkTask(sessionId, g, [], agentType ? { agentType } : {}),
```

(`runWorkTask` already accepts `options.agentType`.)

- [ ] **Step 5: Delete `spawn_sub_agent`**

```bash
git rm apps/desktop/src/service/tools/spawn.ts apps/desktop/src/service/tools/spawn.test.ts
```

In `builtins.ts`: drop the `import { spawnAgentSpec } from './spawn'` line + the `registry.register(spawnAgentSpec())` line.

- [ ] **Step 6: Grep for `spawn_sub_agent` references in agent prompts + update**

```bash
grep -rn "spawn_sub_agent" apps/desktop/src packages/ apps/
```

Update any builtin agent-definition prompt that references `spawn_sub_agent` by name to reference `create_task` (with `asTopLevel` guidance). Custom user-authored agents that call `spawn_sub_agent` will get a "tool not found" — acceptable per the no-compat guardrail, but note it in the commit message.

- [ ] **Step 7: Run tests + typecheck + format + commit**

```bash
find . -name "*.tsbuildinfo" -delete
npm --prefix apps/desktop test
npm --prefix apps/desktop run typecheck
npx biome check --write apps/desktop/src/service/tools/create-task.ts apps/desktop/src/service/tools/create-task.test.ts apps/desktop/src/service/tools/builtins.ts apps/desktop/src/service/session/manager.ts
git add apps/desktop/src/service/tools/create-task.ts apps/desktop/src/service/tools/create-task.test.ts apps/desktop/src/service/tools/builtins.ts apps/desktop/src/service/session/manager.ts
git add -u apps/desktop/src  # picks up the spawn.ts deletion
git commit -m "feat(tools): merge create_task + spawn_sub_agent into one create_task (asTopLevel)"
```

---

## Self-Review

**Spec coverage:**
- §2.1 tool merge (one `create_task` + `asTopLevel`) → Task 3. ✓
- §2.2 `goal` → `initialMessages` (one-shot; resident unchanged) → Task 2. ✓
- §2.3 cleanup batch (RunEventRow rename, dead saveSnapshot branch, stale comments, `as UIEvent` cast, test nits) → Task 1. ✓
- §3 ordering (cleanup → 3c → tool merge) → Tasks 1/2/3. ✓
- §4 testing → each task's TDD step. ✓
- §5 risks (3c rippling → Task 2 grep + e2e; tool-merge prompt refs → Task 3 Step 6; resident preserved → Task 2 leaves `promptOnce(goal)` + resident unchanged). ✓
- §6 forward pointers (none — 4c completes the redesign). ✓

**Placeholder scan:** No "TBD"/"implement later". The exact tool code (Task 3 Step 3), the extraction helper (Task 2 Step 3), and the caller edits (Task 2 Step 4) are shown in full. Task 2's test assertion ("capture via the mocked agent.prompt or the emit stream") names two concrete options the implementer picks based on the existing fixture pattern — not a placeholder, a fixture-adaptation note.

**Type consistency:** `RunEventRow` (Task 1) replaces `ConversationEventRow` everywhere. `createTask(goal, agentType?)` (Task 3) matches the manager wiring `(g, agentType) => runWorkTask(...)`. `AgentRunnerDeps.goal` (dropped in Task 2) is consistently replaced by `extractOneShotGoal(initialMessages)`; `promptOnce(goal, images?)` is explicitly UNCHANGED (resident + one-shot both still pass a goal to it — the runner extracts for one-shot).

**Green-at-each-commit check:** Task 1 is mechanical (rename + dead-code removal + comments). Task 2 drops a field + rewrites 4 callers (typecheck + the new one-shot test + e2e guard it). Task 3 rewrites one tool + deletes another + extends a context signature (typecheck + the merged-tool test guard it). Each commit leaves the suite green (modulo known `gmail.test`).

**One risk noted:** Task 2's `extractOneShotGoal` assumes the last `initialMessages` entry is a user text message. Every one-shot caller (Step 4) must end `initialMessages` with the goal as a user message — the plan makes this explicit per caller. If a caller forgets, the run prompts with `''` (the helper's fallback) — the one-shot test + e2e catch it.
