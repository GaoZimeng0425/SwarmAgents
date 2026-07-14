# App Shell — 64px Icon Rail Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace the floating `AppSidebar` (SessionList-only) with a 64px icon rail as the primary nav, organized into 场景 / 服务 groups, with SessionList becoming a secondary panel shown only in the conversation scene.

**Architecture:** Split the rail into a pure, testable config module (`rail-config.ts`: types + `RAIL_SECTIONS` + `isConversationScene` + `isActive`) and two thin render components (`app-rail.tsx`, `session-panel.tsx`). Wire them into `__root.tsx` in place of `AppSidebar`, then delete the now-dead `service-grid.*` and `app-sidebar.tsx`. All business/IPC/data layers stay untouched.

**Tech Stack:** React 19, TanStack Router (`useLocation`/`useNavigate`/`Link`), Tailwind v4 with `@swarm/ui` tokens, lucide-react icons, Vitest (jsdom) following the project's pure-logic test pattern.

**Spec:** `docs/superpowers/specs/2026-07-05-app-shell-rail-design.md`

**Branch:** `refactor/ui-app-shell-rail` (already created from `develop`).

---

## File Structure

| File | Responsibility | Status |
|---|---|---|
| `apps/desktop/src/renderer/src/components/rail-config.ts` | Pure logic: `RailTarget`/`RailItem`/`RailSection` types, `RAIL_SECTIONS` constant, `isConversationScene(pathname)`, `isActive(item, pathname)`. No React render, no router. Imports only lucide icon components + React type for the icon field. | **Create** |
| `apps/desktop/src/renderer/src/components/rail-config.test.ts` | Pure-logic tests for `RAIL_SECTIONS` shape, `isConversationScene`, `isActive` (incl. shared-route case). | **Create** |
| `apps/desktop/src/renderer/src/components/app-rail.tsx` | Renders the 64px rail. Consumes `RAIL_SECTIONS`, `isActive`, `useLocation`. Maps the `formation` action item to `openSettings('agents')`; footer renders Settings button + `ThemeToggle`. | **Create** |
| `apps/desktop/src/renderer/src/components/session-panel.tsx` | Wraps `SessionList` + its existing footer actions in the 236px secondary panel. Exported only (visibility decided by caller via `isConversationScene`). | **Create** |
| `apps/desktop/src/renderer/src/routes/__root.tsx` | Replace `<AppSidebar/>` with `<AppRail/>` + conditional `<SessionPanel/>`. Remove `SidebarTrigger` from `TopBar`. | **Modify** |
| `apps/desktop/src/renderer/src/components/session-list.tsx` | Remove `<ServiceGrid/>` usage (line 414) + its import (line 38). Nothing else. | **Modify** |
| `apps/desktop/src/renderer/src/components/service-grid.tsx` | Dead after services move to rail. | **Delete** |
| `apps/desktop/src/renderer/src/components/service-grid.test.tsx` | Tests the deleted `SERVICES`. | **Delete** |
| `apps/desktop/src/renderer/src/components/app-sidebar.tsx` | Dead after `AppRail` + `SessionPanel` take over. | **Delete** |

---

## Task 1: Pure rail config + tests (TDD)

**Files:**
- Create: `apps/desktop/src/renderer/src/components/rail-config.ts`
- Create: `apps/desktop/src/renderer/src/components/rail-config.test.ts`

- [ ] **Step 1: Write the failing test**

Create `apps/desktop/src/renderer/src/components/rail-config.test.ts`:

```ts
import { BarChart3, CalendarClock, Clock, LayoutDashboard, Mail, MessageSquare, Network, TrendingUp, Video } from 'lucide-react'
import { describe, expect, it } from 'vitest'

import { type RailItem, RAIL_SECTIONS, isActive, isConversationScene } from '@/components/rail-config'

describe('RAIL_SECTIONS', () => {
  it('has exactly two sections: scenes then services', () => {
    expect(RAIL_SECTIONS.map((s) => s.id)).toEqual(['scenes', 'services'])
  })

  it('scenes list matches the design in order with the right icons', () => {
    const scenes = RAIL_SECTIONS[0].items as RailItem[]
    expect(scenes.map((i) => i.label)).toEqual(['任务台', '对话', '编队', '日历', '自动化', '用量'])
    expect(scenes.map((i) => i.icon)).toEqual([LayoutDashboard, MessageSquare, Network, CalendarClock, Clock, BarChart3])
  })

  it('services list matches the design in order with the right icons', () => {
    const services = RAIL_SECTIONS[1].items as RailItem[]
    expect(services.map((i) => i.label)).toEqual(['Gmail', 'GitHub 趋势', 'Bilibili'])
    expect(services.map((i) => i.icon)).toEqual([Mail, TrendingUp, Video])
  })

  it('routes every route item to its expected path with the expected match mode', () => {
    const routes = RAIL_SECTIONS.flatMap((s) => s.items).filter((i) => i.target.kind === 'route')
    expect(
      routes.map((i) =>
        i.target.kind === 'route' ? { key: i.key, to: i.target.to, match: i.target.match } : null,
      ),
    ).toEqual([
      { key: 'home', to: '/', match: 'exact' },
      { key: 'chat', to: '/session/', match: 'prefix' },
      { key: 'calendar', to: '/scheduled', match: 'exact' },
      { key: 'automation', to: '/scheduled', match: 'exact' },
      { key: 'usage', to: '/usage', match: 'exact' },
      { key: 'gmail', to: '/gmail', match: 'exact' },
      { key: 'trending', to: '/trending', match: 'exact' },
      { key: 'bilibili', to: '/bilibili', match: 'exact' },
    ])
  })

  it('marks only the formation item as an action', () => {
    const actions = RAIL_SECTIONS.flatMap((s) => s.items).filter((i) => i.target.kind === 'action')
    expect(actions.map((i) => i.key)).toEqual(['formation'])
  })
})

describe('isConversationScene', () => {
  it('is true on the home route and any session route', () => {
    expect(isConversationScene('/')).toBe(true)
    expect(isConversationScene('/session/abc')).toBe(true)
    expect(isConversationScene('/session/abc/def')).toBe(true)
  })

  it('is false on every other route', () => {
    expect(isConversationScene('/scheduled')).toBe(false)
    expect(isConversationScene('/usage')).toBe(false)
    expect(isConversationScene('/gmail')).toBe(false)
    expect(isConversationScene('/trending')).toBe(false)
    expect(isConversationScene('/bilibili')).toBe(false)
    expect(isConversationScene('/sessions')).toBe(false) // prefix is '/session/'
  })
})

describe('isActive', () => {
  const find = (key: string): RailItem =>
    RAIL_SECTIONS.flatMap((s) => s.items).find((i) => i.key === key) as RailItem

  it('matches exact routes only on their exact path', () => {
    expect(isActive(find('home'), '/')).toBe(true)
    expect(isActive(find('home'), '/session/x')).toBe(false)
  })

  it('matches prefix routes on any path under them', () => {
    expect(isActive(find('chat'), '/session/abc')).toBe(true)
    expect(isActive(find('chat'), '/')).toBe(false)
  })

  it('lights up both calendar and automation on the shared /scheduled route', () => {
    expect(isActive(find('calendar'), '/scheduled')).toBe(true)
    expect(isActive(find('automation'), '/scheduled')).toBe(true)
  })

  it('is never active for action items', () => {
    expect(isActive(find('formation'), '/')).toBe(false)
    expect(isActive(find('formation'), '/scheduled')).toBe(false)
  })
})
```

- [ ] **Step 2: Run test to verify it fails**

Run from repo root:
```bash
pnpm --filter desktop exec vitest run src/renderer/src/components/rail-config.test.ts
```
Expected: FAIL with "Failed to resolve import '@/components/rail-config'" (file does not exist yet).

- [ ] **Step 3: Write the config module**

Create `apps/desktop/src/renderer/src/components/rail-config.ts`:

```ts
// Pure rail configuration and navigation predicates. No React rendering, no
// router imports — keeps the rail's source of truth testable without a router
// context (matches the project's existing pure-logic test pattern, e.g. the
// former service-grid.test.ts).

import type { ComponentType } from 'react'
import { BarChart3, CalendarClock, Clock, LayoutDashboard, Mail, MessageSquare, Network, TrendingUp, Video } from 'lucide-react'

export type RailTarget =
  // Navigates to a router path. `match` controls active-state matching:
  //   - 'exact': active only when pathname === to (e.g. '/' for 任务台)
  //   - 'prefix': active when pathname starts with to (e.g. '/session/' for 对话)
  | { kind: 'route'; to: string; match: 'exact' | 'prefix' }
  // Fires an in-component handler instead of navigating (e.g. 编队 → settings modal).
  // Never shows an active state.
  | { kind: 'action' }

export type RailItem = {
  key: string
  label: string
  icon: ComponentType<{ className?: string }>
  target: RailTarget
}

export type RailSection = {
  id: 'scenes' | 'services'
  items: RailItem[]
}

// Single source of truth for the 64px rail. Footer items (设置 / 主题) are NOT
// here: 设置 is an action with no route, and 主题 is a dedicated component, so
// they are rendered directly in app-rail.tsx rather than forced into this shape.
export const RAIL_SECTIONS: RailSection[] = [
  {
    id: 'scenes',
    items: [
      { key: 'home', label: '任务台', icon: LayoutDashboard, target: { kind: 'route', to: '/', match: 'exact' } },
      { key: 'chat', label: '对话', icon: MessageSquare, target: { kind: 'route', to: '/session/', match: 'prefix' } },
      // Agents live inside the SettingsDialog today (no /agents route yet); the
      // rail opens that modal directly on the agents section.
      { key: 'formation', label: '编队', icon: Network, target: { kind: 'action' } },
      { key: 'calendar', label: '日历', icon: CalendarClock, target: { kind: 'route', to: '/scheduled', match: 'exact' } },
      { key: 'automation', label: '自动化', icon: Clock, target: { kind: 'route', to: '/scheduled', match: 'exact' } },
      { key: 'usage', label: '用量', icon: BarChart3, target: { kind: 'route', to: '/usage', match: 'exact' } },
    ],
  },
  {
    id: 'services',
    items: [
      { key: 'gmail', label: 'Gmail', icon: Mail, target: { kind: 'route', to: '/gmail', match: 'exact' } },
      { key: 'trending', label: 'GitHub 趋势', icon: TrendingUp, target: { kind: 'route', to: '/trending', match: 'exact' } },
      { key: 'bilibili', label: 'Bilibili', icon: Video, target: { kind: 'route', to: '/bilibili', match: 'exact' } },
    ],
  },
]

// A scene where the conversation surface (and thus the session list) is the
// focus: the home landing and any /session/:id. SessionPanel renders iff true.
export function isConversationScene(pathname: string): boolean {
  return pathname === '/' || pathname.startsWith('/session/')
}

export function isActive(item: RailItem, pathname: string): boolean {
  if (item.target.kind !== 'route') return false
  return item.target.match === 'exact' ? pathname === item.target.to : pathname.startsWith(item.target.to)
}
```

- [ ] **Step 4: Run test to verify it passes**

```bash
pnpm --filter desktop exec vitest run src/renderer/src/components/rail-config.test.ts
```
Expected: PASS (all 4 RAIL_SECTIONS tests + 2 isConversationScene + 4 isActive).

- [ ] **Step 5: Commit**

```bash
git add apps/desktop/src/renderer/src/components/rail-config.ts apps/desktop/src/renderer/src/components/rail-config.test.ts
git commit -m "feat(ui): add rail config + nav predicates for app-shell rail"
```

---

## Task 2: Render the `AppRail` component

**Files:**
- Create: `apps/desktop/src/renderer/src/components/app-rail.tsx`

**Context the implementer needs:**
- `useLocation`/`useNavigate` come from `@tanstack/react-router`. `useLocation()` returns `{ pathname }`.
- `useSettingsDialog` store exposes `openSettings: (section?: SettingsSection) => void`; `'agents'` is a valid section (verified in `settings-dialog.ts`).
- `ThemeToggle` already exists at `@/components/theme-toggle`.
- The rail sits under the macOS traffic lights; reuse the same top padding the floating sidebar used (`pt-9` keeps icons clear of the 36px control band). The fixed `TopBar` overlays the rail's top — that's expected and matches today's layout.

