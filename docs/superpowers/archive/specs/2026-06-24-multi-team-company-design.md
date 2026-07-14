# 设计:多团队公司(CEO + 团队 head 路由 + 训练团队样板能力)

> 状态:已通过 brainstorming 评审,待用户复审。
> 日期:2026-06-24
> 关联:
> - [`2026-06-23-emergent-software-company-prototype-design.md`](./2026-06-23-emergent-software-company-prototype-design.md)(§8 gated 的 Org/Team 层,本设计落地它)
> - [`2026-06-23-agent-role-discovery-design.md`](./2026-06-23-agent-role-discovery-design.md)(`find_agents` 发现层 + 末节预告的 `team` 扩展,本设计实现)
> - [`2026-06-22-agent-cluster-actor-substrate-design.md`](./2026-06-22-agent-cluster-actor-substrate-design.md) / persistent-runloop / cross-dormancy(actor 底座,已合并)

---

## 1. 目标与动机

actor 底座(寻址 + 同辈 RPC + 常驻 + 跨休眠记忆)、`find_agents` 按角色发现、`ceo/pm/engineer/reviewer` 涌现式开发团队原型均已就位。本设计在此之上落地 spec §8 deliberately gated 的 **Org/Team 层**:把单链"软件公司"扩展成**多团队公司** —— 一个 CEO 跨团队协调,多个团队各有 head(团队入口/团内路由器)与 IC,聊天框可 `select` 切换团队、绕过 CEO,默认与 CEO 对话。

并验证关键产品假设:**团队是真实能力载体,不是组织架构 cosplay**。为此给 **Agent 训练团队**接入差异化元能力(创作/编辑 agent 与 skill),形成"能自我扩充的 swarm"闭环。

### 设计哲学(不变量)

延续"无状态推理 + 外化状态 + 不建一等 Org/Team 实体"。组织结构靠 `AgentDefinition` 上的**轻量标签**(`team`/`teamRole`)+ prompt 约定 + `find_agents` 查询过滤涌现。协作仍是既有 `send_and_wait`/`find_agents`/`spawn`。**唯一的新核心机制是训练团队的元工具**(`write_agent`/`write_skill`)—— 这是"能力型团队"必需的真实能力,而非组织抽象。

---

## 2. 现状基线(被改动/依赖的代码)

> **实现前置动作**:开工先核实下列行号与现状(基于 `develop`)。

- `src/shared/types/agent.ts` —— `AgentDefinition = { id, name, description, systemPrompt, toolScope, maxIterations, model?, role?, capabilities? }`;`deriveAllowlist(scope)`。本设计**新增** `team?`、`teamRole?` 两字段。
- `src/shared/agents/builtins.ts` —— `builtinAgents`(default/researcher/executor + ceo/pm/engineer/reviewer 共 7 个)。本设计给 ceo/pm/engineer/reviewer 加 `team`/`teamRole`,改写 CEO prompt,新增 training 团队 2 个角色。
- `src/service/agents/store.ts` ——
  - 磁盘格式 = `<dir>/<id>/AGENT.md`(YAML frontmatter + body=systemPrompt),`parseAgent(raw,id)` 解析。**当前 frontmatter 只 round-trip `name/description/toolScope/maxIterations/model`**;`role`/`capabilities` 既不读也不写(既有缺口)。`serializeAgent(def)` 同样缺 `role`/`capabilities`。
  - `createAgentStore({ dir, builtins })`:`merged()` = 内置中未被用户 id 覆盖者 + 用户磁盘 agent。`reload()` 扫 dir;`save(def)`(校验 → `serializeAgent` 写盘 → reload)、`remove(id)`、`get(id)`、`list()`。
