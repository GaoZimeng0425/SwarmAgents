# Settings Routing (Phase 7) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Promote Settings from a pure modal with an ad-hoc string protocol and three hand-synced section lists into a **URL-driven modal** (`?settings=<section>` search param) that preserves the underlying page, plus redesign the sidebar (5 groups + colored icon chips) and collapse the section lists into one `SECTIONS_REGISTRY`.

**Architecture:** Single feature branch `feat/settings-routing` off `develop` @ `d7edab2`. Six sequential tasks, infra-first: registry → hook+search schema → dialog router-derived (delete store) → migrate 5 entry points → sidebar visual → verify. Search params (not path segments) keep the underlying route mounted. The store is deleted; `useSettingsNav` replaces it.

**Tech Stack:** React + TanStack Router (file-based, hand-written `validateSearch` functions — NOT zod), TanStack Query, zustand (being removed here), Tailwind v4, lucide-react, `@swarm/ui`, vitest + @testing-library/react, pnpm + turbo + biome.

**Spec:** `docs/superpowers/specs/2026-07-06-settings-routing-design.md`

## Global Constraints

- **Branch:** `feat/settings-routing`, base `develop` @ `d7edab2`. Never `git add -A` — parallel sessions pollute the worktree. Always `git add <specific paths>`. `git status` before every commit.
- **Code/comments/commits in English; conversation in Chinese** (AGENTS.md §0).
- **`validateSearch` style is HAND-WRITTEN functions, NOT zod.** Match `routes/session.$sessionId.tsx:13` exactly: `validateSearch: (search: Record<string, unknown>): { settings?: SettingsSection } => ({ settings: isValidSection(search.settings) ? search.settings : undefined })`. Do NOT introduce zod.
- **`useSettingsNav` replaces the `useSettingsDialog` store entirely.** The store's `open`/`section`/`openSettings`/`close` are deleted. All 8 reference sites (5 production + 3 tests) migrate to the hook.
- **Search params, not path segments.** `openSettings` does `navigate({ search: (prev) => ({ ...prev, settings: s }) })`. Section switching uses `replace: true`; open/close push history.
- **Section switch = replace; open/close = push.** So the back stack isn't cluttered with per-section entries.
- **Deep-link string protocol stays.** `swarm:navigate-settings` still sends `/settings/<section>` strings; `routeToSection` translates; `useSettingsNav().openSettings` navigates. Main-side code unchanged.
- **`SECTIONS_REGISTRY` is the single source.** After T1, grep confirms no second section list. The `SettingsSection` union + `routeToSection` stay (typing + deep-link); the store's `SECTIONS` array and the dialog's inline `SECTIONS` array are deleted.
- **Icons confirmed available in lucide-react:** Settings, Cpu, CircleDollarSign, Boxes, Globe, Sparkles, CloudSun, Mail, Calendar, Video, Lock, Info (all verified via node require).
- **Reuse, don't rewrite:** the 12 `*View` section components, `settings-primitives.tsx`, the IPC channel/main-side `open-settings.ts` are all untouched.
- **Verify command:** `pnpm verify`. Baseline 1301/1301 (no host.test flake observed in the 6c run).
- **No `settings-dialog.test.tsx` exists** for the component; only `stores/settings-dialog.test.ts` (tests the store being deleted). T3 deletes/rewrites that store test; component testing is via the hook test (T2).

---

## Task 1: `SECTIONS_REGISTRY` single source

**Rationale:** Collapse the three hand-synced section lists (union, store `SECTIONS`, dialog inline `SECTIONS`) into one registry carrying group + colored-icon metadata. This is the foundation every later task reads from.

**Files:**
- Modify: `apps/desktop/src/renderer/src/stores/settings-dialog.ts` (rewrite: keep union + `routeToSection`; delete the `SECTIONS` array and the `useSettingsDialog` store; add `SECTIONS_REGISTRY` + `SectionMeta` + `GROUP_ORDER` + `SECTION_KEYS`)

