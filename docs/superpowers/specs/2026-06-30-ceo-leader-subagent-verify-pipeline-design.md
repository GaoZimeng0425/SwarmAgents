# 设计:CEO→Leader→subagent 三级目标验收委派流水线

- **日期:** 2026-06-30
- **状态:** 已通过 brainstorming 设计评审,待用户复审
- **关联:**
  - [`2026-06-28-goal-verified-task-loop-design.md`](./2026-06-28-goal-verified-task-loop-design.md) —— 本设计直接复用其 per-task 验收循环(derive→execute→verify→rework)。
  - [`2026-06-24-multi-team-company-design.md`](./2026-06-24-multi-team-company-design.md) —— CEO + 团队 head 底座(team/teamRole 标签 + find_agents)。
  - `CLAUDE.md` §4(目标驱动执行)。
- **外部参考:** `OthmanAdi/planning-with-files`(借其 plan 项的 `Owner`/`DependsOn` 思想做派发 DAG,以及 gate 的 stall detection 思想)。

---

## 1. 问题与动机

现状的 per-task goal-verify 循环只做"单个任务验**自己**的执行";多团队公司(CEO + 团队 head)靠 actor messaging 协调,但**没有跨层级验收**。

用户要的是一条**自主**的三级流水线:

```
CEO 设目标+验收 → 各 Leader 设计达成计划 → 并行派 subagent 执行 → Leader 先验 → CEO 终验
```

核心洞察(也正是"为什么之前不能和 task 结合"的答案):验证原语 per-task 自验是对的,任务树也是对的,**只缺三件事**——

1. 验收条件随委派**下传**(现在 `spawnChild` 把它丢了);
2. 子任务能**开验收循环**(现在硬写 `maxVerifyRounds: 0`);
3. Leader 的计划要带"**谁做 + 依赖**"以支持并行波次(现在 `PlanTodo` 只有 `{content, status}`)。

补上后,跨层验收自然涌现:每一层都是一个"会验收的 Task",父层的验收门判的就是"子层产出的汇总 summary"。

---

## 2. 现状基线(已核实,基于 develop)

- **`src/service/session/manager.ts`**
  - `spawnChild`(L509-655):异步起子任务,走**全局** `maxConcurrent` 信号量(`acquireSlot` L197),**绕过**单会话 `pump`(L215)——因此子任务天然可并行。
  - **L595 硬写 `maxVerifyRounds: 0`**,注释原文:*"Children verify single-shot; only top-level submitGoal tasks run the verify loop."*
  - `spawnChild` 签名**无 `acceptanceCriteria`**;子 Task 构建(L537-553)也不带验收条件。
  - `submitGoal` 顶层任务:L812 `acceptanceCriteria: options?.acceptanceCriteria`、L877 `maxVerifyRounds: MAX_VERIFY_ROUNDS`(顶层会验)。
- **`src/service/session/agent-runner.ts`**
  - `spawnChild` dep(L200-206):`(parentTaskId, newGoal, suggestedTools?, providerKey?, agentType?)`。
  - `buildToolContext`(L299-324):`setAcceptanceCriteria: deps.onAcceptanceCriteria` 已注入。
  - 三阶段循环 + `runGoalVerifyLoop`(L1238)+ `defaultVerifyCompletion`(L1182)+ 派生/judge prompts(L1149+)。
- **`src/service/tools/spawn.ts`**:`spawn_sub_agent` 工具,params = `{ goal, agentType?, suggestedTools?, providerKey? }`。
- **`src/service/tools/acceptance-criteria.ts`**:`set_acceptance_criteria`(本设计的 `set_delegation_plan` 镜像它)。
- **`src/shared/types/task.ts`**:`AcceptanceCriterionSchema`(L88)/`ExecutableCheckSchema`(L71)/`TaskOptionsSchema`(L113)/`TaskSchema`(L194;`acceptanceCriteria` L223、`verifications` L225)。
- **`src/shared/types/ui.ts`**:`task.criteria`(L94)/`task.verification`(L95)事件已有。
- **pi-agent-core:**`toolExecution` 默认 `"parallel"`(`node_modules/@earendil-works/pi-agent-core/dist/agent.js:128`),runner 未覆盖 → **一个 turn 内多个工具调用并发执行**。
- **多团队底座:**`AgentDefinition.team`/`teamRole`、`find_agents({ teamRole:'head' })`;现有 head = pm(team:dev)、training-head(team:training)。

