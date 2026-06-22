# 设计:Agent 集群 —— 可寻址 + 持久化收件箱(actor 基石)

> 状态:已通过 brainstorming 评审,待用户最终确认。
> 日期:2026-06-22
> 关联:[`docs/research/long-lived-agent-entities.md`](../../research/long-lived-agent-entities.md)(第 4 节给出本方案的原始构想);记忆 `project_actor_model_direction` / `project_agent_env_blueprint`。

---

## 1. 目标与动机

终极目的:把 SwarmAgents 变成一个 **Agent 集群** —— 很多 Agent 互相协助完成复杂任务。用户明确要求下列四类场景**全部**可实现:

1. **一次性拆解并行** —— 大任务拆成独立子任务,并行执行,汇总。
2. **多 Agent 辩论/质疑** —— 多个 Agent 对同一问题各出方案、看到彼此输出、互相质疑迭代。
3. **持续运行/事件驱动** —— 集群常驻,监听数据源/事件自动触发 Agent;或用户随时丢任务进去。
4. **长期协作有状态** —— Agent 间跨多轮共享演进的中间状态(不只是 summary 字符串)。

### 关键洞察

只有场景 ① 被当前架构覆盖(`spawnChild` 树状委派)。场景 ②③④ **全部卡在同一缺失能力上**:可寻址 Agent + 持久化收件箱(actor 基底)。因此这不是四个独立项目,而是**一块基石 + 三个特性层**:

| 场景 | 当前 | 真正缺的底座 |
|---|---|---|
| ① 一次性拆解并行 | ✅ 已能 | 无,仅打磨 |
| ② 辩论/质疑 | ❌ | 同辈通信(`send_message` / 共享黑板)|
| ③ 事件驱动 | ❌ | 可寻址 + 投递即激活 |
| ④ 长期有状态 | ❌ | 持久 actor(状态落库,来信重建)|

**本 spec 只覆盖阶段 0(actor 基石)+ 场景① 打磨。** 阶段 1–3 各自独立成 spec(见 §8 roadmap)。

### 设计哲学(不变量)

沿用现有架构的「**无状态推理 + 外化状态**」哲学:运行时对象(`AgentRunner`)仍可随时销毁、从 SQLite 重建。本方案采用研究文档第 4.3 节的 **B「虚拟/持久化 actor」**,而非常驻内存 actor —— 因此**保住崩溃可恢复**,且**不推翻**现有树状委派,只在旁边新增能力。

---

## 2. 现状基线(被改动的代码)

- `src/service/session-manager.ts`
  - `runHandles: Map<taskId, AbortController>`(`:113`)—— 只能 `abort()`,是遥控开关,不是投递通道。
  - `spawnChild`(`:162`)—— 父→子同步委派:建子 Task、`acquireSlot`、新建 `AgentRunner`、`await runner.run()`、把 `summary` 字符串作为工具结果回填父上下文。`initialMessages: []`(子上下文隔离)。
- `src/service/agent-runner.ts`
  - `AgentRunner.run()`(`:110`)—— 跑完一个 goal 即 return,没有「停下来等信」。
  - `spawnChild` 回调签名(`:101`)。
- `src/service/conversation-store.ts` —— SQLite 持久化层(prepared-statement 写法,本方案沿用)。
- `src/service/tools/spawn.ts` / `builtins.ts` —— `agent.*` 工具组(`spawnChild` 暴露给 LLM 的入口)。
- `AskRegistry` / `PermissionRegistry`(`session-manager.ts`)—— 已是「按 id 寻址的一次性 inbox」(`askUser` 阻塞 → 外部 `resolveAsk` 投递唤醒),是 RPC 关联机制的现成模板。

### 场景① 已知缺陷(本阶段顺带修复)

- `dispatcher.submitGoal` 丢弃 `agentDef` → UI 创建的任务永远是 `default`。
- `spawnChild` 硬编码 `agentDefId:'default'` + 固定 allowlist(注:研究记忆所述,需对照当前代码核实——当前 `spawnChild` 已支持 `agentType` 参数,缺陷主要在 `submitGoal` 链路丢 `agentDef`)。

> **实现前置动作**:核实上述缺陷在当前 `develop` 上的真实状态(记忆为 3–8 天前快照),以实际代码为准。

---

## 3. 决策汇总(brainstorming 已拍板)

| 决策 | 选择 | 理由 |
|---|---|---|
| 协作模型 | 持久/虚拟 actor 基石 + 特性层 | 四场景共享同一底座;保住崩溃恢复 |
| 消息语义 | **RPC + fire-and-forget 都要** | 辩论/委派用 RPC(等回信),事件驱动用 fire-and-forget(投递即走);`spawnChild` 是 RPC 的特例 |
| 地址形态 | **ULID(默认)+ 可选可读命名** | 系统内传句柄用 ULID;场景③外部触发需可读地址(如 `researcher-1`)|
| 兼容性 | 旧式无地址 `spawnChild` 保留原路 | 场景① 零回归 |