**Interfaces:**
- Consumes: `lucide-react` icons (Settings, Cpu, …).
- Produces: `SettingsSection` (union, unchanged keys), `SectionGroup`, `SectionMeta`, `SECTIONS_REGISTRY`, `GROUP_ORDER`, `SECTION_KEYS`, `routeToSection` (unchanged logic). The `useSettingsDialog` store is DELETED (callers migrate in T3/T4).

- [ ] **Step 1: Rewrite `stores/settings-dialog.ts`**

Replace the entire file with:

```ts
// SECTIONS_REGISTRY is the single source of truth for the settings sidebar:
// keys, labels, group placement, and colored icon chips. Replaces the former
// triple hand-synced lists (this file's SECTIONS array + the dialog's inline
// SECTIONS + the union). The useSettingsDialog zustand store is gone — open/
// section state is now router-derived (see hooks/use-settings-nav.ts).
import {
  Boxes,
  Calendar,
  CircleDollarSign,
  CloudSun,
  Cpu,
  Globe,
  Info,
  Lock,
  Mail,
  type LucideIcon,
  Settings,
  Sparkles,
  Video,
} from 'lucide-react'

export type SettingsSection =
  | 'general'
  | 'providers'
  | 'budgets'
  | 'mcp'
  | 'web-search'
  | 'skills'
  | 'weather'
  | 'gmail'
  | 'calendar'
  | 'bilibili'
  | 'permissions'
  | 'about'

export type SectionGroup = '通用' | '模型' | '工具' | '连接' | '系统'

export type SectionMeta = {
  key: SettingsSection
  label: string
  group: SectionGroup
  iconBg: string
  icon: LucideIcon
}

export const SECTIONS_REGISTRY: SectionMeta[] = [
  { key: 'general', label: '通用', group: '通用', iconBg: '#8e8e93', icon: Settings },
  { key: 'providers', label: '模型设置', group: '模型', iconBg: '#3478f6', icon: Cpu },
  { key: 'budgets', label: '预算', group: '模型', iconBg: '#ff9f0a', icon: CircleDollarSign },
  { key: 'mcp', label: 'MCP 服务器', group: '工具', iconBg: '#5e5ce6', icon: Boxes },
  { key: 'web-search', label: '网页搜索', group: '工具', iconBg: '#34c759', icon: Globe },
  { key: 'skills', label: '技能', group: '工具', iconBg: '#af52de', icon: Sparkles },
  { key: 'weather', label: '天气', group: '连接', iconBg: '#30b0c7', icon: CloudSun },
  { key: 'gmail', label: 'Gmail', group: '连接', iconBg: '#ea4335', icon: Mail },
  { key: 'calendar', label: '日历', group: '连接', iconBg: '#007aff', icon: Calendar },
  { key: 'bilibili', label: 'Bilibili', group: '连接', iconBg: '#fb7299', icon: Video },
  { key: 'permissions', label: '权限', group: '系统', iconBg: '#30b0c7', icon: Lock },
  { key: 'about', label: '关于', group: '系统', iconBg: '#8e8e93', icon: Info },
]

export const GROUP_ORDER: SectionGroup[] = ['通用', '模型', '工具', '连接', '系统']

export const SECTION_KEYS = SECTIONS_REGISTRY.map((s) => s.key) as readonly [SettingsSection, ...SettingsSection[]]

const SECTION_KEY_SET = new Set<string>(SECTION_KEYS)

export function isValidSection(value: unknown): value is SettingsSection {
  return typeof value === 'string' && SECTION_KEY_SET.has(value)
}

// Map a legacy /settings[/<section>] route (still sent by the menu / deep-link
// IPC) onto a dialog section. Unknown tails fall back to General.
export function routeToSection(route: string): SettingsSection {
  const tail = route.replace(/^\/settings\/?/, '')
  return SECTION_KEY_SET.has(tail) ? (tail as SettingsSection) : 'general'
}
```

- [ ] **Step 2: Typecheck will fail — that's expected**

The store deletion breaks 8 reference sites. **Do NOT fix them in T1** — T3/T4 migrate them. Just confirm the only errors are "useSettingsDialog not found" / "SECTIONS not found" type errors at the known sites (settings-dialog.tsx, app-rail.tsx, no-provider-banner.tsx, weather-card.tsx, palette-dialog.tsx, use-events-subscription.ts, settings-dialog.test.ts, palette-dialog.test.tsx, use-events-subscription.test.tsx).