---

## 3. 决策汇总(brainstorming 已拍板)

| # | 决策 | 选择 | 理由 |
|---|---|---|---|
| 1 | 流程准入 | **全程自动**,无审批门 | 用户拍板;无需新建阻塞/审批原语 |
| 2 | 顶层目标/验收来源 | **CEO 自动派生**(Phase A) | 用户拍板;composer 不改 |
| 3 | 架构 | **任务树 + 会验收的子任务**(方案 A) | 最大化复用 verify 循环 / spawnChild / 任务树;每层对称 |
| 4 | 并行模型 | **DAG 波次调度** | 借 planning-with-files 的 `DependsOn`;支持真实先后依赖,非无脑全派 |
| 5 | 叶子是否自验 | **否**(`maxVerifyRounds: 0`) | 正好对应"Leader 验 → CEO 验"两级;控成本 |
| 6 | 波次派发 | **agent 驱动**(prompt + 扩展 spawn 工具);DAG 用 `set_delegation_plan` 记录供审计/UI,不机械强制 | 贴合 in-runner 取向与"计划 = 指引"精神 |
| 7 | v1 Leader | **复用现有团队 head**,仅改 prompt | 不新增 agent def,最小闭环 |
| 8 | 跨层验收判据 | v1 **信任父层汇总 summary**;"judge 直吃子层 summary"留作增强 | 先跑通,后加准 |
| 9 | pipeline 内委派方式 | **spawnChild**(进验收任务树),不走 actor rpc | 让验收可组合;常驻 CEO/head 对话路径不受影响 |

---

## 4. 架构

三层任务树,**每个非叶节点都是一个跑 goal-verify 循环的 Task**,叶子单发:

```
submitGoal(agentType:'ceo')
  └─► CEO Task (根,跑 verify 循环)
       │ Phase A:set_acceptance_criteria 派生顶层验收条件
       │ 执行:find_agents({teamRole:'head'}) → 给每个 Leader 并行 spawnChild
       │        (下传:子目标 + 子验收条件 + maxVerifyRounds=3)
       │ 验收门:judge「各 Leader 汇总 summary」vs 顶层条件 → fail 则再派/返工
       │
       └─► Leader Task(s)  (现有团队 head,并行兄弟,跑 verify 循环)
            │ Phase A:criteria 由 CEO 供给 → 跳过派生
            │ 执行首步:set_delegation_plan 声明 DAG
            │          {item: 子目标, owner, dependsOn, item-验收条件}
            │ 后续:按依赖**波次**派发 —— 同一波(无未满足依赖)的项
            │        在一个 turn 内并行 spawnChild(下传:item 子目标 + item 验收 + maxVerifyRounds=0)
            │        等该波全回 → 派下一波
            │ 验收门:judge「各 subagent 汇总 summary」vs Leader 子条件
            │
            └─► Subagent Task(s)  (叶子,波内并行,单发)
                 │ maxVerifyRounds=0,不自验;由 Leader 验收其产出
                 │ summary 回冒给 Leader
```

**核心不变量:** 跨层验收无需新原语——父层验收门判自己的 summary,而那个 summary 就是子层产出的汇总。

**解锁整棵树的三处改动:**
1. `spawnChild` 能下传 `acceptanceCriteria` 合同。
2. 子任务能开验收循环(按调用方决定 `maxVerifyRounds`)。
3. 新增 `set_delegation_plan` 工具,让 Leader 声明带 `Owner`+`DependsOn` 的派发 DAG。

