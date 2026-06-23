# Settings 内嵌主窗口 + Provider 列表/Dialog 改造 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 把独立的 Settings 窗口改为主应用内全屏页面（`/settings` 嵌套路由），并把 Provider 配置页从「列表+内联详情」改为「全宽列表 → 点击行弹 Dialog 编辑」。

**Architecture:** Settings 的 route tree 合并进主 route tree 成为 `/settings` 路由组；`__root.tsx` 在 `/settings/*` 时只渲染设置全屏壳、隐藏会话侧栏与顶栏。主进程的菜单/deep-link 不再建窗口，改为 focus 主窗口 + 走一条新的 `swarm:navigate-settings` IPC 频道，由复用的 `useEventsSubscription` 在渲染进程内 `router.navigate`。Provider 页改用现有 `base-ui` Dialog 组件承载既有 `ProviderDetail` / `AddProviderForm`。

**Tech Stack:** Electron + electron-vite、React 19、TanStack Router（文件式路由 + `@tanstack/router-plugin/vite` 自动生成 `routeTree.gen.ts`）、`@base-ui/react` Dialog、pino 日志、Biome、Vitest（经 Electron node 运行）。

## Global Constraints

- 对话回复用中文；**代码注释与 commit message 一律英文**（CLAUDE.md §0）。
- 每条业务路径加结构化日志：入口 `info`、`catch` 必 `error`、分支意外 `warn`；首参为对象 `log.info({ msg, ... })`（CLAUDE.md §5）。本计划中「主进程设置导航入口」属业务路径，必须加日志。
- 外科手术式改动：只动与需求直接相关的行；仅清理本次改动产生的孤儿；不顺手重构无关代码（CLAUDE.md §3）。
- 运行测试用 `npm test`（经 Electron node 的 vitest），**不要** `pnpm rebuild better-sqlite3`。
- TanStack 文件式路由：新增/迁移路由文件后，`routeTree.gen.ts` 由 vite 插件在 `pnpm dev`/`pnpm build` 时重新生成，需把重新生成的 `routeTree.gen.ts` 一并提交。
- `Link`/`navigate` 的 `to` 在本仓库惯例用 `as any` 绕过 Router 类型注册（见 `app-sidebar.tsx`），新增导航沿用此惯例。

---

## File Structure

新增（渲染进程，主 route tree）：
- `src/renderer/src/routes/settings.tsx` — 设置布局路由（左侧二级导航 + 顶部「完成」+ `<Outlet/>`）
- `src/renderer/src/routes/settings.index.tsx` — General（`/settings`）
- `src/renderer/src/routes/settings.providers.tsx` — `/settings/providers`
- `src/renderer/src/routes/settings.mcp.tsx` — `/settings/mcp`
- `src/renderer/src/routes/settings.web-search.tsx` — `/settings/web-search`
- `src/renderer/src/routes/settings.budgets.tsx` — `/settings/budgets`
- `src/renderer/src/routes/settings.permissions.tsx` — `/settings/permissions`
- `src/renderer/src/routes/settings.about.tsx` — `/settings/about`

新增（主进程）：
- `src/main/windows/open-settings.ts` — `openSettings(opts?)`：focus 主窗口 + 发 `swarm:navigate-settings`

修改：
- `src/renderer/src/routes/__root.tsx` — `/settings/*` 全屏接管
- `src/renderer/src/components/app-sidebar.tsx` — Settings 按钮改 `Link to="/settings"`
- `src/renderer/src/components/no-provider-banner.tsx` — 改 `useNavigate()` → `/settings/providers`
- `src/renderer/src/hooks/use-events-subscription.ts` — 订阅 `onNavigateToSettings`
- `src/renderer/src/hooks/use-events-subscription.test.tsx` — mock + 断言
- `src/renderer/src/lib/api.ts` — 暴露 `onNavigateToSettings`
- `src/preload/index.ts` — 增 `onNavigateToSettings`、删 `openSettings`
- `src/shared/types/ui.ts` — 增 `onNavigateToSettings`、删 `openSettings`
- `src/main/system/menu.ts`、`src/main/system/deep-link.ts`、`src/main/index.ts` — import 换到 `open-settings.ts`
- `src/main/ipc/swarm-ipc.ts` — 删 `system:openSettings` handler/卸载/import
- `src/main/system/deep-link.ts` — settings 分支改用新 `openSettings`（route 形参语义不变）
- `electron.vite.config.ts` — 删 settings 入口 + 第二个 router 插件
- `src/renderer/src/components/views/providers-view.tsx` — 列表 + Dialog

删除：
- `src/renderer/settings.html`
- `src/renderer/src/entries/settings.tsx`
- `src/renderer/src/routes-settings/`（整目录）
- `src/renderer/src/routeTreeSettings.gen.ts`
- `src/main/windows/settings-window.ts`

---

## Task 1: 迁移 Settings 路由进主 route tree（additive）

