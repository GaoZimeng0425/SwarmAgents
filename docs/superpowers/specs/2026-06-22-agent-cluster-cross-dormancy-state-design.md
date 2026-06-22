# 设计:Agent 集群 —— 跨休眠长期状态(阶段 3,场景④)

> 状态:已通过 brainstorming 评审,待用户最终确认。
> 日期:2026-06-22
> 关联:[`docs/research/long-lived-agent-entities.md`](../../research/long-lived-agent-entities.md);[`2026-06-22-agent-cluster-actor-substrate-design.md`](./2026-06-22-agent-cluster-actor-substrate-design.md)(§8 阶段 3);[`2026-06-22-agent-cluster-persistent-runloop-design.md`](./2026-06-22-agent-cluster-persistent-runloop-design.md)(§9,本计划的前置;计划 B 已合并到 `develop`,commit `5f7f358`)。

---

## 1. 目标与动机

计划 A(actor 基石)+ 计划 B(常驻 run-loop)让 Agent 可寻址、能互发消息、在**单次常驻期内**累积上下文(空闲 30s 前)。但 actor 一旦空闲超时休眠,该常驻期的对话即随 Runner 销毁而**丢失**;下次同地址再激活时 `initialMessages: []`,角色"失忆"。

本计划补齐场景④——**跨休眠长期有状态**:可寻址 actor 的对话历史按 address 持久化到 `actors.state`(计划 A 预留列),**激活时重放、每轮处理后持久化**,配套 off-the-shelf 上下文压缩,使 actor 成为真正长寿、跨多次激活有连续记忆的协作者。这是"涌现式公司原型"跑跨休眠多团队流程的前置条件。

### 设计哲学(不变量)

延续"**无状态推理 + 外化状态、崩溃可恢复**":运行时对象(`AgentRunner`/pi `Agent`)仍可随时销毁;actor 的长期记忆完全外化到 SQLite,任何时刻销毁都能从库重建。本计划的核心约束:**消息被标记消费的那一刻,产生它的推理也已落库**——消费状态与记忆永不分叉。

---

## 2. 范围(brainstorming 已拍板)

| 决策 | 选择 | 理由 |
|---|---|---|
| 持久化粒度 | **每轮处理后,与 `markConsumed` 同一 SQLite 事务原子持久化**(方案 A) | 唯一与"外化状态、崩溃可恢复"不变量自洽的选择;消费与记忆永不分叉;崩溃丢失窗口 = 0。增量成本几乎为零(本就每轮写 `markConsumed`,合并进同事务) |
| 压缩时机 | **每轮持久化前检查 `shouldCompact`,触发则先 `agent.compact()` 再存** | 落库 state 始终有界,重放成本受控;压缩用 pi 原生,不自造 |
| state schema | **带版本薄包装** `{ v: 1, messages }` | 版本号让重放检测到不兼容旧 blob → 优雅丢弃重开,而非反序列化崩溃 |
| 持久化作用域 | **仅 `runResident`(可寻址 actor)** | 一次性 `spawnChild`/顶层 `run()` 走 `run()` 旧路,天然不持久化,无需额外判断 |

### 非目标(YAGNI)

- **不做**仅在休眠/退出时持久化(方案 B)——硬崩溃会让已消费消息与记忆分叉,违背哲学。
- **不**为一次性 `spawnChild` / 顶层 `run()` 持久化 actor 状态。
- **不**自造压缩/摘要逻辑——复用 pi 的 `compact`/`shouldCompact`。
- **不**在 `actors.state` 里冗余 `agentDefId`/`lastTaskId` 等已是独立列的字段。
- 不重构与本目标无关的代码。

---

## 3. 现状基线(被改动的代码)

> **实现前置动作**:开工先核实下列行号与现状(本文档基于 `develop`,计划 B 刚合并)。

