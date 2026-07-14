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

①③ 共享一个核心机制——**living delegation plan**:一个 session 级的 `planState`,挂在 `createSessionService` 闭包里(与 `sessions` Map、`turnQueues` 同层),经 `LaunchPorts` 注入到每次 `launchMessage` 的 ctx。② 与 planState 正交,不共享此机制。

**planState 是事件流的派生缓存,不是独立的可变状态。** 真相源是 `message_events` 表里的 `message.delegation_plan` + `message.delegation_update` 事件。内存里的 planState:
- **懒加载重放**:首次 `setDelegationPlan` / `mergeDelegationResult` 被调用时,从 `getMessageEvents(sid)` 读出这两类事件按 seq 重放重建(多数 session 无 delegation plan,省掉无谓读盘)。
- **运行中增量**:`setDelegationPlan` 重置(plan 是全量快照),`mergeDelegationResult` 按 itemId 增量更新。
- **崩溃恢复免费**:进程重启后 session 首次被访问,走重放即可恢复——状态本就是事件派生的。
- **后端可读**:planState 在 session-service 闭包,未来 Agent 若需查 plan 进度(如"d1 失败了,d3 依赖 d1"),可经 ports 读到——当前 spec 无此消费者,但架构不堵死。

前端对称:进 session 时从 `getMessageEvents` 重放,`subscribeEvents` 增量更新。前后端共用同一份 reducer 逻辑(放 `packages/shared`,避免漂移)。

```
            message_events (真相源)
            ┌──────────────────────────────────┐
            │ delegation_plan + delegation_update│
            │ (按 seq, 持久化)                  │
            └────────────┬─────────────────────┘
                         │ 重放(懒加载)/ 增量
            ┌────────────┴─────────────────────┐
            ▼                                   ▼
  后端 planState                       前端 reducer (派生视图)
  (session-service 闭包)              (apply-event → MessageRecord)
  经 LaunchPorts 注入 ctx             useDelegationPlan hook 订阅
   ├ setDelegationPlan(重置+emit)      ├ delegation_plan → 全量覆盖
   └ mergeDelegationResult(增量+emit)  └ delegation_update → 按 itemId merge
            │                                   │
            │  ① 结构化 State:                   │  ③ 编排可视化:
            │  report_result→sink→              │  读 planState 的 status/result
            │  EngineRunResult.artifacts→       │  + parentMessageId 建委托树
            │  delegate 透传→tool_result.details  │  + itemId 正向关联 item↔run
            │                                   │
            ② checkpoint fork (与 planState 正交)
            pi initialState.messages 快照 → forkToNewSession
            fork 在 message 粒度, planState 在 item 粒度
```

**实施顺序:① → ③ → ②**(聚焦理由,非技术依赖)。① 是地基;③ 的大部分(数据通路)是 ① 的副产物;② 与 ①③ 正交,技术上可与 ① 并行,放最后仅以聚焦为由。

---

## 2. 项 ①:结构化 State + reducer(地基)

### 2.1 缺口的精确诊断

`DelegateResult.artifacts` 字段在 `protocol/src/types/task.ts:170` **已定义**,但全链路是死的:

| 位置 | 现状 |
|---|---|
| `session-service.ts:405` `delegate()` 返回 | `artifacts: []` 写死 |
| `session-service.ts:351` `createTask()` 返回 | 同样 `artifacts: []` 写死(topLevel 委托路径) |
| `engine.ts:53` `EngineRunResult` | 无 artifacts 字段 |
| `delegate.ts:72` 解构 | 只取 `{ messageId, status, summary }` |
| 子 agent | 无产出结构化数据的约定工具 |

本项 = **接通已有的 artifacts 通路 + 加 session 级 planState(事件重放派生)做合并**。

### 2.2 数据通路(全链路)

**artifacts 透传通路(per-run,父子当次传递):**

```
子 agent 调 report_result({ artifacts })
   ↓ execute 调 ctx.reportResult(artifacts)
launch 层 sink 收集
   ↓ run 结束,塞进 EngineRunResult.artifacts
session-service delegate()/createTask() 透传(不再写死 [])
   ↓ ctx.spawnChild 返回 { ..., artifacts }
delegate 工具放进 tool_result.details.artifacts
   ↓
父 agent 通过 tool_result.details 读到结构化 artifacts
```

