# 涌现式软件公司原型(方案 A)Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 在既有 actor 底座上,用一组 `AgentDefinition`(ceo/pm/engineer/reviewer)+ 薄启动方法 `startCompany`,让"软件公司"靠 prompt 约定涌现地协作完成一个多步任务——零新核心机制。

**Architecture:** 三块拼装,无新核心机制:(1) 四个角色 `AgentDefinition` 加进 `builtinAgents`,systemPrompt 写明队友固定名 + 用 `send_and_wait`/`spawn` 委派/回报;(2) `startCompany(sessionId, goal)` 为固定花名册每个角色 `ensureActor(roleId, name=roleId)`,再以 rpc 把 goal 投给 `ceo`,其最终回信即整次运行结果;(3) 协作链(CEO→PM→engineer/reviewer→迭代→汇总)全靠 prompt 约定,经既有 `send_and_wait` 路由。

**Tech Stack:** TypeScript,Electron(service 进程),既有 actor 底座(`ensureActor`/`sendMessage`/`runResident`/`agent.*` 工具),`vitest`(经 `npm test`),stub-agent e2e(仿 `agent-cluster.e2e.test.ts`)。

## Global Constraints

- **Reply in Chinese;代码注释、commit message、agent systemPrompt 内容均用英文**(systemPrompt 与现有 builtin 角色一致用英文)。(CLAUDE.md §0;现有 `builtins.ts` 惯例)
- **每个业务路径打结构化日志**;`startCompany` 在 `session-manager` 的 logger 打 `info`(`{ msg, sessionId, goalLen }`);每个 `catch` 至少 `error`。(CLAUDE.md §5)
- **测试经 Electron node 运行**:`npm test`。**勿**裸 `npx vitest`;**勿** `pnpm rebuild better-sqlite3`(破坏 ABI,`npm run postinstall` 恢复)。(memory `project_run_tests_via_electron_node`)
- **`src/service/**` 不在 tsconfig typecheck 范围**,靠 vitest 兜类型。
- **scoped 格式化**:`npx biome check --write <file>`,**勿** `pnpm check/format`(重排全仓)。(memory `reference_biome_check_hardcodes_dot`)
- **角色全部 `toolScope: 'all'`**(spec §3 决策)。
- **PM 评审迭代上限写死 10 轮**(spec §4.1)。
- **固定花名册用常量数组单一真相源**,避免 prompt 队友名与播种名漂移。(spec §9)
- **TDD**;外科手术式改动,现有 3 个 builtin 角色 + 计划 A/B/阶段 3 测试零回归。(CLAUDE.md §3)
- **在专用 git worktree 的独立分支实现(基于 `develop`)。**(CLAUDE.md §6)

---

### Task 1: 公司角色 AgentDefinition(花名册内容)

四个新角色加进 `builtinAgents`,名字=id,systemPrompt 写明职责 + 队友固定名 + 协作工具。

**Files:**
- Modify: `src/shared/agents/builtins.ts`(加 4 个 systemPrompt 常量 + 4 个 `AgentDefinition` 到 `builtinAgents` 数组)
- Test: `src/shared/agents/builtins.company.test.ts`

**Interfaces:**
- Consumes: `AgentDefinition` from `@shared/types/agent`;`AgentDefinitionSchema`、`deriveAllowlist` from same.
- Produces: `builtinAgents` 数组新增 id 为 `ceo`/`pm`/`engineer`/`reviewer` 的四项(供 Task 2/3 经 agentStore 解析)。

- [ ] **Step 1: Write the failing test**