- [ ] **Step 1: Create `app-rail.tsx`**

```tsx
// 64px icon rail — the app's primary navigation. Two grouped sections
// (场景 / 服务) rendered from rail-config.ts, plus a footer (设置 / 主题).
// Route items navigate via TanStack Router; the single action item (编队)
// opens the agents section of the SettingsDialog. Active state is derived
// from useLocation so prefix matches (对话) and shared routes (日历+自动化
// both on /scheduled) light up correctly.

import { cn, Tooltip, TooltipContent, TooltipTrigger } from '@swarm/ui'
import { useLocation, useNavigate } from '@tanstack/react-router'
import { Settings } from 'lucide-react'

import { ThemeToggle } from '@/components/theme-toggle'
import { useSettingsDialog } from '@/stores/settings-dialog'
import { type RailItem, RAIL_SECTIONS, isActive } from '@/components/rail-config'

const iconBtn =
  'flex size-11 items-center justify-center rounded-xl text-muted-foreground transition-colors hover:bg-sidebar-accent hover:text-foreground data-[active=true]:bg-sidebar-accent data-[active=true]:text-foreground [&_svg]:size-5'

export function AppRail(): React.JSX.Element {
  const { pathname } = useLocation()
  const navigate = useNavigate()
  const openSettings = useSettingsDialog((s) => s.openSettings)

  // Action items don't navigate; the formation item opens the agents settings.
  const runAction = (item: RailItem) => {
    if (item.key === 'formation') openSettings('agents')
  }

  const onClick = (item: RailItem) => {
    if (item.target.kind === 'route') {
      // '/session/' is a prefix match target, not a real route — route to the
      // landing where the user picks/starts a conversation.
      navigate({ to: item.target.to === '/session/' ? '/' : item.target.to })
    } else {
      runAction(item)
    }
  }

  return (
    // Full-height 64px column pinned left, translucent over window vibrancy.
    // pt-9 keeps icons below the traffic-light band (the fixed TopBar owns
    // that strip and overlays the rail's top).
    <nav className="flex w-16 shrink-0 flex-col items-center gap-1 bg-sidebar pt-9 pb-3" aria-label="主导航">
      {RAIL_SECTIONS.map((section, sectionIdx) => (
        <div key={section.id} className="flex flex-col items-center gap-1">
          {sectionIdx > 0 && <div className="my-1 h-px w-6 bg-sidebar-border" aria-hidden="true" />}
          {section.items.map((item) => {
            const Icon = item.icon
            const active = isActive(item, pathname)
            return (
              <Tooltip key={item.key}>
                <TooltipTrigger
                  render={
                    <button
                      className={iconBtn}
                      data-active={active}
                      onClick={() => onClick(item)}
                      type="button"
                      aria-label={item.label}
                      aria-current={active ? 'page' : undefined}
                    >
                      <Icon />
                    </button>
                  }
                />
                <TooltipContent side="right">{item.label}</TooltipContent>
              </Tooltip>
            )
          })}
        </div>
      ))}

      <div className="flex-1" />

      {/* Footer: settings (modal) + theme toggle. Mirrors the old sidebar footer. */}
      <Tooltip>
        <TooltipTrigger
          render={
            <button className={iconBtn} onClick={() => openSettings()} type="button" aria-label="设置">
              <Settings />
            </button>
          }
        />
        <TooltipContent side="right">设置</TooltipContent>
      </Tooltip>
      <ThemeToggle />
    </nav>
  )
}
```

- [ ] **Step 2: Type-check the new file**