**plan 状态通路(session 级,跨轮累积,UI 视图):**

```
delegate execute 派出/返回/异常
   ↓ ctx.mergeDelegationResult(itemId, { status, artifacts })
session-service 闭包 planState 增量更新(经 LaunchPorts 注入)
   ↓ emit message.delegation_update(携累积 artifacts)
message_events 持久化
   ↓ 前端 subscribeEvents / 进 session 时重放
前端 reducer(apply-event)→ MessageRecord.delegationPlan
   ↓ useDelegationPlan hook
编排图 UI
```

两条通路独立:artifacts 透传是 per-run 的父子数据传递;plan 状态是 session 级的 UI 视图。原 spec 把它们混进"living planState"一个机制,现拆开。

### 2.3 四个改动点

#### 改动点 A:新增 `report_result` 工具(`tools/report-result.ts`)

子 agent 用它提交结构化结果。参数结构对应 `protocol` 的 `ArtifactSchema`(`task.ts:160`):

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

**注意 schema 库差异**:protocol 的 `ArtifactSchema` 用 **zod** 定义(`z.object`/`z.enum`),而工具 params 用 **TypeBox**(`Type.Object`/`Type.Enum`,与 `@earendil-works/pi-ai` 的工具约定一致)。二者不能直接互换。`report_result` 的 params 在工具侧用 TypeBox 重写一份等价结构;如需避免漂移,可在 protocol 侧补一份 TypeBox 版本或经 zod-to-typebox 转换。

**注入策略:自动注入。** `report_result` 不受 `suggestedTools` 限制,总是追加到每个 `kind: 'child'` 的 run。它是运行时基础设施,不是业务工具。注入发生在 `launch.ts` 解析 tools 时(在 `toolRegistry.resolve(...)` 之后追加)。

**子 agent prompt 引导**:Leader 的 system prompt 已有 delegation 指令,新增一句:"委派的子任务应在完成时调用 `report_result` 提交结构化结果(artifacts),不只是写一段总结。"

#### 改动点 B:planState 上移到 session-service + launch.ts 仅做 sink

**核心变更:planState 从 `launchMessage` 闭包局部变量,上移到 `createSessionService` 闭包(与 `sessions` Map、`turnQueues` 同层),经 `LaunchPorts` 注入到 ctx。** 原方案把 planState 放 per-run 闭包,但 delegation plan 的逻辑生命周期是 per-session(跨多轮对话):turn 1 设 plan delegate d1/d2,turn 2 用户追问继续、delegate d3——turn 2 是新的 `launchMessage`,per-run planState 已销毁,d3 的 `itemId` 撞上空 Map 被当临时委托放过,状态更新静默失效。

planState 在 session-service 闭包:

```ts
// session-service.ts createSessionService 闭包内,新增
type PlanItemState = DelegationItem & { status: DelegationItemStatus; result: Artifact[] }
const planStates = new Map<string /*sessionId*/, Map<string /*itemId*/, PlanItemState>>()
```

**懒加载重放**:首次 `setDelegationPlan` / `mergeDelegationResult` 被调用时,从 `getMessageEvents(sid)` 读出 `delegation_plan` + `delegation_update` 事件按 seq 重放重建 planState(多数 session 无 delegation plan,省掉无谓读盘)。重放如实包含 running 态(已 emit running 未 emit 终态的 item 重建为 running)。运行中增量更新;崩溃后进程重启,session 首次被访问时重放即恢复——状态是事件派生的,内存是缓存。

经 LaunchPorts 注入(与现有 `acquireSlot`/`waitTurn` 同路径):

```ts
// session-service.ts 注入 ports
const ports = {
  // ...现有 ports...
  setDelegationPlan: (sessionId, items) => {
    const state = ensurePlanState(sessionId)   // 懒加载重放
    state.clear()
    items.forEach(it => state.set(it.id, { ...it, status: 'pending', result: [] }))
    emit({ kind: 'message.delegation_plan', plan: [...state.values()] })
  },
  mergeDelegationResult: (sessionId, itemId, delta) => {
    const state = ensurePlanState(sessionId)
    const item = state.get(itemId)
    if (!item) return                          // 不在 plan 里的 delegate(临时委托)走原路径
    // reducer:status 覆盖, result 覆盖(重跑=替代, 非追加)
    state.set(itemId, { ...item, status: delta.status, result: delta.artifacts })
    emit({ kind: 'message.delegation_update', itemId, status: delta.status, result: delta.artifacts })
  },
}
```