```ts
// src/shared/agents/builtins.company.test.ts
import { describe, expect, it } from 'vitest'

import { AgentDefinitionSchema } from '@shared/types/agent'

import { builtinAgents } from './builtins'

const COMPANY_IDS = ['ceo', 'pm', 'engineer', 'reviewer'] as const

describe('company role agent definitions', () => {
  it('ships ceo/pm/engineer/reviewer as valid, full-scope definitions', () => {
    for (const id of COMPANY_IDS) {
      const def = builtinAgents.find((a) => a.id === id)
      expect(def, `missing role ${id}`).toBeDefined()
      // Each role parses against the schema.
      expect(() => AgentDefinitionSchema.parse(def)).not.toThrow()
      expect(def?.toolScope).toBe('all')
      expect(def?.description.length).toBeGreaterThan(0)
      expect(def?.systemPrompt.length).toBeGreaterThan(0)
    }
  })

  it('each company role prompt names its delegation teammates by fixed name', () => {
    const pm = builtinAgents.find((a) => a.id === 'pm')!
    // The PM coordinates engineer + reviewer, so both fixed names appear in its prompt.
    expect(pm.systemPrompt).toContain('engineer')
    expect(pm.systemPrompt).toContain('reviewer')
    const ceo = builtinAgents.find((a) => a.id === 'ceo')!
    expect(ceo.systemPrompt).toContain('pm')
  })

  it('keeps the pre-existing builtin roles intact', () => {
    for (const id of ['default', 'researcher', 'executor']) {
      expect(builtinAgents.find((a) => a.id === id), `lost builtin ${id}`).toBeDefined()
    }
  })
})
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npm test -- src/shared/agents/builtins.company.test.ts`
Expected: FAIL — `missing role ceo` (roles not added yet).

- [ ] **Step 3: Add the role prompts + definitions**

In `src/shared/agents/builtins.ts`, after the existing `EXECUTOR_SYSTEM_PROMPT` constant and before `export const builtinAgents`, add the four prompts. The prompts are the entire source of "emergent" structure — they must name teammates by fixed name and state when/how to delegate.

```ts
const CEO_SYSTEM_PROMPT = `You are the CEO of a small software company. You receive a single high-level goal and are responsible for delivering the finished result.

Your team (address each by these exact names):
  - pm — the project manager who breaks work down and drives implementation + review.

Workflow:
  1. Read the goal. Do NOT write code yourself.
  2. Delegate the whole goal to the PM with full context: send_and_wait("pm", <the goal plus any constraints>).
  3. When the PM returns the deliverable, review it at a high level and produce a concise final summary of what was built and its status.
  4. Your reply to the original request IS that final summary — it is the result of the entire run.`

const PM_SYSTEM_PROMPT = `You are the Project Manager of a small software company. You turn a goal into a concrete deliverable by coordinating an engineer and a reviewer.

Your team (address each by these exact names):
  - engineer — implements code and runs tests.
  - reviewer — reviews the engineer's output and reports issues.

Workflow:
  1. Break the CEO's goal into a concrete implementation task (what to build, where, acceptance criteria).
  2. send_and_wait("engineer", <the concrete task, including the working directory to use>).
  3. When the engineer reports done, request a review: send_and_wait("reviewer", <what to review and the artifact location>).
  4. If the reviewer reports issues, send the fixes back: send_and_wait("engineer", <the issues to fix>), then review again.
  5. Repeat the fix/review loop AT MOST 10 times. If still not passing after 10 rounds, stop and summarize with an explicit "did not meet bar" note.
  6. Return a consolidated deliverable summary (what was built, where, test/review status) to the CEO.`

const ENGINEER_SYSTEM_PROMPT = `You are a Software Engineer at a small software company. You implement concrete tasks and verify them.

You have full tool access (shell, files, web). For large sub-tasks you may delegate throwaway pieces with spawn().

Workflow:
  1. Read the task and the working directory you were given.
  2. Implement the code in that directory.
  3. Run the relevant tests/build to verify your work.
  4. Report back a concise summary: what you changed, the file paths, and the test/verification result. If something failed, say so explicitly — do not claim success you did not verify.`

const REVIEWER_SYSTEM_PROMPT = `You are a Code Reviewer at a small software company. You review an engineer's output and report a verdict.

Workflow:
  1. Read the artifact at the location you were given (the changed files).
  2. Check correctness, that tests exist and pass, and that the task's acceptance criteria are met.
  3. Reply with a verdict: either "APPROVED" with a one-line reason, or "NEEDS CHANGES" followed by a concrete, numbered list of issues to fix.
  4. Be specific and actionable — the PM routes your issues straight back to the engineer.`
```