```bash
pnpm --filter desktop exec tsc --noEmit -p src/renderer
```
(If the project's type-check command differs, use `pnpm --filter desktop run typecheck`; either should report no errors from this file.)
Expected: no errors.

- [ ] **Step 3: Commit**

```bash
git add apps/desktop/src/renderer/src/components/app-rail.tsx
git commit -m "feat(ui): add 64px AppRail component"
```

---

## Task 3: Render the `SessionPanel` component

**Files:**
- Create: `apps/desktop/src/renderer/src/components/session-panel.tsx`

**Context:** Today `AppSidebar` (the file we'll delete) wraps `SessionList` in a floating `Sidebar` card with a footer (Settings + ThemeToggle). The Settings/Theme actions move to the rail footer; the panel only needs to host `SessionList`. Use the floating-card treatment so the chat surface still reads as one material with the rail.

- [ ] **Step 1: Create `session-panel.tsx`**

```tsx
// Secondary panel that hosts the conversation list. Shown only in the
// conversation scene (see isConversationScene); the caller decides visibility.
// Settings + theme live in the rail footer now, so this panel is just the list.

import { SessionList } from '@/components/session-list'

export function SessionPanel(): React.JSX.Element {
  return (
    // 236px column (design-spec conversation-list width) flush to the rail.
    // pt-9 clears the traffic-light band shared with the rail + fixed TopBar.
    // SessionList already manages its own scrolling internally (its own
    // ScrollArea at session-list.tsx:444), so we must NOT wrap it again — a
    // double ScrollArea would fight over the viewport height.
    <aside className="flex w-[236px] shrink-0 flex-col border-r border-sidebar-border bg-sidebar pt-9">
      {/* min-h-0 so SessionList's inner ScrollArea (session-list.tsx:444) can
          shrink and scroll within this flex column instead of overflowing it. */}
      <div className="min-h-0 flex-1">
        <SessionList />
      </div>
    </aside>
  )
}
```

- [ ] **Step 2: Type-check**

```bash
pnpm --filter desktop exec tsc --noEmit -p src/renderer
```
Expected: no errors.

- [ ] **Step 3: Commit**

```bash
git add apps/desktop/src/renderer/src/components/session-panel.tsx
git commit -m "feat(ui): add SessionPanel wrapper for the conversation list"
```

---

## Task 4: Decouple `SessionList` from the dead `ServiceGrid`

**Files:**
- Modify: `apps/desktop/src/renderer/src/components/session-list.tsx` (remove line 38 import + line 414 usage)
- Delete: `apps/desktop/src/renderer/src/components/service-grid.tsx`
- Delete: `apps/desktop/src/renderer/src/components/service-grid.test.tsx`

**Why before wiring `__root.tsx`:** `ServiceGrid`'s services are now in the rail. Removing its usage from `SessionList` first means there are no dangling references when we swap the shell in Task 6.

- [ ] **Step 1: Read the two edit sites in `session-list.tsx`**

Confirm the import line (~38) and the `<ServiceGrid />` usage (~414) are exactly as expected:
```bash
grep -n "service-grid\|ServiceGrid" apps/desktop/src/renderer/src/components/session-list.tsx
```
Expected: two hits — the `import { ServiceGrid } from '@/components/service-grid'` line and the `<ServiceGrid />` line.

- [ ] **Step 2: Remove the import**

Delete this line from `session-list.tsx`:
```ts
import { ServiceGrid } from '@/components/service-grid'
```

- [ ] **Step 3: Remove the usage**

Delete this line from `session-list.tsx` (the self-closing element between the "New chat" button and the "Search" button, around line 414):
```tsx
      <ServiceGrid />
```
Leave the surrounding "New chat" and "Search" buttons exactly as they are.

- [ ] **Step 4: Delete the dead module + its test**

```bash
git rm apps/desktop/src/renderer/src/components/service-grid.tsx apps/desktop/src/renderer/src/components/service-grid.test.tsx
```

- [ ] **Step 5: Verify nothing else imports `ServiceGrid`**

```bash
grep -rn "service-grid\|ServiceGrid" apps/desktop/src/renderer/src
```
Expected: no matches.

- [ ] **Step 6: Run the full renderer test suite**

```bash
pnpm --filter desktop exec vitest run
```
Expected: PASS. (The deleted `service-grid.test.ts` no longer runs; `session-list`-related tests, if any, still pass; Task 1's `rail-config.test.ts` passes.)

- [ ] **Step 7: Commit**

```bash
git add apps/desktop/src/renderer/src/components/session-list.tsx
git commit -m "refactor(ui): remove ServiceGrid; services move to the app rail"
```

---

## Task 5: Wire `AppRail` + `SessionPanel` into `__root.tsx`

**Files:**
- Modify: `apps/desktop/src/renderer/src/routes/__root.tsx`

**Context the implementer needs:**
- Current `__root.tsx` renders `<SidebarProvider><TopBar/><AppSidebar/><SidebarInset>…</SidebarInset></SidebarProvider>`.
- `TopBar` (defined in the same file) imports `SidebarTrigger` — that toggled the old single sidebar; with the rail there is nothing to collapse, so remove it (and keep `ArrowLeft`/`ArrowRight` and `ToolsPopover`).
- We keep `SidebarProvider` + `SidebarInset` for layout context (other code may consume it); we just no longer render a `<Sidebar>` inside. The rail + panel + main sit in a flex row.
- `useLocation` is reactive to router navigation, so `EventsBridge`-driven `swarm:navigate` pushes will update the panel's visibility automatically.

- [ ] **Step 1: Edit imports**

In `__root.tsx`:
- Remove `SidebarTrigger` from the `@swarm/ui` import (keep `Button`, `SidebarInset`, `SidebarProvider`, `Toaster`).
- Remove `ArrowLeft`? — NO, keep `ArrowLeft`/`ArrowRight` (still used by TopBar back/forward).
- Replace the `AppSidebar` import with `AppRail` and `SessionPanel`, and add the config import:
```tsx
import { AppRail } from '@/components/app-rail'
import { SessionPanel } from '@/components/session-panel'
import { isConversationScene } from '@/components/rail-config'
```
- Add `useLocation` to the TanStack Router import:
```tsx
import { createRootRoute, Outlet, useLocation, useRouter } from '@tanstack/react-router'
```

- [ ] **Step 2: Replace the body of `RootLayout`**

Find the `<SidebarProvider>…</SidebarProvider>` block and replace its contents so the render becomes:

```tsx
      <SidebarProvider className="bg-(--window-content)">
        <TopBar />
        <div className="flex min-h-svh w-full">
          <AppRail />
          {isConversationScene(location.pathname) && <SessionPanel />}
          <SidebarInset className="min-w-0 flex-1 overflow-hidden">
            <main className="flex h-svh flex-col overflow-hidden pt-9">
              <NoProviderBanner />
              <div className="min-h-0 flex-1">
                <Outlet />
              </div>
            </main>
          </SidebarInset>
        </div>
      </SidebarProvider>
```

And at the top of `RootLayout`, capture the location:
```tsx
function RootLayout(): React.JSX.Element {
  const loadSessions = useLoadSessions()
  const location = useLocation()
  // Load the session list once for the whole app (the panel is mounted in the
  // conversation scene; loading here keeps it ready before first mount).
  // biome-ignore lint/correctness/useExhaustiveDependencies: mount-only; loadSessions is a stable React Query mutation
  useEffect(() => {
    loadSessions.mutate()
  }, [])
  // …existing return replaced as above
}
```

Keep the `<>` fragment wrapper, `<EventsBridge />`, `<SettingsDialog />`, `<SessionSearchDialog />`, `<Toaster />`, and the RouterDevtools block exactly as they are.

- [ ] **Step 3: Remove `SidebarTrigger` from `TopBar`**

In the `TopBar` function (same file), delete this line from the left cluster:
```tsx
        <SidebarTrigger aria-label="Toggle sidebar" className="text-muted-foreground" />
```
Keep the `<Button>` back/forward buttons and the `pl-[88px]` traffic-light offset. The right cluster (`ToolsPopover`) stays unchanged.

- [ ] **Step 4: Type-check**

```bash
pnpm --filter desktop exec tsc --noEmit -p src/renderer
```
Expected: no errors. (If `SidebarInset`/`SidebarProvider` complain about a missing `Sidebar` child, that's not a type error — they accept children freely. Real errors here would be unused imports.)

- [ ] **Step 5: Run the full test suite**

```bash
pnpm --filter desktop exec vitest run
```
Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add apps/desktop/src/renderer/src/routes/__root.tsx
git commit -m "refactor(ui): mount AppRail + conditional SessionPanel in the root layout"
```

---

## Task 6: Delete the dead `AppSidebar`

**Files:**
- Delete: `apps/desktop/src/renderer/src/components/app-sidebar.tsx`

- [ ] **Step 1: Confirm no remaining imports**

```bash
grep -rn "app-sidebar\|AppSidebar" apps/desktop/src
```
Expected: no matches (Task 5 removed the last reference).

- [ ] **Step 2: Delete**

```bash
git rm apps/desktop/src/renderer/src/components/app-sidebar.tsx
```

- [ ] **Step 3: Type-check + test**

```bash
pnpm --filter desktop exec tsc --noEmit -p src/renderer && pnpm --filter desktop exec vitest run
```
Expected: no errors, all tests PASS.

- [ ] **Step 4: Commit**

```bash
git commit -m "refactor(ui): remove dead AppSidebar (replaced by AppRail + SessionPanel)"
```

---

## Task 7: Manual smoke test + verification

**Files:** none (verification only)

- [ ] **Step 1: Start the dev app**

```bash
pnpm --filter desktop dev
```

- [ ] **Step 2: Walk the smoke checklist**

Verify each in the running app:
1. **Rail renders**: 64px column on the left, two groups (场景 then 服务) with a divider between, footer has Settings + theme toggle.
2. **Tooltips**: hover any rail icon → label appears on the right.
3. **Navigation**: clicking 任务台/日历/用量/Gmail/GitHub趋势/Bilibili routes correctly; 对话 routes to `/`.
4. **Active state**: each route lights up its icon; on `/scheduled` both 日历 and 自动化 light up; 编队 never lights up.
5. **编队 action**: clicking 编队 opens the SettingsDialog on the Agents section.
6. **设置 action**: clicking 设置 opens the SettingsDialog on General.
7. **SessionPanel visibility**: panel appears on `/` and `/session/:id`; disappears on `/scheduled`, `/usage`, `/gmail`, `/trending`, `/bilibili`.
8. **SessionList still works**: 新建对话 button creates a session; Search (⌘K) opens the search dialog; list scrolls/pins/reorders as before.
9. **Title bar**: window is draggable from the top strip; traffic lights are not overlapped by rail icons; back/forward buttons work; `ToolsPopover` still opens top-right.
10. **Deep-link nav**: if reachable, trigger a `swarm:navigate` (e.g. open a session from search) — rail/panel react without a reload.

- [ ] **Step 3: Run the full test suite one final time**

```bash
pnpm --filter desktop exec vitest run
```
Expected: PASS.

- [ ] **Step 4: Final commit (if any smoke-test fixes were made)**

If smoke testing surfaced fixes, commit them. Otherwise no commit.

---

## Self-Review

**Spec coverage:**
- §3 Rail structure → Task 1 (config) + Task 2 (render). ✓
- §4 Layout architecture → Task 5 (`__root.tsx` flex row, TopBar keeps traffic-light offset, SidebarTrigger removed). ✓
- §5 Scene model / SessionPanel visibility → Task 1 (`isConversationScene`) + Task 3 (panel) + Task 5 (conditional render). ✓
- §6 Files: rail-config, app-rail, session-panel created (T1–T3); session-list ServiceGrid removed (T4); service-grid.* + app-sidebar.tsx deleted (T4, T6); __root.tsx modified (T5). ✓
- §8 Testing → rail-config.test.ts (T1) + full suite runs (T4/T5/T6/T7) + manual smoke (T7). ✓

**Placeholder scan:** No TBD/TODO; every code step shows the actual code; commands include expected output.

**Type consistency:** `RailItem` / `RailTarget` / `RailSection` defined once in `rail-config.ts` and used unchanged in `app-rail.tsx` and `rail-config.test.ts`. `isActive(item, pathname)` signature consistent across config, test, and render. `isConversationScene(pathname)` consistent across config, test, and `__root.tsx`.

**Scope check:** Single subsystem (app shell). Each task produces a compiling, testable state. No deferred work inside this plan.
