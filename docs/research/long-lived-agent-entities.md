# 关于「长期存活的 Agent 实体」的研究笔记

> 整理自一段架构讨论。主题:SwarmAgents 当前多 Agent 是如何实现与沟通的、"长期存活 vs 临时" 到底指什么、上下文与 memory 的作用域,以及如何引入 actor 模型的「可寻址 + 收件箱」来解锁同辈通信。
>
> 配套生成的三张图(同目录,可直接在浏览器打开):
> - [`swarm-multiagent-flow.html`](./swarm-multiagent-flow.html) —— **时序**:一次委派的调用/返回流
> - [`swarm-lifespan.html`](./swarm-lifespan.html) —— **结构**:长期存活 vs 短命的所有权关系
> - [`swarm-task-lifecycle.html`](./swarm-task-lifecycle.html) —— **状态**:单个 Task 的状态机

> **更新(2026-06,详见 [`openclaw-vs-swarm-lifecycle.md`](./openclaw-vs-swarm-lifecycle.md) §7)**:本笔记写于 actor 落地前。§4.3「B. 虚拟/持久化 actor」方案此后**已实现**(`spawnResident`/`runResident`/`createMailbox` + `actors`/`messages` 表)。但后续推导表明:**对当前「涌现软件公司」spec,完整 actor 是过度工程**——同步协作经父中介即足;§4.4/§5 所列「解锁同辈通信」应读作**前置投资,而非当前必需**。结论摘要见本文末 §6。

---

## 1. 当前多 Agent 的实现与沟通

**核心抽象是 Task 树,而非常驻 Agent。** 每个 "Agent" 就是一次性的 `AgentRunner`,跑完一个 `Task` 就结束。`Task` 带 `parentId`(`src/shared/types/task.ts:108`),所有任务构成一棵树:顶层任务由 `submitGoal` 产生(`parentId: null`),子任务由运行中的 Agent 派生。底层执行引擎是 `@earendil-works/pi-agent-core`,`AgentRunner` 把 pi 的 agent loop 包一层,翻译成 `emit(event, data)`。

**编排者是 SessionManager**(`src/service/session-manager.ts`):
- 一个 Session = 一条串行队列(`session.queue = session.queue.then(runTurn, runTurn)`)。
- 并发由信号量控制(`acquireSlot / releaseSlot` + `maxConcurrent`,`:97-112`)。
- 可中断:每个运行挂一个 `AbortController` 存进 `runHandles`,`cancelTask` 按 taskId 精准 abort(`:356`)。

**沟通方式是「函数调用 + 返回值」,不是消息总线。** 这是关键:

```
父 Agent (LLM)
  └─ 调 agent.* 工具 → ctx.spawnChild(goal, tools, provider, agentType)
       └─ SessionManager.spawnChild()   [session-manager.ts:146]
            1. 建子 Task(parentId = 父),持久化
            2. broadcast 'task.handoff.spawned'
            3. acquireSlot → 新建 AgentRunner → await runner.run()
            4. resolve({ childTaskId, result: { summary, artifacts } })
       ← summary 字符串作为"工具结果"回到父 Agent 的上下文
```

即:**父把一个 goal 字符串传下去,子把一个 summary 字符串传上来**(`spawnChild` 签名见 `src/service/agent-runner.ts:103`,实现见 `session-manager.ts:146-223`)。

约束:
- **没有同辈通信**:兄弟子 Agent 不能直接对话,一切协调经过共同父节点(严格树形委派,类似 Claude Code 的 subagent)。
- **上下文隔离**:子任务拿到 `initialMessages: []`(`session-manager.ts:209`),看不到父对话历史,只有 goal 跨越边界。
- **递归派生**:`spawnChild` 一路向下传(`:211`),子 Agent 也能再 spawn 孙。
- **会话内共享**:`permissionRegistry`、`askRegistry`、`toolRegistry`、`provider` 整会话共享 → 权限确认 / 向人提问汇聚到同一 UI。
- **预算分账**:顶层用 `budgets().main`,子任务用 `budgets().sub`。