---

## 5. 数据模型(`src/shared/types/task.ts` + 透传链路)

### 5.1 `spawnChild` 扩参

`AgentRunnerDeps.spawnChild` 与 manager 内 `spawnChild` 增加 options 透传:

```ts
spawnChild(
  parentTaskId: string,
  newGoal: string,
  suggestedTools?: string[],
  providerKey?: string,
  agentType?: string,
  options?: {
    acceptanceCriteria?: AcceptanceCriterion[]   // 下传合同;子 Task 带上 → 跳自己的 Phase A
    maxVerifyRounds?: number                     // 默认 0(叶子单发);Leader 传 MAX_VERIFY_ROUNDS
  }
): Promise<{ childTaskId: string; result: TaskResult }>
```

manager 内构建 child Task(L537-553)新增 `acceptanceCriteria: options?.acceptanceCriteria`,并把 `maxVerifyRounds`(L595)由硬写 `0` 改为 `options?.maxVerifyRounds ?? 0`。

`spawn_sub_agent` 工具 params(`tools/spawn.ts`)新增 `acceptanceCriteria?` 与 `verify?: boolean`(后者映射到 `maxVerifyRounds`:true→`MAX_VERIFY_ROUNDS`,false/缺省→0)。

### 5.2 `DelegationItem` schema

```ts
export const DelegationItemSchema = z.object({
  id: z.string().min(1),
  goal: z.string().min(1),
  ownerAgentType: z.string().optional(),            // 派给哪种 subagent;缺省=default
  dependsOn: z.array(z.string().min(1)).default([]), // 兄弟 item id;空=无依赖(第一波)
  acceptanceCriteria: z.array(AcceptanceCriterionSchema).optional(), // 该 item 的验收条件
})
export type DelegationItem = z.infer<typeof DelegationItemSchema>
```

`TaskSchema` 加 `delegationPlan: z.array(DelegationItemSchema).optional()`(审计 + UI)。

### 5.3 `set_delegation_plan` 工具(新,`src/service/tools/delegation-plan.ts`)

镜像 `acceptance-criteria.ts`:`group:'agent'`、`risk:'low'`、强制 schema 校验、id 在此分配(d1..dn)、经 `ctx.setDelegationPlan` 回 runner,emit `task.delegation_plan` 事件。

`ToolRunContext`(`registry.ts`)加 `setDelegationPlan?(plan: DelegationItem[]): void`;`buildToolContext` 注入 `setDelegationPlan: deps.onDelegationPlan`;`AgentRunnerDeps` 加 `onDelegationPlan?(plan: DelegationItem[]): void`,由 `createAgentRunner.run` 包装持久化(类比 `onAcceptanceCriteria`)。

### 5.4 持久化(`src/service/conversation/store.ts`)

类比 `saveTaskCriteria`:新增 `tasks.delegation_plan TEXT NOT NULL DEFAULT '[]'` 列 + migration;`rowToTask` 解析;`saveTaskDelegationPlan(taskId, plan)`;`ConversationStore` 类型签名。

### 5.5 事件(`src/shared/types/ui.ts`)

`UIEvent` 加 `task.delegation_plan`(类比 L94 `task.criteria`)。manager `makeEmit` 加分支持久化(类比 L265)。

---

## 6. 委派合同(下传内容)

| 调用 | `goal` | `acceptanceCriteria` | `maxVerifyRounds` | `agentType` |
|---|---|---|---|---|
| CEO → Leader | Leader 子目标 | CEO 派生的该 Leader 子条件 | `MAX_VERIFY_ROUNDS`(3) | 团队 head id |
| Leader → subagent | DAG item 子目标 | 该 item 的验收条件 | `0`(叶子单发) | item.`ownerAgentType` |

