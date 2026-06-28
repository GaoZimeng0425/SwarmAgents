# Goal-Verified Task Loop Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Give every autonomous (`executionMode: 'goal'`) task explicit, checkable acceptance criteria and an independent verify gate, so a task is only marked `completed` after its criteria are verified — looping back to rework when they are not.

**Architecture:** A three-phase state machine inside `createAgentRunner.run()` — Phase A derives acceptance criteria (a forced `set_acceptance_criteria` tool call, skipped when the caller supplied them), Phase B runs the existing pi `Agent` turn loop, Phase C verifies (deterministic hard checks first, an independent LLM judge for the rest). On a failing verdict it injects the gaps as a rework prompt into the **same** agent session and loops, bounded by `maxVerifyRounds` and the existing budget. `'plan'` mode and `maxVerifyRounds === 0` keep the legacy single-shot behavior.

**Tech Stack:** TypeScript, Electron, `@earendil-works/pi-agent-core` / `pi-ai`, zod schemas (`src/shared/types`), `better-sqlite3` (conversation store), `pino` logging, vitest.

## Global Constraints

- **Language:** code comments and commit messages in **English** only. (`CLAUDE.md` §0)
- **Logging:** every business path logged via `pino` child loggers; every `catch` logs at `error` before returning/rethrowing; structured first arg `log.info({ msg, ... })`. (`CLAUDE.md` §5)
- **Tests:** run with `npm test` (Electron-node vitest). **Never** `pnpm rebuild better-sqlite3`. Filter a file with `npm test -- <path>`.
- **Surgical changes:** touch only what the task requires; match existing file style. (`CLAUDE.md` §3)
- **Scope:** verification applies to `executionMode: 'goal'` only; `'plan'` mode untouched. `maxVerifyRounds` default **3**.
- Schemas live in `src/shared/types/task.ts` and are the single source of truth (zod → inferred TS types).

---

### Task 1: Acceptance-criteria & verification types

**Files:**
- Modify: `src/shared/types/task.ts` (add schemas after `PlanTodoSchema` ~line 75; extend `TaskSchema` ~line 146 and `TaskOptionsSchema` ~line 60)
- Test: `src/shared/types/task.test.ts` (create, or append if it exists)

**Interfaces:**
- Produces: `ExecutableCheckSchema`/`ExecutableCheck`, `AcceptanceCriterionSchema`/`AcceptanceCriterion`, `VerificationResultSchema`/`VerificationResult`, `VerificationRoundSchema`/`VerificationRound`; `Task.acceptanceCriteria?: AcceptanceCriterion[]`, `Task.verifications?: VerificationRound[]`, `TaskOptions.acceptanceCriteria?: AcceptanceCriterion[]`.

- [ ] **Step 1: Write the failing test**

Create `src/shared/types/task.test.ts` (if the file already exists, append the `describe` block):

```ts
import { describe, expect, it } from 'vitest'

import {
  AcceptanceCriterionSchema,
  ExecutableCheckSchema,
  TaskSchema,
  VerificationRoundSchema,
} from './task'

const baseTask = {
  id: '01HZZZZZZZZZZZZZZZZZZZZZZZZ',
  parentId: null,
  agentDefId: 'default',
  goal: 'do it',
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
}

describe('acceptance criteria schemas', () => {
  it('parses a command check', () => {
    const c = ExecutableCheckSchema.parse({ kind: 'command', command: 'npm test', expectExitCode: 0 })
    expect(c.kind).toBe('command')
  })

  it('parses a file_exists check', () => {
    const c = ExecutableCheckSchema.parse({ kind: 'file_exists', path: 'dist/out.js' })
    expect(c.kind).toBe('file_exists')
  })

  it('rejects an unknown check kind', () => {
    expect(ExecutableCheckSchema.safeParse({ kind: 'http', url: 'x' }).success).toBe(false)
  })

  it('parses a criterion with and without a check', () => {
    expect(AcceptanceCriterionSchema.parse({ id: 'c1', description: 'tests pass', check: { kind: 'command', command: 'npm test' } }).id).toBe('c1')
    expect(AcceptanceCriterionSchema.parse({ id: 'c2', description: 'reads well' }).check).toBeUndefined()
  })

  it('parses a verification round', () => {
    const r = VerificationRoundSchema.parse({
      round: 0,
      verdict: 'fail',
      results: [{ criterionId: 'c1', pass: false, detail: 'exit 1' }],
      gaps: ['c1: exit 1'],
      ts: 123,
    })
    expect(r.verdict).toBe('fail')
  })

  it('accepts a task carrying criteria and verifications', () => {
    const t = TaskSchema.parse({
      ...baseTask,
      acceptanceCriteria: [{ id: 'c1', description: 'tests pass' }],
      verifications: [{ round: 0, verdict: 'pass', results: [], gaps: [], ts: 1 }],
    })
    expect(t.acceptanceCriteria).toHaveLength(1)
    expect(t.verifications).toHaveLength(1)
  })

  it('accepts a task without criteria (backward compatible)', () => {
    expect(TaskSchema.parse(baseTask).acceptanceCriteria).toBeUndefined()
  })
})
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npm test -- src/shared/types/task.test.ts`
Expected: FAIL — `ExecutableCheckSchema` / `AcceptanceCriterionSchema` / `VerificationRoundSchema` are not exported.

- [ ] **Step 3: Add the schemas**

In `src/shared/types/task.ts`, after the `PlanTodoSchema` / `PlanStatus` block (~line 76), insert:

```ts
// A single machine-checkable "done" condition for an acceptance criterion.
//   command     — passes when the shell command exits with expectExitCode
//                  (default 0) and, when set, stdout contains expectStdout.
//   file_exists  — passes when the path exists (relative to the task cwd).
export const ExecutableCheckSchema = z.discriminatedUnion('kind', [
  z.object({
    kind: z.literal('command'),
    command: z.string().min(1),
    cwd: z.string().optional(),
    expectExitCode: z.number().int().optional(),
    expectStdout: z.string().optional(),
  }),
  z.object({
    kind: z.literal('file_exists'),
    path: z.string().min(1),
  }),
])
export type ExecutableCheck = z.infer<typeof ExecutableCheckSchema>

// One acceptance criterion. A `check` present ⇒ verified deterministically;
// absent ⇒ judged by the LLM verifier against the task summary.
export const AcceptanceCriterionSchema = z.object({
  id: z.string().min(1),
  description: z.string().min(1),
  check: ExecutableCheckSchema.optional(),
})
export type AcceptanceCriterion = z.infer<typeof AcceptanceCriterionSchema>

export const VerificationResultSchema = z.object({
  criterionId: z.string(),
  pass: z.boolean(),
  detail: z.string(),
})
export type VerificationResult = z.infer<typeof VerificationResultSchema>

// One verify round's outcome — persisted as an audit trail and surfaced to the UI.
export const VerificationRoundSchema = z.object({
  round: z.number().int().nonnegative(),
  verdict: z.enum(['pass', 'fail']),
  results: z.array(VerificationResultSchema),
  gaps: z.array(z.string()),
  ts: z.number().int(),
})
export type VerificationRound = z.infer<typeof VerificationRoundSchema>
```

- [ ] **Step 4: Extend `TaskOptionsSchema` and `TaskSchema`**

In `TaskOptionsSchema` (the object ending ~line 67, before `agentType`), add:

```ts
  // Caller-supplied acceptance criteria; when present the agent skips Phase A
  // (criteria derivation) and the verify gate uses these directly.
  acceptanceCriteria: z.array(AcceptanceCriterionSchema).optional(),
```

