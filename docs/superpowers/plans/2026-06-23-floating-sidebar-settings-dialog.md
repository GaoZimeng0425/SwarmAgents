# 浮窗侧边栏 + 设置弹窗化 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 把左侧边栏改为 inset 浮窗观感(去掉聊天区左侧边缘线)、footer 改图标行,并将设置从路由页改为无关闭按钮、点窗外即关的弹窗,Skills 并入其中。

**Architecture:** 复用 shadcn sidebar 已内置的 `variant="inset"` 完成浮窗化(纯样式)。新增一个 Zustand store 控制设置弹窗开关与当前分区;新增 `SettingsDialog` 组件在根布局常驻挂载(Portal),内部用本地 state 切换分区并复用既有/抽取的 view 组件。主进程菜单/deep-link 经现有 IPC 改为打开弹窗。最后删除旧 `/settings/*`、`/skills` 路由与相关返回逻辑。

**Tech Stack:** React 19 + TypeScript、TanStack Router(文件路由)、base-ui Dialog(`components/ui/dialog.tsx`)、Zustand、Tailwind、Vitest(经 Electron node)。

## Global Constraints

- 对话用中文;**代码注释与 commit message 一律英文**。
- 业务路径需结构化日志(`pino`,`src/shared/logger.ts`);本特性为纯 UI 状态切换,无新增业务副作用,不新增业务日志。
- 外科手术式改动:每行改动可追溯到本计划;不顺手改无关代码。
- 测试用 `npm test`(经 Electron node),**禁止** `pnpm rebuild better-sqlite3`。
- 单文件格式化用 `npx biome check --write <file>`(`pnpm check` 会全仓重排)。
- TypeScript 严格:组件返回 `React.JSX.Element`,与现有风格一致。
- 每个任务结束须保持全仓可编译、`pnpm dev` 可运行。

---

### Task 1: 新增设置弹窗状态 store

**Files:**
- Create: `src/renderer/src/stores/settings-dialog.ts`
- Test: `src/renderer/src/stores/settings-dialog.test.ts`

**Interfaces:**
- Produces:
  - `type SettingsSection = 'general' | 'providers' | 'mcp' | 'web-search' | 'skills' | 'budgets' | 'permissions' | 'about'`
  - `useSettingsDialog` (Zustand store):`{ open: boolean; section: SettingsSection; openSettings: (section?: SettingsSection) => void; close: () => void }`
  - `routeToSection(route: string): SettingsSection`

- [ ] **Step 1: 写失败测试**

```ts
// src/renderer/src/stores/settings-dialog.test.ts
import { beforeEach, describe, expect, it } from 'vitest'

import { routeToSection, useSettingsDialog } from './settings-dialog'

beforeEach(() => {
  useSettingsDialog.setState({ open: false, section: 'general' })
})

describe('useSettingsDialog', () => {
  it('opens with default general section', () => {
    useSettingsDialog.getState().openSettings()
    expect(useSettingsDialog.getState().open).toBe(true)
    expect(useSettingsDialog.getState().section).toBe('general')
  })

  it('opens at a specific section', () => {
    useSettingsDialog.getState().openSettings('mcp')
    expect(useSettingsDialog.getState().section).toBe('mcp')
  })

  it('close() resets open to false', () => {
    useSettingsDialog.getState().openSettings('about')
    useSettingsDialog.getState().close()
    expect(useSettingsDialog.getState().open).toBe(false)
  })
})

describe('routeToSection', () => {
  it('maps /settings to general', () => {
    expect(routeToSection('/settings')).toBe('general')
    expect(routeToSection('/settings/')).toBe('general')
  })
  it('maps known sub-routes to their section', () => {
    expect(routeToSection('/settings/mcp')).toBe('mcp')
    expect(routeToSection('/settings/web-search')).toBe('web-search')
    expect(routeToSection('/settings/permissions')).toBe('permissions')
  })
  it('falls back to general for unknown routes', () => {
    expect(routeToSection('/settings/nope')).toBe('general')
  })
})
```

- [ ] **Step 2: 跑测试确认失败**

