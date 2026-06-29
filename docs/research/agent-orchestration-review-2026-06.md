# SwarmAgents 编排架构评审报告（2026-06-27）

> 范围:Agent 执行调度、Agent 间通信、失败重试、把任务进行到底(liveness)。
> 方法:四路并行深读 + 关键发现人工复核。所有引用为 `src/` 下绝对行号(评审时快照)。

---

## 0. 一句话结论

调度与持久化的**地基设计是扎实的**(可证伪的并发信号量、persist-before-deliver 的至少一次投递、崩溃重放、专门测过的 idle/deliver 竞态与 rpc 死锁修复)。但有 **4 个会导致"任务卡死或丢失"的真实缺口**——其中 `spawnChild` 槽位死锁、cron + 人工审批死锁、请求无超时、service 崩溃后无监管——直接命中你最关心的"把任务进行到底"。同时,**resident actor 异步半套是当前 spec 下的过度工程**(项目自己的研究文档 §7 已论证),建议冻结而非继续投入。

---

## 1. 整体架构

### 1.1 进程模型(三进程 Electron)

| 进程 | 职责 |
|---|---|
| **main** | 窗口、配置(providers / mcp-servers / budgets / web-search)、**fork 并监管 service** |
| **service**(`utilityProcess.fork`) | **整个 Agent 系统都在这里**:session manager、agent-runner、tool registry、cron scheduler、MCP manager、所有 SQLite store |
| **renderer** | UI;通过 `ipcMain.handle` 调 main,事件经 `swarm:event` 广播下发 |

main⇄service 是手写的 `parentPort` 请求/响应(自增 id + `pending` map,`service-client.ts:95`);握手等 `{kind:'ready'}` 最多 10s(`index.ts:86`)。

### 1.2 Agent 系统分层(service 内)

```
submitGoal / cron.fire / sendMessage / spawnChild   ← 任务入口
        │
   manager.ts  ── 调度(槽位信号量 + per-session FIFO)、寻址、路由、生命周期
        │
   agent-runner.ts ── 单轮执行(pi-agent-core 驱动工具循环)、重试、fallback、预算/上下文守卫
        │
   tools/registry.ts ── 工具解析(allowlist + 特权组 + 全局开关)+ withLogging 统一埋点
        │
   conversation/store.ts ── SQLite:tasks / actors / messages / cron_runs(持久 mailbox)
```

注意:底层 LLM SDK 不是 `@anthropic-ai/claude-agent-sdk`,而是 **`@earendil-works/pi-agent-core`**(provider 无关,anthropic-messages / openai-completions 两种 wire style)。工具调用循环跑在 pi 内部,runner 只挂 `beforeToolCall` / `prepareNextTurn` 两个钩子。

---

## 2. 任务调度(scheduling)

### 2.1 两级调度——这是核心,设计干净

**(a) 全局并发闸门 = "turn slot" 计数信号量**(`manager.ts:191-204`)
- `activeRunners` + `waitQueue`,上限 `cfg.maxConcurrent`(生产**硬编码 = 4**,`index.ts:86`)。
- `releaseSlot` 在有等待者时**直接移交槽位**(不先减再加),是无丢唤醒的公平 FIFO 信号量。

**(b) per-session 串行 = pending 队列**(`manager.ts:209-224`)
- 每个 session 一条 `pending: QueuedTurn[]` + `running: taskId`。`pump()` 自链式 drain:`runTurn().finally(() => { running=null; pump() })`。

一个 turn 要过**两道门**:session 必须空闲(pump)**且**抢到全局槽(acquireSlot)。职责正交、各自极小可读。

### 2.2 三种执行形态共用同一个槽池

| 形态 | 入口 | 槽位行为 |
|---|---|---|
| 顶层任务 | `submitGoal` → pending → pump | 进 runTurn 抢槽 |
| 子 agent | `spawnChild`(spawn 工具) | **直接 acquireSlot,绕过 pending** |
| 常驻 actor | `spawnResident` / `runResident` | 每轮 acquireTurnSlot |

三者抢同一个 `maxConcurrent=4` 池——**这是 2.x 多个风险的根因**(见评价)。

