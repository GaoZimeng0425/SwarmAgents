# 结构化 State、Checkpoint Fork、编排可视化 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 接通 delegation 的结构化结果传递（artifacts）+ session 级 plan 状态（事件重放派生）+ 编排可视化 + checkpoint fork，补全递归委托架构的三项缺口。

**Architecture:** planState 是 session 级的派生缓存，挂在 `createSessionService` 闭包，经 `MessageSpec` 回调（`onDelegationPlan` / `onDelegationUpdate`）注入到 launch ctx。事件流（`message.delegation_plan` + `message.delegation_update`）是唯一真相，内存懒加载重放。artifacts 透传是独立的 per-run 通路（sink → EngineRunResult → delegate 透传 → tool_result.details）。三项顺序 ①→③→②，②与 ①③ 正交。

**Tech Stack:** TypeScript, Electron, pi-ai (TypeBox tool params), zod (protocol schemas), vitest, @xyflow/react, TanStack react-query, zustand.

## Global Constraints

- Schema 库：protocol 类型用 **zod**（`z.object`/`z.enum` + `z.infer`）；工具 params 用 **TypeBox**（`Type.Object`/`Type.Enum`，来自 `@earendil-works/pi-ai`）。二者不互换，工具侧用 TypeBox 重写等价结构。
- `DelegationItemStatus` 是新建类型：`'pending'|'running'|'completed'|'failed'|'cancelled'`，不复用 task.ts 的 `planStatusValues`（plan todo 用 `in_progress`）。
- 所有代码注释和 commit message 用英文。对话用中文。
- 测试用 vitest，照现有 `delegation-plan.test.ts` 的 `vi.fn()` + `spec().build(ctx)` + `tool.execute(id, params)` 模式。
- 项目用 pnpm。

---

## File Structure

### 项 ① 新增/修改文件

| 文件 | 职责 |
|---|---|
| `packages/protocol/src/types/task.ts` | 导出 `DelegationItemStatus` 类型 |
| `packages/protocol/src/types/message.ts` | 加 `message.delegation_update` 事件 |
| `packages/shared/src/messages/delegation-reducer.ts` | **新增**：前后端共用的 reducer（plan 全量覆盖 / update 按 itemId merge） |
| `packages/shared/src/messages/apply-event.ts` | 加 delegation_plan / delegation_update 处理 + MessageRecord 字段 |
| `apps/desktop/src/service/tools/report-result.ts` | **新增**：子 agent 提交结构化结果的工具 |
| `apps/desktop/src/service/tools/report-result.test.ts` | **新增** |
| `apps/desktop/src/service/tools/builtins.ts` | 注册 report_result |
| `apps/desktop/src/service/tools/registry.ts` | ToolRunContext 加 mergeDelegationResult / reportResult |
| `apps/desktop/src/service/tools/delegate.ts` | 加 itemId 参数 + 三处 merge |
| `apps/desktop/src/service/tools/delegate.test.ts` | 测试 itemId + 异常路径 |
| `apps/desktop/src/service/message-engine/launch.ts` | ctx 加 mergeDelegationResult/reportResult sink；自动注入 report_result；返回值带 artifacts |
| `apps/desktop/src/service/message-engine/engine.ts` | EngineRunResult 加 artifacts 字段 |
| `apps/desktop/src/service/session/session-service.ts` | planStates Map + 懒加载重放 + 回调注入 + delegate/createTask 透传 artifacts |
| `apps/desktop/src/service/agents/prompt.ts` | 加 report_result 引导 |
| `apps/desktop/src/service/agents/prompt.test.ts` | 断言 report_result 出现 |
| `apps/desktop/src/renderer/src/hooks/use-delegation-plan.ts` | **新增**：从 react-query 缓存读 plan 状态 |

### 项 ③ 新增/修改文件

| 文件 | 职责 |
|---|---|
| `apps/desktop/src/renderer/src/components/orchestration/OrchestrationGraph.tsx` | **新增**：xyflow 画布主组件 |
| `apps/desktop/src/renderer/src/components/orchestration/PlanItemNode.tsx` | **新增**：plan-item 节点 |
| `apps/desktop/src/renderer/src/components/orchestration/RunNode.tsx` | **新增**：run 节点 |
| `apps/desktop/src/renderer/src/components/views/tasks-view.tsx` | 改：加编排图面板入口 |

### 项 ② 新增/修改文件

| 文件 | 职责 |
|---|---|
| `apps/desktop/src/service/session/session-service.ts` | 加 forkToNewSession 方法 |
| `apps/desktop/src/main/ipc/swarm-ipc.ts` | 加 forkSession IPC handler |
| `apps/desktop/src/preload/index.ts` | 暴露 forkSession API |
| `packages/protocol/src/types/ui.ts` | SwarmBridge 加 forkSession 类型 |
| `apps/desktop/src/renderer/src/components/task-transcript.tsx` | 加"从这里分支"按钮 |
| `apps/desktop/src/renderer/src/components/session-header.tsx` | fork session 标记 |

---

## 项 ①：结构化 State + session 级 planState（地基）

### Task 1: protocol 加 DelegationItemStatus 类型

**Files:**
- Modify: `packages/protocol/src/types/task.ts`（在 `DelegationItemSchema` 附近，约 L77-86）
- Test: 无独立测试（类型导出，后续任务使用时验证）

**Interfaces:**
- Produces: `DelegationItemStatus` 类型 + `delegationItemStatusValues` const + `DelegationItemStatusSchema`，从 `@swarm/protocol` 导出

- [ ] **Step 1: 加类型定义**

在 `packages/protocol/src/types/task.ts` 的 `DelegationItemSchema`（L77）之前，照现有 `planStatusValues`（L66）模式加：

```ts
export const delegationItemStatusValues = [
  'pending',
  'running',
  'completed',
  'failed',
  'cancelled',
] as const
export const DelegationItemStatusSchema = z.enum(delegationItemStatusValues)
export type DelegationItemStatus = z.infer<typeof DelegationItemStatusSchema>
```

- [ ] **Step 2: 验证类型导出**

Run: `pnpm --filter @swarm/protocol exec tsc --noEmit`
Expected: 无错误。`DelegationItemStatus` 经 `packages/protocol/src/index.ts:23` 的 `export * from './types/task'` 自动导出。

- [ ] **Step 3: Commit**

```bash
git add packages/protocol/src/types/task.ts
git commit -m "feat(protocol): add DelegationItemStatus type for delegation plan state machine"
```

---

### Task 2: protocol 加 message.delegation_update 事件

**Files:**
- Modify: `packages/protocol/src/types/message.ts`（`MessageWireEvent` 联合，约 L30-60）
- Test: 无独立测试

**Interfaces:**
- Consumes: `DelegationItemStatus`（Task 1）、`Artifact`（task.ts:160）
- Produces: `message.delegation_update` 事件类型，是 `MessageWireEvent` 联合的新成员

- [ ] **Step 1: 加事件类型**

在 `packages/protocol/src/types/message.ts` 的 `message.delegation_plan`（L59）之后，加：

```ts
| (MessageEventBase & {
    kind: 'message.delegation_update'
    itemId: string
    status: DelegationItemStatus
    result: Artifact[]
  })
```

确保文件顶部已 import `DelegationItemStatus` 和 `Artifact`（若未 import，加 `import type { Artifact, DelegationItemStatus } from './task'`）。

- [ ] **Step 2: 验证类型**

Run: `pnpm --filter @swarm/protocol exec tsc --noEmit`
Expected: 无错误。

- [ ] **Step 3: Commit**

```bash
git add packages/protocol/src/types/message.ts
git commit -m "feat(protocol): add message.delegation_update wire event"
```

