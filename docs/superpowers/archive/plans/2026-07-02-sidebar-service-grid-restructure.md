# Sidebar Service-Grid Restructure Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Move the four service shortcuts (`/scheduled`, `/usage`, `/trending`, `/bilibili`) out of the sidebar footer into a 3-column grid directly under the "New chat" button; leave only Settings + ThemeToggle in the footer; relabel `/scheduled` 「定时任务」→「日历」.

**Architecture:** Extract the inline footer service `<Link>`s into a focused `<ServiceGrid />` component (owns the services array + 3-col grid), render it inside `SessionList` right after the "New chat" button, and strip the footer down to Settings + ThemeToggle. Pure renderer change — no backend, no protocol, no new deps.

**Tech Stack:** React 19, TanStack Router (`<Link>`), shadcn `Tooltip`, Tailwind, lucide icons, vitest + RTL.

## Global Constraints

- Reply/conversation in Chinese; **code comments and commit messages in English** (CLAUDE.md §0).
- Every changed line traces to the request; don't refactor adjacent code (CLAUDE.md §3).
- All scroll containers use the `ScrollArea` component (memory `feedback_all_scroll_use_scrollarea`); the new grid is non-scrolling.
- Biome formats the whole repo on `pnpm check` — use `npx biome check --write <file>` for scoped formatting (memory `reference_biome_check_hardcodes_dot`).
- This lands in **worktree A**; `calendar` (worktree B) rebases onto it. The shared file `app-sidebar.tsx` is owned by this plan.
- Test commands run via the Electron-node vitest runner: `npm test` (memory `project_run_tests_via_electron_node`). Never `pnpm rebuild better-sqlite3`.

## File Structure

- **Create** `apps/desktop/src/renderer/src/components/service-grid.tsx` — owns the `SERVICES` array + `<ServiceGrid />` (3-col grid of icon `<Link>`s). Single responsibility: sidebar service nav.
- **Modify** `apps/desktop/src/renderer/src/components/session-list.tsx` — render `<ServiceGrid />` directly below the "New chat" button.
- **Modify** `apps/desktop/src/renderer/src/components/app-sidebar.tsx` — remove the four service `<Tooltip>`/`<Link>` blocks and their icon imports from `SidebarFooter`; footer keeps only Settings + ThemeToggle.
- **Create** `apps/desktop/src/renderer/src/components/service-grid.test.ts` — data-contract test for `SERVICES`.

---

### Task 1: `<ServiceGrid />` component + data contract test

**Files:**
- Create: `apps/desktop/src/renderer/src/components/service-grid.tsx`
- Test: `apps/desktop/src/renderer/src/components/service-grid.test.ts`

**Interfaces:**
- Produces: `SERVICES` (exported `ServiceEntry[]`), `<ServiceGrid />` (default export via named `ServiceGrid`). Consumed by `session-list.tsx` (Task 2) and the test.

- [ ] **Step 1: Write the failing test**

Create `apps/desktop/src/renderer/src/components/service-grid.test.ts`:

```tsx
import { BarChart3, CalendarClock, TrendingUp, Video } from 'lucide-react'
import { describe, expect, it } from 'vitest'

import { SERVICES } from '@/components/service-grid'

describe('ServiceGrid SERVICES', () => {
  it('lists the four services with their routes and labels', () => {
    expect(SERVICES.map((s) => ({ to: s.to, label: s.label }))).toEqual([
      { to: '/scheduled', label: '日历' },
      { to: '/usage', label: '用量统计' },
      { to: '/trending', label: 'GitHub 趋势' },
      { to: '/bilibili', label: 'Bilibili 收藏' },
    ])
  })

  it('each entry has an icon component', () => {
    for (const s of SERVICES) {
      expect(typeof s.icon).toBe('function')
    }
  })

  it('keeps exactly the four known icons in order', () => {
    expect(SERVICES.map((s) => s.icon)).toEqual([CalendarClock, BarChart3, TrendingUp, Video])
  })
})
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd apps/desktop && npx vitest run src/renderer/src/components/service-grid.test.ts`
Expected: FAIL — module `@/components/service-grid` not found.

- [ ] **Step 3: Write minimal implementation**

Create `apps/desktop/src/renderer/src/components/service-grid.tsx`:

```tsx
// 3-column grid of service shortcuts, rendered under the "New chat" button.
// Owns the service list so the sidebar footer can stay minimal (Settings +
// ThemeToggle only). Each cell reuses the footer's icon-button styling.
import { Link } from '@tanstack/react-router'
import { BarChart3, CalendarClock, TrendingUp, Video } from 'lucide-react'

import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip'

const iconBtn =
  'flex size-8 items-center justify-center rounded-md text-muted-foreground transition-colors hover:bg-sidebar-accent hover:text-foreground data-[active=true]:bg-sidebar-accent data-[active=true]:text-foreground [&_svg]:size-4'

export type ServiceEntry = {
  icon: React.ComponentType<{ className?: string }>
  to: string
  label: string
}

// Ordered: calendar first (was 定时任务; the view now also shows calendar
// events, hence the 日历 relabel).
export const SERVICES: ServiceEntry[] = [
  { icon: CalendarClock, to: '/scheduled', label: '日历' },
  { icon: BarChart3, to: '/usage', label: '用量统计' },
  { icon: TrendingUp, to: '/trending', label: 'GitHub 趋势' },
  { icon: Video, to: '/bilibili', label: 'Bilibili 收藏' },
]

export function ServiceGrid(): React.JSX.Element {
  return (
    <div className="grid grid-cols-3 gap-1">
      {SERVICES.map(({ icon: Icon, to, label }) => (
        <Tooltip key={to}>
          <TooltipTrigger
            render={
              <Link
                // biome-ignore lint/suspicious/noExplicitAny: TanStack Router activeProps generic over route tree
                activeProps={{ 'data-active': 'true' } as any}
                className={iconBtn}
                // biome-ignore lint/suspicious/noExplicitAny: `to` widened over Router's typed registry
                to={to as any}
              >
                <Icon />
              </Link>
            }
          />
          <TooltipContent side="top">{label}</TooltipContent>
        </Tooltip>
      ))}
    </div>
  )
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `cd apps/desktop && npx vitest run src/renderer/src/components/service-grid.test.ts`
Expected: PASS (3 tests).

- [ ] **Step 5: Commit**

```bash
git add apps/desktop/src/renderer/src/components/service-grid.tsx apps/desktop/src/renderer/src/components/service-grid.test.ts
git commit -m "feat(renderer): add ServiceGrid component (3-col service shortcuts)"
```

---

### Task 2: Render `<ServiceGrid />` under "New chat" in `SessionList`

**Files:**
- Modify: `apps/desktop/src/renderer/src/components/session-list.tsx` (import + insert after the New chat button, ~line 414)

**Interfaces:**
- Consumes: `<ServiceGrid />` from Task 1.

- [ ] **Step 1: Add the import**

In `apps/desktop/src/renderer/src/components/session-list.tsx`, add to the imports (next to the other `@/components/...` imports):

```tsx
import { ServiceGrid } from '@/components/service-grid'
```

- [ ] **Step 2: Insert `<ServiceGrid />` directly below the "New chat" button**

The current JSX (around line 406-414) is:

```tsx
    <div className="flex h-full flex-col gap-1 px-3 pt-2 pb-2">
      <button
        className="flex h-10 shrink-0 items-center gap-2.5 rounded-xl bg-primary/10 px-4 text-left font-semibold text-primary text-sm transition-all hover:bg-primary/15 active:scale-[0.98]"
        onClick={() => void onNew()}
        type="button"
      >
        <SquarePen className="size-4 shrink-0 stroke-[2.5px]" />
        New chat
      </button>
      <button
```

Insert `<ServiceGrid />` between the closing `</button>` of "New chat" and the Search `<button>`:

```tsx
      <button
        className="flex h-10 shrink-0 items-center gap-2.5 rounded-xl bg-primary/10 px-4 text-left font-semibold text-primary text-sm transition-all hover:bg-primary/15 active:scale-[0.98]"
        onClick={() => void onNew()}
        type="button"
      >
        <SquarePen className="size-4 shrink-0 stroke-[2.5px]" />
        New chat
      </button>
      <ServiceGrid />
      <button
```

- [ ] **Step 3: Typecheck + format**

Run: `cd apps/desktop && npx biome check --write src/renderer/src/components/session-list.tsx`
Run: `cd apps/desktop && npx tsc --noEmit -p tsconfig.json` (or the project's typecheck script)
Expected: no errors.

- [ ] **Step 4: Commit**

```bash
git add apps/desktop/src/renderer/src/components/session-list.tsx
git commit -m "feat(renderer): render ServiceGrid under the New chat button"
```

---

### Task 3: Strip the sidebar footer down to Settings + ThemeToggle

**Files:**
- Modify: `apps/desktop/src/renderer/src/components/app-sidebar.tsx`

**Interfaces:**
- None (consumes nothing new; removes the inline service blocks now in `ServiceGrid`).

- [ ] **Step 1: Replace the file body**

Replace the **entire contents** of `apps/desktop/src/renderer/src/components/app-sidebar.tsx` with:

```tsx
import { Settings } from 'lucide-react'