- `src/service/session-manager.ts`
  - `spawnResident`(`~:250-317`):创建 actor + mailbox + `runHandles`,组装 `ResidentHooks`(`onConsumed`/`onReply`/`onError`)与 `AgentRunnerDeps`,`void runResident(...)`。当前硬编码 `initialMessages: []`(`:290`);`ResidentHooks.onConsumed(msgId)` 仅调 `store.markConsumed`(`:268`)。
  - `IDLE_TIMEOUT_MS = 30_000`(`:29`)。
  - 崩溃恢复路径已用 `initialMessages: session.messages` 重放(`:633`)——证明 pi `Agent` 可被既有 messages 播种。
- `src/service/agent-runner.ts`
  - `buildAgentSession(deps)`(`:322`):用 `deps.initialMessages` 构造 pi `Agent`(`:479` `messages: initialMessages`);暴露 `promptOnce` 与 `agent`(`agent.state.messages` 跨 turn 累积);`saveSnapshot` 已读 `agent.state.messages` + `model.contextWindow`(`:571`)。
  - `runResident(deps, mailbox, hooks, idleMs)`(`:724`):循环 `mailbox.receive` → `promptOnce(msg.payload)` → `hooks.onConsumed` / `onReply`(`~:751`)。
  - `ResidentHooks` 类型(`agent-runner.ts`):`onConsumed`/`onReply`/`onError`/`acquireTurnSlot`/`releaseTurnSlot`。
- `src/service/conversation-store.ts`
  - `actors` 表含 `state TEXT`(`:166`);`upsertActor`(`:303`,`ON CONFLICT … state = excluded.state`)/`getActor`(`:309`)/`getActorByName`(`:310`)已就绪。
  - `markConsumed`(计划 A)——本计划需把它与 `upsertActor` 合并进一个事务方法。
- `src/shared/types/actor.ts`
  - `Actor.state: string | null`(`:13`,注释 "reserved for phase 3, unused here")。
- pi(`@earendil-works/pi-agent-core`)
  - `Agent.compact(customInstructions?): Promise<{ summary, firstKeptEntryId, tokensBefore, details? }>`(`agent-harness.d.ts:60`)——mutate 内部 session,压缩后 `agent.state.messages` 反映结果。
  - 独立导出:`shouldCompact(contextTokens, contextWindow, settings)`、`calculateContextTokens`/`estimateContextTokens`、`DEFAULT_COMPACTION_SETTINGS`(`harness/compaction/compaction`)。

---

## 4. 架构设计

### 4.1 State schema 与编解码(组件 1)

新增一处编解码 helper(放 `src/service/actor-state.ts`,纯函数、可单测):

```ts
type ActorStateBlob = { v: 1; messages: AgentMessage[] }

encodeActorState(messages: AgentMessage[]): string   // JSON.stringify({ v: 1, messages })
decodeActorState(raw: string | null): AgentMessage[] // null/解析失败/v≠1 → [] (调用方 warn)
```

- `decodeActorState` 永不抛:`null` → `[]`;`JSON.parse` 失败或 `v` 不符 → `[]`(返回空,调用方记 `warn`)。
- 不引入额外字段。`agentDefId` 等由 `actors` 表列承载。

### 4.2 激活时重放(组件 2,改 `spawnResident`)

`session-manager.ts:290` 的 `initialMessages: []` 改为:

```ts
const restored = decodeActorState(actor.state)
if (actor.state && restored.length === 0)
  log.warn({ msg: 'actor state decode failed, starting fresh', address: actor.address, component: 'actor-state' })
// deps.initialMessages = restored
```

- `restored.length > 0` 时打 `info`:`{ msg: 'actor state replayed', address, messageCount: restored.length }`。
- 重放零新机制:`buildAgentSession` 既有的 `initialMessages` 通道(崩溃恢复已实跑)直接承接。

### 4.3 每轮持久化 + 压缩(组件 3,改 `runResident` + `ResidentHooks`)