---

### Task 3: 前后端共用 delegation reducer

**Files:**
- Create: `packages/shared/src/messages/delegation-reducer.ts`
- Create: `packages/shared/src/messages/delegation-reducer.test.ts`

**Interfaces:**
- Consumes: `DelegationItem`、`DelegationItemStatus`、`Artifact`（from `@swarm/protocol`）、`message.delegation_plan` / `message.delegation_update` 事件类型
- Produces: `PlanItemState` 类型、`applyDelegationPlan(state, plan)` 函数、`applyDelegationUpdate(state, update)` 函数、`replayDelegationEvents(events)` 函数

- [ ] **Step 1: 写失败测试**

`packages/shared/src/messages/delegation-reducer.test.ts`:

```ts
import { describe, it, expect } from 'vitest'
import type { DelegationItem } from '@swarm/protocol'
import {
  applyDelegationPlan,
  applyDelegationUpdate,
  replayDelegationEvents,
  type PlanItemState,
} from './delegation-reducer'

const item = (id: string, deps: string[] = []): DelegationItem => ({
  id,
  prompt: `do ${id}`,
  dependsOn: deps,
})

describe('applyDelegationPlan', () => {
  it('resets state to plan items with pending status', () => {
    const state = applyDelegationPlan(undefined, [item('d1'), item('d2', ['d1'])])
    expect(state.size).toBe(2)
    expect(state.get('d1')).toEqual({
      id: 'd1', prompt: 'do d1', dependsOn: [],
      status: 'pending', result: [],
    })
    expect(state.get('d2')?.status).toBe('pending')
  })

  it('overwrites previous state entirely', () => {
    const prev = applyDelegationPlan(undefined, [item('d1')])
    const next = applyDelegationPlan(prev, [item('d2')])
    expect(next.has('d1')).toBe(false)
    expect(next.has('d2')).toBe(true)
  })
})

describe('applyDelegationUpdate', () => {
  it('updates status and overwrites result', () => {
    const state = applyDelegationPlan(undefined, [item('d1')])
    const s1 = applyDelegationUpdate(state, { itemId: 'd1', status: 'running', result: [] })
    expect(s1.get('d1')?.status).toBe('running')
    const s2 = applyDelegationUpdate(s1, { itemId: 'd1', status: 'completed', result: [{ kind: 'note', text: 'done' }] })
    expect(s2.get('d1')?.status).toBe('completed')
    expect(s2.get('d1')?.result).toEqual([{ kind: 'note', text: 'done' }])
  })

  it('second update overwrites first result (not append)', () => {
    const state = applyDelegationPlan(undefined, [item('d1')])
    const s1 = applyDelegationUpdate(state, { itemId: 'd1', status: 'running', result: [] })
    const s2 = applyDelegationUpdate(s1, { itemId: 'd1', status: 'completed', result: [{ kind: 'note', text: 'A' }] })
    const s3 = applyDelegationUpdate(s2, { itemId: 'd1', status: 'completed', result: [{ kind: 'note', text: 'B' }] })
    expect(s3.get('d1')?.result).toEqual([{ kind: 'note', text: 'B' }])
  })

  it('no-op for unknown itemId (temporary delegation)', () => {
    const state = applyDelegationPlan(undefined, [item('d1')])
    const next = applyDelegationUpdate(state, { itemId: 'unknown', status: 'completed', result: [] })
    expect(next).toBe(state)
  })
})

describe('replayDelegationEvents', () => {
  it('replays plan + update events in order', () => {
    const events = [
      { kind: 'message.delegation_plan' as const, plan: [item('d1'), item('d2')] },
      { kind: 'message.delegation_update' as const, itemId: 'd1', status: 'running' as const, result: [] },
      { kind: 'message.delegation_update' as const, itemId: 'd1', status: 'completed' as const, result: [{ kind: 'note' as const, text: 'done' }] },
    ]
    const state = replayDelegationEvents(events)
    expect(state.get('d1')?.status).toBe('completed')
    expect(state.get('d1')?.result).toEqual([{ kind: 'note', text: 'done' }])
    expect(state.get('d2')?.status).toBe('pending')
  })

  it('returns empty map for no delegation events', () => {
    const state = replayDelegationEvents([
      { kind: 'message.created' as const, prompt: 'hi' },
    ] as never)
    expect(state.size).toBe(0)
  })

  it('includes running state (in-flight replay)', () => {
    const events = [
      { kind: 'message.delegation_plan' as const, plan: [item('d1')] },
      { kind: 'message.delegation_update' as const, itemId: 'd1', status: 'running' as const, result: [] },
    ]
    const state = replayDelegationEvents(events)
    expect(state.get('d1')?.status).toBe('running')
  })
})
```

- [ ] **Step 2: 运行测试确认失败**

Run: `pnpm --filter @swarm/shared test -- delegation-reducer`
Expected: FAIL（模块不存在）

- [ ] **Step 3: 实现 reducer**

`packages/shared/src/messages/delegation-reducer.ts`:

```ts
import type { Artifact, DelegationItem, DelegationItemStatus } from '@swarm/protocol'

export type PlanItemState = DelegationItem & {
  status: DelegationItemStatus
  result: Artifact[]
}

/** A delegation_plan event replaces the entire plan state (full snapshot). */
export function applyDelegationPlan(
  prev: Map<string, PlanItemState> | undefined,
  plan: DelegationItem[]
): Map<string, PlanItemState> {
  const next = new Map<string, PlanItemState>()
  for (const it of plan) {
    next.set(it.id, { ...it, status: 'pending', result: [] })
  }
  return next
}

/** A delegation_update event merges one item: status overwrites, result overwrites (not append). */
export function applyDelegationUpdate(
  state: Map<string, PlanItemState>,
  update: { itemId: string; status: DelegationItemStatus; result: Artifact[] }
): Map<string, PlanItemState> {
  const item = state.get(update.itemId)
  if (!item) return state // unknown itemId = temporary delegation, no-op
  const next = new Map(state)
  next.set(update.itemId, { ...item, status: update.status, result: update.result })
  return next
}

/** Replay a sorted event stream to rebuild planState (lazy-load / crash recovery). */
export function replayDelegationEvents(
  events: Array<{ kind: string; [k: string]: unknown }>
): Map<string, PlanItemState> {
  let state: Map<string, PlanItemState> | undefined
  for (const e of events) {
    if (e.kind === 'message.delegation_plan') {
      state = applyDelegationPlan(state, e.plan as DelegationItem[])
    } else if (e.kind === 'message.delegation_update') {
      if (!state) state = new Map()
      state = applyDelegationUpdate(state, {
        itemId: e.itemId as string,
        status: e.status as DelegationItemStatus,
        result: e.result as Artifact[],
      })
    }
  }
  return state ?? new Map()
}
```

- [ ] **Step 4: 运行测试确认通过**

Run: `pnpm --filter @swarm/shared test -- delegation-reducer`
Expected: PASS（全部测试通过）

- [ ] **Step 5: Commit**

```bash
git add packages/shared/src/messages/delegation-reducer.ts packages/shared/src/messages/delegation-reducer.test.ts
git commit -m "feat(shared): add delegation reducer with event-replay support"
```

---

### Task 4: report_result 工具

**Files:**
- Create: `apps/desktop/src/service/tools/report-result.ts`
- Create: `apps/desktop/src/service/tools/report-result.test.ts`
- Modify: `apps/desktop/src/service/tools/registry.ts`（ToolRunContext 加 `reportResult`）
- Modify: `apps/desktop/src/service/tools/builtins.ts`（注册）