launch.ts 的 ctx 只做引用,不再持有 planState:

```ts
// launch.ts ctx 构建(emit 仍是 launchMessage 闭包变量)
const ctx: ToolRunContext = {
  // ...现有字段...
  setDelegationPlan: (plan) => {
    ports.setDelegationPlan(spec.sessionId, plan)   // 委托给 session 级
    spec.onDelegationPlan?.(plan)
  },
  mergeDelegationResult: (itemId, delta) => {
    ports.mergeDelegationResult(spec.sessionId, itemId, delta)
  },
  reportResult: (artifacts) => {
    collectedArtifacts.push(...artifacts)   // per-run sink,run 结束时读出(artifacts 透传通路,与 planState 无关)
  },
}
```

`mergeDelegationResult` 的 reducer 合并规则:

- **status**:覆盖
- **result(artifacts)**:覆盖。同一 itemId 被 delegate 两次时,第二次的 result **替代**第一次——plan item 语义上是一个任务单元,重跑是替代不是追加。原"追加"语义会产出矛盾列表(`[A, B]` 里 B 可能是 A 的修正)。update 事件携**累积全量** result(后端 merge 后的结果),前端直接覆盖,不需自己累积。

#### 改动点 C:delegate 工具加 `itemId` 可选参数

`delegate.ts` 的 `DelegateParams` 新增:

```ts
itemId: Type.Optional(Type.String({
  description: 'If this delegate call corresponds to a plan item (from set_delegation_plan), pass its id (e.g. "d1") so the result is merged into the plan state.'
}))
```

execute 在三个时机调 `mergeDelegationResult`(带 itemId 时):

```ts
// ① 派出标记(execute 开始)
if (p.itemId) {
  ctx.mergeDelegationResult(p.itemId, { status: 'running', artifacts: [] })
}
try {
  const { messageId, status, summary, artifacts } = await ctx.spawnChild(p.prompt, { ... })
  // ② 末尾:结果合并(正常返回)
  if (p.itemId) {
    ctx.mergeDelegationResult(p.itemId, { status, artifacts: artifacts ?? [] })
  }
  return delegateResult(messageId, status, summary)
} catch (err) {
  // ③ 异常路径:标记 failed 再 rethrow(避免节点卡在 running 永不变色)
  if (p.itemId) {
    ctx.mergeDelegationResult(p.itemId, { status: 'failed', artifacts: [] })
  }
  throw err
}
```

原方案只在末尾 merge 一次,缺 ① 和 ③:① 缺则 running 态不 emit(编排图无"派出中"反馈);③ 缺则 `spawnChild` 抛异常(槽位耗尽、provider 错误、abort)时节点卡在 running 永不变色。

不带 `itemId` 的 delegate(临时委托,不在 plan 里)走原路径,不碰 planState。**完全向后兼容。**

#### 改动点 D:protocol 加 `message.delegation_update` 事件

`protocol/src/types/message.ts` 的 `MessageWireEvent` 联合类型新增,与现有 `message.delegation_plan`(message.ts:59)并列:

```ts
| (MessageEventBase & {
    kind: 'message.delegation_update'
    itemId: string
    status: DelegationItemStatus   // 'pending'|'running'|'completed'|'failed'|'cancelled'
    result: Artifact[]              // 累积全量(覆盖语义),后端 merge 后的结果
  })
```

### 2.4 planState item 状态机

```
pending ──delegate 派出──→ running ──┬──delegate 正常返回──→ completed/failed/cancelled
                                      └──delegate 抛异常────→ failed
```

- `pending → running`:delegate 工具 execute 开始时,如果带 itemId,先 mergeDelegationResult(itemId, { status: 'running' })(改动点 C ①)
- `running → completed/failed/cancelled`:delegate 正常返回时再 merge 一次(改动点 C ②)
- `running → failed`:delegate 抛异常时 catch 里 merge failed 再 rethrow(改动点 C ③)。**原方案缺此路径**,spawnChild 抛异常(槽位耗尽、provider 错误、abort)时节点卡在 running 永不变色