Run: `npm test -- src/renderer/src/stores/settings-dialog.test.ts`
Expected: FAIL（`Cannot find module './settings-dialog'`）

- [ ] **Step 3: 实现 store**

```ts
// src/renderer/src/stores/settings-dialog.ts
import { create } from 'zustand'

// Settings is presented as a single dialog with an internal nav. Each section
// maps 1:1 to what used to be a /settings/* route.
export type SettingsSection =
  | 'general'
  | 'providers'
  | 'mcp'
  | 'web-search'
  | 'skills'
  | 'budgets'
  | 'permissions'
  | 'about'

const SECTIONS: SettingsSection[] = [
  'general',
  'providers',
  'mcp',
  'web-search',
  'skills',
  'budgets',
  'permissions',
  'about',
]

// Map a legacy /settings[/<section>] route (still sent by the menu / deep-link
// IPC) onto a dialog section. Unknown tails fall back to General.
export function routeToSection(route: string): SettingsSection {
  const tail = route.replace(/^\/settings\/?/, '')
  return (SECTIONS as string[]).includes(tail) ? (tail as SettingsSection) : 'general'
}

type SettingsDialogStore = {
  open: boolean
  section: SettingsSection
  openSettings: (section?: SettingsSection) => void
  close: () => void
}

export const useSettingsDialog = create<SettingsDialogStore>((set) => ({
  open: false,
  section: 'general',
  openSettings: (section = 'general') => set({ open: true, section }),
  close: () => set({ open: false }),
}))
```

- [ ] **Step 4: 跑测试确认通过**

Run: `npm test -- src/renderer/src/stores/settings-dialog.test.ts`
Expected: PASS

- [ ] **Step 5: 提交**

```bash
npx biome check --write src/renderer/src/stores/settings-dialog.ts src/renderer/src/stores/settings-dialog.test.ts
git add src/renderer/src/stores/settings-dialog.ts src/renderer/src/stores/settings-dialog.test.ts
git commit -m "feat(settings): add settings-dialog store + route mapping"
```

---

### Task 2: 抽取内联设置子页为 view 组件

把 `settings.index` / `settings.permissions` / `settings.about` 里的内联组件搬到 `components/views/`,并让对应路由改用新组件(保持路由暂时可用,后续任务再删路由)。纯搬运,不改逻辑。

**Files:**
- Create: `src/renderer/src/components/views/general-view.tsx`
- Create: `src/renderer/src/components/views/permissions-view.tsx`
- Create: `src/renderer/src/components/views/about-view.tsx`
- Modify: `src/renderer/src/routes/settings.index.tsx`
- Modify: `src/renderer/src/routes/settings.permissions.tsx`
- Modify: `src/renderer/src/routes/settings.about.tsx`

**Interfaces:**
- Produces: `GeneralView`, `PermissionsView`, `AboutView`(均 `(): React.JSX.Element`)

- [ ] **Step 1: 创建 general-view.tsx**

```tsx
// src/renderer/src/components/views/general-view.tsx
export function GeneralView(): React.JSX.Element {
  return (
    <div className="max-w-xl space-y-4">
      <h2 className="font-medium text-lg">General</h2>
      <p className="text-muted-foreground text-sm">Settings will appear here as features are added.</p>
    </div>
  )
}
```

- [ ] **Step 2: 创建 about-view.tsx**

```tsx
// src/renderer/src/components/views/about-view.tsx
export function AboutView(): React.JSX.Element {
  return (
    <div className="max-w-xl space-y-2">
      <h2 className="font-medium text-lg">SwarmAgents</h2>
      <p className="text-muted-foreground text-sm">Bundle: dev.swarmagents.app · Auto-update via electron-updater.</p>
    </div>
  )
}
```

- [ ] **Step 3: 创建 permissions-view.tsx**

