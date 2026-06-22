# 设计:Agent 集群 —— 常驻虚拟 actor(持久 run-loop,计划 B)

> 状态:已通过 brainstorming 评审,待用户最终确认。
> 日期:2026-06-22
> 关联:[`docs/research/long-lived-agent-entities.md`](../../research/long-lived-agent-entities.md)(§4.3 方案 B);[`2026-06-22-agent-cluster-actor-substrate-design.md`](./2026-06-22-agent-cluster-actor-substrate-design.md)(actor 基石总设计,§4.5 即本计划);计划 A 已合并到 `develop`(commits `b3f7cb7`..`229977d`)。

---

## 1. 目标与动机

计划 A 让 Agent 可寻址、能互发消息,但**每条消息都把目标 actor 当一次性 run 激活、跑完即弃**。这留下了三个已知缺陷(计划 A 文档已记):

1. **死锁**:一个 activation 全程占用一个并发槽,嵌套的 `send_and_wait`(rpc)再抢第二个槽;rpc 链深于 `maxConcurrent`、或两 actor 互发 rpc,会永久锁死(继承自既有 `spawnChild` 嵌套行为)。
2. **fire-and-forget 崩溃孤儿**:`kind:'send'` 的消息仅在异步 activation 完成后才标记 consumed;进程崩在中途 → 消息停在 `consumed=0, dead=0`,因无 run-loop 重新 drain 而被静默遗弃。
3. **`correlationId` 落库但未用**:rpc 回信靠内联 await,关联列形同虚设。

计划 B 把一次性 activation 升级为**常驻虚拟 actor + 收件箱循环**,一举解决上述三点,并为场景③(事件驱动低延迟)、一次协作爆发内的连贯多轮打底。

### 设计哲学(不变量)

延续「无状态推理 + 外化状态、崩溃可恢复」:常驻 actor 仍可随时销毁;休眠/崩溃后从 SQLite 未消费消息重建。本计划采用研究文档 §4.3 的**虚拟/持久化 actor**。

---

## 2. 范围(brainstorming 已拍板)

| 决策 | 选择 | 理由 |
|---|---|---|
| 存活模型 | **常驻 + 空闲超时休眠** | 同一 agent 实例跨消息保留上下文(自然累积),空闲(默认 30s)销毁;重放成本低、体验连贯 |
| 并发模型 | **turn-slot:槽=正在跑的 LLM turn,阻塞时让出** | 空闲/等信的 actor 不占槽;`send_and_wait` 等回信时让出槽 → 从根上消除死锁 |
| 回信语义 | **隐式:消息 turn 的结果即 rpc 回信**(经 `correlationId` 路由) | 延续计划 A,不引入显式 `reply` 工具 |
| session 队列 | 顶层用户对话 turn **仍串行**;actor activation **并发**(仅受 turn-slot 限) | 解锁兄弟 actor 并行协作,同时保住用户主线程顺序 |
| **跨休眠状态恢复** | **不做,留给阶段 3(场景④,`actors.state`)** | Plan B 仅保「一次常驻期内」记忆;跨休眠长期记忆需按 address 持久化对话 + 重放 + 上下文压缩,是独立一块,依赖尚未做的压缩 |
| **常驻 actor ↔ Task 粒度** | **一次常驻期 = 一个 Task + 一个 agent**;多条消息是该 Task 下的 turn,共享一个 budget 包络 | agent 的 `task.id`/emit/budget 绑定在整次常驻期固定,无需逐 turn 重绑 → 实现大幅简化;上下文自然累积。actor 休眠(空闲超时)→ 该 Task 标 completed;再激活 = 新 Task |

### 非目标(YAGNI)

- **不做**跨休眠对话恢复 / `actors.state` 读写(阶段 3)。
- **不做**显式 `reply` 工具(隐式回信足够)。
- **不做**上下文压缩(off-the-shelf,独立)。
- **不引入**第二个 ReAct 循环(pi 内层已提供)。
- 不重构与本目标无关的代码。

---

## 3. 现状基线(被改动的代码)

- `src/service/agent-runner.ts`
  - `run()`(`:120` 起,主体在 `~:300-650`):建一个 pi `Agent`,`await agent.prompt(task.goal)` 跑完整 ReAct 到底,返回 `{status, summary, messages, used}`。**一次 `run()` = 一次 prompt 到完成。** agent-setup(`Agent` 构造、tools、model、event translator、budget 守卫、`beforeToolCall`)约 250 行内联在 `run()` 中。
  - `buildToolContext(deps)`(`:132`):已抽出,组装 `ToolRunContext`(含 `sendMessage`/`sendAndWait` 桥)。
  - `AgentRunnerDeps`(`:88`):有 `signal`、`saveSnapshot`、`spawnChild`、`selfAddress`、`sendMessage`。