新增 `/settings` 路由组（布局 + 七个子页），内容从 `routes-settings/*` 搬运、仅改路由路径字符串与导航 `to`。本任务**只新增、不删除**，旧 Settings 窗口暂时仍可用，保证中间态可构建。

**Files:**
- Create: `src/renderer/src/routes/settings.tsx`
- Create: `src/renderer/src/routes/settings.index.tsx`
- Create: `src/renderer/src/routes/settings.providers.tsx`
- Create: `src/renderer/src/routes/settings.mcp.tsx`
- Create: `src/renderer/src/routes/settings.web-search.tsx`
- Create: `src/renderer/src/routes/settings.budgets.tsx`
- Create: `src/renderer/src/routes/settings.permissions.tsx`
- Create: `src/renderer/src/routes/settings.about.tsx`
- Reference (copy content from): `src/renderer/src/routes-settings/__root.tsx`, `routes-settings/index.tsx`, `routes-settings/providers.tsx`, `routes-settings/mcp.tsx`, `routes-settings/web-search.tsx`, `routes-settings/budgets.tsx`, `routes-settings/permissions.tsx`, `routes-settings/about.tsx`

**Interfaces:**
- Produces: 路由 `'/settings'`（布局，渲染 `<Outlet/>`）、`'/settings/'`、`'/settings/providers'`、`'/settings/mcp'`、`'/settings/web-search'`、`'/settings/budgets'`、`'/settings/permissions'`、`'/settings/about'`。Task 2/3/4 依赖这些路径。

- [ ] **Step 1: 创建布局路由 `routes/settings.tsx`**

由 `routes-settings/__root.tsx` 改造：`createRootRoute` → `createFileRoute('/settings')`，NAV 的 `to` 改为绝对路径，顶部加「‹ 完成」返回按钮（拖拽条样式对齐主窗口 `__root.tsx` 的 TopBar，no-drag 区偏移 `pl-[70px]` 避开红绿灯）。去掉原来的 `<TitleBar/>` 依赖，改为内联拖拽顶栏。

```tsx
import { createFileRoute, Link, Outlet, useRouter } from '@tanstack/react-router'
import { ArrowLeft, Bot, Boxes, DollarSign, Info, Lock, Search, Settings as SettingsIcon } from 'lucide-react'

import { Button } from '@/components/ui/button'
import { ScrollArea } from '@/components/ui/scroll-area'

export const Route = createFileRoute('/settings')({ component: SettingsLayout })

const NAV = [
  { to: '/settings', label: 'General', icon: SettingsIcon },
  { to: '/settings/providers', label: 'Providers', icon: Bot },
  { to: '/settings/mcp', label: 'MCP Servers', icon: Boxes },
  { to: '/settings/web-search', label: 'Web Search', icon: Search },
  { to: '/settings/budgets', label: 'Budgets', icon: DollarSign },
  { to: '/settings/permissions', label: 'Permissions', icon: Lock },
  { to: '/settings/about', label: 'About', icon: Info },
] as const

function SettingsLayout(): React.JSX.Element {
  const router = useRouter()
  return (
    <div className="flex h-svh flex-col overflow-hidden bg-[var(--window-content)]">
      {/* Draggable top strip with a Done affordance, offset clear of the macOS
          traffic lights. Mirrors the main window TopBar in routes/__root.tsx. */}
      <div
        className="fixed inset-x-0 top-0 z-30 flex h-9 shrink-0 items-center bg-[var(--window-content)]/80 px-2 backdrop-blur-md"
        style={{ WebkitAppRegion: 'drag' } as React.CSSProperties}
      >
        <div className="pl-[70px]" style={{ WebkitAppRegion: 'no-drag' } as React.CSSProperties}>
          <Button
            className="gap-1 text-muted-foreground"
            onClick={() => router.history.back()}
            size="sm"
            variant="ghost"
          >
            <ArrowLeft className="size-4" /> 完成
          </Button>
        </div>
      </div>
      <div className="flex min-h-0 flex-1 pt-9">
        <nav className="flex w-52 shrink-0 flex-col gap-0.5 px-3 pb-4 pt-3">
          {NAV.map((item) => {
            const Icon = item.icon
            return (
              <Link
                activeOptions={{ exact: item.to === '/settings' }}
                // biome-ignore lint/suspicious/noExplicitAny: TanStack Router activeProps generic over route tree
                activeProps={{ 'data-status': 'active' } as any}
                className="flex items-center gap-2.5 rounded-lg px-2.5 py-1.5 text-[13px] text-muted-foreground transition-colors hover:bg-accent hover:text-foreground data-[status=active]:bg-accent data-[status=active]:text-foreground"
                key={item.to}
                // biome-ignore lint/suspicious/noExplicitAny: `to` constrained by Router's typed registry, widened over NAV const
                to={item.to as any}
              >
                <Icon className="size-4" />
                {item.label}
              </Link>
            )
          })}
        </nav>
        <main className="min-h-0 flex-1 bg-[var(--window-content)]">
          <ScrollArea className="h-full" edgeFade>
            <div className="min-h-full p-6">
              <Outlet />
            </div>
          </ScrollArea>
        </main>
      </div>
    </div>
  )
}
```