In `TaskSchema` (before its closing `})` ~line 173, alongside `permissionMode`/`executionMode`), add:

```ts
  // Checkable done-conditions for this task. Derived by the agent in Phase A or
  // supplied by the caller; drives the verify gate.
  acceptanceCriteria: z.array(AcceptanceCriterionSchema).optional(),
  // Per-round verify audit trail (UI + logs).
  verifications: z.array(VerificationRoundSchema).optional(),
```

- [ ] **Step 5: Run test to verify it passes**

Run: `npm test -- src/shared/types/task.test.ts`
Expected: PASS (all cases).

- [ ] **Step 6: Commit**

```bash
git add src/shared/types/task.ts src/shared/types/task.test.ts
git commit -m "feat(types): acceptance criteria and verification round schemas"
```

---

### Task 2: Verification engine (hard checks + judge merge)

**Files:**
- Create: `src/service/session/verify.ts`
- Test: `src/service/session/verify.test.ts`

**Interfaces:**
- Consumes (Task 1): `AcceptanceCriterion`, `ExecutableCheck`.
- Produces: `CheckResult`, `Verdict`, `Judge`; `runHardChecks(criteria, cwd?)`, `parseVerdict(raw)`, `verifyTask({ criteria, summary, cwd?, judge })`.

```ts
export type CheckResult = { criterionId: string; pass: boolean; detail: string }
export type Verdict = { verdict: 'pass' | 'fail'; results: CheckResult[]; gaps: string[] }
export type Judge = (soft: AcceptanceCriterion[], summary: string) => Promise<{ pass: boolean; gaps: string[] }>
```

- [ ] **Step 1: Write the failing test**

Create `src/service/session/verify.test.ts`:

```ts
import { describe, expect, it, vi } from 'vitest'

import { parseVerdict, runHardChecks, verifyTask } from './verify'

describe('parseVerdict', () => {
  it('parses a bare json object', () => {
    expect(parseVerdict('{"pass": true, "gaps": []}')).toEqual({ pass: true, gaps: [] })
  })
  it('extracts json embedded in prose', () => {
    expect(parseVerdict('Here is my verdict:\n{"pass": false, "gaps": ["no tests"]}\nDone.')).toEqual({
      pass: false,
      gaps: ['no tests'],
    })
  })
  it('returns null when no parseable verdict', () => {
    expect(parseVerdict('looks good to me')).toBeNull()
  })
  it('returns null when pass is not a boolean', () => {
    expect(parseVerdict('{"pass": "yes"}')).toBeNull()
  })
})

describe('runHardChecks', () => {
  it('passes a command that exits 0', async () => {
    const r = await runHardChecks([{ id: 'c1', description: 'echo', check: { kind: 'command', command: 'exit 0' } }])
    expect(r).toEqual([{ criterionId: 'c1', pass: true, detail: expect.any(String) }])
  })
  it('fails a command that exits non-zero', async () => {
    const r = await runHardChecks([{ id: 'c1', description: 'fail', check: { kind: 'command', command: 'exit 3' } }])
    expect(r[0].pass).toBe(false)
  })
  it('honors a non-zero expectExitCode', async () => {
    const r = await runHardChecks([
      { id: 'c1', description: 'expect 3', check: { kind: 'command', command: 'exit 3', expectExitCode: 3 } },
    ])
    expect(r[0].pass).toBe(true)
  })
  it('checks stdout substring', async () => {
    const ok = await runHardChecks([
      { id: 'c1', description: 'say hi', check: { kind: 'command', command: 'echo hello', expectStdout: 'hello' } },
    ])
    expect(ok[0].pass).toBe(true)
    const bad = await runHardChecks([
      { id: 'c2', description: 'say hi', check: { kind: 'command', command: 'echo hello', expectStdout: 'bye' } },
    ])
    expect(bad[0].pass).toBe(false)
  })
  it('checks file_exists against cwd', async () => {
    const r = await runHardChecks([{ id: 'c1', description: 'pkg', check: { kind: 'file_exists', path: 'package.json' } }], process.cwd())
    expect(r[0].pass).toBe(true)
  })
  it('skips criteria without a check', async () => {
    const r = await runHardChecks([{ id: 'c1', description: 'reads well' }])
    expect(r).toEqual([])
  })
})

describe('verifyTask', () => {
  it('passes when all hard checks pass and judge passes', async () => {
    const judge = vi.fn().mockResolvedValue({ pass: true, gaps: [] })
    const v = await verifyTask({
      criteria: [
        { id: 'c1', description: 'tests', check: { kind: 'command', command: 'exit 0' } },
        { id: 'c2', description: 'reads well' },
      ],
      summary: 'done',
      judge,
    })
    expect(v.verdict).toBe('pass')
    expect(judge).toHaveBeenCalledWith([{ id: 'c2', description: 'reads well' }], 'done')
  })
  it('fails when a hard check fails, even if judge passes', async () => {
    const judge = vi.fn().mockResolvedValue({ pass: true, gaps: [] })
    const v = await verifyTask({
      criteria: [{ id: 'c1', description: 'tests', check: { kind: 'command', command: 'exit 1' } }],
      summary: 'done',
      judge,
    })
    expect(v.verdict).toBe('fail')
    expect(v.gaps.some((g) => g.startsWith('c1:'))).toBe(true)
  })
  it('does not call the judge when every criterion has a check', async () => {
    const judge = vi.fn().mockResolvedValue({ pass: true, gaps: [] })
    await verifyTask({
      criteria: [{ id: 'c1', description: 'tests', check: { kind: 'command', command: 'exit 0' } }],
      summary: 'done',
      judge,
    })
    expect(judge).not.toHaveBeenCalled()
  })
  it('runs the judge for overall judgment when there are no criteria', async () => {
    const judge = vi.fn().mockResolvedValue({ pass: false, gaps: ['nothing produced'] })
    const v = await verifyTask({ criteria: [], summary: 'idle', judge })
    expect(judge).toHaveBeenCalled()
    expect(v.verdict).toBe('fail')
  })
})
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npm test -- src/service/session/verify.test.ts`
Expected: FAIL — `./verify` module does not exist.

- [ ] **Step 3: Implement `verify.ts`**

Create `src/service/session/verify.ts`:

```ts
import { exec } from 'node:child_process'
import { existsSync } from 'node:fs'
import { homedir } from 'node:os'
import { isAbsolute, join } from 'node:path'
import { promisify } from 'node:util'

import { createLogger } from '@shared/logger'
import type { AcceptanceCriterion, ExecutableCheck } from '@shared/types/task'

const log = createLogger({ process: 'service' }).child({ component: 'verify' })
const pexec = promisify(exec)

export type CheckResult = { criterionId: string; pass: boolean; detail: string }
export type Verdict = { verdict: 'pass' | 'fail'; results: CheckResult[]; gaps: string[] }
export type Judge = (soft: AcceptanceCriterion[], summary: string) => Promise<{ pass: boolean; gaps: string[] }>

const CHECK_TIMEOUT_MS = 120_000

async function runCheck(check: ExecutableCheck, cwd?: string): Promise<{ pass: boolean; detail: string }> {
  const base = cwd ?? homedir()
  if (check.kind === 'file_exists') {
    const abs = isAbsolute(check.path) ? check.path : join(base, check.path)
    const pass = existsSync(abs)
    return { pass, detail: pass ? `exists: ${abs}` : `missing: ${abs}` }
  }
  const expectExit = check.expectExitCode ?? 0
  const stdoutOk = (stdout: string): boolean => (check.expectStdout ? stdout.includes(check.expectStdout) : true)
  try {
    const { stdout } = await pexec(check.command, { cwd: base, timeout: CHECK_TIMEOUT_MS, maxBuffer: 1024 * 1024 })
    const pass = expectExit === 0 && stdoutOk(stdout)
    return {
      pass,
      detail: pass ? `exit 0${check.expectStdout ? ', stdout matched' : ''}` : `exit 0 but stdout missing "${check.expectStdout}"`,
    }
  } catch (e) {
    // A non-zero exit rejects; `code` carries the exit status, `stdout` the captured output.
    const code = (e as { code?: number }).code
    const stdout = (e as { stdout?: string }).stdout ?? ''
    const pass = code === expectExit && stdoutOk(stdout)
    return { pass, detail: pass ? `exit ${code} as expected` : `exit ${code ?? 'error'} (expected ${expectExit})` }
  }
}

// Run every criterion that carries a `check`, deterministically and in process.
// A thrown check is recorded as a failed criterion (logged) — never crashes verify.
export async function runHardChecks(criteria: AcceptanceCriterion[], cwd?: string): Promise<CheckResult[]> {
  const results: CheckResult[] = []
  for (const c of criteria) {
    if (!c.check) continue
    try {
      const r = await runCheck(c.check, cwd)
      results.push({ criterionId: c.id, pass: r.pass, detail: r.detail })
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err)
      log.error({ msg: 'hard check threw', criterionId: c.id, err: msg })
      results.push({ criterionId: c.id, pass: false, detail: `check error: ${msg}` })
    }
  }
  return results
}

// Tolerant verdict parse: pull the first {...} block and require a boolean `pass`.
export function parseVerdict(raw: string): { pass: boolean; gaps: string[] } | null {
  const match = raw.match(/\{[\s\S]*\}/)
  if (!match) return null
  try {
    const obj = JSON.parse(match[0]) as { pass?: unknown; gaps?: unknown }
    if (typeof obj.pass !== 'boolean') return null
    const gaps = Array.isArray(obj.gaps) ? obj.gaps.filter((g): g is string => typeof g === 'string') : []
    return { pass: obj.pass, gaps }
  } catch {
    return null
  }
}

// Combine hard checks (deterministic) with a soft LLM judge over the remaining
// criteria. Verdict passes iff every hard check passes AND the judge passes.
export async function verifyTask(input: {
  criteria: AcceptanceCriterion[]
  summary: string
  cwd?: string
  judge: Judge
}): Promise<Verdict> {
  const { criteria, summary, cwd, judge } = input
  const hard = await runHardChecks(criteria, cwd)
  const soft = criteria.filter((c) => !c.check)
  // Judge runs for soft criteria, or for an overall judgment when there are none.
  let judged = { pass: true, gaps: [] as string[] }
  if (soft.length > 0 || criteria.length === 0) {
    judged = await judge(soft, summary)
  }
  const hardGaps = hard.filter((r) => !r.pass).map((r) => `${r.criterionId}: ${r.detail}`)
  const softResults: CheckResult[] = soft.map((c) => ({
    criterionId: c.id,
    pass: judged.pass,
    detail: judged.pass ? 'judged satisfied' : 'judged unmet',
  }))
  const pass = hard.every((r) => r.pass) && judged.pass
  return {
    verdict: pass ? 'pass' : 'fail',
    results: [...hard, ...softResults],
    gaps: [...hardGaps, ...judged.gaps],
  }
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npm test -- src/service/session/verify.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/service/session/verify.ts src/service/session/verify.test.ts
git commit -m "feat(verify): hard-check runner, verdict parser, verify merge"
```

---

### Task 3: `set_acceptance_criteria` tool + tool-context seam

**Files:**
- Create: `src/service/tools/acceptance-criteria.ts`
- Modify: `src/service/tools/registry.ts` (add `setAcceptanceCriteria?` to `ToolRunContext`, ~line 53)
- Test: `src/service/tools/acceptance-criteria.test.ts`
- Modify (registration): the builtin assembly that calls `registry.register(updatePlanSpec())` — locate in Step 5.

**Interfaces:**
- Consumes (Task 1): `AcceptanceCriterion`, `ExecutableCheckSchema`.
- Produces: `acceptanceCriteriaSpec(): ToolSpec` (tool name `set_acceptance_criteria`, group `agent`); `ToolRunContext.setAcceptanceCriteria?(criteria: AcceptanceCriterion[]): void`.

- [ ] **Step 1: Write the failing test**

Create `src/service/tools/acceptance-criteria.test.ts`:

```ts
import { describe, expect, it, vi } from 'vitest'

import { acceptanceCriteriaSpec } from './acceptance-criteria'
import type { ToolRunContext } from './registry'

const ctx = (over: Partial<ToolRunContext> = {}): ToolRunContext =>
  ({ sessionId: 's', setAcceptanceCriteria: vi.fn(), spawnChild: vi.fn() } as unknown as ToolRunContext)

describe('set_acceptance_criteria tool', () => {
  it('has the expected name and group', () => {
    const spec = acceptanceCriteriaSpec()
    expect(spec.name).toBe('set_acceptance_criteria')
    expect(spec.group).toBe('agent')
  })

  it('records criteria and assigns stable ids', async () => {
    const c = ctx()
    const tool = acceptanceCriteriaSpec().build(c)
    const res = (await tool.execute('id', {
      criteria: [
        { description: 'tests pass', check: { kind: 'command', command: 'npm test' } },
        { description: 'reads clearly' },
      ],
    })) as { details: { criteria?: unknown } }
    expect(c.setAcceptanceCriteria).toHaveBeenCalledWith([
      { id: 'c1', description: 'tests pass', check: { kind: 'command', command: 'npm test' } },
      { id: 'c2', description: 'reads clearly' },
    ])
    expect((res.details.criteria as unknown[]).length).toBe(2)
  })

  it('rejects an empty list', async () => {
    const tool = acceptanceCriteriaSpec().build(ctx())
    const res = (await tool.execute('id', { criteria: [] })) as { details: { error?: string } }
    expect(res.details.error).toBeTruthy()
  })

  it('rejects an invalid check', async () => {
    const tool = acceptanceCriteriaSpec().build(ctx())
    const res = (await tool.execute('id', {
      criteria: [{ description: 'x', check: { kind: 'command' } }],
    })) as { details: { error?: string } }
    expect(res.details.error).toBeTruthy()
  })
})
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npm test -- src/service/tools/acceptance-criteria.test.ts`
Expected: FAIL — module does not exist.

- [ ] **Step 3: Add the tool-context seam**

In `src/service/tools/registry.ts`, add the import (top, with the other `@shared/types` imports):

```ts
import type { AcceptanceCriterion, TaskResult } from '@shared/types/task'
```

(replace the existing `import type { TaskResult } from '@shared/types/task'`.)

Then inside `interface ToolRunContext`, after `reportExternalUsage?` (~line 64), add:

```ts
  /**
   * Record the task's acceptance criteria (set_acceptance_criteria tool). Wired
   * in agent-runner's Phase A; absent in standalone tool tests and contexts that
   * do not verify.
   */
  setAcceptanceCriteria?(criteria: AcceptanceCriterion[]): void
```

- [ ] **Step 4: Implement the tool**

Create `src/service/tools/acceptance-criteria.ts`:

```ts
import type { AgentTool } from '@earendil-works/pi-agent-core'
import { Type } from '@earendil-works/pi-ai'
import { type AcceptanceCriterion, ExecutableCheckSchema } from '@shared/types/task'

import type { ToolRunContext, ToolSpec } from './registry'

type Result = { content: [{ type: 'text'; text: string }]; details: Record<string, unknown> }
const ok = (text: string, details: Record<string, unknown> = {}): Result => ({ content: [{ type: 'text', text }], details })
const err = (message: string): Result => ok(`error: ${message}`, { error: message })

const Params = Type.Object({
  criteria: Type.Array(
    Type.Object({
      description: Type.String({ description: 'A single, checkable done-condition for the task.' }),
      check: Type.Optional(
        Type.Object({
          kind: Type.String({ description: "'command' or 'file_exists'." }),
          command: Type.Optional(Type.String({ description: "Shell command (kind='command'); passes on expectExitCode (default 0)." })),
          cwd: Type.Optional(Type.String({ description: 'Working directory for the command.' })),
          expectExitCode: Type.Optional(Type.Number({ description: 'Expected exit code (default 0).' })),
          expectStdout: Type.Optional(Type.String({ description: 'Substring that must appear in stdout.' })),
          path: Type.Optional(Type.String({ description: "File path that must exist (kind='file_exists')." })),
        })
      ),
    }),
    {
      description:
        'Acceptance criteria for this task. Each is a checkable done-condition. Attach a `check` ' +
        '(command or file_exists) when a command or file can verify it deterministically; leave it off ' +
        'when only judgment applies.',
    }
  ),
})

// Records the task's acceptance criteria (Phase A of the goal-verify loop). The
// model owns the list; ids are assigned here (c1..cn) so later verify rounds can
// reference each criterion stably. Routed to the runner via ctx.setAcceptanceCriteria.
export function acceptanceCriteriaSpec(): ToolSpec {
  return {
    group: 'agent',
    name: 'set_acceptance_criteria',
    risk: 'low',
    source: 'builtin',
    build: (ctx: ToolRunContext): AgentTool => ({
      name: 'set_acceptance_criteria',
      label: 'Set acceptance criteria',
      description:
        'Define how this task will be judged complete: a list of checkable done-conditions. ' +
        'Attach a `check` to any criterion a command or file can verify; the rest are judged against your summary. ' +
        'Call this once, before doing the task.',
      parameters: Params,
      execute: async (_id: string, params: unknown) => {
        const raw = (params as { criteria?: unknown }).criteria
        if (!Array.isArray(raw) || raw.length === 0) return err('criteria must be a non-empty array')
        const criteria: AcceptanceCriterion[] = []
        for (let i = 0; i < raw.length; i++) {
          const item = raw[i] as { description?: unknown; check?: unknown }
          if (typeof item.description !== 'string' || item.description.trim().length === 0) {
            return err(`criterion ${i + 1} needs a non-empty description`)
          }
          let check: AcceptanceCriterion['check']
          if (item.check && typeof item.check === 'object') {
            const parsed = ExecutableCheckSchema.safeParse(item.check)
            if (!parsed.success) {
              return err(`criterion ${i + 1} has an invalid check: ${parsed.error.issues[0]?.message ?? 'invalid'}`)
            }
            check = parsed.data
          }
          criteria.push({ id: `c${i + 1}`, description: item.description.trim(), ...(check ? { check } : {}) })
        }
        if (!ctx.setAcceptanceCriteria) return err('acceptance criteria are not accepted in this context')
        ctx.setAcceptanceCriteria(criteria)
        const lines = criteria.map((c) => `- ${c.description}${c.check ? ` [${c.check.kind}]` : ''}`)
        return ok(`Acceptance criteria recorded (${criteria.length}):\n${lines.join('\n')}`, { criteria })
      },
    }),
  }
}
```

- [ ] **Step 5: Register the tool next to `update_plan`**

Find the registration site:

```bash
grep -rn "updatePlanSpec()" src/service
```
Expected: a line like `registry.register(updatePlanSpec())` in the builtin assembly (e.g. `src/service/tools/builtins.ts`).

Add directly below it, mirroring style — including the matching import:

```ts
import { acceptanceCriteriaSpec } from './acceptance-criteria'
// ...
registry.register(acceptanceCriteriaSpec())
```

- [ ] **Step 6: Run tests to verify they pass**

Run: `npm test -- src/service/tools/acceptance-criteria.test.ts src/service/tools/builtins.test.ts`
Expected: PASS. The builtins test may assert the known tool set — if it enumerates tool names, add `'agent.set_acceptance_criteria'` to that expectation (mirror how `'agent.update_plan'` appears there).

- [ ] **Step 7: Commit**

```bash
git add src/service/tools/acceptance-criteria.ts src/service/tools/acceptance-criteria.test.ts src/service/tools/registry.ts src/service/tools/builtins.ts
git commit -m "feat(tools): set_acceptance_criteria tool and tool-context seam"
```

---

### Task 4: Three-phase `run()` loop in agent-runner

**Files:**
- Modify: `src/service/session/agent-runner.ts` (extend `AgentRunnerDeps` ~line 232; add `buildToolContext` wiring ~line 292; replace `createAgentRunner` ~line 1118; add helpers)
- Test: `src/service/session/agent-runner.verify.test.ts`

**Interfaces:**
- Consumes (Task 1): `AcceptanceCriterion`, `VerificationRound`; (Task 2): `verifyTask`, `parseVerdict`, `Judge`, `Verdict`.
- Produces: `AgentRunnerDeps.onAcceptanceCriteria?`, `AgentRunnerDeps.verifyCompletion?`, `AgentRunnerDeps.maxVerifyRounds?`; exported `runGoalVerifyLoop(...)` for testing; emits events `task.criteria` and `task.verification`.
- The `run()` return contract is unchanged: `{ status, summary, messages, used }`.

- [ ] **Step 1: Write the failing test**

Create `src/service/session/agent-runner.verify.test.ts`. This tests the loop via `runGoalVerifyLoop` with a fake session — no real model:

```ts
import { describe, expect, it, vi } from 'vitest'

import { runGoalVerifyLoop } from './agent-runner'
import type { Verdict } from './verify'

const fakeSession = (statuses: Array<'completed' | 'failed' | 'cancelled'>) => {
  let i = 0
  const messages = [{ role: 'assistant', content: 'work' }]
  return {
    promptOnce: vi.fn(async (goal: string) => {
      const status = statuses[Math.min(i, statuses.length - 1)]
      i += 1
      return { status, summary: `summary for: ${goal}` }
    }),
    getUsed: () => ({ tokens: 10, calls: 1, wallMs: 5, usdCents: 1, cacheRead: 0, cacheWrite: 0 }),
    agent: { state: { messages } },
  } as unknown as Parameters<typeof runGoalVerifyLoop>[0]['session']
}

const verdict = (verdict: 'pass' | 'fail', gaps: string[] = []): Verdict & { judgeUsed?: undefined } => ({
  verdict,
  results: [],
  gaps,
})

describe('runGoalVerifyLoop', () => {
  it('completes on a passing first verdict', async () => {
    const verify = vi.fn().mockResolvedValue(verdict('pass'))
    const emit = vi.fn()
    const r = await runGoalVerifyLoop({
      session: fakeSession(['completed']),
      goal: 'do it',
      images: undefined,
      criteriaRef: { current: [{ id: 'c1', description: 'x' }] },
      verify,
      maxRounds: 3,
      cwd: undefined,
      emit,
      taskId: 't1',
    })
    expect(r.status).toBe('completed')
    expect(verify).toHaveBeenCalledTimes(1)
    expect(emit).toHaveBeenCalledWith('task.verification', expect.objectContaining({ taskId: 't1' }))
  })

  it('loops back on fail then completes', async () => {
    const verify = vi
      .fn()
      .mockResolvedValueOnce(verdict('fail', ['add tests']))
      .mockResolvedValueOnce(verdict('pass'))
    const session = fakeSession(['completed', 'completed'])
    const r = await runGoalVerifyLoop({
      session,
      goal: 'do it',
      criteriaRef: { current: [{ id: 'c1', description: 'x' }] },
      verify,
      maxRounds: 3,
      emit: vi.fn(),
      taskId: 't1',
    })
    expect(r.status).toBe('completed')
    expect(verify).toHaveBeenCalledTimes(2)
    // round 0 goal + round 1 rework = 2 prompts
    expect((session.promptOnce as ReturnType<typeof vi.fn>)).toHaveBeenCalledTimes(2)
  })

  it('fails after exhausting maxRounds, with gaps in the summary', async () => {
    const verify = vi.fn().mockResolvedValue(verdict('fail', ['still broken']))
    const r = await runGoalVerifyLoop({
      session: fakeSession(['completed']),
      goal: 'do it',
      criteriaRef: { current: [{ id: 'c1', description: 'x' }] },
      verify,
      maxRounds: 1,
      emit: vi.fn(),
      taskId: 't1',
    })
    expect(r.status).toBe('failed')
    expect(r.summary).toContain('still broken')
    // round 0 + round 1 = 2 verifies at maxRounds=1
    expect(verify).toHaveBeenCalledTimes(2)
  })

  it('short-circuits when a turn does not complete (e.g. budget)', async () => {
    const verify = vi.fn()
    const r = await runGoalVerifyLoop({
      session: fakeSession(['failed']),
      goal: 'do it',
      criteriaRef: { current: [{ id: 'c1', description: 'x' }] },
      verify,
      maxRounds: 3,
      emit: vi.fn(),
      taskId: 't1',
    })
    expect(r.status).toBe('failed')
    expect(verify).not.toHaveBeenCalled()
  })

  it('folds judge usage into the returned used', async () => {
    const verify = vi.fn().mockResolvedValue({
      verdict: 'pass',
      results: [],
      gaps: [],
      judgeUsed: { tokens: 100, calls: 1, wallMs: 1, usdCents: 2, cacheRead: 0, cacheWrite: 0 },
    })
    const r = await runGoalVerifyLoop({
      session: fakeSession(['completed']),
      goal: 'do it',
      criteriaRef: { current: [{ id: 'c1', description: 'x' }] },
      verify,
      maxRounds: 3,
      emit: vi.fn(),
      taskId: 't1',
    })
    expect(r.used.tokens).toBe(110) // 10 session + 100 judge
  })
})
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npm test -- src/service/session/agent-runner.verify.test.ts`
Expected: FAIL — `runGoalVerifyLoop` is not exported.

- [ ] **Step 3: Extend `AgentRunnerDeps`**

In `src/service/session/agent-runner.ts`, add imports near the top (with the other `@shared/types` / local imports):

```ts
import type { AcceptanceCriterion, VerificationRound } from '@shared/types/task'
import { type Judge, parseVerdict, type Verdict, verifyTask } from './verify'
```

(If `Task`/`TaskResult` are already imported from `@shared/types/task`, merge `AcceptanceCriterion, VerificationRound` into that import instead of adding a second line.)

In `AgentRunnerDeps` (before its closing `}` ~line 233), add:

```ts
  /** Capture the agent's derived acceptance criteria (Phase A). Wired by createAgentRunner.run. */
  onAcceptanceCriteria?(criteria: AcceptanceCriterion[]): void
  /**
   * Independently verify a completed turn. Default = hard checks + an LLM judge
   * sub-run; tests inject a stub. `judgeUsed` (when present) is folded into the
   * run's reported `used`.
   */
  verifyCompletion?(input: {
    criteria: AcceptanceCriterion[]
    summary: string
    cwd?: string
  }): Promise<Verdict & { judgeUsed?: ConsumedResources }>
  /**
   * Max execute→verify→rework rounds for a 'goal' task. Default 3. `0` disables
   * the verify loop entirely (legacy single-shot) — used by the verifier sub-run
   * to avoid recursion.
   */
  maxVerifyRounds?: number
```

- [ ] **Step 4: Wire the tool-context callback**

In `buildToolContext` (~line 292, in the returned object after `writeSkill: deps.writeSkill,`), add:

```ts
    setAcceptanceCriteria: deps.onAcceptanceCriteria,
```

- [ ] **Step 5: Add helpers + the loop + rebuild `createAgentRunner`**

Add these module-level helpers and constants just above `export function createAgentRunner` (~line 1117):