**`DelegationItemStatus` 是新建类型**,值为 `'pending'|'running'|'completed'|'failed'|'cancelled'`。**不复用** task.ts 既有的 `planStatusValues`(`['pending','in_progress','completed']`,plan todo 状态机用 `in_progress`)——delegation item 用 `running` 且多 failed/cancelled,语义不同。在 `protocol/src/types/task.ts` 导出此类型。

### 2.5 降级策略(向后兼容)

子 agent 没调 `report_result` → launch 层 sink 为空 → `EngineRunResult.artifacts` 为 `[]` → delegate 的 `details.artifacts` 为空,**但 summary 照常返回**。父 agent 拿到的是"没有结构化数据,只有文字摘要"——和现在行为完全一致。**不破坏现有用法,也不强制子 agent 必须产出 artifacts。**

### 2.6 本项文件清单

| 文件 | 改动类型 |
|---|---|
| `tools/report-result.ts` | 新增 |
| `tools/registry.ts` | 改:`ToolRunContext` 加 `mergeDelegationResult`(`reportResult` sink 保留) |
| `message-engine/launch.ts` | 改:ctx 从 ports 读 `setDelegationPlan`/`mergeDelegationResult`(不再新建 planState);保留 `reportResult` sink;自动注入 report_result |
| `message-engine/engine.ts` | 改:`EngineRunResult` 加 artifacts 字段,从 sink 读出 |
| `tools/delegate.ts` | 改:加 itemId 参数;execute 开始/末尾/catch 三处 mergeDelegationResult |
| `service/session/session-service.ts` | 改:加 `planStates` Map + 懒加载重放 + `setDelegationPlan`/`mergeDelegationResult` 实现 + 经 LaunchPorts 注入;delegate()/createTask() 透传 artifacts(不再写死 []) |
| `shared/messages/delegation-reducer.ts` | 新增:前后端共用的 reducer(delegation_plan 全量覆盖 / delegation_update 按 itemId merge),避免漂移 |
| `service/agents/prompt.ts` | 改:子 agent prompt 加 report_result 引导 |
| `protocol/src/types/message.ts` | 改:加 `message.delegation_update` |
| `protocol/src/types/task.ts` | 改:导出 `DelegationItemStatus` 类型;`DelegationItem` 可选加 `status`/`result` 字段(用于 plan payload) |
| `shared/messages/apply-event.ts` | 改:`message.delegation_plan` 不再空操作(全量覆盖 `MessageRecord.delegationPlan`);加 `message.delegation_update` 处理(按 itemId merge) |
| `renderer/src/hooks/use-delegation-plan.ts` | 新增:从 react-query 缓存读 `MessageRecord.delegationPlan`,订阅 `delegation_update` 触发重渲染 |

---

## 3. 项 ③:编排可视化(合并一张图)

### 3.1 前置条件

本项的数据通路由项 ① 提供。项 ① 做完后:

- `message.delegation_plan` 事件带完整 DAG(后端 emit,前端经 `apply-event` 落进 `MessageRecord.delegationPlan`)
- `message.delegation_update` 事件实时更新 item 状态(前端 reducer 增量 merge)
- `MessageEventBase` 带 `parentMessageId`(委托树,message.ts:23);`callId` 在 `message.progress` 内部的 `TaskEvent.tool.call`/`tool.result` 上(task.ts:120,128,optional),**非 message 事件顶层字段**

事件流数据齐全,但前端当前**不消费** `message.delegation_plan`(`apply-event.ts` 空操作,`MessageRecord` 无对应字段)。项 ① 已含前端 reducer + `useDelegationPlan` hook 的增量构建(见 §2.6),故本项聚焦**渲染层**:xyflow 画布 + 节点/边组件 + 面板入口。非"纯订阅",但 plan 状态构建已在项 ① 完成。

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

**item→run 关联策略(正向,非事后反向匹配)**:`delegate` 工具 execute 时,若带 `itemId`,将其写进 `tool.call.args.itemId`。前端建边时从 run 的 `message.progress` 事件里找 `tool.call`(name=delegate),读其 `args.itemId`,正向匹配 plan-item 节点。不依赖"mergeDelegationResult 被调用了"这个副作用——即便 Leader 漏传 itemId,run 树本身仍完整;plan-item 到 run 的关联降级为"无关联",而非图断裂。

