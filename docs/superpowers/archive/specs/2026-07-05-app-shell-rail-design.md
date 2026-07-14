# App Shell Refactor — 64px Icon Rail Navigation (Phase 1)

**Date:** 2026-07-05
**Scope:** Phase 1 of the desktop UI redesign described in `docs/design/`.
**Branch:** to be created from `develop` as `refactor/ui-app-shell-rail`.
**Out of scope:** any in-page redesign of 任务台首页 / 会话工作台 / 编队 / 服务视图 / 设置. Phase 1 only swaps the app shell.

---

## 1. Goal

Replace the current floating `AppSidebar` (which carries only `SessionList` and a Settings/Theme footer) with the design's **64px icon rail** as the primary navigation, organized into a 场景 (Scenes) group and a 服务 (Services) group. The existing pages are re-hung on this new skeleton without changing their internals.

### Non-goals (deferred to later phases)

- 任务台 dashboard (composer + 进行中 card wall + 定时任务 + 最近完成) — `/` keeps `HomeComposer` for now.
- 会话工作台 four-tab workspace (计划/时间线/产出物/审批) — `TasksView` internals untouched.
- 编队命令中心 rework — current `agents-view` / `org-tree-view` untouched.
- ⌘K unified command palette — `SessionSearchDialog` untouched.
- Settings restructure — stays a modal dialog.

### Success criteria

- The 64px rail is the only top-level nav. It has two grouped sections (场景 / 服务) plus a footer (设置 / 主题).
- Clicking 对话 shows the existing `SessionList` as a secondary panel attached to the rail's right edge; switching to any other scene hides `SessionList`.
- Every page reachable today (`/`, `/session/$id`, `/scheduled`, `/usage`, `/trending`, `/bilibili`, `/gmail`, agents) remains reachable from the rail.
- Active route is reflected on the matching rail icon (`data-active`).
- Existing tests still pass; `service-grid.test.tsx` is updated (or its concerns moved) since `ServiceGrid` is removed.
- macOS title-bar drag region, traffic-light clearance, and `ToolsPopover` placement still work.

---

## 2. Design Decisions (locked from brainstorm)

| Decision | Choice | Rationale |
|---|---|---|
| SessionList placement | 对话场景二级面板 (secondary panel shown only in 对话 scene) | Matches design稿; cleanest navigation semantics. |
| Rail icon set | 设计稿全套 (all scenes + services rendered) | Per design稿; unimplemented pages navigate to existing routes for now. |
| Settings entry | Keep modal dialog | Out of scope for Phase 1; opens `SettingsDialog` as today. |
| Brand icons | Reuse existing `lucide-react` mappings (`Mail`/`Video`/`TrendingUp`), no new brand SVGs | Consistent with `service-grid.tsx` / `settings-dialog.tsx`; brand polish is a later visual phase. |

---

## 3. Rail Structure

A vertical 64px-wide rail pinned to the window's left edge, full height, with the macOS traffic lights rendered above it (the rail's top has the same `pt-9`/top-padding clearance the floating sidebar uses today, so traffic lights stay visible).

### Icon inventory (top → bottom)

**场景 group (Scenes):**
| Icon (`lucide-react`) | Label | Routes to | Notes |
|---|---|---|---|
| `LayoutDashboard` | 任务台 | `/` | Active on `/`. |
| `MessageSquare` | 对话 | `/session/$sessionId` or `/` fallback | Active on `/session/*`. Selecting with no sessions lands on `/`. Shows SessionList panel. |
| `Network` | 编队 | `openSettings('agents')` | Agents currently live inside SettingsDialog only (no `/agents` route). **Phase 1 behavior:** clicking opens the SettingsDialog directly on the agents section. A dedicated `/agents` route is deferred. This icon is never "active" (no route to match). |
| `Calendar` (`CalendarClock`) | 日历 | `/scheduled` | Existing route. |
| `Clock` | 自动化 | `/scheduled` | Same route as 日历 (the view shows both cron jobs and calendar). Label differs from 日历 to match design稿; both highlight together when on `/scheduled`. |
| `BarChart3` | 用量 | `/usage` | Existing route. |

**服务 group (Services):**
| Icon | Label | Routes to |
|---|---|---|
| `Mail` | Gmail | `/gmail` |
| `TrendingUp` | GitHub 趋势 | `/trending` |
| `Video` | Bilibili | `/bilibili` |

**Footer:**
| Icon | Label | Action |
|---|---|---|
| `Settings` | 设置 | `useSettingsDialog.openSettings()` (modal). |
| (`ThemeToggle`) | 主题 | Existing component. |