### 2.3 cron 定时(`cron/scheduler.ts`)

- 每个 job 一个 `CronJob.from({waitForCompletion:true})`,`tick` 写 `cron_runs` 行 → `fire` → `submitGoal`。
- job 归属专用 **system session**(`manager.ts:687`),所以删掉发起会话也不影响;有一次性迁移把旧的 per-conversation job 重指过来。
- 启动时 `reconcile()` 把崩溃残留的 `running` 行按任务终态收口(`scheduler.ts:108`)。

### 2.4 评价

**优点**:两级分离干净;槽位移交无丢唤醒;cron 全局化 + 崩溃收口 + 落库前校验。

**风险**:
- **`maxConcurrent` 硬编码 4**(`index.ts:86`),预算都能配它却不能配——系统最重要的吞吐旋钮要重编译才能改。
- **三形态共用一个槽池、无分级预留**:深度递归的 company 跑法可吃光 4 个槽,顶层/交互 turn 被饿死,UI 像卡死。建议为顶层 turn 预留至少 1 槽。
- **无 fan-out 上限**:`spawnChild` 可无界递归(`manager.ts:565`),只有槽池限"并发"不限"广度/深度";预算限 token 不限任务图规模。

---

## 3. Agent 间沟通(communication)

### 3.1 寻址 + 邮箱

- 一个 `Actor` = ULID 地址 + 可读名 + `agentDefId` + 跨休眠对话状态。寻址双模:`getActor(to) ?? getActorByName(sessionId, to)`(`manager.ts:285`)。
- **每个 resident 一个内存 FIFO mailbox**,单等待者(`receive` 重入即抛,`mailbox.ts:40`),因为 loop 串行消费。`receive({idleMs})` 超时抛 `IdleTimeoutError` → actor 休眠(30s,`manager.ts:41`)。

### 3.2 send vs rpc + 回复关联

- `send_message` → `kind:'send'`,立即返回。`send_and_wait` → `kind:'rpc'`,等回复文本。
- rpc 关联:`correlationId = msgId`,caller `awaitReply(msgId, 120s)`;callee 那轮结束 `onReply(correlationId, summary)` → `replyRegistry.resolve`(一次性 Map)。
- **rpc 超时静默返回 `''`**(`reply-registry.ts:24`)——"回了空"和"超时了"对模型无法区分。
- **rpc 回复不持久**:crash 后 caller 已不在,`onReply` 命中"caller gone"日志,结果静默丢失。消息本身持久,但 rpc 结果不持久。

### 3.3 spawn 子 agent

`spawn_sub_agent` → `spawnChild`(`manager.ts:488`):建 `parentId` 子 Task(持久、父子边)、广播 `task.handoff.spawned`、`acquireSlot` 跑一次性 runner、**resolve(不 reject)** 返回 summary 给父工具。这是一条干净的 **resumable-subagent / 父子委派**路径。

### 3.4 组织/团队路由——prompt 驱动,无硬调度器

- `AgentDefinition` 带 `role / team / teamRole(head|member) / capabilities / parentId`。默认是软件公司:CEO→各 team head→members。
- **没有中央 router**:路由靠系统提示词里的 `find_agents({teamRole:'head'})` + `send_and_wait` 约定涌现(`agents.ts:16`)。`find_agents` → `directory.find` 是 actors 表的纯投影,**只列已存在的 actor**。
- `delegation.ts` 仅靠正则从提示词里扒 `find_agents({...})` 画意图图,**明确声明非运行时强制**(`delegation.ts:4`)。即 CEO→head→worker 是写在散文里的约定,**无任何强制**。

### 3.5 评价 + 过度工程结论

**优点**:persist-before-deliver + redrain = 真正的至少一次投递与崩溃恢复;idle/deliver 竞态被显式识别并测试;寻址双模、directory 是纯投影无第二真相源;失败隔离(坏消息杀不死 loop,子失败 resolve 不阻断父)。