```tsx
// src/renderer/src/components/views/permissions-view.tsx
import { useCallback, useEffect, useState } from 'react'
import type { MacPermissions, MacPermissionState } from '@shared/types/ui'

import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'

const STATE_LABEL: Record<MacPermissionState, { text: string; variant: 'secondary' | 'destructive' | 'outline' }> = {
  granted: { text: 'Granted', variant: 'secondary' },
  denied: { text: 'Not granted', variant: 'destructive' },
  'not-determined': { text: 'Not set', variant: 'outline' },
  unsupported: { text: 'N/A', variant: 'outline' },
}

export function PermissionsView(): React.JSX.Element {
  const [perms, setPerms] = useState<MacPermissions | null>(null)

  const refresh = useCallback(() => {
    void window.swarm.getMacPermissions().then(setPerms)
  }, [])

  useEffect(() => {
    refresh()
  }, [refresh])

  const isMac = perms !== null && perms.screenRecording !== 'unsupported'

  return (
    <div className="max-w-xl space-y-6">
      <section className="space-y-2">
        <h2 className="font-medium text-lg">Permissions</h2>
        <p className="text-muted-foreground text-sm">
          Default policy: prompt on medium and high. Per-tool overrides coming in a later release.
        </p>
      </section>

      {isMac && (
        <section className="space-y-3">
          <div className="flex items-center justify-between">
            <h3 className="font-medium text-sm">macOS System Access</h3>
            <Button onClick={refresh} size="sm" variant="ghost">
              Re-check
            </Button>
          </div>
          <p className="text-muted-foreground text-sm">
            The screen tools (see_screen, list_apps) need these. Grant them in System Settings, then re-check. Screen
            Recording changes may require relaunching SwarmAgents.
          </p>
          <PermissionRow
            hint="Capturing the screen for see_screen."
            label="Screen Recording"
            onOpen={() => void window.swarm.openPrivacySettings('screen')}
            state={perms.screenRecording}
          />
          <PermissionRow
            hint="Reading on-screen UI elements (and future click/type)."
            label="Accessibility"
            onOpen={() => void window.swarm.openPrivacySettings('accessibility')}
            state={perms.accessibility}
          />
        </section>
      )}
    </div>
  )
}

type RowProps = { label: string; hint: string; state: MacPermissionState; onOpen: () => void }

function PermissionRow({ label, hint, state, onOpen }: RowProps): React.JSX.Element {
  const meta = STATE_LABEL[state]
  return (
    <div className="flex items-center justify-between gap-3 rounded-lg border p-3">
      <div className="min-w-0">
        <div className="flex items-center gap-2">
          <span className="font-medium text-sm">{label}</span>
          <Badge variant={meta.variant}>{meta.text}</Badge>
        </div>
        <p className="text-muted-foreground text-xs">{hint}</p>
      </div>
      <Button onClick={onOpen} size="sm" variant="outline">
        Open Settings
      </Button>
    </div>
  )
}
```

- [ ] **Step 4: 路由改用新组件**

`src/renderer/src/routes/settings.index.tsx` 全文替换为:

```tsx
import { createFileRoute } from '@tanstack/react-router'

import { GeneralView } from '@/components/views/general-view'

export const Route = createFileRoute('/settings/')({ component: GeneralView })
```

`src/renderer/src/routes/settings.about.tsx` 全文替换为:

```tsx
import { createFileRoute } from '@tanstack/react-router'

import { AboutView } from '@/components/views/about-view'

export const Route = createFileRoute('/settings/about')({ component: AboutView })
```

`src/renderer/src/routes/settings.permissions.tsx` 全文替换为:

```tsx
import { createFileRoute } from '@tanstack/react-router'

import { PermissionsView } from '@/components/views/permissions-view'

export const Route = createFileRoute('/settings/permissions')({ component: PermissionsView })
```

- [ ] **Step 5: 类型检查**

Run: `pnpm typecheck`
Expected: 无报错

- [ ] **Step 6: 提交**

```bash
npx biome check --write src/renderer/src/components/views/general-view.tsx src/renderer/src/components/views/about-view.tsx src/renderer/src/components/views/permissions-view.tsx src/renderer/src/routes/settings.index.tsx src/renderer/src/routes/settings.about.tsx src/renderer/src/routes/settings.permissions.tsx
git add src/renderer/src/components/views/ src/renderer/src/routes/settings.index.tsx src/renderer/src/routes/settings.about.tsx src/renderer/src/routes/settings.permissions.tsx
git commit -m "refactor(settings): extract inline general/about/permissions into view components"
```