---

## 2. 「长期存活的 Agent 实体」是什么意思

### 2.1 推理层:LLM 永远无状态

每次都是 `f(context) → tokens`,没有"活着"的模型实例;所谓"记忆"就是这次塞进 context 的历史。**在这一层,长期存活 Agent 和临时 Agent 没有区别**——两者都得把历史重新拼进 prompt 再发一次 API。"活着不过是带记忆的 prompt" 在推理边界上成立。

所以"没有长期存活的 Agent 实体" **指的不是模型**,而是模型外面那层**运行时对象**(`AgentRunner` 这个对象 / 控制循环)。区别只在这一层。

### 2.2 运行时层:到底差什么

"长期存活" 指那个包裹 LLM 的**运行时实体在两次 LLM 调用之间是否持续存在、且可被寻址**。一个真正长期存活的 Agent(actor 模型)有四样临时 Agent 没有的能力:

| 能力 | 长期存活 Agent | SwarmAgents 临时 Runner |
|---|---|---|
| **可寻址 / 收件箱** | 有 address,空闲时别人也能随时发消息唤醒它 | 没有。`run()` 返回后对象即弃,没有"对方"可寄信 |
| **进程内活状态** | 能持有不可序列化的东西:浏览器会话、websocket、子 Agent 句柄 | 必须全部外化(`ToolStateManager`、SQLite 快照),否则丢失 |
| **主动性** | 自带循环,可定时醒来、监听事件、不被提示就行动 | 只在被 goal / cron **创建出一次新 run** 时才存在 |
| **并发 / 重入** | 处理 mailbox,有"忙/闲"概念,会排队消息 | 一条线性的 `run()`,跑完即终 |

### 2.3 诚实的结论:对回合制系统而言二者功能等价

对一个**回合制、由任务触发、不需要同辈中途对话**的系统,临时 Agent 和长期 Agent **功能上等价**:把消息数组留在内存里复用,和销毁后从 SQLite 重建再喂给模型,LLM 看到的 context 一模一样。

SwarmAgents 故意选临时模型,用它换两样:
- **崩溃可恢复**:运行时不存状态,中断只需 abort 这次 `run()`,重启从库重放;
- **简单**:省掉 mailbox、生命周期管理、"消息发给已死 Agent 怎么办"那一整套。

代价正是上表那四样能力的缺失。由此自然掉出两个结论:**无同辈通信**(没有活着、可寻址的兄弟能收信)、**状态必须外化**(承载状态的对象本身不持久)。

> 更准的重构:**整个系统 = 无状态推理 + 外化状态,"Agent" 只是对这二者的一次性循环封装。**"长期 vs 临时" 不是模型的属性,是那层封装活多久、能不能被找到的属性。

---

## 3. 上下文与 memory 的作用域

| 维度 | 作用域 | 依据 |
|---|---|---|
| 顶层对话上下文 (`agent_snapshot`) | **per-session**(一份 messages,跨该 session 所有 turn 累加) | `session-manager.ts:31, :310-313`;`conversation-store.ts:75` |
| 权限 / 提问 / 工具状态 (`tool_state`) | **per-session** | `conversation-store.ts:106`(`session_id` 主键) |
| 子 Agent 上下文 | **隔离**(空起点,不写回 session) | `session-manager.ts:209`(无 `saveSnapshot`) |
| 子 Agent 任务事件 | per-task 持久化(供回放),非会话上下文 | `task_events` / `tasks.history` |
| **memory(`remember`/`recall`)** | **全局 · 跨 session 共享** | 见下 |

**memory 是全局的,不按 session 分:**
- `MemoryStore` 是进程级单例,一个 `memoryPath` JSON 文件(`src/service/index.ts:45`)。
- 工具刻意不绑 session:`src/service/tools/memory.ts:91-93` 注释 "build() ignores the per-task context";`build(ctx)` 没用 `ctx.sessionId`。
- 隔离维度是自由的 `namespace` 参数,默认 `'default'`(`memory.ts:6`),由模型自己填;没有任何代码把 sessionId 当 namespace 注入。

