# 设计:涌现式软件公司原型(方案 A,预播种固定花名册)

> 状态:已通过 brainstorming 评审,待用户最终确认。
> 日期:2026-06-23
> 关联:[`2026-06-22-agent-cluster-actor-substrate-design.md`](./2026-06-22-agent-cluster-actor-substrate-design.md)(§8「公司模式」归属 + 涌现式优先决策);[`2026-06-22-agent-cluster-persistent-runloop-design.md`](./2026-06-22-agent-cluster-persistent-runloop-design.md)(计划 B,已合并);[`2026-06-22-agent-cluster-cross-dormancy-state-design.md`](./2026-06-22-agent-cluster-cross-dormancy-state-design.md)(阶段 3,已合并 `ae4bcf2`)。

---

## 1. 目标与动机

actor 基石(计划 A)+ 常驻 run-loop(计划 B)+ 跨休眠长期状态(阶段 3)已就位:Agent 可寻址、能同辈 RPC、常驻累积上下文、跨休眠记忆。本原型在这套底座上**验证 spec §8 的核心产品假设**:一组写对的 `AgentDefinition`(CEO/PM/engineer/reviewer)+ 调度 prompt,能让"软件公司"靠**约定涌现**真正协作完成一个多步任务——零新核心机制,不建一等 `Team`/Org 实体。

成功即证明:命名角色 actor 能经 `send_and_wait`/`spawn` 协作产出工件;失败则暴露涌现式的不足,为后续 gated 的 Org/Team 层提供依据。

### 设计哲学(不变量)

延续"无状态推理 + 外化状态"。本原型**不引入新核心机制**:角色 = `AgentDefinition`,职责/约定 = `systemPrompt`,协作 = 既有 `send_message`/`send_and_wait`/`spawn`/`whoami`,身份 = 既有 `ensureActor` 命名 actor。团队边界/路由/层级全靠 prompt 约定涌现。

---

## 2. 现状基线(被改动/依赖的代码)

> **实现前置动作**:开工先核实下列行号与现状(基于 `develop`,阶段 3 已合并)。

- `src/shared/agents/builtins.ts` —— `builtinAgents: AgentDefinition[]`(当前 3 个 macOS-UI 角色:default/researcher/executor)。本原型**新增** 4 个角色定义到此数组。
- `src/shared/types/agent.ts` —— `AgentDefinition = { id, name, description, systemPrompt, toolScope, maxIterations, model? }`;`deriveAllowlist(scope)`:`'all' → ['*']`(含 shell/fs/web/`agent.*`/memory/peekaboo)。
- `src/service/index.ts` —— `builtinAgents` 在此并入 agent store(新角色随之可用)。
- `src/service/session-manager.ts`
  - `ensureActor(sessionId, agentDefId, name?)`(`~:190`)—— 创建/复用命名、可寻址、持久(阶段 3)的 actor。当前**内部函数**,仅 `__ensureActorForTest`(`~:741`)暴露。本原型新增薄方法 `startCompany` 复用它。
  - `sendMessage(sessionId, from, to, payload, kind)` —— `resolveAddress = getActor ?? getActorByName`,故可按固定名投递。
  - `SessionManager` 接口(`~:74`)—— 新增 `startCompany` 方法签名。
- `src/service/agent-cluster.e2e.test.ts` / `agent-cluster-runloop.e2e.test.ts` —— stub-agent 驱动的 e2e 样板,本原型的验收测试仿此。

---

## 3. 决策汇总(brainstorming 已拍板)

| 决策 | 选择 | 理由 |
|---|---|---|
| 成员存在方式 | **预播种固定花名册**(方案 A) | 零新工具;完整用上命名 actor + 同辈 rpc + 跨休眠记忆;干净验证涌现 |
| 组织结构实体 | **不建**(靠约定涌现) | 遵 spec §8;避免过早抽象,gated 延后 |
| 角色 toolScope | **全部 `all`** | 原型不设能力边界,避免人为摩擦;角色差异只在 systemPrompt 职责约定 |
| 动态招募 | **不做**(方案 B 后续) | 固定花名册足以验证;先涌现 |
| 验证 | **确定性 stub-agent e2e + 手动真 LLM 冒烟** | 遵项目 stub 测试纪律;CI 安全 + 真实可观察 |