---

### Task 3: 新增 SettingsDialog 组件

无关闭按钮、点遮罩/Esc 关闭;左侧导航(含 Skills)切换分区,右侧滚动渲染对应 view。先建组件,本任务不挂载。

**Files:**
- Create: `src/renderer/src/components/settings-dialog.tsx`

**Interfaces:**
- Consumes:`useSettingsDialog`(Task 1);`GeneralView/PermissionsView/AboutView`(Task 2);`ProvidersView`、`McpServersView`、`WebSearchView`、`BudgetsView`(已存在于 `components/views/`);`SkillsView`(`components/views/skills-view`);`Dialog`、`DialogContent`(`components/ui/dialog`);`ScrollArea`(`components/ui/scroll-area`)。
- Produces:`SettingsDialog(): React.JSX.Element`

- [ ] **Step 1: 实现组件**

```tsx
// src/renderer/src/components/settings-dialog.tsx
import { Bot, Boxes, DollarSign, Info, Lock, Search, Settings as SettingsIcon, Sparkles } from 'lucide-react'

import { Dialog, DialogContent, DialogTitle } from '@/components/ui/dialog'
import { ScrollArea } from '@/components/ui/scroll-area'
import { AboutView } from '@/components/views/about-view'
import { BudgetsView } from '@/components/views/budgets-view'
import { GeneralView } from '@/components/views/general-view'
import { McpServersView } from '@/components/views/mcp-servers-view'
import { PermissionsView } from '@/components/views/permissions-view'
import { ProvidersView } from '@/components/views/providers-view'
import { SkillsView } from '@/components/views/skills-view'
import { WebSearchView } from '@/components/views/web-search-view'
import { cn } from '@/lib/utils'
import { type SettingsSection, useSettingsDialog } from '@/stores/settings-dialog'

const SECTIONS: { key: SettingsSection; label: string; icon: typeof SettingsIcon; View: () => React.JSX.Element }[] = [
  { key: 'general', label: 'General', icon: SettingsIcon, View: GeneralView },
  { key: 'providers', label: 'Providers', icon: Bot, View: ProvidersView },
  { key: 'mcp', label: 'MCP Servers', icon: Boxes, View: McpServersView },
  { key: 'web-search', label: 'Web Search', icon: Search, View: WebSearchView },
  { key: 'skills', label: 'Skills', icon: Sparkles, View: SkillsView },
  { key: 'budgets', label: 'Budgets', icon: DollarSign, View: BudgetsView },
  { key: 'permissions', label: 'Permissions', icon: Lock, View: PermissionsView },
  { key: 'about', label: 'About', icon: Info, View: AboutView },
]

export function SettingsDialog(): React.JSX.Element {
  const { open, section, openSettings, close } = useSettingsDialog()
  const active = SECTIONS.find((s) => s.key === section) ?? SECTIONS[0]
  const ActiveView = active.View

  return (
    <Dialog
      onOpenChange={(next) => {
        if (!next) close()
      }}
      open={open}
    >
      {/* No close button; base-ui Dialog dismisses on backdrop click / Esc. */}
      <DialogContent
        className="flex h-[80vh] max-w-3xl gap-0 overflow-hidden p-0 sm:max-w-3xl"
        showCloseButton={false}
      >
        <DialogTitle className="sr-only">Settings</DialogTitle>
        <nav className="flex w-52 shrink-0 flex-col gap-0.5 border-r bg-muted/30 px-3 py-4">
          {SECTIONS.map(({ key, label, icon: Icon }) => (
            <button
              className={cn(
                'flex items-center gap-2.5 rounded-lg px-2.5 py-1.5 text-left text-[13px] text-muted-foreground transition-colors hover:bg-accent hover:text-foreground',
                key === section && 'bg-accent text-foreground'
              )}
              key={key}
              onClick={() => openSettings(key)}
              type="button"
            >
              <Icon className="size-4" />
              {label}
            </button>
          ))}
        </nav>
        <ScrollArea className="min-h-0 flex-1">
          <div className="p-6">
            <ActiveView />
          </div>
        </ScrollArea>
      </DialogContent>
    </Dialog>
  )
}
```

