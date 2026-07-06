# Settings Routing (Phase 7) Design

**Date:** 2026-07-06
**Scope:** Phase 7 of the desktop UI redesign — promote Settings from a pure
modal with an ad-hoc string protocol and three hand-synced section lists into a
**URL-driven modal** (`?settings=<section>` search param) so opening settings
shares/bookmarks/deep-links cleanly, **while preserving the current "overlay the
current page" UX** (the underlying route does not unmount). Also redesigns the
settings sidebar per the design draft (5 grouped sections + colored icon chips),
reconciles the stale draft (drops Agents, adds Weather), and collapses the three
section lists into one `SECTIONS_REGISTRY` source of truth.
**Branch:** `feat/settings-routing` (off `develop` @ `d7edab2`).
**Depends on:** Phase 1 (rail/shell), Phase 5 (Agents removal). The Settings
modal, the 12 section views, and all entry points (rail, palette, banner,
weather-card, deep-link) exist today.
**Out of scope:** making settings a full-screen route page (it stays a modal
overlay); adding/removing setting items; putting Agents back; redesigning any
section view's content; the sidebar search box (follow-up).

---

## 1. Goal & Scope

Turn Settings into a URL-driven modal whose open/section state derives from the
router, not an independent store — while keeping the "overlay, don't unmount"
behavior users expect from a quick settings toggle.

- **URL-driven modal (search params):** opening settings navigates the current
  route to add a `?settings=<section>` search param; the modal renders from that
  param. The underlying page stays mounted (state preserved). Browser back
  removes the param → modal closes.
- **Single source of truth:** replace the three hand-synced lists
  (`SettingsSection` union, store `SECTIONS`, dialog `SECTIONS`) with one
  `SECTIONS_REGISTRY` carrying group + colored-icon metadata.
- **Sidebar redesign:** 5 grouped sections (通用 / 模型 / 工具 / 连接 / 系统) with
  colored icon chips, per the design draft.
- **Reconcile with reality:** no Agents (it lives at `/formations`), Weather
  included.

### Non-goals (explicitly deferred)

- **Full-screen `/settings/<section>` path-segment route.** Considered and
  rejected: it unmounts the underlying page (loses unsaved state), violating the
  modal's core promise. Search params keep the page mounted.
- **Adding/removing settings.** Only the shell, routing, and sidebar change.
- **Agents return.** Phase 5's removal stands; Agents stays at `/formations`.
- **Section view content redesigns.** The 12 `*View` components are untouched.
- **Sidebar search box.** The draft draws one; deferred (YAGNI for now).

### Confirmed deviations from the design draft

1. **5 sidebar groups** (通用/模型/工具/连接/系统) vs the draft's 4 (the draft
   merges tools + connected services under "服务"). Splitting them is clearer.
2. **No Agents entry** (draft shows it; Phase 5 moved it).
3. **Weather entry added** (draft predates Phase 6).
4. **URL form is `/<current>?settings=<section>`**, not `/settings/<section>`.
   Trade-off: bookmarks carry the current page path, but the underlying page
   stays mounted — the whole point.

### Success criteria

- Clicking rail 设置 (or any entry) navigates to `/<current>?settings=general`;
  the modal opens; the underlying page does NOT unmount (its state survives).
- Browser back closes the modal (URL returns to `/<current>`); forward reopens.
- Switching sidebar sections updates the `settings` search param with
  `replace: true` (history stack does NOT grow per-section).
- Esc / backdrop dismiss removes the search param.
- Sidebar shows 5 group headers + colored icon chips; no Agents; Weather present.
- All 5 entry points (rail, palette, no-provider-banner, weather-card, deep-link)
  open to the correct section.
- `SECTIONS_REGISTRY` is the single source (grep confirms no second section
  list); the store's `open`/`section`/`openSettings`/`close` are gone (replaced
  by the router-derived hook).
- Existing settings tests updated and green; typecheck clean; check-boundaries
  passes.

---

## 2. Design Decisions (locked from brainstorm)