- `src/service/session-manager.ts`
  - `acquireSlot`/`releaseSlot` + `activeRunners`/`waitQueue`(`~:115-128`):全局信号量,`maxConcurrent`。
  - `runHandles: Map<taskId, AbortController>`(`:113`):只 abort,非投递通道。
  - `activateActor`(计划 A 新增):创建子 task、`acquireSlot`、建 runner、`run()` 一次、释放槽。
  - `sendMessage`(计划 A):rpc = activate-and-await(内联);fire-and-forget = activate-不-await;未知地址 dead-letter。
  - `session.queue`(`:46`):每 session 一条串行 Promise 链,顶层 turn 顺序执行。
- `src/service/conversation-store.ts`
  - `actors` / `messages` 表 + CRUD(计划 A):`upsertActor`/`getActor`/`getActorByName`/`enqueueMessage`/`nextUnconsumedFor`/`markConsumed`/`markDead`/`bumpRetries`。
  - `getInterruptedSessions`/`markAndGetInterrupted`(`:376`):启动时把遗留 `active` session 标 interrupted —— 崩溃重放扫描的样板。

> **实现前置动作**:本计划基于当前 `develop`(计划 A 刚合并)。开工先核实上述 `run()` 主体行号与 `activateActor`/`sendMessage` 现状,以实际代码为准。

---

## 4. 架构设计

### 4.1 agent-setup 抽取 + 常驻循环(组件 1)

把 `run()` 内 ~250 行 agent-setup 抽成可复用核心(纯重构,不改一次性 `run()` 的外部行为):

- **`buildAgentSession(deps): AgentSession`** —— 建一个 pi `Agent` + 其 budget 守卫/event translator/stop 处理,暴露:
  - `promptOnce(goal, images?): Promise<{ status, summary }>` —— 跑一个 turn(一次 `agent.prompt`)到完成。
  - `agent`(底层实例,`state.messages` 跨 `promptOnce` 累积)。
- 一次性 `run()`(顶层用户任务 / 旧式 spawnChild):`buildAgentSession(deps).promptOnce(task.goal)` 后返回 —— 行为不变。
- **常驻 `runResident(deps, mailbox)`**(新):

  ```
  const sess = buildAgentSession(deps)   // 建一次,跨消息复用
  loop:
    const msg = await mailbox.receive({ idleMs: IDLE_TIMEOUT })  // 空 → 休眠;超时 → 抛 IdleTimeout
    acquireTurnSlot()
    try {
      const { summary } = await sess.promptOnce(msg.payload)
      store.markConsumed(msg.id)
      if (msg.kind === 'rpc' && msg.correlationId)
        replyRegistry.resolve(msg.correlationId, summary)
    } finally { releaseTurnSlot() }
  // IdleTimeout / session 结束 / abort → 退出循环,销毁(从 runHandles 删除)
  ```

- `IDLE_TIMEOUT` 默认 **30_000ms**(常量,可后续配置)。

### 4.2 激活管理器 + mailbox(组件 1 续)

- `runHandles` 升级:`Map<address, { abort(): void; deliver(msg: ActorMessage): void; kind: 'resident' | 'oneshot' }>`。一次性 task 仍按 taskId 注册(`kind:'oneshot'`,沿用 cancel 路径);常驻 actor 按 address 注册(`kind:'resident'`)。
- **mailbox**(内存,每常驻 actor 一个):`{ deliver(msg), receive({idleMs}): Promise<ActorMessage> }`。`deliver` 把消息推入内存队列并唤醒等待者;`receive` 队列空时挂起,超过 `idleMs` 无消息则 reject `IdleTimeout`。
- `send(addr, msg)`(改造 `sendMessage` 的投递部分):
  1. `store.enqueueMessage(...)`(入库,dead=!target)。
  2. 查 `runHandles[addr]`:有常驻循环 → `deliver(msg)`;无 → 拉起 `runResident`(它首轮 `receive` 立刻拿到刚 enqueue 的消息;**注意**:为避免竞态,拉起时先从库 `nextUnconsumedFor` 预载,再进循环)。
  3. 未知地址 → 标 dead + `warn`(不变)。