- [ ] **Step 2: 类型检查**

Run: `pnpm typecheck`
Expected: 无报错（确认 `ProvidersView/McpServersView/WebSearchView/BudgetsView/SkillsView` 导出名与 import 一致;若实际导出名不同,以 `components/views/*` 实际导出为准修正 import）

- [ ] **Step 3: 提交**

```bash
npx biome check --write src/renderer/src/components/settings-dialog.tsx
git add src/renderer/src/components/settings-dialog.tsx
git commit -m "feat(settings): add SettingsDialog component (nav + section views, no close button)"
```

---

### Task 4: 挂载弹窗 + 接线菜单/deep-link 打开弹窗

把 `SettingsDialog` 挂到 `__root.tsx` 常驻处;把 `use-events-subscription` 的设置导航从 `navigate` 改为打开弹窗;更新对应单测。此时路由式设置仍在(下个任务删),弹窗与路由并存。

**Files:**
- Modify: `src/renderer/src/routes/__root.tsx`
- Modify: `src/renderer/src/hooks/use-events-subscription.ts:70-77`
- Modify: `src/renderer/src/hooks/use-events-subscription.test.tsx:107-114`

**Interfaces:**
- Consumes:`SettingsDialog`(Task 3)、`useSettingsDialog`/`routeToSection`(Task 1)

- [ ] **Step 1: 改 use-events-subscription 测试为断言打开弹窗**

`src/renderer/src/hooks/use-events-subscription.test.tsx` 顶部 import 增加(若尚无):

```tsx
import { useSettingsDialog } from '../stores/settings-dialog'
```

把第 107-114 行的整个 describe 块替换为:

```tsx
describe('useEventsSubscription — settings navigation', () => {
  it('opens the settings dialog at the mapped section when main pushes swarm:navigate-settings', () => {
    useSettingsDialog.setState({ open: false, section: 'general' })
    mount()
    expect(settingsNavCb).toBeTypeOf('function')
    settingsNavCb?.('/settings/providers')
    expect(useSettingsDialog.getState().open).toBe(true)
    expect(useSettingsDialog.getState().section).toBe('providers')
    expect(navigateSpy).not.toHaveBeenCalledWith({ to: '/settings/providers' })
  })
})
```

- [ ] **Step 2: 跑测试确认失败**

Run: `npm test -- src/renderer/src/hooks/use-events-subscription.test.tsx`
Expected: FAIL（弹窗仍未打开,`open` 为 false）

- [ ] **Step 3: 改 use-events-subscription.ts**

把 `src/renderer/src/hooks/use-events-subscription.ts` 第 70-77 行的 effect 替换为:

```ts
  // Main → renderer Settings open (menu / deep-link). Mounted app-wide via
  // EventsBridge, so it works regardless of the current route. Opens the
  // settings dialog at the mapped section instead of navigating to a route.
  useEffect(() => {
    return swarmApi.onNavigateToSettings((route) => {
      useSettingsDialog.getState().openSettings(routeToSection(route))
    })
  }, [])
```

并在该文件 import 区加入:

```ts
import { routeToSection, useSettingsDialog } from '@/stores/settings-dialog'
```

（注意:`navigate` 若因此变为未使用,需从该 effect 的依赖与其它仍在使用处确认;`use-events-subscription.ts` 的 session 导航 effect 仍使用 `navigate`,故 `navigate` 不会变成孤儿——保持不动。）

- [ ] **Step 4: 跑测试确认通过**

Run: `npm test -- src/renderer/src/hooks/use-events-subscription.test.tsx`
Expected: PASS

- [ ] **Step 5: 在 __root.tsx 挂载 SettingsDialog**

`src/renderer/src/routes/__root.tsx` import 区加入:

```tsx
import { SettingsDialog } from '@/components/settings-dialog'
```