- `src/service/directory/receptionist.ts` —— `createAgentDirectory({ listActors, isLive, getAgentDef })`;`PeerQuery = { role?, capability?, query? }`;`find(sessionId, q, selfAddress?)` 过滤+打分+排序。本设计扩展 `PeerQuery` 加 `team?`/`teamRole?`。
- `src/service/tools/messaging.ts` —— `findAgentsSpec()` → `find_agents` 工具。本设计加 `team`/`teamRole` 入参透传;**新增** `writeAgentSpec()`/`writeSkillSpec()`(训练团队元工具)。
- `src/service/session/manager.ts` —— `submitGoal(... , options?: { agentType? })`(`~:442` / `~:654`):`options.agentType` 解析为 agent def,未命中 fall back 到 default。`startCompany`(预播种花名册 + rpc 投 CEO)。
- `src/shared/types/task.ts` —— `TaskOptions.agentType?: string`(渲染层已可传)。
- composer(渲染层,`src/renderer/**`)—— **当前无 agent/团队选择器 UI**;本设计新增团队 `<select>`,把选择写进提交的 `options.agentType`。
- 测试基线:`src/service/agents/store.test.ts`、`directory/receptionist.test.ts`、`tools/messaging.test.ts`、`e2e/company*.e2e.test.ts`(stub-agent 驱动)。

---

## 3. 决策汇总(brainstorming 已拍板)

| 决策 | 选择 | 理由 |
|---|---|---|
| 团队的本质 | **混合:组织结构层先行 + 1 个能力团队样板** | 尽快验证 CEO/团队协作涌现,同时避免团队全是 prompt 空壳 |
| 样板能力团队 | **Agent 训练团队**(元能力:创作/编辑 agent & skill) | 能力最差异化(别团队都没有这组元工具),形成自我扩充闭环,且直接用上磁盘 agents/skills 目录 |
| 团队 select 语义 | **head 作团队入口**;选团队 = 直接和 head 对话绕过 CEO;默认 = CEO | 层级最清晰:CEO=跨团队路由器,head=团内路由器;单团队工作省一跳 |
| 组织结构实体 | **不建**(`team`/`teamRole` 轻量标签 + prompt 约定 + find_agents 过滤) | 遵 spec §8 + 2026-06-23 决策;避免过早抽象 |
| agent 存放 | **代码内置骨架 + 磁盘叠加**(`~/.swarm-agents/agents/<id>/AGENT.md`,同 id 用户覆盖内置) | 骨架开箱即用、随版本演进;磁盘层留给用户与训练团队产出,不引入 seed 漂移 |
| 范围 | **方案 A**(数据模型 + find_agents 扩展 + 训练元能力 + 选择器 UI + CEO/dev/training 花名册) | 完整闭环可手动验真,单 spec 能装下;`eval_agent` 判定模糊延后 |
| 验证 | **确定性 stub-agent e2e + 单测 + 手动真 LLM 冒烟** | 遵项目 stub 测试纪律 |

---

## 4. 架构设计

### 4.1 三层组织模型(零新核心机制)

```
                      用户(你)
                         │  默认收件人 = CEO
                         ▼
                    ┌─────────┐
                    │   CEO   │  跨团队路由器:find_agents({teamRole:'head'}) → send_and_wait 派给各团队 head
                    └────┬────┘  (无 team;全公司)
          ┌──────────────┴──────────────┐
          ▼                              ▼
   ┌──────────────┐              ┌──────────────┐
   │ dev head(PM) │              │ training head│      ← teamRole:'head',团内路由器
   │  team:'dev'  │              │team:'training'│
   └──────┬───────┘              └──────┬───────┘
      ┌───┴────┐                        │
      ▼        ▼                        ▼
  engineer  reviewer            training-author          ← IC,各挂不同 skill / 能力
  team:dev  team:dev            team:training
                                (持 write_agent/write_skill)
```

- **CEO**:默认对话对象,无 `team`。只跨团队协调:`find_agents({ teamRole:'head' })` 找到各团队 head,`send_and_wait` 派活,汇总回用户。不亲自干活。
- **团队 head**(`teamRole:'head'`):团队入口 + 团内路由器。`select` 切到该团队 = 顶层 agent 设为它,**绕过 CEO**。head 用 `find_agents({ team:'X' })` 在团内派给 IC。
- **IC**:实干 subAgent,差异在 systemPrompt 职责 + 各自挂载 skill / 能力。
- 协作 = 既有 `send_and_wait`/`find_agents`/`spawn`;**不建 Team/Org 实体**。

### 4.2 数据模型改动(最小)