| Decision | Choice | Rationale |
|---|---|---|
| Routing model | URL-driven modal via **search params** (`?settings=<section>`) | Keeps underlying page mounted (state preserved); browser back closes; standard modal-as-route pattern. Path-segment routes unmount the page. |
| State ownership | Router search param is the single source; store deleted | Eliminates dual source of truth between store + URL. |
| Section list | Single `SECTIONS_REGISTRY` with group + icon metadata | Replaces 3 hand-synced lists; drives sidebar, typing, and the `routeToSection` validator. |
| Sidebar grouping | 5 groups (通用/模型/工具/连接/系统) | Clearer than draft's 4; splits tools from connected services. |
| History behavior | Open/close push history; section switch uses `replace: true` | Open/close is a meaningful navigation; per-section switching shouldn't clutter the back stack. |
| Deep-link protocol | Keep main→renderer `/settings/<section>` string IPC; renderer translates via `routeToSection` → navigate | Main can't use the router; string protocol stays, only its endpoint changes (store action → navigate). |
| Search box | Not this phase (follow-up) | YAGNI. |
| Implementation slicing | Single branch, 6 sequential tasks, infra-first | Matches Phase 5/6 rhythm; registry + hook stabilize before the migration. |

---

## 3. Specification

### 3.1 `SECTIONS_REGISTRY` — single source (replaces 3 lists)

`stores/settings-dialog.ts` is rewritten. The `SettingsSection` union stays
(as the key type). The store is deleted. In its place:

```ts
export type SettingsSection =
  | 'general' | 'providers' | 'budgets' | 'mcp' | 'web-search' | 'skills'
  | 'weather' | 'gmail' | 'calendar' | 'bilibili' | 'permissions' | 'about'

export type SectionGroup = '通用' | '模型' | '工具' | '连接' | '系统'

export type SectionMeta = {
  key: SettingsSection
  label: string
  group: SectionGroup
  iconBg: string      // hex color for the icon chip, e.g. '#3478f6'
  icon: LucideIcon    // lucide-react icon component
}

export const SECTIONS_REGISTRY: SectionMeta[] = [ /* 12 entries, see §3.2 */ ]
export const GROUP_ORDER: SectionGroup[] = ['通用', '模型', '工具', '连接', '系统']

export function routeToSection(route: string): SettingsSection { /* unchanged */ }
```

The `useSettingsDialog` zustand store (`open`/`section`/`openSettings`/`close`)
is **deleted**. Callers use `useSettingsNav()` (§3.3).

### 3.2 Section metadata (12 entries, 5 groups)

| group | key | label | iconBg | icon (lucide) |
|---|---|---|---|---|
| 通用 | general | 通用 | #8e8e93 | Settings |
| 模型 | providers | 模型设置 | #3478f6 | Cpu |
| 模型 | budgets | 预算 | #ff9f0a | CircleDollarSign |
| 工具 | mcp | MCP 服务器 | #5e5ce6 | Boxes |
| 工具 | web-search | 网页搜索 | #34c759 | Globe |
| 工具 | skills | 技能 | #af52de | Sparkles |
| 连接 | weather | 天气 | #30b0c7 | CloudSun |
| 连接 | gmail | Gmail | #ea4335 | Mail |
| 连接 | calendar | 日历 | #007aff | Calendar |
| 连接 | bilibili | Bilibili | #fb7299 | Video |
| 系统 | permissions | 权限 | #30b0c7 | Lock |
| 系统 | about | 关于 | #8e8e93 | Info |

(Icon names indicative — confirm exact lucide exports during implementation.)

### 3.3 Router search schema + `useSettingsNav` hook

**`routes/__root.tsx`** declares the search schema (root search is inherited by
all child routes, so the modal works from any page):

```ts
import { z } from 'zod'  // or the project's chosen validator; match existing routes

export const Route = createRootRoute({
  component: RootLayout,
  validateSearch: z.object({
    settings: z.enum(SECTION_KEYS).optional(),
  }),
  // SECTION_KEYS = SECTIONS_REGISTRY.map(s => s.key) as [SettingsSection, ...SettingsSection[]]
})
```

If the project doesn't already use zod in routes, use TanStack's plain-object
`validateSearch` form. Match whatever the existing routes use.

**`hooks/use-settings-nav.ts`** — the single replacement for the deleted store:

```ts
export function useSettingsNav() {
  const navigate = useNavigate()
  const { settings } = useSearch({ strict: false })  // root search
  const section = isValidSection(settings) ? (settings as SettingsSection) : null
  return {
    open: section !== null,
    section,
    openSettings: (s: SettingsSection = 'general', opts?: { replace?: boolean }) =>
      navigate({ search: (prev) => ({ ...prev, settings: s }), replace: opts?.replace }),
    close: () => navigate({ search: (prev) => ({ ...prev, settings: undefined }) }),
  }
}
```

`isValidSection` checks membership against `SECTIONS_REGISTRY` (handles
bad/manual URLs gracefully → null).

### 3.4 `<SettingsDialog>` — router-derived + grouped sidebar

- `open`/`section` come from `useSettingsNav()` (not the deleted store).
- `onOpenChange(false)` → `close()`.
- Sidebar `<nav>` renders `GROUP_ORDER.map(group => group's sections)`:
  - group header: `通用`/`模型`/..., small uppercase muted (draft:
    `font:600 10.5px tracking-wide text-muted-foreground`).
  - per-section button: a 23×23 rounded icon chip
    (`style={{ background: meta.iconBg }}` + white icon) + label; active =
    `bg-accent text-foreground` (unchanged).
  - onClick → `openSettings(key, { replace: true })` (section switch, no stack growth).
- The right panel's `<ActiveView>` resolves from `SECTIONS_REGISTRY.find(...)`.
- The dialog component itself (overlay/backdrop/Esc) is unchanged — only its
  open/section source changes.

### 3.5 Entry-point migration (5 call sites; signatures unchanged)

All call sites still call `openSettings(section?)`. The difference is the
function's source: the deleted store's action → `useSettingsNav().openSettings`.

| Call site | Change |
|---|---|
| `components/app-rail.tsx` (设置 action) | `const { openSettings } = useSettingsNav()` |
| `lib/palette/build-items.ts` (cb.openSettings) | the `cb` is injected from the caller; that caller now sources `openSettings` from `useSettingsNav` (signatures unchanged) |
| `components/no-provider-banner.tsx` | `openSettings('providers')` from `useSettingsNav` |
| `components/views/dashboard/weather-card.tsx` | `openSettings('weather')` from `useSettingsNav` |
| `hooks/use-events-subscription.ts` (deep-link) | on `swarm:navigate-settings`: `openSettings(routeToSection(route))` from `useSettingsNav` (the IPC string protocol stays) |

**Palette `cb` wiring note:** `build-items.ts` receives `cb` with an
`openSettings` method. The caller that builds `cb` (likely `palette-dialog.tsx`)
must source `openSettings` from `useSettingsNav` instead of the store. The
`build-items.ts` code itself is unchanged (it just calls `cb.openSettings`).

---

## 4. Architecture

### 4.1 File structure

**Modified:**
- `apps/desktop/src/renderer/src/stores/settings-dialog.ts` — rewrite: drop store,
  add `SECTIONS_REGISTRY` + `SectionMeta` + `GROUP_ORDER`; keep `SettingsSection`
  + `routeToSection`.
- `apps/desktop/src/renderer/src/routes/__root.tsx` — add `validateSearch` for
  the `settings` param.
- `apps/desktop/src/renderer/src/components/settings-dialog.tsx` —
  `useSettingsNav` instead of store; grouped sidebar; `SECTIONS_REGISTRY`.
- `apps/desktop/src/renderer/src/components/app-rail.tsx` — `useSettingsNav`.
- `apps/desktop/src/renderer/src/lib/palette/build-items.ts` — (maybe unchanged;
  depends on cb wiring) — see §3.5.
- `apps/desktop/src/renderer/src/components/palette/palette-dialog.tsx` — source
  `openSettings` from `useSettingsNav` into the `cb`.
- `apps/desktop/src/renderer/src/components/no-provider-banner.tsx` — `useSettingsNav`.
- `apps/desktop/src/renderer/src/components/views/dashboard/weather-card.tsx` — `useSettingsNav`.
- `apps/desktop/src/renderer/src/hooks/use-events-subscription.ts` — `useSettingsNav`
  for deep-link handling.
- `apps/desktop/src/renderer/src/components/settings-dialog.test.tsx` — update
  (mock router / inject hook).