> 注：`activeOptions={{ exact: ... }}` 让 General（`/settings`）不会在子路由激活时仍高亮。若 `ScrollArea` 不支持 `edgeFade` 报类型错，去掉该属性（与 `routes-settings/__root.tsx` 保持一致即可）。

- [ ] **Step 2: 创建 7 个子路由文件**

`settings.index.tsx`（由 `routes-settings/index.tsx` 改路径）：

```tsx
import { createFileRoute } from '@tanstack/react-router'

export const Route = createFileRoute('/settings/')({ component: General })

function General(): React.JSX.Element {
  return (
    <div className="max-w-xl space-y-4">
      <h2 className="font-medium text-lg">General</h2>
      <p className="text-muted-foreground text-sm">Settings will appear here as features are added.</p>
    </div>
  )
}
```

`settings.providers.tsx`：

```tsx
import { createFileRoute } from '@tanstack/react-router'

import { ProvidersView } from '@/components/views/providers-view'

export const Route = createFileRoute('/settings/providers')({ component: ProvidersView })
```

`settings.about.tsx`：

```tsx
import { createFileRoute } from '@tanstack/react-router'

export const Route = createFileRoute('/settings/about')({ component: About })

function About(): React.JSX.Element {
  return (
    <div className="max-w-xl space-y-2">
      <h2 className="font-medium text-lg">SwarmAgents</h2>
      <p className="text-muted-foreground text-sm">Bundle: dev.swarmagents.app · Auto-update via electron-updater.</p>
    </div>
  )
}
```

`settings.permissions.tsx`：复制 `routes-settings/permissions.tsx` 全文，仅把 `createFileRoute('/permissions')` 改为 `createFileRoute('/settings/permissions')`，其余（`Permissions`、`PermissionRow`、`STATE_LABEL` 等）原样保留。

`settings.mcp.tsx` / `settings.web-search.tsx` / `settings.budgets.tsx`：分别复制 `routes-settings/{mcp,web-search,budgets}.tsx` 全文，只把 `createFileRoute('/<x>')` 改为 `createFileRoute('/settings/<x>')`（`/mcp`→`/settings/mcp`，`/web-search`→`/settings/web-search`，`/budgets`→`/settings/budgets`），其余内容与 import 原样不变。

> 先打开对应的 `routes-settings/*` 文件原样照抄，只改 `createFileRoute` 路径字符串。不要改动被引用的视图组件本身。

- [ ] **Step 3: 重新生成 routeTree 并类型检查**

让 vite 插件重新生成 `routeTree.gen.ts`（含新 `/settings*` 路由），然后类型检查。

Run:
```bash
cd /Users/gaozimeng/Learn/macOS/SwarmAgents
# 启动 dev 让 router 插件写入 routeTree.gen.ts，等约 8s 后停止
timeout 12 pnpm dev >/tmp/swarm-dev-regen.log 2>&1 || true
git diff --stat src/renderer/src/routeTree.gen.ts
npm run typecheck
```
Expected: `routeTree.gen.ts` 出现 `/settings`、`/settings/providers` 等条目；`npm run typecheck` 通过（无错误）。

> 若 `timeout`/`pnpm dev` 不便，等价做法是用 run-desktop 技能启动一次应用，插件会写入 `routeTree.gen.ts`，随后停止应用。

- [ ] **Step 4: 提交**

```bash
cd /Users/gaozimeng/Learn/macOS/SwarmAgents
git add src/renderer/src/routes/settings.tsx src/renderer/src/routes/settings.*.tsx src/renderer/src/routeTree.gen.ts
git commit -m "feat(settings): add /settings nested route group in main route tree"
```

---

## Task 2: `/settings/*` 全屏接管（隐藏会话侧栏 + 顶栏）

修改 `routes/__root.tsx`，在 `/settings` 路径下只渲染 `<Outlet/>`（设置布局自带全屏壳），其余路径维持现状。`EventsBridge` 与会话加载始终保持挂载。

**Files:**
- Modify: `src/renderer/src/routes/__root.tsx`

**Interfaces:**
- Consumes: Task 1 的 `/settings*` 路由。
- Produces: 进入 `/settings*` 时主窗口呈现设置全屏壳，无会话 `AppSidebar` / `TopBar`。

- [ ] **Step 1: 改写 `RootLayout` 为条件渲染**

把 `EventsBridge`、`useLoadSessions` 提到条件分支之上常驻；`inSettings` 为真时只渲染 `<Outlet/>`。完整替换 `RootLayout`：