**风险**:
- **mailbox / waitQueue 全无界**(`mailbox.ts:22`):刷屏或自循环 agent 可无限堆积,无背压。提示词里"至多 10 轮"只是散文,无强制。
- **rpc 超时返回 `''` 易被当成有效空答**;rpc 结果 crash 即丢。
- **槽位归属靠推断**(`callerHoldsSlot = residentHandles.has(fromAddr)`,`manager.ts:475`):仅在"resident 只在槽内串行发 rpc"不变式下成立,是约定而非构造保证,一旦被违反会腐蚀 `activeRunners`。

**过度工程(高置信)**:项目自己的 `openclaw-vs-swarm-lifecycle.md §7` 已逐级论证:
- 系统其实有**两套委派机制**——(a) `spawnChild` 干净的父子模型;(b) actor/mailbox/rpc/redrain/cross-dormancy 整套异步机器。
- 而 **company 工作流几乎全用 `send_and_wait`,即同步请求/响应——恰恰是 (a) 已能提供的**,却架在 mailbox 单等待者契约 + idle 休眠/重生 + idle/deliver 竞态 + redrain + 槽位让渡启发式之上。
- actor 真正独占的只有两条:**非中介同辈通信** + **事件驱动空闲唤醒**。当前 spec 都没用到;且因产出落盘(artifact 在文件系统),连"跨调用上下文保留"都被弱化。
- 结论与建议:**冻结 actor 异步半套**,原型用其已有的同步 rpc 子集(功能上等价 resumable-subagent);出现"A 绕开共同祖先直发 B"或"agent 被 cron/外部事件异步唤醒"两个信号之一时再激活异步能力。

---

## 4. 失败重试与回退(retry & fallback)

### 4.1 请求级重试(`agent-runner.ts`)

- 常量:**`MAX_PROMPT_RETRIES = 10`,`RETRY_DELAY_MS = 5000`——固定退避,无指数、无 jitter**(`:59`)。
- 层级:**请求/prompt 级**(内层 `for(attempt)` 重发 `agent.prompt`),非工具级、非整任务级。
- 永久 vs 瞬时:`isPermanentModelFailure` 正则匹配 `401/403/404/auth/quota/billing/model-not-found` → 永久,直接跳 fallback;其余(超时/5xx/限流/reset)→ 瞬时,原地重试。
- 主动停止(cancel/budget/iterations/context)在失败分支**之前**返回,永不被重试。
- **进度保留 = 重启而非续跑**:每次 attempt 把 transcript 还原到 prompt 前快照(`:900,:979`),失败轮的 user+error 消息被丢弃。**副作用不回滚**——失败 prompt 里已执行的工具(写文件、发消息、spawn)会在重试时重复执行。
- UI:中间失败发 `transient` 提示并抑制终态 error,只有最后一次才发 `task.error`。

### 4.2 模型/provider fallback

- `modelChain = [model, ...fallbackModels]`(`:694`),来自 provider 的 `fallbackProviderIds`(自引用/未知 id 丢弃,展平一层,`service.ts:211`)。
- 与重试嵌套:**外层 = model chain,内层 = 瞬时重试**。每个 model 耗尽重试或遇永久失败 → break 到下一个 model,**重试预算重置**。
- 切换时 `agent.state.model` 与闭包 `model` 同时改,usage/守卫都按引用读到新值。

### 4.3 消息级 deadletter(manager 层,第二层)

resident turn 抛错 → 不消费消息 → `bumpRetries`,超 `MAX_RETRIES=3` 标 `dead`;`allUnconsumedFor` 过滤 `consumed=0 AND dead=0`,最终收敛——保证 redrain 不会无限循环。

### 4.4 评价

**优点**:主动停止 vs 失败的分离做得很对(最易错的地方);正确处理 pi 的"void-resolve 失败"契约;重试 transcript 卫生(快照还原避免重复);永久失败快路径避免在死 key 上空耗 50s;两层韧性(请求级重试 + 消息级 deadletter)。

