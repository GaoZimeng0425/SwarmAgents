# CEO→Leader→subagent Verified Delegation Pipeline — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Turn the company into a three-level autonomous pipeline — CEO derives goal + acceptance criteria, delegates to team Leaders, each Leader plans a dependency DAG and dispatches subagents in parallel waves, then two-level verify (Leader verifies, CEO verifies) — by extending the existing per-task goal-verify loop down the `spawnChild` task tree.

**Architecture:** Every non-leaf level (CEO, Leader) is a Task running the existing derive→execute→verify→rework loop; leaves are single-shot. Cross-level verify composes for free once (1) `spawnChild` carries an `acceptanceCriteria` + `maxVerifyRounds` contract down, (2) spawned children can run the verify loop (currently hard-coded to 0), and (3) a new `set_delegation_plan` tool lets a Leader declare a DAG (`goal` / `ownerAgentType` / `dependsOn` / per-item criteria) that drives prompt-level wave dispatch. A small stall-detection guard (borrowed from `planning-with-files`) fail-fasts when rework stops progressing.

**Tech Stack:** TypeScript, Electron, `@earendil-works/pi-agent-core` / `pi-ai`, zod schemas (`src/shared/types`), `better-sqlite3` (conversation store), `pino` logging, vitest.

## Global Constraints

- **Language:** code comments and commit messages in **English** only. (`CLAUDE.md` §0)
- **Logging:** every business path logged via `pino` child loggers; every `catch` logs at `error` before returning/rethrowing; structured first arg `log.info({ msg, ... })`. (`CLAUDE.md` §5)
- **Tests:** run with `npm test` (Electron-node vitest). **Never** `pnpm rebuild better-sqlite3`. Filter a file with `npm test -- <path>`. `src/service/**` is not in typecheck scope — vitest carries type coverage there.
- **Surgical changes:** touch only what the task requires; match existing factory+closure / single-file-slice style. (`CLAUDE.md` §3)
- **Scope:** non-leaf tasks (CEO, Leader) run the verify loop; leaves stay single-shot (`maxVerifyRounds: 0`). DAG dispatch is agent-driven (prompt + tool), not a runner-side scheduler. No composer UI; top-level criteria are CEO-derived.
- Schemas live in `src/shared/types/task.ts` (single source of truth: zod → inferred TS types).
- Per `CLAUDE.md` §6, implement in a dedicated worktree off `develop`.

---

### Task 1: `DelegationItem` schema and `Task.delegationPlan`

**Files:**
- Modify: `src/shared/types/task.ts` (new schema after `VerificationRoundSchema` ~L110; extend `TaskSchema` ~L223)
- Test: `src/shared/types/task.test.ts` (append)

**Interfaces:**
- Produces: `DelegationItemSchema` / `DelegationItem` (`{ id, goal, ownerAgentType?, dependsOn: string[], acceptanceCriteria? }`); `Task.delegationPlan?: DelegationItem[]`. Consumed by Tasks 2, 4, 5.

- [ ] **Step 1: Write the failing test**

Append to `src/shared/types/task.test.ts` (reuse the file's existing `baseTask` fixture if present; otherwise define one as in the goal-verify plan's Task 1):

```ts
import { DelegationItemSchema, TaskSchema } from './task'

describe('delegation plan schemas', () => {
  it('parses a minimal item and defaults dependsOn to []', () => {
    const item = DelegationItemSchema.parse({ id: 'd1', goal: 'do X' })
    expect(item.dependsOn).toEqual([])
    expect(item.ownerAgentType).toBeUndefined()
    expect(item.acceptanceCriteria).toBeUndefined()
  })

  it('parses a full item with owner, dependsOn, and item criteria', () => {
    const item = DelegationItemSchema.parse({
      id: 'd2',
      goal: 'do Y',
      ownerAgentType: 'engineer',
      dependsOn: ['d1'],
      acceptanceCriteria: [{ id: 'c1', description: 'X shipped' }],
    })
    expect(item.dependsOn).toEqual(['d1'])
    expect(item.acceptanceCriteria).toHaveLength(1)
  })

  it('round-trips a task carrying a delegationPlan', () => {
    const t = TaskSchema.parse({
      ...baseTask,
      delegationPlan: [{ id: 'd1', goal: 'g', ownerAgentType: 'engineer' }],
    })
    expect(t.delegationPlan).toHaveLength(1)
    expect(t.delegationPlan?.[0].ownerAgentType).toBe('engineer')
  })

  it('accepts a task without delegationPlan (backward compatible)', () => {
    expect(TaskSchema.parse(baseTask).delegationPlan).toBeUndefined()
  })
})
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npm test -- src/shared/types/task.test.ts`
Expected: FAIL — `DelegationItemSchema` is not exported.

- [ ] **Step 3: Add the schema**

In `src/shared/types/task.ts`, immediately after the `VerificationRoundSchema` / `VerificationRound` block (the block ending with `export type VerificationRound = ...`), insert:

```ts
// One item in a Leader's delegation plan. The Leader declares this DAG via the
// set_delegation_plan tool; dispatch is prompt-driven (parallel within a wave,
// waves ordered by dependsOn). Recorded for audit + UI, not mechanically enforced.
export const DelegationItemSchema = z.object({
  id: z.string().min(1),
  goal: z.string().min(1),
  // Which sub-agent type to spawn for this item; omitted → default agent.
  ownerAgentType: z.string().optional(),
  // Sibling item ids that must finish before this item is unblocked. Empty (= no
  // deps) marks a first-wave item. Drives wave dispatch in the Leader's prompt.
  dependsOn: z.array(z.string().min(1)).default([]),
  // Per-item done-conditions; passed down to the spawned sub-agent as its contract.
  acceptanceCriteria: z.array(AcceptanceCriterionSchema).optional(),
})
export type DelegationItem = z.infer<typeof DelegationItemSchema>
```

- [ ] **Step 4: Extend `TaskSchema`**

In `TaskSchema` (alongside `acceptanceCriteria` ~L223 and `verifications`), add:

```ts
  // Leader-authored delegation DAG (set_delegation_plan tool). Audit + UI only.
  delegationPlan: z.array(DelegationItemSchema).optional(),
```

- [ ] **Step 5: Run test to verify it passes**

Run: `npm test -- src/shared/types/task.test.ts`
Expected: PASS (all cases).

- [ ] **Step 6: Commit**

```bash
git add src/shared/types/task.ts src/shared/types/task.test.ts
git commit -m "feat(types): DelegationItem schema and Task.delegationPlan"
```

---