### Active-state rules

- An icon is active when the current route matches its target path prefix.
- `对话` is active on `/session/:id`.
- `任务台` is active on exactly `/`.
- 日历 and 自动化 share `/scheduled`; both light up there (acceptable — they are the same view in Phase 1).
- `编队` does not have a route; it is never "active" in Phase 1 (it calls `openSettings('agents')`). This is documented and accepted.

### Grouping visual

- A subtle divider (existing `border-sidebar-border` token) between 场景 and 服务.
- Group headers from design稿 ("场景" / "服务") are **omitted in Phase 1** to keep the rail at 64px with no text; the divider conveys grouping. (Design稿 also shows no header text inside the 64px rail — labels appear only in tooltips.)

---

## 4. Layout Architecture

### Current (`__root.tsx`)

```
SidebarProvider
  ├─ TopBar (fixed, drag region, ToolsPopover right)
  ├─ AppSidebar (floating card → SessionList + Settings/Theme footer)
  └─ SidebarInset → main (Outlet)
```

### After Phase 1

```
SidebarProvider  (unchanged provider; provides collapse state if needed)
  ├─ TopBar (fixed, drag region — UNCHANGED, still owns ToolsPopover + back/forward)
  ├─ AppRail (new — the 64px icon rail, replaces AppSidebar)
  ├─ SessionPanel (new — secondary panel, rendered only when 对话 is active)
  │     contains <SessionList/> + its existing footer actions
  └─ SidebarInset → main (Outlet)
```

Key points:

- `AppRail` is **not** a `@swarm/ui` `<Sidebar variant="floating">` card. It is a plain `flex` column pinned left, full height, `w-16` (64px), translucent over window vibrancy (`bg-sidebar/transparent` per design稿). This avoids fighting the `Sidebar` component's collapse/cookie machinery, which is designed for a collapsible content sidebar, not a fixed icon rail.
- `SessionPanel` is a secondary `w-[236px]` column (design稿 width) that holds the existing `SessionList`. It is conditionally rendered based on the active scene (see §5). It uses the same translucent/card treatment as the old `AppSidebar` body so the chat surface still reads as one material.
- The `TopBar` keeps the traffic-light offset (`pl-[88px]`) but **drops the `SidebarTrigger`** — there is no longer a single collapsible sidebar to toggle. `SessionPanel` may get its own collapse control in a later phase; Phase 1 leaves it always-visible within the 对话 scene.

### Visual / token usage