---

## 4. 架构设计(阶段 0)

### 4.1 地址模型 —— `Actor`

引入稳定身份概念,与「一次 run」解耦:

- **Actor = 一个长期身份**;**Task = 该 Actor 的一次激活(run)**。
- 新增 SQLite 表 `actors`:

  ```sql
  CREATE TABLE actors (
    address    TEXT PRIMARY KEY,   -- ULID 或用户/Agent 命名
    agent_def_id TEXT NOT NULL,
    session_id TEXT,               -- 归属 session(跨 session actor 可为 null)
    name       TEXT,               -- 可选可读名;唯一性在应用层校验
    state      TEXT,               -- JSON,场景④的演进状态;阶段0仅建列,暂不写
    last_task_id TEXT,
    created_at INTEGER NOT NULL,
    updated_at INTEGER NOT NULL
  );
  ```

- `spawnChild` 改造:不再隐式创建一次性身份,而是「创建/复用一个 Actor → 起一个 Task 跑它」。**不带地址的旧式调用**仍创建临时 actor(跑完不复用),保证向后兼容。

### 4.2 收件箱 —— `messages` 表

```sql
CREATE TABLE messages (
  id         TEXT PRIMARY KEY,
  to_addr    TEXT NOT NULL,
  from_addr  TEXT,
  kind       TEXT NOT NULL,        -- 'send' | 'rpc'
  correlation_id TEXT,             -- rpc 关联回信用
  payload    TEXT NOT NULL,        -- JSON
  consumed   INTEGER DEFAULT 0,
  retries    INTEGER DEFAULT 0,    -- 激活失败重试计数
  dead       INTEGER DEFAULT 0,    -- 死信标记
  ts         INTEGER NOT NULL
);
CREATE INDEX idx_messages_to ON messages(to_addr, consumed, dead);
```

沿用 `conversation-store.ts` 的 prepared-statement 写法,新增一个 `MessageStore`(或并入 conversation-store)。

### 4.3 激活管理器(投递即激活)

`runHandles` 从 `Map<taskId, AbortController>` 升级为 `Map<address, { abort(), deliver(msg) }>`。

`send(addr, msg)` 流程:
1. 消息入库(`consumed=0`)。
2. 查 `runHandles[addr]`:
   - **有活 Runner** → `deliver(msg)` 唤醒其内存 mailbox。
   - **无活 Runner** → 激活管理器:`acquireSlot` → 查 `actors[addr]` → 新建 `AgentRunner`,以 `Actor.state`(阶段0为空)+ 未消费消息重放为输入 → 跑到 idle → 休眠(销毁 Runner,状态已落库)。
   - **地址不存在** → 标记死信 + `warn` 日志(不抛)。

### 4.4 RPC 关联

`send_and_wait(to, payload)` = 投递一条 `kind:'rpc'` + 新 `correlation_id` 的消息,调用方阻塞等待对应回信。复用 `AskRegistry` 模式(按 id 寻址的一次性 inbox),收件人从「人」换成「Agent 地址」。被叫 Agent 处理完后向 `from_addr` 投递一条带同 `correlation_id` 的回信,解除调用方阻塞。超时 → 调用方拿到 timeout 结果,不永久阻塞。

`spawnChild` 在新模型下 = `send_and_wait` 到一个**新建临时 actor**的特例。

### 4.5 Runner 循环改造

`AgentRunner.run()`:跑完当前 goal/消息后**不直接 return**,改为 `await mailbox.receive()`:
- 查库有未消费消息 → 继续处理。
- 无 → 休眠退出(虚拟 actor:状态已落库,下次 `send` 再激活)。

这是从「临时 Runner」到「虚拟 actor」的核心改动。崩溃恢复不变:中断只需 abort 当前 run,重启从库重放未消费消息。

### 4.6 新增 LLM 工具(`agent.*` 组)

- `send_message(to, payload)` —— fire-and-forget。
- `send_and_wait(to, payload, timeoutMs?)` —— RPC,返回回信。
- `spawn(...)` —— 保留,语义不变(场景① 兼容)。
- 可选:`whoami()` —— 返回自身 address(供 Agent 把地址告诉同辈)。

---

## 5. 数据流

### 场景① 一次性拆解并行(回归路径,不变)
父 Agent 调 `spawn` → 临时 actor + Task → `run()` → summary 回填父上下文。