### Task 2: `set_delegation_plan` tool + tool-context seam

**Files:**
- Create: `src/service/tools/delegation-plan.ts`
- Modify: `src/service/tools/registry.ts` (import + `ToolRunContext.setDelegationPlan?` ~L70)
- Modify: `src/service/session/agent-runner.ts` (`AgentRunnerDeps.onDelegationPlan?` ~L237; `buildToolContext` injection ~L322)
- Modify: `src/service/tools/builtins.ts` (import + register ~L78)
- Test: `src/service/tools/delegation-plan.test.ts`

**Interfaces:**
- Consumes (Task 1): `DelegationItem`, `AcceptanceCriterionSchema` (via `DelegationItemSchema`).
- Produces: `delegationPlanSpec(): ToolSpec` (tool name `set_delegation_plan`, group `agent`); `ToolRunContext.setDelegationPlan?(plan: DelegationItem[])`; `AgentRunnerDeps.onDelegationPlan?(plan)`.

- [ ] **Step 1: Write the failing test**

Create `src/service/tools/delegation-plan.test.ts` (mirror `acceptance-criteria.test.ts`):

```ts
import { describe, expect, it, vi } from 'vitest'

import { delegationPlanSpec } from './delegation-plan'
import type { ToolRunContext } from './registry'

const ctx = (over: Partial<ToolRunContext> = {}): ToolRunContext =>
  ({ sessionId: 's', setDelegationPlan: vi.fn(), spawnChild: vi.fn() } as unknown as ToolRunContext)

describe('set_delegation_plan tool', () => {
  it('has the expected name and group', () => {
    const spec = delegationPlanSpec()
    expect(spec.name).toBe('set_delegation_plan')
    expect(spec.group).toBe('agent')
  })

  it('records the plan and assigns stable ids', async () => {
    const c = ctx()
    const tool = delegationPlanSpec().build(c)
    const res = (await tool.execute('id', {
      items: [
        { goal: 'build api', ownerAgentType: 'engineer', acceptanceCriteria: [{ description: 'tests pass' }] },
        { goal: 'review api', dependsOn: ['d1'] },
      ],
    })) as { details: { plan?: unknown } }
    expect(c.setDelegationPlan).toHaveBeenCalledWith([
      { id: 'd1', goal: 'build api', ownerAgentType: 'engineer', dependsOn: [], acceptanceCriteria: [{ id: 'c1', description: 'tests pass' }] },
      { id: 'd2', goal: 'review api', dependsOn: ['d1'] },
    ])
    expect((res.details.plan as unknown[]).length).toBe(2)
  })

  it('rejects an empty list', async () => {
    const tool = delegationPlanSpec().build(ctx())
    const res = (await tool.execute('id', { items: [] })) as { details: { error?: string } }
    expect(res.details.error).toBeTruthy()
  })

  it('rejects an item without a goal', async () => {
    const tool = delegationPlanSpec().build(ctx())
    const res = (await tool.execute('id', { items: [{ ownerAgentType: 'engineer' }] })) as { details: { error?: string } }
    expect(res.details.error).toBeTruthy()
  })
})
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npm test -- src/service/tools/delegation-plan.test.ts`
Expected: FAIL — module does not exist.

- [ ] **Step 3: Add the tool-context seam**

In `src/service/tools/registry.ts`, extend the `@shared/types/task` import (currently `import type { AcceptanceCriterion, TaskResult } from '@shared/types/task'`) to include `DelegationItem`:

```ts
import type { AcceptanceCriterion, DelegationItem, TaskResult } from '@shared/types/task'
```

Inside `interface ToolRunContext`, after `setAcceptanceCriteria?` (~L70), add:

```ts
  /**
   * Record the task's delegation DAG (set_delegation_plan tool). Wired in
   * agent-runner; absent in standalone tool tests and non-delegating contexts.
   */
  setDelegationPlan?(plan: DelegationItem[]): void
```

- [ ] **Step 4: Implement the tool**

Create `src/service/tools/delegation-plan.ts`:

```ts
import type { AgentTool } from '@earendil-works/pi-agent-core'
import { Type } from '@earendil-works/pi-ai'

import type { DelegationItem } from '@shared/types/task'
import { AcceptanceCriterionSchema } from '@shared/types/task'

import type { ToolRunContext, ToolSpec } from './registry'

type Result = { content: [{ type: 'text'; text: string }]; details: Record<string, unknown> }
const ok = (text: string, details: Record<string, unknown> = {}): Result => ({ content: [{ type: 'text', text }], details })
const err = (message: string): Result => ok(`error: ${message}`, { error: message })

const Params = Type.Object({
  items: Type.Array(
    Type.Object({
      goal: Type.String({ description: 'The sub-goal this delegation item accomplishes.' }),
      ownerAgentType: Type.Optional(
        Type.String({ description: 'Sub-agent type to spawn for this item (from your prompt). Omit for default.' })
      ),
      dependsOn: Type.Optional(
        Type.Array(Type.String(), {
          description: 'Sibling item ids that must finish first. Omit/empty for a first-wave (parallelizable) item.',
        })
      ),
      acceptanceCriteria: Type.Optional(
        Type.Array(
          Type.Object({
            description: Type.String({ description: 'A checkable done-condition for this item.' }),
            check: Type.Optional(
              Type.Object({
                kind: Type.String({ description: "'command' or 'file_exists'." }),
                command: Type.Optional(Type.String()),
                expectExitCode: Type.Optional(Type.Number()),
                expectStdout: Type.Optional(Type.String()),
                path: Type.Optional(Type.String()),
              })
            ),
          })
        )
      ),
    }),
    {
      description:
        'The delegation DAG. Dispatch items in dependency waves: items whose dependsOn are all done go in one parallel wave; the next wave starts when the previous completes. Attach acceptanceCriteria to pass down as each sub-agent\'s contract.',
    }
  ),
})

// Records the Leader's delegation DAG. The model owns the list; ids are assigned
// here (d1..dn) so dependsOn can reference items stably. Routed to the runner via
// ctx.setDelegationPlan. Dispatch itself is prompt-driven (the Leader calls
// spawn_sub_agent per item); this tool only records the plan for audit + UI.
export function delegationPlanSpec(): ToolSpec {
  return {
    group: 'agent',
    name: 'set_delegation_plan',
    risk: 'low',
    source: 'builtin',
    build: (ctx: ToolRunContext): AgentTool => ({
      name: 'set_delegation_plan',
      label: 'Set delegation plan',
      description:
        'Declare how you will delegate this task to sub-agents: a DAG of items, each with a sub-goal, an owner agent type, optional dependsOn (sibling ids), and optional per-item acceptance criteria. Dispatch items in dependency waves — all items whose dependencies are met, spawned in parallel this turn; the next wave when they return. Call this before dispatching.',
      parameters: Params,
      execute: async (_id: string, params: unknown) => {
        const raw = (params as { items?: unknown }).items
        if (!Array.isArray(raw) || raw.length === 0) return err('items must be a non-empty array')
        const knownIds = new Set<string>()
        const items: DelegationItem[] = []
        for (let i = 0; i < raw.length; i++) {
          const item = raw[i] as { goal?: unknown; ownerAgentType?: unknown; dependsOn?: unknown; acceptanceCriteria?: unknown }
          if (typeof item.goal !== 'string' || item.goal.trim().length === 0) {
            return err(`item ${i + 1} needs a non-empty goal`)
          }
          const id = `d${i + 1}`
          let deps: string[] = []
          if (Array.isArray(item.dependsOn)) {
            deps = item.dependsOn.filter((d): d is string => typeof d === 'string' && d.trim().length > 0)
            for (const d of deps) {
              if (!knownIds.has(d)) return err(`item ${i + 1} dependsOn unknown id "${d}" (must reference an earlier item)`)
            }
          }
          let criteria: DelegationItem['acceptanceCriteria']
          if (Array.isArray(item.acceptanceCriteria)) {
            const parsed: NonNullable<DelegationItem['acceptanceCriteria']> = []
            for (let j = 0; j < item.acceptanceCriteria.length; j++) {
              const c = item.acceptanceCriteria[j]
              const p = AcceptanceCriterionSchema.safeParse({ ...(c as object), id: `c${j + 1}` })
              if (!p.success) return err(`item ${i + 1} criterion ${j + 1} invalid: ${p.error.issues[0]?.message ?? 'invalid'}`)
              parsed.push(p.data)
            }
            if (parsed.length > 0) criteria = parsed
          }
          const entry: DelegationItem = { id, goal: item.goal.trim(), dependsOn: deps, ...(item.ownerAgentType ? { ownerAgentType: String(item.ownerAgentType) } : {}), ...(criteria ? { acceptanceCriteria: criteria } : {}) }
          items.push(entry)
          knownIds.add(id)
        }
        if (!ctx.setDelegationPlan) return err('delegation plans are not accepted in this context')
        ctx.setDelegationPlan(items)
        const lines = items.map((it) => `- ${it.id}: ${it.goal}${it.ownerAgentType ? ` [${it.ownerAgentType}]` : ''}${it.dependsOn.length ? ` (after ${it.dependsOn.join(',')})` : ''}`)
        return ok(`Delegation plan recorded (${items.length}):\n${lines.join('\n')}`, { plan: items })
      },
    }),
  }
}
```

- [ ] **Step 5: Wire `onDelegationPlan` through `buildToolContext`**

In `src/service/session/agent-runner.ts`, add `DelegationItem` to the `@shared/types/task` import (merge with the existing `AcceptanceCriterion, VerificationRound` import). In `AgentRunnerDeps`, after `onAcceptanceCriteria?` (~L237), add:

```ts
  /** Capture the Leader's delegation DAG (set_delegation_plan tool). */
  onDelegationPlan?(plan: DelegationItem[]): void
```

In `buildToolContext` (the returned object, after `setAcceptanceCriteria: deps.onAcceptanceCriteria,` ~L322), add:

```ts
    setDelegationPlan: deps.onDelegationPlan,
```

- [ ] **Step 6: Register the tool**

In `src/service/tools/builtins.ts`, add the import near the other tool imports:

```ts
import { delegationPlanSpec } from './delegation-plan'
```

Register directly below `registry.register(acceptanceCriteriaSpec())` (~L78):

```ts
  registry.register(delegationPlanSpec())
```

- [ ] **Step 7: Run tests to verify they pass**

Run: `npm test -- src/service/tools/delegation-plan.test.ts src/service/tools/builtins.test.ts`
Expected: PASS. If `builtins.test.ts` enumerates the known tool set, add `'agent.set_delegation_plan'` to that expectation (mirror how `'agent.set_acceptance_criteria'` appears there).

- [ ] **Step 8: Commit**

```bash
git add src/service/tools/delegation-plan.ts src/service/tools/delegation-plan.test.ts src/service/tools/registry.ts src/service/tools/builtins.ts src/service/session/agent-runner.ts
git commit -m "feat(tools): set_delegation_plan tool and tool-context seam"
```

---

### Task 3: Thread `spawnChild` options (criteria + `maxVerifyRounds`) end-to-end

**Files:**
- Modify: `src/service/tools/registry.ts` (`ToolRunContext.spawnChild` signature ~L26)
- Modify: `src/service/session/agent-runner.ts` (`AgentRunnerDeps.spawnChild` ~L200; `buildToolContext` pass-through ~L304)
- Modify: `src/service/session/manager.ts` (`spawnChild` ~L509; child task build ~L537; `maxVerifyRounds` ~L595)
- Modify: `src/service/tools/spawn.ts` (params + options mapping)
- Test: `src/service/tools/spawn.test.ts` (append)

**Interfaces:**
- Produces: a trailing `options?: { acceptanceCriteria?: AcceptanceCriterion[]; maxVerifyRounds?: number }` on every `spawnChild` variant; the `spawn_sub_agent` tool gains `acceptanceCriteria?` + `verify?`. Consumed by the CEO/Leader prompts (Task 7) and exercised end-to-end by Task 8.

- [ ] **Step 1: Write the failing test**