> CEO 把顶层条件"按 Leader 职责切片"下发;Leader 收到后**跳过自己的 Phase A**(criteria 已供给),但仍要**自己定派发计划**(`set_delegation_plan`,属执行首步而非 Phase A)。叶子收到 item 验收条件,既不派生也不自验,产出 summary 由 Leader 验。

---

## 7. 各层 prompt 要点(`src/shared/agents/builtins.ts`)

**CEO** —— 改写为:
1. `set_acceptance_criteria`:把用户目标拆成可检的顶层 done-conditions;
2. `find_agents({ teamRole:'head' })` 找各团队 head;
3. **同一 turn 内并行** `spawn_sub_agent` 把每个 head 派成 Leader(传其子目标 + 切片后的子条件 + `verify:true`);
4. 各 Leader 回报后,写一份**汇总 summary**(逐 Leader 对照其条件的结果);
5. 自己的验收门判顶层条件;fail 则按 gap 再派或返工。

**Leader**(改写现有 head prompt,如 pm / training-head)—— Leader 自己的验收条件已由 CEO 供给,故:
1. `set_delegation_plan`(执行首步):声明 DAG(item = {子目标, owner, dependsOn, item-验收});
2. **波次派发**:把"依赖已满足"的项在同一 turn **并行** `spawn_sub_agent`(传 item 子目标 + item 验收,`verify:false`);
3. 该波全回 → 派下一波(随依赖解锁);
4. 全完后写汇总 summary(逐 subagent 对照其 item 条件);
5. 自己的验收门判子条件;fail 则按 gap 再派对应 item。

> 约定:Leader 在 pipeline 模式下**用 `spawn_sub_agent` 派发**(进验收任务树),不用 actor `send_and_wait`;常驻 head 的日常对话路径不受影响。

---

## 8. 错误 / 预算 / 边界

| 情况 | 处理 |
|---|---|
| 子任务失败 | `spawnChild` 返回子终态;父在 summary 看到,可在自己的 `maxVerifyRounds`/budget 内再派,或把 gap 上报 |
| 成本放大 | 每非叶层跑自己的 verify(含 judge 子运行)。兜底:子任务 `budgets().sub` + 树深定死(3 层)+ 每层 `maxVerifyRounds`;judge 子运行仍 `maxVerifyRounds:0` 防递归 |
| 返工空转 | **Stall detection(借 planning-with-files):** verify 连续两轮产出相同 gaps → fail-fast,不空转满 `maxVerifyRounds`。落在 `runGoalVerifyLoop` |
| 叶子不自验 | 叶子 `maxVerifyRounds:0`;由 Leader 验收其 summary |
| Leader 派发变成串行 | prompt 明确"同一波必须同一 turn 并行发出";pi-agent 默认 parallel 已保证并发;退化到串行仍正确,只是慢 |
| CEO 选错 Leader | 沿用多团队 find_agents 回退 + warn;CEO 据回报再派 |

业务路径按 `CLAUDE.md` §5 打结构化日志:合同下传(info)、波次派发(info,itemId/batch)、各层验收裁决(info/warn)、stall fail-fast(warn)。

---

## 9. 测试策略(TDD,经 Electron node `npm test`)

> 勿裸 `npx vitest`;勿 `pnpm rebuild better-sqlite3`。`src/service/**` 不在 typecheck 范围,靠 vitest 兜类型。