```ts
const DEFAULT_MAX_VERIFY_ROUNDS = 3

const VERIFIER_SYSTEM_PROMPT =
  'You are an independent verifier. You are given a task goal, its acceptance criteria, and the ' +
  "executor's final summary. Judge ONLY whether the criteria are met by the summary. Be strict and " +
  'skeptical; do not assume work that is not evidenced. Respond with ONLY a JSON object: ' +
  '{"pass": boolean, "gaps": [string]}. "gaps" lists concrete unmet items (empty when pass is true).'

const deriveCriteriaPrompt = (goal: string): string =>
  'Before doing the task, define how it will be judged complete. Call set_acceptance_criteria with a ' +
  'concise list of checkable done-conditions. Attach a `check` (command or file_exists) to any ' +
  'criterion a command can verify deterministically (e.g. tests pass, a file exists); leave the rest ' +
  `for judgment. Do NOT start the task yet.\n\nGoal: ${goal}`

const reworkPrompt = (gaps: string[]): string =>
  'Your work did not yet meet all acceptance criteria. Address these gaps, then stop:\n' +
  gaps.map((g) => `- ${g}`).join('\n')

const buildJudgePrompt = (goal: string, soft: AcceptanceCriterion[], summary: string): string =>
  `Goal:\n${goal}\n\nAcceptance criteria to judge:\n${
    soft.length ? soft.map((c) => `- ${c.description}`).join('\n') : '(none — judge overall goal completion)'
  }\n\nExecutor summary:\n${summary}`

const addUsed = (a: ConsumedResources, b: ConsumedResources): ConsumedResources => ({
  tokens: a.tokens + b.tokens,
  calls: a.calls + b.calls,
  wallMs: a.wallMs + b.wallMs,
  usdCents: a.usdCents + b.usdCents,
  cacheRead: a.cacheRead + b.cacheRead,
  cacheWrite: a.cacheWrite + b.cacheWrite,
})

// Default verification: deterministic hard checks plus an independent LLM judge
// sub-run on the same provider. The sub-run sets maxVerifyRounds: 0 so it never
// recurses into another verify loop.
function defaultVerifyCompletion(deps: AgentRunnerDeps): NonNullable<AgentRunnerDeps['verifyCompletion']> {
  return async ({ criteria, summary, cwd }) => {
    let judgeUsed: ConsumedResources | undefined
    const judge: Judge = async (soft, sum) => {
      const verifierTask: Task = {
        ...deps.task,
        id: `${deps.task.id}:verify`,
        goal: buildJudgePrompt(deps.task.goal, soft, sum),
        attachments: [],
        toolAllowlist: [],
        acceptanceCriteria: undefined,
        verifications: undefined,
        executionMode: 'goal',
      }
      const runner = createAgentRunner({
        task: verifierTask,
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
      const r = await runner.run()
      judgeUsed = r.used
      const parsed = parseVerdict(r.summary)
      if (!parsed) {
        log.warn({ msg: 'verifier output unparseable; treating as fail', taskId: deps.task.id })
        return { pass: false, gaps: ['verifier produced no parseable verdict'] }
      }
      return parsed
    }
    const verdict = await verifyTask({ criteria, summary, cwd, judge })
    return { ...verdict, judgeUsed }
  }
}

// The execute→verify→rework loop for a 'goal' task. Exported for unit testing
// with a fake session and an injected verify; createAgentRunner.run wires the
// real session + verify.
export async function runGoalVerifyLoop(args: {
  session: AgentSession
  goal: string
  images?: ImageContent[]
  criteriaRef: { current: AcceptanceCriterion[] }
  verify: NonNullable<AgentRunnerDeps['verifyCompletion']>
  maxRounds: number
  cwd?: string
  emit: EmitFn
  taskId: string
}): Promise<{ status: 'completed' | 'failed' | 'cancelled'; summary: string; messages: AgentMessage[]; used: ConsumedResources }> {
  const { session, goal, images, criteriaRef, verify, maxRounds, cwd, emit, taskId } = args
  const taskLog = log.child({ taskId })
  let extraUsed: ConsumedResources = emptyUsed()
  let lastGaps: string[] = []

  for (let round = 0; round <= maxRounds; round++) {
    const r =
      round === 0
        ? await session.promptOnce(goal, images && images.length > 0 ? images : undefined)
        : await session.promptOnce(reworkPrompt(lastGaps))
    if (r.status !== 'completed') {
      return { status: r.status, summary: r.summary, messages: session.agent.state.messages, used: addUsed(session.getUsed(), extraUsed) }
    }
    taskLog.info({ msg: 'verify round start', round, criteria: criteriaRef.current.length })
    const verdict = await verify({ criteria: criteriaRef.current, summary: r.summary, cwd })
    if (verdict.judgeUsed) extraUsed = addUsed(extraUsed, verdict.judgeUsed)
    const vr: VerificationRound = { round, verdict: verdict.verdict, results: verdict.results, gaps: verdict.gaps, ts: Date.now() }
    emit('task.verification', { taskId, round: vr, ts: Date.now() })
    taskLog.info({ msg: 'verify verdict', round, verdict: verdict.verdict, gaps: verdict.gaps.length })

    if (verdict.verdict === 'pass') {
      return { status: 'completed', summary: r.summary, messages: session.agent.state.messages, used: addUsed(session.getUsed(), extraUsed) }
    }
    lastGaps = verdict.gaps
    if (round === maxRounds) {
      taskLog.warn({ msg: 'verification exhausted rounds; marking failed', rounds: maxRounds })
      const summary = `${r.summary}\n\nUnmet acceptance criteria after ${maxRounds + 1} verify round(s):\n${verdict.gaps
        .map((g) => `- ${g}`)
        .join('\n')}`
      return { status: 'failed', summary, messages: session.agent.state.messages, used: addUsed(session.getUsed(), extraUsed) }
    }
  }
  // Unreachable — the loop always returns within the bounded rounds.
  return { status: 'failed', summary: '', messages: session.agent.state.messages, used: addUsed(session.getUsed(), extraUsed) }
}
```

Now replace the entire `createAgentRunner` function (~lines 1118-1136) with:

```ts
export function createAgentRunner(deps: AgentRunnerDeps): AgentRunner {
  return {
    async run() {
      const images: ImageContent[] = deps.task.attachments.map((a) => ({ type: 'image', data: a.data, mimeType: a.mimeType }))
      const maxRounds = deps.maxVerifyRounds ?? DEFAULT_MAX_VERIFY_ROUNDS
      const taskLog = log.child({ taskId: deps.task.id })

      // Legacy single-shot: plan mode, or verification disabled (e.g. the
      // verifier sub-run). No criteria derivation, no verify gate.
      if (deps.task.executionMode === 'plan' || maxRounds === 0) {
        const session = buildAgentSession(deps)
        const r = await session.promptOnce(deps.task.goal, images.length > 0 ? images : undefined)
        return { status: r.status, summary: r.summary, messages: session.agent.state.messages, used: session.getUsed() }
      }

      // Goal mode: define → execute → verify → rework.
      const criteriaRef: { current: AcceptanceCriterion[] } = { current: deps.task.acceptanceCriteria ?? [] }
      const wrappedDeps: AgentRunnerDeps = {
        ...deps,
        onAcceptanceCriteria: (c) => {
          criteriaRef.current = c
          deps.emit('task.criteria', { taskId: deps.task.id, criteria: c, ts: Date.now() })
          deps.onAcceptanceCriteria?.(c)
        },
      }
      const session = buildAgentSession(wrappedDeps)
      const verify = deps.verifyCompletion ?? defaultVerifyCompletion(deps)

      // Phase A — derive criteria unless the caller supplied them.
      if (criteriaRef.current.length === 0) {
        taskLog.info({ msg: 'deriving acceptance criteria' })
        await session.promptOnce(deriveCriteriaPrompt(deps.task.goal))
        if (criteriaRef.current.length === 0) {
          taskLog.warn({ msg: 'agent derived no criteria; using goal as a single soft criterion' })
          criteriaRef.current = [{ id: 'c1', description: deps.task.goal }]
        }
      }

      // Phase B + C.
      return runGoalVerifyLoop({
        session,
        goal: deps.task.goal,
        images,
        criteriaRef,
        verify,
        maxRounds,
        cwd: deps.task.cwd,
        emit: deps.emit,
        taskId: deps.task.id,
      })
    },
  }
}
```

- [ ] **Step 6: Run the new test + the existing runner tests**

Run: `npm test -- src/service/session/agent-runner.verify.test.ts src/service/session/agent-runner.test.ts src/service/session/agent-runner.fallback.test.ts`
Expected: PASS. The existing tests use real tasks with no `executionMode`, so they now run the goal loop — they each issue one `promptOnce` (the mock `prompt`), and Phase A's extra `promptOnce` plus the default verifier would change call counts. **To keep them deterministic, the existing tests already pass `toolAllowlist: []` and a 1-iteration agent.** Two of them may now expect different prompt counts. If any existing assertion breaks on prompt count or status, set `maxVerifyRounds: 0` in that test's `createAgentRunner({...})` deps so it keeps the legacy single-shot path. Document the change in the commit. Do NOT weaken a real behavior assertion — only opt the pure-plumbing tests out of the verify loop.

- [ ] **Step 7: Commit**

```bash
git add src/service/session/agent-runner.ts src/service/session/agent-runner.verify.test.ts src/service/session/agent-runner.test.ts src/service/session/agent-runner.fallback.test.ts
git commit -m "feat(runner): three-phase goal-verify loop (derive, execute, verify, rework)"
```

---

### Task 5: Persist criteria & verifications in the conversation store

**Files:**
- Modify: `src/service/conversation/store.ts` (schema/migration ~line 247; `ConversationStore` type ~line 78; statements ~line 487; `rowToTask` ~line 286; `saveTask` insert ~line 459/669; new methods ~line 665)
- Test: `src/service/conversation/store.test.ts` (append)

