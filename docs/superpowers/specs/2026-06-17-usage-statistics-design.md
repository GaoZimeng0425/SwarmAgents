# Usage Statistics — Design

**Date:** 2026-06-17
**Status:** Approved (pending spec review)

## Goal

Add an in-app usage dashboard (`/usage`) that surfaces token/session/message
activity over a selectable time range, modelled on the reference mockups: six
summary cards, an activity heatmap, a daily-token bar trend, and a per-model
donut. Read-only — it reports on data SwarmAgents already persists.

## Key constraint: no new tracking

Every metric is derivable from the existing SQLite store. No new columns, no
new instrumentation:

- `tasks.used.tokens` — already accumulated per task (`ResourceBudget`).
- `tasks.created_at` — range bucketing and active-day computation.
- `sessions.provider_snapshot.model` — per-model attribution (a session keeps
  one provider snapshot, so tasks attribute to their session's model).
- `task_events` (kind `llm.message`, with `ts`) — message counts.

`usdCents` exists but is **not** surfaced — it is unreliable/zero for custom
providers (e.g. GLM), so a cost card would show misleading data. Omitted.

## Architecture & data flow

One new read-only RPC method, threaded through the existing chain exactly as
`getSessionTasks` is:

```
usage-view (route /usage)
  → swarmApi.getUsageStats(rangeDays)            src/renderer/src/lib/api.ts
  → window.swarm.usage.get(rangeDays)            preload bridge + src/shared/types/ipc.ts
  → serviceClient.getUsageStats(rangeDays)       src/main/service-client.ts
  → dispatcher case 'getUsageStats'              src/service/dispatcher.ts
  → sessionManager.getUsageStats(rangeDays)      src/service/session-manager.ts
  → conversationStore.getUsageStats(rangeDays)   src/service/conversation-store.ts  ← SQL aggregation
```

`getUsageStats` is added to the `ServiceMethod` union in
`src/shared/types/service-ipc.ts`.

## Data shape

New file `src/shared/types/usage.ts`:

```ts
export type ModelUsage = { model: string; tokens: number; pct: number }
export type DayBucket  = { date: string /* 'YYYY-MM-DD' local */; tokens: number }

export type UsageStats = {
  rangeDays: 7 | 30
  totals: {
    tokens: number
    sessions: number       // distinct sessions with ≥1 task in range
    messages: number       // llm.message events in range
    activeDays: number     // distinct local dates with a task in range
    currentStreak: number  // consecutive trailing days (incl. today) with activity
    topModel: ModelUsage | null
  }
  daily: DayBucket[]        // range-scoped → bar trend
  byModel: ModelUsage[]     // range-scoped → donut (desc by tokens)
  heatmap: DayBucket[]      // fixed trailing 12 weeks (84d), independent of range toggle
}
```

A `UsageStatsSchema` (zod) lives alongside the types for parity with the other
shared-type modules.

## Aggregation (`conversationStore.getUsageStats`)

All computed in SQL against the existing tables. Timestamps are epoch-ms;
convert to local dates with `date(<col>/1000, 'unixepoch', 'localtime')`. JSON
columns read via `json_extract`.

- `cutoff = startOfLocalDay(today − (rangeDays − 1))` as epoch-ms — so a 7-day
  range includes today plus the prior six full local days.
- **tokens**: `SUM(json_extract(used,'$.tokens'))` over `tasks` where
  `created_at ≥ cutoff`.
- **sessions**: `COUNT(DISTINCT session_id)` over `tasks` where
  `created_at ≥ cutoff`.
- **messages**: `COUNT(*)` over `task_events` joined to `tasks` (for range),
  where `json_extract(event,'$.kind') = 'llm.message'` and `ts ≥ cutoff`.
- **activeDays**: `COUNT(DISTINCT date(created_at/1000,'unixepoch','localtime'))`
  over `tasks` in range.
- **byModel**: `tasks` joined to `sessions`, grouped by
  `json_extract(provider_snapshot,'$.model')`, `SUM` tokens, ordered desc;
  `pct` computed in JS against the range total. `topModel` = first row.
- **daily**: tokens grouped by local date over the range; zero-fill missing
  days in JS so the bar chart has a continuous axis.
- **heatmap**: same grouping over a fixed trailing 84-day window (independent
  of `rangeDays`); zero-filled to 84 buckets in JS.
- **currentStreak**: pure JS helper over the set of active local dates — walk
  backward from today while each day is present; stops at the first gap.

The method logs entry (`{ rangeDays }`, info), outcome
(`{ durationMs, tokens }`, info), and wraps the queries in try/catch logging at
`error` before rethrowing, per CLAUDE.md §5.

## Renderer components

Mirrors the `routes/skills.tsx → components/views/skills-view.tsx` pattern.

- **`src/renderer/src/routes/usage.tsx`** — TanStack route at `/usage`; renders
  `UsageView`.
- **`src/renderer/src/components/views/usage-view.tsx`** — owns `rangeDays`
  state (7 | 30, default 30), fetches on mount and on toggle change, and
  composes the sections. Handles loading / error / empty.
- Subcomponents (same file or co-located):
  - `StatCard` ×6 — icon + label + value. Numbers via
    `Intl.NumberFormat('en', { notation: 'compact', maximumFractionDigits: 1 })`.
    Cards: tokens, sessions, messages, active days, current streak, top model
    (model name + share %).
  - `DailyTokenChart` — recharts `BarChart` over `daily`, wrapped in the shadcn
    `ui/chart.tsx` `ChartContainer`.
  - `ModelUsageDonut` — recharts `PieChart` (inner radius for the donut hole,
    center total) + legend rows (color dot, model, tokens, pct).
  - `ActivityHeatmap` — CSS-grid GitHub-style calendar over `heatmap`; 5 shade
    buckets by token quantile. No new dependency (recharts has no calendar).
- **Sidebar** (`src/renderer/src/components/app-sidebar.tsx`) — new footer
  `SidebarMenuItem` above Skills, `BarChart3` icon (lucide), `to="/usage"`,
  label "Usage", following the existing `Link` + `activeProps` pattern.

Labels are English to match the rest of the app (no i18n library present); the
Chinese mockups are visual references only.

## Error / empty handling

- Route: loading skeleton while the promise is in flight; inline error message
  on rejection; empty state ("No usage yet") when `totals.tokens === 0`.
- The range toggle re-fetches; an in-flight fetch is superseded (ignore stale
  responses by tracking the latest request).

## Testing

- **`conversation-store.test.ts`** — seed sessions (varied models), tasks
  (varied `used.tokens`, `created_at` inside and outside the range), and
  `llm.message` events; assert: range-filtered token total, session count,
  message count, active-day count, multi-model `byModel` grouping + ordering,
  `daily` zero-fill length, and `heatmap` 84-bucket length.
- **`currentStreak` helper** — unit tests: today-active streak, gap breaks
  streak, empty set → 0, streak not counting future-only days.
- **`dispatcher.test.ts`** (or inline) — `getUsageStats` routes to the manager
  and returns its result.

## Out of scope (v1)

- Cost / `usdCents` surfacing.
- Per-session drill-down from the dashboard.
- Export / CSV.
- i18n / Chinese labels.
- Custom date-range picker beyond the 7/30 toggle.