**Interfaces:**
- Consumes: `Artifact`（from `@swarm/protocol`）、`ToolRunContext`（from `./registry`）
- Produces: `reportResultSpec()` 工厂，`ToolRunContext.reportResult?: (artifacts: Artifact[]) => void`

- [ ] **Step 1: registry.ts 加 reportResult sink**

在 `apps/desktop/src/service/tools/registry.ts` 的 `ToolRunContext` 接口（L21-71），在 `setDelegationPlan?`（L70）附近加：

```ts
  /** Per-run sink: child agent submits structured results (artifacts). Collected by launch. */
  reportResult?: (artifacts: Artifact[]) => void
```

确保 `Artifact` 已 import（`import type { Artifact } from '@swarm/protocol'`）。

- [ ] **Step 2: 写失败测试**

`apps/desktop/src/service/tools/report-result.test.ts`:

```ts
import { describe, it, expect, vi } from 'vitest'
import type { ToolRunContext } from './registry'
import { reportResultSpec } from './report-result'

const ctx = (overrides: Partial<ToolRunContext> = {}): ToolRunContext =>
  ({ sessionId: 's', reportResult: vi.fn() } as unknown as ToolRunContext)

describe('report_result tool', () => {
  it('calls ctx.reportResult with artifacts', async () => {
    const c = ctx()
    const tool = reportResultSpec().build(c)
    const res = (await tool.execute('call1', {
      artifacts: [{ kind: 'note', text: 'result text' }],
    })) as { details: { artifacts: unknown[] } }
    expect(c.reportResult).toHaveBeenCalledWith([{ kind: 'note', text: 'result text' }])
    expect(res.details.artifacts).toHaveLength(1)
  })

  it('works with empty artifacts array', async () => {
    const c = ctx()
    const tool = reportResultSpec().build(c)
    await tool.execute('call2', { artifacts: [] })
    expect(c.reportResult).toHaveBeenCalledWith([])
  })

  it('returns error when reportResult not available', async () => {
    const c = { sessionId: 's' } as unknown as ToolRunContext
    const tool = reportResultSpec().build(c)
    const res = (await tool.execute('call3', { artifacts: [] })) as { details: { error?: string } }
    expect(res.details.error).toBeTruthy()
  })
})
```

- [ ] **Step 3: 运行测试确认失败**

Run: `pnpm --filter @swarm/desktop test -- report-result`
Expected: FAIL（模块不存在）

- [ ] **Step 4: 实现 report_result 工具**

`apps/desktop/src/service/tools/report-result.ts`:

```ts
import type { AgentTool } from '@earendil-works/pi-agent-core'
import { Type } from '@earendil-works/pi-ai'

import type { ToolRunContext, ToolSpec } from './registry'

const Params = Type.Object({
  artifacts: Type.Array(
    Type.Object({
      kind: Type.Enum({ file: 'file', note: 'note', image: 'image' }),
      path: Type.Optional(Type.String()),
      text: Type.Optional(Type.String()),
      meta: Type.Optional(Type.Record(Type.String(), Type.Unknown())),
    }),
    { description: 'Structured results from this run — files produced, notes, images, etc.' }
  ),
})

export function reportResultSpec(): ToolSpec {
  return {
    group: 'agent',
    name: 'report_result',
    risk: 'low',
    source: 'builtin',
    build: (ctx: ToolRunContext): AgentTool => ({
      name: 'report_result',
      label: 'Report Result',
      description:
        'Submit structured results (artifacts) from this run to the parent. Call this when the task is done, in addition to writing a summary. Artifacts complement your text summary with machine-readable outputs.',
      parameters: Params,
      execute: async (_toolCallId: string, params: unknown) => {
        const p = params as { artifacts: Array<{ kind: string; path?: string; text?: string; meta?: Record<string, unknown> }> }
        if (!ctx.reportResult) {
          return {
            content: [{ type: 'text' as const, text: 'report_result is not available in this context.' }],
            details: { error: 'not_wired' },
          }
        }
        ctx.reportResult(p.artifacts)
        return {
          content: [{ type: 'text' as const, text: `Reported ${p.artifacts.length} artifact(s).` }],
          details: { artifacts: p.artifacts },
        }
      },
    }),
  }
}
```

- [ ] **Step 5: 运行测试确认通过**

Run: `pnpm --filter @swarm/desktop test -- report-result`
Expected: PASS

- [ ] **Step 6: 注册到 builtins.ts**

在 `apps/desktop/src/service/tools/builtins.ts`，import 并注册（照 `delegationPlanSpec` 模式，在 L77 附近 `registry.register(delegationPlanSpec())` 之后）：

```ts
import { reportResultSpec } from './report-result'
// ...在 registerBuiltinTools 内：
registry.register(reportResultSpec())
```

- [ ] **Step 7: Commit**

```bash
git add apps/desktop/src/service/tools/report-result.ts apps/desktop/src/service/tools/report-result.test.ts apps/desktop/src/service/tools/registry.ts apps/desktop/src/service/tools/builtins.ts
git commit -m "feat(tools): add report_result tool for structured child results"
```

---

### Task 5: EngineRunResult 加 artifacts + launch sink 收集

**Files:**
- Modify: `apps/desktop/src/service/message-engine/engine.ts`（L53-58）
- Modify: `apps/desktop/src/service/message-engine/launch.ts`（L194-221 ctx、L249-251 返回值）

**Interfaces:**
- Consumes: `Artifact`（from `@swarm/protocol`）
- Produces: `EngineRunResult.artifacts: Artifact[]`、launchMessage 返回值含 artifacts

- [ ] **Step 1: engine.ts 加 artifacts 字段**

在 `apps/desktop/src/service/message-engine/engine.ts` 的 `EngineRunResult`（L53-58）：

```ts
export type EngineRunResult = {
  status: 'completed' | 'failed' | 'cancelled'
  summary: string
  messages: AgentMessage[]
  used: ConsumedResources
  artifacts: Artifact[]
}
```

确保 `Artifact` 已 import。`terminal()` 函数（L287-295）的返回对象加 `artifacts: []`（engine 自身不收集 artifacts，由 launch sink 填充并覆盖）。`cancelledResult`（L93-99）也加 `artifacts: []`。

- [ ] **Step 2: launch.ts 加 sink + 填充返回值**

在 `apps/desktop/src/service/message-engine/launch.ts`：

L193 附近（`usageSink` 声明旁），加收集数组：
```ts
const collectedArtifacts: Artifact[] = []
```

L194-221 的 ctx 对象，在 `setDelegationPlan`（L213）附近加：
```ts
reportResult: (artifacts) => {
  collectedArtifacts.push(...artifacts)
},
```

L249-251 返回值，附加 artifacts：
```ts
const r = await engine.run(spec.prompt, images.length > 0 ? images : undefined)
runLog.info({ msg: 'run finished', status: r.status, summaryLen: r.summary.length })
return { messageId, ...r, artifacts: collectedArtifacts }
```

确保 `Artifact` 已 import。

- [ ] **Step 3: 验证类型**

Run: `pnpm --filter @swarm/desktop run typecheck:node`
Expected: 无错误。

- [ ] **Step 4: Commit**

```bash
git add apps/desktop/src/service/message-engine/engine.ts apps/desktop/src/service/message-engine/launch.ts
git commit -m "feat(engine): add artifacts sink to EngineRunResult and launch ctx"
```

---

### Task 6: launch 自动注入 report_result 到 child run

**Files:**
- Modify: `apps/desktop/src/service/message-engine/launch.ts`（L222 `toolRegistry.resolve` 之后）