在 `RootLayout` 的返回 JSX 中,`<EventsBridge />` 之后加入一行(与 EventsBridge 同级,始终渲染):

```tsx
      <SettingsDialog />
```

即:

```tsx
      <EventsBridge />
      <SettingsDialog />
      {inSettings ? (
```

- [ ] **Step 6: 类型检查 + 手动验证**

Run: `pnpm typecheck`
Expected: 无报错

`pnpm dev` 手动:按 Cmd+,(或触发菜单 Settings)应弹出设置弹窗并停在对应分区;点遮罩/Esc 关闭;Skills 分区内容正常。

- [ ] **Step 7: 提交**

```bash
npx biome check --write src/renderer/src/routes/__root.tsx src/renderer/src/hooks/use-events-subscription.ts src/renderer/src/hooks/use-events-subscription.test.tsx
git add src/renderer/src/routes/__root.tsx src/renderer/src/hooks/use-events-subscription.ts src/renderer/src/hooks/use-events-subscription.test.tsx
git commit -m "feat(settings): mount SettingsDialog at root + open via menu/deep-link IPC"
```

---

### Task 5: 侧边栏 inset 浮窗 + footer 图标行

切 inset 变体;footer 重写为图标行:定时任务/用量(`Link`)+ 设置(开弹窗按钮)+ 右侧主题切换;移除 Skills 入口。

**Files:**
- Modify: `src/renderer/src/components/app-sidebar.tsx`(整文件重写)

**Interfaces:**
- Consumes:`useSettingsDialog`(Task 1);`Tooltip/TooltipContent/TooltipTrigger`(`components/ui/tooltip`);`Sidebar*`(`components/ui/sidebar`);`ThemeToggle`、`SessionList`。

- [ ] **Step 1: 重写 app-sidebar.tsx**

```tsx
// src/renderer/src/components/app-sidebar.tsx
import { Link } from '@tanstack/react-router'
import { BarChart3, CalendarClock, Settings } from 'lucide-react'

import { SessionList } from '@/components/session-list'
import { ThemeToggle } from '@/components/theme-toggle'
import { Sidebar, SidebarContent, SidebarFooter } from '@/components/ui/sidebar'
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip'
import { cn } from '@/lib/utils'
import { useSettingsDialog } from '@/stores/settings-dialog'

const iconBtn =
  'flex size-8 items-center justify-center rounded-md text-muted-foreground transition-colors hover:bg-sidebar-accent hover:text-foreground data-[active=true]:bg-sidebar-accent data-[active=true]:text-foreground [&_svg]:size-4'

export function AppSidebar(): React.JSX.Element {
  const openSettings = useSettingsDialog((s) => s.openSettings)

  return (
    // inset variant: the window is tinted with the sidebar color and the main
    // content floats as a rounded card — no border line on the chat's left edge.
    <Sidebar variant="inset">
      <SidebarContent>
        <SessionList />
      </SidebarContent>
      <SidebarFooter className="border-sidebar-border border-t">
        <div className="flex items-center gap-1">
          <Tooltip>
            <TooltipTrigger
              render={
                <Link
                  // biome-ignore lint/suspicious/noExplicitAny: TanStack Router activeProps generic over route tree
                  activeProps={{ 'data-active': 'true' } as any}
                  className={iconBtn}
                  // biome-ignore lint/suspicious/noExplicitAny: `to` widened over Router's typed registry
                  to={'/scheduled' as any}
                >
                  <CalendarClock />
                </Link>
              }
            />
            <TooltipContent side="top">定时任务</TooltipContent>
          </Tooltip>

          <Tooltip>
            <TooltipTrigger
              render={
                <Link
                  // biome-ignore lint/suspicious/noExplicitAny: TanStack Router activeProps generic over route tree
                  activeProps={{ 'data-active': 'true' } as any}
                  className={iconBtn}
                  // biome-ignore lint/suspicious/noExplicitAny: `to` widened over Router's typed registry
                  to={'/usage' as any}
                >
                  <BarChart3 />
                </Link>
              }
            />
            <TooltipContent side="top">用量统计</TooltipContent>
          </Tooltip>

          <Tooltip>
            <TooltipTrigger
              render={
                <button className={cn(iconBtn)} onClick={() => openSettings()} type="button">
                  <Settings />
                </button>
              }
            />
            <TooltipContent side="top">设置</TooltipContent>
          </Tooltip>

          <div className="flex-1" />
          <ThemeToggle />
        </div>
      </SidebarFooter>
    </Sidebar>
  )
}
```