推论:memory 是当前架构里**唯一天然跨 session 流动的状态通道**。想要"每个 session 私有记忆"得手动把 `sessionId` 当 namespace 传(或在工具层强制注入);想做"跨 session 长期画像"则现成可用。

### Task 状态机的「名实之差」

`Task['status']` 定义了 10 个值,但真实被事件驱动的只有主线;UI 还会归并显示:
- `planning · dispatched · paused` → UI 归并为 `running`(`src/renderer/src/lib/replay.ts:10-14`);
- `interrupted` 由重启标记,UI **视作 `failed`** 呈现(`replay.ts:18`)。
- 真实转移在 `src/renderer/src/lib/apply-event.ts`:`created→pending`、`task.dispatched→running`、`permission_request/ask→awaiting_user`、`task.complete→completed`、`task.error(cancelled)→cancelled / 否则 failed`。

---

## 4. 可寻址(addressable)与收件箱(mailbox)

### 4.1 概念

- **可寻址**:每个 Agent 有稳定地址(id),持有地址的人就能寄信,**与它此刻是否在运行无关**。运行时负责送达,或在它没活着时先存起来、按需唤醒。
- **收件箱**:挂在地址背后的消息队列。寄来的消息入队,Agent 循环逐条取出处理(一次一条 → 无内部数据竞争)。空队列时停在"等信",来信才醒。这是 actor "长期存活 + 反应式" 的来源。

```
loop {
  msg = mailbox.receive()   // 队列空时阻塞
  处理 msg(可能改状态、可能向别的地址 send 回信)
}
```

对比当前 Runner:`run()` 跑完一个 goal 就退出,没有"停下来等信",所以无处可寄。

### 4.2 当前代码里的两个雏形

1. **taskId 是 id,但不是地址**:`runHandles: Map<taskId, AbortController>`(`session-manager.ts:97`)只能 `abort()`——遥控开关,不是投递通道。
2. **`AskRegistry` / `PermissionRegistry` 是"单次收件箱"**:Agent 调 `askUser` 后阻塞,外部 `resolveAsk(sessionId, askId, answer)` 投递唤醒(`session-manager.ts:352`)。结构上就是按 id 寻址的一次性 inbox,只是:① 必须先主动问才能收(pull 非 push);② 一次性、不排队;③ 收件人是人,不是 Agent。

把这个模式推广成"可被别人主动 push、可排队、多条、收件人是 Agent 地址"的持久队列 = 真正的 mailbox。

### 4.3 如何实现

**A. 常驻 actor(简单,但丢掉崩溃恢复)** —— Runner 不退出,跑完 goal 停在 `mailbox.receive()`:

```ts
function createMailbox<T>() {
  const queue: T[] = []
  let wake: (() => void) | null = null
  return {
    send(msg: T) { queue.push(msg); wake?.(); wake = null },
    async receive(): Promise<T> {
      if (queue.length === 0) await new Promise<void>(r => { wake = r })
      return queue.shift()!
    },
  }
}
```

全局 `Map<address, Mailbox>`,`send(addr, msg)` 查表投递。代价:Runner 永不释放,状态全在内存 → 回到"长期存活"的权衡。

**B. 虚拟 / 持久化 actor(推荐,保住崩溃恢复)** —— 最贴合当前架构(沿用"状态外化 + 按需重建"哲学):

- 地址持久;收件箱是 SQLite 一张表:
  ```sql
  CREATE TABLE messages (
    id TEXT PRIMARY KEY, to_addr TEXT NOT NULL, from_addr TEXT,
    payload TEXT NOT NULL, ts INTEGER NOT NULL, consumed INTEGER DEFAULT 0
  );
  CREATE INDEX idx_messages_to ON messages(to_addr, consumed);
  ```