---

## 4. 架构设计

### 4.1 角色花名册(新增 `AgentDefinition`)

四个角色加进 `builtinAgents`,**名字 = id**(故 `getActorByName` 可按名寻址),`systemPrompt` 写明:本角色职责、**队友的固定名字**、用哪些协作工具委派/回报。全部 `toolScope: 'all'`,`maxIterations` 按工作量(engineer 较高)。

| id | toolScope | maxIterations | 职责(systemPrompt 约定) |
|---|---|---|---|
| `ceo` | `all` | 20 | 收目标 → `send_and_wait('pm', 目标+背景)` → 拿到交付物 → 产出最终总结(其 rpc 回信即整次运行结果)。不写代码。 |
| `pm` | `all` | 25 | 拆解目标 → `send_and_wait('engineer', 具体任务)` → 拿结果后 `send_and_wait('reviewer', 评审请求 + 工件位置)` → 评审有问题则再 `send_and_wait('engineer', 修复请求)` 迭代(**至多 10 轮**,prompt 写死上限)→ 汇总交付物回 CEO。 |
| `engineer` | `all` | 30 | 收具体任务 → 在工作目录写代码 + 跑测试(shell/fs)→ 可 `spawn` 零碎子活 → 完成后回报"做了什么 + 工件位置 + 测试结果"摘要。 |
| `reviewer` | `all` | 20 | 收评审请求 → 读 engineer 产出的文件 → 回 verdict(通过/需改)+ 具体问题清单。 |

- 每个角色一次公司运行内是**常驻 actor**:处理多条消息时上下文自然累积(计划 B),空闲休眠后再激活能重放历史(阶段 3)。
- prompt 写作约定:trigger-first 的 `description`(现有惯例);systemPrompt 显式列出队友名字与"何时委派给谁",这是涌现的全部来源。

### 4.2 启动入口 `startCompany`(SessionManager 薄方法)

```
startCompany(sessionId, goal): Promise<{ reply: string }>
  for roleId of ['ceo','pm','engineer','reviewer']:
     ensureActor(sessionId, roleId, /* name */ roleId)   // 固定名花名册
  return sendMessage(sessionId, /*from*/ null, /*to*/ 'ceo', goal, 'rpc')  // 踢启动并等 CEO 最终回信
```

- 纯组合既有 `ensureActor` + `sendMessage`,**非新核心机制**。
- 以 `kind:'rpc'` 投给 CEO,故 `startCompany` 的 Promise 在 CEO 产出最终总结时 resolve(整次公司运行的结果)。
- 暴露在 `SessionManager` 接口;原型阶段由 e2e 测试 / 小 dev 脚本驱动。

### 4.3 运行时数据流(全靠约定涌现)

```
goal ─rpc→ CEO
            └─send_and_wait→ PM
                              ├─send_and_wait→ ENGINEER   (写代码/跑测试; 可 spawn 子活)
                              └─send_and_wait→ REVIEWER   (读文件评审)
                                   ↑ 需改则回 ENGINEER 迭代(≤N 轮)
            ←──────────────── PM 汇总交付物
   CEO 最终总结 ──rpc reply──→ startCompany 调用方
```

无新机制:CEO/PM/engineer/reviewer 的每次 `send_and_wait` 各自激活目标 actor、跑一个 turn、回信(计划 B 的 turn-slot 让出确保深 rpc 链不死锁)。

---

## 5. 错误处理 / 边界

| 情况 | 处理(全部落在既有底座行为) |
|---|---|
| 某角色 rpc 超时 | `send_and_wait` 返回 timeout 文本,调用方角色据此决定(prompt 约定:回报失败而非永久阻塞)|
| 评审反复不通过 | PM 的 prompt 写死迭代上限 10 轮,超限则带"未达标"说明汇总回 CEO,不无限循环 |
| 深层 rpc 链(CEO→PM→engineer)| 计划 B 的 turn-slot 让出已消除嵌套死锁;`maxConcurrent` 仍是统一上限 |
| 角色 turn 内崩溃 | 既有重试/死信(`onError`/`bumpRetries`);该角色状态已按阶段 3 落库,再激活重放 |
| 未知队友名 | `resolveAddress` 命中不到 → 既有死信 + `warn`(prompt 约定固定名,正常不触发)|

