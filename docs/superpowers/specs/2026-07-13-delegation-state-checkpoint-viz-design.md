# 结构化 State、Checkpoint Fork、编排可视化

> 状态:已批准(设计阶段),待用户审查 → 转入实现计划
> 日期:2026-07-13
> 范围:在现有 pi + delegate 工具的递归委托架构上,补全三项缺口。**不含**并发管控(架构无缺口,见 §0)。

---

## 0. 背景与不做什么

SwarmAgents 的多 agent 编排是 **LLM-driven 递归委托**:Leader agent 在 loop 里调 `delegate` 工具,同步 await 子 run,子 run 的文字 summary 作为 tool_result 喂回。这套已经工作,但有三个缺口:

1. 父子只传 string summary,**无结构化结果合并**
2. transcript 已落盘,**无 fork 重跑能力**
3. `set_delegation_plan` 记一次就死,**无实时编排可视化**

**显式不做:并发管控。** 现有的全局槽位池(session-service `acquireSlot`)+ 父子槽位让渡(launch `withSlotReleased`)+ 会话级 FIFO(`waitTurn`)已经完整覆盖。所谓"补全"是搞错了缺口的形状。

## 1. 总体架构

三项改进共享一个核心机制——**living delegation plan**:一个可变的 `planState`,由 `report_result` 工具的产出喂入,由 `mergeDelegationResult` 合并,由编排可视化读取。

```
                  ┌─────────────────────────────────────┐
                  │   living planState (Map<itemId>)     │
                  │   id → {prompt, deps, status,        │
                  │          result: {artifacts, ...}}   │
                  └──────────┬──────────────┬────────────┘
                             │              │
        ① 结构化State+reducer│              │③ 编排可视化
        report_result→details│              │(合并一张图读
         →mergeDelegationResult│             │ planState 的
         合并入 planState)    │              │ status/result,
                             │              │ + parentMessageId
                  ② checkpoint fork         │ 建委托树)
                  (pi initialState.messages │
                   快照→forkToNewSession)   │
                  (fork 与 planState 正交:  │
                   fork 在 message 粒度,     │
                   planState 在 item 粒度)   │
```

**实施顺序锁定:① → ③ → ②**。① 是地基;③ 的大部分(数据通路)是 ① 的副产物;② 最独立,放最后。

---

## 2. 项 ①:结构化 State + reducer(地基)

### 2.1 缺口的精确诊断

`DelegateResult.artifacts` 字段在 `protocol/src/types/task.ts:170` **已定义**,但全链路是死的:

| 位置 | 现状 |
|---|---|
| `session-service.ts:405` `delegate()` 返回 | `artifacts: []` 写死 |
| `engine.ts:53` `EngineRunResult` | 无 artifacts 字段 |
| `delegate.ts:72` 解构 | 只取 `{ messageId, status, summary }` |
| 子 agent | 无产出结构化数据的约定工具 |

本项 = **接通已有的 artifacts 通路 + 加 living planState 做合并**。

### 2.2 数据通路(全链路)

```
子 agent 调 report_result({ artifacts })
   ↓ execute 调 ctx.reportResult(artifacts)
launch 层 sink 收集
   ↓ run 结束,塞进 EngineRunResult.artifacts
session-service delegate() 透传(不再写死 [])
   ↓ ctx.spawnChild 返回 { ..., artifacts }
delegate 工具放进 tool_result.details.artifacts
   ↓ 同时调 ctx.mergeDelegationResult(itemId, result)
planState 合并(reducer)→ emit message.delegation_update
   ↓ UI 订阅
父 agent 通过 tool_result.details 读到结构化 artifacts
```

### 2.3 四个改动点

#### 改动点 A:新增 `report_result` 工具(`tools/report-result.ts`)

子 agent 用它提交结构化结果。参数复用 `protocol` 的 `ArtifactSchema`(`task.ts:160`):

```ts
const Params = Type.Object({
  artifacts: Type.Array(Type.Object({
    kind: Type.Enum({ file: 'file', note: 'note', image: 'image' }),
    path: Type.Optional(Type.String()),
    text: Type.Optional(Type.String()),
    meta: Type.Optional(Type.Record(Type.String(), Type.Unknown())),
  }), { description: 'Structured results from this run.' })
})
```

**注入策略:自动注入。** `report_result` 不受 `suggestedTools` 限制,总是追加到每个 `kind: 'child'` 的 run。它是运行时基础设施,不是业务工具。注入发生在 `launch.ts` 解析 tools 时(在 `toolRegistry.resolve(...)` 之后追加)。