**Interfaces:**
- Consumes: `reportResultSpec`（from `../tools/report-result`）、`toolRegistry.resolve` 返回的 tools 数组
- Produces: `kind: 'child'` 的 run 总是带 report_result 工具

- [ ] **Step 1: 加自动注入逻辑**

在 `apps/desktop/src/service/message-engine/launch.ts` L222 `const { tools, riskOf } = ports.toolRegistry.resolve(spec.tools ?? [], ctx)` 之后，加：

```ts
// report_result is runtime infrastructure for child runs — always injected,
// bypassing the allowlist. It's how children submit structured results.
const toolsWithReport = spec.kind === 'child'
  ? [...tools, reportResultSpec().build(ctx)]
  : tools
```

然后把 L225 `createEngine({ ... tools, ... })` 改为 `tools: toolsWithReport`。

文件顶部 import：`import { reportResultSpec } from '../tools/report-result'`

- [ ] **Step 2: 验证类型**

Run: `pnpm --filter @swarm/desktop run typecheck:node`
Expected: 无错误。

- [ ] **Step 3: Commit**

```bash
git add apps/desktop/src/service/message-engine/launch.ts
git commit -m "feat(launch): auto-inject report_result tool into child runs"
```

---

### Task 7: session-service planState + 懒加载重放 + 回调注入

这是项 ① 的核心任务——planState 上移到 session 级。

**Files:**
- Modify: `apps/desktop/src/service/session/session-service.ts`（闭包加 planStates、加 ensurePlanState 重放、basePorts / delegate / runWork 传回调、delegate/createTask 透传 artifacts）
- Modify: `apps/desktop/src/service/message-engine/launch.ts`（MessageSpec 加 onDelegationUpdate、ctx.mergeDelegationResult 桥接回调）
- Modify: `apps/desktop/src/service/tools/registry.ts`（ToolRunContext 加 mergeDelegationResult）

**Interfaces:**
- Consumes: `replayDelegationEvents`、`applyDelegationPlan`、`applyDelegationUpdate`（from `@swarm/shared`）、`DelegationItemStatus`、`Artifact`、`getMessageEvents`（store）
- Produces: `MessageSpec.onDelegationUpdate?` 回调、`ToolRunContext.mergeDelegationResult?` 方法、session-service 闭包 `planStates` Map

- [ ] **Step 1: registry.ts 加 mergeDelegationResult**

在 `apps/desktop/src/service/tools/registry.ts` 的 `ToolRunContext`（L21-71），`reportResult` 附近加：

```ts
  /** Merge a delegation item's result into session-level planState. */
  mergeDelegationResult?: (
    itemId: string,
    delta: { status: DelegationItemStatus; artifacts: Artifact[] }
  ) => void
```

确保 `DelegationItemStatus` import（`import type { Artifact, DelegationItemStatus } from '@swarm/protocol'`）。

- [ ] **Step 2: launch.ts MessageSpec 加 onDelegationUpdate + ctx 桥接**

在 `apps/desktop/src/service/message-engine/launch.ts`：

L51 `MessageSpec`，`onDelegationPlan` 附近加：
```ts
  onDelegationUpdate?: (itemId: string, delta: { status: DelegationItemStatus; artifacts: Artifact[] }) => void
```

L194-221 ctx 对象，`setDelegationPlan`（L213）改为同时操作回调，并加 `mergeDelegationResult`：

```ts
setDelegationPlan: (plan) => {
  emit({ kind: 'message.delegation_plan', plan })
  spec.onDelegationPlan?.(plan)
},
mergeDelegationResult: (itemId, delta) => {
  emit({ kind: 'message.delegation_update', itemId, status: delta.status, result: delta.artifacts })
  spec.onDelegationUpdate?.(itemId, delta)
},
```

注意：`mergeDelegationResult` 这里只做 emit + 回调——**planState 的实际存储在 session-service 闭包**，经 `spec.onDelegationUpdate` 回调操作。launch 不持有 planState。

确保 `DelegationItemStatus` import。

- [ ] **Step 3: session-service 加 planStates + ensurePlanState + 回调注入**

在 `apps/desktop/src/service/session/session-service.ts` 的 `createSessionService` 闭包内（`sessions` Map、`turnQueues` 附近，约 L300），加：

```ts
import { applyDelegationPlan, applyDelegationUpdate, replayDelegationEvents, type PlanItemState } from '@swarm/shared'
import type { DelegationItemStatus, Artifact } from '@swarm/protocol'

// session-level planState (event-replay derived cache)
const planStates = new Map<string, Map<string, PlanItemState>>()

/** Lazy-load: replay delegation events from store on first access. */
const ensurePlanState = (sessionId: string): Map<string, PlanItemState> => {
  let state = planStates.get(sessionId)
  if (state) return state
  const events = store.getMessageEvents(sessionId).map((r) => r.event)
  state = replayDelegationEvents(events as Array<{ kind: string; [k: string]: unknown }>)
  planStates.set(sessionId, state)
  return state
}

const setDelegationPlanForSession = (sessionId: string, plan: DelegationItem[]) => {
  const state = applyDelegationPlan(planStates.get(sessionId), plan)
  planStates.set(sessionId, state)
}

const mergeDelegationResultForSession = (
  sessionId: string,
  itemId: string,
  delta: { status: DelegationItemStatus; artifacts: Artifact[] }
) => {
  const state = ensurePlanState(sessionId)
  const next = applyDelegationUpdate(state, { itemId, ...delta })
  planStates.set(sessionId, next)
}
```

- [ ] **Step 4: delegate / runWork / turn 传 onDelegationPlan + onDelegationUpdate 回调**

`delegate` 函数（L368-406）的 `launchMessage({ ... })` spec，加：
```ts
onDelegationPlan: (plan) => setDelegationPlanForSession(session.id, plan),
onDelegationUpdate: (itemId, delta) => mergeDelegationResultForSession(session.id, itemId, delta),
```

`runWork` 函数（约 L425-442）和 `submitPrompt`/turn 路径（约 L560-593）的 `launchMessage` spec 同样加上面两个回调。

- [ ] **Step 5: delegate / createTask 透传 artifacts**

`delegate` 函数返回（L405）：
```ts
return { messageId: r.messageId, status: r.status, summary: r.summary, artifacts: r.artifacts ?? [] }
```

`basePorts` 的 `createTask`（L351-357）：
```ts
createTask: (prompt, agentType) =>
  runWork(session.id, prompt, agentType ? { agentType } : {}).then((r) => ({
    messageId: r.messageId,
    status: r.status,
    summary: r.summary,
    artifacts: r.artifacts ?? [],
  })),
```

（原来是 `artifacts: []` 写死，改为 `r.artifacts ?? []`）

- [ ] **Step 6: 验证类型**

Run: `pnpm --filter @swarm/desktop run typecheck:node`
Expected: 无错误。

- [ ] **Step 7: Commit**

```bash
git add apps/desktop/src/service/session/session-service.ts apps/desktop/src/service/message-engine/launch.ts apps/desktop/src/service/tools/registry.ts
git commit -m "feat(session): session-level planState with event-replay + delegation callbacks"
```

---

### Task 8: delegate 工具加 itemId + 三处 merge

**Files:**
- Modify: `apps/desktop/src/service/tools/delegate.ts`（DelegateParams 加 itemId、execute 三处 merge）
- Modify: `apps/desktop/src/service/tools/delegate.test.ts`（测 itemId + 异常路径）

**Interfaces:**
- Consumes: `ctx.mergeDelegationResult`（Task 7）、`ctx.spawnChild` / `ctx.createTask`（现有）
- Produces: delegate 工具支持可选 `itemId` 参数

- [ ] **Step 1: 写失败测试**

