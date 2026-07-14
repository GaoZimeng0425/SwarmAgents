# Settings 内嵌主窗口 + Provider 列表/Dialog 改造

Date: 2026-06-23
Status: Approved (design)

## 背景与目标

当前 Settings 是一个独立的 `BrowserWindow`（`settings.html` + 独立 TanStack Router route
tree `routes-settings/` + 独立 Vite 入口 `entries/settings.tsx`），通过侧栏按钮、macOS
菜单、deep-link、无 provider 横幅四处调用 `window.swarm.openSettings()` 触发。Provider 配置页
（`providers-view.tsx`）当前是「左侧列表 + 右侧内联详情」的分栏布局。

两个目标：

1. **Settings 不再新开窗口**，改为在主应用内以**全屏接管**形态打开（已与用户确认）。
2. **Provider 页改为「全宽列表 → 点击行弹 Dialog 编辑」**：列表只展示供应商，不展示详情；
   点击某个供应商才弹出 Dialog，在其中查看与编辑详情。

非目标：不改动 provider 的持久化逻辑、字段语义、IPC 数据结构；不改动其他设置页
（MCP / Web Search / Budgets / Permissions / About）的内容，仅随路由整合而迁移。

## Part 1 — Settings 改为主应用内全屏页面

### 路由整合（核心）

将独立的 settings route tree 合并进主 route tree，作为嵌套路由组 `/settings`：

- 新增 `src/renderer/src/routes/settings.tsx`（layout route，`createFileRoute('/settings')`），
  由现有 `routes-settings/__root.tsx` 的 `SettingsLayout` 改造而来：渲染「左侧二级导航
  （General / Providers / MCP / Web Search / Budgets / Permissions / About）+ 右侧 `<Outlet/>`」，
  并在顶部提供「‹ 完成」按钮（`router.history.back()`，回退失败时 `navigate({ to: '/' })`）。
  二级导航的 `Link` 目标改为 `/settings`、`/settings/providers` 等绝对路径。
- 迁移子页：把 `routes-settings/{index,providers,mcp,web-search,budgets,permissions,about}.tsx`
  迁为 `src/renderer/src/routes/settings/{index,providers,mcp,web-search,budgets,permissions,about}.tsx`，
  路径相应变为 `/settings`、`/settings/providers` 等。文件内容除路由路径字符串外不变；
  `providers.tsx` 仍 `createFileRoute('/settings/providers')({ component: ProvidersView })`。

### 全屏接管（隐藏会话侧栏 + 顶栏）

修改 `src/renderer/src/routes/__root.tsx` 的 `RootLayout`：

- 用 `useRouterState({ select: (s) => s.location.pathname })` 读取当前路径。
- 当路径以 `/settings` 开头时，**只渲染 `<Outlet/>`**（设置自带全屏壳：左侧二级导航 + 内容 +
  「‹ 完成」），**不渲染** `SidebarProvider` / `AppSidebar` / `TopBar`。
- 其余路径维持现状（`SidebarProvider` + `EventsBridge` + `TopBar` + `AppSidebar` + `Outlet`）。
- `EventsBridge` 与下文的 NavBridge 需在两种分支下都保持挂载（提到条件分支之上，确保
  事件订阅与导航桥接不被卸载）。

### 触发入口改写

渲染进程内触发，直接用 router 导航：

- 侧栏 Settings 按钮（`app-sidebar.tsx`）：从 `onClick={() => void window.swarm.openSettings()}`
  改为 `Link to="/settings"`（与其他侧栏项一致的 `Link` 写法）。
- 无 provider 横幅（`no-provider-banner.tsx`）：从 `window.swarm.openSettings({ initialRoute: '/providers' })`
  改为 `useNavigate()` → `navigate({ to: '/settings/providers' })`。

主进程触发（菜单、deep-link），不再建窗口，改为 focus 主窗口 + 发导航事件：

- 重写主进程的设置入口逻辑：用 `getMainWindow()` 取主窗口，`win.show()` / `win.focus()`，
  再 `win.webContents.send('navigate:to', route)`，其中 `route` 默认 `/settings`，
  deep-link 带子路由时为 `/settings/<sub>`。该函数加 `info` 日志（component 维度，含目标
  route），`catch` 加 `error` 日志（遵循 CLAUDE.md §5）。
- 新增渲染进程导航桥接 `NavBridge`（挂在 RouterProvider 之下、`RootLayout` 内或与
  `EventsBridge` 并列）：通过 preload 暴露的订阅 API 监听 `navigate:to` 事件，调用
  `router.navigate({ to })`。preload 增加 `onNavigateTo(cb): () => void` 订阅方法
  （沿用现有 events 订阅的 `ipcRenderer.on` + 返回取消函数的范式）。
- deep-link（`system/deep-link.ts`）与菜单（`system/menu.ts` 的 `onOpenSettings`）改为调用
  重写后的设置入口函数。

### 删除（仅本次改动产生的孤儿）