**子 agent prompt 引导**:Leader 的 system prompt 已有 delegation 指令,新增一句:"委派的子任务应在完成时调用 `report_result` 提交结构化结果(artifacts),不只是写一段总结。"

#### 改动点 B:launch.ts 加 `reportResult` sink + planState

在 `ToolRunContext`(launch.ts 里的 `ctx` 对象)新增,与现有 `setDelegationPlan` 并列:

```ts
const planState = new Map<string, DelegationItem & { status: PlanItemStatus; result?: Artifact[] }>()

const ctx: ToolRunContext = {
  // ...现有字段...
  setDelegationPlan: (items) => {
    items.forEach(it => planState.set(it.id, { ...it, status: 'pending' }))
    emit({ kind: 'message.delegation_plan', plan: [...planState.values()] })
  },
  reportResult: (artifacts) => {
    collectedArtifacts.push(...artifacts)   // sink,run 结束时读出
  },
  mergeDelegationResult: (itemId, result) => {
    const item = planState.get(itemId)
    if (!item) return                        // 不在 plan 里的 delegate(临时委托)走原路径
    // reducer:artifacts 追加, status 覆盖
    planState.set(itemId, {
      ...item,
      status: result.status,
      result: [...(item.result ?? []), ...result.artifacts],
    })
    emit({ kind: 'message.delegation_update', itemId, status: result.status, result: item.result })
  },
}
```

`mergeDelegationResult` 就是 reducer。合并规则:

- **status**:覆盖
- **artifacts**:追加(防御同一 item 被 delegate 两次的边缘情况)

#### 改动点 C:delegate 工具加 `itemId` 可选参数

`delegate.ts` 的 `DelegateParams` 新增:

```ts
itemId: Type.Optional(Type.String({
  description: 'If this delegate call corresponds to a plan item (from set_delegation_plan), pass its id (e.g. "d1") so the result is merged into the plan state.'
}))
```

execute 末尾,在返回前:

```ts
if (p.itemId) {
  ctx.mergeDelegationResult(p.itemId, {
    status: result.status,
    artifacts: result.artifacts ?? [],
  })
}
```

不带 `itemId` 的 delegate(临时委托,不在 plan 里)走原路径,不碰 planState。**完全向后兼容。**

#### 改动点 D:protocol 加 `message.delegation_update` 事件

`protocol/src/types/message.ts` 的 `MessageWireEvent` 联合类型新增,与现有 `message.delegation_plan`(message.ts:59)并列:

```ts
| (MessageEventBase & {
    kind: 'message.delegation_update'
    itemId: string
    status: 'pending' | 'running' | 'completed' | 'failed' | 'cancelled'
    result?: Artifact[]
  })
```

### 2.4 planState item 状态机

```
pending ──delegate 派出──→ running ──delegate 返回──→ completed/failed/cancelled
```

- `pending → running`:delegate 工具 execute 开始时,如果带 itemId,先 mergeDelegationResult(itemId, { status: 'running' })
- `running → completed/failed/cancelled`:delegate 返回时再 merge 一次

### 2.5 降级策略(向后兼容)

子 agent 没调 `report_result` → launch 层 sink 为空 → `EngineRunResult.artifacts` 为 `[]` → delegate 的 `details.artifacts` 为空,**但 summary 照常返回**。父 agent 拿到的是"没有结构化数据,只有文字摘要"——和现在行为完全一致。**不破坏现有用法,也不强制子 agent 必须产出 artifacts。**

### 2.6 本项文件清单

| 文件 | 改动类型 |
|---|---|
| `tools/report-result.ts` | 新增 |
| `tools/registry.ts` | 改:`ToolRunContext` 加 `reportResult` / `mergeDelegationResult` |
| `message-engine/launch.ts` | 改:planState + sink + 自动注入 report_result + itemId 透传 |
| `message-engine/engine.ts` | 改:`EngineRunResult` 加 artifacts 字段,从 sink 读出 |
| `tools/delegate.ts` | 改:加 itemId 参数,返回前 mergeDelegationResult |
| `service/session/session-service.ts` | 改:delegate() 透传 artifacts(不再写死 []) |
| `service/agents/prompt.ts` | 改:子 agent prompt 加 report_result 引导 |
| `protocol/src/types/message.ts` | 改:加 `message.delegation_update` |
| `protocol/src/types/task.ts` | 改:`DelegationItem` 可选加 `status`/`result` 字段(用于 plan payload) |

---

## 3. 项 ③:编排可视化(合并一张图)

### 3.1 前置条件