`src/shared/types/agent.ts` —— `AgentDefinition` 加两个可选字段:
- `team?: string` —— 团队标签(`'dev'`/`'training'`);CEO 与通用骨架(default/researcher/executor)无 team。
- `teamRole?: 'head'` —— 标记团队负责人;缺省 = 普通 IC。Schema 中可选,无跨字段默认。

> **同时修复既有缺口**:`parseAgent`/`serializeAgent`(`store.ts`)扩展 frontmatter round-trip,新增 `role`/`capabilities`/`team`/`teamRole` 的读写。否则磁盘上的团队 agent 会丢这些字段(`role`/`capabilities` 当前就已丢失,本设计顺手补齐,因为训练团队产出的新 agent 必须能带 team/role 落盘并被 `find_agents` 发现)。

### 4.3 发现层扩展

`src/service/directory/receptionist.ts` —— `PeerQuery` 加 `team?`/`teamRole?`:
- `q.team` 设定时,只留 `team === q.team` 的 peer。
- `q.teamRole` 设定时,只留 `teamRole === q.teamRole` 的 peer。
- 其余过滤/打分/排序逻辑不变(沿用现有 role/capability/query 三段)。

`src/service/tools/messaging.ts` —— `find_agents({ role?, capability?, query?, team?, teamRole? })` 透传新参数到 `findPeers`,输出行追加 team 标注。**不动消息投递**(发现与投递仍是 find→send 两步)。

### 4.4 训练团队的真实能力(元工具)

核心:复用 `AgentStore.save()`(校验 → 落盘 `<id>/AGENT.md` → reload)与 skills 目录的既有 chokidar 热重载(commit `ff31848`)。元工具写文件后,新 agent/skill 立即可被发现/调用。

`src/service/tools/messaging.ts`(或新建 `tools/authoring.ts`)新增两个工具,**仅训练团队 toolScope 可达**:

| 工具 | 入参 | 实现 | risk |
|---|---|---|---|
| `write_agent` | `{ id, name, description, systemPrompt, toolScope, team?, role?, capabilities?, maxIterations? }` | 组装 `AgentDefinition` → `ctx.writeAgent(def)`(包装 `AgentStore.save`,内含 `AgentDefinitionSchema` 校验)→ 成功返回新 agent 位置/可被 `find_agents` 发现 | `medium`(代码注入语义,默认走权限提示) |
| `write_skill` | `{ name, description, body, allowedTools? }` | 写 `~/.swarm-agents/skills/<name>/SKILL.md`(frontmatter + body)→ chokidar 自动重载 | `medium` |

- 经由 `ToolRunContext` 注入 `writeAgent(def)`/`writeSkill(...)` 闭包(沿用 receptionist `findPeers` 的注入路径:`AgentRunnerDeps` → `buildToolContext`),避免工具裸用 `fs`,**强制 schema 校验**(不写坏定义)。
- `eval_agent`(对新建 agent 跑冒烟并判定)**判定标准模糊,v1 不做**,留待验证后细化(避免硬编近似判定)。

### 4.5 UI:composer 团队选择器(公司功能首个 UI)

复用早已铺好但无 UI 的 `options.agentType` 管线。

- composer 顶部加 `<select>`,项 = **「公司(CEO)」(默认)+ 每个 `teamRole:'head'` 的团队**。
- 列表**从 agent store 派生**:遍历 `store.list()`,`teamRole==='head'` 的 agent → 一项(label 取其 `team`/`name`,如「💻 开发团队」「🧠 Agent 训练团队」);外加固定的「🏢 公司(CEO)」首项。**不写死** —— 训练团队后续 `write_agent` 造出带 `teamRole:'head'` 的新团队负责人,选择器自动多一项。
- 选「公司(CEO)」→ 提交 `options.agentType = 'ceo'`(默认)。
- 选某团队 → 提交 `options.agentType = <该 head 的 agent id>`,绕过 CEO 直接对话。
- 只影响**新消息的顶层 agent**;不改"一会话一顶层 agent"模型。

### 4.6 运行时数据流