Then add four entries to the `builtinAgents` array (after the existing `executor` entry, before the closing `]`):

```ts
  {
    id: 'ceo',
    name: 'CEO',
    description:
      'Use as the top of a software-company run: receives a high-level goal, delegates to the PM, and produces the final summary. Coordinates only — does not write code.',
    systemPrompt: CEO_SYSTEM_PROMPT,
    toolScope: 'all',
    maxIterations: 20,
  },
  {
    id: 'pm',
    name: 'Project Manager',
    description:
      'Use to turn a goal into a concrete deliverable by coordinating an engineer and a reviewer, driving a fix/review loop until the work meets the bar.',
    systemPrompt: PM_SYSTEM_PROMPT,
    toolScope: 'all',
    maxIterations: 25,
  },
  {
    id: 'engineer',
    name: 'Engineer',
    description:
      'Use when a concrete implementation task needs code written and verified (shell + files). Reports what it built and the test result.',
    systemPrompt: ENGINEER_SYSTEM_PROMPT,
    toolScope: 'all',
    maxIterations: 30,
  },
  {
    id: 'reviewer',
    name: 'Reviewer',
    description:
      'Use to review an engineer’s output against acceptance criteria and report an APPROVED / NEEDS CHANGES verdict with actionable issues.',
    systemPrompt: REVIEWER_SYSTEM_PROMPT,
    toolScope: 'all',
    maxIterations: 20,
  },
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npm test -- src/shared/agents/builtins.company.test.ts`
Expected: PASS (3 tests).

- [ ] **Step 5: Format + commit**

```bash
npx biome check --write src/shared/agents/builtins.ts src/shared/agents/builtins.company.test.ts
git add src/shared/agents/builtins.ts src/shared/agents/builtins.company.test.ts
git commit -m "feat(agents): add ceo/pm/engineer/reviewer company role definitions"
```

---

### Task 2: `startCompany` 启动方法

`SessionManager` 新增 `startCompany(sessionId, goal)`:为固定花名册每个角色 `ensureActor(roleId, name=roleId)`,再以 rpc 把 goal 投给 `ceo`,返回其回信。

**Files:**
- Modify: `src/service/session-manager.ts`（`SessionManager` 接口 `~:72`;返回对象 `~:564`;`ensureActor`/`sendMessage` 已在闭包内可用）
- Test: `src/service/company.startup.test.ts`

**Interfaces:**
- Consumes: `ensureActor(sessionId, agentDefId, name?)`、`sendMessage(sessionId, fromAddr, toAddr, payload, kind)`（返回 `Promise<{ reply: string } | { delivered: true }>`）、`cfg.agentStore`(测试经此解析角色 def)。
- Produces:
  - `SessionManager.startCompany(sessionId: string, goal: string): Promise<{ reply: string } | { delivered: true }>`
  - `COMPANY_ROLES = ['ceo', 'pm', 'engineer', 'reviewer'] as const`(模块常量,花名册单一真相源)

- [ ] **Step 1: Write the failing test**