无新增日志组件;复用既有 `actor-runtime`/`mailbox`/`actor-state` 打点即可观察整条协作链。`startCompany` 自身在 `session-manager` 的 logger 打 `info`(company started, sessionId, goalLen)。

---

## 6. 测试策略(TDD)

经 Electron node 运行:`npm test`(勿裸 `npx vitest`;勿 `pnpm rebuild better-sqlite3`)。`src/service/**` 不在 typecheck 范围,靠 vitest 兜类型。

- **`startCompany` 单测**:调用后 `ensureActor` 为四个固定名各建一个 actor;以 rpc 投给 `ceo`;返回 CEO 的回信。
- **确定性协作 e2e(主验收)**:仿 `agent-cluster.e2e.test.ts` stub agent —— 脚本化委派:CEO 收 goal → 向 pm 发 → pm 向 engineer、reviewer 发 → reviewer 回 verdict → pm 汇总回 CEO → CEO 回 startCompany。断言:四个命名 actor 被播种;消息按预期链路路由;最终回信回到 kickoff。证明接线确定可重放。
- **迭代回环**:stub reviewer 首轮回"需改"→ 断言 pm 再次 `send_and_wait('engineer')`,二轮回"通过"→ 收敛(验证 PM prompt 约定的迭代上限逻辑可被驱动;上限本身是 prompt 内容,e2e 验证机制可达)。
- **角色定义健全性**:四个新 `AgentDefinition` 通过 `AgentDefinitionSchema` 校验;id 唯一;`toolScope:'all'`;description trigger-first 非空。
- **回归**:现有 3 个 builtin 角色不受影响;计划 A/B/阶段 3 全部测试仍绿。
- **手动真 LLM 冒烟(文档化,不进 CI)**:dev 脚本用真 provider 调 `startCompany` 给一个真实小任务(如"在临时目录实现并测试一个小工具函数"),在日志/transcript 观察四角色经 `send_and_wait` 完整协作并产出工件。

---

## 7. 文件结构(实现指引)

- **修改** `src/shared/agents/builtins.ts` —— 新增 4 个角色 `AgentDefinition`(ceo/pm/engineer/reviewer)+ 各自 systemPrompt 常量。这是主要"内容"改动。
- **修改** `src/service/session-manager.ts` —— 新增 `startCompany(sessionId, goal)` 方法 + `SessionManager` 接口签名;复用 `ensureActor`/`sendMessage`。
- **新增** `src/service/company.e2e.test.ts` —— stub-agent 驱动的协作链 e2e + `startCompany` 单测 + 迭代回环测试。
- **可能新增** `scripts/smoke-company.ts`(或 dev-only 测试)—— 手动真 LLM 冒烟入口(文档化用法)。
- 改动外科手术式,保持现有 factory+closure / builtins 数组风格。

---

## 8. 范围与非目标(YAGNI)

- **不建** 一等 `Team`/Org 实体、路由器、共享黑板(spec §8 gated 延后)。
- **不做** 动态招募 `hire`/`spawn_named` 工具(方案 B,后续)。
- **不做** 公司 UI 接线(原型从 `startCompany`/测试驱动)。
- **不做** 并行多 engineer / 多团队(先单链验证涌现)。
- **不加** 超出 `toolScope` 的角色权限强制(全 `all`)。
- 不改与本目标无关的代码。

---

## 9. 实现注意

- 按 CLAUDE.md §6,在专用 git worktree 的独立分支实现(基于 `develop`)。
- 验收核心:确定性协作 e2e —— 先写它,确保花名册播种 + `send_and_wait` 路由 + 回信链确定跑通。
- 角色 systemPrompt 是本原型成败关键:队友固定名、委派时机、回报格式必须写清,因为"涌现"= 这些约定。
- `startCompany` 的固定名花名册用常量数组,单一真相源,避免 prompt 里队友名与播种名漂移。
