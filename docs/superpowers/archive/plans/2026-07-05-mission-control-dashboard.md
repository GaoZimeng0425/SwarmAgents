# Mission Control Dashboard Implementation Plan (Phase 2)

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Rebuild the `/` route from the bare `HomeComposer` into the design-spec 任务台 dashboard: top bar + composer + 进行中 card wall + 定时任务 / 最近完成 split, all bound to existing renderer data (no backend changes).

**Architecture:** Pure selector modules derive dashboard rows from existing React Query caches (`useRuns`, `useAllCronJobs`, `useAllCronRuns`) and the sessions store; each selector is a pure function with unit tests (matching the project's `buildScheduledRows` pattern). Thin view components render from those rows. The composer reuses `<ChatInput>` unchanged inside a new dashboard shell.

**Tech Stack:** React 19, TanStack Router/Query v5, Zustand, Tailwind v4 with `@swarm/ui` tokens, lucide-react, Vitest (jsdom) following the project's pure-logic test pattern.

**Spec:** `docs/superpowers/specs/2026-07-05-mission-control-dashboard-design.md`

**Branch:** create `refactor/ui-mission-control-dashboard` from current `refactor/ui-app-shell-rail` (Phase 1) before Task 1.

---

## File Structure

| File | Responsibility | Status |
|---|---|---|
| `apps/desktop/src/renderer/src/lib/format-time.ts` | `formatRelativeTime(ts, now)` → "刚刚" / "X 分钟前" / "X 小时前" / "昨天" / "X 天前" / date. Pure. | **Create** |
| `apps/desktop/src/renderer/src/lib/format-time.test.ts` | Unit tests for `formatRelativeTime`. | **Create** |
| `apps/desktop/src/renderer/src/hooks/use-now.ts` | `useNow(intervalMs)` — ticking `Date.now()` hook for live wall-time/countdowns. | **Create** |
| `apps/desktop/src/renderer/src/lib/dashboard-runs.ts` | `DashboardRun` type + `selectDashboardRuns(runs, sessions, teamOptions, now)` → `{ running: DashboardRun[]; awaiting: DashboardRun[] }`. Pure. | **Create** |
| `apps/desktop/src/renderer/src/lib/dashboard-runs.test.ts` | Unit tests for the runs selector. | **Create** |
| `apps/desktop/src/renderer/src/lib/dashboard-cron.ts` | `DashboardCronRow` type + `selectDashboardCron(jobs, runs, now)`. Pure. | **Create** |
| `apps/desktop/src/renderer/src/lib/dashboard-cron.test.ts` | Unit tests for the cron selector. | **Create** |
| `apps/desktop/src/renderer/src/lib/dashboard-recent.ts` | `DashboardRecentRow` type + `selectDashboardRecent(sessions)`. Pure. | **Create** |
| `apps/desktop/src/renderer/src/lib/dashboard-recent.test.ts` | Unit tests for the recent selector. | **Create** |
| `apps/desktop/src/renderer/src/components/views/dashboard/running-card.tsx` | One running/awaiting card. | **Create** |
| `apps/desktop/src/renderer/src/components/views/dashboard/running-cards.tsx` | The 进行中 section (header + grid + empty state). | **Create** |
| `apps/desktop/src/renderer/src/components/views/dashboard/scheduled-list.tsx` | The 定时任务 section. | **Create** |
| `apps/desktop/src/renderer/src/components/views/dashboard/recent-list.tsx` | The 最近完成 section. | **Create** |
| `apps/desktop/src/renderer/src/components/views/dashboard/dashboard-topbar.tsx` | Slim top bar: title + running pill + search button. | **Create** |
| `apps/desktop/src/renderer/src/components/views/home-dashboard.tsx` | The new `/` view composing top bar + composer + the four sections. | **Create** |
| `apps/desktop/src/renderer/src/routes/index.tsx` | Render `<HomeDashboard/>` instead of `<HomeComposer/>`. | **Modify** |
| `apps/desktop/src/renderer/src/components/rail-config.ts` | Narrow `isConversationScene` to `/session/*` only. | **Modify** |
| `apps/desktop/src/renderer/src/components/rail-config.test.ts` | Update `isConversationScene` test cases. | **Modify** |
| `apps/desktop/src/renderer/src/components/views/home-composer.tsx` | Superseded. | **Delete** |

---

## Task 0: Create the branch

- [ ] **Step 1: Create and switch to the branch**

```bash
git checkout -b refactor/ui-mission-control-dashboard refactor/ui-app-shell-rail
```

Expected: `Switched to a new branch 'refactor/ui-mission-control-dashboard'`.

- [ ] **Step 2: Verify clean state**

```bash
git status --short
```
Expected: only `?? docs/design/` (pre-existing untracked) — nothing else.

---

## Task 1: `formatRelativeTime` helper + tests (TDD)

**Files:**
- Create: `apps/desktop/src/renderer/src/lib/format-time.ts`
- Create: `apps/desktop/src/renderer/src/lib/format-time.test.ts`

- [ ] **Step 1: Write the failing test**

Create `apps/desktop/src/renderer/src/lib/format-time.test.ts`:

```ts
import { describe, expect, it } from 'vitest'

import { formatRelativeTime } from '@/lib/format-time'

// Fixed "now" = 2026-07-05T12:00:00Z (local noon-ish). All inputs are ms.
const NOW = Date.UTC(2026, 5, 5, 12, 0, 0)
const MIN = 60_000
const HOUR = 60 * MIN
const DAY = 24 * HOUR

describe('formatRelativeTime', () => {
  it('returns "刚刚" for < 1 minute', () => {
    expect(formatRelativeTime(NOW - 10_000, NOW)).toBe('刚刚')
    expect(formatRelativeTime(NOW, NOW)).toBe('刚刚')
  })

  it('returns "X 分钟前" for < 1 hour', () => {
    expect(formatRelativeTime(NOW - 1 * MIN, NOW)).toBe('1 分钟前')
    expect(formatRelativeTime(NOW - 30 * MIN, NOW)).toBe('30 分钟前')
    expect(formatRelativeTime(NOW - 59 * MIN, NOW)).toBe('59 分钟前')
  })

  it('returns "X 小时前" for < 24 hours', () => {
    expect(formatRelativeTime(NOW - 1 * HOUR, NOW)).toBe('1 小时前')
    expect(formatRelativeTime(NOW - 5 * HOUR, NOW)).toBe('5 小时前')
    expect(formatRelativeTime(NOW - 23 * HOUR, NOW)).toBe('23 小时前')
  })

  it('returns "昨天" for 24–48 hours', () => {
    expect(formatRelativeTime(NOW - 1 * DAY, NOW)).toBe('昨天')
    expect(formatRelativeTime(NOW - 47 * HOUR, NOW)).toBe('昨天')
  })

  it('returns "X 天前" for 2–6 days', () => {
    expect(formatRelativeTime(NOW - 2 * DAY, NOW)).toBe('2 天前')
    expect(formatRelativeTime(NOW - 6 * DAY, NOW)).toBe('6 天前')
  })

  it('returns a localized date for >= 7 days', () => {
    // Exact format depends on locale; assert it contains the month/day digits.
    const out = formatRelativeTime(NOW - 30 * DAY, NOW)
    expect(out).toMatch(/2026|26/)
  })

  it('clamps future timestamps to "刚刚"', () => {
    expect(formatRelativeTime(NOW + 5 * MIN, NOW)).toBe('刚刚')
  })
})
```

- [ ] **Step 2: Run test to verify it fails**

```bash
pnpm --filter desktop exec vitest run src/renderer/src/lib/format-time.test.ts
```
Expected: FAIL — "Failed to resolve import '@/lib/format-time'".

- [ ] **Step 3: Write the helper**

Create `apps/desktop/src/renderer/src/lib/format-time.ts`:

```ts
// Relative-time formatting for dashboard rows ("X 分钟前" / "昨天" / "X 天前").
// Pure; unit-tested. All inputs/outputs are epoch ms.
//
// Bucket boundaries (for ts <= now):
//   < 1 min   → "刚刚"
//   < 1 hour  → "X 分钟前"
//   < 1 day   → "X 小时前"
//   < 2 days  → "昨天"
//   < 7 days  → "X 天前"
//   else      → localized date (YYYY-MM-DD via toLocaleDateString, varies by locale)
// Future timestamps clamp to "刚刚" (clock skew / optimistic timestamps).

const MIN = 60_000
const HOUR = 60 * MIN
const DAY = 24 * HOUR

export function formatRelativeTime(ts: number, now: number): string {
  const diff = now - ts
  if (diff < MIN) return '刚刚'
  if (diff < HOUR) return `${Math.floor(diff / MIN)} 分钟前`
  if (diff < DAY) return `${Math.floor(diff / HOUR)} 小时前`
  if (diff < 2 * DAY) return '昨天'
  if (diff < 7 * DAY) return `${Math.floor(diff / DAY)} 天前`
  return new Date(ts).toLocaleDateString()
}
```

- [ ] **Step 4: Run test to verify it passes**

```bash
pnpm --filter desktop exec vitest run src/renderer/src/lib/format-time.test.ts
```
Expected: PASS (7 tests).

- [ ] **Step 5: Commit**

```bash
git add apps/desktop/src/renderer/src/lib/format-time.ts apps/desktop/src/renderer/src/lib/format-time.test.ts
git commit -m "feat(ui): add formatRelativeTime helper for dashboard rows"
```

---

## Task 2: `useNow` hook

**Files:**
- Create: `apps/desktop/src/renderer/src/hooks/use-now.ts`

- [ ] **Step 1: Verify no existing `useNow`**

```bash
grep -rn "useNow\|export function now" apps/desktop/src/renderer/src
```
Expected: no matches. (If a `useNow` already exists, STOP and report — reuse it instead.)

- [ ] **Step 2: Create the hook**

Create `apps/desktop/src/renderer/src/hooks/use-now.ts`:

```ts
import { useEffect, useState } from 'react'

// A ticking "current time" hook for live-derived UI (elapsed wall time on
// running cards, "X 天后" countdowns on scheduled rows). Re-renders the caller
// every `intervalMs`. The interval is suspended in the SSR/test default (no
// effect runs), so callers can pass a fixed `now` in tests by not mounting.
export function useNow(intervalMs = 30_000): number {
  const [now, setNow] = useState(() => Date.now())
  useEffect(() => {
    const id = setInterval(() => setNow(Date.now()), intervalMs)
    return () => clearInterval(id)
  }, [intervalMs])
  return now
}
```

- [ ] **Step 3: Type-check**

```bash
pnpm --filter desktop run typecheck:web
```
Expected: no errors.

- [ ] **Step 4: Commit**

```bash
git add apps/desktop/src/renderer/src/hooks/use-now.ts
git commit -m "feat(ui): add useNow ticking-time hook"
```

---

## Task 3: `selectDashboardRuns` selector + tests (TDD)

**Files:**
- Create: `apps/desktop/src/renderer/src/lib/dashboard-runs.ts`
- Create: `apps/desktop/src/renderer/src/lib/dashboard-runs.test.ts`

**Type reference (verified, do not re-derive):**
- `RunRecord` (`@shared/lib/apply-event`): `{ id, sessionId, goal, status: RunStatus, summary, startedAt, attachments, used?, contextTokens?, contextWindow?, plan?: PlanTodo[], parentRunId?, agentDefId?, events: UIEvent[] }`
- `RunStatus = 'pending'|'running'|'completed'|'failed'|'awaiting_user'|'cancelled'`
- `SessionSummary` (`@swarm/protocol`): `{ id, title, status: 'active'|'interrupted'|'ended', lastActiveAt, taskCount, tokensUsed?, usdCents?, pinned, sortOrder, isSystem, cwd?, agentType?, ... }`
- `PlanTodo` (`@swarm/protocol`): `{ status: 'pending'|'in_progress'|'completed', content, ... }`

- [ ] **Step 1: Write the failing test**

Create `apps/desktop/src/renderer/src/lib/dashboard-runs.test.ts`:

```ts
import type { RunRecord } from '@shared/lib/apply-event'
import type { SessionSummary } from '@swarm/protocol'
import { describe, expect, it } from 'vitest'

import { selectDashboardRuns } from '@/lib/dashboard-runs'

const NOW = 1_000_000
const run = (over: Partial<RunRecord> & Pick<RunRecord, 'id' | 'sessionId' | 'status'>): RunRecord => ({
  goal: 'g',
  summary: null,
  startedAt: NOW - 60_000,
  attachments: [],
  events: [],
  ...over,
})
const session = (over: Partial<SessionSummary> & Pick<SessionSummary, 'id'>): SessionSummary => ({
  title: 't',
  status: 'active',
  lastActiveAt: NOW,
  taskCount: 0,
  pinned: false,
  sortOrder: 0,
  isSystem: false,
  ...over,
})

describe('selectDashboardRuns', () => {
  it('partitions running/pending into `running` and awaiting_user into `awaiting`', () => {
    const runs = [
      run({ id: '1', sessionId: 's1', status: 'running' }),
      run({ id: '2', sessionId: 's2', status: 'pending' }),
      run({ id: '3', sessionId: 's3', status: 'awaiting_user' }),
      run({ id: '4', sessionId: 's4', status: 'completed' }),
      run({ id: '5', sessionId: 's5', status: 'failed' }),
    ]
    const out = selectDashboardRuns(runs, [], [], NOW)
    expect(out.running.map((r) => r.id)).toEqual(['1', '2'])
    expect(out.awaiting.map((r) => r.id)).toEqual(['3'])
  })

  it('drops sub-agent runs (parentRunId set) — only top-level runs show on the dashboard', () => {
    const runs = [
      run({ id: '1', sessionId: 's1', status: 'running' }),
      run({ id: '2', sessionId: 's1', status: 'running', parentRunId: '1' }),
    ]
    const out = selectDashboardRuns(runs, [], [], NOW)
    expect(out.running.map((r) => r.id)).toEqual(['1'])
  })

  it('sorts running newest-first by startedAt', () => {
    const runs = [
      run({ id: 'old', sessionId: 's1', status: 'running', startedAt: NOW - 10_000 }),
      run({ id: 'new', sessionId: 's2', status: 'running', startedAt: NOW - 1_000 }),
    ]
    const out = selectDashboardRuns(runs, [], [], NOW)
    expect(out.running.map((r) => r.id)).toEqual(['new', 'old'])
  })

  it('joins session cwd + agentType and maps agentType via teamOptions', () => {
    const runs = [run({ id: '1', sessionId: 's1', status: 'running' })]
    const sessions = [
      session({ id: 's1', cwd: '/repo/x', agentType: 'team-a' }),
    ]
    const teamOptions = [
      { id: 'ceo', label: '默认 Agent' },
      { id: 'team-a', label: '团队 A' },
    ]
    const out = selectDashboardRuns(runs, sessions, teamOptions, NOW)
    expect(out.running[0]).toMatchObject({ cwd: '/repo/x', agentLabel: '团队 A' })
  })

  it('falls back to the raw agentType id when no teamOption matches', () => {
    const runs = [run({ id: '1', sessionId: 's1', status: 'running' })]
    const sessions = [session({ id: 's1', agentType: 'unknown' })]
    const out = selectDashboardRuns(runs, sessions, [], NOW)
    expect(out.running[0].agentLabel).toBe('unknown')
  })

  it('computes wallMs from now - startedAt', () => {
    const runs = [run({ id: '1', sessionId: 's1', status: 'running', startedAt: NOW - 60_000 })]
    const out = selectDashboardRuns(runs, [], [], NOW)
    expect(out.running[0].wallMs).toBe(60_000)
  })

  it('derives step progress `${completed}/${total}` from plan, null when no plan', () => {
    const withPlan = run({
      id: '1',
      sessionId: 's1',
      status: 'running',
      plan: [
        { status: 'completed', content: 'a' },
        { status: 'in_progress', content: 'b' },
        { status: 'pending', content: 'c' },
      ] as RunRecord['plan'],
    })
    const noPlan = run({ id: '2', sessionId: 's2', status: 'running' })
    const out = selectDashboardRuns([withPlan, noPlan], [], [], NOW)
    expect(out.running[0].steps).toBe('1/3')
    expect(out.running[1].steps).toBeNull()
  })
})
```

- [ ] **Step 2: Run test to verify it fails**

```bash
pnpm --filter desktop exec vitest run src/renderer/src/lib/dashboard-runs.test.ts
```
Expected: FAIL — "Failed to resolve import '@/lib/dashboard-runs'".

- [ ] **Step 3: Write the selector**

Create `apps/desktop/src/renderer/src/lib/dashboard-runs.ts`:

```ts
// Pure selector turning the global RunRecord cache + sessions store into the
// rows the dashboard's 进行中 section renders. Top-level runs only (sub-agents
// are nested inside their parent's transcript). Running/pending → `running`;
// awaiting_user → `awaiting` (amber approval cards). Sorted newest-first.
//
// Counting rule (locked in the spec): "running" = pending+running only;
// awaiting_user renders in the section but does NOT count toward the headline.

import type { RunRecord, RunStatus } from '@shared/lib/apply-event'
import type { PlanTodo, SessionSummary } from '@swarm/protocol'

export type TeamOption = { id: string; label: string }

export type DashboardRun = {
  id: string
  sessionId: string
  goal: string
  status: RunStatus
  /** Elapsed wall time in ms (now - startedAt); ticks via useNow. */
  wallMs: number
  /** Joined from SessionSummary.cwd via sessionId; undefined when no session match. */
  cwd: string | undefined
  /** Display label for the entry agent (team head), resolved via teamOptions. */
  agentLabel: string | undefined
  /** `"${completed}/${total}"` plan progress, or null when the run has no plan. */
  steps: string | null
}

const ACTIVE_RUNNING: ReadonlySet<RunStatus> = new Set(['pending', 'running'])

export function selectDashboardRuns(
  runs: RunRecord[],
  sessions: SessionSummary[],
  teamOptions: TeamOption[],
  now: number,
): { running: DashboardRun[]; awaiting: DashboardRun[] } {
  const cwdBySession = new Map(sessions.map((s) => [s.id, s.cwd]))
  const agentBySession = new Map(sessions.map((s) => [s.id, s.agentType]))
  const labelByAgent = new Map(teamOptions.map((t) => [t.id, t.label]))

  const toRow = (r: RunRecord): DashboardRun => {
    const agentType = agentBySession.get(r.sessionId)
    return {
      id: r.id,
      sessionId: r.sessionId,
      goal: r.goal,
      status: r.status,
      wallMs: now - r.startedAt,
      cwd: cwdBySession.get(r.sessionId),
      agentLabel: agentType ? (labelByAgent.get(agentType) ?? agentType) : undefined,
      steps: planSteps(r.plan),
    }
  }

  // Top-level runs only (sub-agents carry parentRunId and render inside the
  // parent's transcript, not as their own dashboard cards).
  const topLevel = runs.filter((r) => !r.parentRunId)
  const running = topLevel
    .filter((r) => ACTIVE_RUNNING.has(r.status))
    .sort((a, b) => b.startedAt - a.startedAt)
    .map(toRow)
  const awaiting = topLevel
    .filter((r) => r.status === 'awaiting_user')
    .sort((a, b) => b.startedAt - a.startedAt)
    .map(toRow)

  return { running, awaiting }
}

// `"${completed}/${total}"` step progress, matching PlanStatusBar's semantics.
// Returns null when there is no plan (or it is empty) so cards can omit it.
function planSteps(plan: PlanTodo[] | undefined): string | null {
  if (!plan || plan.length === 0) return null
  const completed = plan.filter((t) => t.status === 'completed').length
  return `${completed}/${plan.length}`
}
```

- [ ] **Step 4: Run test to verify it passes**

```bash
pnpm --filter desktop exec vitest run src/renderer/src/lib/dashboard-runs.test.ts
```
Expected: PASS (7 tests).

- [ ] **Step 5: Commit**

```bash
git add apps/desktop/src/renderer/src/lib/dashboard-runs.ts apps/desktop/src/renderer/src/lib/dashboard-runs.test.ts
git commit -m "feat(ui): add selectDashboardRuns selector for the 进行中 section"
```

---

## Task 4: `selectDashboardCron` selector + tests (TDD)

**Files:**
- Create: `apps/desktop/src/renderer/src/lib/dashboard-cron.ts`
- Create: `apps/desktop/src/renderer/src/lib/dashboard-cron.test.ts`

**Type reference (verified):**
- `ScheduledTask` (`@swarm/protocol`) = `CronJobSummary & { sessionTitle, originSessionTitle }`
- `CronJobSummary`: `{ id, sessionId, originSessionId, name: string|null, cron, goal, createdAt, lastRunAt: number|null, nextRun: number|null }`
- `CronRun`: `{ id, jobId, sessionId, taskId: string|null, status: string, triggeredAt, endedAt: number|null, error: string|null }`

- [ ] **Step 1: Write the failing test**

Create `apps/desktop/src/renderer/src/lib/dashboard-cron.test.ts`:

```ts
import type { CronRun, ScheduledTask } from '@swarm/protocol'
import { describe, expect, it } from 'vitest'

import { selectDashboardCron } from '@/lib/dashboard-cron'

const NOW = Date.UTC(2026, 5, 5, 9, 0, 0)
const DAY = 86_400_000

const job = (over: Partial<ScheduledTask> & Pick<ScheduledTask, 'id'>): ScheduledTask => ({
  sessionId: 's1',
  originSessionId: 's1',
  name: 'n',
  cron: '0 9 * * *',
  goal: 'g',
  createdAt: NOW - 10 * DAY,
  lastRunAt: null,
  nextRun: null,
  sessionTitle: null,
  originSessionTitle: null,
  ...over,
})
const cronRun = (over: Partial<CronRun> & Pick<CronRun, 'id' | 'jobId'>): CronRun => ({
  sessionId: 's1',
  taskId: null,
  status: 'completed',
  triggeredAt: NOW - DAY,
  endedAt: NOW - DAY + 60_000,
  error: null,
  ...over,
})

describe('selectDashboardCron', () => {
  it('sorts by nextRun ascending (nulls last) and limits to 5', () => {
    const jobs = [
      job({ id: 'j-null', nextRun: null }),
      job({ id: 'j-late', nextRun: NOW + 3 * DAY }),
      job({ id: 'j-soon', nextRun: NOW + DAY }),
      job({ id: 'j-now', nextRun: NOW + 60_000 }),
    ]
    const out = selectDashboardCron(jobs, [], NOW)
    expect(out.rows.map((r) => r.id)).toEqual(['j-now', 'j-soon', 'j-late', 'j-null'])
  })

  it('limits to 5 rows', () => {
    const jobs = Array.from({ length: 8 }, (_, i) => job({ id: `j${i}`, nextRun: NOW + i * 60_000 }))
    expect(selectDashboardCron(jobs, [], NOW).rows).toHaveLength(5)
  })

  it('shows "上次成功" (green) when the job has a completed last run', () => {
    const jobs = [job({ id: 'j1', lastRunAt: NOW - DAY, nextRun: NOW + DAY })]
    const runs = [cronRun({ id: 'r1', jobId: 'j1', status: 'completed', triggeredAt: NOW - DAY })]
    const out = selectDashboardCron(jobs, runs, NOW)
    expect(out.rows[0].statusKind).toBe('success')
    expect(out.rows[0].statusLabel).toBe('上次成功')
  })

  it('shows "上次失败" (failed) when the job has a non-completed last run', () => {
    const jobs = [job({ id: 'j1', lastRunAt: NOW - DAY, nextRun: NOW + DAY })]
    const runs = [cronRun({ id: 'r1', jobId: 'j1', status: 'error', triggeredAt: NOW - DAY })]
    const out = selectDashboardCron(jobs, runs, NOW)
    expect(out.rows[0].statusKind).toBe('failed')
    expect(out.rows[0].statusLabel).toBe('上次失败')
  })

  it('shows "X 天后" (pending) when there is no past run', () => {
    const jobs = [job({ id: 'j1', lastRunAt: null, nextRun: NOW + 3 * DAY })]
    const out = selectDashboardCron(jobs, [], NOW)
    expect(out.rows[0].statusKind).toBe('pending')
    expect(out.rows[0].statusLabel).toBe('3 天后')
  })

  it('shows "明天" for a next-run 1 day out with no past run', () => {
    const jobs = [job({ id: 'j1', lastRunAt: null, nextRun: NOW + DAY })]
    expect(selectDashboardCron(jobs, [], NOW).rows[0].statusLabel).toBe('明天')
  })

  it('picks the most recent run per job for the status (newest triggeredAt)', () => {
    const jobs = [job({ id: 'j1', lastRunAt: NOW - 60_000, nextRun: NOW + DAY })]
    const runs = [
      cronRun({ id: 'old', jobId: 'j1', status: 'completed', triggeredAt: NOW - 2 * DAY }),
      cronRun({ id: 'new', jobId: 'j1', status: 'error', triggeredAt: NOW - 60_000 }),
    ]
    expect(selectDashboardCron(jobs, runs, NOW).rows[0].statusKind).toBe('failed')
  })
})
```

- [ ] **Step 2: Run test to verify it fails**

```bash
pnpm --filter desktop exec vitest run src/renderer/src/lib/dashboard-cron.test.ts
```
Expected: FAIL — "Failed to resolve import '@/lib/dashboard-cron'".

- [ ] **Step 3: Write the selector**

Create `apps/desktop/src/renderer/src/lib/dashboard-cron.ts`:

```ts
// Pure selector for the dashboard's 定时任务 section. Sorts upcoming jobs by
// nextRun, limits to 5, and derives a per-row status from the most recent past
// CronRun (success/failed) or, with no past runs, a countdown to nextRun.

import type { CronRun, ScheduledTask } from '@swarm/protocol'
import { orderBy } from 'es-toolkit'

export type CronStatusKind = 'success' | 'failed' | 'pending'

export type DashboardCronRow = {
  id: string
  /** Display name: job.name (preferred) → goal (fallback). */
  name: string
  /** Localized next-run label, e.g. "每天 9:00" / "周一 8:30" / "明天". */
  timeLabel: string
  statusKind: CronStatusKind
  statusLabel: string
}

const DAY = 86_400_000

export function selectDashboardCron(
  jobs: ScheduledTask[],
  runs: CronRun[],
  now: number,
): { rows: DashboardCronRow[] } {
  // Most recent run per job (by triggeredAt) → status/error lookup.
  const latestRunByJob = new Map<string, CronRun>()
  for (const r of runs) {
    const cur = latestRunByJob.get(r.jobId)
    if (!cur || r.triggeredAt > cur.triggeredAt) latestRunByJob.set(r.jobId, r)
  }

  // Sort: jobs with a nextRun ascending first; null nextRuns last. Use Number
  // max-safe as the sort key for nulls so they sink below all real timestamps.
  const sorted = orderBy(
    jobs,
    [(j) => j.nextRun ?? Number.MAX_SAFE_INTEGER],
    ['asc'],
  )

  const rows = sorted.slice(0, 5).map((j): DashboardCronRow => {
    const name = j.name ?? j.goal
    const latest = j.lastRunAt != null ? latestRunByJob.get(j.id) : undefined
    let statusKind: CronStatusKind
    let statusLabel: string
    if (latest) {
      const ok = latest.status === 'completed'
      statusKind = ok ? 'success' : 'failed'
      statusLabel = ok ? '上次成功' : '上次失败'
    } else {
      statusKind = 'pending'
      statusLabel = countdownLabel(j.nextRun, now)
    }
    return { id: j.id, name, timeLabel: timeLabelFor(j), statusKind, statusLabel }
  })

  return { rows }
}

// Render a cron job's schedule as a human label. Phase 2 keeps this lightweight:
// prefer nextRun-derived weekday+time; fall back to the raw cron expression.
// (A full cron→human parser is out of scope — the design mockups show simple
// daily/weekly schedules; if a complex expression appears, show it verbatim.)
function timeLabelFor(j: ScheduledTask): string {
  if (j.nextRun != null) return weekdayTimeLabel(j.nextRun)
  return j.cron
}

function weekdayTimeLabel(ts: number): string {
  const d = new Date(ts)
  const weekdays = ['周日', '周一', '周二', '周三', '周四', '周五', '周六']
  const hh = String(d.getHours()).padStart(2, '0')
  const mm = String(d.getMinutes()).padStart(2, '0')
  return `${weekdays[d.getDay()]} ${hh}:${mm}`
}

function countdownLabel(nextRun: number | null, now: number): string {
  if (nextRun == null) return '待调度'
  const diff = nextRun - now
  if (diff < DAY) return '即将运行'
  const days = Math.floor(diff / DAY)
  if (days === 1) return '明天'
  return `${days} 天后`
}
```

- [ ] **Step 4: Run test to verify it passes**

```bash
pnpm --filter desktop exec vitest run src/renderer/src/lib/dashboard-cron.test.ts
```
Expected: PASS (7 tests).

- [ ] **Step 5: Commit**

```bash
git add apps/desktop/src/renderer/src/lib/dashboard-cron.ts apps/desktop/src/renderer/src/lib/dashboard-cron.test.ts
git commit -m "feat(ui): add selectDashboardCron selector for the 定时任务 section"
```

---

## Task 5: `selectDashboardRecent` selector + tests (TDD)

**Files:**
- Create: `apps/desktop/src/renderer/src/lib/dashboard-recent.ts`
- Create: `apps/desktop/src/renderer/src/lib/dashboard-recent.test.ts`

- [ ] **Step 1: Write the failing test**

Create `apps/desktop/src/renderer/src/lib/dashboard-recent.test.ts`:

```ts
import type { SessionSummary } from '@swarm/protocol'
import { describe, expect, it } from 'vitest'

import { selectDashboardRecent } from '@/lib/dashboard-recent'

const NOW = 1_000_000
const session = (over: Partial<SessionSummary> & Pick<SessionSummary, 'id'>): SessionSummary => ({
  title: 't',
  status: 'ended',
  lastActiveAt: NOW,
  taskCount: 0,
  pinned: false,
  sortOrder: 0,
  isSystem: false,
  ...over,
})

describe('selectDashboardRecent', () => {
  it('keeps only ended sessions, sorted by lastActiveAt desc, top 5', () => {
    const sessions = [
      session({ id: 'active', status: 'active', lastActiveAt: NOW + 1 }),
      session({ id: 'old', status: 'ended', lastActiveAt: NOW - 10_000 }),
      session({ id: 'new', status: 'ended', lastActiveAt: NOW - 1_000 }),
      session({ id: 'interrupted', status: 'interrupted', lastActiveAt: NOW }),
    ]
    const out = selectDashboardRecent(sessions)
    expect(out.rows.map((r) => r.id)).toEqual(['new', 'old'])
  })

  it('carries lastActiveAt through to the row (for relative-time formatting)', () => {
    const sessions = [session({ id: 's1', status: 'ended', lastActiveAt: NOW - 5_000 })]
    expect(selectDashboardRecent(sessions).rows[0].lastActiveAt).toBe(NOW - 5_000)
  })

  it('limits to 5', () => {
    const sessions = Array.from({ length: 8 }, (_, i) =>
      session({ id: `s${i}`, status: 'ended', lastActiveAt: NOW - i }),
    )
    expect(selectDashboardRecent(sessions).rows).toHaveLength(5)
  })

  it('falls back to "未命名任务" when title is null', () => {
    const sessions = [session({ id: 's1', status: 'ended', title: null })]
    expect(selectDashboardRecent(sessions).rows[0].name).toBe('未命名任务')
  })

  it('excludes the system session', () => {
    const sessions = [
      session({ id: 'sys', status: 'ended', isSystem: true }),
      session({ id: 'real', status: 'ended' }),
    ]
    expect(selectDashboardRecent(sessions).rows.map((r) => r.id)).toEqual(['real'])
  })
})
```

- [ ] **Step 2: Run test to verify it fails**

```bash
pnpm --filter desktop exec vitest run src/renderer/src/lib/dashboard-recent.test.ts
```
Expected: FAIL — "Failed to resolve import '@/lib/dashboard-recent'".

- [ ] **Step 3: Write the selector**

Create `apps/desktop/src/renderer/src/lib/dashboard-recent.ts`:

```ts
// Pure selector for the dashboard's 最近完成 section. Approximates "recently
// completed tasks" with recently-ended *sessions* (per the spec's locked
// decision: no per-task IPC in Phase 2). Excludes the system (cron) session.
//
// Phase-2 limitation (documented): a session shows as one row regardless of how
// many tasks it ran; the success icon is always green because SessionSummary
// carries no per-session success/failure flag. Per-task granularity needs a new
// IPC and is deferred.

import type { SessionSummary } from '@swarm/protocol'

export type DashboardRecentRow = {
  id: string
  name: string
  /** The session's lastActiveAt, carried through for relative-time formatting in the view. */
  lastActiveAt: number
}

export function selectDashboardRecent(
  sessions: SessionSummary[],
): { rows: DashboardRecentRow[] } {
  const rows = sessions
    .filter((s) => s.status === 'ended' && !s.isSystem)
    .sort((a, b) => b.lastActiveAt - a.lastActiveAt)
    .slice(0, 5)
    .map((s) => ({ id: s.id, name: s.title ?? '未命名任务', lastActiveAt: s.lastActiveAt }))
  return { rows }
}
```

- [ ] **Step 4: Run test to verify it passes**

```bash
pnpm --filter desktop exec vitest run src/renderer/src/lib/dashboard-recent.test.ts
```
Expected: PASS (5 tests).

- [ ] **Step 5: Commit**

```bash
git add apps/desktop/src/renderer/src/lib/dashboard-recent.ts apps/desktop/src/renderer/src/lib/dashboard-recent.test.ts
git commit -m "feat(ui): add selectDashboardRecent selector for the 最近完成 section"
```

---

## Task 6: Narrow `isConversationScene` to `/session/*` (hide SessionPanel on `/`)

**Files:**
- Modify: `apps/desktop/src/renderer/src/components/rail-config.ts`
- Modify: `apps/desktop/src/renderer/src/components/rail-config.test.ts`

- [ ] **Step 1: Update the test first (TDD)**

In `apps/desktop/src/renderer/src/components/rail-config.test.ts`, find the `describe('isConversationScene', ...)` block and replace it so `/` is NO longer a conversation scene:

```ts
describe('isConversationScene', () => {
  it('is true only on session routes (NOT the home route, which is the dashboard)', () => {
    expect(isConversationScene('/')).toBe(false)
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
```

- [ ] **Step 2: Run test to verify it fails**

```bash
pnpm --filter desktop exec vitest run src/renderer/src/components/rail-config.test.ts
```
Expected: FAIL — the `expect(isConversationScene('/')).toBe(false)` assertion fails (current impl returns true).

- [ ] **Step 3: Update the implementation**

In `apps/desktop/src/renderer/src/components/rail-config.ts`, change `isConversationScene` and its comment:

```ts
// A scene where the conversation surface (and thus the session list) is the
// focus: any path under /session/. The home route '/' is the dashboard (full
// width, no list), so it is NOT a conversation scene. SessionPanel renders iff
// true.
export function isConversationScene(pathname: string): boolean {
  return pathname.startsWith('/session/')
}
```

- [ ] **Step 4: Run test to verify it passes**

```bash
pnpm --filter desktop exec vitest run src/renderer/src/components/rail-config.test.ts
```
Expected: PASS (all tests, now 11 with the updated cases — count may differ if the original two `it` blocks merged into the new shape; just confirm all green).

- [ ] **Step 5: Type-check**

```bash
pnpm --filter desktop run typecheck:web
```
Expected: no errors.

- [ ] **Step 6: Commit**

```bash
git add apps/desktop/src/renderer/src/components/rail-config.ts apps/desktop/src/renderer/src/components/rail-config.test.ts
git commit -m "refactor(ui): hide SessionPanel on the home route (dashboard is full-width)"
```

---

## Task 7: `RunningCard` component

**Files:**
- Create: `apps/desktop/src/renderer/src/components/views/dashboard/running-card.tsx`

- [ ] **Step 1: Create the component**

Create `apps/desktop/src/renderer/src/components/views/dashboard/running-card.tsx`:

```tsx
// One card in the dashboard's 进行中 wall. Two visual modes:
//   - running/pending → blue dot + elapsed wall time
//   - awaiting_user   → amber border/ring + inline 允许/拒绝 buttons
// Clicking the card opens its session; the approve/reject buttons stop
// propagation so they resolve inline without navigating.

import { useNavigate } from '@tanstack/react-router'
import { Check, X } from 'lucide-react'

import { useDecidePermission } from '@/hooks/use-runs'
import { usePermissionStore } from '@/stores/permission'
import { cn } from '@/lib/utils'
import { formatDuration } from '@/lib/scheduled-rows'
import type { DashboardRun } from '@/lib/dashboard-runs'

type Props = { run: DashboardRun }

export function RunningCard({ run }: Props): React.JSX.Element {
  const navigate = useNavigate()
  const decidePermission = useDecidePermission()
  const awaiting = run.status === 'awaiting_user'
  // The pending permission action id for this run, if any (used to decide).
  const actionId = usePermissionStore((s) => {
    const entry = Object.values(s.items).find((p) => p.sessionId === run.sessionId)
    return entry?.actionId ?? null
  })

  const open = () => navigate({ to: '/session/$sessionId', params: { sessionId: run.sessionId } })

  const decide = (decision: 'grant' | 'deny') => (e: React.MouseEvent) => {
    e.stopPropagation()
    if (actionId) decidePermission.mutate({ sessionId: run.sessionId, actionId, decision })
  }

  return (
    // The whole card is a click target → session. Buttons inside stopPropagation.
    <button
      className={cn(
        'flex w-full flex-col gap-2.5 rounded-2xl border bg-card p-4 text-left transition-colors hover:bg-accent/30',
        awaiting ? 'border-amber-400 shadow-[0_0_0_3px_rgba(226,176,107,0.14)]' : 'border-border',
      )}
      onClick={open}
      type="button"
    >
      <div className="flex items-center gap-1.5">
        <span
          className={cn(
            'size-[7px] rounded-full',
            awaiting ? 'bg-amber-500' : 'bg-primary shadow-[0_0_0_3px_rgba(52,120,246,0.18)]',
          )}
        />
        <span className={cn('text-[11.5px] font-medium', awaiting ? 'text-amber-600' : 'text-primary')}>
          {awaiting ? '等待审批' : `运行中 · ${formatDuration(run.wallMs)}`}
        </span>
      </div>

      <h3 className="line-clamp-1 font-semibold text-[14px] text-foreground">{run.goal}</h3>

      {run.steps && (
        <div className="mt-auto flex items-center justify-between text-[11.5px] text-muted-foreground">
          <span className="truncate">{run.cwd ?? run.agentLabel ?? '—'}</span>
          <span className="ml-2 shrink-0 tabular-nums">{run.steps} 步</span>
        </div>
      )}

      {awaiting && (
        <div className="flex gap-2">
          <span
            className="flex-1 rounded-lg bg-foreground py-1.5 text-center font-semibold text-[12px] text-background"
            // biome-ignore lint/suspicious/noExplicitAny: onClick typed via decide()
            onClick={decide('grant' as any)}
            onPointerDown={(e) => e.stopPropagation()}
            role="button"
            tabIndex={0}
            onKeyDown={(e) => {
              if (e.key === 'Enter' || e.key === ' ') (e.currentTarget as HTMLElement).click()
            }}
          >
            <Check className="mr-1 inline size-3" />
            允许
          </span>
          <span
            className="flex-1 rounded-lg border border-border py-1.5 text-center font-medium text-[12px] text-muted-foreground"
            // biome-ignore lint/suspicious/noExplicitAny: onClick typed via decide()
            onClick={decide('deny' as any)}
            onPointerDown={(e) => e.stopPropagation()}
            role="button"
            tabIndex={0}
            onKeyDown={(e) => {
              if (e.key === 'Enter' || e.key === ' ') (e.currentTarget as HTMLElement).click()
            }}
          >
            <X className="mr-1 inline size-3" />
            拒绝
          </span>
        </div>
      )}
    </button>
  )
}
```

> **Note on the approve/reject affordance:** nesting interactive `<span role="button">` inside a `<button>` is technically invalid HTML (a button cannot contain another button). If the type-check or a lint rule complains, switch the OUTER `<button>` to a `<div role="button" tabIndex={0} onClick={open} onKeyDown={enter→open}>` and keep the inner `<span role="button">` children. The behavior is identical. Use whichever variant passes lint/type-check; commit only one. (Check `apps/desktop/src/renderer/src/components/permission-card.tsx` for the project's established pattern on approve/reject buttons — match it.)

- [ ] **Step 2: Inspect `permission-card.tsx` and the permission store shape**

```bash
grep -n "actionId\|sessionId\|items" apps/desktop/src/renderer/src/stores/permission.ts | head
grep -n "useDecidePermission\|onClick\|<button" apps/desktop/src/renderer/src/components/permission-card.tsx | head
```
Confirm: (a) the permission store's item shape really is `{ actionId, sessionId, ... }` (adjust the `usePermissionStore` selector if not); (b) how `permission-card.tsx` lays out its approve/deny buttons (mirror that styling/structure for consistency). Adjust the `RunningCard` accordingly before type-checking.

- [ ] **Step 3: Type-check**

```bash
pnpm --filter desktop run typecheck:web
```
Expected: no errors. (Resolve any nested-button / store-shape issues per the Note above before proceeding.)

- [ ] **Step 4: Commit**

```bash
git add apps/desktop/src/renderer/src/components/views/dashboard/running-card.tsx
git commit -m "feat(ui): add RunningCard for the 进行中 wall (running + awaiting-approval modes)"
```

---

## Task 8: `RunningCards` section (header + grid + empty state)

**Files:**
- Create: `apps/desktop/src/renderer/src/components/views/dashboard/running-cards.tsx`

- [ ] **Step 1: Create the section**

Create `apps/desktop/src/renderer/src/components/views/dashboard/running-cards.tsx`:

```tsx
// The 进行中 section: header (label + count of running/pending) and a card wall
// of running and awaiting-approval cards. Empty state when nothing is active.
//
// Count rule (locked): the header count = running.length ONLY (pending+running),
// not awaiting — matching the top-bar pill. Awaiting cards still render here.

import { RunningCard } from '@/components/views/dashboard/running-card'
import type { DashboardRun } from '@/lib/dashboard-runs'

type Props = { running: DashboardRun[]; awaiting: DashboardRun[] }

export function RunningCards({ running, awaiting }: Props): React.JSX.Element | null {
  const total = running.length + awaiting.length
  if (total === 0) {
    return (
      <section>
        <h2 className="mb-3 font-semibold text-[13px] text-foreground">进行中</h2>
        <p className="rounded-xl border border-dashed border-border bg-muted/20 px-4 py-6 text-center text-[13px] text-muted-foreground">
          暂无运行中的任务。从上方描述一个目标开始。
        </p>
      </section>
    )
  }

  return (
    <section>
      <h2 className="mb-3 flex items-baseline gap-2 font-semibold text-[13px] text-foreground">
        进行中
        <span className="text-[12px] text-muted-foreground tabular-nums">{running.length}</span>
      </h2>
      <div className="grid grid-cols-1 gap-3 sm:grid-cols-2 lg:grid-cols-3">
        {running.map((r) => (
          <RunningCard key={r.id} run={r} />
        ))}
        {awaiting.map((r) => (
          <RunningCard key={r.id} run={r} />
        ))}
      </div>
    </section>
  )
}
```

- [ ] **Step 2: Type-check**

```bash
pnpm --filter desktop run typecheck:web
```
Expected: no errors.

- [ ] **Step 3: Commit**

```bash
git add apps/desktop/src/renderer/src/components/views/dashboard/running-cards.tsx
git commit -m "feat(ui): add RunningCards section with empty state"
```

---

## Task 9: `ScheduledList` section

**Files:**
- Create: `apps/desktop/src/renderer/src/components/views/dashboard/scheduled-list.tsx`

- [ ] **Step 1: Create the section**

Create `apps/desktop/src/renderer/src/components/views/dashboard/scheduled-list.tsx`:

```tsx
// The 定时任务 section: a card of upcoming cron jobs (next-run time + name +
// status). "查看日历 →" links to /scheduled. Empty state when no jobs exist.

import { useNavigate } from '@tanstack/react-router'
import { ArrowRight } from 'lucide-react'

import type { DashboardCronRow } from '@/lib/dashboard-cron'
import { cn } from '@/lib/utils'

type Props = { rows: DashboardCronRow[] }

const STATUS_TONE: Record<DashboardCronRow['statusKind'], string> = {
  success: 'text-emerald-600',
  failed: 'text-red-500',
  pending: 'text-muted-foreground',
}

export function ScheduledList({ rows }: Props.JSX.Element | null {
  const navigate = useNavigate()

  if (rows.length === 0) {
    return (
      <section>
        <h2 className="mb-3 font-semibold text-[13px] text-foreground">定时任务</h2>
        <p className="rounded-xl border border-border bg-card px-4 py-6 text-center text-[13px] text-muted-foreground">
          暂无定时任务。在「对话」中创建一个定时任务后会显示在这里。
        </p>
      </section>
    )
  }

  return (
    <section>
      <h2 className="mb-3 flex items-baseline gap-2 font-semibold text-[13px] text-foreground">
        定时任务
        <button
          className="ml-auto flex items-center gap-1 font-medium text-[12px] text-primary hover:underline"
          onClick={() => navigate({ to: '/scheduled' })}
          type="button"
        >
          查看日历
          <ArrowRight className="size-3" />
        </button>
      </h2>
      <ul className="overflow-hidden rounded-xl border border-border bg-card">
        {rows.map((r, i) => (
          <li
            className={cn(
              'flex items-center gap-2.5 px-4 py-3',
              i < rows.length - 1 && 'border-b border-border/60',
            )}
            key={r.id}
          >
            <span className="w-16 shrink-0 font-mono text-[12px] text-muted-foreground">
              {r.timeLabel}
            </span>
            <span className="min-w-0 flex-1 truncate text-[13px] text-foreground">{r.name}</span>
            <span className={cn('shrink-0 text-[11.5px]', STATUS_TONE[r.statusKind])}>
              {r.statusLabel}
            </span>
          </li>
        ))}
      </ul>
    </section>
  )
}
```

> **Fix before type-check:** the `Props` line has a typo (`}: Props.JSX.Element` should be `}: Props): React.JSX.Element`). Correct it:
> ```tsx
> export function ScheduledList({ rows }: Props): React.JSX.Element | null {
> ```

- [ ] **Step 2: Apply the typo fix above, then type-check**

```bash
pnpm --filter desktop run typecheck:web
```
Expected: no errors.

- [ ] **Step 3: Commit**

```bash
git add apps/desktop/src/renderer/src/components/views/dashboard/scheduled-list.tsx
git commit -m "feat(ui): add ScheduledList section for 定时任务"
```

---

## Task 10: `RecentList` section

**Files:**
- Create: `apps/desktop/src/renderer/src/components/views/dashboard/recent-list.tsx`

- [ ] **Step 1: Create the section**

Create `apps/desktop/src/renderer/src/components/views/dashboard/recent-list.tsx`:

```tsx
// The 最近完成 section: recently-ended sessions as rows (green check + name +
// relative time). Clicking a row reopens the session. Empty state when none.

import { useNavigate } from '@tanstack/react-router'
import { Check } from 'lucide-react'

import { formatRelativeTime } from '@/lib/format-time'
import type { DashboardRecentRow } from '@/lib/dashboard-recent'
import { cn } from '@/lib/utils'

type Props = { rows: DashboardRecentRow[]; now: number }

export function RecentList({ rows, now }: Props): React.JSX.Element | null {
  const navigate = useNavigate()

  if (rows.length === 0) {
    return (
      <section>
        <h2 className="mb-3 font-semibold text-[13px] text-foreground">最近完成</h2>
        <p className="rounded-xl border border-border bg-card px-4 py-6 text-center text-[13px] text-muted-foreground">
          还没有完成的任务。完成的会话会显示在这里。
        </p>
      </section>
    )
  }

  return (
    <section>
      <h2 className="mb-3 font-semibold text-[13px] text-foreground">最近完成</h2>
      <ul className="overflow-hidden rounded-xl border border-border bg-card">
        {rows.map((r, i) => (
          <li
            className={cn(
              'flex items-center gap-2.5 px-4 py-3',
              i < rows.length - 1 && 'border-b border-border/60',
            )}
            key={r.id}
          >
            <button
              className="flex w-full items-center gap-2.5 text-left"
              onClick={() => navigate({ to: '/session/$sessionId', params: { sessionId: r.id } })}
              type="button"
            >
              <span className="flex size-3.5 shrink-0 items-center justify-center">
                <Check className="size-3.5 stroke-[2.4px] text-emerald-600" />
              </span>
              <span className="min-w-0 flex-1 truncate text-[13px] text-foreground">{r.name}</span>
              <span className="shrink-0 text-[11.5px] text-muted-foreground">
                {formatRelativeTime(r.lastActiveAt, now)}
              </span>
            </button>
          </li>
        ))}
      </ul>
    </section>
  )
}
```

(`DashboardRecentRow.lastActiveAt` is already on the type from Task 5 — no extra wiring needed.)

- [ ] **Step 2: Type-check**

```bash
pnpm --filter desktop run typecheck:web
```
Expected: no errors.

- [ ] **Step 3: Commit**

```bash
git add apps/desktop/src/renderer/src/components/views/dashboard/recent-list.tsx
git commit -m "feat(ui): add RecentList section for 最近完成"
```

---

## Task 11: `DashboardTopbar` (slim top bar)

**Files:**
- Create: `apps/desktop/src/renderer/src/components/views/dashboard/dashboard-topbar.tsx`

- [ ] **Step 1: Inspect how the search dialog opens**

```bash
grep -n "useSearchDialog\|openSearch\|open.*search\|SessionSearchDialog" apps/desktop/src/renderer/src/stores/search-dialog.ts apps/desktop/src/renderer/src/components/session-list.tsx | head
```
Identify the store hook + action that opens `SessionSearchDialog` (likely `useSearchDialog((s) => s.open)` or similar). Use it in the top bar's search button.

- [ ] **Step 2: Create the component**

Create `apps/desktop/src/renderer/src/components/views/dashboard/dashboard-topbar.tsx` (adjust the search-hook import to match Step 1's finding):

```tsx
// Slim dashboard top bar: section title, a "运行中" pill (running/pending
// count), and a search button that opens the global session search (⌘K).

import { useSearchDialog } from '@/stores/search-dialog'

type Props = { runningCount: number }

export function DashboardTopbar({ runningCount }: Props): React.JSX.Element {
  const openSearch = useSearchDialog((s) => s.open)

  return (
    <div className="flex h-13 shrink-0 items-center gap-2.5 px-7">
      <h1 className="font-semibold text-[13px] text-muted-foreground">任务台</h1>
      <div className="ml-auto flex items-center gap-2">
        {runningCount > 0 && (
          <span className="flex items-center gap-1.5 rounded-full bg-primary/10 px-3 py-1 font-medium text-[12px] text-primary">
            <span className="size-1.5 rounded-full bg-primary" />
            {runningCount} 个运行中
          </span>
        )}
        <button
          className="flex items-center gap-1.5 rounded-lg border border-border px-2.5 py-1 text-[12px] text-muted-foreground transition-colors hover:bg-accent/30"
          onClick={openSearch}
          type="button"
        >
          搜索
          <kbd className="rounded bg-muted px-1.5 py-0.5 font-mono text-[10.5px]">⌘K</kbd>
        </button>
      </div>
    </div>
  )
}
```

> **Adjust the import** if the search store's hook name differs from `useSearchDialog` (Step 1 told you the exact name). The `(s) => s.open` selector assumes an `open` action; confirm against the store.

- [ ] **Step 3: Type-check**

```bash
pnpm --filter desktop run typecheck:web
```
Expected: no errors.

- [ ] **Step 4: Commit**

```bash
git add apps/desktop/src/renderer/src/components/views/dashboard/dashboard-topbar.tsx
git commit -m "feat(ui): add DashboardTopbar with running pill + search button"
```

---

## Task 12: `HomeDashboard` view (compose everything)

**Files:**
- Create: `apps/desktop/src/renderer/src/components/views/home-dashboard.tsx`

- [ ] **Step 1: Create the view**

Create `apps/desktop/src/renderer/src/components/views/home-dashboard.tsx`:

```tsx
// The 任务台 dashboard (Phase 2). Replaces HomeComposer on `/`. Composes the
// slim top bar, the hero composer (reusing <ChatInput> unchanged inside a new
// shell), and the three live sections — 进行中 card wall, 定时任务, 最近完成.
//
// All data comes from existing caches (useRuns, useAllCronJobs, useAllCronRuns)
// and the sessions store; the dashboard itself owns no new fetch. The single
// useNow tick drives elapsed wall time + cron countdowns at 30s granularity.

import { providerViewById } from '@swarm/protocol'
import { useNavigate } from '@tanstack/react-router'

import { ChatInput } from '@/components/chat-input'
import { DashboardTopbar } from '@/components/views/dashboard/dashboard-topbar'
import { RecentList } from '@/components/views/dashboard/recent-list'
import { RunningCards } from '@/components/views/dashboard/running-cards'
import { ScheduledList } from '@/components/views/dashboard/scheduled-list'
import { useNow } from '@/hooks/use-now'
import { useTeamOptions } from '@/hooks/use-agents'
import { useProviders } from '@/hooks/use-providers'
import { useAllCronJobs, useAllCronRuns } from '@/hooks/use-cron'
import { useRuns, useSubmitGoal } from '@/hooks/use-runs'
import { selectDashboardCron } from '@/lib/dashboard-cron'
import { selectDashboardRecent } from '@/lib/dashboard-recent'
import { selectDashboardRuns } from '@/lib/dashboard-runs'
import { useComposerDefaults } from '@/stores/composer-defaults'
import { useSessionsStore } from '@/stores/sessions'

export function HomeDashboard(): React.JSX.Element {
  const navigate = useNavigate()
  const submitGoal = useSubmitGoal()
  const { ready, state } = useProviders()
  const now = useNow(30_000)

  // Composer defaults (same pattern as the old HomeComposer — persisted controls
  // carried into the first turn, then the session owns its own copy).
  const cwd = useComposerDefaults((s) => s.cwd)
  const setCwd = useComposerDefaults((s) => s.setCwd)
  const permissionMode = useComposerDefaults((s) => s.permissionMode)
  const setPermissionMode = useComposerDefaults((s) => s.setPermissionMode)
  const executionMode = useComposerDefaults((s) => s.executionMode)
  const setExecutionMode = useComposerDefaults((s) => s.setExecutionMode)
  const agentType = useComposerDefaults((s) => s.agentType)
  const setAgentType = useComposerDefaults((s) => s.setAgentType)
  const teamOptions = useTeamOptions()

  // Dashboard data.
  const runs = useRuns()
  const sessions = useSessionsStore((s) => s.sessions)
  const cronJobs = useAllCronJobs().data ?? []
  const cronRuns = useAllCronRuns().data ?? []

  const { running, awaiting } = selectDashboardRuns(runs, sessions, teamOptions, now)
  const { rows: cronRows } = selectDashboardCron(cronJobs, cronRuns, now)
  const { rows: recentRows } = selectDashboardRecent(sessions)

  return (
    <div className="flex h-full flex-col">
      <DashboardTopbar runningCount={running.length} />

      <div className="mx-auto flex w-full max-w-[1088px] flex-1 flex-col gap-7 overflow-hidden px-6 py-5">
        {/* Composer */}
        <section className="flex flex-col gap-4">
          <h2 className="font-semibold text-[26px] tracking-tight text-foreground">
            今天想让 swarm 做点什么?
          </h2>
          <div className="rounded-2xl border border-border bg-card p-4 shadow-sm">
            <ChatInput
              agentType={agentType}
              cwd={cwd}
              disabled={!ready}
              executionMode={executionMode}
              onAgentTypeChange={setAgentType}
              onCwdChange={setCwd}
              onExecutionModeChange={setExecutionMode}
              onPermissionModeChange={setPermissionMode}
              onSubmit={async (goal, attachments) => {
                if (!ready) return
                const { sessionId } = await submitGoal.mutateAsync({
                  goal,
                  attachments,
                  options: { cwd, permissionMode, executionMode, agentType },
                })
                void navigate({ to: '/session/$sessionId', params: { sessionId } })
              }}
              permissionMode={permissionMode}
              placeholder="描述一个目标,或按 ⌘⏎ 从剪贴板开始…"
              supportsImages={!!providerViewById(state, state.active)?.supportsImages}
              teamOptions={teamOptions}
            />
          </div>
        </section>

        {/* 进行中 */}
        <RunningCards awaiting={awaiting} running={running} />

        {/* 定时任务 + 最近完成 */}
        <div className="grid grid-cols-1 gap-6 lg:grid-cols-2">
          <ScheduledList rows={cronRows} />
          <RecentList now={now} rows={recentRows} />
        </div>
      </div>
    </div>
  )
}
```

- [ ] **Step 2: Type-check**

```bash
pnpm --filter desktop run typecheck:web
```
Expected: no errors. (Watch for `ChatInput` prop mismatches vs Task 7's verified signature; the props used here match `home-composer.tsx` exactly, which already compiles.)

- [ ] **Step 3: Commit**

```bash
git add apps/desktop/src/renderer/src/components/views/home-dashboard.tsx
git commit -m "feat(ui): add HomeDashboard view composing the 任务台 dashboard"
```

---

## Task 13: Wire `HomeDashboard` into the `/` route + delete `HomeComposer`

**Files:**
- Modify: `apps/desktop/src/renderer/src/routes/index.tsx`
- Delete: `apps/desktop/src/renderer/src/components/views/home-composer.tsx`

- [ ] **Step 1: Confirm `HomeComposer` has no other importers**

```bash
grep -rn "home-composer\|HomeComposer" apps/desktop/src
```
Expected: hits only in `routes/index.tsx` (import + usage) and the `home-composer.tsx` file itself. (If anything else imports it, STOP and report.)

- [ ] **Step 2: Edit `routes/index.tsx`**

Replace the `HomeComposer` import with `HomeDashboard`:
```tsx
import { HomeDashboard } from '@/components/views/home-dashboard'
```
And in `IndexView`'s return, replace `<HomeComposer />` with `<HomeDashboard />`. Keep the `select(null)` effect untouched.

- [ ] **Step 3: Delete `home-composer.tsx`**

```bash
git rm apps/desktop/src/renderer/src/components/views/home-composer.tsx
```

- [ ] **Step 4: Type-check + full renderer test suite**

```bash
pnpm --filter desktop run typecheck:web
pnpm --filter desktop exec vitest run src/renderer
```
Expected: no type errors; all renderer tests pass (252 prior + the new selector/format tests). Pre-existing `src/main`/`src/service` sqlite failures are unrelated.

- [ ] **Step 5: Commit**

```bash
git add apps/desktop/src/renderer/src/routes/index.tsx
git commit -m "refactor(ui): mount HomeDashboard on / and remove HomeComposer"
```
(The `git rm`'d file is staged already.)

---

## Task 14: Manual smoke test + final verification

**Files:** none (verification only)

- [ ] **Step 1: Build the app**

```bash
pnpm --filter desktop build
```
Expected: build succeeds (catches any bundle-time import errors).

- [ ] **Step 2: Start the dev app**

```bash
pnpm --filter desktop dev
```

- [ ] **Step 3: Smoke checklist**

1. `/` shows the dashboard: top bar ("任务台" + search button; running pill only when something runs), hero composer with heading "今天想让 swarm 做点什么?", 进行中 section, then 定时任务 | 最近完成 split.
2. **SessionPanel is HIDDEN on `/`** (Phase 1 behavior narrowed in Task 6) — the dashboard takes the full width to the rail.
3. SessionPanel STILL shows on `/session/:id` (Phase 1 preserved for sessions).
4. Submit the composer → creates a session, navigates to `/session/:id`.
5. Return to `/` via rail 任务台 → the running task appears in 进行中 with a blue dot, elapsed wall time ticking, cwd/agent label, and step count (if a plan exists).
6. Trigger a permission request (run a task in `ask` mode that calls a gated tool) → an amber-bordered awaiting card appears in 进行中 with 允许/拒绝 buttons; clicking them resolves inline WITHOUT navigating; the card disappears or returns to running.
7. Click any 进行中 card → navigates to its session.
8. Create a cron job (in a session) → it appears in 定时任务 with time label + status (上次成功 / 上次失败 / X 天后). "查看日历 →" navigates to `/scheduled`.
9. End a session → it appears in 最近完成 with a green check + relative time; clicking it reopens the session.
10. Empty states: with zero runs / zero cron / zero ended sessions, each section shows its empty-state copy.
11. Dark mode: amber awaiting border, green check, and the composer primary button all render correctly.
12. The 搜索 button opens the global session search (⌘K) dialog.

- [ ] **Step 4: Final test + typecheck pass**

```bash
pnpm --filter desktop run typecheck:web
pnpm --filter desktop exec vitest run src/renderer
```
Expected: clean.

- [ ] **Step 5: Final commit (only if smoke-testing surfaced fixes)**

---

## Self-Review

**Spec coverage:**
- §1 Goal (composer + 进行中 + 定时任务 + 最近完成) → Tasks 7–13. ✓
- §2 Decisions (running count = pending+running; SessionPanel hidden on `/`; reuse ChatInput; full empty states; session approximation for recent) → Tasks 6, 8, 11, 12, 5. ✓
- §3 Layout (top bar, max-w-1088 body, composer card, 3-card grid, 2-col split) → Task 12. ✓
- §4.2 进行中 data (useRuns, top-level only, running/pending vs awaiting, plan steps, wall time) → Task 3. ✓
- §4.3 定时任务 (useAllCronJobs + useAllCronRuns, top 5 by nextRun, last-run status) → Task 4. ✓
- §4.4 最近完成 (ended sessions, top 5, exclude system) → Task 5. ✓
- §5 Live updates (useNow 30s) → Task 2 + used in 12. ✓
- §6 Files — all created/modified/deleted per the table. ✓
- §7 Risks (ChatInput on `/`, narrowing isConversationScene, nested-button, empty vs loading) → addressed in Tasks 6, 7 (note), 8/9/10 (empty states). ✓

**Placeholder scan:** Two intentional "fix-before-typecheck" notes (Task 9 typo, Task 10 row-type extension) are concrete patches with exact code, not placeholders. Task 7's nested-button note and Task 11's search-hook name are framed as "verify-then-match" with explicit fallbacks. No TBD/TODO/implicit.

**Type consistency:**
- `DashboardRun` (Task 3) consumed unchanged in Tasks 7, 8, 12.
- `DashboardCronRow` (Task 4) consumed in Tasks 9, 12.
- `DashboardRecentRow` (Task 5, extended in Task 10 to add `lastActiveAt`) consumed in Tasks 10, 12.
- `selectDashboardRuns/Cron/Recent` signatures consistent across selector + view.
- `formatRelativeTime(ts, now)` signature consistent across Task 1 + Task 10.
- `useNow(intervalMs)` consistent across Task 2 + Task 12.

**Scope:** Single subsystem (the `/` dashboard). Each task compiles/tests independently.