- [ ] **Step 2: 类型检查**

Run: `pnpm typecheck`
Expected: 无报错（确认 `Tooltip`/`TooltipTrigger`/`TooltipContent` 的 `render` 用法与现有调用点一致——参考 `components/ui/sidebar.tsx` 中 `TooltipTrigger render={...}`;若 `TooltipTrigger` 在本项目无 `render` 支持,改为把 Link/button 作为 children 包裹)

- [ ] **Step 3: 手动验证**

`pnpm dev`:
- 侧边栏融入染色窗体、聊天区为浮起圆角卡、**左侧无边缘线**。
- footer 一行图标:定时任务/用量/设置 + 右侧主题切换;hover 出 tooltip;点设置弹窗打开;无 Skills 入口。

- [ ] **Step 4: 提交**

```bash
npx biome check --write src/renderer/src/components/app-sidebar.tsx
git add src/renderer/src/components/app-sidebar.tsx
git commit -m "feat(sidebar): inset floating variant + icon-row footer; settings opens dialog"
```

---

### Task 6: 删除旧路由与返回逻辑、清死代码

侧边栏已不再链接 `/settings`、`/skills`,菜单/deep-link 走弹窗。删除路由式设置全套、`settings-return.ts`、`__root` 全屏接管,以及孤立的 `settings-view.tsx`。

**Files:**
- Delete: `src/renderer/src/routes/settings.tsx`
- Delete: `src/renderer/src/routes/settings.index.tsx`
- Delete: `src/renderer/src/routes/settings.providers.tsx`
- Delete: `src/renderer/src/routes/settings.mcp.tsx`
- Delete: `src/renderer/src/routes/settings.web-search.tsx`
- Delete: `src/renderer/src/routes/settings.budgets.tsx`
- Delete: `src/renderer/src/routes/settings.permissions.tsx`
- Delete: `src/renderer/src/routes/settings.about.tsx`
- Delete: `src/renderer/src/routes/skills.tsx`
- Delete: `src/renderer/src/lib/settings-return.ts`
- Delete: `src/renderer/src/components/views/settings-view.tsx`
- Modify: `src/renderer/src/routes/__root.tsx`
- Auto-regen: `src/renderer/src/routeTree.gen.ts`(由 TanStack Router 插件在 dev/build 时重生成)

- [ ] **Step 1: 删除文件**

```bash
git rm src/renderer/src/routes/settings.tsx \
  src/renderer/src/routes/settings.index.tsx \
  src/renderer/src/routes/settings.providers.tsx \
  src/renderer/src/routes/settings.mcp.tsx \
  src/renderer/src/routes/settings.web-search.tsx \
  src/renderer/src/routes/settings.budgets.tsx \
  src/renderer/src/routes/settings.permissions.tsx \
  src/renderer/src/routes/settings.about.tsx \
  src/renderer/src/routes/skills.tsx \
  src/renderer/src/lib/settings-return.ts \
  src/renderer/src/components/views/settings-view.tsx
```

- [ ] **Step 2: 精简 __root.tsx**

把 `RootLayout` 中的 `inSettings` 分支与返回记录逻辑移除。具体:

删除 import:
```tsx
import { setSettingsReturnHref } from '@/lib/settings-return'
```

删除这两段(`pathname`/`inSettings` 计算 + 记录 effect):
```tsx
  const pathname = useRouterState({ select: (s) => s.location.pathname })
  const inSettings = pathname === '/settings' || pathname.startsWith('/settings/')

  // Remember where we were before entering Settings so "Done" can jump straight
  // back, rather than history.back()-ing through visited settings sub-pages.
  useEffect(() => {
    if (!inSettings) setSettingsReturnHref(href)
  }, [href, inSettings])
```