### 4.3 turn-slot 并发(组件 2)

- `acquireSlot`/`releaseSlot` 语义不变(全局信号量),但**获取时机收窄**:从「activation 全程」改为「每次 `promptOnce` 前获取、后释放」。空闲/等信的常驻 actor 不持槽。
- `send_and_wait`(rpc 调用方):它在某个 actor 的 turn 内执行(该 turn 持槽)。流程:
  1. enqueue rpc 消息(`correlationId = msgId`)。
  2. `replyRegistry.awaitReply(correlationId)` 注册等待。
  3. **释放调用方 turn-slot**(关键:阻塞期间不占并发)。
  4. `await` 回信(或超时)。
  5. **重获 turn-slot**,把 reply 作为工具结果返回给 agent loop。
- 不变式:同时进行的 `agent.prompt` 数 ≤ `maxConcurrent`;被阻塞(等 rpc 回信)的 turn 不计数 → **永不死锁**。
- 旧式 `spawnChild`:同样改为「子 turn 跑时持槽、父等待时让出」,顺带消除其既有嵌套死锁。

### 4.4 回信路由(组件 3)

- **`ReplyRegistry`**(仿 `src/service/...` 的 `AskRegistry`/`PermissionRegistry`):
  - `awaitReply(correlationId, timeoutMs): Promise<string>` —— 注册一次性等待,超时 reject。
  - `resolve(correlationId, payload): void` —— 投递回信、唤醒等待者;无等待者(调用方已销毁)→ 丢弃 + `warn`。
- 常驻循环处理完一条 `kind:'rpc'` 消息后,把该 turn 的 `summary` 经 `correlationId` `resolve` 回去。
- `correlationId` 列从此被读;一次性 `activateActor` 的内联 rpc 路径迁移到此机制。
- **超时**:`send_and_wait` 注册 `awaitReply` 时带超时(默认取 rpc 子任务的 `budget.wallMs` 或一个上限),超时 → 工具返回 timeout 文本,调用方不永久阻塞。

### 4.5 崩溃重放(组件 4)

- 启动时(与 `getInterruptedSessions` 并列,在 `createSessionManager` 初始化处):扫描 `messages` 中 `consumed=0 AND dead=0`,按 `to_addr` 去重,对每个目标地址拉起 `runResident` drain。
- 重放的 rpc 消息:原调用方进程已不在 → `replyRegistry` 无等待者 → 回信 `resolve` 时丢弃 + `warn`(可接受:崩溃前的调用方上下文已不存在)。
- 修复计划 A 的 fire-and-forget 孤儿:这些消息现在会被启动 drain 重新处理。
- **重试/死信**:`promptOnce` 抛错时 `bumpRetries(msg.id)`;超过上限(默认 3)→ `markDead` + `error` 日志,不无限重试。

### 4.6 session 队列交互(组件 5)

- **顶层用户对话 turn**(`submitGoal` → `session.queue.then(runTurn)`):不变,串行,保住用户主线程顺序。
- **actor activation(来自 mailbox)**:**不**进 `session.queue`;并发执行,仅受 turn-slot 信号量约束。这是解锁兄弟 actor 并行协作的关键。
- 二者共享同一个 `maxConcurrent` 信号量(turn-slot),所以总 LLM 并发仍有统一上限。

---

## 5. 数据流

### 兄弟 rpc(辩论/委派,并发版)
A 的 turn 调 `send_and_wait(B,...)` → enqueue rpc(correlationId) → A 让出 turn-slot、await → B 的常驻循环 `receive` 到消息 → 取 turn-slot → `promptOnce` → `replyRegistry.resolve(correlationId, summary)` → A 重获槽、拿到 reply 继续。A、B 的 turn 在不同时刻各自持槽,互不阻塞。

### 事件驱动(场景③雏形)
外部 `send(addr, event)` → 入库 → 若 addr 休眠则拉起常驻循环 → drain → 处理完空闲 30s → 休眠。低延迟(活着的 actor 直接 `deliver` 唤醒,无需重建)。

### 崩溃恢复
重启 → 扫未消费消息 → 按地址拉起常驻 drain → 继续处理;rpc 回信无主则丢弃。

---

## 6. 错误处理 / 边界