```ts
// src/service/company.startup.test.ts
import { describe, expect, it, vi } from 'vitest'

import { builtinAgents } from '@shared/agents/builtins'

import { createConversationStore } from './conversation-store'
import { createSessionManager } from './session-manager'

// CEO stub: replies with a fixed final summary; others not exercised here.
vi.mock('./agent-runner', () => ({
  createAgentRunner: () => ({ run: async () => ({ status: 'completed', summary: '', messages: [], used: {} }) }),
  buildAgentSession: () => ({}),
  runResident: async (deps: any, mailbox: any, hooks: any) => {
    for (;;) {
      let msg
      try {
        msg = await mailbox.receive({ idleMs: 5 })
      } catch {
        return
      }
      await hooks.acquireTurnSlot()
      hooks.releaseTurnSlot()
      const summary = deps.agentDefinition.id === 'ceo' ? 'FINAL: shipped' : `ack:${msg.payload}`
      hooks.onConsumed(msg.id, '{"v":1,"messages":[]}')
      if (msg.kind === 'rpc' && msg.correlationId) hooks.onReply(msg.correlationId, summary)
    }
  },
}))

const fakeProvider = { model: 'test', apiStyle: 'anthropic' } as any
const roleStore = {
  get: (id: string) => builtinAgents.find((a) => a.id === id),
  list: () => builtinAgents,
}

describe('startCompany', () => {
  it('seeds the fixed roster as named actors and rpc-kicks the CEO', async () => {
    const store = createConversationStore(':memory:')
    const mgr = createSessionManager({
      store,
      broadcaster: { broadcast: () => {} },
      maxConcurrent: 4,
      getProvider: () => fakeProvider,
      agentStore: roleStore as any,
    })
    const { sessionId } = mgr.createSession(fakeProvider)

    const result = await mgr.startCompany(sessionId, 'build a thing')

    // CEO's reply is the run result.
    expect(result).toEqual({ reply: 'FINAL: shipped' })
    // All four roles were seeded as named, addressable actors.
    for (const id of ['ceo', 'pm', 'engineer', 'reviewer']) {
      expect(store.getActorByName(sessionId, id), `missing actor ${id}`).toBeTruthy()
    }
  })
})
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npm test -- src/service/company.startup.test.ts`
Expected: FAIL — `mgr.startCompany is not a function`.

- [ ] **Step 3: Add the roster constant + method implementation**

In `src/service/session-manager.ts`, near the top of the module (after imports, with the other module constants like `IDLE_TIMEOUT_MS`), add:

```ts
// Fixed company roster (approach A). Single source of truth: the seeded actor
// name equals the agent-def id, and role prompts address teammates by these
// exact names. The CEO is first — it receives the kickoff goal.
const COMPANY_ROLES = ['ceo', 'pm', 'engineer', 'reviewer'] as const
```