```tsx
function RootLayout(): React.JSX.Element {
  const loadSessions = useLoadSessions()
  // Load the session list once for the whole app (the sidebar is always mounted).
  // biome-ignore lint/correctness/useExhaustiveDependencies: mount-only; loadSessions is a stable React Query mutation
  useEffect(() => {
    loadSessions.mutate()
  }, [])

  // Full-screen takeover: the /settings route group renders its own chrome
  // (left sub-nav + Done bar), so we hide the session sidebar and top bar.
  const pathname = useRouterState({ select: (s) => s.location.pathname })
  const inSettings = pathname === '/settings' || pathname.startsWith('/settings/')

  return (
    <>
      {/* Mounted in both modes: owns event subscription + main→renderer
          navigation (incl. swarm:navigate-settings). Must never unmount. */}
      <EventsBridge />
      {inSettings ? (
        <Outlet />
      ) : (
        <SidebarProvider>
          <TopBar />
          <AppSidebar />
          <SidebarInset className="min-w-0 overflow-hidden">
            <main className="flex h-svh flex-col overflow-hidden bg-[var(--window-content)] pt-9">
              <div className="min-h-0 flex-1">
                <Outlet />
              </div>
            </main>
          </SidebarInset>
        </SidebarProvider>
      )}
      <Toaster />
      {SHOW_ROUTER_DEVTOOLS && (
        <Suspense fallback={null}>
          <RouterDevtools position="bottom-right" />
        </Suspense>
      )}
    </>
  )
}
```

- [ ] **Step 2: 增加 `useRouterState` import**

在第 2 行把 `useRouter` 旁补上 `useRouterState`：

```tsx
import { createRootRoute, Outlet, useRouterState } from '@tanstack/react-router'
```

> 注意：原文件第 2 行只 import 了 `createRootRoute, Outlet, useRouter`。`useRouter` 仅 `TopBar` 使用，仍需保留；改为 `import { createRootRoute, Outlet, useRouter, useRouterState } from '@tanstack/react-router'`。

- [ ] **Step 3: 类型检查 + 运行验证**

Run:
```bash
cd /Users/gaozimeng/Learn/macOS/SwarmAgents && npm run typecheck
```
Expected: 通过。

再用 run-desktop 技能启动应用，在地址栏/通过下一任务前手动验证：临时把 `app-sidebar.tsx` 的 Settings 按钮（仍是 `openSettings`）暂不改也可，先通过 deep-link 或下个任务验证。本步以 typecheck 通过为准。

- [ ] **Step 4: 提交**

```bash
cd /Users/gaozimeng/Learn/macOS/SwarmAgents
git add src/renderer/src/routes/__root.tsx
git commit -m "feat(settings): full-screen takeover for /settings routes in main window"
```

---

## Task 3: 主进程导航频道 + 重写触发入口 + 移除独立窗口

主进程菜单/deep-link 改为 focus 主窗口并通过新 IPC 频道 `swarm:navigate-settings` 通知渲染进程导航；渲染进程的侧栏按钮与无 provider 横幅改为直接 router 导航；删除 `settings-window.ts` 与 `system:openSettings`。

**Files:**
- Create: `src/main/windows/open-settings.ts`
- Modify: `src/main/system/menu.ts`、`src/main/system/deep-link.ts`、`src/main/index.ts`、`src/main/ipc/swarm-ipc.ts`
- Modify: `src/preload/index.ts`、`src/shared/types/ui.ts`、`src/renderer/src/lib/api.ts`
- Modify: `src/renderer/src/hooks/use-events-subscription.ts`、`src/renderer/src/hooks/use-events-subscription.test.tsx`
- Modify: `src/renderer/src/components/app-sidebar.tsx`、`src/renderer/src/components/no-provider-banner.tsx`
- Delete: `src/main/windows/settings-window.ts`

**Interfaces:**
- Produces (main): `openSettings(opts?: { initialRoute?: string }): void` — focus 主窗口并发送 `swarm:navigate-settings` `{ route: string }`；`route` = `opts.initialRoute` 存在时 `'/settings/' + initialRoute.replace(/^\//, '')`，否则 `'/settings'`。
- Produces (preload/ui): `onNavigateToSettings(cb: (route: string) => void): () => void`。
- Consumes: Task 1 的 `/settings*` 路由；现有 `getMainWindow()`（`src/main/windows/main-window.ts`）。

- [ ] **Step 1: 在测试里先加断言（TDD）**

`use-events-subscription.test.tsx` 现有对 `onNavigateToSession` 的 mock（`vi.spyOn(api.swarmApi, 'onNavigateToSession').mockReturnValue(() => {})`）。新增对 `onNavigateToSettings` 的 mock，并加一个测试：当 `onNavigateToSettings` 回调收到 route 时调用 `navigate({ to })`。

先在该测试文件顶部的 `useNavigate` mock 处捕获 navigate spy（文件已 `useNavigate: () => vi.fn()`；改为共享一个 spy），并在 mock swarmApi 处记录回调：