在 `apps/desktop/src/service/tools/delegate.test.ts` 加（保留现有测试）：

```ts
it('calls mergeDelegationResult with running then completed when itemId provided', async () => {
  const mergeDelegationResult = vi.fn()
  const spawnChild = vi.fn().mockResolvedValue({ messageId: 'm1', status: 'completed', summary: 'ok', artifacts: [{ kind: 'note', text: 'result' }] })
  const c = { sessionId: 's', spawnChild, mergeDelegationResult } as unknown as ToolRunContext
  const tool = delegateSpec().build(c)
  await tool.execute('call1', { prompt: 'do task', itemId: 'd1' })
  expect(mergeDelegationResult).toHaveBeenNthCalledWith(1, 'd1', { status: 'running', artifacts: [] })
  expect(mergeDelegationResult).toHaveBeenNthCalledWith(2, 'd1', { status: 'completed', artifacts: [{ kind: 'note', text: 'result' }] })
})

it('calls mergeDelegationResult with failed on spawnChild throw', async () => {
  const mergeDelegationResult = vi.fn()
  const spawnChild = vi.fn().mockRejectedValue(new Error('slot exhausted'))
  const c = { sessionId: 's', spawnChild, mergeDelegationResult } as unknown as ToolRunContext
  const tool = delegateSpec().build(c)
  await expect(tool.execute('call1', { prompt: 'do task', itemId: 'd1' })).rejects.toThrow('slot exhausted')
  expect(mergeDelegationResult).toHaveBeenNthCalledWith(2, 'd1', { status: 'failed', artifacts: [] })
})

it('does not call mergeDelegationResult when no itemId', async () => {
  const mergeDelegationResult = vi.fn()
  const spawnChild = vi.fn().mockResolvedValue({ messageId: 'm1', status: 'completed', summary: 'ok', artifacts: [] })
  const c = { sessionId: 's', spawnChild, mergeDelegationResult } as unknown as ToolRunContext
  const tool = delegateSpec().build(c)
  await tool.execute('call1', { prompt: 'do task' })
  expect(mergeDelegationResult).not.toHaveBeenCalled()
})
```

- [ ] **Step 2: 运行测试确认失败**

Run: `pnpm --filter @swarm/desktop test -- delegate`
Expected: FAIL（itemId 参数不存在 / mergeDelegationResult 未调用）

- [ ] **Step 3: 实现 itemId + 三处 merge**

`apps/desktop/src/service/tools/delegate.ts`：

DelegateParams（L7-24）加：
```ts
itemId: Type.Optional(
  Type.String({
    description:
      'If this delegate call corresponds to a plan item (from set_delegation_plan), pass its id (e.g. "d1") so the result is merged into the plan state.',
  })
),
```

execute 函数（L48-78），`const p = params as { ... }` 类型加 `itemId?: string`。

child 分支（L66-77），改为：

```ts
if (!ctx.spawnChild) {
  return {
    content: [{ type: 'text' as const, text: 'delegate is not available in this context.' }],
    details: { error: 'not_wired' },
  }
}
if (p.itemId) ctx.mergeDelegationResult?.(p.itemId, { status: 'running', artifacts: [] })
try {
  const { messageId, status, summary, artifacts } = await ctx.spawnChild(p.prompt, {
    suggestedTools: p.suggestedTools,
    providerKey: p.providerKey,
    agentType: p.agentType,
  })
  if (p.itemId) ctx.mergeDelegationResult?.(p.itemId, { status, artifacts: artifacts ?? [] })
  return delegateResult(messageId, status, summary)
} catch (err) {
  if (p.itemId) ctx.mergeDelegationResult?.(p.itemId, { status: 'failed', artifacts: [] })
  throw err
}
```

topLevel 分支（L56-64）同样加 itemId 三处 merge（用 `ctx.createTask` 返回的 artifacts）。

- [ ] **Step 4: 运行测试确认通过**

Run: `pnpm --filter @swarm/desktop test -- delegate`
Expected: PASS（全部测试通过）

- [ ] **Step 5: Commit**

```bash
git add apps/desktop/src/service/tools/delegate.ts apps/desktop/src/service/tools/delegate.test.ts
git commit -m "feat(delegate): add itemId param with running/terminal/failed merge states"
```

---

### Task 9: prompt.ts 加 report_result 引导

**Files:**
- Modify: `apps/desktop/src/service/agents/prompt.ts`（L7-12 section 模板）
- Modify: `apps/desktop/src/service/agents/prompt.test.ts`

**Interfaces:**
- Consumes: 现有 prompt 结构
- Produces: 子 agent prompt 含 report_result 引导

- [ ] **Step 1: 写失败测试**

在 `apps/desktop/src/service/agents/prompt.test.ts` 加：

```ts
it('mentions report_result in delegation instructions', () => {
  const result = withAgentTypes('base', [])
  expect(result).toContain('report_result')
})
```

- [ ] **Step 2: 运行测试确认失败**

Run: `pnpm --filter @swarm/desktop test -- prompt`
Expected: FAIL

- [ ] **Step 3: 加引导文案**

在 `apps/desktop/src/service/agents/prompt.ts` 的 `section` 模板字符串（L7-12），现有 delegation 指令后加一句：

```
When you complete a delegated sub-task, call `report_result` to submit structured results (artifacts) — not just a text summary.
```

- [ ] **Step 4: 运行测试确认通过**

Run: `pnpm --filter @swarm/desktop test -- prompt`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add apps/desktop/src/service/agents/prompt.ts apps/desktop/src/service/agents/prompt.test.ts
git commit -m "feat(prompt): guide child agents to call report_result for structured results"
```

---

### Task 10: apply-event.ts 加 delegation 事件处理 + MessageRecord 字段

**Files:**
- Modify: `packages/shared/src/messages/apply-event.ts`（MessageRecord 加字段、switch 加 case）
- Modify: `packages/shared/src/messages/apply-event.test.ts`（若存在，否则新建测试片段）

**Interfaces:**
- Consumes: `message.delegation_plan`（已存在）、`message.delegation_update`（Task 2）、`DelegationItem`、`Artifact`、`PlanItemState`
- Produces: `MessageRecord.delegationPlan?: DelegationItem[]`、`MessageRecord.delegationUpdates?: Array<{ itemId, status, result }>`

- [ ] **Step 1: MessageRecord 加字段**

在 `packages/shared/src/messages/apply-event.ts` 的 `MessageRecord`（L5-22），`plan?` 附近加：

```ts
  delegationPlan?: import('@swarm/protocol').DelegationItem[]
  delegationUpdates?: Array<{
    itemId: string
    status: import('@swarm/protocol').DelegationItemStatus
    result: import('@swarm/protocol').Artifact[]
  }>
```

- [ ] **Step 2: switch 加 case**

在 `applyEvent` 的 switch（L85-122），`message.plan`（L101-103）附近加：

```ts
case 'message.delegation_plan':
  updated = { ...updated, delegationPlan: e.plan }
  break
case 'message.delegation_update':
  updated = {
    ...updated,
    delegationUpdates: [...(updated.delegationUpdates ?? []), { itemId: e.itemId, status: e.status, result: e.result }],
  }
  break
```

- [ ] **Step 3: 写测试**

在 `packages/shared/src/messages/apply-event.test.ts`（若不存在则新建）加：

```ts
import { describe, it, expect } from 'vitest'
import { applyEvent } from './apply-event'
import type { MessageRecord } from './apply-event'

const baseRecord = (id = 'm1'): MessageRecord => ({
  id, sessionId: 's', prompt: 'hi', status: 'running', summary: null,
  createdAt: 0, attachments: [], order: 0, events: [],
})