**孤儿节点处理**:两种节点并非一一对应——临时委托的 run(无 itemId)没有 plan-item 节点;pending 的 plan-item(尚未 delegate)没有 run 节点。孤儿不连 `item→run` 边,单独渲染:临时委托 run 挂在委托树的 parent→child 边下(无 plan-item 关联);pending plan-item 作为游离矩形显示在画布上(灰色,等待派出)。

### 3.3 交互

- 点击 plan-item 节点 → 高亮其对应的 run 节点 + 依赖链
- 点击 run 节点 → 滚动到该 run 的对话视图
- item 状态实时变化(zustand/react-query 订阅 `delegation_update` 事件)→ 节点颜色实时变

### 3.4 渲染入口

在现有对话视图旁(或作为可切换标签)加一个"编排图"面板。仅当 session 存在 delegation_plan 时显示;无 plan 的普通对话不显示该面板。

### 3.5 跨 session 边界(简化声明)

合并图是 **per-session** 的。fork(项 ②)跨 session 后的分支**不在原图里追踪**——fork 开新 session,用户心智上已"独立"。如需跨 session fork 追踪,是未来需求,不在本 spec 范围。

### 3.6 本项文件清单

> 现有对话视图是 `renderer/src/components/views/tasks-view.tsx`(由 `routes/session.$sessionId.tsx` 渲染),其 message 渲染在 `components/task-transcript.tsx`、prompt 输入在 `components/chat-input.tsx`、session 头在 `components/session-header.tsx`。编排图组件作为 `components/orchestration/` 子目录。`@xyflow/react` 已在 `apps/desktop/package.json` dependencies(`^12.11.2`)。

| 文件 | 改动类型 |
|---|---|
| `renderer/src/components/orchestration/OrchestrationGraph.tsx` | 新增:xyflow 画布主组件 |
| `renderer/src/components/orchestration/PlanItemNode.tsx` | 新增:plan-item 节点组件 |
| `renderer/src/components/orchestration/RunNode.tsx` | 新增:run 节点组件 |
| `renderer/src/hooks/use-delegation-plan.ts` | 新增:从 react-query 缓存读 plan 状态,返回 nodes/edges(项 ① 已建 reducer + 落库,本 hook 做派生) |
| `renderer/src/components/views/tasks-view.tsx` | 改:加"编排图"面板入口(可切换标签或侧边面板),仅当 session 存在 delegation_plan 时显示 |

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

**处理:UI 只在 turn_end 边界的 message 显示"从这里分支"按钮。** 这同时简化实现(切片总是完整 turn)。

判别 turn_end 边界:

- **主判据**——该 messageId 已到达终态(`message.complete` 或 `message.error`,见 `terminalStatusForMessageEvent`)。终态即一次 message 的终止边界,判别成本低于 toolCall 悬空扫描。
- **可选校验**——该 message 范围内所有 `tool.call` 都有配对 `tool.result`(按 callId 配对,见 task.ts:109-129),防御不完整终态的边缘情况。

原方案用"无悬空 toolCall"作主判据,可行但非最优——项目已有 `message.complete`/`message.error` 这种现成的 terminal 边界标记可直接用。

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

> fork 的 UI 入口嵌入现有组件:message 渲染在 `components/task-transcript.tsx`(segment 分发器 :349-478,assistant 行 :406-421,hover 模式用 `group` + `MessageAction`)、prompt 输入在 `components/chat-input.tsx`(已在 3 处复用,支持 `variant`)、session 头在 `components/session-header.tsx`。对话主页 `views/tasks-view.tsx`。IPC handler 在 `main/ipc/swarm-ipc.ts`,preload 在 `preload/index.ts`,IPC 类型在 `packages/protocol/src/types/ui.ts`(`SwarmBridge`)。

| 文件 | 改动类型 |
|---|---|
| `service/session/session-service.ts` | 改:加 `forkToNewSession` 方法;`SessionState` 可选加 `forkedFrom` 元数据 |
| `main/ipc/swarm-ipc.ts` | 改:加 `swarm:forkSession` handler(照 `swarm:createSession` 模式) |
| `preload/index.ts` | 改:暴露 `forkSession` API(照 `sessions.create` 模式) |
| `components/task-transcript.tsx` | 改:turn_end 边界的 assistant message hover 时显示"从这里分支"按钮(复用 `MessageAction`) |
| `components/chat-input.tsx` | 复用:fork 输入弹窗(或新增 `variant`) |
| `components/session-header.tsx` | 改:fork session 显示"fork 自"标记 |
| `packages/protocol/src/types/ui.ts` | 改:`SwarmBridge` 加 `forkSession` IPC 类型 |