- **投递即"激活"**:`send(addr, msg)` 先入库;若该地址没有活着的 Runner,SessionManager 临时创建一个(从 store 重放上下文),喂入未消费消息,跑到 idle 再休眠(销毁 Runner,消息和状态已落库)。

落地清单(在现有结构上加,不推翻):
1. 加 `messages` 表 + send/poll 接口(沿用 `conversation-store.ts` 的 prepare-statement 写法)。
2. 把 `runHandles` 从 `Map<id, AbortController>` 扩成 `Map<address, { abort, deliver(msg) }>`。
3. 加一个 `send_message(to, payload)` 工具到 `agent` 组(与 `spawnChild` 并列)。
4. 激活管理器:`send` 时若无此地址的 Runner → 入库 +(可选)拉起 Runner 重放上下文(复用 `acquireSlot`/spawn 那条路)。
5. Runner 循环改造:处理完当前消息后不直接 return,而 `await mailbox.receive()`(B 方案下:查库,无未消费消息则休眠退出,下次 send 再激活)。

### 4.4 它解锁什么 + 待定的设计岔路

- **解锁同辈通信**:有了地址 + 收件箱,子 A 可 `send(B_address, ...)` 直接寄给兄弟 B,不必经父中转。
- **第一个真正的岔路 = 消息语义**:是"激活并等回信"的 RPC 式(像现在的 `spawnChild`),还是"投递即走、异步处理"的 fire-and-forget?这决定整套 API 的形状。

---

## 5. 何时需要从临时模型升级

只要出现以下需求,临时模型就不够,需要引入 mailbox / 共享黑板 / 长期 actor:
- **同辈通信**(并行 fan-out 的兄弟之间互相协调);
- **主动性 / 常驻监听**(不被提示就行动的 Agent);
- **不可序列化的进程内活状态**(长连接、跨多轮的复杂内存结构)。

当前架构没有这些需求,所以临时模型是恰当选择。要往这些方向走,应正式进入设计(brainstorming → spec → plan)。

---

## 6. 后续修正:actor 对当前 spec 是过度工程(2026-06 摘要)

> 完整推导(树 → resumable subagent → actor 的能力边界与代价)见 [`openclaw-vs-swarm-lifecycle.md`](./openclaw-vs-swarm-lifecycle.md) §7;此处只同步结论。

§4.3「B 方案」此后已落地(phase 3 合并),但「涌现软件公司」原型(CEO→PM→{engineer, reviewer},全同步 `send_and_wait`,PM 编排,产出落盘)的实际需求,经复核**并不要求**完整 actor:

- **「有环」不需要可寻址**:PM↔engineer↔reviewer 的迭代是 **PM 控制流里的循环**(星型拓扑),一棵树的父节点写个 `loop` 即可;不是通信图的环。
- **「跨调用保留上下文」不需要 mailbox**:resumable subagent(给 child 稳定 id + 持久化 messages + resume 灌回 `initialMessages`,= OpenClaw `resumeSessionId`)完全等价,且复用现成一次性路径——而 actor 的同步 `send_and_wait` 是架在 mailbox+resident loop+replyRegistry 之上的,代码量差一个数量级。
- **产出落盘进一步弱化**:engineer 修复轮直接读文件即可重建上下文,对话记忆只是锦上添花(呼应本文 §2.3「无状态推理 + 外化状态」)。

**actor 唯一比 resumable subagent 多出来的,只有 §2.2 表的最后两行**——非中介点对点通信、事件驱动空闲唤醒——而当前 spec 两者都不需要。

**结论与行动**:不拆(已建好、有测试),但**冻结 actor 异步部分的继续投入**,原型用其同步 rpc 子集跑通。**重判触发条件**:出现「A 不经共同祖先直接给 B 发消息」或「agent 跑完不死、被外部事件异步唤醒」→ actor 回本,激活异步能力;长期不出现 → 下版本评估把 rpc 降级为 resumable subagent、砍掉 mailbox。