import { SessionList } from '@/components/session-list'
import { ThemeToggle } from '@/components/theme-toggle'
import { Sidebar, SidebarContent, SidebarFooter } from '@/components/ui/sidebar'
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip'
import { useSettingsDialog } from '@/stores/settings-dialog'

const iconBtn =
  'flex size-8 items-center justify-center rounded-md text-muted-foreground transition-colors hover:bg-sidebar-accent hover:text-foreground data-[active=true]:bg-sidebar-accent data-[active=true]:text-foreground [&_svg]:size-4'

export function AppSidebar(): React.JSX.Element {
  const openSettings = useSettingsDialog((s) => s.openSettings)

  return (
    // floating variant: the sidebar is a rounded, shadowed card with a gap around
    // it (showing the window vibriness) — no hard border line on the chat's left.
    // The card reaches near the top so it wraps the native traffic lights inside
    // its rounded top corner; the inner pt-9 (ui/sidebar.tsx) keeps the session
    // list clear of that top control band. The fixed TopBar — not the card —
    // owns the toggle, so it stays reachable when the sidebar is collapsed.
    <Sidebar variant="floating">
      <SidebarContent>
        <SessionList />
      </SidebarContent>
      <SidebarFooter className="border-sidebar-border border-t">
        <div className="flex items-center gap-1">
          <Tooltip>
            <TooltipTrigger
              render={
                <button className={iconBtn} onClick={() => openSettings()} type="button">
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

This removes the four service `<Tooltip>`/`<Link>` blocks and the now-unused `BarChart3, CalendarClock, TrendingUp, Video` icon imports (kept `Settings`). The `Link` import is gone too (footer no longer uses it).

- [ ] **Step 2: Typecheck + format**

Run: `cd apps/desktop && npx biome check --write src/renderer/src/components/app-sidebar.tsx`
Run typecheck (project script).
Expected: no errors; no unused-import warnings.

- [ ] **Step 3: Commit**

```bash
git add apps/desktop/src/renderer/src/components/app-sidebar.tsx
git commit -m "feat(renderer): reduce sidebar footer to Settings + ThemeToggle"
```

---

### Task 4: Visual verification + final checks

**Files:** none (verification only).

- [ ] **Step 1: Run the full renderer test suite**

Run: `cd apps/desktop && npm test -- src/renderer/src/components/service-grid.test.ts`
Expected: PASS.

- [ ] **Step 2: Build the desktop app (catches type + bundler errors)**

Run: `cd apps/desktop && npm run build` (or the project's build script)
Expected: build succeeds.

- [ ] **Step 3: Launch the app and visually verify**

Use the `run-desktop` skill (or `pnpm dev`) to launch the app. Verify:
1. The sidebar footer (bottom) shows **only** the Settings (gear) icon and the theme toggle.
2. Directly under "New chat" there is a **3-column grid**: 日历 (CalendarClock) · 用量统计 (BarChart3) · GitHub 趋势 (TrendingUp) on row 1, Bilibili 收藏 (Video) on row 2.
3. Hovering each grid cell shows its tooltip; clicking navigates to the right route.
4. The `/scheduled` tooltip now reads **日历** (was 定时任务).
5. The session list below still scrolls correctly (uses `ScrollArea`).

Take a screenshot (run-desktop skill) and confirm the layout.

- [ ] **Step 4: Commit any format-only changes if the build reformatted**

```bash
git status
# if clean, nothing to commit; if biome reformatted, amend or add a chore commit
```

---

## Self-Review

- **Spec coverage:** Spec §5.7 + §8 — services array (Task 1 ✓), 3-col grid under New chat (Task 2 ✓), footer = Settings + ThemeToggle (Task 3 ✓), 定时任务→日历 relabel (Task 1 `SERVICES` label ✓), visual verification (Task 4 ✓).
- **Type consistency:** `ServiceEntry` shape `{ icon, to, label }` used identically in component, test, and consumed by `session-list.tsx`. `iconBtn` string copied verbatim from the original `app-sidebar.tsx`.
- **No placeholders:** all code blocks complete; exact commands given.
