# Usage Statistics — Design

**Date:** 2026-06-17
**Status:** Approved (pending spec review)

## Goal

Add an in-app usage dashboard (`/usage`) that surfaces token/session/message
activity over a selectable time range, modelled on the reference mockups: seven
summary cards, an activity heatmap, a daily-token bar trend, and a per-model
donut. Read-only — it reports on data SwarmAgents already persists. Labels are
in Chinese, matching the reference mockups.

## Key constraint: no new tracking

Every metric is derivable from the existing SQLite store. No new columns, no
new instrumentation:

- `tasks.used.tokens` — already accumulated per task (`ResourceBudget`).
- `tasks.created_at` — range bucketing and active-day computation.
- `sessions.provider_snapshot.model` — per-model attribution (a session keeps
  one provider snapshot, so tasks attribute to their session's model).
- `task_events` (kind `llm.message`, with `ts`) — message counts.
- `tasks.used.usdCents` — cost. Populated in `agent-runner.ts` from pi-ai's
  per-model price table (`usage.cost.total`).

### Cost caveat (the "估算" label)

`usdCents` is accurate for built-in Anthropic/OpenAI providers but **estimated**
for custom providers: `resolveModel` clones a built-in *template* model
(gpt-4o / fallback) to get a request shape, so cost is computed at the
template's rates, not the custom model's real pricing. The dashboard therefore
shows the cost card **always**, but labels it "估算" (estimated) with a note that
custom-provider pricing may be inaccurate — rather than hiding it or presenting
it as exact.

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
    usdCents: number       // summed cost; estimated for custom providers (see caveat)
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
- **usdCents**: `SUM(json_extract(used,'$.usdCents'))` over `tasks` in range.
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
  - `StatCard` ×7 — icon + label + value. Counts/tokens via
    `Intl.NumberFormat('zh-CN', { notation: 'compact', maximumFractionDigits: 1 })`
    (yields 万/亿 units, matching the mockup's "241.8万"). Cards: tokens
    (tokens 用量), cost (花费 — value via currency format, with an "估算" badge and
    tooltip noting custom-provider pricing may be inaccurate), sessions
    (会话数量), messages (消息数量), active days (活跃天数), current streak
    (当前连续天数), top model (最常用模型 — model name + 占比 %).
  - `DailyTokenChart` (按天 Token 趋势) — recharts `BarChart` over `daily`,
    wrapped in the shadcn `ui/chart.tsx` `ChartContainer`.
  - `ModelUsageDonut` (模型用量) — recharts `PieChart` (inner radius for the
    donut hole, center total) + legend rows (color dot, model, tokens, pct).
  - `ActivityHeatmap` (活跃热力图) — CSS-grid GitHub-style calendar over
    `heatmap`; 5 shade buckets by token quantile, with 较少/较多 legend. No new
    dependency (recharts has no calendar).
- Time-range toggle labels: 最近 7 天 / 最近 30 天. Section header: 时间范围.
- **Sidebar** (`src/renderer/src/components/app-sidebar.tsx`) — new footer
  `SidebarMenuItem` above Skills, `BarChart3` icon (lucide), `to="/usage"`,
  label "用量统计", following the existing `Link` + `activeProps` pattern.

Labels are in Chinese (hardcoded literals), matching the reference mockups.
There is no i18n library; the rest of the app's chrome stays English.

## Error / empty handling

- Route: loading skeleton while the promise is in flight; inline error message
  on rejection; empty state ("No usage yet") when `totals.tokens === 0`.
- The range toggle re-fetches; an in-flight fetch is superseded (ignore stale
  responses by tracking the latest request).

## Testing

- **`conversation-store.test.ts`** — seed sessions (varied models), tasks
  (varied `used.tokens`, `created_at` inside and outside the range), and
  `llm.message` events; assert: range-filtered token total, cost (usdCents)
  total, session count, message count, active-day count, multi-model `byModel`
  grouping + ordering, `daily` zero-fill length, and `heatmap` 84-bucket length.
- **`currentStreak` helper** — unit tests: today-active streak, gap breaks
  streak, empty set → 0, streak not counting future-only days.
- **`dispatcher.test.ts`** (or inline) — `getUsageStats` routes to the manager
  and returns its result.

## Out of scope (v1)

- Accurate cost for custom providers (shown as 估算 only).
- Per-session drill-down from the dashboard.
- Export / CSV.
- A full i18n framework (labels are hardcoded Chinese literals).
- Custom date-range picker beyond the 7/30 toggle.