**hook 签名扩展**:`onConsumed(msgId)` → `onConsumed(msgId, state: string)`。`ResidentHooks` 仅 `runResident` 使用,改动内聚。

**`runResident` 循环**,每轮 `promptOnce` 成功后(在 agent-runner,因 `compact()` 异步且 mutate agent):

```
const { summary } = await session.promptOnce(msg.payload)
// 压缩检查(失败不致命,见 §5)
try {
  const tokens = calculateContextTokens(session.agent.state.messages)
  if (shouldCompact(tokens, model.contextWindow, DEFAULT_COMPACTION_SETTINGS)) {
    const { tokensBefore } = await session.agent.compact()
    log.info({ msg: 'compacted', address, tokensBefore, component: 'actor-state' })
  }
} catch (err) { log.error({ msg: 'compact failed, persisting uncompacted', address, err: String(err), component: 'actor-state' }) }
const state = encodeActorState(session.agent.state.messages)
hooks.onConsumed(msg.id, state)            // 原子 markConsumed + upsertActor
if (msg.kind === 'rpc' && msg.correlationId) hooks.onReply(msg.correlationId, summary)
```

- `model`/`contextWindow` 在 `buildAgentSession` 作用域内可得(`saveSnapshot` 已用),需经 `AgentSession` 暴露(如 `session.contextWindow`)或在循环内从 `session` 读取。
- 空闲超时退出**无需**额外持久化:最后消费的 turn 已落库,之后无新 turn。

### 4.4 原子持久化(组件 4,改 `conversation-store` + `spawnResident` hook)

`conversation-store.ts` 新增一个事务方法,把消费标记与状态写入合并。**用定向 UPDATE 只动 `state` + `updated_at`**,不走全行 `upsertActor`——避免把 `lastTaskId`/`name` 等列写回陈旧值:

```ts
// better-sqlite3 transaction()
consumeAndPersist(msgId: string, address: string, state: string, updatedAt: number): void
// 一个 tx 内:
//   UPDATE messages SET consumed=1 WHERE id=?
//   UPDATE actors   SET state=?, updated_at=? WHERE address=?
```

`spawnResident` 的 hook 改为:

```ts
onConsumed: (msgId, state) =>
  store.consumeAndPersist(msgId, actor.address, state, Date.now()),
```

- 事务失败 → 整体回滚:消息留 `consumed=0` → 走既有 re-drain/重试(`onError`/`bumpRetries`),`error` 日志。
- `lastTaskId` 仍由现有激活路径(`:248`)维护;本事务只触及 `state` + `updated_at`,不碰其他列。

---

## 5. 数据流 / 错误处理 / 边界

### 数据流:跨休眠连续记忆
首次 `send(addr, m1)` → 无活 resident → `spawnResident`:`decodeActorState(null) → []` → 处理 m1 → 每轮 `compact?` + `consumeAndPersist`(state 落库)→ 空闲 30s 休眠。
再次 `send(addr, m2)` → `spawnResident`:`decodeActorState(actor.state)` 重放 m1 的对话 → m2 的 prompt 在 m1 历史之上继续 → 落库 → 休眠。actor 跨两次激活记忆连续。

| 情况 | 处理 |
|---|---|
| 重放解码失败 / `v` 不符 | `decodeActorState` 返回 `[]`,`spawnResident` 记 `warn`,actor 干净重启,不抛 |
| `compact()` 抛错 | `error` 日志,**跳过压缩**(持久化未压缩 messages),循环继续——保住记忆优于丢记忆 |
| `consumeAndPersist` 事务失败 | 整体回滚 → 消息留 `consumed=0` → 既有 re-drain/重试;`error` 日志 |
| abort 中途(turn 未完成) | 该 turn 未 `consumeAndPersist` → 下次激活基于**上一已落库 state** 重处理该消息,自洽 |
| 一次性 `spawnChild` / 顶层 `run()` | 走 `run()` 旧路,**不**调 `consumeAndPersist`,不写 `actor.state` —— 持久化只在 `runResident` |
| 同地址并发写 | 单地址仅一个活 resident(计划 B 不变量)→ 无并发写 `actor.state` |
| 临时(ULID 匿名)resident actor | 有 `actors` 行即随常驻期持久化,语义一致;空闲休眠后其 state 留库(可接受,后续可加 GC,非本计划) |

