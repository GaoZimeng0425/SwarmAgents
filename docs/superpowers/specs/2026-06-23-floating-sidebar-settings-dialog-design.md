# 浮窗侧边栏 + 设置弹窗化 设计稿

日期:2026-06-23
分支建议:`feat/floating-sidebar-settings-dialog`(独立 worktree)

## 目标

1. **左侧边栏浮窗化**:去掉「聊天区左侧的边缘线」,把侧边栏改成融入染色窗体、内容区浮起为圆角卡片的现代 macOS 观感(inset 形态)。
2. **顶部不再空荡**:侧边栏顶部以已存在的「New chat」按钮作为首要元素;清理旧的全屏 `pt-9` 空白带来的丑陋感。
3. **底部 footer 改为图标行**:定时任务 / 用量 / 设置 三个图标 + 右侧主题切换(无文字,hover 出 tooltip)。
4. **设置改为弹窗**:用 `Dialog` 实现,**无关闭按钮**,点遮罩/窗外/Esc 关闭;内部左侧导航切换分区。
5. **Skills 并入设置弹窗**:作为设置导航的一项,移除侧边栏独立 Skills 入口。
6. **删除旧 `/settings/*` 与 `/skills` 路由**,菜单 Cmd+, 与 deep-link 改为打开弹窗。

非目标(YAGNI):不引入搜索/过滤改造;不改动 `/scheduled`、`/usage` 页面本身;不重写任何 settings 子页的业务逻辑(只搬运)。

## 现状(关键文件)

- `components/app-sidebar.tsx`:`<Sidebar>` 用默认 `variant="sidebar"`(→ 左侧 `border-r`,即边缘线);footer 是竖排文字菜单(定时任务/用量/Skills/Settings)+ `ThemeToggle`。
- `components/ui/sidebar.tsx`:已内置 `variant="inset"`。切到 inset 后:`SidebarProvider` 外层 `has-data-[variant=inset]:bg-sidebar` 把窗体染成侧边栏底色;`SidebarInset`(`__root.tsx` 已在用)带 `m-2 ml-0 rounded-xl shadow-sm` 让内容浮起;default 才有的 `border-r` 不再应用。
- `routes/__root.tsx`:`inSettings` 时全屏接管(隐藏侧边栏/顶栏)渲染 `<Outlet/>`;并用 `setSettingsReturnHref` 记录返回位置。`TopBar` 固定全宽,含 侧栏开关 + 前进/后退 + 右侧 `ToolsPopover`。
- `routes/settings.tsx`:设置布局(左侧 `NAV` 子导航 + 「完成」返回按钮 + `<Outlet/>`)。
- 设置子路由:`settings.index`(内联 `General`)、`settings.providers`→`ProvidersView`、`settings.mcp`→`McpServersView`、`settings.web-search`→`WebSearchView`、`settings.budgets`→`BudgetsView`、`settings.permissions`(内联 `Permissions`)、`settings.about`(内联 `About`)。
- `routes/skills.tsx`→`SkillsView`。
- 主进程→渲染进程:`main/windows/open-settings.ts` 经 `swarm:navigate-settings` 发 `{ route }`;`hooks/use-events-subscription.ts` 收到后 `navigate({ to: route })`。`lib/api.ts` 暴露 `onNavigateToSettings`。
- `lib/settings-return.ts`:仅服务于路由式设置的「完成」返回,弹窗化后不再需要。
- `components/views/settings-view.tsx`:**孤立死代码**(无引用)。本次不主动删除(遵循「不动既有死代码」),仅在此标注,可由用户决定。

## 架构

### A. 侧边栏浮窗(inset)

- `app-sidebar.tsx`:`<Sidebar variant="inset">`。`SidebarProvider`(在 `__root.tsx`)与 `SidebarInset` 无需改动即可生效(样式已就绪)。
- 验证点:`sidebar-inner` 的 `pt-9` 与 `TopBar` 固定栏在 inset 下仍正确避让红绿灯;`SidebarInset` 的圆角卡 `pt-9` 顶部留白与 `NoProviderBanner` 排版正常。如顶部留白在 inset 下显突兀,微调 `TopBar`/`pt` 即可(纯样式)。

### B. footer 图标行

`app-sidebar.tsx` 的 `SidebarFooter` 重写为单行:

- 左起图标按钮:定时任务(`CalendarClock`,`Link to=/scheduled`)、用量(`BarChart3`,`Link to=/usage`)、设置(`Settings`,**按钮**,`onClick` 打开弹窗)。
- `flex-1` 占位,右端放 `ThemeToggle`(现有三段控件)。
- 每个图标按钮用 `Tooltip` 包裹给出中文名;active 路由高亮沿用现有 `activeProps` 模式。
- 移除 Skills 项。

### C. 设置弹窗