describe('applyEvent delegation', () => {
  it('message.delegation_plan sets delegationPlan', () => {
    const rec = baseRecord()
    const result = applyEvent([rec], { ...baseEvent(rec.id), kind: 'message.delegation_plan', plan: [{ id: 'd1', prompt: 'x', dependsOn: [] }] })
    expect(result[0].delegationPlan).toEqual([{ id: 'd1', prompt: 'x', dependsOn: [] }])
  })

  it('message.delegation_update appends to delegationUpdates', () => {
    const rec = baseRecord()
    const e1 = applyEvent([rec], { ...baseEvent(rec.id), kind: 'message.delegation_update', itemId: 'd1', status: 'running', result: [] })
    const e2 = applyEvent(e1, { ...baseEvent(rec.id), kind: 'message.delegation_update', itemId: 'd1', status: 'completed', result: [{ kind: 'note', text: 'done' }] })
    expect(e2[0].delegationUpdates).toHaveLength(2)
    expect(e2[0].delegationUpdates?.[1].status).toBe('completed')
  })
})

function baseEvent(messageId: string) {
  return { sessionId: 's', messageId, seq: 0, ts: 0 }
}
```

- [ ] **Step 4: 运行测试确认通过**

Run: `pnpm --filter @swarm/shared test -- apply-event`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add packages/shared/src/messages/apply-event.ts packages/shared/src/messages/apply-event.test.ts
git commit -m "feat(shared): apply delegation_plan and delegation_update in apply-event"
```

---

### Task 11: useDelegationPlan hook

**Files:**
- Create: `apps/desktop/src/renderer/src/hooks/use-delegation-plan.ts`

**Interfaces:**
- Consumes: `useMessages`（from `./use-messages`）、`MessageRecord.delegationPlan` / `delegationUpdates`（Task 10）
- Produces: `useDelegationPlan()` hook，返回 `{ plan: PlanItemState[] | null }`

- [ ] **Step 1: 实现 hook**

`apps/desktop/src/renderer/src/hooks/use-delegation-plan.ts`:

```ts
import { useMemo } from 'react'
import { useMessages } from './use-messages'
import { applyDelegationUpdate, applyDelegationPlan, type PlanItemState } from '@swarm/shared'
import type { DelegationItem } from '@swarm/protocol'

/**
 * Derive the session-level delegation plan state from the message cache.
 * planState is event-replay derived: start from the last delegation_plan,
 * then apply all delegation_updates chronologically.
 */
export function useDelegationPlan(): Map<string, PlanItemState> | null {
  const messages = useMessages()

  return useMemo(() => {
    // Find the last message carrying a delegation_plan
    let planItems: DelegationItem[] | null = null
    let planMessageId: string | null = null
    for (const m of messages) {
      if (m.delegationPlan && m.delegationPlan.length > 0) {
        planItems = m.delegationPlan
        planMessageId = m.id
      }
    }
    if (!planItems || !planMessageId) return null

    let state = applyDelegationPlan(undefined, planItems)
    // Apply all delegation_updates from the plan message onward
    for (const m of messages) {
      if (m.delegationUpdates) {
        for (const u of m.delegationUpdates) {
          state = applyDelegationUpdate(state, u)
        }
      }
    }
    return state
  }, [messages])
}
```

- [ ] **Step 2: 验证类型**

Run: `pnpm --filter @swarm/desktop run typecheck:web`
Expected: 无错误。

- [ ] **Step 3: Commit**

```bash
git add apps/desktop/src/renderer/src/hooks/use-delegation-plan.ts
git commit -m "feat(renderer): add useDelegationPlan hook deriving plan state from message cache"
```

---

### Task 12: 项 ① 集成验证

**Files:**
- 无新文件，运行现有测试 + 手动验证

- [ ] **Step 1: 全量 typecheck**

Run: `pnpm turbo run typecheck`
Expected: 全部通过。

- [ ] **Step 2: 全量测试**

Run: `pnpm turbo run test`
Expected: 全部通过。

- [ ] **Step 3: 验收项 ① checklist**

对照 spec §7 项 ① 验收标准确认：
- [ ] 子 agent 调 report_result 后，父 agent 在 tool_result.details.artifacts 读到（delegate.test.ts 覆盖）
- [ ] delegation_update 在派出/返回各 emit 一次（delegate.test.ts 覆盖）
- [ ] 异常时 emit failed（delegate.test.ts 覆盖）
- [ ] 多轮 plan 跨 turn：planStates 在 session-service 闭包，跨 launchMessage 存活（结构保证）
- [ ] 不调 report_result 时行为不变（sink 为空，artifacts=[]）
- [ ] 不传 itemId 时不碰 planState（delegate.test.ts 覆盖）

- [ ] **Step 4: Commit（若有 fix）**

```bash
git add -A
git commit -m "fix: integration fixes for delegation state pipeline"
```

---

## 项 ③：编排可视化

### Task 13: OrchestrationGraph + 节点组件

**Files:**
- Create: `apps/desktop/src/renderer/src/components/orchestration/OrchestrationGraph.tsx`
- Create: `apps/desktop/src/renderer/src/components/orchestration/PlanItemNode.tsx`
- Create: `apps/desktop/src/renderer/src/components/orchestration/RunNode.tsx`

**Interfaces:**
- Consumes: `useDelegationPlan`（Task 11）、`useMessages`、`@xyflow/react`
- Produces: `<OrchestrationGraph />` 组件，渲染 plan-item + run 节点 + 边

- [ ] **Step 1: PlanItemNode 组件**

`apps/desktop/src/renderer/src/components/orchestration/PlanItemNode.tsx`:

```tsx
import { Handle, Position } from '@xyflow/react'
import type { PlanItemState } from '@swarm/shared'

const statusColors: Record<string, string> = {
  pending: 'bg-gray-200 border-gray-400',
  running: 'bg-blue-100 border-blue-500',
  completed: 'bg-green-100 border-green-500',
  failed: 'bg-red-100 border-red-500',
  cancelled: 'bg-gray-100 border-gray-300',
}

export function PlanItemNode({ data }: { data: { item: PlanItemState } }) {
  const { item } = data
  const color = statusColors[item.status] ?? statusColors.pending
  return (
    <div className={`rounded-md border-2 px-3 py-2 ${color}`}>
      <Handle type="target" position={Position.Top} />
      <div className="text-xs font-mono text-gray-500">{item.id}</div>
      <div className="text-sm font-medium line-clamp-2">{item.prompt}</div>
      <div className="text-xs text-gray-500 mt-1">{item.status}</div>
      <Handle type="source" position={Position.Bottom} />
    </div>
  )
}
```

- [ ] **Step 2: RunNode 组件**

`apps/desktop/src/renderer/src/components/orchestration/RunNode.tsx`:

```tsx
import { Handle, Position } from '@xyflow/react'

export type RunNodeData = {
  messageId: string
  summary: string
  agentType?: string
  parentMessageId?: string
}

export function RunNode({ data }: { data: RunNodeData }) {
  return (
    <div className="rounded-lg border border-indigo-300 bg-indigo-50 px-3 py-2">
      <Handle type="target" position={Position.Top} />
      <div className="text-xs font-mono text-indigo-400">{data.agentType ?? 'default'}</div>
      <div className="text-sm line-clamp-2">{data.summary || '(no summary)'}</div>
      <Handle type="source" position={Position.Bottom} />
    </div>
  )
}
```

- [ ] **Step 3: OrchestrationGraph 主组件**

`apps/desktop/src/renderer/src/components/orchestration/OrchestrationGraph.tsx`:

```tsx
import { useMemo } from 'react'
import { ReactFlow, Background, Controls, type Node, type Edge } from '@xyflow/react'
import '@xyflow/react/dist/style.css'

import { useDelegationPlan } from '../../hooks/use-delegation-plan'
import { useMessages } from '../../hooks/use-messages'
import { PlanItemNode } from './PlanItemNode'
import { RunNode, type RunNodeData } from './RunNode'

const nodeTypes = { planItem: PlanItemNode, run: RunNode }

export function OrchestrationGraph() {
  const planState = useDelegationPlan()
  const messages = useMessages()

  const { nodes, edges } = useMemo(() => {
    if (!planState) return { nodes: [], edges: [] }

    const nodes: Node[] = []
    const edges: Edge[] = []

    // plan-item nodes (top row)
    const planItems = [...planState.values()]
    planItems.forEach((item, i) => {
      nodes.push({
        id: `plan-${item.id}`,
        type: 'planItem',
        position: { x: i * 200, y: 0 },
        data: { item },
      })
      // dependsOn edges
      for (const dep of item.dependsOn) {
        edges.push({ id: `dep-${dep}-${item.id}`, source: `plan-${dep}`, target: `plan-${item.id}`, animated: true })
      }
    })

    // run nodes (bottom row) — messages with parentMessageId form the delegation tree
    const runMessages = messages.filter((m) => m.parentMessageId)
    runMessages.forEach((m, i) => {
      const runData: RunNodeData = {
        messageId: m.id,
        summary: m.summary ?? '',
        agentType: m.agentDefId,
        parentMessageId: m.parentMessageId,
      }
      nodes.push({
        id: `run-${m.id}`,
        type: 'run',
        position: { x: i * 200, y: 250 },
        data: runData,
      })
      // parent→child edge
      edges.push({ id: `pc-${m.parentMessageId}-${m.id}`, source: `run-${m.parentMessageId}`, target: `run-${m.id}` })
    })

    // TODO: item→run edges via tool.call.args.itemId (requires reading message.progress events)
    // This is a follow-up refinement; initial version shows plan DAG + run tree separately.

    return { nodes, edges }
  }, [planState, messages])

  if (!planState || planState.size === 0) return null

  return (
    <div className="h-[400px] w-full border rounded-lg bg-white">
      <ReactFlow nodes={nodes} edges={edges} nodeTypes={nodeTypes} fitView>
        <Background />
        <Controls />
      </ReactFlow>
    </div>
  )
}
```

- [ ] **Step 4: 验证类型**

Run: `pnpm --filter @swarm/desktop run typecheck:web`
Expected: 无错误。

- [ ] **Step 5: Commit**

```bash
git add apps/desktop/src/renderer/src/components/orchestration/
git commit -m "feat(renderer): add OrchestrationGraph with plan-item and run nodes"
```

---

### Task 14: tasks-view 加编排图面板入口

**Files:**
- Modify: `apps/desktop/src/renderer/src/components/views/tasks-view.tsx`

**Interfaces:**
- Consumes: `OrchestrationGraph`（Task 13）、`useDelegationPlan`（判断是否显示）

- [ ] **Step 1: 加面板入口**

在 `apps/desktop/src/renderer/src/components/views/tasks-view.tsx`，import 并在有 delegation plan 时显示编排图面板：

```tsx
import { OrchestrationGraph } from '../orchestration/OrchestrationGraph'
import { useDelegationPlan } from '../../hooks/use-delegation-plan'
```

在视图布局中（对话区上方或侧边），加条件渲染：

```tsx
const planState = useDelegationPlan()
// ...在 JSX 中：
{planState && planState.size > 0 && (
  <div className="border-b p-3">
    <div className="mb-2 text-xs font-medium text-gray-500">Orchestration</div>
    <OrchestrationGraph />
  </div>
)}
```

具体插入位置取决于 tasks-view 现有布局结构——放在对话列表上方、session header 下方。

- [ ] **Step 2: 验证类型 + 手动验证**

Run: `pnpm --filter @swarm/desktop run typecheck:web`
Expected: 无错误。

启动 app，在一个有 delegation plan 的 session 里确认编排图面板可见；普通对话不显示。

- [ ] **Step 3: Commit**

```bash
git add apps/desktop/src/renderer/src/components/views/tasks-view.tsx
git commit -m "feat(renderer): add orchestration graph panel to tasks-view"
```

---

## 项 ②：Checkpoint Fork

### Task 15: forkToNewSession 核心方法

**Files:**
- Modify: `apps/desktop/src/service/session/session-service.ts`

**Interfaces:**
- Consumes: `createSession`、`launchMessage`、`store.getMessageEvents`、`SessionState`
- Produces: `service.forkToNewSession(sourceSessionId, forkPointMessageId, newPrompt, opts?)` 方法

- [ ] **Step 1: 实现 forkToNewSession**

在 `apps/desktop/src/service/session/session-service.ts` 的 service 对象（导出方法区域），加：

```ts
forkToNewSession: (
  sourceSessionId: string,
  forkPointMessageId: string,
  newPrompt: string,
  opts?: { agentType?: string }
): { sessionId: string; messageId: string } => {
  // 1. Read source session's transcript, slice to fork point
  const sourceSession = sessions.get(sourceSessionId)
  if (!sourceSession) throw new Error(`session not found: ${sourceSessionId}`)
  const events = store.getMessageEvents(sourceSessionId)
  // Collect messages up to and including forkPointMessageId (terminal boundary)
  const slicedEvents = []
  for (const row of events) {
    slicedEvents.push(row)
    if (row.messageId === forkPointMessageId) break
  }
  // Reconstruct AgentMessage[] history from the sliced events
  const history = reconstructHistoryFromEvents(slicedEvents)

  // 2. Create new session with source provider
  const { sessionId } = createSession(sourceSession.provider)
  const newSession = sessions.get(sessionId)!

  // 3. Launch work run with sliced history as prior context
  const def = (opts?.agentType ? cfg.agentStore?.get(opts.agentType) : undefined) ?? DEFAULT_AGENT_DEF
  log.info({ msg: 'session forked', sourceSessionId, forkPointMessageId, newSessionId: sessionId })

  runWork(sessionId, newPrompt, { agentType: opts?.agentType }).then((r) => {
    // history is passed via launchMessage spec — see runWork modification below
  })

  return { sessionId, messageId: '' } // messageId filled after launch
}
```

注意：`reconstructHistoryFromEvents` 需要从 `message.progress` 事件里的 `TaskEvent.llm.message` 重建 `AgentMessage[]`。这是一个辅助函数——检查代码库是否已有类似工具（`translator.ts` 或 `apply-event.ts` 可能有反向逻辑）。若没有，实现一个精简版从 `llm.message` 事件提取 `AgentMessage[]`。

`runWork` 需要支持传 `history` 参数——修改 `runWork` 签名加 `opts.history?: AgentMessage[]`，传给 `launchMessage` spec 的 `history` 字段。

- [ ] **Step 2: 加 SessionState forkedFrom 元数据（可选）**

`SessionState`（L53-58）加可选字段：
```ts
forkedFrom?: { sessionId: string; messageId: string }
```

`forkToNewSession` 创建新 session 后设置：
```ts
newSession.forkedFrom = { sessionId: sourceSessionId, messageId: forkPointMessageId }
```

- [ ] **Step 3: 验证类型**

Run: `pnpm --filter @swarm/desktop run typecheck:node`
Expected: 无错误。

- [ ] **Step 4: Commit**

```bash
git add apps/desktop/src/service/session/session-service.ts
git commit -m "feat(session): add forkToNewSession for checkpoint branching"
```

---

### Task 16: fork IPC + preload + 类型

