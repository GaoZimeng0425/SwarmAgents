# OpenClaw vs SwarmAgents:Agent 生命周期对比 & 「热缓存层」可行性评估

> 承接 [`long-lived-agent-entities.md`](./long-lived-agent-entities.md)。那篇写于 actor 引入之前(结论是「没有同辈通信」);本篇基于已落地的 resident actor + mailbox 实现,对比外部参考实现 OpenClaw(`~/Learn/ai/openclaw`),并评估是否值得为 resident 唤醒加一层「热缓存」。
>
> 代码引用均为本仓 `src/`;OpenClaw 引用标注其仓库路径。

---

## 1. 一句话结论

两者「长期存活」的落点正好相反:

- **OpenClaw:让进程保活,把 agent 当无状态。** 长期存活的是后端 runtime 进程(ACP session),缓存在内存里;agent 调用本身是无状态 RPC,跑完即弃。
- **SwarmAgents:让身份+状态在 DB 里保活,让进程随用随起随睡。** 长期存活的是 actor 的逻辑身份(SQLite 行)+ 持久 mailbox;承载它的 resident run-loop 是按需启动、空闲 30s 即休眠的。

SwarmAgents 反而更接近**真正的 actor 模型**(可寻址 + mailbox + 同辈 send/rpc),这是 OpenClaw 没有的。

---

## 2. 生命周期模型对照

| 维度 | **OpenClaw** | **SwarmAgents** |
|---|---|---|
| 长期存活实体 | 运行时进程(ACP runtime/backend session) | actor 身份 + 状态(DB 逻辑实体) |
| agent 逻辑本身 | 无状态 RPC,跑完即弃 | resident loop,按需起、空闲即睡 |
| 持久化落点 | 进程留在内存(`RuntimeCache`) | 状态落 SQLite,进程可来可走 |
| 回收方式 | TTL 空闲淘汰 runtime(`ttlMinutes`) | 30s 空闲后 loop 自然返回(`IDLE_TIMEOUT_MS`) |
| 寻址 | `sessionKey` + `resumeSessionId` | ULID 地址 / session 内可读名 + mailbox |
| agent 间通信 | 无(client→gateway→runtime 单向 RPC) | 真正的 send/rpc 点对点消息 |
| 崩溃恢复 | 看后端能否 `resume` 同一 session | 重放 DB 未消费消息(`listUnconsumedAddresses` → `redrainAddress`) |

### OpenClaw(参考实现,验证自其源码)
- agent 层 `src/agents/agent-command.ts`、`src/agents/cli-runner.ts`:无状态,跑完即退。
- 真正保活的是 `AcpSessionManager` 单例(`src/acp/control-plane/manager.core.ts`)里 `RuntimeCache`(`runtime-cache.ts`)缓存的**活 runtime 句柄**。
- 跨重启靠落盘的 `SessionAcpMeta`(含 `mode: persistent|oneshot`、`identity`)+ `resumeSessionId`。
- `evictIdleRuntimeHandles()` 按 `acp.runtime.ttlMinutes` 淘汰空闲 runtime。

### SwarmAgents(本仓)
两条执行路径(`src/service/agent-runner.ts:137` 注释里的 Task 3 vs Task 4):

- **一次性(one-shot)**:`createAgentRunner(...).run()`。用于普通任务和 `spawnChild` 子 agent(`session-manager.ts:400`)。父 `await runner.run()`,子跑完即销毁,`oneShotHandles` 里的 `AbortController` 退出时删除。纯 ephemeral。
- **常驻 actor(resident)**:`spawnResident`(`session-manager.ts:221`)+ `runResident`(`agent-runner.ts:736`)。一个 residency = 一个 Task + 一个 pi `Agent`,跨多轮复用 `promptOnce`。
  - **懒启动**:`sendMessage` 时 `residentHandles.get(addr) ?? spawnResident(...)`(`session-manager.ts:369`)——有消息才起 loop。
  - **休眠**:`IDLE_TIMEOUT_MS = 30_000`(`session-manager.ts:30`),mailbox 空 30s 后 `runResident` 返回,actor「睡着」,handle 删除。
  - **状态持久**:每轮 `consumeAndPersist(msgId, address, state, ...)` 把「消息已消费 + actor 对话状态」原子写进 SQLite(`conversation-store.ts:334` 事务);唤醒时 `decodeActorState(actor.state)` 重放(`session-manager.ts:266`)。
  - **崩溃恢复**:`actors` / `messages` 两张表是持久 mailbox;启动时 `listUnconsumedAddresses()` 找还有未消费消息的地址,`redrainAddress` 重新 spawn 续灌;还专门处理了「空闲返回 vs 实时投递」的竞态(`session-manager.ts:321-334`)。

---

## 3. resident 唤醒到底做了什么(冷启动路径)

这是评估热缓存的关键。一次 resident 唤醒(`spawnResident` → `runResident` → `buildAgentSession`)做的全是**进程内同步工作**:

1. `decodeActorState(actor.state)` —— `JSON.parse` 已存的消息数组(`session-manager.ts:266`)。
2. `toolRegistry.resolve(allowlist, ctx)` —— 数组 `filter` + 对每个 spec 调 `build(ctx)`(`registry.ts:124`)。**纯同步,无 I/O,不建立 MCP 连接**(MCP 连接由 `setMcpServers` 在 registry 级管理,不在 resolve 里发生)。
3. `resolveModel(provider)` —— pi-ai 注册表查表 + clone(`agent-runner.ts:59`),同步。
4. `new Agent({ initialState: { messages: initialMessages, ... } })`(`agent-runner.ts:459`)—— 仅对象构造,把消息塞进内存。

**关键事实:构造期没有任何 LLM 调用、没有网络、没有 MCP 握手。** 真正贵的是把全量对话发给 LLM——而这件事:
- 发生在**第一轮 `promptOnce`**,不在构造期;
- **每一轮都会发生**(pi Agent 对 LLM 无状态,每轮重发整段对话,见 `agent-runner.ts:558-560` 注释)。

所以「对象是否常驻」对 LLM 侧的 token 成本和延迟**没有任何影响**。

---

## 4. 「热缓存层」可行性评估

设想:在 30s 休眠窗口内不真正销毁 `AgentSession`,而是把它的 JS 对象留在内存(类比 OpenClaw 的 `RuntimeCache`),下次消息直接复用,跳过 decode + 重建。

### 结论:现在不值得做。

**它能省的,只有第 3 节那几步本地同步开销:**
- 一次 `JSON.parse`(即便 200k token 的历史也就几 MB JSON,个位~低双位毫秒);
- 一次同步 `filter`/`build`/`clone`(亚毫秒~低毫秒)。

**它省不掉真正的成本:**
- LLM 侧 token 与延迟与对象常驻无关(每轮全量重发,见上)。
- **provider prompt cache 也救不了。** Anthropic 的 `cacheRead/cacheWrite`(本仓已在 `agent-runner.ts:565-566` 统计)是按**内容 + 服务端 TTL**(默认 ~5min)命中的,**不按客户端对象身份**。把 JS 对象留在内存**不会延长服务端缓存 TTL**;决定能否命中缓存的是「两次请求的墙钟间隔」,不是「对象活没活」。

也就是说:热缓存层引入了一层带 LRU/TTL/失效语义的状态(复杂度真实存在),换来的只是几毫秒本地解码——**投入产出严重不成比例**。这正是该砍掉的过度设计。

### 真正的成本杠杆,是另一件事

如果目标是省钱省延迟,应该做的是 **把 `IDLE_TIMEOUT_MS` 对齐到 provider 的 prompt-cache TTL**:

- 现在 30s 远短于 Anthropic ~5min 的缓存窗口——这其实是好事,但它的意义不在「保活对象」,而在「下一轮请求仍落在服务端缓存窗口内 → `cacheRead` 命中 → 省钱省首字延迟」。
- 真正的风险区间是 actor 以略大于缓存窗口的节奏收消息(例:每 6~7 分钟一条,Anthropic 5min TTL)——每次唤醒都缓存未命中,全量重发按全价计费。
- **对策是一行改动**:把 `IDLE_TIMEOUT_MS`(或新增一个独立的「保持缓存温度」窗口)对齐到 provider 缓存 TTL,让 loop 在缓存仍有效期内不睡;而不是去缓存 JS 对象。

---

## 5. 什么情况下热缓存才会值得(触发条件)

仅当出现可测量的下列信号,才回头考虑:

1. **`build(ctx)` 变重**:若未来某些 MCP 工具的 `build` 在每次 resolve 时做了重活(重新拉 schema、开有状态句柄),resolve 成本随工具数上升——届时缓存「已 resolve 的 tools」比缓存整个 session 更对症。
2. **bursty 消息抖动**:actor 以略超 30s 的间隔成串收消息,导致 sleep→wake→sleep 反复。**首选仍是调长 `IDLE_TIMEOUT_MS`**,而非加缓存层;只有调参解决不了再上 warm-handle LRU。
3. **超大历史的 GC 压力**:历史涨到多 MB 时,decode 的临时分配在高并发下产生 GC 抖动。注意:encode 已经**每轮**在 `consumeAndPersist` 里付出(与休眠无关),所以缓存只省 wake 时的一次 decode——收益依旧有限。

**原则:先用 profiler 量到瓶颈,再决定。** 在第 3 节那条「构造期零 I/O」成立的前提下,默认不加这层。

---

## 6. 给 SwarmAgents 的可借鉴点(非热缓存)

OpenClaw 真正值得借鉴的不是「缓存对象」,而是它**显式的 TTL 生命周期管理**——把「保活多久」做成一个可配置策略,而本仓现在是写死的 `30_000`。建议:

- 把 `IDLE_TIMEOUT_MS` 提为可配置,并让默认值跟随 provider 的 prompt-cache TTL(已知 Anthropic ~5min)。
- 这一步同时拿到「减少抖动」和「提升缓存命中」两个收益,且不引入任何新的内存状态机。