```tsx
// 顶部：让 useNavigate 返回可断言的 spy
const navigateSpy = vi.fn()
vi.mock('@tanstack/react-router', () => ({
  useNavigate: () => navigateSpy,
}))

// 在 setup 中捕获 onNavigateToSettings 的回调
let settingsNavCb: ((route: string) => void) | null = null
vi.spyOn(api.swarmApi, 'onNavigateToSettings').mockImplementation((cb) => {
  settingsNavCb = cb
  return () => {}
})

// 新测试
it('navigates to a settings route when main pushes swarm:navigate-settings', () => {
  renderHook(() => useEventsSubscription()) // 沿用本文件既有的挂载方式
  expect(settingsNavCb).toBeTypeOf('function')
  settingsNavCb?.('/settings/providers')
  expect(navigateSpy).toHaveBeenCalledWith({ to: '/settings/providers' })
})
```

> 按该测试文件已有的渲染/挂载写法套用（若已有 `renderHook`/包装器，复用之）；关键是：捕获回调、触发、断言 `navigate({ to })`。`onNavigateToSettings` 此刻在 `api.swarmApi` 上还不存在，spyOn 会失败 —— 这就是预期的失败点。

- [ ] **Step 2: 运行测试，确认失败**

Run:
```bash
cd /Users/gaozimeng/Learn/macOS/SwarmAgents && npm test -- use-events-subscription
```
Expected: FAIL —— `onNavigateToSettings` 不存在（`Cannot spy ... property does not exist` 或断言未命中）。

- [ ] **Step 3: 主进程新增 `open-settings.ts`**

