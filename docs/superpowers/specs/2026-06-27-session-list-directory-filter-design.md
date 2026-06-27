# Session List 目录分组过滤器 — 设计

日期：2026-06-27
状态：已批准设计，待实现

## 目标

给侧边栏 session 列表增加一个排序/分组过滤器：

- 默认模式保持现状（扁平 + 手动拖拽排序）。
- 「按目录」模式下，目录成为一级（可折叠）节点，session 成为二级子项。
- 没有目录（无 `cwd`）的 session 归入固定在最底部的「无目录」分组。
- 目录模式下：目录与目录之间可拖拽排序；同一目录内 session 与 session 之间可拖拽排序。
- 过滤器选择、目录顺序、目录折叠状态都持久化；每次打开应用恢复上一次状态。

## 背景 / 现状

- `SessionSummary`（`src/shared/types/ui.ts`）含可选 `cwd?: string`，即「目录」来源（完整路径）。
- session 顺序持久化在**后端**：`swarmApi.reorderSessions(orderedIds)` → 后端按数组下标写 `sortOrder`。
- 扁平列表排序键见 `stores/sessions.ts` 的 `byPinnedThenSortOrder`：系统会话置顶 → pinned → `sortOrder` 升序。
- 现有拖拽在 `components/session-list.tsx`：单个 `DndContext` + `restrictToVerticalAxis`，`onDragEnd` 对非系统 session 重排并调 `reorderSessions`。
- UI 偏好持久化用 zustand `persist`（localStorage）惯例，见 `stores/recent-dirs.ts`（key 形如 `swarm:recent-dirs`）。
- 系统会话「定时任务」(`isSystem`) 固定渲染在列表顶部，不可拖拽。

## 设计

### 1. 持久化：新增 `stores/session-view.ts`

仿 `recent-dirs.ts`，用 `persist` 中间件存 localStorage，key `swarm:session-view`：

```ts
type Mode = 'flat' | 'directory'
type SessionViewStore = {
  mode: Mode
  directoryOrder: string[]            // 目录（cwd）手动顺序，已记录的在前
  collapsed: Record<string, true>     // 被折叠的目录 cwd 集合
  setMode: (m: Mode) => void
  setDirectoryOrder: (order: string[]) => void
  toggleCollapsed: (dir: string) => void
}
```

- 这三项均持久化，重启恢复。
- session 顺序**不**进这里——继续复用后端 `sortOrder`，避免两套真相。

### 2. 入口控件：分段切换

在 `New chat` / `Search` 行下方加一个小分段控件，两段：`默认` / `按目录`。

- 点击即 `setMode` 并持久化。
- 命名用「默认」而非「最近」：现有扁平列表是手动 `sortOrder`，并非按时间排序。

### 3. 默认模式（`flat`）

完全保持现状：扁平列表 + 单 `DndContext` 拖拽 + `reorderSessions`；系统会话置顶。即把现有渲染逻辑原样保留为该分支。

### 4. 目录模式（`directory`）

布局自上而下：

1. 系统会话「定时任务」固定置顶（与现状一致，不分组、不可拖拽）。
2. 目录分组，按下文「目录排序规则」排列。每个目录是**可折叠一级节点**：
   - 行内显示目录 basename，`title` 全路径 tooltip，左侧折叠/展开 chevron。
   - 点击行头切换折叠，写 `toggleCollapsed`。
   - 展开时渲染该目录下的 session 二级子项（缩进）。
3. 「无目录」分组（`cwd` 为空/undefined 的 session）**永远固定在最底部**，同样可折叠，但不参与目录间拖拽。

**分组与组内排序**：

- 分组键 = `cwd`（完整路径原值；空值归入「无目录」）。
- 组内 session 顺序 = pinned 优先，再按 `sortOrder` 升序（沿用 pin 语义）。

**目录排序规则**（计算可见目录顺序）：

- `directoryOrder` 中已记录的目录按其顺序在前；
- 未记录的新目录追加在后，按该目录下 session 的最近活动时间（`lastActiveAt`）降序；
- 「无目录」永远最后（不在 `directoryOrder` 中体现）。

### 5. 拖拽（两层，相互独立）

- **目录之间拖拽** → 仅更新 localStorage `directoryOrder`（目录是从 `cwd` 派生的视图概念，非后端实体），不调后端。「无目录」分组不可被拖拽、其它目录也不能拖到它之后。
- **组内 session 之间拖拽** → 复用后端 `reorderSessions`：把当前可见的「目录顺序 × 各组内顺序」拍平成完整非系统 session 的 id 列表，整体持久化。这样后端 `sortOrder` 始终等于目录模式可见顺序（副作用：默认模式顺序也随之对齐，可接受）。
- **跨目录拖 session 不支持**：那等同于修改 session 的 `cwd`，属于设置变更，超出本次范围。每个目录用各自独立的 `SortableContext`（`items` = 该组 session id），目录列表用另一个 `SortableContext`（`items` = 目录 key）。

### 6. 组件结构

集中在 `components/session-list.tsx`：

- 保留现有 `renderRow` / `renderSystemRow` / 重命名 / 删除 / pin 逻辑不变。
- 抽出小组件：
  - `SortableSessionRow`（已存在，复用）。
  - `SortableDirectoryGroup`：可折叠目录头 + 其 `SortableContext` 子列表。
- 顶层按 `mode` 分支渲染 flat / directory 两套。
- session 行渲染（`renderRow`）在两种模式共用。

## 错误处理 / 边界

- session 没有 `cwd` → 落入「无目录」。
- 某目录所有 session 被删/移走 → 该目录从可见列表消失（`directoryOrder` 里残留的 key 不渲染，无害；可在 `setDirectoryOrder` 时顺带剔除不存在的 key，非必须）。
- `reorderSessions` 失败 → 与现状一致：`toast.error` 并保留乐观更新后由下次刷新纠正。
- localStorage 不可用 → zustand persist 自身降级为内存态（与 `recent-dirs` 同等风险，不额外处理）。

## 测试

仿 `stores/sessions.test.ts`：

- `session-view` store：默认值、`setMode`、`setDirectoryOrder`、`toggleCollapsed` 的状态转移。
- 一个纯函数（建议抽到可测模块）`groupSessionsByDirectory(sessions, directoryOrder)`：
  - 按 cwd 分组；
  - 已记录目录在前、新目录按最近活动降序追加、「无目录」垫底；
  - 组内 pinned 优先再 sortOrder。
- 拍平函数 `flattenForReorder(groups)`：产出用于 `reorderSessions` 的 id 列表，顺序与可见顺序一致。

## 非目标

- 不改 `cwd` 语义、不支持跨目录拖拽改 cwd。
- 不为目录顺序新增后端存储。
- 默认模式行为零变更。