> 反过来,SwarmAgents 的持久化模型(状态在 DB、进程无所谓)比 OpenClaw 的「进程保活」更抗崩溃、更易水平扩展——这个方向不要为了「像 OpenClaw 那样保活进程」而倒退。

---

## 7. 为什么 resident actor 对当前 spec 是过度工程

> 本节是一场逐步收敛的推导的结论,**修正**第 4/5 节里把「有环图」当作保留 actor 理由的说法——那是错的。推导链:树 → resumable subagent → actor,逐级问「这一级到底买到了什么」。

### 7.1 三种实现方式的能力边界

目标场景(spec §8 原型):CEO→PM→{engineer, reviewer},全同步 `send_and_wait`,PM 编排,产出工件落盘,PM↔engineer 评审迭代至多 10 轮。

| 能力 | 树 `spawnChild` | resumable subagent(按 id 续接) | 完整 actor(mailbox+resident) |
|---|---|---|---|
| 父调子、拿返回 | ✅ | ✅ | ✅ |
| **迭代回环**(PM 循环调 engineer/reviewer) | ✅ 循环在 PM 控制流里 | ✅ | ✅ |
| **同一身份跨调用保留对话上下文** | ❌ 每次 `initialMessages: []` | ✅ 持久化 messages + resume 灌回 | ✅ `consumeAndPersist` + 重放 |
| 非中介同辈通信(engineer 直接喊 reviewer) | ❌ | ❌ caller 必须中转 id | ✅ 按名寻址 |
| 事件驱动空闲唤醒(跑完不死、坐等消息) | ❌ | ❌ 被调用才活 | ✅ mailbox |

### 7.2 关键纠正:有环 ≠ 需要可寻址

PM↔engineer↔reviewer 的「环」是 **PM 控制流里的循环**,不是通信图的环。拓扑上是**星型**(PM 在中心),一切协调过 PM。一棵树的父节点写个 `loop` 就实现了迭代,**不需要可寻址**。把「有环」列为保留理由是判断错误。

### 7.3 actor 真正、且唯一比 resumable subagent 多出来的

只有 7.1 表最后两行:**非中介同辈通信** + **事件驱动空闲唤醒**。除此之外,「跨调用保留上下文」resumable subagent 100% 等价,且复用现成的一次性路径:

- `createAgentRunner` 本就吃 `initialMessages`(`agent-runner.ts:99` / `:486`);
- actor 状态列 `actors.state` 已是「按身份持久化对话」的现成原语(`conversation-store.ts:170-179`);
- 只需:给 child 稳定 id + run 结束持久化 messages + resume 参数灌回。

代价对比:actor 的**同步 `send_and_wait` 也架在 mailbox + resident loop + replyRegistry + rpc 让 turn-slot 防死锁之上**(`session-manager.ts:369-396`)——为拿「上下文保留」跑了一整套异步邮箱机器;resumable subagent 只动一次性路径,代码量差一个数量级。

> 这正是 OpenClaw 的 `resumeSessionId` 模型。绕一圈回到:当前 spec 用 OpenClaw 那套就够。

### 7.4 因为产出落盘,连上下文保留都被弱化

engineer 的产出是**文件**。修复轮即便是全新 engineer,`spawnChild(engineer, "改 foo.ts 的 Y")` 直接读 foo.ts 即可重建上下文——artifact 在文件系统,不在对话里(spec §17「无状态推理 + 外化状态」)。所以对一个产出落盘的编程公司,**resident actor 的对话记忆是锦上添花(记得"为什么这么选/试过哪些死路"),不是硬需求。**

### 7.5 结论与行动

**就当前 spec,resumable subagent(= `resumeSessionId`)恰好够用、更稳;完整 actor 是过度工程。** 这与所有主流 coding harness 的做法一致(ephemeral + 外化状态),它们是对的。

但 actor **已建好、有测试、phase 3 已合并**,故决策拆成两问:

1. **要不要继续往 actor 异步那半套投精力?** —— 不该,除非 7.5(2) 成立。
2. **「涌现软件公司」愿景是否确定要走到非中介同辈通信 / 事件驱动唤醒?** —— 若是,actor 是该提前打的地基,继续投入是**有意识的产品赌注**;若否,它一直是死重。

**建议**:不拆,冻结 actor 异步部分的继续投入,原型用 actor 已有的同步 rpc 子集跑通(功能上已覆盖 resumable subagent)。等真出现表中最后两行的需求再激活异步能力;若长期不出现,下个版本认真评估把 rpc 降级为 resumable subagent、砍掉 mailbox。

**重判触发条件**(roster / 协作模式一变就对照):
- 出现「A 不经共同祖先直接给 B 发消息」→ 需要可寻址,actor 回本。
- 出现「agent 跑完不死、被 cron/外部事件异步叫醒」→ 需要 mailbox,actor 回本。
- 两者都没出现 → 树 或 resumable subagent 即可,actor 维持冻结。