全程结构化日志(CLAUDE.md §5),pino child `component: 'actor-state'`,打点:`replay`(带 `messageCount`)/ `persist` / `compact`(带 `tokensBefore`)/ `replay-decode-failed` / `compact-failed` / `persist-failed`,均带 `address`。每个 `catch` 至少 `error` 级。

---

## 6. 测试策略(TDD)

经 Electron node 运行:`npm test`(勿裸 `npx vitest`;勿 `pnpm rebuild better-sqlite3`)。`src/service/**` 不在 typecheck 范围,靠 vitest 兜类型。压缩阈值测试用可注入的假 token 计数 / 小 `contextWindow`,避免依赖真实 LLM。

- **编解码(`actor-state.ts`)**:`encode` 后 `decode` 往返一致;`null`/坏 JSON/`v` 不符 → `[]`,不抛。
- **原子性(`consumeAndPersist`)**:成功后 `messages.consumed=1` 且 `actors.state` 已更新;事务内任一步抛错 → 二者皆回滚(消息仍 `consumed=0`)。
- **重放连贯**:持久化 m1 对话 → 重新激活 → 第二条消息的 `promptOnce` 能看到 m1 历史(stub agent 记录收到的 `initialMessages`)。
- **压缩**:`calculateContextTokens` 超阈值 → `agent.compact()` 被调、落库 state 的 messages 数变小;未超 → 不压缩。
- **压缩失败兜底**:`compact()` 抛错 → 仍持久化(未压缩)+ `error` 日志,循环不中断。
- **解码失败重启**:坏 `actor.state` → `spawnResident` 以空历史启动 + `warn`,不崩。
- **回归**:一次性 `run()` / 旧式 `spawnChild` / 顶层 `submitGoal` 不写 `actor.state`,行为不变;计划 A/B 全部测试在新 hook 签名下仍绿。

---

## 7. 文件结构(实现指引)

- **新增** `src/service/actor-state.ts` —— `encodeActorState` / `decodeActorState`,纯函数、可单测。
- **修改** `src/service/agent-runner.ts` —— `ResidentHooks.onConsumed` 加 `state` 参数;`runResident` 循环加压缩检查 + 序列化 + 经 hook 持久化;`AgentSession` 暴露 `contextWindow`(若尚未)。
- **修改** `src/service/conversation-store.ts` —— 新增 `consumeAndPersist`(`markConsumed` + `upsertActor` 同事务)。
- **修改** `src/service/session-manager.ts` —— `spawnResident`:`initialMessages` 接 `decodeActorState(actor.state)` + warn;`onConsumed` hook 改调 `consumeAndPersist`。
- **可能修改** `src/shared/types/actor.ts` —— 更新 `state` 字段注释(不再 "unused")。
- 这些文件较大,改动需外科手术式、保持现有 factory+closure 风格;一次性路径零回归是验收硬指标。

---

## 8. 实现注意

- 按 CLAUDE.md §6,在专用 git worktree 的独立分支实现(基于 `develop`)。
- 验收核心:**原子持久化**(consumed ⇔ state 已更新)与**重放连贯**两条测试先写。
- `ResidentHooks.onConsumed` 签名变更只影响 `runResident` 调用点与 `spawnResident` 实现,改动内聚;确认无其他调用方。
- 压缩为 off-the-shelf:只调 pi 的 `shouldCompact`/`compact`/`DEFAULT_COMPACTION_SETTINGS`,不自定义摘要 prompt(除非后续需要,届时另议)。
