# 连发消息：排队执行 + 取消 + 打断插队

**日期**：2026-06-24
**状态**：已确认，进入实现

## 背景与现状

同一 session 的消息当前是**串行**的，但用户根本发不出第二条：

- 后端 `submitGoal`（`src/service/session/manager.ts:654`）每次提交都立即建一个 `status: 'pending'` 的 Task 并广播 `task.created`，再通过 `session.queue = session.queue.then(runTurn, runTurn)`（`manager.ts:766`）把执行串成 promise 链。
- 但渲染层 `chat-input.tsx` 在任务运行时把发送按钮变成**停止键**（`PromptInputSubmit` 在 `status` 为 `submitted`/`streaming` 时 `type='button'` 走 `onStop`，`prompt-input.tsx:1055-1085`），导致正常路径下无法提交第二条。
- `cancelTask`（`manager.ts:784`）只做 `oneShotHandles.get(taskId)?.abort()`；而排队中的 pending 任务此时尚无 `AbortController`（它在 `runTurn` 进入、`acquireSlot` 之后才创建），**所以取消一个排队项目前完全无效，它照样会跑**。

本设计让连发消息成为一等体验：默认排队、可视化队列、逐项取消、逐项打断插队。

## 目标

1. **默认排队**：运行中仍可提交，新消息进入可视队列，FIFO 自动执行。
2. **展示队列**：composer 上方堆叠区显示「等待中」的排队卡片。
3. **取消排队项**：每张排队卡片可单独取消，被取消项永不执行。
4. **打断插队**：每张排队卡片右侧有打断控件，点击 → 取消当前运行中任务（保留部分结果）+ 该条提到队首立即执行。
5. **停止语义**：普通停止只停当前一条，队列继续自动跑下一条。

## 非目标（YAGNI）

- 编辑排队消息内容（仅取消，不改文本）。
- 队列顺序跨应用重启持久化（pending Task 行本身已持久化，但执行队列顺序是 ephemeral——重启本就把 active session 标记 `interrupted`）。
- 把第二条消息「追加注入」正在运行的同一个 agent turn（需 agent-core 支持中途追加，改动过大，明确舍弃）。
- 跨 session 的全局队列（队列严格 per-session）。

## 行为决策（已与用户确认）

| 问题 | 决策 |
|---|---|
| 连发第二条 | 默认排队，运行中可发 |
| 打断当前任务 | 复用 `cancelTask`，运行中任务标 `cancelled` 并**保留部分结果**到对话历史 |
| 多条排队时打断 | **每条一个**打断控件，点哪条哪条**插到队首**立即跑，其余保持原顺序 |
| 队列 UI 操作 | 显示队列 + 取消排队项（不支持编辑） |
| 普通停止后 | 队列**继续**自动跑下一条（要全停则逐条取消） |
| 布局 | 排队区在 composer 上方（`ComposerOverlay`）；发送键恢复「始终发送」；停止键移到运行中任务状态条 |

## 架构改动

### 1. 后端 session manager（`src/service/session/manager.ts`）

**用显式队列数组替换 promise 链**——promise 链无法重排序，支撑不了插队。

`Session` 类型改动：

```ts
type QueuedTurn = { taskId: string; runTurn: () => Promise<void> }

type Session = {
  // ...现有字段
  // 移除：queue: Promise<void>
  pending: QueuedTurn[]        // FIFO 等待队列（不含正在跑的那条）
  running: string | null       // 正在执行的 taskId，空闲为 null
  pumping: boolean             // 防止 pump 重入
}
```

`pump(session)`（新增内部函数）：

- 若 `session.running` 非空或 `pumping` 为真，直接返回（一次只跑一条）。
- 否则 shift 队首，置 `session.running = taskId`，执行其 `runTurn()`。
- `runTurn` 的 `finally` 里：清 `session.running = null`，再次调用 `pump(session)` 续跑下一条 → 天然实现「停止后队列继续」。

`submitGoal` 改动（`manager.ts:654`）：

- 照旧建 pending Task、广播 `task.created`、设标题。
- 不再 `session.queue.then(...)`；改为把 `{ taskId, runTurn }` push 进 `session.pending`，然后 `pump(session)`。
- 仍立即返回 `{ taskId }`。

`cancelTask` 扩展（`manager.ts:784`）：

```
若 taskId === session.running        → oneShotHandles.get(taskId)?.abort()   （现状路径）
否则若在 session.pending 中           → 从数组移除 + store.updateTaskStatus(taskId, 'cancelled')
                                        + 广播 task 状态（让 UI 移除排队卡片）
否则                                  → 无操作（日志 warn：未知/已结束 taskId）
```

`interruptWith(sessionId, taskId)`（新增 SessionManager 方法）：

- 在 `session.pending` 中找到该项，移除并 `unshift` 到队首（插队，Q2）。
- 若 `session.running` 非空 → `oneShotHandles.get(session.running)?.abort()`：运行中任务被 `runner.run()` 的 abort 路径终结，状态置 `cancelled`，部分结果已通过 `saveSnapshot` 留在 `session.messages`（Q1 保留部分结果）。
- 其 `finally` → `pump` 自动跑被提到队首的那条。
- 边界：无运行中任务时（仅排队），不 abort，直接 `pump`（被提项即刻成为队首）。

类型签名新增（`SessionManager`）：