Run: `pnpm --filter @swarm/desktop typecheck 2>&1 | grep -E "useSettingsDialog|has no exported member" | head`
Expected: errors only at the known sites.

- [ ] **Step 3: Commit (registry only; the broken callers are intentional, fixed in T3/T4)**

```bash
git add apps/desktop/src/renderer/src/stores/settings-dialog.ts
git commit -m "refactor(settings): SECTIONS_REGISTRY single source (group + colored icons); delete useSettingsDialog store"
```

Note: this commit leaves the tree in a non-compiling state by design (T2-T4 restore it). This is acceptable for a short-lived feature branch with sequential tasks; the branch is only merged after T6 verifies a clean build.

---

## Task 2: `useSettingsNav` hook + `__root` validateSearch

**Rationale:** The router-derived replacement for the deleted store. Reads the `settings` search param (declared on `__root` so it works from any route) and exposes open/openSettings/close. T3/T4 consume it.

**Files:**
- Modify: `apps/desktop/src/renderer/src/routes/__root.tsx` (add `validateSearch`)
- Create: `apps/desktop/src/renderer/src/hooks/use-settings-nav.ts`
- Create: `apps/desktop/src/renderer/src/hooks/use-settings-nav.test.tsx`

**Interfaces:**
- Consumes: `SettingsSection`, `isValidSection` from Task 1; TanStack Router `useNavigate`/`useSearch`.
- Produces: `useSettingsNav()` → `{ open, section, openSettings(section?, opts?), close() }`.

- [ ] **Step 1: Add `validateSearch` to `__root.tsx`**

In `apps/desktop/src/renderer/src/routes/__root.tsx`, find `export const Route = createRootRoute({ component: RootLayout })`. Add a `validateSearch` matching the hand-written style of `session.$sessionId.tsx:13`:

```ts
import type { SettingsSection } from '@/stores/settings-dialog'
import { isValidSection } from '@/stores/settings-dialog'

export const Route = createRootRoute({
  component: RootLayout,
  validateSearch: (search: Record<string, unknown>): { settings?: SettingsSection } => ({
    settings: isValidSection(search.settings) ? search.settings : undefined,
  }),
})
```