- `src/renderer/settings.html`
- `src/renderer/src/entries/settings.tsx`
- `src/renderer/src/routes-settings/`（整目录，内容已迁移至 `routes/settings/`）
- `src/renderer/src/routeTreeSettings.gen.ts`（生成产物）
- `src/main/windows/settings-window.ts`（其 `openSettings` 逻辑迁入主窗口导航实现，
  例如放到 `main-window.ts` 或新建 `windows/open-settings.ts`）
- `electron.vite.config.ts`：移除 `rollupOptions.input.settings` 入口，移除第二个
  `TanStackRouterVite({ routesDirectory: 'routes-settings', generatedRouteTree: 'routeTreeSettings.gen.ts' })`
  插件配置。
- 移除已无人调用的 `window.swarm.openSettings`：preload 中的 `openSettings`、IPC handler
  `system:openSettings`（`swarm-ipc.ts` 注册与卸载）、`shared/types/ui.ts` 的接口声明。

### 验证

- `pnpm dev` 启动后：点侧栏 Settings → 主窗口全屏切到 `/settings`，会话侧栏与顶栏隐藏，
  「‹ 完成」可返回会话；二级导航各项可切换且 URL 为 `/settings/*`。
- 无 provider 横幅点击 → 跳 `/settings/providers`。
- macOS 菜单「Settings…」与 deep-link `swarm://settings[/providers]` → 主窗口被 focus 并
  导航到对应设置页（不再弹独立窗口）。
- 类型检查与构建通过（routeTree.gen.ts 由插件重新生成，含新的 `/settings*` 路由）。

## Part 2 — Provider 列表 + 点击弹 Dialog 编辑

仅改 `src/renderer/src/components/views/providers-view.tsx`，复用现有
`src/renderer/src/components/ui/dialog.tsx`。

### 列表

- `ProvidersView` 改为**全宽列表**（去掉左右分栏的 `Sidebar` / `main` 结构）：
  - 「内置」分组：遍历 `BUILTIN_IDS`，每行展示名称 + 状态圆点（`state.active === id` 或已配置）
    + `已启用` 徽标（当 active）。
  - 「自定义供应商」分组：遍历 `state.providers.filter((p) => !p.registry)`，同样的行样式。
  - 底部「+ 添加供应商」按钮。
- 顶部保留 `decryptFailed` 提示横幅。

### 编辑 Dialog

- 组件状态：`const [editId, setEditId] = useState<string | null>(null)` 与
  `const [addOpen, setAddOpen] = useState(false)`。
- 点击任一供应商行 → `setEditId(id)`，打开受控 `<Dialog open={editId !== null}>`，
  `<DialogContent>` 内渲染现有 `ProviderDetail`（启用/停用、名称、apiStyle、API Key、
  baseUrl、模型列表、thinking、上下文窗口、连接测试、删除）。`ProviderDetail` 接口基本不变
  （`id` / `state` / `onDeleted`）；删除回调改为关闭 Dialog（`setEditId(null)`）。
- 字段子组件（`NameField` / `KeyField` / `BaseUrlField` / `ModelList` / …）本就直接调用
  `window.swarm.providers.*` 持久化，无需改动；Dialog 打开期间 `useProviders()` 的实时
  订阅会驱动字段随保存刷新。
- Dialog 需可滚动（`DialogContent` 加最大高度 + 内部 `ScrollArea`/`overflow-y-auto`），
  因详情字段较多。

### 添加 Dialog

- 「+ 添加供应商」→ `setAddOpen(true)`，打开 `<Dialog open={addOpen}>`，内容为现有
  `AddProviderForm`。
- 创建成功（`onCreated`）→ **直接关闭 Dialog**（`setAddOpen(false)`）。新供应商随实时订阅
  出现在列表中。**不做任何自动弹窗**（创建表单已收集名称 / Base URL / API Key / API 格式 /
  模型列表，配置即完整）。

### 验证

- `/settings/providers` 显示为列表，无右侧内联详情。
- 点击内置或自定义供应商行 → 弹出 Dialog，可改 Key / baseUrl / 模型 / thinking 等并即时保存；
  启用/停用生效；自定义供应商可删除且删除后 Dialog 关闭。
- 「+ 添加供应商」→ 弹 Dialog 填表创建 → Dialog 关闭、列表新增该供应商。

## 影响面小结

- 渲染进程：`routes/__root.tsx`、`routes/settings.tsx`(新) + `routes/settings/*`(迁移)、
  `app-sidebar.tsx`、`no-provider-banner.tsx`、`providers-view.tsx`、新增 NavBridge、preload。
- 主进程：设置入口函数重写（主窗口导航）、`menu.ts`、`deep-link.ts`、`swarm-ipc.ts`（移除
  `system:openSettings`）。
- 构建/类型：`electron.vite.config.ts`、`shared/types/ui.ts`；删除 settings 独立入口与第二
  route tree 及其生成产物。
- 日志：主进程设置导航入口按 CLAUDE.md §5 加 info / error 日志。