- Rail background: `bg-sidebar` (existing token) over `--window-content` vibrancy — same material family as today's floating sidebar, so no new tokens.
- Active icon: `bg-sidebar-accent text-foreground` (same classes as today's `iconBtn` in `app-sidebar.tsx` / `service-grid.tsx`).
- Icon size: `[&_svg]:size-5` (20px) to read well in a 64px rail with 44px hit targets (matches design稿 hit area).
- Hit target: `size-11` (44px) centered in the 64px rail.
- Tooltips: `side="right"` (rail is on the left edge), label text from §3.

---

## 5. Scene Model & SessionPanel Visibility

A small piece of UI state decides whether `SessionPanel` is shown:

```ts
// true when the current route is a conversation scene (任务台 landing OR /session/:id)
function isConversationScene(pathname: string): boolean {
  return pathname === '/' || pathname.startsWith('/session/')
}
```

- `SessionPanel` renders iff `isConversationScene(pathname)` is true.
- Rationale: on 任务台 (`/`) the user is between conversations and may want to pick/restart one, so the list stays visible (matches design稿 任务台 having the list accessible). On any non-conversation scene (编队/日历/自动化/用量/服务) the list is hidden to give the page the full width — matching design稿's per-scene layouts where the list is absent.

> **Alternative considered:** show SessionList only on `/session/:id`, not on `/`. Rejected because 任务台首页 in design稿 is itself a conversation-adjacent surface, and hiding the list there would leave an empty rail-adjacent gutter during Phase 1 (任务台 dashboard is Phase 2). Keeping the list on `/` is the least-surprising bridge state.

Active-state subscription uses TanStack Router's `useLocation` (already used elsewhere in the renderer) — no new store needed.

---

## 6. Files Touched

### New files

- `src/renderer/src/components/app-rail.tsx` — the 64px rail. Exports `AppRail` and the `RAIL_SECTIONS` config (icon, label, target).
- `src/renderer/src/components/session-panel.tsx` — the secondary panel wrapping `SessionList` + its footer actions (moved from `app-sidebar.tsx`).

### Modified files

- `src/renderer/src/routes/__root.tsx`
  - Replace `<AppSidebar />` with `<AppRail />`.
  - Add `<SessionPanel />` (conditionally rendered via `useLocation`).
  - Remove `SidebarTrigger` from `TopBar` (no single sidebar to toggle).
  - Keep `ToolsPopover`, back/forward, drag region unchanged.

- `src/renderer/src/components/app-sidebar.tsx`
  - **Delete.** Its contents split into `app-rail.tsx` (rail) and `session-panel.tsx` (SessionList + footer). Or, if preferred for diff clarity, keep the filename and repurpose it as the rail — but two new focused files read cleaner. **Decision: delete + two new files.**

- `src/renderer/src/components/service-grid.tsx`
  - **Delete.** Its function (service shortcuts) is fully absorbed by the rail. The `SERVICES` array's icon/label/route triples move into `RAIL_SECTIONS`.

- `src/renderer/src/components/service-grid.test.tsx`
  - **Delete** (tests the deleted `SERVICES` ordering). The rail will get its own lightweight test (see §8).

- `src/renderer/src/components/session-list.tsx`
  - **One surgical edit** (not a rewrite): remove the `<ServiceGrid />` usage at line 414 and its now-unused import (line 38). The services it launched are now reachable from the rail, so embedding them inside the conversation list is redundant. Everything else in the 533-line file is untouched — the New chat button, Search button, segmented control, and list rendering all stay.
  - Rationale: this is a direct consequence of moving services to the rail, not an unrelated cleanup (passes the "every changed line traces to the request" test).

- `src/renderer/src/components/tools-popover.tsx`, `events-bridge.tsx`, `settings-dialog.tsx`, `session-search-dialog.tsx`
  - **No change.** They remain mounted in `__root.tsx`.

### Unchanged but relevant

- `@swarm/ui` `Sidebar` component — still used by `SidebarProvider`/`SidebarInset` for layout context; we just don't render a `<Sidebar>` inside it. No lib change.
- All route files (`index.tsx`, `session.$sessionId.tsx`, `bilibili.tsx`, etc.) — untouched.
- `SessionList` footer actions (new chat, services grid today) — the "new chat" action and `ServiceGrid` currently live in `session-list.tsx`'s footer area; need to verify and move them appropriately (see §7 Risks).

---

## 7. Risks & Verification

| Risk | Mitigation |
|---|---|
| `SessionList` embeds `<ServiceGrid />` at line 414 (verified). | Remove that one usage + its import when deleting `service-grid.tsx`. The New chat / Search buttons stay. Covered by §6. |
| Removing `SidebarTrigger` breaks a keyboard shortcut or `ToolsPopover` alignment. | `SidebarTrigger` only toggled the floating sidebar; grep for other refs before removing. `ToolsPopover` is in `TopBar`, independent. |
| Active-state matching for shared routes (日历+自动化 on `/scheduled`) is confusing. | Documented in §3; both icons highlight. Acceptable for Phase 1. |
| Traffic-light overlap with rail icons. | Rail top keeps `pt-9` padding (same as today's floating sidebar inner content) so icons start below the 36px control band. |
| `events-bridge.tsx` navigates to `/session/:id` from outside; ensure rail/panel react. | Uses `useLocation`, which is reactive to router navigation — no extra wiring. |

---

## 8. Testing

- **Existing tests must pass** (`pnpm test` in `apps/desktop`, esp. `service-grid.test.tsx` removed cleanly, `session-list`-related tests unaffected).
- **New test:** `app-rail.test.tsx` — asserts:
  - All expected icons render with correct labels (snapshot of `RAIL_SECTIONS`).
  - Clicking a scene icon navigates to its route (mock router).
  - `isConversationScene` returns true for `/` and `/session/x`, false for `/usage` etc.
- **Manual smoke test checklist** (in commit message / PR):
  - Rail visible, two groups, footer.
  - 对话 → SessionPanel appears; 用量 → disappears.
  - Active icon highlights on each route.
  - 设置 opens modal.
  - Traffic lights not overlapped; window still draggable.
  - `ToolsPopover` still opens from top-right.

---

## 9. Phases After This One (context only)

2. 任务台首页 dashboard · 3. ⌘K 命令台 · 4. 会话工作台四 tab · 5. 编队命令中心 · 6. 服务视图重做 · 7. 设置路由化. Each gets its own spec → plan → branch.