### RPC 委派 / 辩论雏形
Agent A 调 `send_and_wait(B, "评审这个方案")` → 投递 rpc 消息 → 激活 B(或唤醒)→ B 处理 → 回信带 correlation_id → A 解除阻塞拿到回信。

### fire-and-forget / 事件驱动雏形
外部/Agent 调 `send(addr, event)` → 入库 → 激活 addr 对应 actor 处理 → idle 休眠。地址不存在则死信。

---

## 6. 错误处理 / 边界

| 情况 | 处理 |
|---|---|
| 发给不存在地址 | 入库标记 `dead=1` + `warn` 日志,不抛 |
| 激活失败 | 消息保留 `consumed=0`,`retries++`;超限转死信 |
| RPC 超时 | 调用方拿到 timeout 结果对象,不永久阻塞 |
| 崩溃/重启 | abort 当前 run;重启从 `messages`(未消费)+ `actors.state` 重放 |
| 并发投递同一空闲 actor | 激活管理器对单地址串行化激活(同地址仅一个活 Runner),消息按 `ts` 顺序消费 |

全程结构化日志(遵循 CLAUDE.md §5,pino child `component:'mailbox'` / `'actor'`):`send` / `activate` / `deliver` / `consume` / `rpc-reply` / `deadletter` 各打点,带 `address`、`correlation_id`、`from_addr`。每个 `catch` 至少 `error` 级。

---

## 7. 测试策略(TDD)

- `MessageStore` CRUD:入库、查未消费、标记消费、死信、重试计数。
- 激活管理器:有活 Runner(`deliver`)/ 无活 Runner(拉起重放)两路;同地址并发投递串行化。
- RPC:关联回信解除阻塞;超时返回 timeout。
- 地址模型:ULID 自动分配、可读命名唯一性校验。
- 崩溃重放:重启后未消费消息被处理。
- **场景① 回归**:旧式 `spawnChild` 路径行为不变(summary 回填)。
- 缺陷修复回归:`submitGoal` 透传 `agentDef`。

> 测试经 Electron node 运行:`npm test`(勿用裸 `npx vitest`;勿 `pnpm rebuild better-sqlite3`)。注意 `src/service/**` 不在 tsconfig typecheck 范围,靠 vitest 兜类型错误。

---

## 8. Roadmap(后续独立 spec)

- **阶段 1 — 场景② 辩论**:在基石上加共享黑板或兄弟互发 `send_message`,加辩论编排模式(各出方案 → 互看 → 质疑 → 收敛)。
- **阶段 2 — 场景③ 事件驱动**:外部事件/数据源变化 → `send(可读地址, event)` 触发常驻 Agent;与 cron 子系统整合。
- **阶段 3 — 场景④ 长期有状态**:启用 `actors.state`,Agent 把演进状态落库,来信重建,实现跨多轮有状态协作。

### 「公司模式」(多团队/多职位)的归属

用户提出的「公司模式」(多个团队、每团队多职位、大任务拆成团队任务再拆给 agent)**不需要新的核心机制**:职位 = `AgentDefinition`,职责/权限 = `toolScope`,大任务拆解 = `spawnChild` 树状委派,跨角色沟通 = 本 spec 的 `send_message`/`send_and_wait`。

**决策(2026-06-22):走「涌现式原型」优先。** 计划 A 落地后,用「写对一组 AgentDefinition(CEO/各 team-lead/各角色)+ 调度 prompt」即可搭出可跑的公司原型——零新架构代码。团队边界/路由/成员关系靠约定涌现,**不**建一等 `Team`/Org 实体。

**延后(可选,gated)**:若涌现式验证后发现隐式结构不够(需可声明、可强制、可视化的组织架构 + 路由器 + 团队共享黑板 + 强制层级 allowlist),再单独起一份 **Org/Team 层 spec**,依赖本 actor 基石(计划 A/B)先就位。在此之前不投入——避免过早抽象。

---

## 9. 范围与非目标(YAGNI)

- **不做**常驻内存 actor(方案 A)——会丢崩溃恢复。
- 阶段 0 **不实现** `actors.state` 的读写逻辑(仅建列),留给阶段 3。
- 阶段 0 **不做**辩论编排、事件源接入——分别是阶段 1、2。
- 不引入第二个 ReAct 循环(pi 内层已提供)。
- 不做与本目标无关的重构。

---

## 10. 实现注意

- 按 CLAUDE.md §6,实现应在专用 git worktree 的独立分支上进行。
- 改动集中在 `session-manager.ts`(激活管理器、`runHandles` 升级)、`agent-runner.ts`(Runner 循环 + mailbox 接收)、新 `MessageStore`/`actors` 表、`tools/spawn.ts`(新工具)。这些文件较大,改动需外科手术式、保持现有风格。