```
选「公司」: 你 ─→ CEO ─find_agents(teamRole:head)→ 各 head ─send_and_wait→ 团队产出 ─→ CEO 汇总 ─→ 你
选「开发」: 你 ─→ dev head(PM) ─find_agents(team:dev)→ engineer/reviewer ─迭代→ 汇总 ─→ 你   (无 CEO 跳)
选「训练」: 你 ─→ training head ─→ write_agent / 派 training-author ─→ 落盘新 agent/skill ─→ 回报 ─→ 你
```

---

## 5. v1 初版花名册

| 团队 | head | IC | 改动 |
|---|---|---|---|
| (无,全公司) | **ceo** | — | 加无 team;改写 prompt 为"find_agents({teamRole:'head'}) 协调各团队 head" |
| **dev** | **pm**(`team:'dev'`,`teamRole:'head'`) | engineer, reviewer(`team:'dev'`) | 复用现有 4 角色,加 team 标签;PM prompt 改为 `find_agents({ team:'dev', role:'engineer'/'reviewer' })` |
| **training** | **training-head**(`team:'training'`,`teamRole:'head'`,caps `['agent-authoring','skill-authoring']`) | **training-author**(`team:'training'`,持 `write_agent`/`write_skill`) | **新增** 2 个 `AgentDefinition` + systemPrompt |

> 通用骨架 default/researcher/executor 保持无 team(不进团队选择器),仅作 spawn/兜底用。UI 团队**不在 v1** —— 它是纯 prompt 团队,后续训练团队可自行 `write_agent` 造出,恰好演示闭环。

---

## 6. 错误处理 / 边界

| 情况 | 处理(落在既有底座) |
|---|---|
| 某 head rpc 超时 | `send_and_wait` 返回 timeout 文本,CEO 据 prompt 约定回报失败而非永久阻塞 |
| `write_agent` 定义非法 | `AgentStore.save` 的 schema 校验返回 `{ ok:false, code, message }`,工具回报错误文本,不落坏文件 |
| `write_agent` id 撞内置骨架 | merge 语义 = 用户 id 覆盖内置;工具回报"将覆盖内置 X"提示(prompt 约定避免误覆盖核心骨架) |
| `select` 选了已被删除/改名的 head | `options.agentType` 未命中 → 既有 fall back 到 default + `warn`(manager.ts:443/655) |
| 训练团队造出的 head 未带 `teamRole:'head'` | 选择器不显示该团队(派生条件);prompt 约定造团队 head 必带该标签 |
| 深层 rpc 链(CEO→head→IC) | 计划 B turn-slot 让出已消除嵌套死锁;`maxConcurrent` 仍是统一上限 |

`write_agent`/`write_skill` 在 service logger 打 `info`(authored agent/skill, id/name)+ 失败 `error`;选择器切换在渲染层既有打点即可观察。

---

## 7. 测试策略(TDD)

> 经 Electron node 跑 `npm test`(勿裸 `npx vitest`;勿 `pnpm rebuild better-sqlite3`)。`src/service/**` 不在 typecheck 范围,靠 vitest 兜类型。

- **`agents/store.test.ts`**:`parseAgent`/`serializeAgent` round-trip 新增 `role`/`capabilities`/`team`/`teamRole`(写盘再读回不丢);坏 frontmatter 仍被拒。
- **`directory/receptionist.test.ts`**:`team` 过滤;`teamRole` 过滤;两者与现有 role/capability/query 组合;骨架排序回归。
- **`tools/messaging.test.ts`**:`find_agents` 透传 `team`/`teamRole` 并格式化输出;`write_agent` 合法定义经 `ctx.writeAgent` 落盘 + schema 拒绝坏定义 + 落盘后 `find_agents` 能发现新 agent(确定性,不调真 LLM);`write_skill` 写出 `SKILL.md` 且 frontmatter 合法。
- **多团队协作 e2e**(主验收,仿 `company.e2e.test.ts` stub-agent):CEO `find_agents({teamRole:'head'})` → 派给 dev head 与 training head → dev head `find_agents({team:'dev'})` 派 engineer/reviewer → 汇总回 CEO/用户。断言:团队标签播种正确;路由链按 head→IC 走;选择器派生项 = CEO + dev head + training head。
- **渲染层**:团队选择器从 `store.list()` 派生项(CEO 首项 + 每个 teamRole:'head');切换写 `options.agentType` 到提交载荷。
- **角色定义健全性**:新增 training 2 角色过 `AgentDefinitionSchema`;id 唯一;head 带 `teamRole:'head'`;description trigger-first。
- **回归**:现有 7 个 builtin + 计划 A/B/阶段 3 + 发现层全部测试仍绿(当前约 572+,数目上升 0 失败)。
- **手动真 LLM 冒烟**(文档化不进 CI):选「训练团队」让其真造一个新 agent(如一个简单的 docs 团队 head),观察落盘 `<id>/AGENT.md` + 选择器多一项 + 新 agent 可被 `find_agents` 派活。