**Interfaces:**
- Consumes (Task 1): `AcceptanceCriterion`, `VerificationRound` via `Task`.
- Produces: `store.saveTaskCriteria(taskId, criteria)`, `store.saveTaskVerifications(taskId, rounds)`; `getTask`/`getSessionTasks` round-trip `acceptanceCriteria` and `verifications`.

- [ ] **Step 1: Write the failing test**

Append to `src/service/conversation/store.test.ts` (mirror the existing task round-trip tests for setup; the store is created with an in-memory or temp db there):

```ts
import type { AcceptanceCriterion, VerificationRound } from '@shared/types/task'

describe('acceptance criteria & verifications persistence', () => {
  it('round-trips criteria and verifications on a task', () => {
    const store = createConversationStore(':memory:')
    store.createSession('s1', { id: 'p', apiStyle: 'anthropic', model: 'm', apiKey: 'k' } as never)
    const task = {
      id: '01HZZZZZZZZZZZZZZZZZZZZZZ01',
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

    const criteria: AcceptanceCriterion[] = [{ id: 'c1', description: 'tests pass', check: { kind: 'command', command: 'npm test' } }]
    const rounds: VerificationRound[] = [{ round: 0, verdict: 'pass', results: [{ criterionId: 'c1', pass: true, detail: 'exit 0' }], gaps: [], ts: 5 }]
    store.saveTaskCriteria('01HZZZZZZZZZZZZZZZZZZZZZZ01', criteria)
    store.saveTaskVerifications('01HZZZZZZZZZZZZZZZZZZZZZZ01', rounds)

    const got = store.getTask('01HZZZZZZZZZZZZZZZZZZZZZZ01')
    expect(got?.acceptanceCriteria).toEqual(criteria)
    expect(got?.verifications).toEqual(rounds)
    store.close()
  })
})
```

(Use the same store-construction helper the existing tests use if they wrap `createConversationStore`; match imports already present in the file.)

- [ ] **Step 2: Run test to verify it fails**

Run: `npm test -- src/service/conversation/store.test.ts`
Expected: FAIL — `saveTaskCriteria` is not a function.

- [ ] **Step 3: Add columns + migration**

In the `CREATE TABLE IF NOT EXISTS tasks (...)` block (~line 144), add two columns before `created_at`:

```sql
      acceptance_criteria TEXT NOT NULL DEFAULT '[]',
      verifications       TEXT NOT NULL DEFAULT '[]',
```

In the `ALTER TABLE` migration array (~line 247), add:

```ts
    `ALTER TABLE tasks ADD COLUMN acceptance_criteria TEXT NOT NULL DEFAULT '[]'`,
    `ALTER TABLE tasks ADD COLUMN verifications TEXT NOT NULL DEFAULT '[]'`,
```

- [ ] **Step 4: Parse them in `rowToTask`**

In `rowToTask` (~line 286), before the trailing `...(row.context_window ...)` spread, add:

```ts
    acceptanceCriteria: JSON.parse((row.acceptance_criteria as string) ?? '[]') as Task['acceptanceCriteria'],
    verifications: JSON.parse((row.verifications as string) ?? '[]') as Task['verifications'],
```

Note: these parse to `[]` for legacy rows. `Task.acceptanceCriteria` is optional, so `[]` is valid. Downstream code (the runner) treats `[]` as "none".

- [ ] **Step 5: Add insert columns + the new statements/methods**

Update `stmtInsertTask` (~line 459) to include the two columns and two more `?`:

```ts
  const stmtInsertTask = db.prepare(
    `INSERT OR REPLACE INTO tasks
     (id, session_id, parent_id, goal, status, result, budget, used,
      agent_def_id, assigned_worker_id, tool_allowlist, history, attachments, plan,
      acceptance_criteria, verifications,
      created_at, started_at, ended_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
  )
```

Add two prepared statements near `stmtSetTaskPlan` (~line 487):

```ts
  const stmtSetTaskCriteria = db.prepare('UPDATE tasks SET acceptance_criteria = ? WHERE id = ?')
  const stmtSetTaskVerifications = db.prepare('UPDATE tasks SET verifications = ? WHERE id = ?')
```

Update the `saveTask` body (~line 669) to pass the two new JSON values in the matching positions (after `plan`, before `createdAt`):

```ts
        JSON.stringify(task.plan ?? []),
        JSON.stringify(task.acceptanceCriteria ?? []),
        JSON.stringify(task.verifications ?? []),
        task.createdAt,
```

Add the two methods next to `saveTaskPlan` (~line 665):

```ts
    saveTaskCriteria(taskId, criteria) {
      stmtSetTaskCriteria.run(JSON.stringify(criteria), taskId)
    },
    saveTaskVerifications(taskId, rounds) {
      stmtSetTaskVerifications.run(JSON.stringify(rounds), taskId)
    },
```

Add their signatures to the `ConversationStore` type (~line 78, after `saveTaskPlan`):

```ts
  saveTaskCriteria(taskId: string, criteria: Task['acceptanceCriteria']): void
  saveTaskVerifications(taskId: string, rounds: Task['verifications']): void
```

- [ ] **Step 6: Run test to verify it passes**

Run: `npm test -- src/service/conversation/store.test.ts`
Expected: PASS.

- [ ] **Step 7: Commit**

```bash
git add src/service/conversation/store.ts src/service/conversation/store.test.ts
git commit -m "feat(store): persist acceptance criteria and verification rounds"
```

---

### Task 6: Wire events, options, and config in the manager

**Files:**
- Modify: `src/shared/types/ui.ts` (`UIEvent` union ~line 79)
- Modify: `src/service/session/manager.ts` (event persistence ~line 252; `submitGoal` task build ~line 733; `maxVerifyRounds` into the two `createAgentRunner({...})` call sites ~line 556 and ~line 781)
- Test: `src/service/session/manager.test.ts` (append a focused case)

**Interfaces:**
- Consumes (Task 1): `AcceptanceCriterion`, `VerificationRound`; (Task 5): `store.saveTaskCriteria`, `store.saveTaskVerifications`.
- Produces: `UIEvent` variants `task.criteria` and `task.verification`; criteria from `TaskOptions` flow onto the submitted task; `maxVerifyRounds` reaches the runner.

- [ ] **Step 1: Write the failing test**

Append to `src/service/session/manager.test.ts` a case asserting that `task.criteria` / `task.verification` emits are persisted. Mirror the existing `task.plan` persistence test (search for `saveTaskPlan` in that file). If no such test exists, assert via a spy on the store passed into `createSessionManager`:

```ts
it('persists task.criteria and task.verification emits', () => {
  // Reuse the file's existing manager+store harness. Grab the emit fn the
  // manager wires (makeEmit) by triggering an emit through a known path, or
  // assert store methods are invoked when those events are emitted.
  // Concretely: call the manager's internal emit indirectly is not exposed, so
  // this test drives store wiring through the emit handler:
  const { store } = makeHarness() // existing helper in this file
  const saveCriteria = vi.spyOn(store, 'saveTaskCriteria')
  const saveVerif = vi.spyOn(store, 'saveTaskVerifications')
  // emit handler is exercised by the runner during a real submitGoal; if the
  // file already has a submitGoal-driven test with a mocked runner, assert the
  // spies there. Otherwise assert the pure handler if exported.
  expect(saveCriteria).toBeDefined()
  expect(saveVerif).toBeDefined()
})
```

Note to implementer: `manager.test.ts` already has a harness pattern — follow it. The substantive assertion is that the two new `if (event === ...)` branches call the store. If the existing tests do not exercise `makeEmit` directly, keep this test minimal (asserting the branches exist via a small refactor is optional) and rely on Task 5's store test + Task 4's emit test for coverage. Do not invent a new harness.

- [ ] **Step 2: Add the `UIEvent` variants**

In `src/shared/types/ui.ts`, in the `UIEvent` union (after the `task.plan` line ~line 79), add (with the `AcceptanceCriterion` / `VerificationRound` import at the top of the file, alongside the existing `PlanTodo` import from `./task`):

```ts
  | { kind: 'task.criteria'; sessionId: string; taskId: string; criteria: AcceptanceCriterion[]; ts: number }
  | { kind: 'task.verification'; sessionId: string; taskId: string; round: VerificationRound; ts: number }