- **`types/task.test.ts`**:`DelegationItemSchema` 解析(含/不含 dependsOn、owner、check);`TaskSchema` round-trip `delegationPlan`;空数组向后兼容。
- **`tools/delegation-plan.test.ts`**:`set_delegation_plan` 记录 DAG + 分配稳定 id + 拒空表 + schema 拒坏 item;记录后能被读取。
- **`tools/spawn.test.ts`**(扩):`spawn_sub_agent` 透传 `acceptanceCriteria` + `verify` → `ctx.spawnChild` 收到正确的 `options`。
- **`session/agent-runner.verify.test.ts`**(扩):stall detection —— 连续两轮相同 gaps → 提前 `failed`,verify 调用次数 < `maxRounds+1`。
- **`conversation/store.test.ts`**(扩):`delegationPlan` round-trip。
- **集成 e2e(stub-agent,仿 `company.e2e`)**:CEO 派生条件 → 并行派 2 Leader → 各 Leader 建 DAG → 波次派 subagent → 汇总 → Leader 验收 → CEO 汇总 → CEO 验收。断言:合同下传正确、Leader `maxVerifyRounds>0` 而叶子 `=0`、两级验收门都触发、并行波次可观测(同一 turn 多个 spawn)。
- **回归**:现有 goal-verify 与多团队测试全绿。
- **手动真 LLM 冒烟**(文档化不进 CI):真 CEO 拆解一个多团队目标,观察三级树 + 两级验收裁决。

---

## 10. 范围与非目标(YAGNI)

- **不做** composer 验收输入框(顶层由 CEO 派生)。
- **不做** runner 侧硬调度器(波次由 agent 驱动)。
- **不做** judge 直吃子层 summary(v1 信任父层汇总)。
- **不做** 计划审批门 / 人工 in-the-loop(全程自动)。
- **不做** 叶子自验(由 Leader 验)。
- **不改** 常驻 CEO/head 对话路径;不改 actor messaging 底座。
- **不做** DAG 依赖的机械强制执行(计划是审计/指引,派发由 prompt 驱动)。
- 不改与本目标无关的代码。

---

## 11. 文件结构(实现指引)

- **改** `src/shared/types/task.ts` —— `DelegationItemSchema`/`DelegationItem`;`TaskSchema.delegationPlan`。
- **改** `src/service/session/agent-runner.ts` —— `spawnChild` dep 加 `options`;`AgentRunnerDeps.onDelegationPlan`;`buildToolContext` 注入 `setDelegationPlan`;`runGoalVerifyLoop` 加 stall detection。
- **改** `src/service/session/manager.ts` —— `spawnChild` 透传 `options`(criteria + maxVerifyRounds);child Task 构建;`makeEmit` 持久化 `task.delegation_plan`。
- **改** `src/service/tools/spawn.ts` —— `spawn_sub_agent` 加 `acceptanceCriteria?` + `verify?`。
- **改** `src/service/tools/registry.ts` —— `ToolRunContext.setDelegationPlan?`。
- **改** `src/service/conversation/store.ts` —— `delegation_plan` 列 + migration + `saveTaskDelegationPlan`。
- **改** `src/shared/types/ui.ts` —— `task.delegation_plan` 事件。
- **改** `src/shared/agents/builtins.ts` —— CEO / head(Leader)prompt 改写。
- **新** `src/service/tools/delegation-plan.ts`(+ test)。
- **扩** 对应 `*.test.ts` + e2e。
- 外科手术式改动,保持 factory+closure / 单文件 slice 风格;按 `CLAUDE.md` §6 在专用 worktree 实现。

---

## 12. 成功标准

- 一个多团队目标走通三级树:CEO 派生顶层条件 → 并行派 Leader → Leader 建 DAG → 波次并行派 subagent → 两级验收门(Leader → CEO)都触发。
- 验收条件经 `spawnChild` 正确下传;Leader `maxVerifyRounds>0`、叶子 `=0`。
- 同一波内多个 subagent 在同一 turn 并发(日志可观测)。
- 任一 Leader/subagent 失败 → 父层在 `maxVerifyRounds`/budget 内再派或上报 gap;耗尽标 `failed` 并附未满足项。
- stall detection:连续两轮相同 gaps → 提前失败,不空转。
- 只读 `swarm-dev.log` 能还原:合同下传、波次派发、各层验收裁决、最终结局。
- 现有 goal-verify + 多团队测试全绿。