---

## 5. 实施顺序与依赖

```
① 结构化 State(地基)
   ├─ 改动 A:report_result 工具
   ├─ 改动 B:planState 上移 session-service + 事件重放 + ports 注入
   ├─ 改动 C:delegate 加 itemId(三处 merge:派出/返回/异常)
   ├─ 改动 D:protocol 事件
   └─ 前端 reducer + apply-event + useDelegationPlan hook
        │
        ↓ (数据通路就绪)
③ 编排可视化
   ├─ xyflow 合并图组件(plan-item / run 节点)
   ├─ item→run 正向关联(读 tool.call.args.itemId)
   └─ 面板入口(tasks-view)
        │
        ↓ (与 ①③ 正交,技术上可并行,放最后仅以聚焦为由)
② Checkpoint Fork
   ├─ forkToNewSession 核心方法
   ├─ IPC + preload
   └─ UI(按钮 + 弹窗 + session 标记)
```

② 与 ①③ 正交:fork 操作 message transcript,不碰 planState(planState 在 item 粒度,见 §4.6)。技术上 ② 可与 ① 并行,顺序锁定 ①→③→② 仅为聚焦,非技术依赖。每项完成后可独立提交、独立验证。

## 6. 风险与降级

| 风险 | 降级方案 |
|---|---|
| 子 agent 不调 report_result | artifacts 为空,summary 照常——与现状一致(§2.5) |
| Leader 不传 itemId 给 delegate | planState 不更新,但 delegate 正常返回——与现状一致。编排图里该 run 成为孤儿(无 plan-item 关联),run 树本身仍完整(§3.2 孤儿处理) |
| delegate spawnChild 抛异常 | catch 里 merge `{ status: 'failed' }` 再 rethrow,节点不卡 running(§2.3 改动点 C ③ / §2.4) |
| planState 重放开销 | 懒加载:首次 setDelegationPlan/mergeDelegationResult 时才重放,多数 session 无 plan 不触发(§1)。重放只读 delegation_plan + delegation_update 两类事件,非全量 transcript |
| fork 切片遇到非 turn_end 边界 | UI 只在 terminal 边界显示按钮,杜绝此情况(§4.4) |
| xyflow 画布在大型 plan(>20 items)时卡顿 | 后续可加折叠/缩略模式;当前 plan 通常个位数 item,不构成问题 |

## 7. 验收标准

### 项 ①
- [ ] 子 agent 调用 `report_result` 后,父 agent 在 tool_result.details.artifacts 中读到结构化数据
- [ ] `message.delegation_update` 事件在 delegate 派出(running)和返回(终态)时各 emit 一次,status 正确
- [ ] delegate spawnChild 抛异常时,emit `status: 'failed'`,节点不卡 running
- [ ] **多轮 plan 跨 turn 状态延续**:turn 1 设 plan delegate d1/d2,turn 2 用户追问、delegate d3(带 itemId),d3 状态正确更新为 running→completed(planState 是 session 级,跨 turn 存活)
- [ ] 子 agent 不调 `report_result` 时,行为与现状一致(只返回 summary)
- [ ] delegate 不传 itemId 时,行为与现状一致(不碰 planState)
- [ ] 前端 `apply-event` 正确处理 `delegation_plan`(全量覆盖)和 `delegation_update`(按 itemId merge)

### 项 ③
- [ ] session 存在 delegation_plan 时,编排图面板可见
- [ ] 图中 plan-item 节点显示正确状态色,随 delegation_update 实时变化
- [ ] 图中 run 节点按 parentMessageId 正确建树
- [ ] 点击 plan-item 高亮对应 run 节点(经 tool.call.args.itemId 正向关联)
- [ ] 孤儿节点(临时委托 run / pending plan-item)正确渲染,不连 item→run 边

### 项 ②
- [ ] 只在 terminal 边界(complete/error)的 message 显示"从这里分支"按钮
- [ ] 点击后创建新 session,继承源 session 的 provider
- [ ] 新 session 的首条 run 带"fork 自 [源]"标记
- [ ] 新 session 的 history 是源 session 到 fork 点的 transcript 切片