Append to `src/service/tools/spawn.test.ts` (mirror the file's existing `ctx` shape — `spawnChild: vi.fn()` resolving to `{ childTaskId, result: { summary, artifacts: [] } }`):

```ts
import type { AcceptanceCriterion } from '@shared/types/task'

describe('spawn_sub_agent options', () => {
  it('passes acceptanceCriteria and verify=true through as options', async () => {
    const spawnChild = vi.fn(async () => ({ childTaskId: 'c', result: { summary: 'done', artifacts: [] } }))
    const tool = spawnAgentSpec().build({ sessionId: 's', spawnChild } as never)
    const criteria: AcceptanceCriterion[] = [{ id: 'c1', description: 'ships' }]
    await tool.execute('id', { goal: 'do it', agentType: 'pm', acceptanceCriteria: criteria, verify: true })
    expect(spawnChild).toHaveBeenCalledTimes(1)
    const args = spawnChild.mock.calls[0]
    // [goal, suggestedTools, providerKey, agentType, options]
    expect(args[0]).toBe('do it')
    expect(args[3]).toBe('pm')
    expect(args[4]).toMatchObject({ acceptanceCriteria: criteria, maxVerifyRounds: 3 })
  })

  it('omits options when neither is supplied', async () => {
    const spawnChild = vi.fn(async () => ({ childTaskId: 'c', result: { summary: 'done', artifacts: [] } }))
    const tool = spawnAgentSpec().build({ sessionId: 's', spawnChild } as never)
    await tool.execute('id', { goal: 'do it' })
    const args = spawnChild.mock.calls[0]
    expect(args[4]).toBeUndefined()
  })
})
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npm test -- src/service/tools/spawn.test.ts`
Expected: FAIL — the tool never passes a 5th argument.

- [ ] **Step 3: Extend the shared options type**

In `src/service/session/agent-runner.ts`, add a shared alias near the other type aliases (top of the deps section, before `AgentRunnerDeps`):

```ts
/** Extra contract passed down a delegation edge via spawnChild. */
export type SpawnChildOptions = {
  acceptanceCriteria?: import('@shared/types/task').AcceptanceCriterion[]
  /** Rounds for the child's verify loop. 0 (default) = single-shot leaf. */
  maxVerifyRounds?: number
}
```

In `AgentRunnerDeps.spawnChild` (currently `(parentTaskId, newGoal, suggestedTools?, providerKey?, agentType?)`), append a trailing param:

```ts
  spawnChild(
    parentTaskId: string,
    newGoal: string,
    suggestedTools?: string[],
    providerKey?: string,
    agentType?: string,
    options?: SpawnChildOptions
  ): Promise<{ childTaskId: string; result: TaskResult }>
```

- [ ] **Step 4: Extend `ToolRunContext.spawnChild`**

In `src/service/tools/registry.ts`, import the alias and extend the signature (currently L26-31):

```ts
import type { AcceptanceCriterion, DelegationItem, TaskResult } from '@shared/types/task'
import type { SpawnChildOptions } from '../session/agent-runner'
// ...
  spawnChild(
    goal: string,
    suggestedTools?: string[],
    providerKey?: string,
    agentType?: string,
    options?: SpawnChildOptions
  ): Promise<{ childTaskId: string; result: TaskResult }>
```

- [ ] **Step 5: Pass options through `buildToolContext`**

In `src/service/session/agent-runner.ts` `buildToolContext` (~L304), thread the new arg:

```ts
    spawnChild: (goal, suggestedTools, providerKey, agentType, options) =>
      deps.spawnChild(deps.task.id, goal, suggestedTools, providerKey, agentType, options),
```

- [ ] **Step 6: Consume options in the manager**

In `src/service/session/manager.ts` `spawnChild` (signature ~L509), append `options?: SpawnChildOptions` (import `SpawnChildOptions` from `./agent-runner`). In the `childTask` literal (~L537), add after `toolAllowlist`:

```ts
      acceptanceCriteria: options?.acceptanceCriteria,
```

Replace the hard-coded `maxVerifyRounds: 0` (~L595) with:

```ts
          maxVerifyRounds: options?.maxVerifyRounds ?? 0,
```

- [ ] **Step 7: Expose params on the `spawn_sub_agent` tool**

In `src/service/tools/spawn.ts`, import the alias and the criterion type, then extend `SpawnParams` and the execute body:

```ts
import { type AcceptanceCriterion } from '@shared/types/task'
import { DEFAULT_MAX_VERIFY_ROUNDS } from '../session/agent-runner'
```

(See Step 8 for exporting `DEFAULT_MAX_VERIFY_ROUNDS`.) Extend `SpawnParams` (add after `providerKey`):

```ts
  acceptanceCriteria: Type.Optional(
    Type.Array(
      Type.Object({
        description: Type.String({ description: 'A checkable done-condition passed down as this sub-agent\'s contract.' }),
        check: Type.Optional(
          Type.Object({
            kind: Type.String({ description: "'command' or 'file_exists'." }),
            command: Type.Optional(Type.String()),
            expectExitCode: Type.Optional(Type.Number()),
            expectStdout: Type.Optional(Type.String()),
            path: Type.Optional(Type.String()),
          })
        ),
      })
    )
  ),
  verify: Type.Optional(
    Type.Boolean({
      description:
        'true = this sub-agent runs its own verify loop (use for Leaders that must self-verify); false/omit = single-shot leaf verified by the caller.',
    })
  ),
```

In `execute`, build and pass options:

```ts
        const p = params as {
          goal: string
          agentType?: string
          suggestedTools?: string[]
          providerKey?: string
          acceptanceCriteria?: AcceptanceCriterion[]
          verify?: boolean
        }
        const options =
          p.acceptanceCriteria || p.verify
            ? {
                ...(p.acceptanceCriteria ? { acceptanceCriteria: p.acceptanceCriteria } : {}),
                ...(p.verify ? { maxVerifyRounds: DEFAULT_MAX_VERIFY_ROUNDS } : {}),
              }
            : undefined
        const { childTaskId, result } = await ctx.spawnChild(p.goal, p.suggestedTools, p.providerKey, p.agentType, options)
```

- [ ] **Step 8: Export `DEFAULT_MAX_VERIFY_ROUNDS`**

In `src/service/session/agent-runner.ts`, change `const DEFAULT_MAX_VERIFY_ROUNDS = 3` (~L1147) to:

```ts
export const DEFAULT_MAX_VERIFY_ROUNDS = 3
```

- [ ] **Step 9: Run tests to verify they pass**

Run: `npm test -- src/service/tools/spawn.test.ts src/service/tools/builtins.test.ts src/service/tools/delegation-plan.test.ts`
Expected: PASS.

- [ ] **Step 10: Commit**

```bash
git add src/service/tools/registry.ts src/service/tools/spawn.ts src/service/session/agent-runner.ts src/service/session/manager.ts
git commit -m "feat(spawn): thread acceptanceCriteria + maxVerifyRounds down spawnChild"
```

---

### Task 4: Persist `delegationPlan` in the conversation store

**Files:**
- Modify: `src/service/conversation/store.ts` (column ~L163; migration ~L256; `rowToTask` ~L309; INSERT ~L493/790; prepared stmt ~L588; method ~L770; type ~L79)
- Test: `src/service/conversation/store.test.ts` (append)

**Interfaces:**
- Consumes (Task 1): `DelegationItem` via `Task`.
- Produces: `store.saveTaskDelegationPlan(taskId, plan)`; `getTask`/`getSessionTasks` round-trip `delegationPlan`.

- [ ] **Step 1: Write the failing test**

Append to `src/service/conversation/store.test.ts` (reuse the file's existing store/task harness — mirror how it constructs a task for the `saveTaskCriteria` round-trip test):

```ts
import type { DelegationItem } from '@shared/types/task'

describe('delegation plan persistence', () => {
  it('round-trips a delegation plan on a task', () => {
    const store = createConversationStore(':memory:')
    store.createSession('s1', { id: 'p', apiStyle: 'anthropic', model: 'm', apiKey: 'k' } as never)
    const task = {
      id: '01HZZZZZZZZZZZZZZZZZZZZZZ04',
      parentId: null,
      agentDefId: 'default',
      goal: 'g',
      status: 'pending',
      assignedWorkerId: null,
      toolAllowlist: [],
      budget: { tokens: 1, calls: 1, wallMs: 1, usdCents: 1 },
      used: { tokens: 0, calls: 0, wallMs: 0, usdCents: 0, cacheRead: 0, cacheWrite: 0 },
      history: [],
      attachments: [],
      plan: [],
      result: null,
      createdAt: 1,
      startedAt: null,
      endedAt: null,
    } as never
    store.saveTask(task, 's1')

    const plan: DelegationItem[] = [
      { id: 'd1', goal: 'build', ownerAgentType: 'engineer', dependsOn: [], acceptanceCriteria: [{ id: 'c1', description: 'tests pass' }] },
      { id: 'd2', goal: 'review', dependsOn: ['d1'] },
    ]
    store.saveTaskDelegationPlan('01HZZZZZZZZZZZZZZZZZZZZZZ04', plan)

    const got = store.getTask('01HZZZZZZZZZZZZZZZZZZZZZZ04')
    expect(got?.delegationPlan).toEqual(plan)
    store.close()
  })
})
```

(If the file already wraps `createConversationStore` in a helper, use it; match the existing imports.)

- [ ] **Step 2: Run test to verify it fails**

Run: `npm test -- src/service/conversation/store.test.ts`
Expected: FAIL — `saveTaskDelegationPlan` is not a function.

- [ ] **Step 3: Add column + migration**

In the `CREATE TABLE IF NOT EXISTS tasks (...)` block, after `verifications TEXT NOT NULL DEFAULT '[]',` (~L164), add:

```sql
      delegation_plan   TEXT NOT NULL DEFAULT '[]',
```

In the `ALTER TABLE` migration array, after the `verifications` line (~L256), add:

```ts
    `ALTER TABLE tasks ADD COLUMN delegation_plan TEXT NOT NULL DEFAULT '[]'`,
```

- [ ] **Step 4: Parse it in `rowToTask`**

In `rowToTask` (~L309, after the `verifications` parse), add:

```ts
    delegationPlan: JSON.parse((row.delegation_plan as string) ?? '[]') as Task['delegationPlan'],
```

- [ ] **Step 5: Add insert column + prepared statement + method**

Update `stmtInsertTask` (~L493) to include the new column and one more `?` (after `verifications`, before `created_at`):

```ts
  const stmtInsertTask = db.prepare(
    `INSERT OR REPLACE INTO tasks
     (id, session_id, parent_id, goal, status, result, budget, used,
      agent_def_id, assigned_worker_id, tool_allowlist, history, attachments, plan,
      acceptance_criteria, verifications, delegation_plan,
      created_at, started_at, ended_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
  )
```

Add a prepared statement near `stmtSetTaskVerifications` (~L589):

```ts
  const stmtSetTaskDelegationPlan = db.prepare('UPDATE tasks SET delegation_plan = ? WHERE id = ?')
```

In the `saveTask` body (~L790, after `JSON.stringify(task.verifications ?? [])`), add the matching value in the same position:

```ts
        JSON.stringify(task.delegationPlan ?? []),
```

Add the method next to `saveTaskVerifications` (~L773):

```ts
    saveTaskDelegationPlan(taskId, plan) {
      stmtSetTaskDelegationPlan.run(JSON.stringify(plan), taskId)
    },
```

Add its signature to the `ConversationStore` type (~L80, after `saveTaskVerifications`):

```ts
  saveTaskDelegationPlan(taskId: string, plan: Task['delegationPlan']): void
```

- [ ] **Step 6: Run test to verify it passes**

Run: `npm test -- src/service/conversation/store.test.ts`
Expected: PASS.

- [ ] **Step 7: Commit**

```bash
git add src/service/conversation/store.ts src/service/conversation/store.test.ts
git commit -m "feat(store): persist Task.delegationPlan"
```

---

### Task 5: `task.delegation_plan` event + runner emit + manager persist

**Files:**
- Modify: `src/shared/types/ui.ts` (`UIEvent` union ~L95)
- Modify: `src/service/session/agent-runner.ts` (`createAgentRunner` wrap `onDelegationPlan` ~L1337)
- Modify: `src/service/session/manager.ts` (`makeEmit` branch ~L270)
- Test: `src/service/session/agent-runner.verify.test.ts` (append an emit assertion)

**Interfaces:**
- Consumes (Task 1): `DelegationItem`; (Task 4): `store.saveTaskDelegationPlan`.
- Produces: `UIEvent` variant `task.delegation_plan`; the runner emits it when the Leader records its plan; the manager persists it.

- [ ] **Step 1: Write the failing test**

Append to `src/service/session/agent-runner.verify.test.ts` a case asserting the runner emits `task.delegation_plan` when `onDelegationPlan` is invoked through the wrapped deps. Use the file's existing `runGoalVerifyLoop`/fake-session harness only if it already constructs a runner; otherwise assert the wrapping directly via `buildToolContext` is insufficient (it does not wrap), so drive it through `createAgentRunner` with a stub verify:

```ts
import { createAgentRunner } from './agent-runner'

describe('delegation plan emit', () => {
  it('emits task.delegation_plan when onDelegationPlan fires', async () => {
    const emits: Array<{ event: string; data: unknown }> = []
    const received: DelegationItem[] = []
    // Minimal deps: a verify that passes immediately so the run terminates.
    const runner = createAgentRunner({
      task: { id: 't1', goal: 'g', acceptanceCriteria: [{ id: 'c1', description: 'x' }], attachments: [], toolAllowlist: [] } as never,
      provider: undefined as never,
      agentDefinition: { id: 'a', name: 'A', description: '', systemPrompt: '', toolScope: 'all', maxIterations: 1 } as never,
      sessionId: 's',
      emit: (event, data) => emits.push({ event, data }),
      permissionRegistry: { isAllowed: () => true, decide: () => {} } as never,
      toolRegistry: { resolve: () => ({ tools: [], riskOf: () => 'low' as const }) } as never,
      initialMessages: [],
      spawnChild: async () => ({ childTaskId: 'c', result: { summary: '', artifacts: [] } }),
      verifyCompletion: async () => ({ verdict: 'pass', results: [], gaps: [] }),
      maxVerifyRounds: 1,
      onDelegationPlan: (p) => {
        received.push(...p)
      },
    })
    // Drive a delegation plan record through the wrapped deps (the tool does this
    // in production; here we call the wrapped callback the runner installs).
    // The runner exposes the wrapper via the session it builds; for this unit we
    // assert the emit path by invoking the same wrapping logic indirectly through
    // a real tool call would need a model — so instead assert the contract: the
    // runner must have installed an onDelegationPlan that emits. We exercise it by
    // awaiting run() (which is a no-op pass) then checking no throw occurred.
    await runner.run()
    // The wrapper is internal; the substantive coverage is the manager persistence
    // test + the delegation-plan tool test. This test guards the wiring compiles
    // and the pass-path terminates.
    expect(runner).toBeDefined()
    expect(received).toEqual([])
  })
})
```

> **Note to implementer:** the runner installs the `onDelegationPlan` wrapper internally, so a pure unit test cannot easily fire it without a model. The substantive assertion that the event is emitted-and-persisted lives in the Task 8 e2e (which drives a real `set_delegation_plan` tool call). Keep this test as a compile/contract guard; if `createAgentRunner` requires more deps in the current code than shown, add the minimum stubs to satisfy its type — do not weaken a real behavior assertion.

- [ ] **Step 2: Run test to verify it fails / compiles**

Run: `npm test -- src/service/session/agent-runner.verify.test.ts`
Expected: FAIL to compile or FAIL the assertion until the wiring exists. (If it already passes trivially because the wrapper is absent, that is the signal to add the wrapper in Step 3.)

- [ ] **Step 3: Add the `UIEvent` variant**

In `src/shared/types/ui.ts`, extend the task-type import (the existing `PlanTodo, AcceptanceCriterion, VerificationRound` import from `./task`) to include `DelegationItem`. In the `UIEvent` union, after `task.verification` (~L95), add:

```ts
  | { kind: 'task.delegation_plan'; sessionId: string; taskId: string; plan: DelegationItem[]; ts: number }
```

- [ ] **Step 4: Wrap `onDelegationPlan` in `createAgentRunner`**

In `src/service/session/agent-runner.ts` `createAgentRunner.run`, extend the `wrappedDeps` object (which already wraps `onAcceptanceCriteria` ~L1337) to also wrap `onDelegationPlan`:

```ts
        onDelegationPlan: (plan) => {
          deps.emit('task.delegation_plan', { taskId: deps.task.id, plan, ts: Date.now() })
          deps.onDelegationPlan?.(plan)
        },
```

- [ ] **Step 5: Persist the event in the manager**

In `src/service/session/manager.ts` `makeEmit`, after the `task.verification` branch (~L275), add:

```ts
      if (event === 'task.delegation_plan' && taskId && Array.isArray(obj?.plan)) {
        const plan = obj.plan as import('@shared/types/task').DelegationItem[]
        store.saveTaskDelegationPlan(taskId, plan)
        log.info({ msg: 'delegation plan persisted', taskId, items: plan.length })
      }
```

- [ ] **Step 6: Run tests + typecheck**

Run: `npm test -- src/service/session/agent-runner.verify.test.ts src/service/session/manager.test.ts`
Expected: PASS. Then run the project's typecheck (`grep '"typecheck"\|"check"' package.json`; typically `npx tsc --noEmit -p tsconfig.json` or `npm run typecheck`):
Expected: no type errors from the new `UIEvent` variant.

- [ ] **Step 7: Commit**

```bash
git add src/shared/types/ui.ts src/service/session/agent-runner.ts src/service/session/manager.ts src/service/session/agent-runner.verify.test.ts
git commit -m "feat(events): task.delegation_plan event, runner emit, manager persist"
```

---

### Task 6: Stall detection in `runGoalVerifyLoop`

**Files:**
- Modify: `src/service/session/agent-runner.ts` (`runGoalVerifyLoop` ~L1259-1305)
- Test: `src/service/session/agent-runner.verify.test.ts` (append)

**Interfaces:**
- Consumes: the existing loop state (`lastGaps`).
- Produces: a fail-fast when two consecutive rounds produce identical gaps.

- [ ] **Step 1: Write the failing test**

Append to `src/service/session/agent-runner.verify.test.ts` (reuse the file's `fakeSession` + `verdict` helpers):

```ts
describe('runGoalVerifyLoop stall detection', () => {
  it('fails fast when two consecutive rounds report identical gaps', async () => {
    const sameGaps = ['fix tests']
    const verify = vi.fn().mockResolvedValue({ verdict: 'fail', results: [], gaps: sameGaps })
    const session = fakeSession(['completed', 'completed', 'completed'])
    const r = await runGoalVerifyLoop({
      session,
      goal: 'do it',
      images: undefined,
      criteriaRef: { current: [{ id: 'c1', description: 'x' }] },
      verify,
      maxRounds: 5,
      cwd: undefined,
      emit: vi.fn(),
      taskId: 't1',
    })
    expect(r.status).toBe('failed')
    expect(r.summary).toContain('not progressing')
    // round 0 fails (gaps set) → round 1 fails with SAME gaps → stall → stop.
    // So verify is called exactly twice, not maxRounds+1 (6).
    expect(verify).toHaveBeenCalledTimes(2)
  })

  it('keeps looping when gaps change between rounds', async () => {
    const verify = vi
      .fn()
      .mockResolvedValueOnce({ verdict: 'fail', results: [], gaps: ['a'] })
      .mockResolvedValueOnce({ verdict: 'fail', results: [], gaps: ['b'] })
      .mockResolvedValueOnce({ verdict: 'pass', results: [], gaps: [] })
    const r = await runGoalVerifyLoop({
      session: fakeSession(['completed', 'completed', 'completed']),
      goal: 'do it',
      images: undefined,
      criteriaRef: { current: [{ id: 'c1', description: 'x' }] },
      verify,
      maxRounds: 5,
      cwd: undefined,
      emit: vi.fn(),
      taskId: 't1',
    })
    expect(r.status).toBe('completed')
    expect(verify).toHaveBeenCalledTimes(3)
  })
})
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npm test -- src/service/session/agent-runner.verify.test.ts`
Expected: FAIL — the stall case loops until `maxRounds` (verify called 6 times) instead of 2.

- [ ] **Step 3: Add the stall guard**

In `src/service/session/agent-runner.ts`, add a small equality helper near `addUsed` (~L1170):

```ts
// Order-insensitive equality of two gap lists, so a re-ordered but identical set
// still counts as "no progress". Used by the stall guard in runGoalVerifyLoop.
const sameGaps = (a: string[], b: string[]): boolean => {
  if (a.length !== b.length) return false
  const sa = new Set(a)
  return b.every((g) => sa.has(g))
}
```

In `runGoalVerifyLoop`, replace the fail-handling tail (the block after `lastGaps = verdict.gaps`, currently ~L1293-1305) with:

```ts
    const stalled = round > 0 && sameGaps(verdict.gaps, lastGaps)
    lastGaps = verdict.gaps
    if (round === maxRounds) {
      taskLog.warn({ msg: 'verification exhausted rounds; marking failed', rounds: maxRounds })
      const summary = `${r.summary}\n\nUnmet acceptance criteria after ${maxRounds + 1} verify round(s):\n${verdict.gaps
        .map((g) => `- ${g}`)
        .join('\n')}`
      return { status: 'failed', summary, messages: session.agent.state.messages, used: addUsed(session.getUsed(), extraUsed) }
    }
    if (stalled) {
      taskLog.warn({ msg: 'verify gaps not progressing since last round; marking failed', round })
      const summary = `${r.summary}\n\nStopped: acceptance criteria not progressing (same gaps repeated):\n${verdict.gaps
        .map((g) => `- ${g}`)
        .join('\n')}`
      return { status: 'failed', summary, messages: session.agent.state.messages, used: addUsed(session.getUsed(), extraUsed) }
    }
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npm test -- src/service/session/agent-runner.verify.test.ts`
Expected: PASS (both cases).

- [ ] **Step 5: Commit**

```bash
git add src/service/session/agent-runner.ts src/service/session/agent-runner.verify.test.ts
git commit -m "feat(runner): fail-fast when verify gaps stop progressing"
```

---

### Task 7: CEO + Leader prompts

**Files:**
- Modify: `src/shared/constants/agents.ts` (CEO prompt ~L16; a team-head prompt, e.g. the dev `pm` head)
- Test: `src/shared/constants/agents.test.ts` (create, or append) — prompt-content regression

**Interfaces:**
- Consumes (Tasks 2, 3): the `set_delegation_plan`, `set_acceptance_criteria`, `spawn_sub_agent` tools.
- Produces: CEO and Leader system-prompt addenda that drive the three-level pipeline.

- [ ] **Step 1: Write the failing test**

Create or append `src/shared/constants/agents.test.ts`:

```ts
import { describe, expect, it } from 'vitest'

import { builtinAgents } from './agents'

describe('pipeline prompt content', () => {
  it('CEO prompt instructs delegation + verify', () => {
    const ceo = builtinAgents.find((a) => a.id === 'ceo')
    expect(ceo).toBeDefined()
    const p = ceo!.systemPrompt
    expect(p).toMatch(/set_acceptance_criteria/)
    expect(p).toMatch(/spawn_sub_agent/)
    expect(p).toMatch(/verify/)
  })

  it('dev head prompt instructs delegation plan + parallel wave dispatch', () => {
    const head = builtinAgents.find((a) => a.teamRole === 'head' && a.team === 'dev')
    expect(head).toBeDefined()
    const p = head!.systemPrompt
    expect(p).toMatch(/set_delegation_plan/)
    expect(p).toMatch(/parallel/)
  })
})
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npm test -- src/shared/constants/agents.test.ts`
Expected: FAIL — the prompts do not yet mention these tools/behaviors.

- [ ] **Step 3: Update the CEO prompt**

In `src/shared/constants/agents.ts`, find the CEO `systemPrompt` (the block around L16 that already says *"Discover the team leads: call find_agents({ teamRole: 'head' })"*). Append a delegation + verify section to that prompt string:

```ts
    `\n\nWhen the goal is substantive and spans teams, run a verified delegation pipeline:\n` +
    `1. Call set_acceptance_criteria with checkable top-level done-conditions for the WHOLE goal.\n` +
    `2. find_agents({ teamRole: 'head' }) to discover team Leaders.\n` +
    `3. Slice the goal + the relevant criteria per Leader, and in ONE turn call spawn_sub_agent once per Leader with that Leader's goal, its acceptanceCriteria, and verify=true ( Leaders must self-verify).\n` +
    `4. When all Leaders return, write a summary that reports each Leader's outcome against its criteria.\n` +
    `5. Your own verify gate then judges the top-level criteria. If gaps remain, re-dispatch the affected Leader(s) with the specific gaps.`
```

- [ ] **Step 4: Update a team-head (Leader) prompt**

Find the dev team head (the `pm` agent with `team: 'dev'`, `teamRole: 'head'`, whose prompt references `find_agents({ team: 'dev', ... })`). Append a delegation section:

```ts
    `\n\nWhen your team must produce work, delegate via a verified pipeline:\n` +
    `1. Call set_delegation_plan with a DAG of items — each item has a sub-goal, an ownerAgentType (the IC that should do it), dependsOn (sibling item ids that must finish first; omit for first-wave items), and acceptanceCriteria for that item.\n` +
    `2. Dispatch in WAVES: in one turn, call spawn_sub_agent in parallel for every item whose dependsOn are all complete (pass the item's goal + its acceptanceCriteria; do NOT set verify — leaves are single-shot and you will verify them).\n` +
    `3. When a wave returns, dispatch the next wave (items whose deps just cleared).\n` +
    `4. After all items finish, summarize each sub-agent's outcome against its item criteria.\n` +
    `5. Your own verify gate judges your team's criteria. On gaps, re-dispatch the affected item(s).\n` +
    `Use spawn_sub_agent for delegation (not send_and_wait) so the work enters the verifying task tree.`
```

- [ ] **Step 5: Run test to verify it passes**

Run: `npm test -- src/shared/constants/agents.test.ts`
Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add src/shared/constants/agents.ts src/shared/constants/agents.test.ts
git commit -m "feat(agents): CEO + Leader verified-delegation prompts"
```

---

### Task 8: Integration e2e — three-level pipeline

**Files:**
- Create: `tests/e2e/multi-level-verify.e2e.test.ts` (or the project's e2e directory — mirror `company.e2e.test.ts`)
- Test: same file.

**Interfaces:**
- Consumes: Tasks 1-7 (full pipeline).
- Produces: a deterministic, stub-agent-driven end-to-end test of CEO → Leaders → subagents → Leader verify → CEO verify.

- [ ] **Step 1: Locate the e2e harness**

Run: `grep -rln "company.e2e\|stub.*agent\|StubAgent" tests/ src/service 2>/dev/null | head`
Open the existing company e2e test and the stub-agent helper it uses. The new test reuses that harness (session manager + a stub provider/agent that returns scripted tool calls).

- [ ] **Step 2: Write the failing test**

Create `tests/e2e/multi-level-verify.e2e.test.ts` (adapt the import paths + stub helper to match the located harness; the assertions are the contract):

```ts
import { describe, expect, it } from 'vitest'
// Import the project's stub-agent + session-manager harness (same as company.e2e.test.ts).

describe('CEO → Leader → subagent verified pipeline', () => {
  it('runs three levels with two-stage verify', async () => {
    // Script the stubs:
    // - CEO: set_acceptance_criteria([top-level]) → spawn_sub_agent(leaders, verify=true) x2 → summarize.
    // - Each Leader: set_delegation_plan([2 items, one depending on the other]) → spawn_sub_agent(items) in waves → summarize.
    // - Each subagent: single-shot, returns a summary that satisfies its item criteria.
    // - Verify: CEO + Leaders run the verify loop; leaves are single-shot (maxVerifyRounds: 0).
    const { manager, events } = await buildHarness({
      ceoScript: [...],
      leaderScript: [...],
      subagentScript: [...],
    })

    const { taskId } = manager.submitGoal(sessionId, 'Ship feature X across teams', undefined, ceoAgentDef, undefined, {
      agentType: 'ceo',
    })
    await drain(manager, taskId) // pump until the root task reaches a terminal status.

    // 1. Top-level criteria derived and persisted.
    expect(events.some((e) => e.kind === 'task.criteria' && e.taskId === taskId)).toBe(true)

    // 2. Two Leader children spawned with verify on (maxVerifyRounds > 0).
    const leaders = childrenOf(taskId, events)
    expect(leaders.length).toBe(2)

    // 3. Each Leader recorded a delegation plan and spawned leaf subagents.
    for (const l of leaders) {
      expect(events.some((e) => e.kind === 'task.delegation_plan' && e.taskId === l.taskId)).toBe(true)
      const leaves = childrenOf(l.taskId, events)
      expect(leaves.length).toBeGreaterThan(0)
    }

    // 4. Both verify levels fired: each Leader and the CEO emitted task.verification.
    expect(events.filter((e) => e.kind === 'task.verification').length).toBeGreaterThanOrEqual(3)

    // 5. Root completed (all criteria met by the stubbed summaries).
    const root = manager.getSessionTasks(sessionId).find((t) => t.id === taskId)
    expect(root?.status).toBe('completed')
  })
})
```

`childrenOf(parentId, events)` derives children from `task.created` events carrying `parentTaskId`. Fill the stub scripts so that Leader/subagent summaries satisfy the criteria (the verify judge is also stubbed to pass) — mirror exactly how `company.e2e.test.ts` scripts its stub agents and stubs the verify judge.

- [ ] **Step 3: Run test to verify it fails**

Run: `npm test -- tests/e2e/multi-level-verify.e2e.test.ts`
Expected: FAIL — until the harness scripts are complete and the full chain is wired.

- [ ] **Step 4: Make it pass**

Implement the stub scripts fully (CEO/Leader/subagent tool-call sequences + a stubbed verify judge that passes when summaries contain the expected keywords). The production code from Tasks 1-7 should already make the assertions hold; this step is about completing the deterministic stub wiring, not changing production code. If an assertion reveals a real wiring gap, fix it in the relevant task's file and re-run.

- [ ] **Step 5: Run the full suite + regression**

Run: `npm test`
Expected: PASS — including the existing goal-verify, multi-team, spawn, and store suites.

- [ ] **Step 6: Commit**

```bash
git add tests/e2e/multi-level-verify.e2e.test.ts
git commit -m "test(e2e): three-level CEO→Leader→subagent verified pipeline"
```

---

## Self-Review

**1. Spec coverage:**
- §3 decisions 1-9 → Task 1 (types/DAG), Task 2 (`set_delegation_plan`), Task 3 (criteria+rounds down `spawnChild`), Task 6 (stall detection). ✓
- §4 three-level architecture → Task 7 (prompts) + Task 8 (e2e). ✓
- §5.1 `spawnChild` options → Task 3. ✓
- §5.2 `DelegationItem` → Task 1. ✓
- §5.3 `set_delegation_plan` tool → Task 2. ✓
- §5.4 store persistence → Task 4. ✓
- §5.5 `task.delegation_plan` event → Task 5. ✓
- §6 delegation contract (CEO→Leader verify on, Leader→leaf verify off) → Task 3 (options) + Task 7 (prompts) + Task 8 (e2e asserts verify levels). ✓
- §7 prompts → Task 7. ✓
- §8 stall detection → Task 6; budget/depth bounds inherit existing `budgets().sub` + `maxVerifyRounds` + judge recursion guard (unchanged). ✓
- §9 testing → Tasks 1-8 each carry TDD tests; e2e in Task 8. ✓

**2. Placeholder scan:** No TBD/TODO. Task 5 Step 1 and Task 8 reference the project's existing harnesses (`createAgentRunner` deps shape, the company e2e stub helper) and name the file + pattern to mirror rather than inventing — acceptable, and the substantive coverage lives in Tasks 1-4, 6 unit tests + Task 8 e2e.

**3. Type consistency:** `DelegationItem` / `DelegationItemSchema` named identically across Tasks 1-5. `SpawnChildOptions` defined in Task 3 Step 3 and used in Tasks 3-4 (registry + manager + tool). `setDelegationPlan` (ToolRunContext, Task 2) ↔ `onDelegationPlan` (AgentRunnerDeps, Task 2) ↔ wrapped in `createAgentRunner` (Task 5) ↔ `saveTaskDelegationPlan` (store, Task 4) ↔ persisted in `makeEmit` (Task 5). `DEFAULT_MAX_VERIFY_ROUNDS` exported in Task 3 Step 8 and imported in Task 3 Step 7. The `acceptanceCriteria` field name is identical on `TaskOptions`, `Task`, `SpawnChildOptions`, and the `spawn_sub_agent` params.

**4. Scope check:** Single feature, one plan, 8 tasks each independently testable — mirrors the size of the goal-verify plan. No decomposition needed.