若移除后 `href`/`useRouterState` 仅剩此处使用,一并删除其声明:
```tsx
  const href = useRouterState({ select: (s) => s.location.href })
```

把返回 JSX 的 `inSettings` 三元改为始终渲染侧边栏布局:
```tsx
    <>
      <EventsBridge />
      <SettingsDialog />
      <SidebarProvider>
        <TopBar />
        <AppSidebar />
        <SidebarInset className="min-w-0 overflow-hidden">
          <main className="flex h-svh flex-col overflow-hidden bg-[var(--window-content)] pt-9">
            <NoProviderBanner />
            <div className="min-h-0 flex-1">
              <Outlet />
            </div>
          </main>
        </SidebarInset>
      </SidebarProvider>
      <Toaster />
      {SHOW_ROUTER_DEVTOOLS && (
        <Suspense fallback={null}>
          <RouterDevtools position="bottom-right" />
        </Suspense>
      )}
    </>
```

（若 `useEffect`/`useRouterState` 在文件内不再被任何代码使用,移除对应 import 名;`useLoadSessions` 的 mount effect 仍用 `useEffect`,故 `useEffect` 保留。）

- [ ] **Step 3: 重生成路由树 + 类型检查**

Run: `pnpm dev` 启动一次让插件重写 `routeTree.gen.ts`(或运行项目的路由生成命令,如 `pnpm exec tsr generate`,以实际脚本为准);随后 Ctrl-C。
然后 Run: `pnpm typecheck`
Expected: 无报错,且 `routeTree.gen.ts` 不再含 `/settings`、`/skills` 节点。

- [ ] **Step 4: 全量校验**

Run: `npm test`
Expected: 全绿(尤其 `use-events-subscription.test.tsx`、`settings-dialog.test.ts`)。

`pnpm dev` 手动确认:
- 访问 `/`、`/scheduled`、`/usage` 正常;旧 `/settings`、`/skills` 不再可达。
- `swarmagents://settings/mcp` deep-link 打开弹窗并定位 MCP 分区。

- [ ] **Step 5: 提交**

```bash
npx biome check --write src/renderer/src/routes/__root.tsx
git add -A
git commit -m "refactor(settings): remove /settings & /skills routes, settings-return, full-screen takeover; drop dead settings-view"
```

---

## Self-Review

**1. Spec coverage:**
- 浮窗侧边栏(inset)→ Task 5 ✓
- 顶部 New chat 作首要元素(已存在,无需改)+ 清理全屏空白 → Task 5(inset)+ Task 6(移除 inSettings 接管)✓
- footer 图标行 → Task 5 ✓
- 设置弹窗(无关闭按钮、点窗外关)→ Task 3 ✓
- Skills 并入弹窗 → Task 3(SECTIONS 含 skills)+ Task 5(移除侧栏 Skills 入口)✓
- 删旧路由 + 菜单/deep-link 改开弹窗 → Task 4(接线)+ Task 6(删除)✓
- 删 settings-return / settings-view → Task 6 ✓
- 抽取内联子页 → Task 2 ✓
- 更新失效测试 → Task 4 ✓

**2. Placeholder scan:** 无 TBD/TODO;所有代码步骤含完整代码。

**3. Type consistency:** `SettingsSection`、`useSettingsDialog`、`routeToSection`、`SettingsDialog`、各 `*View` 命名在 Task 1→3→4→5 间一致。`openSettings(section?)` 签名一致。

**待实现者实机核对的两处(已在步骤内标注,非占位符):**
- Task 3:`components/views/` 各 view 的导出名(预期 `ProvidersView/McpServersView/WebSearchView/BudgetsView/SkillsView`,以实际为准)。
- Task 5:`TooltipTrigger` 的 `render` prop 用法(参考 `components/ui/sidebar.tsx` 现有用法);如不支持则改 children 包裹。
- Task 6:路由生成命令(`routeTree.gen.ts` 重生成方式,以项目实际脚本为准)。
