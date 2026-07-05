# Run-Engine 重写总结:旧逻辑 vs 新逻辑

> 2026-07-04 ~ 07-05 完成的四阶段重写(W0–W4),develop 最终合并点 `7306a8f`。
> 设计规格:`docs/superpowers/specs/2026-07-04-run-engine-rewrite-design.md`
> 实施计划:`docs/superpowers/plans/2026-07-04-run-engine-w0-*.md` … `2026-07-05-run-engine-w4-*.md`

**一句话**:把 agent 运行层从"四条手拼启动路径 + 半接线的 actor 邮箱系统 + task/run 双词汇"重写为"单一 `launchRun` 管线 + 纯 one-shot 生成树 + 全线 `run.*` 协议",老引擎(`manager.ts` + `agent-runner.ts` ≈ 2100 行)整体删除,净减约 7000 行。

---

## 1. 总体架构

### 之前

```
submitGoal ──► runTurn ─────┐        每条路径手拼 ~30 行 deps,
create_task ─► runTaskTurn ─┤        共享 helper 只有一条路径在用;
spawn_child ─► startChild ──┼──► createAgentRunner ──► buildAgentSession(580 行巨函数)
send_and_wait► spawnResident┘              │
                                    promptOnce(215 行闭包:重试/回退/终态混杂)
```

- 工具能力随进入路径漂移:同一个 agent 定义,走不同路径拿到不同的工具集
- one-shot 与 resident actor 两套运行制并存,resident 半边只接了一半线

### 现在

```
SessionService(只管会话簿记:FIFO 票据、快照、CRUD)
      │
      ▼
launchRun(spec, ports)          ← 任何 run 的唯一入口
      │  注册中止句柄(先于一切等待)
      │  run.created → 排队票据 → 并发槽 → run.dispatched
      │  统一组装工具上下文(所有 run 能力一致)
      ▼
engine(门控 + 重试/回退 + 唯一终态)
  ├─ models.ts      模型解析(纯函数)
  ├─ retry.ts       重试/回退决策(纯函数)
  ├─ translator.ts  pi 事件 → run.progress(结构上无法发终态)
  └─ emit.ts        单模式发射:seq 戳 → 落库 → 终态注册 → 广播
```

- `turn` / `work` / `child` 三种 run 只是 **spec 字段差异**,不再是代码路径差异
- 每个模块 ≤ 300 行、可独立单测

---

## 2. 逐项对比

### 2.1 goal 的传递

| | 之前 | 现在 |
|---|---|---|
| 契约 | goal 塞进 `initialMessages` 末尾,runner 按"最后一条是 user 字符串"启发式提取,再 `slice(0,-1)` 剥掉,让 pi 重新追加 | `spec.prompt` 与 `spec.history` 两个显式字段 |
| 风险 | 一天内吃过两个 hotfix;非字符串 user 消息静默退化成空 goal | 无启发式、无位置约定 |

### 2.2 终态事件(修复"中断后状态错乱")

| | 之前 | 现在 |
|---|---|---|
| 谁发终态 | translator 在 `agent_end` 发 `task.complete`,promptOnce 又按中止原因发 `task.error` —— **两处都可能发** | engine 的 `terminal()` 是全系统唯一发射点;translator 源码中不存在任何发终态的路径(grep 可证) |
| 被中止的 run | 双发终态:live registry 记 completed、UI/重启后记 cancelled,三个消费方意见不一 | 单终态不变量,优先级明确:stopCause → 失败(经重试策略) → aborted → 完成 |
| 边角 | "超迭代恰逢无工具调用的自然收尾轮"仍双终态(老引擎修不掉) | 由构造消灭,并有双形状测试钉死 |

### 2.3 多 agent 协作(最大的删除)

| | 之前 | 现在 |
|---|---|---|
| 运行制 | one-shot + resident actor(邮箱、`send_and_wait` RPC、跨轮记忆、redrain 恢复)并存 | 纯 one-shot 生成树 |
| 委派 | CEO/Leader 提示词教 `send_and_wait(<地址>)`,但 `send_message` 在非 resident 路径**假装发送成功**;`set_delegation_plan` 恰对其设计用户(resident Leader)报错 | 统一 `delegate({ goal, agentType })`;`find_agents` 读 agent **定义**(id 即 agentType),不再读 actor 行 |
| 死锁 | CEO→Leader→IC 扇出可构造槽池死锁(父占槽等子) | 父阻塞等子时**让出自己的槽**,子结束后取回 |
| 子结果 | 父只拿到 summary 文本,分不清失败残稿和完成交付 | 结果携带 `status`,失败以 `[failed]` 前缀直接呈现给父 agent |
| 删除物 | — | `actors`/`messages`/`task_waiters` 三张表、mailbox、reply-registry、`send_message`/`send_and_wait`/`whoami`/`wait_for_task` 四个工具、EventBus、startCompany |