---

## 8. 文件结构(实现指引)

- **修改** `src/shared/types/agent.ts` —— `AgentDefinition` 加 `team?`/`teamRole?`;`AgentDefinitionSchema` 同步。
- **修改** `src/service/agents/store.ts` —— `parseAgent`/`serializeAgent` round-trip `role`/`capabilities`/`team`/`teamRole`。
- **修改** `src/service/directory/receptionist.ts` —— `PeerQuery` 加 `team?`/`teamRole?` + 过滤。
- **修改** `src/shared/agents/builtins.ts` —— ceo/pm/engineer/reviewer 加 team/teamRole + 改写 CEO/PM prompt;新增 training-head / training-author 两角色。
- **修改/新增** `src/service/tools/messaging.ts`(或新建 `tools/authoring.ts`)—— `find_agents` 加参;`write_agent`/`write_skill` 工具 + 注入 `ctx.writeAgent`/`ctx.writeSkill`(经 `AgentRunnerDeps`→`buildToolContext`,包装 `AgentStore.save` 与 skills 写盘)。
- **修改** `src/service/tools/registry.ts` / `session/agent-runner.ts` / `session/manager.ts` —— `ToolRunContext` + `AgentRunnerDeps` 加 `writeAgent`/`writeSkill`;manager 注入(持有 agentStore 引用)。
- **修改** composer(`src/renderer/**`)—— 团队 `<select>` 派生 + 写 `options.agentType`。
- **新增** 对应 `*.test.ts` + `e2e/multi-team-company.e2e.test.ts`。
- 改动外科手术式,保持 factory+closure / builtins 数组 / 单文件 slice 风格。

---

## 9. 范围与非目标(YAGNI)

- **不建** 一等 `Team`/Org 实体、路由器服务、共享黑板。
- **不做** `eval_agent` 自动判定(v1 延后,判定标准未定)。
- **不做** UI 团队 v1 内置(留给训练团队 `write_agent` 演示闭环)。
- **不做** 团队"群聊"式多 agent 同屏对话(沿用一会话一顶层 agent)。
- **不做** 跨会话发现 / 团队级权限强制(发现仍 session-scoped;权限仍靠 toolScope)。
- **不把** 骨架搬上磁盘当 seed(保留内置,避免 seed 漂移)。
- 不改与本目标无关的代码。

---

## 10. 实现注意

- 按 CLAUDE.md §6,在专用 git worktree 的独立分支实现(基于 `develop`)。
- 验收核心 = 多团队协作 e2e:先写它,确保 team 标签播种 + `find_agents({teamRole:'head'})`/`({team})` 路由 + head→IC 链确定跑通。
- `write_agent` 必须包装 `AgentStore.save`(强制 schema 校验),**禁止**让工具裸 `fs.writeFile` 拼 JSON/frontmatter(避免懒启发式写坏定义)。
- 团队 head 的判定单一真相源 = `teamRole:'head'`,选择器、CEO 发现、e2e 断言都读它,避免漂移。
- prompt 是成败关键:CEO 用 `teamRole:'head'` 发现、各 head 用 `team` 发现、训练团队造 head 必带 `teamRole:'head'` —— 写清这些约定,涌现 = 这些约定。
- 业务路径按 CLAUDE.md §5 打结构化日志(`write_agent`/`write_skill` 入口 info、catch error、找不到 head 等分支 warn)。