```ts
interruptWith(sessionId: string, taskId: string): void
```

**日志**（CLAUDE.md §5）：

- `info` 入队：复用现有 `'goal submitted'`，补 `queueDepth`。
- `info` turn 启动：pump 取出执行时 `{ msg: 'turn started', sessionId, taskId, queueDepth }`。
- `info` 取消排队项：`{ msg: 'queued task cancelled', sessionId, taskId }`。
- `info` 打断插队：`{ msg: 'task interrupted, promoted to front', sessionId, taskId, cancelledTaskId }`。

### 2. IPC 三层

- `cancelTask` 已三层贯通，语义扩展无需改签名。
- 新增 `interruptWith`：
  - `src/service/ipc/dispatcher.ts`：注册 `interruptWith` → `manager.interruptWith`。
  - `src/main/service-client.ts`：加 `interruptWith(sessionId, taskId)` 转发。
  - `src/main/ipc/swarm-ipc.ts`：暴露 IPC channel。
  - preload（`window.swarm`）：暴露 `interruptWith`。
  - renderer query hook：仿现有 `cancelTask` mutation 加 `interruptWith` mutation。

### 3. 渲染层

**`src/renderer/src/components/chat-input.tsx`**：

- 发送键恢复「始终发送」——不再因 `status` 把按钮变停止键。最简做法：`onStop` 不再传给 composer 的提交按钮（或传 `status='ready'` 给 `PromptInputSubmit`，保持它永远是 submit）。`handleSubmit` 已只判 `disabled`，运行中可正常提交。
- Enter 始终触发提交（提交按钮不再 disabled）。

**运行中任务状态条 + 停止键**：

- 在转写区（`ConversationThread`）运行中任务卡片上展示 `[● 执行中…] [■ 停止]`，停止 → `cancelTask(runningTask)`。
- 具体落点跟随现有运行中任务的渲染；停止键从 composer 迁移至此。

**`src/renderer/src/components/composer-overlay.tsx`**：

- 新增排队卡片列表 `QueuedTaskCard`，渲染传入的 `queued: Task[]`。
- 每张卡片：goal 文本摘要 + `[× 取消]`（→ `cancelTask`）+ `[⏭ 打断]`（→ `interruptWith`）。
- 与现有 `PlanStatusBar` / `PermissionCard` 同处堆叠区，排在合适层级。

**`src/renderer/src/components/views/tasks-view.tsx`**：

- 区分：
  - `runningTask` = `sessionTasks.find(status ∈ {running, awaiting_user})`
  - `queuedTasks` = `sessionTasks.filter(status === 'pending')`（按 createdAt 升序 = 队列顺序）
- `ComposerOverlay` 传 `queued={queuedTasks}` + `onCancelQueued` + `onInterrupt`。
- composer `status` 不再驱动停止键（见上）。

### 4. 数据流

```
用户提交（运行中也可）
  → submitGoal：建 pending Task + 广播 task.created + push pending + pump
  → 渲染层收到 task.created(status=pending) → ComposerOverlay 显示排队卡片
  → pump FIFO 执行 → task 状态流转 running → completed/cancelled/failed
  → 取消排队项：cancelTask → 移出队列 + 标 cancelled + 卡片消失
  → 打断：interruptWith → 移到队首 + abort 当前 → 当前 cancelled（留部分结果）→ pump 跑被提项
```

队列存于 service 进程内存（`Session.pending`）；pending Task 行已持久化用于展示，但队列**顺序**不持久化（见非目标）。

## 错误处理

- `runTurn` 失败：现有逻辑标 `failed` + `onComplete('failed')`，`finally` 仍 `pump` 续跑下一条（一条失败不卡住队列）。
- `interruptWith` 目标 taskId 不在 pending（已开始/已结束）：日志 warn，不操作。
- `cancelTask` 目标 taskId 未知：日志 warn，不操作。
- abort 与 pump 的竞态：`session.running` 由 pump 设、由 `runTurn.finally` 清，单一 owner；`pumping` 防重入。

## 测试（`src/service/session/manager.test.ts`）

1. **串行执行**：连提两条 goal，断言第二条的 `runTurn` 在第一条结束后才启动（`running` 同一时刻只有一个）。
2. **取消排队项**：提两条，对第二条（pending）调 `cancelTask`，断言它永不执行、状态为 `cancelled`、不出现在执行序列。
3. **打断插队**：提三条（A 跑，B、C 排队），对 C 调 `interruptWith`，断言：A 被 `cancelled`、C 紧接着跑、B 之后跑（C 插到 B 前）。
4. **停止续跑**：A 跑、B 排队，`cancelTask(A)`，断言 B 随后自动执行。

## 受影响文件清单

- `src/service/session/manager.ts`（队列结构、pump、cancelTask、interruptWith）
- `src/service/ipc/dispatcher.ts`、`src/main/service-client.ts`、`src/main/ipc/swarm-ipc.ts`、preload、renderer query hook（interruptWith 贯通）
- `src/renderer/src/components/chat-input.tsx`（发送键恢复始终发送）
- `src/renderer/src/components/composer-overlay.tsx`（排队卡片）
- `src/renderer/src/components/views/tasks-view.tsx`（区分 running/queued + 接线）
- 运行中任务卡片处的停止键（落点随现有渲染确定）
- `src/service/session/manager.test.ts`（4 个用例）