**风险**:
- **固定退避无 jitter**:并行 agent 的重试会同步成惊群,打在被限流的 provider 上。
- **最坏延迟/预算巨大且静默**:`(10 重试 × 5s) × (1 + N fallback)` 纯等待,持续 503 的两模型链可空睡 ~100s。
- **副作用不幂等却会重放**(4.1):非幂等工具(spawn / 写文件 / 发消息)在重试时可能重复触发——可能重复 spawn 子任务、重复落盘。
- **计数不一致**:`turns` 每次 attempt 重置,但 `used.calls` 累计;被放弃的重试仍吃掉 call 预算。
- **fallback 不重夹 `thinkingLevel`**:切到不支持主模型 thinking 等级的 fallback 时,旧 clamp 值会跟着跑(潜在 bug)。

---

## 5. 把任务进行到底(liveness / completion)

### 5.1 终止保障(四道)

1. **最大轮数** `maxTurns = maxIterations ?? 25`,在 `prepareNextTurn` 每轮检查——**唯一能挡住"无工具调用的纯推理死循环"的后盾**(预算/上下文守卫只在 `beforeToolCall` 触发)。
2. **预算** `overBudget()` 查 `calls / wallMs / usdCents`——**`tokens` 故意不 gate**(配置里的 token 预算对成本控制是摆设)。
3. **上下文窗口**:`contextTokens > model.contextWindow` 时硬失败 `context_window_full`(`:782`)。
4. **墙钟**:仅经 `budget.wallMs`,且只在工具调用时查。

### 5.2 致命缺口(直接威胁"进行到底")

> 这一节是你这次评审最该优先看的。

| # | 缺口 | 后果 | 位置 |
|---|---|---|---|
| **G1** | **`spawnChild` 不让渡父槽**(已人工复核确认):`acquireSlot()` 给子,但不像 rpc 那样释放父槽。 | `maxConcurrent=1` 时任意 `spawn_sub_agent` **自死锁**;一般情况下嵌套 N 层吃 N 个槽,深度 ≥ maxConcurrent 即停滞。rpc 路径修了,spawn 路径没修,**且无测试覆盖**。 | `manager.ts:553` |
| **G2** | **cron + 人工审批死锁**:cron 用默认 `permissionMode:'ask'` 跑,触到 medium/high 工具就 `permissionRegistry.request()` **无超时永等**。 | 半夜无人值守的定时任务永久挂起,直到耗尽 `wallMs`,期间还占住 4 个槽之一。 | `index.ts:97` / `permission-registry.ts:34` |
| **G3** | **请求无超时**:pi-ai 支持 per-request `AbortSignal`,但 runner 没接。 | 连接挂死(server 接了不回流)时 `await agent.prompt()` **无限阻塞**;`wallMs` 只在 `beforeToolCall` 查,挂死期间永不触发;只有用户 cancel 能打断。**这是最危险的静默卡死路径**。 | `agent-runner.ts:989` |
| **G4** | **service 启动后无监管**:`on('exit')` 只在启动 Promise 内;启动成功后崩溃**无人发现、不重启**;且 `service-client.ts` 的 `pending` 永不 reject。 | service 崩溃后 app 变僵尸:所有进行中/未来的 IPC 调用永久挂起,无错误上报。 | `index.ts:96` / `service-client.ts:95` |
| **G5** | **一次性路径无 compaction**:上下文满 = 直接 `failed`(compaction 只在 resident 路径有)。 | 长单任务填满窗口直接失败而非压缩续跑(代码注释自承是 interim)。 | `agent-runner.ts:782` vs `:1189` |
| **G6** | **cron 无补跑**:app 关闭期间错过的 fire 静默跳过。 | 桌面 app 非常驻,`0 9 * * *` 在关机日必丢,用户预期外。 | `cron/scheduler.ts:193` |

---

## 6. 是否符合最优解——综合判断

**地基层(调度信号量、持久 mailbox、崩溃重放、两级重试)** 在"是否最优"上接近最优解:可证伪、有针对性测试、降级处处友好(坏状态→干净重启)。

**不最优的两类**:
1. **正确性缺口(G1–G4)**——不是风格问题,是会让"任务进行到底"失败的真 bug,且部分(G1)是已知修复模式没对称应用。
2. **复杂度过剩**——actor 异步半套对当前 spec 是过度工程(项目自证),`correlationId` 等是为未用的"Plan B"预留的脚手架,徒增认知与失败面。

换言之:**砍掉过度设计、补齐 4 个正确性缺口后,这套架构就是当前 spec 的最优解区间**。不需要推倒重来。