**Files:**
- Modify: `apps/desktop/src/main/ipc/swarm-ipc.ts`（加 handler）
- Modify: `apps/desktop/src/preload/index.ts`（暴露 API）
- Modify: `packages/protocol/src/types/ui.ts`（SwarmBridge 加类型）

**Interfaces:**
- Consumes: `service.forkToNewSession`（Task 15）
- Produces: `window.swarm.forkSession(sourceSessionId, forkPointMessageId, newPrompt, opts?)` IPC

- [ ] **Step 1: ui.ts 加类型**

在 `packages/protocol/src/types/ui.ts` 的 `SwarmBridge` 类型（L458-550），加方法签名（照 `sessions.create` 模式）：

```ts
forkSession: (
  sourceSessionId: string,
  forkPointMessageId: string,
  newPrompt: string,
  opts?: { agentType?: string }
) => Promise<{ sessionId: string; messageId: string }>
```

- [ ] **Step 2: swarm-ipc.ts 加 handler**

在 `apps/desktop/src/main/ipc/swarm-ipc.ts`（照 `swarm:createSession` L261 模式），加：

```ts
ipcMain.handle('swarm:forkSession', (_e, sourceSessionId, forkPointMessageId, newPrompt, opts) =>
  serviceClient.forkToNewSession(sourceSessionId, forkPointMessageId, newPrompt, opts)
)
```

- [ ] **Step 3: preload 暴露**

在 `apps/desktop/src/preload/index.ts`（照 `sessions.create` L376 模式），加：

```ts
forkSession: (sourceSessionId: string, forkPointMessageId: string, newPrompt: string, opts?: { agentType?: string }) =>
  ipcRenderer.invoke('swarm:forkSession', sourceSessionId, forkPointMessageId, newPrompt, opts) as Promise<{ sessionId: string; messageId: string }>,
```

- [ ] **Step 4: 验证类型**

Run: `pnpm turbo run typecheck`
Expected: 无错误。

- [ ] **Step 5: Commit**

```bash
git add packages/protocol/src/types/ui.ts apps/desktop/src/main/ipc/swarm-ipc.ts apps/desktop/src/preload/index.ts
git commit -m "feat(ipc): wire forkSession IPC handler and preload API"
```

---

### Task 17: "从这里分支"按钮 + fork 弹窗

**Files:**
- Modify: `apps/desktop/src/renderer/src/components/task-transcript.tsx`（加 hover 按钮）

**Interfaces:**
- Consumes: `swarmApi.forkSession`（Task 16）、terminal 边界判别（`message.complete`/`message.error`）

- [ ] **Step 1: 加 fork 按钮到 terminal assistant message**

在 `apps/desktop/src/renderer/src/components/task-transcript.tsx`，找到 assistant segment 渲染（L406-421 的 `'assistant'` case）。在 terminal 边界的 message（`messageEndedAt` 返回非 null）上，hover 时显示"从这里分支"按钮。

```tsx
// 在 assistant 渲染的 MessageActions 内，加条件按钮：
{isTerminalMessage(messageId) && (
  <MessageAction
    tooltip="Fork from here"
    onClick={() => setForkTarget({ messageId })}
  >
    <GitBranch className="size-3.5" />
  </MessageAction>
)}
```

`isTerminalMessage` 判别：检查该 messageId 的事件流里是否有 `message.complete` 或 `message.error`（用现有 `messageEndedAt` 函数，task-transcript.ts:303-311）。

- [ ] **Step 2: fork 输入弹窗**

点击按钮后弹轻量输入框。可复用 `ChatInput` 组件（在 Dialog/Popover 内），或用一个简单 `<input>` + 提交按钮。提交时调：

```tsx
const result = await swarmApi.forkSession(sessionId, forkTarget.messageId, newPrompt)
// 切换到新 session
navigate({ to: '/session/$sessionId', params: { sessionId: result.sessionId } })
```

- [ ] **Step 3: 验证类型 + 手动验证**

Run: `pnpm --filter @swarm/desktop run typecheck:web`
启动 app，在一个完成的 assistant message 上 hover，确认按钮可见；点击后输入新指令，确认切换到新 session。

- [ ] **Step 4: Commit**

```bash
git add apps/desktop/src/renderer/src/components/task-transcript.tsx
git commit -m "feat(renderer): add fork-from-here button on terminal assistant messages"
```

---

### Task 18: session header fork 标记

**Files:**
- Modify: `apps/desktop/src/renderer/src/components/session-header.tsx`

**Interfaces:**
- Consumes: session 的 `forkedFrom` 元数据（需经 IPC 传到前端）

- [ ] **Step 1: 加 fork 标记**

在 `apps/desktop/src/renderer/src/components/session-header.tsx`，加条件 badge：

```tsx
{session.forkedFrom && (
  <span className="text-xs text-gray-400">
    forked from session
  </span>
)}
```

注意：`forkedFrom` 需要从后端传到前端——检查 sessions list IPC 是否包含 `forkedFrom` 字段，若不需要在 `session.list` 返回里补上。

- [ ] **Step 2: Commit**

```bash
git add apps/desktop/src/renderer/src/components/session-header.tsx
git commit -m "feat(renderer): show forked-from badge on fork session headers"
```

---

## Self-Review Notes

### Spec coverage
- §2.1 缺口表格 → Task 5（engine artifacts）、Task 7（session-service 透传）、Task 4（report_result）
- §2.3 改动点 A（report_result）→ Task 4
- §2.3 改动点 B（planState 上移）→ Task 3（reducer）、Task 7（session-service + 回调注入）
- §2.3 改动点 C（delegate itemId 三处 merge）→ Task 8
- §2.3 改动点 D（protocol 事件）→ Task 2
- §2.4 状态机 → Task 8（三处 merge 覆盖 pending→running→completed/failed）
- §2.5 降级 → Task 8（不传 itemId 不碰 planState）+ Task 5（sink 为空时 artifacts=[]）
- §2.6 文件清单 → 全覆盖
- §3.1-3.3 可视化 → Task 13
- §3.4 渲染入口 → Task 14
- §3.6 文件清单 → 全覆盖
- §4.2 forkToNewSession → Task 15
- §4.4 turn_end 约束 → Task 17（用 messageEndedAt terminal 判别）
- §4.5 产品化 UI → Task 17
- §4.7 文件清单 → 全覆盖
- §7 验收 → Task 12（项①）+ Task 14（项③）+ Task 17（项②）

### Known gaps / follow-ups
- **item→run 正向关联边**（§3.2）：Task 13 的 OrchestrationGraph 里标了 TODO——初始版本只画 plan DAG + run 树，item→run 边需读 `message.progress` 里的 `tool.call.args.itemId`，作为后续精化。
- **reconstructHistoryFromEvents**（Task 15）：需确认代码库是否已有从事件重建 AgentMessage[] 的工具。若无，需实现。
- **forkedFrom 传到前端**（Task 18）：需确认 sessions.list IPC 返回结构是否需扩展。

### Type consistency
- `DelegationItemStatus`: Task 1 定义 → Task 2（事件）→ Task 3（reducer）→ Task 7（mergeDelegationResult delta）→ Task 8（delegate merge）→ Task 10（MessageRecord）—— 全程一致
- `PlanItemState`: Task 3 定义 → Task 7（planStates）→ Task 11（hook）→ Task 13（PlanItemNode）—— 一致
- `mergeDelegationResult` 签名: `(itemId, delta: { status, artifacts })` —— Task 7（ctx）→ Task 8（delegate）一致
- `reportResult` 签名: `(artifacts: Artifact[])` —— Task 4（ctx）→ Task 5（sink）→ Task 6（注入）一致