| 情况 | 处理 |
|---|---|
| `promptOnce` 抛错 | `bumpRetries`;超上限 → `markDead` + `error`;否则消息留待重试 |
| rpc 回信无等待者(调用方已销毁/崩溃) | `replyRegistry.resolve` 丢弃 + `warn` |
| rpc 超时 | `send_and_wait` 返回 timeout 文本,调用方不永久阻塞 |
| 空闲超时 | 常驻循环退出、销毁;未来 send 再拉起 |
| abort / session 结束 | `runHandles[address].abort()` 终止当前 turn + 退出循环 |
| 拉起竞态(send 与 receive 抢同一首消息) | 拉起时先 `nextUnconsumedFor` 预载;`markConsumed` 是幂等终态,重复处理由 consumed 标记防住 |
| turn-slot 让出后重获时无空槽 | 正常排队(`waitQueue`);不死锁,因被阻塞者已让出 |

全程结构化日志(CLAUDE.md §5,`component:'actor-runtime'` / `'mailbox'` / `'reply'`):`resident-start` / `receive` / `turn-start` / `turn-end` / `reply-resolve` / `reply-orphan` / `idle-sleep` / `redrain` / `deadletter` 各打点,带 `address`、`correlationId`、`msgId`。每个 `catch` 至少 `error`。

---

## 7. 测试策略(TDD)

- **mailbox**:deliver/receive 唤醒;空闲超时 reject。
- **turn-slot**:槽在 `promptOnce` 前后获取/释放;阻塞让出后他者可获槽。
- **死锁回归(核心)**:`maxConcurrent=1` 下,A `send_and_wait` B、B 也回应 —— 不死锁(stub agent)。深度 > maxConcurrent 的 rpc 链完成。
- **回信路由**:`ReplyRegistry` resolve 唤醒;超时;无主回信丢弃。
- **常驻上下文累积**:同一常驻期内,第二条消息的 prompt 能看到第一条的 `agent.state.messages`(stub agent 记录收到的历史)。
- **空闲休眠**:无消息 30s(用可注入的假时钟/短超时)→ 循环退出、`runHandles` 删除。
- **崩溃重放**:预置未消费消息 → 启动 → 被 drain。
- **回归**:一次性 `run()` / 顶层 `submitGoal` / 旧式 `spawnChild` 行为不变;计划 A 的 messaging 测试在新机制下仍绿。

> 经 Electron node 运行:`npm test`(勿裸 `npx vitest`;勿 `pnpm rebuild better-sqlite3`)。`src/service/**` 不在 typecheck 范围,靠 vitest 兜类型。假时钟用于空闲超时测试,避免真实等待。

---

## 8. 文件结构(实现指引)

- **修改** `src/service/agent-runner.ts` —— 抽 `buildAgentSession`;`run()` 改为薄封装;新增 `runResident(deps, mailbox)`。这是最大改动,需保一次性路径零回归。
- **新增** `src/service/actor-mailbox.ts` —— `createMailbox()`(deliver/receive + idle 超时);纯内存、可单测。
- **新增** `src/service/reply-registry.ts` —— `createReplyRegistry()`(awaitReply/resolve + 超时);仿 AskRegistry。
- **修改** `src/service/session-manager.ts` —— `runHandles` 升级为按 address;`send`/`sendMessage` 接 mailbox + 拉起常驻循环;`acquireSlot` 收窄到 turn 粒度;启动崩溃重放扫描;`send_and_wait` 让出/重获槽 + 接 ReplyRegistry。
- **可能修改** `src/service/index.ts` —— 注入/初始化崩溃重放。
- 这些文件较大,改动需外科手术式、保持现有 factory+closure 风格。

---

## 9. Roadmap 之后

- **阶段 3 — 场景④ 跨休眠长期状态**:激活时从 `actors.state`(计划 A 预留列)重放该 actor 的对话历史,休眠时持久化;配套上下文压缩(off-the-shelf:pi 的 `compact`/`shouldCompact`)。依赖本计划的常驻循环。
- **涌现式公司原型**:计划 B 后,常驻 + 并发 + 同辈 rpc 已足以让一组 AgentDefinition(CEO/team-lead/角色)真正并行协作。

---

## 10. 实现注意

- 按 CLAUDE.md §6,在专用 git worktree 的独立分支实现(基于 `develop`)。
- 死锁回归测试是本计划的验收核心 —— 先写它,确保新并发模型真的解锁。
- `buildAgentSession` 抽取若导致一次性 `run()` 行为漂移,即为缺陷:一次性路径的所有现有测试必须零回归。