---

## 7. 优化清单(按优先级)

### P0 — 正确性(会卡死/丢任务,先做)

1. **G1 修 `spawnChild` 死锁**(`manager.ts:553`):像 rpc 路径一样,在 `await runner.run()` 期间让渡父槽、返回前重夺;并补 `maxConcurrent=1` 下的 spawn 死锁测试。
2. **G3 接 per-request 超时**(`agent-runner.ts:989`):`AbortSignal.timeout(...)` 与 `deps.signal` 组合传入 `agent.prompt` —— 堵住最危险的无限挂死。
3. **G2 cron 自治**(`index.ts:97`):给 cron 的 `submitGoal` 传 `{permissionMode:'full'}` 或专用策略 + 禁高危工具白名单;并给 `permission-registry`(`:34`)加超时**fail-safe 拒绝**,避免无人审批占死槽位。
4. **G4 service 监管**(`index.ts:96`):启动后注册常驻 `on('exit')` 退避重启 + 向 renderer 报错;`service-client.ts:95` 在传输死亡时 reject 所有 `pending`。

### P1 — 健壮性

5. **重试退避加指数 + jitter**(`agent-runner.ts:60`):消除惊群与过度空等。
6. **wallMs 也在 `prepareNextTurn` 查**(`agent-runner.ts:698`):纯推理/挂死的 turn 当前逃过墙钟预算。
7. **rpc 区分超时与空答**(`reply-registry.ts:21`):返回哨兵/reject,并把"120s 超时"写进工具结果文本。
8. **mailbox / waitQueue 加上界 + 背压**(`mailbox.ts:34`):堵 OOM 与自循环。
9. **fan-out 深度/广度上限**(`spawnChild`,`manager.ts:565`):独立于 token 预算地限制任务图规模。
10. **一次性路径补 compaction**(`agent-runner.ts:782`):满窗口先压缩再失败。

### P2 — 简化(降复杂度,中长期)

11. **冻结 actor 异步半套**(研究文档 §7 已结论):原型只用同步 rpc 子集 = resumable-subagent;若长期不出现"非中介同辈通信 / 事件驱动唤醒",下版评估把 rpc 降级为 resumable-subagent、砍 mailbox/redrain。
12. **槽位归属显式化**(`manager.ts:475`):用 `slotHolders:Set<address>` 替代 `residentHandles.has` 推断,移除死锁修复里的隐式不变式与 over-release 风险。
13. **清理 dead code**:`main/permission/gate.ts` 未被 agent 路径接线,要么删要么作为单一真相源接进 runner。

### P3 — 性能/成本

14. **`maxConcurrent` 改为可配**(`index.ts:86`),并为顶层 turn 预留至少 1 槽,防 fan-out 饿死交互。
15. **`IDLE_TIMEOUT_MS` 对齐 provider prompt-cache TTL**(研究文档 §4):一行改动同时拿到"减抖动"+"提升 cacheRead 命中"两个收益,无需引入热缓存层(已论证热缓存投入产出严重不成比例)。
16. **永久失败判定改读结构化状态码**(`agent-runner.ts:88`):正则匹配错误散文跨 provider/语言脆弱,会误判 429。

---

## 附:本报告依据的关键文件

- 调度/生命周期:`src/service/session/manager.ts`、`conversation/store.ts`、`actor/mailbox.ts`、`actor/state.ts`
- 执行/重试/fallback:`src/service/session/agent-runner.ts`、`main/providers/service.ts`、`shared/types/model-role.ts`
- 通信/组织:`src/service/tools/messaging.ts`、`tools/spawn.ts`、`session/reply-registry.ts`、`directory/receptionist.ts`、`shared/agents/{delegation,org-tree}.ts`、`shared/constants/agents.ts`
- 工具/权限/cron/接线:`src/service/tools/registry.ts`、`session/permission-registry.ts`、`cron/scheduler.ts`、`main/index.ts`、`main/service-client.ts`
- 既有内部分析:`docs/research/openclaw-vs-swarm-lifecycle.md`(§4 热缓存、§7 actor 过度工程)