```ts
// src/main/windows/open-settings.ts
//
// In-app Settings navigation. Replaces the old standalone Settings BrowserWindow:
// menu / deep-link entry points focus the main window and push a route over
// SETTINGS_NAV_CHANNEL; the renderer (useEventsSubscription) performs the
// router navigation.
import { createLogger } from '@shared/logger'

import { getMainWindow } from './main-window'

const log = createLogger({ process: 'main' }).child({ component: 'open-settings' })

// Keep in sync with preload's SETTINGS_NAV_CHANNEL.
const SETTINGS_NAV_CHANNEL = 'swarm:navigate-settings'

export function openSettings(opts: { initialRoute?: string } = {}): void {
  const route = opts.initialRoute ? `/settings/${opts.initialRoute.replace(/^\//, '')}` : '/settings'
  const win = getMainWindow()
  if (!win) {
    log.warn({ msg: 'open settings: no main window', route })
    return
  }
  try {
    const send = (): void => win.webContents.send(SETTINGS_NAV_CHANNEL, { route })
    if (win.webContents.isLoading()) {
      win.webContents.once('did-finish-load', send)
    } else {
      send()
    }
    if (win.isMinimized()) win.restore()
    win.show()
    win.focus()
    log.info({ msg: 'navigate settings', route })
  } catch (err) {
    log.error({ msg: 'open settings failed', err: err instanceof Error ? err.message : String(err), route })
  }
}
```

- [ ] **Step 4: 切换 menu/deep-link/index 的 import 到新模块**

`src/main/index.ts`：把 `import { openSettings } from './windows/settings-window'` 改为 `from './windows/open-settings'`（第 18 行）。`setupMenu({ onOpenSettings: openSettings })` 不变。

`src/main/system/deep-link.ts`：把 `import { openSettings } from '../windows/settings-window'` 改为 `from '../windows/open-settings'`（第 14 行）。settings 分支逻辑不变（仍 `openSettings(route ? { initialRoute: route } : {})`，`route` 为去掉前导斜杠的 pathname）。

`src/main/system/menu.ts`：无需改（仅消费传入的 `onOpenSettings` 回调）。

- [ ] **Step 5: 删除 `system:openSettings` IPC 与 `settings-window.ts`**

`src/main/ipc/swarm-ipc.ts`：删除 `import { openSettings } from '../windows/settings-window'`（第 14 行）、`handleOpenSettings` 函数及其 `ipcMain.handle('system:openSettings', handleOpenSettings)`（约 213–227 行），以及卸载处 `ipcMain.removeHandler('system:openSettings')`（约 289 行）。

删除文件：
```bash
cd /Users/gaozimeng/Learn/macOS/SwarmAgents
git rm src/main/windows/settings-window.ts
```

- [ ] **Step 6: preload + 类型 + api 暴露新频道、删除旧 openSettings**

`src/preload/index.ts`：
- 在频道常量区（`NAVIGATE_CHANNEL` 附近，第 31 行一带）新增 `const SETTINGS_NAV_CHANNEL = 'swarm:navigate-settings'`。
- 删除 `openSettings: (opts) => ipcRenderer.invoke('system:openSettings', opts) as Promise<void>,`（第 204 行）。
- 在 `onNavigateToSession` 旁新增：

```ts
  onNavigateToSettings: (cb) => {
    const listener = (_: Electron.IpcRendererEvent, payload: { route: string }): void => cb(payload.route)
    ipcRenderer.on(SETTINGS_NAV_CHANNEL, listener)
    return () => {
      ipcRenderer.removeListener(SETTINGS_NAV_CHANNEL, listener)
    }
  },
```

`src/shared/types/ui.ts`：删除 `openSettings(opts?: { initialRoute?: string }): Promise<void>`（第 251 行及其上方注释），在 `onNavigateToSession` 声明下方新增：

```ts
  /** Main pushes a /settings route here (menu / deep-link) for in-app navigation. */
  onNavigateToSettings(cb: (route: string) => void): () => void
```

`src/renderer/src/lib/api.ts`：在 `onNavigateToSession` 行下方新增：

```ts
  onNavigateToSettings: (cb: (route: string) => void): (() => void) => window.swarm.onNavigateToSettings(cb),
```

- [ ] **Step 7: 渲染进程订阅导航（让测试转绿）**

`src/renderer/src/hooks/use-events-subscription.ts`：在现有 deep-link session 的 `useEffect` 下方新增一个 effect：

```ts
  // Main → renderer Settings navigation (menu / deep-link). Mounted app-wide
  // via EventsBridge, so it works regardless of the current route.
  useEffect(() => {
    return swarmApi.onNavigateToSettings((route) => {
      // biome-ignore lint/suspicious/noExplicitAny: dynamic /settings* path widened over Router's typed registry
      void navigate({ to: route as any })
    })
  }, [navigate])
```

- [ ] **Step 8: 运行测试，确认通过**

Run:
```bash
cd /Users/gaozimeng/Learn/macOS/SwarmAgents && npm test -- use-events-subscription
```
Expected: PASS（含新增的 settings 导航用例；原 session 导航用例不回归）。

- [ ] **Step 9: 重写渲染进程触发入口**

`src/renderer/src/components/app-sidebar.tsx`：把 Settings 项从按钮改为 `Link`，与其他侧栏项一致：

```tsx
          <SidebarMenuItem>
            <SidebarMenuButton
              render={
                <Link
                  // biome-ignore lint/suspicious/noExplicitAny: TanStack Router activeProps generic over route tree
                  activeProps={{ 'data-active': 'true' } as any}
                  className="flex items-center gap-2"
                  // biome-ignore lint/suspicious/noExplicitAny: `to` constrained by Router's typed registry, widened over route const
                  to={'/settings' as any}
                >
                  <Settings />
                  <span>Settings</span>
                </Link>
              }
              tooltip="Settings"
            />
          </SidebarMenuItem>
```

（`Link` 已在文件首行 import；`Settings` 图标 import 保留。）

`src/renderer/src/components/no-provider-banner.tsx`：把 `void window.swarm.openSettings({ initialRoute: '/providers' })` 改为 router 导航。在组件内引入 `useNavigate`：

```tsx
import { useNavigate } from '@tanstack/react-router'
// ...
  const navigate = useNavigate()
  // 原 onClick:
  onClick={() => {
    // biome-ignore lint/suspicious/noExplicitAny: widened over Router's typed registry
    void navigate({ to: '/settings/providers' as any })
  }}
```

> 打开 `no-provider-banner.tsx` 确认其当前结构（是否已是函数组件、onClick 位置），按既有写法把 `openSettings` 调用替换为 `navigate`。

- [ ] **Step 10: 全量类型检查 + 运行验证**

Run:
```bash
cd /Users/gaozimeng/Learn/macOS/SwarmAgents && npm run typecheck
```
Expected: 通过（确认无残留 `window.swarm.openSettings` / `system:openSettings` 引用）。

再用 run-desktop 技能启动应用，手动验证：
1. 点侧栏 Settings → 主窗口全屏切到 `/settings`，会话侧栏与顶栏隐藏，「‹ 完成」返回会话。
2. 触发无 provider 横幅 → 跳 `/settings/providers`。
3. macOS 菜单「Settings…」(⌘,) → 主窗口被 focus 并到 `/settings`（不弹独立窗口）。
4. deep-link `swarmagents://settings/providers` → 主窗口到 `/settings/providers`。

确认 `userData/swarm-dev.log` 出现 `navigate settings` info 行。

- [ ] **Step 11: 提交**

```bash
cd /Users/gaozimeng/Learn/macOS/SwarmAgents
git add -A
git commit -m "feat(settings): route menu/deep-link/sidebar to in-app /settings; drop settings window"
```

---

## Task 4: 删除 Settings 独立入口、第二 route tree 与构建配置

移除现已无人引用的独立 Settings 入口产物与第二个 router 插件配置。

**Files:**
- Delete: `src/renderer/settings.html`、`src/renderer/src/entries/settings.tsx`、`src/renderer/src/routes-settings/`（整目录）、`src/renderer/src/routeTreeSettings.gen.ts`
- Modify: `electron.vite.config.ts`

**Interfaces:**
- Consumes: Task 3 已移除所有对 `settings.html` / 第二 route tree 的引用。

- [ ] **Step 1: 改 `electron.vite.config.ts`**

删除 renderer `rollupOptions.input` 里的 `settings: resolve('src/renderer/settings.html'),`（第 87 行），只留 `index`。删除第二个 `TanStackRouterVite({...routes-settings...routeTreeSettings.gen.ts})` 插件块（第 98–103 行），保留第一个（routes / routeTree.gen.ts）。

- [ ] **Step 2: 删除文件**

```bash
cd /Users/gaozimeng/Learn/macOS/SwarmAgents
git rm src/renderer/settings.html src/renderer/src/entries/settings.tsx src/renderer/src/routeTreeSettings.gen.ts
git rm -r src/renderer/src/routes-settings
```

- [ ] **Step 3: 构建验证**

Run:
```bash
cd /Users/gaozimeng/Learn/macOS/SwarmAgents && pnpm build
```
Expected: `npm run typecheck` 与 `electron-vite build` 均成功；产物不再有 settings 入口；无 `routeTreeSettings`/`routes-settings`/`settings.html` 相关报错。

- [ ] **Step 4: 提交**

```bash
cd /Users/gaozimeng/Learn/macOS/SwarmAgents
git add -A
git commit -m "chore(settings): remove standalone settings entry, route tree and build config"
```

---

## Task 5: Provider 改为「全宽列表 → 点击行弹 Dialog 编辑」

仅改 `providers-view.tsx`：去掉左右分栏，改为分组列表；点击行弹编辑 Dialog（复用 `ProviderDetail`），「+ 添加供应商」弹创建 Dialog（复用 `AddProviderForm`，创建成功即关闭）。本任务与 Task 1–4 相互独立，可单独实现。

**Files:**
- Modify: `src/renderer/src/components/views/providers-view.tsx`
- Use: `src/renderer/src/components/ui/dialog.tsx`（已存在）

**Interfaces:**
- Consumes: 既有 `ProviderDetail({ id, state, onDeleted })`、`AddProviderForm({ onCreated })`、`useProviders()`、`displayName`、`Dot`、`providerViewById`、`BUILTIN_IDS`、`BUILTIN_DEFS`（均在本文件/已 import）。`base-ui` Dialog：`Dialog` 受控用 `open` + `onOpenChange={(open) => ...}`（首参即新状态）。
- Produces: 列表 UI + 两个受控 Dialog；`ProviderDetail`/`AddProviderForm` 行为不变。

- [ ] **Step 1: 调整 import**

在 `providers-view.tsx` 顶部 import 区新增 Dialog，移除改写后不再使用的 `ScrollArea`（确认全文仅旧 `ProvidersView` 用到它）：

```tsx
import { Dialog, DialogContent, DialogHeader, DialogTitle } from '@/components/ui/dialog'
```

删除 `import { ScrollArea } from '@/components/ui/scroll-area'`（若类型检查报 `ScrollArea` 未使用）。

- [ ] **Step 2: 重写 `ProvidersView`，删除 `Sidebar` 与 `ADD`**

用列表 + 两个 Dialog 替换现有 `ProvidersView`；删除 `Sidebar` 函数；删除 `const ADD = '__add__'`（不再使用）。`ProviderDetail`、`AddProviderForm`、`Dot`、`displayName`、各 Field 子组件保持不变。

```tsx
export function ProvidersView(): React.JSX.Element {
  const { state, decryptFailed } = useProviders()
  const [editId, setEditId] = useState<string | null>(null)
  const [addOpen, setAddOpen] = useState(false)
  const customs = state.providers.filter((p) => !p.registry)

  const Row = ({ id, label, configured }: { id: string; label: string; configured: boolean }): React.JSX.Element => (
    <button
      className="flex w-full items-center justify-between rounded-lg border px-3 py-2.5 text-left text-sm hover:bg-accent"
      key={id}
      onClick={() => setEditId(id)}
      type="button"
    >
      <span className="flex items-center gap-2">
        <Dot on={state.active === id || configured} />
        <span className="truncate">{label}</span>
      </span>
      {state.active === id && (
        <span className="rounded-full bg-emerald-500/15 px-2 py-0.5 text-emerald-600 text-xs dark:text-emerald-400">
          已启用
        </span>
      )}
    </button>
  )

  return (
    <div className="mx-auto max-w-2xl space-y-6">
      {decryptFailed && (
        <div className="rounded border border-amber-500/40 bg-amber-500/10 px-3 py-2 text-sm">
          Saved keys could not be decrypted on this machine. Re-enter them to continue.
        </div>
      )}

      <section className="space-y-2">
        <div className="text-muted-foreground text-xs">内置</div>
        <div className="space-y-1.5">
          {BUILTIN_IDS.map((bid) =>
            Row({ id: bid, label: BUILTIN_DEFS[bid].name, configured: providerViewById(state, bid) !== null }),
          )}
        </div>
      </section>

      <section className="space-y-2">
        <div className="text-muted-foreground text-xs">自定义供应商</div>
        <div className="space-y-1.5">
          {customs.map((p) => Row({ id: p.id, label: p.name, configured: true }))}
          <button
            className="flex w-full items-center gap-2 rounded-lg border border-dashed px-3 py-2.5 text-left text-sm hover:bg-accent"
            onClick={() => setAddOpen(true)}
            type="button"
          >
            <span className="text-base leading-none">+</span> 添加供应商
          </button>
        </div>
      </section>

      <Dialog onOpenChange={(open) => !open && setEditId(null)} open={editId !== null}>
        <DialogContent className="max-h-[85vh] w-full max-w-2xl overflow-y-auto">
          {editId && (
            <>
              <DialogHeader className="sr-only">
                <DialogTitle>{displayName(state, editId)}</DialogTitle>
              </DialogHeader>
              <ProviderDetail id={editId} key={editId} onDeleted={() => setEditId(null)} state={state} />
            </>
          )}
        </DialogContent>
      </Dialog>

      <Dialog onOpenChange={setAddOpen} open={addOpen}>
        <DialogContent className="max-h-[85vh] w-full max-w-2xl overflow-y-auto">
          <DialogHeader className="sr-only">
            <DialogTitle>添加模型供应商</DialogTitle>
          </DialogHeader>
          <AddProviderForm onCreated={() => setAddOpen(false)} />
        </DialogContent>
      </Dialog>
    </div>
  )
}
```

> `DialogHeader` 用 `sr-only` 提供无障碍标题，可见标题仍由 `ProviderDetail` 内部的 `<h2>` / `AddProviderForm` 自带标题承担，避免重复。`ProviderDetail` 的 `onDeleted` 现在关闭 Dialog；删除后 `useProviders` 实时订阅会把该项从列表移除。

- [ ] **Step 3: 类型检查**

Run:
```bash
cd /Users/gaozimeng/Learn/macOS/SwarmAgents && npm run typecheck
```
Expected: 通过（确认 `Sidebar`、`ADD`、`ScrollArea` 无残留未用引用）。

- [ ] **Step 4: 运行验证**

用 run-desktop 技能启动应用，到 `/settings/providers`：
1. 页面是分组列表（内置 / 自定义），无右侧内联详情。
2. 点任一行 → 弹 Dialog；改 Key / baseUrl / 模型 / thinking 即时保存；启用/停用生效；自定义供应商可删除且删除后 Dialog 关闭、列表移除。
3. 点「+ 添加供应商」→ 弹 Dialog 填表（名称/Base URL/API Key/API 格式/模型）→ 创建成功后 Dialog 关闭、列表新增该供应商。

- [ ] **Step 5: 提交**

```bash
cd /Users/gaozimeng/Learn/macOS/SwarmAgents
git add src/renderer/src/components/views/providers-view.tsx
git commit -m "feat(providers): list view with click-to-edit dialog; add provider dialog"
```

---

## Self-Review

**Spec coverage:**
- Settings 不新开窗口、应用内全屏接管 → Task 1（路由）+ Task 2（接管）+ Task 3（菜单/deep-link/侧栏/横幅改走应用内）。✓
- 删除独立窗口/html/entry/第二 route tree/`window.swarm.openSettings` 全链路 → Task 3（窗口 + IPC + preload + ui）+ Task 4（html/entry/tree/vite）。✓
- 主进程导航入口加日志 → Task 3 Step 3（`open-settings.ts` info/warn/error）。✓
- Provider 列表 + 点击弹 Dialog 编辑、创建成功即关闭、无自动弹窗 → Task 5。✓

**Placeholder scan:** 无 TBD/TODO；每个改动步骤都给出完整代码或精确文件/行与改法。引用「打开原文件照抄改路径」的子页迁移，因内容与现有文件逐字相同、仅改一处字符串，故未重复粘贴大段（已逐文件指明改哪一行）。✓

**Type consistency:**
- 频道常量 `swarm:navigate-settings` 在 `open-settings.ts` 与 `preload/index.ts` 两处字面量一致（与现有 `NAVIGATE_CHANNEL` 双声明惯例相同）。✓
- `openSettings(opts?: { initialRoute?: string })` 签名在 menu/deep-link 调用点一致（`initialRoute` 为去前导斜杠的 pathname）。✓
- `onNavigateToSettings(cb: (route: string) => void): () => void` 在 ui.ts / preload / api.ts / use-events-subscription 四处一致。✓
- Dialog 受控 `open` + `onOpenChange((open)=>...)` 与 `@base-ui/react` 1.6 的 `DialogRoot` 实际签名一致。✓