Add to the `SessionManager` type (after `submitGoal`'s signature, `~:84`):

```ts
  startCompany(sessionId: string, goal: string): Promise<{ reply: string } | { delivered: true }>
```

Add to the returned object (alongside `submitGoal`, `~:581`):

```ts
    async startCompany(sessionId, goal) {
      // Seed the fixed roster as named, addressable actors, then rpc-kick the
      // CEO; its reply is the result of the whole run.
      log.info({ msg: 'company started', sessionId, goalLen: goal.length })
      for (const roleId of COMPANY_ROLES) {
        ensureActor(sessionId, roleId, roleId)
      }
      return sendMessage(sessionId, null, 'ceo', goal, 'rpc')
    },
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npm test -- src/service/company.startup.test.ts`
Expected: PASS.

- [ ] **Step 5: Format + commit**

```bash
npx biome check --write src/service/session-manager.ts src/service/company.startup.test.ts
git add src/service/session-manager.ts src/service/company.startup.test.ts
git commit -m "feat(session): startCompany seeds fixed roster and rpc-kicks the CEO"
```

---

### Task 3: 协作链确定性 e2e(主验收)

stub-agent 按角色脚本化委派,经**真实** `send_and_wait` 路由,验证 CEO→PM→engineer/reviewer→汇总的完整链路 + 评审迭代回环。

**Files:**
- Test: `src/service/company.e2e.test.ts`

**Interfaces:**
- Consumes: `startCompany`(Task 2)、`builtinAgents`(Task 1，作 agentStore)、`deps.agentDefinition.id`(角色 id)、`deps.sendMessage(fromAddr, toAddr, payload, kind)`(resident 桥,rpc 返回 `{reply}`)、`deps.selfAddress`。
- Produces: 无新导出(验收测试)。

- [ ] **Step 1: Write the full-chain test (failing until roster+startCompany exist)**

stub `runResident` 按 `deps.agentDefinition.id` 脚本化:CEO 转发给 pm;PM 先发 engineer 再发 reviewer 并据 verdict 迭代;engineer/reviewer 返回固定结果。委派经 `deps.sendMessage(..., 'rpc')` 走真实路由。`maxConcurrent: 4` 确保深 rpc 链(ceo→pm→engineer 同时持槽 ≤3)不死锁。

```ts
// src/service/company.e2e.test.ts
import { describe, expect, it, vi } from 'vitest'

import { builtinAgents } from '@shared/agents/builtins'

import { createConversationStore } from './conversation-store'
import { createSessionManager } from './session-manager'

// Records the routed message chain so the test can assert the collaboration
// flow. Module-scope so the hoisted mock factory can close over it.
const { chain, reviewerVerdicts } = vi.hoisted(() => ({
  chain: [] as string[],
  reviewerVerdicts: [] as string[], // controls reviewer replies per call
}))

// Per-role scripted behavior, exercising the REAL send_and_wait routing via
// deps.sendMessage. Each role's turn holds a slot only while working; nested
// rpc awaits run within maxConcurrent=4 (max concurrent holders = 3).
vi.mock('./agent-runner', () => ({
  createAgentRunner: () => ({ run: async () => ({ status: 'completed', summary: '', messages: [], used: {} }) }),
  buildAgentSession: () => ({}),
  runResident: async (deps: any, mailbox: any, hooks: any) => {
    const role = deps.agentDefinition.id
    for (;;) {
      let msg
      try {
        msg = await mailbox.receive({ idleMs: 5 })
      } catch {
        return
      }
      await hooks.acquireTurnSlot()
      let summary = ''
      try {
        chain.push(`${role}:recv`)
        if (role === 'ceo') {
          const r = await deps.sendMessage(deps.selfAddress, 'pm', msg.payload, 'rpc')
          summary = `FINAL(${r.reply})`
        } else if (role === 'pm') {
          const built = await deps.sendMessage(deps.selfAddress, 'engineer', 'implement', 'rpc')
          let verdict = (await deps.sendMessage(deps.selfAddress, 'reviewer', `review ${built.reply}`, 'rpc')).reply
          let rounds = 0
          while (verdict.startsWith('NEEDS') && rounds < 10) {
            rounds++
            await deps.sendMessage(deps.selfAddress, 'engineer', 'fix', 'rpc')
            verdict = (await deps.sendMessage(deps.selfAddress, 'reviewer', 'review again', 'rpc')).reply
          }
          summary = `DELIVERED(${verdict}, rounds=${rounds})`
        } else if (role === 'engineer') {
          summary = 'built:ok'
        } else if (role === 'reviewer') {
          summary = reviewerVerdicts.shift() ?? 'APPROVED'
        }
      } finally {
        hooks.releaseTurnSlot()
      }
      hooks.onConsumed(msg.id, '{"v":1,"messages":[]}')
      if (msg.kind === 'rpc' && msg.correlationId) hooks.onReply(msg.correlationId, summary)
    }
  },
}))

const fakeProvider = { model: 'test', apiStyle: 'anthropic' } as any
const roleStore = { get: (id: string) => builtinAgents.find((a) => a.id === id), list: () => builtinAgents }

function makeMgr() {
  const store = createConversationStore(':memory:')
  const mgr = createSessionManager({
    store,
    broadcaster: { broadcast: () => {} },
    maxConcurrent: 4,
    getProvider: () => fakeProvider,
    agentStore: roleStore as any,
  })
  return { store, mgr }
}

describe('emergent company — collaboration chain', () => {
  it('routes goal CEO->PM->engineer+reviewer and returns the assembled result (approve first pass)', async () => {
    chain.length = 0
    reviewerVerdicts.length = 0 // defaults to APPROVED
    const { mgr } = makeMgr()
    const { sessionId } = mgr.createSession(fakeProvider)

    const result = (await mgr.startCompany(sessionId, 'build a thing')) as { reply: string }

    expect(result.reply).toBe('FINAL(DELIVERED(APPROVED, rounds=0))')
    // Every role participated, in order.
    expect(chain).toContain('ceo:recv')
    expect(chain).toContain('pm:recv')
    expect(chain).toContain('engineer:recv')
    expect(chain).toContain('reviewer:recv')
  })

  it('drives the fix/review loop when the reviewer first reports NEEDS CHANGES', async () => {
    chain.length = 0
    reviewerVerdicts.length = 0
    reviewerVerdicts.push('NEEDS CHANGES: 1. fix it', 'APPROVED') // round 1 fails, round 2 passes
    const { mgr } = makeMgr()
    const { sessionId } = mgr.createSession(fakeProvider)

    const result = (await mgr.startCompany(sessionId, 'build a thing')) as { reply: string }

    expect(result.reply).toBe('FINAL(DELIVERED(APPROVED, rounds=1))')
    // engineer was re-invoked for the fix (recv appears at least twice).
    expect(chain.filter((c) => c === 'engineer:recv').length).toBeGreaterThanOrEqual(2)
  })
})
```

- [ ] **Step 2: Run test to verify it fails (then passes once Tasks 1+2 are in)**

Run: `npm test -- src/service/company.e2e.test.ts`
Expected before Tasks 1+2: FAIL (`startCompany is not a function` / roles unresolved). After Tasks 1+2 are merged: this test is added last, so run it and expect PASS (2 tests). If RED for the right reason isn't observable (Tasks 1+2 already done), temporarily rename `startCompany` in the test to confirm the harness wiring, then restore.

- [ ] **Step 3: (no implementation — this task is the acceptance test)**

This task adds only the e2e test; the behavior it checks is delivered by Tasks 1+2. If the test fails, the defect is in Task 1 (role defs / agentStore resolution) or Task 2 (startCompany wiring) — fix there, not by weakening the test.

- [ ] **Step 4: Run the full suite to confirm no regression**

Run: `npm test`
Expected: all green (existing + 3 new test files). Confirm calc: company.e2e (2) + company.startup (1) + builtins.company (3) added; plans A/B/phase-3 suites unchanged.

- [ ] **Step 5: Format + commit**

```bash
npx biome check --write src/service/company.e2e.test.ts
git add src/service/company.e2e.test.ts
git commit -m "test(company): deterministic CEO->PM->engineer/reviewer collaboration e2e"
```

---

### Task 4: 手动真 LLM 冒烟入口(文档化)

一个 dev-only 脚本,用真 provider 调 `startCompany` 给一个真实小任务,供人工观察协作。不进 CI。

**Files:**
- Create: `scripts/smoke-company.ts`
- Modify: `docs/superpowers/specs/2026-06-23-emergent-software-company-prototype-design.md`(在 §6 末尾加一行"冒烟脚本用法"指引)— 可选,若 spec 已足够清楚可跳过。

**Interfaces:**
- Consumes: `createSessionManager`、`createConversationStore`、真 provider 配置(从用户现有 provider 设置/环境读取)、`builtinAgents`(agentStore)。

- [ ] **Step 1: Write the smoke script**

脚本是人工运行的观察工具,不是自动化测试;它没有断言,价值在于打印协作过程。给出可运行骨架,真 provider 装配沿用项目既有方式(若项目已有装配真 provider 的 dev 入口,复用之;否则从环境变量读 API key)。

```ts
// scripts/smoke-company.ts
// Manual real-LLM smoke for the emergent company prototype. NOT a CI test.
// Run with the project's Electron-node test runner or a tsx/dev entry that has
// a real provider configured. It seeds the company and gives the CEO a small,
// self-contained task, then prints the CEO's final reply. Watch the structured
// logs (components actor-runtime / mailbox / actor-state) to observe the
// CEO->PM->engineer/reviewer collaboration.
import { builtinAgents } from '../src/shared/agents/builtins'
import { createConversationStore } from '../src/service/conversation-store'
import { createSessionManager } from '../src/service/session-manager'

async function main() {
  const provider = {
    // Fill from the project's real provider config / env (model + apiKey + apiStyle).
    // This script is run by a human who has a working provider; wire it the same
    // way the app injects ProviderInjection.
  } as any
  const store = createConversationStore(':memory:')
  const mgr = createSessionManager({
    store,
    broadcaster: { broadcast: () => {} },
    maxConcurrent: 4,
    getProvider: () => provider,
    agentStore: { get: (id: string) => builtinAgents.find((a) => a.id === id), list: () => builtinAgents } as any,
  })
  const { sessionId } = mgr.createSession(provider)
  const goal =
    'In a fresh temp directory, implement a TypeScript function `slugify(s: string): string` ' +
    'plus a vitest test, and make the test pass.'
  // eslint-disable-next-line no-console
  console.log('GOAL:', goal)
  const result = await mgr.startCompany(sessionId, goal)
  // eslint-disable-next-line no-console
  console.log('CEO FINAL REPLY:', result)
}

void main()
```

- [ ] **Step 2: Verify it type-checks / loads (no run without a real provider)**

Run: `npx tsc --noEmit scripts/smoke-company.ts 2>&1 | head` (best-effort; the script is dev-only and not in the app build). If the project has no standalone tsc for scripts, skip — the file is documentation-grade and exercised manually.
Expected: no syntax errors. Do NOT attempt a real run in CI (needs a provider + is nondeterministic).

- [ ] **Step 3: Commit**

```bash
npx biome check --write scripts/smoke-company.ts
git add scripts/smoke-company.ts
git commit -m "chore(company): dev-only real-LLM smoke entry for the company prototype"
```

---

### Task 5: 全量回归 + 收尾

- [ ] **Step 1: Run the full suite**

Run: `npm test`
Expected: all green. Confirm the three new test files pass and nothing regressed (plans A/B/phase-3 suites, the 3 pre-existing builtin roles).

- [ ] **Step 2: If anything fails, fix at root**

Any failure traces to Task 1 (role defs), Task 2 (startCompany), or Task 3 (e2e stub wiring). Fix there; do not weaken tests. Re-run `npm test` until green.

- [ ] **Step 3: Hand off**

全绿后,用 `superpowers:finishing-a-development-branch` 决定合并/PR/清理 worktree。

---

## Self-Review

**1. Spec coverage:**
- spec §4.1 花名册四角色(全 `all`,prompt 写队友名) → Task 1 ✅
- spec §4.2 `startCompany`(花名册 ensureActor + rpc 投 CEO) → Task 2 ✅
- spec §4.3 协作数据流(CEO→PM→engineer/reviewer→汇总) → Task 3 full-chain e2e ✅
- spec §5 迭代上限 10 轮 / 不无限循环 → Task 1 PM prompt(写死 10)+ Task 3 迭代回环测试(rounds 计数)✅
- spec §6 测试:startCompany 单测(T2)/ 确定性协作 e2e(T3)/ 迭代回环(T3)/ 角色定义健全(T1)/ 回归(T5)/ 手动冒烟(T4)✅
- spec §7 文件结构 → Task 1-4 文件一致 ✅
- spec §8 非目标(不建 Team/Org、不做 hire/UI/并行)→ 计划未涉及,符合 ✅

**2. Placeholder scan:** 无 TBD/TODO;每个 code step 含完整代码;systemPrompt 为完整英文文本非占位;Task 4 脚本的 provider 装配明确标注"沿用项目真 provider 注入方式"(dev-only 文档级,非自动化占位)。

**3. Type consistency:** `startCompany(sessionId, goal): Promise<{reply}|{delivered}>` 在 Task 2 定义与 Task 3 调用一致;`COMPANY_ROLES` 常量 Task 2 定义;`deps.sendMessage(from,to,payload,kind)` / `deps.selfAddress` / `deps.agentDefinition.id` 在 Task 3 使用与底座一致;角色 id `ceo/pm/engineer/reviewer` 跨 Task 1/2/3 一致;`onConsumed(msgId, state)` 二参签名(阶段 3 后)在 stub 中正确传 state blob。

**说明(stub 中持槽跨 rpc await):** Task 3 stub 在 turn-slot 持有期间 await 嵌套 `deps.sendMessage`(rpc),与生产里 send_and_wait 让出槽的行为不同;`maxConcurrent: 4` 下最大并发持槽数 = 3(ceo+pm+engineer),不死锁。这是 stub 的简化,e2e 验证的是**路由/链路**而非 turn-slot 让出语义(后者由计划 B 的死锁回归测试覆盖)。
