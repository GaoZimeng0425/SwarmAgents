# Composer：工作目录 / 权限 / 执行模式

**日期**：2026-06-21
**状态**：已确认，进入实现

## 目标

在聊天 composer 中新增三类控制，并完整打通后端使其真正生效：

1. **工作目录（cwd）**——让 agent 知道在哪个文件夹执行任务。
2. **权限模式**——含"完全操作权限"选项（旁路所有确认）。
3. **执行模式**——目标模式（自主执行）/ 计划模式（只读 + 先出计划）。

外加一个「＋」插入菜单：上传图片/文件、选择文件或文件夹（作为上下文路径引用插入输入框）。

## 非目标（YAGNI）

- 三个控件跨应用重启的持久化（仅按 session 内存粘性）。
- 计划模式下保留 shell 只读调查（明确舍弃，换取"绝不改动"的硬保证）。
- 把"选文件/文件夹"做成新的附件数据类型（仅插入绝对路径文本引用）。

## 数据模型（`src/shared/types/task.ts`）

```ts
export type PermissionMode = 'ask' | 'full'
//   ask  = 现状：low 自动放行，medium/high 弹权限卡
//   full = 全部自动放行（旁路确认）
export type ExecutionMode = 'goal' | 'plan'
//   goal = 自主执行（默认）
//   plan = 只读工具集 + "先出计划"提示
```

`Task` 新增三个可选字段（可选 → 旧持久化数据反序列化无碍）：

```ts
cwd?: string                     // 绝对工作目录，undefined → home
permissionMode?: PermissionMode  // 默认 'ask'
executionMode?: ExecutionMode    // 默认 'goal'
```

`TaskOptions` 透传类型（renderer → service）：

```ts
export type TaskOptions = {
  cwd?: string
  permissionMode?: PermissionMode
  executionMode?: ExecutionMode
}
```

## 后端

### cwd 约束工具

- `ToolRunContext`（`src/service/tools/registry.ts`）新增 `cwd?: string`。
- `agent-runner` 构建 `runCtx` 时填 `cwd: task.cwd`。
- `shell.ts`：`const cwd = p.cwd ?? ctx.cwd ?? homedir()`（开始使用 `ctx`，不再 `_ctx`）。
- `fs.ts`：各工具 `p.path ?? homedir()` 改为 `p.path ?? ctx.cwd ?? homedir()`。

### cwd 告知 agent

`agent-runner` 在设置 `initialState.systemPrompt` 时，若 `task.cwd` 存在则前置一行：

```
Working directory: <cwd>. Treat it as the base for relative paths and run commands there unless told otherwise.
```

### 完全权限

`agent-runner` `beforeToolCall`：

```ts
if (risk === 'low' || task.permissionMode === 'full') return undefined
```

预算 / 中止 / 上下文守卫保持不变。

### 计划模式

`session-manager.submitGoal`：

- `executionMode === 'plan'` 时，`toolAllowlist` 用只读集（不含 shell / fs.write / fs.edit / peekaboo 交互）：
  ```ts
  const PLAN_READONLY_ALLOWLIST = [
    'fs.read', 'fs.list', 'fs.glob', 'fs.grep',
    'web.*', 'peekaboo.see_screen', 'peekaboo.list_apps',
    'agent.*', 'plan.*',
  ]
  ```
  否则沿用 `deriveAllowlist(agentDef.toolScope)`。
- `agent-runner` systemPrompt 追加计划模式指令：
  ```
  You are in PLAN mode. Investigate using read-only tools and produce a step-by-step plan with update_plan. Do NOT modify files or run mutating commands — you have no write tools.
  ```
  （cwd 行与 plan 行可叠加。）

> 仅作用于 composer 主任务（默认 agent，scope 'all'）。子 agent 不受影响。

### submitGoal 透传链路

`taskOptions?: TaskOptions` 贯穿：
`preload`（`window.swarm.submitGoal`）→ IPC `swarm:submitGoal` → `service-client.submitGoal` → `session-manager.submitGoal`。
session-manager 把三字段盖到新建 Task 上。

### 文件/文件夹选择对话框

main 新增 IPC：`dialog:openPath`，用 `dialog.showOpenDialog({ properties: ['openDirectory'] | ['openFile'] })`，返回所选绝对路径或 `null`。preload 暴露：

```ts
window.swarm.dialog.openFolder(): Promise<string | null>
window.swarm.dialog.openFile(): Promise<string | null>
```

## 前端（`ChatInput`）

底部工具栏三个独立控件：

- **📁 工作目录 chip**：点击 → `dialog.openFolder()`；显示当前目录 basename，可清除回 home。
- **🛡 权限下拉**（`PromptInputSelect`）：询问权限 / 完全操作权限。
- **🎯 模式下拉**（`PromptInputSelect`）：目标模式 / 计划模式。

**「＋」菜单**（升级现有回形针为下拉）：

- 上传图片 / 文件 → 现有 attachment 流程（`attachments.openFileDialog()`）。
- 选择文件或文件夹 → `dialog.openFile/openFolder()` → 把绝对路径作为文本引用插入输入框（追加 `@/abs/path`），agent 经 fs 工具读取。

**状态粘性**：cwd / permissionMode / executionMode 提到 `tasks-view`（当前 session 作用域），提交时随 `submitGoal` 的 `taskOptions` 一并传。

## 测试

- `fs.test.ts`：shell / fs 在无显式 path 时回退到 `ctx.cwd`。
- `session-manager`：plan 模式产出只读 allowlist；三选项盖到 task。
- `agent-runner`：full 模式下 medium/high 不再调用 `permissionRegistry.request`。
- 渲染层：三控件渲染、调用 dialog、提交时携带 `taskOptions`（沿用 `composer-overlay.test` 模式）。

## 日志（遵循 CLAUDE.md §5）

- `session-manager.submitGoal`：在已有 `goal submitted` info 日志补上 `cwd`、`permissionMode`、`executionMode`。
- `agent-runner`：full 模式旁路、plan 模式只读 allowlist 在 `task starting` info 日志中可见。