**New:**
- `apps/desktop/src/renderer/src/hooks/use-settings-nav.ts`
- `apps/desktop/src/renderer/src/hooks/use-settings-nav.test.tsx`

**Deleted (from the store, after migration):**
- the `useSettingsDialog` store object and its `open`/`section`/`openSettings`/`close`.

**Kept (unchanged):**
- All 12 section view components (`general-view.tsx`, …, `about-view.tsx`).
- `settings-primitives.tsx` (shared header/Section components).
- The `swarm:navigate-settings` IPC channel + `open-settings.ts` main-side code
  (it still sends `/settings/<section>` strings; the renderer translates).

### 4.2 Data flow (after)

```
any route (e.g. /gmail)
  └─ user clicks 设置 (rail) → useSettingsNav().openSettings('general')
     └─ navigate({ search: prev => ({...prev, settings:'general'}) })
        └─ URL: /gmail?settings=general
           ├─ <Outlet/> still renders /gmail (unmounted? NO — same route, search changed)
           └─ <SettingsDialog> (in __root)
               └─ useSettingsNav() reads settings='general' → open=true, section='general'
               └─ sidebar openSettings(key, {replace:true}) → navigate updates param
               └─ Esc/backdrop/onOpenChange(false) → close() → navigate removes param
```

---

## 5. Risks & Verification

| Risk | Mitigation |
|---|---|
| Search param not available on all routes. | Declare `validateSearch` on `__root` (root search inherits to all children). Verify by opening settings from each major route. |
| Bad manual URL (`?settings=foo`). | `useSettingsNav` validates against `SECTIONS_REGISTRY`; invalid → null → modal stays closed (no crash). |
| Removing the store breaks existing tests. | `settings-dialog.test.tsx` updates to mock the router or inject the hook's return. Grep for `useSettingsDialog` references and remove all. |
| Palette `cb.openSettings` wiring. | The `cb` is built in `palette-dialog.tsx`; swap its `openSettings` source from store to `useSettingsNav`. `build-items.ts` unchanged. |
| Other search params clobbered on open. | `navigate({ search: prev => ({...prev, settings: s}) })` spreads prev. |
| Focus restore on close. | shadcn Dialog's built-in focus restore still triggers via `onOpenChange`. |
| Deep-link string protocol ↔ router. | IPC stays `/settings/<section>`; `routeToSection` translates; `useSettingsNav().openSettings` navigates. |
| Dark-mode legibility of colored chips. | Chips use saturated hex (draft values); verify in dark mode. |
| Parallel-session worktree pollution. | Every commit `git add <paths>`; base `develop @ d7edab2`. |

### Success criteria — restated, verifiable

See §1.

### Manual smoke (after implementation)

1. On `/gmail` → click 设置 → URL `/gmail?settings=general`, modal opens, Gmail
   visible behind (state intact).
2. Browser back → modal closes, URL `/gmail`; forward → reopens.
3. Switch to 模型设置 in sidebar → URL param → providers; back stack unchanged.
4. Esc → modal closes.
5. ⌘K "打开设置" → opens to general.
6. No-provider banner "配置" → opens to providers.
7. weather-card settings icon → opens to weather.
8. `swarmagents://settings/mcp` deep-link → opens to mcp.
9. Dark mode: group headers + colored chips legible.

---

## 6. Phases After This One (context only)

- This completes the UI redesign arc (Phases 1-7).
- **Follow-ups (this spec's non-goals):** sidebar search box; LLM-assisted
  settings search; per-section content redesigns.

---

## Implementation order

1. **Spec → plan → branch `feat/settings-routing` → implement → review → merge.**
   (Write `docs/superpowers/plans/2026-07-06-settings-routing.md` next, via the
   writing-plans skill.)

Task breakdown (6 tasks, single branch, sequential, infra-first):

```
T1: SECTIONS_REGISTRY single source (drop store arrays, keep union + routeToSection)
T2: useSettingsNav hook + __root validateSearch (+ tests)
T3: <SettingsDialog> router-derived + delete store
T4: migrate 5 entry points to useSettingsNav
T5: grouped sidebar visual redesign (5 groups + colored icon chips)
T6: full verify + final review + progress ledger
```

Dependencies: T1 first; T2 before T3; T3 before T4; T5 last (pure surface).