### 2.4 词汇与持久化数据

| | 之前 | 现在 |
|---|---|---|
| 事件 | 表叫 `run_events`,事件却叫 `task.*`;同一 ULID 有四个名字(turnId/runId/childRunId/correlationId);runner 局部变量故意叫回 `task` | 全线 `run.*`:wire 事件、payload 键(`runId`/`parentRunId`)、IPC(`cancelRun`)、renderer(`useRuns`/`RunRecord`) |
| 历史数据 | — | 带版本戳(schema_meta v2)的**单事务幂等迁移**原地改写旧行,老会话依然可渲染(已在真实 dev 库上验证);孤儿行顺带清扫 |
| 终态规则 | TS/SQL/reducer 三份手抄,漂移过一次 | `terminalStatusForRunEvent` 单一事实源,TS/SQL 等价性由测试断言 |

### 2.5 工具面

| | 之前 | 现在 |
|---|---|---|
| 派生工具 | `create_task`(默认行为却是老 spawn_sub_agent,名不副实;`asTopLevel` 只在会话轮次可用) | `delegate`(`topLevel?`),两分支对**所有** run 可用 |
| spawn 签名 | 5 个位置参数三层望远镜穿透 | options 对象 |
| 死旋钮 | `budget.tokens` 配置了从不生效;`toolScope` 除 authoring 外全解析成 `*` | tokens 从预算 schema/UI 删除(用量统计保留,两 schema 解耦);toolScope 坍缩为 `authoring` 布尔门(旧磁盘定义兼容) |

### 2.6 顺带修复的实证 bug(14 条台账,全部"由构造消灭")

用户可直接感知的:

1. **Gmail 邮件分析必崩**(`attachments!` 非空断言)→ 修复,并重建在 launchRun 上
2. **会话完成摘要永不显示**(发射端嵌套 `result.*` vs 协议扁平 `summary`)→ 修复
3. **中断后状态不一致**(双终态)→ 见 2.2
4. 取消排队中的 run 竞态、`contextWindow` 回退后冻结、恢复顺序洞、权限事件词汇等 → 全部修复

---

## 3. 阶段与合并点

| 阶段 | 内容 | 合并 |
|---|---|---|
| W0 | 3 个热修复打在老引擎上(保生产可用) | 07-04 |
| W1 | `run.*` 协议 v2 + emit/retry/translator 骨架(应用零引用) | 07-04 |
| W2 | engine + launch(单终态、让槽、never-rejects、`acquireSlot` 中止契约) | 07-05 `2a92d7f` |
| W3 | actor 半边删除 + 提示词全册重写 + SessionService(暗置) | 07-05 `9a52bc7` |
| W4 | 全线改名 + DB 迁移 + 切换 + delegate + 死旋钮 + e2e/冒烟 | 07-05 `7306a8f` |

每个任务:独立实现者 → spec+质量双审查 → 修复循环;每个分支:最强模型整分支终审 → rebase + ff-only 合入。评审在合并前逮住的真问题包括:磁盘 agent 存储的 **roster 静默清空**(Critical,实证复现)、`acquireSlot` 无视中止信号的**整会话死锁**、`run_events` 无 FK 的孤儿行断言、plan 模式只读工具集失去在测断言等。

## 4. 冒烟验证(真实环境)

W4 构建 + 真实 dev 数据库:迁移 v2 落位、会话列表/导航正常、真实 "pong" 对话轮端到端跑通。持久化事件文法与设计完全一致:

```
run.created → run.progress(用户消息) → run.dispatched
→ run.progress(思考) → run.usage → run.progress(正文) → run.complete
```

注:旧会话正文为空是 4a 时代已批准的"pre-4a 历史可弃"(当时的历史存在已删除的 tasks/task_events 表中),非本次回归。

## 5. 合并后跟进清单(全部非阻塞)

- 旧嵌套 `result.summary` 的 COALESCE 展平(需 v3 迁移;对当前空历史库无收益)
- `run.tool_call` 死联盟成员:删除或标注保留
- store 的变异 getter `getInterruptedSessions` 命名债(W3 遗留)
- `serializeAgent`/`parseAgent` 不往返 `skills`/`thinkingLevel`(预先存在,接上消费方前无影响)
- cron 实时失败的内联错误文案(细节仍在 `run.error` 行)

完整清单与执行台账:`.superpowers/sdd/progress.md`。
