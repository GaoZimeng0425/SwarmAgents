# 任务台首页 Dashboard Refactor (Phase 2)

**Date:** 2026-07-05
**Scope:** Phase 2 of the desktop UI redesign — rebuild the `/` (任务台) route from the bare `HomeComposer` into the design-spec dashboard: composer + 进行中 card wall + 定时任务 + 最近完成.
**Branch:** to be created from `refactor/ui-app-shell-rail` (Phase 1) as `refactor/ui-mission-control-dashboard`.
**Depends on:** Phase 1 (`refactor/ui-app-shell-rail`) merged or present.
**Out of scope:** the 会话工作台 four-tab workspace, 编队 command center, ⌘K palette, service views, settings.

---

## 1. Goal

Transform `/` from a centered composer into the design-spec 任务台 dashboard: a slim top bar, a hero composer, a 进行中 card wall (live running + awaiting-approval cards), and a two-column footer of 定时任务 + 最近完成. All four sections bind to real data that already exists in the renderer — no backend/IPC changes.

### Non-goals

- No new IPC, no service-layer changes, no new preload channels. "最近完成" is approximated from `SessionSummary` (see §4.4), explicitly accepting the loss of per-task granularity.
- No reimplementation of the composer — reuse `<ChatInput>` inside a new shell.
- No work on `/session/:id`, agents, settings, command palette, or service views.
- No agent avatars (none exist in the codebase today; net-new UI deferred).

### Success criteria

- `/` renders: top bar (title + running-count pill + search button) → composer → 进行中 cards → (定时任务 | 最近完成) split.
- 进行中 cards reflect live run state across all sessions (running, pending, awaiting_user) via the global `useRuns()` cache; clicking a card opens its session; awaiting-approval cards approve/reject inline without navigating.
- 定时任务 lists upcoming cron jobs from `useAllCronJobs()` with next-run + last-result status.
- 最近完成 lists recently-ended sessions from `useSessionsStore()` with completion time.
- Empty states render for each section when its data is empty.
- Submitting the composer creates a session and navigates to `/session/:id` (unchanged behavior).
- The SessionPanel (Phase 1) is hidden on `/` (任务台 is full-width dashboard) — only shows on `/session/*`.
- Existing renderer tests pass; new dashboard has unit tests for the data-derivation logic.

---

## 2. Design Decisions (locked from brainstorm)