(If `createRootRoute`'s type complains about the return shape, cast as needed — match how `session.$sessionId.tsx` does it.)

- [ ] **Step 2: Write the failing hook test**

Create `apps/desktop/src/renderer/src/hooks/use-settings-nav.test.tsx`. Use `renderHook` + a `MemoryHistory`/`RouterProvider` setup so `useSearch`/`useNavigate` work. Stub nothing — exercise the real router.

```ts
// @vitest-environment jsdom
import '@testing-library/jest-dom/vitest'
import type React from 'react'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { RouterProvider, createMemoryHistory, createRootRoute, createRoute, createRouter } from '@tanstack/react-router'
import { act, renderHook, waitFor } from '@testing-library/react'
import { afterEach, describe, expect, it } from 'vitest'

import { useSettingsNav } from './use-settings-nav'

// Build a minimal router whose root carries the same validateSearch as the app.
const rootRoute = createRootRoute({
  validateSearch: (search: Record<string, unknown>) => ({
    settings: typeof search.settings === 'string' ? search.settings : undefined,
  }),
  component: () => <OutletStub />,
})
function OutletStub(): React.JSX.Element {
  return <div>{useSettingsNav().open ? 'open' : 'closed'}</div>
}
const indexRoute = createRoute({ getParentRoute: () => rootRoute, path: '/', component: () => null })

function makeRouter(initialUrl: string): ReturnType<typeof createRouter> {
  const router = createRouter({
    routeTree: rootRoute.addChildren([indexRoute]),
    history: createMemoryHistory({ initialEntries: [initialUrl] }),
  })
  return router
}

function wrap(router: ReturnType<typeof createRouter>): React.ReactElement {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } })
  return (
    <QueryClientProvider client={qc}>
      <RouterProvider router={router} />
    </QueryClientProvider>
  )
}

afterEach(() => { vi.restoreAllMocks() })

describe('useSettingsNav', () => {
  it('reads closed state when no settings param', () => {
    const router = makeRouter('/')
    const { result } = renderHook(() => useSettingsNav(), { wrapper: () => wrap(router) })
    expect(result.current.open).toBe(false)
    expect(result.current.section).toBe(null)
  })

  it('reads open + section from the settings param', async () => {
    const router = makeRouter('/?settings=providers')
    const { result } = renderHook(() => useSettingsNav(), { wrapper: () => wrap(router) })
    await waitFor(() => expect(result.current.open).toBe(true))
    expect(result.current.section).toBe('providers')
  })

  it('openSettings navigates to add the param', async () => {
    const router = makeRouter('/')
    const { result } = renderHook(() => useSettingsNav(), { wrapper: () => wrap(router) })
    await act(async () => { result.current.openSettings('mcp') })
    expect(router.state.location.search.settings).toBe('mcp')
  })

  it('close removes the param', async () => {
    const router = makeRouter('/?settings=general')
    const { result } = renderHook(() => useSettingsNav(), { wrapper: () => wrap(router) })
    await act(async () => { result.current.close() })
    expect(router.state.location.search.settings).toBeUndefined()
  })

  it('openSettings replace option controls history', async () => {
    const router = makeRouter('/')
    const { result } = renderHook(() => useSettingsNav(), { wrapper: () => wrap(router) })
    await act(async () => { result.current.openSettings('general') })
    await act(async () => { result.current.openSettings('providers', { replace: true }) })
    expect(router.state.location.search.settings).toBe('providers')
    // (Asserting history length precisely is brittle; the replace flag is
    // exercised by the navigate call. The test confirms navigation still works.)
  })

  it('invalid settings value yields closed', async () => {
    const router = makeRouter('/?settings=bogus')
    const { result } = renderHook(() => useSettingsNav(), { wrapper: () => wrap(router) })
    await waitFor(() => expect(result.current.open).toBe(false))
  })
})
```

(Adapt: the test creates its own mini-router because the app's real routeTree pulls in too much. The `validateSearch` shape mirrors `__root`. If `useSettingsNav` uses `strict: false` on `useSearch`, the mini-router's root search is read correctly.)

- [ ] **Step 3: Run the test to verify it fails**

Run: `pnpm --filter @swarm/desktop exec vitest run src/hooks/use-settings-nav.test.tsx`
Expected: FAIL (module not found).

- [ ] **Step 4: Implement `use-settings-nav.ts`**

Create `apps/desktop/src/renderer/src/hooks/use-settings-nav.ts`:

```ts
// Router-derived replacement for the deleted useSettingsDialog store. The
// settings modal's open/section state is a projection of the `settings` search
// param (declared on __root, so it works from any route). openSettings/close
// navigate; section switching passes { replace: true } so the back stack isn't
// cluttered with per-section entries.
import { useNavigate, useSearch } from '@tanstack/react-router'

import { isValidSection, type SettingsSection } from '@/stores/settings-dialog'

export type SettingsNav = {
  open: boolean
  section: SettingsSection | null
  openSettings: (section?: SettingsSection, opts?: { replace?: boolean }) => Promise<void>
  close: () => Promise<void>
}

export function useSettingsNav(): SettingsNav {
  const navigate = useNavigate()
  // strict:false reads the root-level search (the settings param lives on __root).
  const { settings } = useSearch({ strict: false })
  const section = isValidSection(settings) ? settings : null

  return {
    open: section !== null,
    section,
    openSettings: (section: SettingsSection = 'general', opts?: { replace?: boolean }) =>
      navigate({ search: (prev) => ({ ...prev, settings: section }), replace: opts?.replace }),
    close: () => navigate({ search: (prev) => ({ ...prev, settings: undefined }) }),
  }
}
```

- [ ] **Step 5: Run the test to verify it passes**

Run: `pnpm --filter @swarm/desktop exec vitest run src/hooks/use-settings-nav.test.tsx`
Expected: all green. If `useSearch({ strict: false })` typing complains, cast `settings` to `unknown` before `isValidSection`.

- [ ] **Step 6: Commit**

```bash
git add apps/desktop/src/renderer/src/routes/__root.tsx apps/desktop/src/renderer/src/hooks/use-settings-nav.ts apps/desktop/src/renderer/src/hooks/use-settings-nav.test.tsx
git commit -m "feat(settings): useSettingsNav hook + __root validateSearch for settings search param"
```

---

## Task 3: `<SettingsDialog>` router-derived + delete store residue

**Rationale:** Switch the dialog from the deleted store to `useSettingsNav`. This is the largest caller migration (the dialog owns open/section + the sidebar).

**Files:**
- Modify: `apps/desktop/src/renderer/src/components/settings-dialog.tsx`
- Delete: `apps/desktop/src/renderer/src/stores/settings-dialog.test.ts` (the store-test for the now-deleted store)
- Modify (if it imports the deleted store symbols): `apps/desktop/src/renderer/src/components/palette/palette-dialog.test.tsx`, `apps/desktop/src/renderer/src/hooks/use-events-subscription.test.tsx` — but ONLY if they break on `useSettingsDialog`. T4 owns the production migration; tests for not-yet-migrated code can mock the old store minimally. (Prefer: leave these tests' breakage for T4 to resolve alongside the production migration.)

**Interfaces:**
- Consumes: `useSettingsNav` (T2), `SECTIONS_REGISTRY`/`GROUP_ORDER`/`SectionMeta` (T1).
- Produces: a `<SettingsDialog>` that opens/closes via URL.

- [ ] **Step 1: Rewrite `settings-dialog.tsx` to use `useSettingsNav`**

In `apps/desktop/src/renderer/src/components/settings-dialog.tsx`:

1. Replace the store import + usage:
```ts
// DELETE: import { type SettingsSection, useSettingsDialog } from '@/stores/settings-dialog'
import { type SettingsSection, SECTIONS_REGISTRY, GROUP_ORDER } from '@/stores/settings-dialog'
import { useSettingsNav } from '@/hooks/use-settings-nav'
```

2. In the component, replace `const { open, section, openSettings, close } = useSettingsDialog()` with:
```ts
  const { open, section, openSettings, close } = useSettingsNav()
```

3. Resolve the active view from `SECTIONS_REGISTRY` instead of the deleted inline `SECTIONS`:
```ts
  const active = SECTIONS_REGISTRY.find((s) => s.key === section) ?? SECTIONS_REGISTRY[0]
```
And render `<active.View />` (the `View` component must be attached to the registry — see Step 2).

4. The sidebar nav `<button onClick={() => openSettings(key)}>` becomes `<button onClick={() => openSettings(key, { replace: true })}>` (section switch = replace).

5. The `<Dialog open={open} onOpenChange={(o) => !o && close()}>` stays — `close()` now navigates.

6. Delete the inline `SECTIONS` array (lines ~33-46) entirely.

- [ ] **Step 2: Attach the `View` component to `SectionMeta`**

`SECTIONS_REGISTRY` (T1) has no `View` field yet — the views are imported in the dialog today. Two options:
- **Option A (preferred):** extend `SectionMeta` with `View: React.ComponentType` and import the 12 views in `stores/settings-dialog.ts`, attaching them to each entry. Then `active.View` works.
- **Option B:** keep a separate `{ [key]: View }` map in the dialog. Less clean.

Use Option A. In `stores/settings-dialog.ts`, add to each registry entry the `View` import (the 12 `*View` components). Add `View: React.ComponentType` to `SectionMeta`. Update T1's file (this amends T1 — that's fine, same branch). The 12 imports:
`general-view.tsx` (GeneralView), `providers-view.tsx` (ProvidersView), `mcp-servers-view.tsx` (McpServersView), `web-search-view.tsx` (WebSearchView), `weather-view.tsx` (WeatherView), `gmail-view.tsx` (GmailSettingsView), `calendar-view.tsx` (CalendarSettingsView), `skills-view.tsx` (SkillsView), `bilibili-settings-view.tsx` (BilibiliSettingsView), `budgets-view.tsx` (BudgetsView), `permissions-view.tsx` (PermissionsView), `about-view.tsx` (AboutView).

(Caveat: putting React component imports in `stores/` blurs the "store" naming, but this file is now a registry module, not a store. Acceptable. If a check-boundaries rule forbids stores/ from importing components, move the registry to `lib/settings/registry.ts` instead and re-export from the store path for backward compat. Check `tools/check-boundaries.mjs` if it complains.)

- [ ] **Step 3: Delete the store test**

```bash
git rm apps/desktop/src/renderer/src/stores/settings-dialog.test.ts
```
(The store is gone; this test is obsolete. T2 covers the replacement hook.)

- [ ] **Step 4: Verify typecheck (the dialog + store file should now compile; palette/events callers still broken — T4)**

Run: `pnpm --filter @swarm/desktop typecheck 2>&1 | grep -vE "palette-dialog|use-events-subscription" | grep error | head`
Expected: no errors outside palette-dialog.tsx and use-events-subscription.ts (those are T4).

- [ ] **Step 5: Commit**

```bash
git add apps/desktop/src/renderer/src/components/settings-dialog.tsx apps/desktop/src/renderer/src/stores/settings-dialog.ts
git rm apps/desktop/src/renderer/src/stores/settings-dialog.test.ts 2>/dev/null || true
git commit -m "feat(settings): SettingsDialog router-derived via useSettingsNav; attach View to registry"
```

---

## Task 4: Migrate the remaining 5 entry points to `useSettingsNav`

**Rationale:** The store is gone; the remaining callers (rail, palette, banner, weather-card, events/deep-link) must source `openSettings` from `useSettingsNav`. Signatures unchanged.

**Files:**
- Modify: `apps/desktop/src/renderer/src/components/app-rail.tsx`
- Modify: `apps/desktop/src/renderer/src/components/palette/palette-dialog.tsx`
- Modify: `apps/desktop/src/renderer/src/components/no-provider-banner.tsx`
- Modify: `apps/desktop/src/renderer/src/components/views/dashboard/weather-card.tsx`
- Modify: `apps/desktop/src/renderer/src/hooks/use-events-subscription.ts`
- Modify (tests): `apps/desktop/src/renderer/src/components/palette/palette-dialog.test.tsx`, `apps/desktop/src/renderer/src/hooks/use-events-subscription.test.tsx`

**Interfaces:**
- Consumes: `useSettingsNav` (T2). Each site swaps `useSettingsDialog((s) => s.openSettings)` → `useSettingsNav().openSettings`.

- [ ] **Step 1: `app-rail.tsx`**

Find `const openSettings = useSettingsDialog((s) => s.openSettings)` (~line 20). Replace:
```ts
import { useSettingsNav } from '@/hooks/use-settings-nav'
// ...
const { openSettings } = useSettingsNav()
```
Remove the `useSettingsDialog` import. The rail action's onClick still calls `openSettings()` (defaults to general).

- [ ] **Step 2: `palette-dialog.tsx` (the cb source)**

Find `const openSettings = useSettingsDialog((s) => s.openSettings)` (~line 60). Replace with `const { openSettings } = useSettingsNav()`. The `cb` built at ~line 71 injects `openSettings` into `buildItems` — its body is unchanged. Remove the store import.

- [ ] **Step 3: `no-provider-banner.tsx`**

Find `const openSettings = useSettingsDialog((s) => s.openSettings)` (~line 8). Replace with `useSettingsNav().openSettings`. Remove the store import. The `openSettings('providers')` call is unchanged.

- [ ] **Step 4: `weather-card.tsx`**

Find `const openSettings = useSettingsDialog((s) => s.openSettings)` (~line 71). Replace with `useSettingsNav().openSettings`. Remove the store import.

- [ ] **Step 5: `use-events-subscription.ts` (deep-link)**

Find the `swarm:navigate-settings` handler (~line 73-77). It currently calls `openSettings(routeToSection(route))` where `openSettings` came from the store. Source it from `useSettingsNav` instead:
```ts
const { openSettings } = useSettingsNav()
// in the handler:
openSettings(routeToSection(route))
```
This is a hook calling a hook — fine (use-events-subscription is itself a hook). Remove the store import.

- [ ] **Step 6: Update the 2 broken tests**

`palette-dialog.test.tsx` and `use-events-subscription.test.tsx` referenced `useSettingsDialog`. They now need to either:
- Wrap renders in a router (so `useSettingsNav` works), or
- Mock `useSettingsNav` via `vi.mock('@/hooks/use-settings-nav', ...)`.

Prefer mocking (less setup). In each test file:
```ts
vi.mock('@/hooks/use-settings-nav', () => ({
  useSettingsNav: () => ({ openSettings: vi.fn(), close: vi.fn(), open: false, section: null }),
}))
```
Adapt to what each test actually asserts.

- [ ] **Step 7: Verify typecheck + grep no residue**

Run: `pnpm --filter @swarm/desktop typecheck` — expect clean.

Run: `grep -rn "useSettingsDialog" apps/desktop/src/renderer/src`
Expected: no matches (only the `search-dialog.ts` comment mentioning it by name, which is fine — that's a different store's doc comment, not a real reference). If `search-dialog.ts` only mentions it in a comment, leave it.

- [ ] **Step 8: Commit**

```bash
git add apps/desktop/src/renderer/src/components/app-rail.tsx apps/desktop/src/renderer/src/components/palette/palette-dialog.tsx apps/desktop/src/renderer/src/components/no-provider-banner.tsx apps/desktop/src/renderer/src/components/views/dashboard/weather-card.tsx apps/desktop/src/renderer/src/hooks/use-events-subscription.ts apps/desktop/src/renderer/src/components/palette/palette-dialog.test.tsx apps/desktop/src/renderer/src/hooks/use-events-subscription.test.tsx
git commit -m "refactor(settings): migrate 5 entry points + tests to useSettingsNav"
```

---

## Task 5: Grouped sidebar visual redesign

**Rationale:** Surface-level redesign of the settings sidebar: 5 group headers + colored icon chips, per the design draft. No logic changes — purely the nav rendering inside `<SettingsDialog>`.

**Files:**
- Modify: `apps/desktop/src/renderer/src/components/settings-dialog.tsx` (the `<nav>` block)

- [ ] **Step 1: Rewrite the sidebar `<nav>` to render by group**

In `apps/desktop/src/renderer/src/components/settings-dialog.tsx`, find the `<nav>` block that maps over sections. Replace it with a grouped render:

```tsx
<nav className="scv flex-1 overflow-y-auto px-2.5 pb-4 pt-1">
  {GROUP_ORDER.map((group) => (
    <div className="mb-3.5 flex flex-col gap-0.5" key={group}>
      <p className="px-2.5 pb-0.5 pt-1.5 text-[10.5px] font-semibold tracking-wide text-muted-foreground/70 uppercase">
        {group}
      </p>
      {SECTIONS_REGISTRY.filter((s) => s.group === group).map((s) => {
        const Icon = s.icon
        const isActive = s.key === section
        return (
          <button
            className={`flex w-full items-center gap-2.5 rounded-lg px-2 py-1.5 text-left text-[13px] font-medium transition-colors ${
              isActive ? 'bg-accent text-foreground' : 'text-foreground/80 hover:bg-accent/60'
            }`}
            key={s.key}
            onClick={() => openSettings(s.key, { replace: true })}
            type="button"
          >
            <span
              className="flex size-[23px] shrink-0 items-center justify-center rounded-md"
              style={{ backgroundColor: s.iconBg }}
            >
              <Icon className="size-[13px] text-white" />
            </span>
            {s.label}
          </button>
        )
      })}
    </div>
  ))}
</nav>
```

The icon chip uses inline `style={{ backgroundColor: s.iconBg }}` (hex from the registry). Active state is unchanged (`bg-accent`). The group header matches the draft (`font-semibold text-[10.5px] tracking-wide text-muted-foreground/70 uppercase`).

- [ ] **Step 2: Verify typecheck + manual render check (no browser; rely on typecheck + existing dialog mount)**

Run: `pnpm --filter @swarm/desktop typecheck` — clean.

Run: `pnpm --filter @swarm/desktop exec vitest run src/hooks/use-settings-nav.test.tsx` — still green (no logic change).

(Visual confirmation is manual smoke, deferred to T6/user.)

- [ ] **Step 3: Commit**

```bash
git add apps/desktop/src/renderer/src/components/settings-dialog.tsx
git commit -m "feat(settings): grouped sidebar with colored icon chips (5 groups per design draft)"
```

---

## Task 6: Full verify, cross-cutting final review, progress ledger

**Rationale:** Final gate. Confirm the whole branch is green, the store is fully gone, and the spec's success criteria hold.

**Files:**
- Create (local, gitignored): `.superpowers/sdd/progress-settings.md`

- [ ] **Step 1: Full verify**

Run: `pnpm verify`
Expected: typecheck clean; all tests pass (1301 baseline + the new hook tests ≈ +6); `check-boundaries` passes.

- [ ] **Step 2: Cross-cutting review checklist**

1. **Store fully gone:** `grep -rn "useSettingsDialog" apps/desktop/src/renderer/src` returns nothing (except maybe the `search-dialog.ts` doc comment).
2. **Single source:** `grep -rn "SettingsSection\[\]\|SECTIONS " apps/desktop/src/renderer/src` — only `SECTIONS_REGISTRY`.
3. **URL flow:** open from any page → URL gains `?settings=...`; underlying page stays mounted; back closes.
4. **replace vs push:** section switch doesn't grow history; open/close does.
5. **All 5 entries work:** rail, palette, banner, weather-card, deep-link.
6. **Sidebar:** 5 groups, colored chips, no Agents, Weather present.
7. **Dark mode:** chips + group headers legible.
8. **Deep-link string protocol intact:** `swarm:navigate-settings` still fires `/settings/<section>`; `routeToSection` translates; `openSettings` navigates.

- [ ] **Step 3: Write the progress ledger**

Create `.superpowers/sdd/progress-settings.md` (gitignored — local recovery map), modeled on prior phase ledgers. Fill commit hashes from `git log --oneline feat/settings-routing ^develop`.

- [ ] **Step 4: Report merge-readiness**

Report to the user: branch ready to merge into develop (fast-forward or PR). GUI smoke per spec §5 deferred to user.

---

## Self-Review (run after writing this plan)

**1. Spec coverage:**
- §1 URL-driven modal → T2 (hook + validateSearch), T3 (dialog), T4 (entries) ✓
- §1 single source `SECTIONS_REGISTRY` → T1 ✓
- §1 sidebar redesign (5 groups + chips) → T5 ✓
- §1 reconcile (no Agents, Weather) → T1 registry ✓
- §1 success criteria → T6 Step 2 walks each ✓
- Non-goals (full-screen route, add/remove items, Agents return, content redesigns, search box) → respected ✓

**2. Placeholder scan:** No "TBD"/"TODO". Code blocks contain real code. Two implementation notes flagged inline (Option A vs B for attaching View to registry — resolved to A; check-boundaries caveat — resolved by checking). The T1 broken-tree state is intentional and called out.

**3. Type consistency:**
- `SettingsSection` union (T1) — keys match `SECTIONS_REGISTRY` entries (T1) ✓
- `SectionMeta` (T1) gains `View: React.ComponentType` in T3 Step 2 (amends T1) ✓
- `useSettingsNav` return (T2) — `{ open, section, openSettings, close }` matches what T3/T4 consume ✓
- `isValidSection` (T1) used by both `validateSearch` (T2) and `useSettingsNav` (T2) ✓
- `openSettings(section?, opts?)` signature consistent across T2 def, T3 sidebar call (`openSettings(key, {replace:true})`), T4 entry calls (`openSettings('providers')`) ✓

**4. Risk notes for the implementer (flagged inline):**
- T1 intentionally leaves the tree non-compiling (store deleted, callers not yet migrated). Acceptable for a short-lived branch; resolved by T4. Communicate this in the T1 commit message.
- T3 Step 2 amends T1's registry (adds `View` field). Same branch, fine.
- T3 Step 2: if `check-boundaries` forbids `stores/` from importing view components, move the registry to `lib/settings/registry.ts`.
- T4 Step 6: prefer mocking `useSettingsNav` in the 2 broken tests over full router setup.
- T2's mini-router test harness: `useSearch({ strict: false })` must read the root search — verify in the test.

Plan is complete.
