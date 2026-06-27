# 定时任务 session 只读结果视图 — 设计

日期：2026-06-27
分支：`worktree-cron-readonly-results`（基于 develop）

## 背景与问题

侧边栏顶部的「定时任务」行对应一个系统 session（`SessionSummary.isSystem === true`，
id 为 `SYSTEM_SESSION_ID`）。点进去后走的是和普通聊天**完全相同**的 `TasksView`：
渲染 `ConversationThread`（转写）+ `ComposerOverlay`（发送/队列浮层）+ `ChatInput`（输入框）。

后果：用户能在「定时任务」里像普通会话一样打字、发送、与之"聊天"。但这个 session 的语义是
**承载所有 cron 定时运行的结果**——cron 调度器会把每次运行作为一个 task 写进这个 session。
把它当聊天界面渲染既误导用户，也让"定时任务结果"以聊天气泡的形式返回，不符合预期。

已有的"结果导向"入口是日历视图（路由 `/scheduled`，组件 `ScheduledCalendarView`，侧栏底部
日历图标）。日历里「查看运行记录 →」会带 `?task=<id>` 跳进系统 session 的转写并滚动定位到那次运行。

## 目标

- 系统 session **不可聊天**：移除输入框、发送/队列浮层。
- 系统 session 以**结果卡片列表**的只读形式呈现每次定时运行。
- 日历的 `?task=<id>` 深链仍然有效：自动展开并滚动到对应运行卡片。

## 非目标

- 不改动后端。cron 调度器仍照常向系统 session 写入运行 task（合法行为）。
- 后端是否要拒绝向系统 session 提交 goal —— 不在本次范围（UI 已不再提供该入口）。
- 不改日历视图 `ScheduledCalendarView` 的行为（仅依赖它现有的深链跳转）。

## 方案总览

```
TasksView
 ├─ if session.isSystem  → <ScheduledResultsView tasks focusTaskId/>   (只读，无 composer / RightPanel)
 └─ else                 → ConversationThread + ComposerOverlay + ChatInput + RightPanel   (现状不变)
```

### 1. `TasksView` 分流（`src/renderer/src/components/views/tasks-view.tsx`）

按 `session?.isSystem` 早返回一个独立布局：系统 session 渲染 `<ScheduledResultsView>`，
**不渲染** `ChatInput`、`ComposerOverlay`、`RightPanel`（三者都属于聊天/输入，只读视图不需要）。
普通 session 分支保持现状，逐字不动。

系统 session 的 task 数据沿用现有路径：`useTasks()` 过滤 `sessionId === selectedSessionId`
（即 `sessionTasks`）。

### 2. 新组件 `ScheduledResultsView`（`src/renderer/src/components/views/scheduled-results-view.tsx`）

职责：渲染系统 session 的运行结果卡片列表（只读）。

- **数据**
  - 顶层运行 task：`tasks.filter(t => !t.parentTaskId)`，按 `startedAt` **倒序**（最新在上）。
  - cron 元数据关联：`useAllCronRuns()` + `useAllCronJobs()`，用纯函数 `buildScheduledRows`
    （见 §4）把每个 task 关联到其 cron 运行记录与任务名。
- **折叠态卡片**：状态徽标（✓ 完成 / ✗ 失败 / ⟳ 运行中 / ○ 其它）· 任务名 · 触发时间
  （`formatMessageTime` / 复用 `timeline` 里的格式化）· 耗时（`task.used?.wallMs`）· 摘要首行
  （`task.summary`，行数截断）；失败时显示 `run.error`。
- **展开态**：内联渲染该次运行的完整只读转写（见 §3 的 `<TaskTranscript>`）。
- **深链**：接收 `focusTaskId`；命中时默认展开该卡片，并复用现有 `data-task-id` +
  `scrollIntoView` + 高亮 ring 逻辑滚动定位。
- **空态**：无运行时显示一个"暂无定时运行"占位。

布局：组件自身是一个填满高度的可滚动容器（`ScrollArea` 或 `overflow-y-auto`），
不再嵌套 `Conversation`（`StickToBottom`）滚动视口。

### 3. 抽出共享转写渲染 `TaskTranscript`（`src/renderer/src/components/task-transcript.tsx`，新文件）