| Decision | Choice | Rationale |
|---|---|---|
| "最近完成" data source | `SessionSummary` where `status==='ended'`, sorted by `lastActiveAt`, top N | No IPC work; Phase 2 stays front-end-only. Accept coarse granularity. |
| Running-count semantics | Both the top-bar pill AND the 进行中 section header count only `running`+`pending` (NOT `awaiting_user`) | Single consistent number; awaiting cards still render in the section, just don't inflate the count. Resolves the design-spec 2-vs-3 discrepancy in favor of clarity. |
| SessionPanel on `/` | Hidden. `isConversationScene` narrows to `/session/*` only. | 任务台 is a full-width dashboard; the list would compete for space. Matches design-spec 2a (no right panel on home). |
| Composer | Reuse `<ChatInput>` (as today's `HomeComposer` does), wrapped in a new dashboard shell. | All composer features (cwd, model, agent, approval mode, attachments, shortcuts, submit) preserved. Only the surrounding layout changes. |
| Empty states | Full empty states per section. | First-run UX matters; design-spec didn't draw them but they're necessary. |

---

## 3. Layout (matches design-spec Hi-fi 2a)

Main content area (everything right of the 64px rail from Phase 1):

```
┌─ top bar (h-13, px-7) ─────────────────────────────────────┐
│ 任务台            [● 2 个运行中]              [搜索 ⌘K]    │
├─ dashboard body (max-w-[1088px] mx-auto, px-6 py-5, gap-7) ┤
│                                                             │
│  今天想让 swarm 做点什么?                                   │
│  ┌─ composer card (rounded-2xl, shadow) ──────────────┐    │
│  │  <ChatInput/>                                        │    │
│  │  [~/repo/desktop] [Model ▾] [Agent ▾] [需审批 ▾] [↑]│    │
│  └─────────────────────────────────────────────────────┘    │
│                                                             │
│  进行中                                  3   ← counts running+pending+awaiting visible cards
│  ┌──────────┐ ┌──────────┐ ┌──────────┐                     │
│  │ ● 运行中  │ │ ◆ 等待审批│ │ ● 运行中  │                     │
│  │ 标题      │ │ 标题      │ │ 标题      │                     │
│  │ ▸ action │ │ rm -rf…  │ │ ▸ action │                     │
│  │ cwd  12/18│ │ [允许][拒绝]│ │ 研究任务 5/9 │                  │
│  └──────────┘ └──────────┘ └──────────┘                     │
│                                                             │
│  ┌─ 定时任务 ───── 查看日历→─┐ ┌─ 最近完成 ─────────┐        │
│  │ 每天 9:00  抓取趋势 上次成功│ │ ✓ 补全IPC测试 1小时前│        │
│  │ 周一 8:30  Gmail摘要 3天后 │ │ ✓ B站转写    昨天  │        │
│  └─────────────────────────┘ └───────────────────┘        │
└─────────────────────────────────────────────────────────────┘
```

### Design tokens (from Hi-fi 2c, mapped to existing Tailwind tokens)

| Design | Tailwind token |
|---|---|
| 底 `#F4F4F2` | `bg-background` (already the window backdrop) |
| 面 `#FFFFFF` | `bg-card` |
| 墨 `#1C1C1E` | `text-foreground` |
| 运行 `#3478F6` | `text-primary` (system accent) |
| 待审 amber `#C77D1E` / border `#E2B06B` / tint `#FBF4E8` | new minor tokens via inline classes (see §6) |
| 完成 `#2E9E5B` | `text-emerald-600` (Tailwind arbitrary) |
| Hairline `rgba(0,0,0,.07)` | `border-border` |

Dark mode handled by existing `.dark` token swap; amber uses `dark:text-amber-400` etc.

---

## 4. Data Sources & Derivation

### 4.1 Composer

- Component: `<ChatInput>` (existing, `components/chat-input.tsx`).
- Submit: existing `useSubmitGoal()` mutation → creates session → `navigate('/session/:id')`. Behavior identical to today's `HomeComposer`.
- No changes to the composer itself.

### 4.2 进行中 (In progress)

- Source: `useRuns()` → `RunRecord[]` (global cache, `hooks/use-runs.ts`).
- Filter: `status ∈ {'pending','running','awaiting_user'}`, sorted by `startedAt` desc.
- Per-card fields:
  - **status label/dot**: derive from `RunRecord.status` (running/pending → blue "运行中"; awaiting_user → amber "等待审批").
  - **title**: `RunRecord.goal` (truncate to 1 line).
  - **current action**: the latest `tool.call` or `llm.message` event in `RunRecord.events` — render the tool name or a short text snippet in a monospace `▸ …` box. (Mirror what the conversation transcript shows for the latest turn.)
  - **cwd / agent label**: join `RunRecord.sessionId` → `useSessionsStore().sessions` to get `SessionSummary.cwd` and `agentType`. For the agent label, map `agentType` via `useTeamOptions()` (id → display name).
  - **step progress**: `RunRecord.plan ? `${completed}/${total} 步` : null` (reuse `PlanStatusBar` arithmetic). Null if no plan.
  - **wall time**: `Date.now() - RunRecord.startedAt`, formatted via existing `formatDuration` (`lib/scheduled-rows.ts`), live-ticking (re-render every 30s — see §5).
  - **approval payload** (awaiting_user only): the latest `permission_request` event's tool call (e.g. `rm -rf out/ && pnpm build`).
- Actions:
  - Click card → `navigate('/session/:sessionId')`.
  - Approve/Reject (awaiting_user only) → existing `useDecidePermission()` mutation; `stopPropagation` so the card click doesn't fire.
- New helper: `lib/dashboard-runs.ts` — `selectDashboardRuns(runs, sessions)` returns `{ running: DashboardRun[], awaiting: DashboardRun[] }`. Pure function, unit-tested. (Counts: `running.length` for both the top-bar pill and the section header count.)

> **Cold-start note:** `useRuns()` only holds sessions hydrated this launch. On a fresh dashboard mount with no runs in cache, 进行中 is empty (empty state renders). This is acceptable — the dashboard is meant to show *currently* running tasks, and a freshly-launched app correctly has none until the user starts one or one is streamed in. We will NOT preload historical runs (deferred — would need IPC).

### 4.3 定时任务 (Scheduled)

- Source: `useAllCronJobs()` → `ScheduledTask[]` (`hooks/use-cron.ts`).
- Filter/sort: by `nextRun` ascending, top 5.
- Per-row fields:
  - **time**: format `nextRun` (or `cron` expr) → "每天 9:00" / "周一 8:30" style. Reuse/extend `lib/scheduled-rows.ts` formatters.
  - **name**: `ScheduledTask.name ?? ScheduledTask.goal` (truncate).
  - **status**: if `lastRunAt` exists, look up the latest `CronRun` for this job via `useAllCronRuns()` → green "上次成功" (status==='completed') or red "上次失败" (otherwise); if no past run, show "X 天后" countdown from `nextRun`.
- Action: "查看日历 →" link → `navigate('/scheduled')`. Row click also navigates to `/scheduled` (or to the job's session — TBD, default to `/scheduled` for Phase 2).
- New helper: `lib/dashboard-cron.ts` — `selectDashboardCron(jobs, runs, now)` returns `DashboardCronRow[]`. Pure, unit-tested.

### 4.4 最近完成 (Recently completed)

- Source: `useSessionsStore((s) => s.sessions)` → `SessionSummary[]`.
- Filter: `status === 'ended'`, sort by `lastActiveAt` desc, top 5.
- Per-row fields:
  - **name**: `SessionSummary.title ?? '未命名任务'` (truncate).
  - **time**: relative format of `lastActiveAt` ("1 小时前" / "昨天" / "3 天前") — reuse/extend a relative-time helper (check `lib/` for existing; if none, add `formatRelativeTime` to `lib/format-usage.ts` or a new `lib/format-time.ts`).
  - **icon**: green check (success). Failed-state (red X) is NOT derivable from `SessionSummary` (no per-session success flag) — so all 最近完成 rows show the success icon in Phase 2. Documented limitation.
- Action: row click → `navigate('/session/:id')`.
- New helper: `lib/dashboard-recent.ts` — `selectDashboardRecent(sessions)` returns `DashboardRecentRow[]`. Pure, unit-tested.

> **Limitation acknowledged:** "最近完成" shows recently-ended *sessions*, not completed *tasks within* a session. A session that ended after many tasks shows as one row. Per-task granularity requires a new IPC (deferred). This is the agreed trade-off from brainstorm.

---

## 5. Live updates

The dashboard must reflect real-time changes (a task starting, completing, requesting approval).

- `useRuns()` cache updates automatically via the app-wide event subscription (`useEventsSubscription` in `EventsBridge`) — no extra wiring. React Query re-renders subscribers.
- **Wall-time ticks**: each running card shows elapsed time. Add a single `useNow(intervalMs=30_000)` hook (or reuse if one exists — grep first) mounted once in the dashboard; pass `now` to `selectDashboardRuns`. 30s granularity is sufficient (cards show "4 分钟" / "12 分钟").
- **Cron "X 天后" countdown**: also derived from `now`; the same `useNow` tick refreshes it.

---

## 6. Files

### New files

- `src/renderer/src/components/views/home-dashboard.tsx` — the new `/` view. Composes the top bar, composer, and the four section components. Replaces `HomeComposer` as the route's component.
- `src/renderer/src/components/views/dashboard/running-cards.tsx` — the 进行中 section (header + card grid + empty state).
- `src/renderer/src/components/views/dashboard/running-card.tsx` — a single running/awaiting card.
- `src/renderer/src/components/views/dashboard/scheduled-list.tsx` — the 定时任务 section.
- `src/renderer/src/components/views/dashboard/recent-list.tsx` — the 最近完成 section.
- `src/renderer/src/components/views/dashboard/dashboard-topbar.tsx` — the slim top bar (title + pill + search button).
- `src/renderer/src/lib/dashboard-runs.ts` — pure selectors + types (`DashboardRun`, `selectDashboardRuns`).
- `src/renderer/src/lib/dashboard-cron.ts` — pure selectors + types (`DashboardCronRow`, `selectDashboardCron`).
- `src/renderer/src/lib/dashboard-recent.ts` — pure selectors + types (`DashboardRecentRow`, `selectDashboardRecent`).
- `src/renderer/src/lib/dashboard-runs.test.ts`, `dashboard-cron.test.ts`, `dashboard-recent.test.ts` — unit tests for the selectors.
- `src/renderer/src/hooks/use-now.ts` — a `useNow(intervalMs)` hook (after grepping for an existing one).

### Modified files

- `src/renderer/src/routes/index.tsx` — render `<HomeDashboard/>` instead of `<HomeComposer/>`. Keep the `select(null)` effect.
- `src/renderer/src/components/rail-config.ts` — narrow `isConversationScene` to `/session/*` only (drop the `pathname === '/'` branch). Update its test accordingly. **This hides SessionPanel on `/`** (the dashboard is full-width).
- `src/renderer/src/components/views/home-composer.tsx` — **delete** (superseded by `home-dashboard.tsx`). Confirm nothing else imports it first.

### Unchanged (reused as-is)

- `components/chat-input.tsx`, `hooks/use-runs.ts`, `hooks/use-cron.ts`, `hooks/use-events-subscription.ts`, `stores/sessions.ts`, `lib/scheduled-rows.ts`, `lib/format-usage.ts`, `components/plan-status-bar.tsx`, `components/session-search-dialog.tsx`.

---

## 7. Risks & Verification

| Risk | Mitigation |
|---|---|
| `<ChatInput>` assumes a session context (e.g. reads `selectedSessionId`); using it on `/` must still work. | Today's `HomeComposer` already does exactly this (composer with no active session → submit creates one). Reuse the same pattern; verify submit still navigates. |
| Narrowing `isConversationScene` breaks the Phase 1 panel-on-`/` behavior that existing tests might assume. | Update `rail-config.test.ts`'s `isConversationScene` cases; re-run full renderer suite. |
| Live wall-time ticking causes excessive re-renders. | Single `useNow(30s)` at the dashboard root; selectors are pure and cheap; cards are light. |
| `RunRecord.events` could be large; deriving "current action" by scanning events on every render. | Memoize the latest-action derivation inside `selectDashboardRuns` (or `useMemo` in the card). |
| Approval card click vs button click navigation conflict. | `stopPropagation` on the approve/reject buttons; verify clicking them does NOT navigate. |
| Empty states look broken if data is loading (vs truly empty). | Distinguish `isLoading` (skeleton/spinner) from `isEmpty` (empty-state copy). React Query exposes `isLoading`. |
| "最近完成" shows sessions not tasks — confusing label. | Label the section "最近完成" but the empty/limitation is documented in code comments; consider a future tooltip. |

### Manual smoke test (Phase 2)

1. `/` shows the dashboard; SessionPanel is hidden (full width).
2. Submit composer → navigates to `/session/:id`; new run appears.
3. Return to `/` (via rail 任务台) → the running task shows in 进行中 with live status + wall time.
4. Trigger a permission request → awaiting card appears with amber styling + 允许/拒绝 buttons; clicking them resolves inline without navigating.
5. 定时任务 shows upcoming cron jobs (create one in /scheduled first if none).
6. 最近完成 shows ended sessions (end a session to populate).
7. Empty states render when each section is empty (fresh install / cleared data).
8. Dark mode renders correctly (amber, green, inverted primary button).
9. `/session/:id` still shows SessionPanel (Phase 1 behavior preserved for sessions).

---

## 8. Phases After This One (context only)

3. ⌘K command palette · 4. 会话工作台 four-tab · 5. 编队 command center · 6. service views · 7. settings routing. Each gets its own spec → plan → branch.