```

Update the import: `import type { ... PlanTodo, AcceptanceCriterion, VerificationRound } from './task'` (merge into the existing task-type import).

- [ ] **Step 3: Persist the events in the manager**

In `src/service/session/manager.ts`, in the emit handler (after the `task.plan` branch ~line 256), add:

```ts
      if (event === 'task.criteria' && taskId && Array.isArray(obj?.criteria)) {
        const criteria = obj.criteria as import('@shared/types/task').AcceptanceCriterion[]
        store.saveTaskCriteria(taskId, criteria)
        log.info({ msg: 'acceptance criteria persisted', taskId, count: criteria.length })
      }
      if (event === 'task.verification' && taskId && obj?.round) {
        const round = obj.round as import('@shared/types/task').VerificationRound
        // Replace the full audit array each round (read-modify-write keeps it simple
        // and the array is tiny — bounded by maxVerifyRounds + 1).
        const existing = store.getTask(taskId)?.verifications ?? []
        store.saveTaskVerifications(taskId, [...existing, round])
        log.info({ msg: 'verification round persisted', taskId, round: round.round, verdict: round.verdict })
      }
```

(`obj` is the event payload already destructured in this handler — confirm the local variable name by reading lines 238-258; reuse it.)

- [ ] **Step 4: Flow criteria from options + wire `maxVerifyRounds`**

In `submitGoal`'s task literal (~line 733), add after `executionMode: options?.executionMode,`:

```ts
        acceptanceCriteria: options?.acceptanceCriteria,
```

Decide the `maxVerifyRounds` source. For v1, a module constant in the manager is sufficient (config UI is out of scope). Add near the top of the manager module (with the other consts like `PLAN_READONLY_ALLOWLIST`):

```ts
// Max execute→verify→rework rounds for autonomous ('goal') tasks. Bounded so a
// task that can't satisfy its criteria fails instead of looping forever.
const MAX_VERIFY_ROUNDS = 3
```

Then in BOTH `createAgentRunner({...})` deps objects — the `submitGoal` one (~line 781) and the `spawnChild` one (~line 556) — add:

```ts
          maxVerifyRounds: MAX_VERIFY_ROUNDS,
```

Leave `spawnResident`'s `runResident` path unchanged (actors are out of scope — they call `runResident`, not `createAgentRunner.run`).

- [ ] **Step 5: Run the manager tests + typecheck**

Run: `npm test -- src/service/session/manager.test.ts`
Expected: PASS. Then:
Run: `npx tsc --noEmit -p tsconfig.json` (or the project's typecheck script — `grep '"typecheck"\|"check"' package.json`)
Expected: no type errors from the new `UIEvent` variants or store signatures.

- [ ] **Step 6: Commit**

```bash
git add src/shared/types/ui.ts src/service/session/manager.ts src/service/session/manager.test.ts
git commit -m "feat(manager): persist criteria/verification events, wire options and round cap"
```

---

### Task 7 (optional follow-up): Renderer — criteria checklist + verdict marker

This task is a UI increment; the core loop is fully functional and persisted after Task 6. Ship it separately if time-boxed.

**Files:**
- Modify: `src/renderer/src/lib/apply-event.ts` (handle `task.criteria` / `task.verification` into task view state)
- Modify/Create: a small panel mirroring `plan-panel.tsx` / `plan-status-bar.tsx` to render criteria with pass/fail markers
- Test: alongside the existing renderer tests (e.g. `apply-event` test)

**Interfaces:**
- Consumes: `UIEvent` `task.criteria` / `task.verification` (Task 6); `AcceptanceCriterion` / `VerificationRound` (Task 1).

- [ ] **Step 1:** Read `src/renderer/src/lib/apply-event.ts` and the `task.plan` handling within it; add analogous reducers storing `acceptanceCriteria` and the latest `VerificationRound` on the task view model. Write a failing test mirroring the existing `task.plan` apply-event test.
- [ ] **Step 2:** Run the test to confirm it fails.
- [ ] **Step 3:** Implement the reducers (store criteria; append/replace the latest verdict).
- [ ] **Step 4:** Add a render surface: mirror `plan-status-bar.tsx`, showing each criterion with `[x]`/`[ ]` from the latest verdict's `results`, and an overall pass/fail chip. Use the `ScrollArea` component for any scroll container (never raw `overflow-auto`).
- [ ] **Step 5:** Run the renderer tests + the app (`run-desktop` skill) to eyeball the panel.
- [ ] **Step 6:** Commit: `feat(ui): render acceptance criteria and verify verdicts`.

---

## Self-Review

**Spec coverage:**
- §2 decisions 1-6 → Tasks 1 (types), 2 (hybrid verify), 3 (self-derive tool), 4 (in-runner loop, bounded rounds, goal-mode gate). ✓
- §3 data model → Task 1. ✓
- §4 three-phase loop → Task 4. ✓
- §5 verifier components (hard-check runner + judge) → Task 2 (engine) + Task 4 (`defaultVerifyCompletion` judge sub-run). ✓
- §6 criteria source/override → Task 1 (`TaskOptions`) + Task 4 (skip Phase A when supplied) + Task 6 (flow from options). ✓
- §7 bounds & budget → Task 4 (`maxVerifyRounds`, `addUsed` folds judge cost; live budget guard inside `promptOnce` ends a failed turn). ✓ Note: judge tokens count toward reported `used` but do not gate the live budget — bounded by `maxVerifyRounds`, documented in the dep comment.
- §8 logging → Tasks 2/4/6 (`info` derive/round/verdict/outcome, `warn` fallbacks/exhaustion, `error` check/judge failures). ✓
- §9 UI → Task 7 (optional). ✓
- §10 out of scope → actors (`runResident`) untouched; no verifier ModelRole (hook via `verifyCompletion`/provider reuse). ✓

**Placeholder scan:** No TBD/TODO; every code step shows full code. Task 6 Step 1 and Task 7 reference existing harness/patterns the implementer must read rather than inventing — acceptable (they say which file + which existing pattern to mirror), and the substantive coverage lives in Tasks 4/5 tests.

**Type consistency:** `AcceptanceCriterion`, `VerificationRound`, `Verdict`, `Judge`, `CheckResult` named identically across Tasks 1-6. `setAcceptanceCriteria` (ToolRunContext) ↔ `onAcceptanceCriteria` (AgentRunnerDeps) wired in Task 4 Step 4. `verifyCompletion` signature identical in the dep (Task 4 Step 3) and `runGoalVerifyLoop` arg (Task 4 Step 5). Store methods `saveTaskCriteria`/`saveTaskVerifications` match between Task 5 (definition) and Task 6 (call sites).

**Recursion guard:** verifier sub-run sets `maxVerifyRounds: 0` → legacy single-shot path, no nested verify. ✓