问题：单条运行的转写渲染（reasoning 块、工具卡、工具组、子 agent 块、消息气泡）目前**私有写死**
在 `conversation-thread.tsx` 内，且 `ConversationThread` 整体是 `flex-1` 的 `StickToBottom`
滚动视口，无法直接塞进卡片做内联展开。

做法：把以下渲染基元从 `conversation-thread.tsx` 抽到新模块 `task-transcript.tsx`：
- `ReasoningBlock`、`ToolImage`、`SubagentBlock`、`ToolGroupBlock`
- 一个 `renderSegment` 工厂：`createSegmentRenderer({ busy, onSend, onCopy, onDelete })`
  返回 `(seg, isLiveTail) => JSX`（把现有闭包依赖显式参数化）。
- 一个 `<TaskTranscript task readOnly onSend? />` 组件：对单个 task 调
  `taskSegments(task)` + `groupSegments` 并内联渲染（非滚动容器；`busy=false`；
  `readOnly` 时不显示删除动作）。

`conversation-thread.tsx` 改为从 `task-transcript.tsx` 导入这些基元，**保持唯一渲染源**——
卡片展开与聊天转写不会分裂成两套实现。`ConversationThread` 自身的跨 task 因果交织逻辑保留不动。

> 这是本次唯一一处动到稳定文件（`conversation-thread.tsx`）的较大改动。
> 备选是在卡片里复制一份精简 `renderSegment`，但会造成两套渲染逻辑长期漂移，不采用。

### 4. 纯函数 + 单测（`src/renderer/src/lib/scheduled-rows.ts` + `.test.ts`）

`buildScheduledRows(tasks, runs, jobs)` → `ScheduledRow[]`：
- 输入：系统 session 顶层 tasks、`CronRun[]`、`ScheduledTask[]`（或 `CronJobSummary[]`）。
- 关联：`run.taskId === task.id` → `run.jobId` → `job.name`。
- 输出每行：`{ taskId, name, status, startedAt, durationMs, summary, error }`
  - `name`：cron 任务名优先，取不到回退 `task.goal`。
  - `status`：取自 `task.status`（运行中/完成/失败等）。
  - `durationMs`：`task.used?.wallMs`（无则 undefined）。
  - `error`：对应 `run.error`（无则 undefined）。
  - 倒序排列（最新在上）。

测试覆盖：有/无关联 run、有/无 job name 回退、失败带 error、倒序、耗时缺失。
纯函数无副作用，便于在 `npm test`（Electron node 运行器）下断言。

## 数据流

```
cron scheduler ──(后端，照常)──▶ 系统 session 写入运行 task
                                          │
useTasks() 过滤 sessionId ─────────────────┤
useAllCronRuns()/useAllCronJobs() ────────┤
                                          ▼
                        buildScheduledRows(tasks, runs, jobs)
                                          │
                                          ▼
                          ScheduledResultsView（卡片列表）
                              └─ 展开 ─▶ <TaskTranscript task readOnly/>
```

## 错误处理

- 关联不到 cron run / job：回退用 `task.goal` 作名字，不报错（兼容历史/手动 task）。
- 运行失败：卡片显示失败徽标 + `run.error`（若有）/ `task.summary`。
- 深链 `focusTaskId` 指向不存在的 task：无匹配卡片时静默（不展开、不滚动），与现状一致。

## 测试

- 单测：`scheduled-rows.test.ts` 覆盖 `buildScheduledRows` 各分支（见 §4）。
- 手动验证（`run-desktop` skill）：
  1. 打开「定时任务」，确认**没有**输入框/发送浮层，呈现为卡片列表。
  2. 展开一张卡片显示完整只读转写。
  3. 从日历「查看运行记录 →」跳入，对应卡片自动展开并滚动高亮。
  4. 普通聊天 session 行为完全不变（仍可输入/发送）。

## 影响面

- 改动：`tasks-view.tsx`（分流）、`conversation-thread.tsx`（抽离渲染基元后改为导入）。
- 新增：`scheduled-results-view.tsx`、`task-transcript.tsx`、`scheduled-rows.ts` + 测试。
- 不动：后端、`ScheduledCalendarView`、`ChatInput`、`session-list.tsx`。