新增 `components/settings-dialog.tsx`:

- 结构:`Dialog` + `DialogContent showCloseButton={false}`,覆写 `className` 为宽弹窗(约 `max-w-3xl`、高 `~80vh`、`flex` 横向)。
- 左侧:导航列表(沿用 `settings.tsx` 的 `NAV`,新增 **Skills**),点选切换 `section` 状态(非路由)。导航顺序:**General · Providers · MCP Servers · Web Search · Skills · Budgets · Permissions · About**。
- 右侧:按 `section` 渲染对应 view,外层包 `ScrollArea`。
- 关闭:依赖 base-ui `Dialog` 默认 `dismissible`(点遮罩/窗外/Esc 关),不放任何关闭按钮,不放「完成」。

**全局开关状态**(新增 `stores/settings-dialog.ts`,Zustand,风格对齐 `stores/sessions.ts`):

```
useSettingsDialog: { open: boolean; section: SettingsSection; openSettings(section?): void; close(): void }
```

`<SettingsDialog/>` 挂载在 `__root.tsx` 始终渲染处(与 `EventsBridge` 同级,Portal 渲染,任意路由可用)。

### D. 抽取内联子页为 view 组件

把路由文件里的内联组件搬到 `components/views/`(纯搬运,不改逻辑):

- `settings.index` 的 `General` → `components/views/general-view.tsx`
- `settings.permissions` 的 `Permissions` → `components/views/permissions-view.tsx`
- `settings.about` 的 `About` → `components/views/about-view.tsx`

其余 `ProvidersView/McpServersView/WebSearchView/BudgetsView/SkillsView` 已是独立组件,直接复用。

### E. 主进程/菜单/deep-link 接线

- `hooks/use-events-subscription.ts`:`onNavigateToSettings((route) => …)` 改为把 `route`(如 `/settings/mcp`、`/settings`)映射成 `section` 并调用 `useSettingsDialog.getState().openSettings(section)`,不再 `navigate`。
- `main/windows/open-settings.ts` 与 `deep-link.ts`:IPC 负载形态不变(仍发 `{ route }`),映射在渲染侧完成,主进程零改动。

### F. 删除与清理

- 删除路由文件:`routes/settings.tsx`、`settings.index.tsx`、`settings.providers.tsx`、`settings.mcp.tsx`、`settings.web-search.tsx`、`settings.budgets.tsx`、`settings.permissions.tsx`、`settings.about.tsx`、`routes/skills.tsx`。
- 删除 `lib/settings-return.ts`。
- `__root.tsx`:移除 `inSettings` 分支与全屏接管、移除 `setSettingsReturnHref` 相关 `useEffect` 与 import;`RootLayout` 始终渲染侧边栏布局,并挂载 `<SettingsDialog/>`。
- `routeTree.gen.ts`:由 TanStack Router 插件在 dev/build 时自动重生成(无需手改)。
- `components/views/settings-view.tsx`:标注为死代码,**不在本次删除**(除非你确认要清)。

## 数据流

- 打开设置:footer ⚙ 按钮 / 菜单 Cmd+, / deep-link → `useSettingsDialog.openSettings(section?)` → 弹窗打开并定位分区。
- 切换分区:点左侧导航 → set `section`(纯内存,无 URL 变化)。
- 关闭:点遮罩/窗外/Esc → `open=false`。

## 日志(遵循 CLAUDE.md §5)

设置弹窗为纯 UI 状态切换,无业务副作用,不新增业务日志;沿用各 view 既有逻辑的日志。`open-settings.ts` 现有 info 日志保留。

## 测试与验证

- 现有 `hooks/use-events-subscription.test.tsx` 中「navigates to a settings route when main pushes swarm:navigate-settings」用例会失效:改为断言「触发后弹窗 `open=true` 且 `section` 正确」。
- `npm test`(经 Electron node,见项目记忆)跑通。
- `pnpm dev` 手动验证清单:
  1. 侧边栏浮窗观感、聊天区左侧无边缘线、顶部不再空荡。
  2. footer 图标行可点、tooltip、主题切换正常。
  3. ⚙ 打开弹窗、左侧导航可切换、各分区内容(含 Skills)正常、点窗外/Esc 关闭、无关闭按钮。
  4. 菜单 Cmd+, 与 `swarmagents://settings/mcp` deep-link 能打开弹窗并定位分区。
  5. 旧 `/settings`、`/skills` URL 已移除(不再可达)。

## 风险

- inset 顶部留白在 macOS 红绿灯下的视觉对齐需实机微调(纯样式)。
- 删除路由后若仍有遗漏引用 `/settings`、`/skills`、`settings-return` 之处会编译报错——已确认仅 `app-sidebar`、`__root`、`settings.tsx`、`use-events-subscription` 引用,全部在改动范围内。