本项的数据通路由项 ① 提供。项 ① 做完后:

- `message.delegation_plan` 事件带完整 DAG
- `message.delegation_update` 事件实时更新 item 状态
- 现有 message 事件带 `parentMessageId`(委托树)+ `callId`(工具时序)

**数据全齐,本项纯前端。**

### 3.2 视图设计:合并一张图

用 `@xyflow/react`(已在 dependencies)画一张画布。**两种节点类型共存**:

| 节点类型 | 数据源 | 视觉 |
|---|---|---|
| **plan-item** | `message.delegation_plan` 的 items + `delegation_update` 的 status | 矩形,显示 prompt 摘要 + 状态色(pending 灰 / running 蓝 / completed 绿 / failed 红) |
| **run** | message 列表按 `parentMessageId` 建树 | 圆角矩形,显示 message 摘要 + agent 类型 |

**边**:

| 边类型 | 含义 | 视觉 |
|---|---|---|
| `dependsOn` | plan item 之间的 DAG 依赖 | 实线箭头 |
| `item→run` | plan item 由哪个 run 执行 | 实线(item.itemId ↔ run 的 delegate toolCall) |
| `parent→child` | 委托树父子 | 实线(来自 parentMessageId) |

### 3.3 交互

- 点击 plan-item 节点 → 高亮其对应的 run 节点 + 依赖链
- 点击 run 节点 → 滚动到该 run 的对话视图
- item 状态实时变化(redux/react-query 订阅 `delegation_update` 事件)→ 节点颜色实时变

### 3.4 渲染入口

在现有对话视图旁(或作为可切换标签)加一个"编排图"面板。仅当 session 存在 delegation_plan 时显示;无 plan 的普通对话不显示该面板。

### 3.5 跨 session 边界(简化声明)

合并图是 **per-session** 的。fork(项 ②)跨 session 后的分支**不在原图里追踪**——fork 开新 session,用户心智上已"独立"。如需跨 session fork 追踪,是未来需求,不在本 spec 范围。

### 3.6 本项文件清单

> 前端组件的确切路径在实现计划阶段确定(现有视图在 `renderer/src/components/views/workbench/`,编排图组件作为子目录或独立目录)。

| 文件 | 改动类型 |
|---|---|
| `renderer/src/.../orchestration/OrchestrationGraph.tsx` | 新增:xyflow 画布主组件 |
| `renderer/src/.../orchestration/PlanItemNode.tsx` | 新增:plan-item 节点组件 |
| `renderer/src/.../orchestration/RunNode.tsx` | 新增:run 节点组件 |
| `renderer/src/hooks/useDelegationPlan.ts` | 新增:订阅 delegation_plan + delegation_update,返回 nodes/edges |
| 现有 workbench 视图 | 改:加"编排图"面板入口(可切换标签或侧边面板) |

---

## 4. 项 ②:Checkpoint Fork(核心 + 产品化 UI)

### 4.1 前置条件

- pi 的 `Agent({ initialState: { messages: [...] } })` 原生支持从任意 message slice 起新 Agent——**无需改 pi**
- 现有 `message_events` store 存了完整 transcript,带 seq——**数据全有**

### 4.2 核心能力:`forkToNewSession`

`session-service.ts` 新增方法(核心 ~40 行):

```ts
forkToNewSession(
  sourceSessionId: string,
  forkPointMessageId: string,
  newPrompt: string,
  opts?: { agentType?: string }
): { sessionId: string, messageId: string }
```

**流程**:

1. 读源 session 的 `message_events`,切片到 `forkPointMessageId`(必须是 turn_end 边界——见 §4.4)
2. 新建 session(复用 `createSession`,传源 session 的 provider)
3. `launchMessage({ kind: 'work', sessionId: 新id, history: 切片, prompt: newPrompt, ... })`
4. 新 session 记一个 `forkedFrom: { sessionId, messageId }` 元数据

### 4.3 settings 继承

`SessionState`(session-service.ts:53)只有 4 个字段:

| 字段 | fork 时处理 |
|---|---|
| `id` | 新生成 |
| `provider` | 直接复制源 session 的 |
| `permissionRegistry` | 新建空的(权限决策不跨 session 继承) |
| `messages` | 空(fork 的 transcript 作为 `history` 传 launchMessage,不预填 session.messages) |

### 4.4 fork 点约束:只允许 turn_end 边界

fork 点卡在 `assistant message(含 toolCall)` 之后、对应 `toolResult` 之前 → 切片不完整 → 模型困惑。

**处理:UI 只在 turn_end 边界的 message 显示"从这里分支"按钮。** 这同时简化实现(切片总是完整 turn)且符合用户直觉。

判别 turn_end 边界:该 message 之后没有"悬空"的 toolCall(即所有 toolCall 都有配对的 toolResult)。

### 4.5 产品化 UI

**入口**:每个 turn_end 边界的 assistant message,hover 时显示一个"从这里分支"图标按钮(不占常驻空间)。

**交互**:
1. 点击按钮 → 弹轻量输入框(复用现有 prompt 输入组件)
2. 用户输入新指令 → 调 `forkToNewSession` IPC
3. 新 session 创建 → 自动切换到新 session 视图
4. 新 session 首条 message 带"fork 自 [源 session #N]"标记

### 4.6 fork 与 planState 正交

fork 操作的是 **message transcript**,不是 planState。fork 出的新 run 自己跑自己的 loop,不继承原 run 的 delegation plan。如果新 run 自己又 Leader 委托,它建自己的新 planState。**fork 粒度是 message,planState 粒度是 delegation item,两者正交。**

### 4.7 本项文件清单

> 前端组件的确切路径在实现计划阶段确定。现有的 message 渲染、session header、prompt 输入组件散布在 `renderer/src/components/views/workbench/` 和 `renderer/src/components/`,fork 的 UI 入口需要嵌入这些现有组件。

| 文件 | 改动类型 |
|---|---|
| `service/session/session-service.ts` | 改:加 `forkToNewSession` 方法;`SessionState` 可选加 `forkedFrom` 元数据 |
| `main/ipc/`(现有 IPC handler 目录) | 改:加 fork IPC handler |
| `preload/`(现有 preload) | 改:暴露 fork API |
| 现有 message 渲染组件 | 改:加"从这里分支"按钮(hover,turn_end 边界限定) |
| 现有 prompt 输入组件 | 复用:fork 输入弹窗(或轻量包装) |
| 现有 session header 组件 | 改:fork session 显示"fork 自"标记 |
| `protocol/src/types/ui.ts` | 改:加 forkSession IPC 类型 |

---

## 5. 实施顺序与依赖

```
① 结构化 State(地基)
   ├─ 改动 A:report_result 工具
   ├─ 改动 B:planState + sink
   ├─ 改动 C:delegate 加 itemId
   └─ 改动 D:protocol 事件
        │
        ↓ (数据通路就绪)
③ 编排可视化
   ├─ useDelegationPlan hook(订阅 ① 的事件)
   ├─ xyflow 合并图组件
   └─ 面板入口
        │
        ↓ (最独立,可与 ③ 并行,但放最后以聚焦)
② Checkpoint Fork
   ├─ forkToNewSession 核心方法
   ├─ IPC + preload
   └─ UI(按钮 + 弹窗 + session 标记)
```

每项完成后可独立提交、独立验证,不阻塞其他项。

## 6. 风险与降级

| 风险 | 降级方案 |
|---|---|
| 子 agent 不调 report_result | artifacts 为空,summary 照常——与现状一致(§2.5) |
| Leader 不传 itemId 给 delegate | planState 不更新,但 delegate 正常返回——与现状一致 |
| fork 切片遇到非 turn_end 边界 | UI 只在 turn_end 显示按钮,杜绝此情况(§4.4) |
| xyflow 画布在大型 plan(>20 items)时卡顿 | 后续可加折叠/缩略模式;当前 plan 通常个位数 item,不构成问题 |

## 7. 验收标准

### 项 ①
- [ ] 子 agent 调用 `report_result` 后,父 agent 在 tool_result.details.artifacts 中读到结构化数据
- [ ] `message.delegation_update` 事件在 delegate 派出和返回时各 emit 一次,status 正确
- [ ] 子 agent 不调 `report_result` 时,行为与现状一致(只返回 summary)
- [ ] delegate 不传 itemId 时,行为与现状一致(不碰 planState)

### 项 ③
- [ ] session 存在 delegation_plan 时,编排图面板可见
- [ ] 图中 plan-item 节点显示正确状态色,随 delegation_update 实时变化
- [ ] 图中 run 节点按 parentMessageId 正确建树
- [ ] 点击 plan-item 高亮对应 run 节点

### 项 ②
- [ ] 只在 turn_end 边界的 message 显示"从这里分支"按钮
- [ ] 点击后创建新 session,继承源 session 的 provider
- [ ] 新 session 的首条 run 带"fork 自 [源]"标记
- [ ] 新 session 的 history 是源 session 到 fork 点的 transcript 切片
