# Service Views Redesign (Phase 6a) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Redesign two service pages (Bilibili 收藏 + 日历 月视图) so agent value becomes a first-class surface — Bilibili's AI summary moves into a persistent right detail column, and the calendar gains a front-end-derived "Agent 洞察" sidebar — plus fold calendar's `window.swarm.calendar.*` calls into `swarmApi` (flat, signature-stable).

**Architecture:** Single feature branch `feat/service-views-bili-cal` off `develop` @ `7177bab`. Six sequential tasks: (1) data-layer fold, (2–3) Bilibili restructure, (4–5) calendar insights, (6) verify. Each task is independently testable and reviewable. Pure front-end; no backend changes.

**Tech Stack:** React + TanStack Router + TanStack Query, Tailwind v4, `@swarm/ui` + `@swarm/protocol`, vitest + @testing-library/react, pnpm + turbo + biome.

**Spec:** `docs/superpowers/specs/2026-07-06-service-views-design.md`

## Global Constraints

- **Branch:** `feat/service-views-bili-cal`, base `develop` @ `7177bab`. Never `git add -A` — parallel sessions pollute the worktree (weather/settings files). Always `git add <specific paths>`. Run `git status` before every commit.
- **Code/comments/commits in English; conversation in Chinese** (per AGENTS.md §0).
- **Logging:** not heavily applicable here (pure renderer UI); follow existing view files which have no logger.
- **Naming:** `swarmApi` is **flat** (`getBilibiliStatus`, `bilibiliProcess`), not nested. New calendar methods use the prefix `calendar*` (e.g. `calendarListInRange`), matching the existing `bilibili*` / cron style — NOT a nested `swarmApi.calendar` object. (Spec §3.3 said nested; implement flat to match the codebase. This is a plan-level correction.)
- **Styling tokens:** violet = `violet-500` (Agent/local), blue = `blue-500`/`primary` (Google), green = `emerald-500` (task/focus), danger = `destructive`/`red-500` (conflict). Tailwind utility classes; match the existing `eventPillTone` in `scheduled-calendar-view.tsx`.
- **Reuse, don't rewrite:** `SummaryView`, `FullTextView`, `TranscribeProgress`, `buildRows`, `VideoCard` are reused as-is.
- **Verify command:** `pnpm verify` (runs typecheck + test + check-boundaries). Target: 1239/1239 baseline maintained (or +N for new tests).
- **Test command:** `pnpm --filter @swarm/desktop test` (or `pnpm test` for full). New pure-fn tests: `vitest run <path>`.

---

## Task 1: Fold calendar preload calls into `swarmApi` (flat, signature-stable)

**Rationale:** The hooks currently call `window.swarm.calendar.*` directly. Fold these into `swarmApi` with flat `calendar*` names so the data-access surface matches Bilibili/cron. Only port the methods the **page** uses (not the settings panel's OAuth methods — out of scope). `use-cron.ts` already uses `swarmApi`, so it is untouched.

**Files:**
- Modify: `apps/desktop/src/renderer/src/lib/api.ts` (add 4 methods near the bilibili block, ~line 86)
- Modify: `apps/desktop/src/renderer/src/hooks/use-calendar.ts:14-32` (3 call sites)
- Modify: `apps/desktop/src/renderer/src/components/views/scheduled-calendar-view.tsx:96` (1 call site)
- Test: existing calendar tests stay green (no new test — pure refactor)

**Interfaces:**
- Consumes: `window.swarm.calendar.{listInRange, createLocal, deleteLocal, onStateChanged}` (preload bridge, unchanged)
- Produces: `swarmApi.calendarListInRange`, `swarmApi.calendarCreateLocal`, `swarmApi.calendarDeleteLocal`, `swarmApi.calendarOnStateChanged` — same signatures as the bridge methods they wrap.

- [ ] **Step 1: Add the 4 flat methods to `swarmApi`**

In `apps/desktop/src/renderer/src/lib/api.ts`, find the bilibili block ending around line 86 (`bilibiliGetAnalysis`). Immediately after it (and before the cron block at line 87), add:

```ts
  // Calendar (page-surface subset; settings-panel OAuth methods stay on window.swarm.calendar directly).
  calendarListInRange: (fromMs: number, toMs: number): Promise<CalendarEvent[]> =>
    window.swarm.calendar.listInRange(fromMs, toMs),
  calendarCreateLocal: (input: CalendarLocalInput): Promise<CalendarEvent> =>
    window.swarm.calendar.createLocal(input),
  calendarDeleteLocal: (id: string): Promise<boolean> => window.swarm.calendar.deleteLocal(id),
  calendarOnStateChanged: (cb: (view: CalendarConfigView) => void): (() => void) =>
    window.swarm.calendar.onStateChanged(cb),
```

Ensure the imports at the top of `api.ts` include `CalendarConfigView`, `CalendarEvent`, `CalendarLocalInput` from `@swarm/protocol` (add them to the existing import block if missing).

- [ ] **Step 2: Update `use-calendar.ts` call sites**

In `apps/desktop/src/renderer/src/hooks/use-calendar.ts`, replace the three `window.swarm.calendar.*` calls:

```ts
// line 15 (inside useCalendarEvents queryFn)
queryFn: () => swarmApi.calendarListInRange(from.getTime(), to.getTime()),
```
```ts
// line 22 (inside useCreateLocalEvent mutationFn)
mutationFn: (input: CalendarLocalInput) => swarmApi.calendarCreateLocal(input),
```
```ts
// line 30 (inside useDeleteLocalEvent mutationFn)
mutationFn: (id: string) => swarmApi.calendarDeleteLocal(id),
```

Add `import { swarmApi } from '@/lib/api'` at the top (after the protocol import). Remove the now-unused direct `window.swarm` references. **Do not change** the exported hook names or their parameter/return types.

- [ ] **Step 3: Update `scheduled-calendar-view.tsx` call site**

In `apps/desktop/src/renderer/src/components/views/scheduled-calendar-view.tsx` around line 96:

```ts
  useEffect(
    () =>
      swarmApi.calendarOnStateChanged(() => {
        void qc.invalidateQueries({ queryKey: ['calendar'] })
      }),
    [qc]
  )
```

Add `swarmApi` to the existing imports from `@/lib/api` (check if already imported; if not, add `import { swarmApi } from '@/lib/api'`).

- [ ] **Step 4: Verify typecheck + tests**

Run: `pnpm verify`
Expected: typecheck clean; all tests pass (1239/1239 baseline). The `window.swarm.calendar.*` references in `calendar-view.tsx` (settings panel) are intentionally left untouched — that file is out of scope.

Run: `grep -rn "window.swarm.calendar" apps/desktop/src/renderer/src/components/views/scheduled-calendar-view.tsx apps/desktop/src/renderer/src/hooks/use-calendar.ts`
Expected: no matches (both files now route through `swarmApi`).

- [ ] **Step 5: Commit**

```bash
git add apps/desktop/src/renderer/src/lib/api.ts apps/desktop/src/renderer/src/hooks/use-calendar.ts apps/desktop/src/renderer/src/components/views/scheduled-calendar-view.tsx
git commit -m "refactor(api): fold calendar preload calls into swarmApi (flat, signatures unchanged)"
```

---

## Task 2: Extract Bilibili detail panel from Sheet to persistent right column

**Rationale:** The AI summary currently lives in a `VideoDetailSheet` overlay. Move it to a persistent `w-[472px]` sibling column so the agent value is always visible (matches the design draft's "knowledge-base" framing and Phase 5's formations layout). The mutation/query lifecycle moves verbatim; `SummaryView`/`FullTextView`/`TranscribeProgress` are reused.

**Files:**
- Create: `apps/desktop/src/renderer/src/components/views/bilibili-detail-panel.tsx`
- Modify: `apps/desktop/src/renderer/src/components/views/bilibili-view.tsx` (delete `VideoDetailSheet`, restructure layout)
- Test: `apps/desktop/src/renderer/src/components/views/bilibili-view.test.tsx` (existing tests should mostly still pass; add 1 empty-state test)

**Interfaces:**
- Consumes: `swarmApi.bilibiliProcess`, `bilibiliTranscribe`, `bilibiliSave`, `bilibiliGetAnalysis`, `bilibiliOpen`, `bilibiliOnTranscribeProgress` (all unchanged)
- Produces: `BilibiliDetailPanel` component with props `{ video: BiliVideo | null; onClose: () => void }`. Renders its own empty state when `video === null`.

- [ ] **Step 1: Create `bilibili-detail-panel.tsx` by extracting `VideoDetailSheet` logic**

Create `apps/desktop/src/renderer/src/components/views/bilibili-detail-panel.tsx`. Move the entire body of `VideoDetailSheet` (lines 166–357 of `bilibili-view.tsx`: all the mutations, queries, `useEffect`s, the `cached`/`summary`/`fullText` derivation, the actions, the analysis/text tab switcher) into a new exported `BilibiliDetailPanel`. Key changes from the original:

1. Replace the `<Sheet>`/`<SheetContent>` wrapper with a plain `<aside>`:
```tsx
export function BilibiliDetailPanel({ video, onClose }: { video: BiliVideo | null; onClose: () => void }): React.JSX.Element {
  // ... all the existing mutation/query/useEffect logic, unchanged, referencing `video` ...
  return (
    <aside className="flex w-[472px] shrink-0 flex-col border-l border-border/60 bg-background">
      {video ? (
        <div className="flex h-full flex-col">
          {/* header with title + a close button (X) calling onClose */}
          <div className="flex items-start justify-between gap-2 border-b border-border/60 p-4">
            <div className="min-w-0">
              <h2 className="truncate font-semibold text-foreground">{video.title}</h2>
              <p className="text-muted-foreground text-xs">{video.author} · {formatDuration(video.durationSec)}</p>
            </div>
            <Button aria-label="关闭详情" onClick={onClose} size="icon-sm" variant="ghost">
              <X className="size-4" />
            </Button>
          </div>
          {/* the existing two-column inner body (metadata+actions aside + reading area) */}
          {/* ... unchanged from VideoDetailSheet's inner flex ... */}
        </div>
      ) : (
        <div className="flex h-full flex-col items-center justify-center gap-2 p-8 text-center">
          <Sparkles className="size-7 text-muted-foreground/40" />
          <p className="text-muted-foreground text-sm">选择一个视频查看 AI 解析</p>
        </div>
      )}
    </aside>
  )
}
```

2. Keep the `formatDuration` helper — either export it from `bilibili-view.tsx` or duplicate it (small enough; prefer exporting to stay DRY). Add `export` to `formatDuration` in `bilibili-view.tsx` and import it here.
3. Import the same deps: `useMutation`, `useQuery`, `useQueryClient`, `useEffect`, `useState` from react/react-query; `Button` from `@swarm/ui`; `BiliSummary`, `BiliVideo` from `@swarm/protocol`; `swarmApi` from `@/lib/api`; `TranscribeProgress`, `SummaryView`, `FullTextView` — **move** `SummaryView` and `FullTextView` into this file too (they are only used by the detail panel), OR export them from `bilibili-view.tsx`. Prefer moving them here (they are the panel's concern; keeps `bilibili-view.tsx` focused on the grid). `splitTextBlocks` moves with `FullTextView`.
4. Imports for icons: `Sparkles`, `X`, `Loader2` as needed from `lucide-react`.

- [ ] **Step 2: Restructure `BilibiliView` to two-column layout; delete `VideoDetailSheet`**

In `apps/desktop/src/renderer/src/components/views/bilibili-view.tsx`:

1. **Delete** the `VideoDetailSheet` function (lines 166–357) entirely.
2. **Delete** `SummaryView` and `FullTextView` and `splitTextBlocks` (moved to the new file).
3. **Update imports**: remove `Sheet, SheetContent, SheetDescription, SheetHeader, SheetTitle` from `@swarm/ui`; remove `BiliSummary` from the protocol import if no longer used here; add `import { BilibiliDetailPanel } from './bilibili-detail-panel'`. Keep `export function formatDuration` (used by the panel).
4. **Change the main layout**: the current return is `<div className="mx-auto flex h-full w-full flex-col gap-4 p-4">` with a single grid child + the Sheet at the bottom. Restructure so the body row holds grid + panel side by side:

Replace the `<div className="min-h-0 flex-1" ref={measureRef}>...</div>` + `<VideoDetailSheet .../>` with:

```tsx
        <div className="flex min-h-0 flex-1 gap-0">
          <div className="min-h-0 flex-1" ref={measureRef}>
            <ScrollArea className="h-full">
              <div className="flex flex-col gap-3">
                {rows.map((row) =>
                  row.kind === 'header' ? (
                    <h2 className="pt-2 font-medium text-foreground/80 text-sm" key={row.key}>
                      {row.title}
                    </h2>
                  ) : (
                    <div
                      className="grid gap-3"
                      key={row.key}
                      style={{ gridTemplateColumns: `repeat(${columns}, minmax(0, 1fr))` }}
                    >
                      {row.videos.map((v) => (
                        <VideoCard
                          analyzed={analyzedSet.has(v.bvid)}
                          key={v.bvid}
                          onClick={setSelected}
                          selected={selected?.bvid === v.bvid}
                          video={v}
                        />
                      ))}
                    </div>
                  )
                )}
              </div>
            </ScrollArea>
          </div>
          <BilibiliDetailPanel onClose={() => setSelected(null)} video={selected} />
        </div>
```

5. Remove the now-unused `Sheet` import and any orphaned imports your deletion created. Run `pnpm --filter @swarm/desktop typecheck` to catch them.

- [ ] **Step 3: Update existing tests + add empty-state test**

In `apps/desktop/src/renderer/src/components/views/bilibili-view.test.tsx`:

1. The existing tests (lines 97–228) click "视频甲" then assert on intro/summary/etc. These **should still pass** because the panel renders the same content; only its container changed from Sheet to aside. Run them first; if any fail due to the close button or layout, adjust the selector.
2. Add one new test for the empty state (selected === null). After the `beforeEach` mocks and inside the `describe('BilibiliView', ...)` block:

```ts
  it('shows an empty-state prompt in the detail panel before any video is selected', async () => {
    vi.spyOn(swarmApi, 'getBilibiliStatus').mockResolvedValue({ loggedIn: true, uname: 'me', mid: 42 })
    vi.spyOn(swarmApi, 'getBilibiliList').mockResolvedValue(SAMPLE)
    render(wrap(<BilibiliView />))
    expect(await screen.findByText('选择一个视频查看 AI 解析')).toBeInTheDocument()
  })
```

- [ ] **Step 4: Verify typecheck + tests**

Run: `pnpm --filter @swarm/desktop typecheck`
Expected: clean.

Run: `pnpm --filter @swarm/desktop test -- bilibili-view`
Expected: all bilibili tests pass (including the new empty-state test).

Run: `grep -rn "VideoDetailSheet" apps/desktop/src/renderer/src`
Expected: no matches.

- [ ] **Step 5: Commit**

```bash
git add apps/desktop/src/renderer/src/components/views/bilibili-detail-panel.tsx apps/desktop/src/renderer/src/components/views/bilibili-view.tsx apps/desktop/src/renderer/src/components/views/bilibili-view.test.tsx
git commit -m "feat(bilibili): extract AI summary into persistent right detail panel"
```

---

## Task 3: Add Bilibili "AI 已解析 N / M" stat chip to the toolbar

**Rationale:** Surface the knowledge-base angle globally — how many of the user's favorited/watch-later videos have been AI-analyzed.

**Files:**
- Modify: `apps/desktop/src/renderer/src/components/views/bilibili-view.tsx` (toolbar)
- Test: `apps/desktop/src/renderer/src/components/views/bilibili-view.test.tsx` (add 2 tests)

**Interfaces:**
- Consumes: `analyzedSet` (already computed), `listQuery.data` (folders + watchLater)
- Produces: a stat chip in the toolbar.

- [ ] **Step 1: Compute N and M; render the chip**

In `apps/desktop/src/renderer/src/components/views/bilibili-view.tsx`, inside `BilibiliView`, after `analyzedSet` is computed (~line 375), add:

```ts
  const totalCount = useMemo(() => {
    const favs = listQuery.data?.folders ?? []
    const inFolders = favs.reduce((n, f) => n + f.videos.length, 0)
    return inFolders + (listQuery.data?.watchLater.length ?? 0)
  }, [listQuery.data])
  const analyzedCount = analyzedSet.size
```

Then in the toolbar `<div className="flex flex-wrap items-center gap-3">` (the one holding Tabs/Select/uname), replace the `<span className="ml-auto ...">{uname}</span>` with:

```tsx
        {totalCount > 0 ? (
          <span className="ml-auto inline-flex items-center gap-1.5 rounded-full border border-violet-500/20 bg-linear-to-br from-violet-500/10 to-primary/10 px-3 py-1 text-xs">
            <Sparkles className="size-3 text-violet-500" />
            <span className="font-semibold text-violet-700 dark:text-violet-300">
              AI 已解析 <span className="tabular-nums">{analyzedCount}</span> / <span className="tabular-nums">{totalCount}</span>
            </span>
          </span>
        ) : null}
        <span className="text-muted-foreground text-sm">{statusQuery.data?.uname ?? ''}</span>
```

Import `Sparkles` from `lucide-react` (add to the existing import or add `import { Sparkles } from 'lucide-react'`).

- [ ] **Step 2: Add tests for the chip**

In `apps/desktop/src/renderer/src/components/views/bilibili-view.test.tsx`, add:

```ts
  it('shows the AI stat chip with analyzed/total counts', async () => {
    vi.spyOn(swarmApi, 'getBilibiliStatus').mockResolvedValue({ loggedIn: true, uname: 'me', mid: 42 })
    vi.spyOn(swarmApi, 'getBilibiliList').mockResolvedValue(SAMPLE) // 3 videos total (2 folders + 1 watch-later)
    vi.spyOn(swarmApi, 'bilibiliAnalyzedBvids').mockResolvedValue(['BV1', 'BV3']) // 2 analyzed
    render(wrap(<BilibiliView />))
    expect(await screen.findByText(/AI 已解析/)).toBeInTheDocument()
    const chip = screen.getByText(/AI 已解析/).closest('span')?.parentElement
    expect(chip).toHaveTextContent('2')
    expect(chip).toHaveTextContent('3')
  })

  it('hides the AI stat chip when there are no videos', async () => {
    vi.spyOn(swarmApi, 'getBilibiliStatus').mockResolvedValue({ loggedIn: true, uname: 'me', mid: 42 })
    vi.spyOn(swarmApi, 'getBilibiliList').mockResolvedValue({ folders: [], watchLater: [] })
    render(wrap(<BilibiliView />))
    await screen.findByText('me') // wait for render
    expect(screen.queryByText(/AI 已解析/)).not.toBeInTheDocument()
  })
```

- [ ] **Step 3: Verify**

Run: `pnpm --filter @swarm/desktop test -- bilibili-view`
Expected: all pass, including the 2 new chip tests.

- [ ] **Step 4: Commit**

```bash
git add apps/desktop/src/renderer/src/components/views/bilibili-view.tsx apps/desktop/src/renderer/src/components/views/bilibili-view.test.tsx
git commit -m "feat(bilibili): add AI-analyzed stat chip to toolbar"
```

---

## Task 4: `buildCalendarInsights` pure function + unit tests

**Rationale:** The calendar insight rules (conflict / delegable / focus) are derived from the selected day's items. Make them a pure function with zero React deps, fully unit-testable, mirroring `build-agent-activity.ts`.

**Files:**
- Create: `apps/desktop/src/renderer/src/lib/calendar/build-insights.ts`
- Create: `apps/desktop/src/renderer/src/lib/calendar/build-insights.test.ts`

**Interfaces:**
- Consumes: nothing (pure). Defines its own minimal input type so it does NOT depend on the view's internal `DayItem`.
- Produces: `buildCalendarInsights(items: InsightInput[]): CalendarInsight[]` and types `InsightInput`, `CalendarInsight`.

- [ ] **Step 1: Write the failing tests**

Create `apps/desktop/src/renderer/src/lib/calendar/build-insights.test.ts`:

```ts
import { describe, expect, it } from 'vitest'

import { buildCalendarInsights } from './build-insights'
import type { InsightInput } from './build-insights'

// Helpers: build items with sensible defaults. Times are ms epochs; only
// relative ordering matters for the rules, so we use small offsets from a base.
const NOON = new Date(2026, 6, 3, 12, 0).getTime() // Jul 3 2026 12:00
function ev(over: Partial<InsightInput> & Pick<InsightInput, 'startMs'>): InsightInput {
  return { kind: 'event', source: 'google', title: 'e', endMs: over.startMs + 60 * 60 * 1000, ...over }
}
function proj(over: Partial<InsightInput> & Pick<InsightInput, 'startMs'>): InsightInput {
  return { kind: 'projection', source: 'task', title: 't', endMs: over.startMs, ...over }
}

describe('buildCalendarInsights', () => {
  it('returns no insights for an empty day', () => {
    expect(buildCalendarInsights([])).toEqual([])
  })

  it('returns no insights for a single event', () => {
    expect(buildCalendarInsights([ev({ startMs: NOON })])).toEqual([])
  })

  it('flags a conflict when two events are back-to-back with <30min gap', () => {
    const a = ev({ startMs: new Date(2026, 6, 3, 11, 0).getTime(), endMs: new Date(2026, 6, 3, 11, 30).getTime() })
    const b = ev({ startMs: new Date(2026, 6, 3, 11, 45).getTime(), endMs: new Date(2026, 6, 3, 12, 30).getTime() })
    const out = buildCalendarInsights([a, b])
    expect(out.some((i) => i.kind === 'conflict')).toBe(true)
  })

  it('does not flag a conflict when gap is >=30min', () => {
    const a = ev({ startMs: new Date(2026, 6, 3, 11, 0).getTime(), endMs: new Date(2026, 6, 3, 11, 30).getTime() })
    const b = ev({ startMs: new Date(2026, 6, 3, 12, 0).getTime(), endMs: new Date(2026, 6, 3, 13, 0).getTime() })
    const out = buildCalendarInsights([a, b])
    expect(out.some((i) => i.kind === 'conflict')).toBe(false)
  })

  it('flags overlapping events as a conflict', () => {
    const a = ev({ startMs: new Date(2026, 6, 3, 11, 0).getTime(), endMs: new Date(2026, 6, 3, 12, 0).getTime() })
    const b = ev({ startMs: new Date(2026, 6, 3, 11, 30).getTime(), endMs: new Date(2026, 6, 3, 12, 30).getTime() })
    const out = buildCalendarInsights([a, b])
    expect(out.some((i) => i.kind === 'conflict')).toBe(true)
  })

  it('emits a delegable insight when a local event exists', () => {
    const out = buildCalendarInsights([ev({ startMs: NOON, source: 'local', title: 'Agent:整理周报' })])
    expect(out.some((i) => i.kind === 'delegable')).toBe(true)
  })

  it('emits a delegable insight when a cron projection exists', () => {
    const out = buildCalendarInsights([proj({ startMs: NOON })])
    expect(out.some((i) => i.kind === 'delegable')).toBe(true)
  })

  it('emits a focus insight when a >=90min free block exists in the afternoon', () => {
    // 09:00-10:00 meeting, then nothing until evening -> 13:00-15:00 is free (>=90min, outside lunch)
    const a = ev({ startMs: new Date(2026, 6, 3, 9, 0).getTime(), endMs: new Date(2026, 6, 3, 10, 0).getTime() })
    const out = buildCalendarInsights([a])
    expect(out.some((i) => i.kind === 'focus')).toBe(true)
  })

  it('does not emit a focus insight inside the 12:00-13:00 lunch band', () => {
    // Only a 09:00-11:30 meeting; the largest non-lunch free block before lunch is 11:30-12:00 (30min, too short);
    // afternoon is fully free though -> focus IS emitted. To test lunch exclusion we need the ONLY gap to be lunch.
    // Construct: meetings 09:00-12:00 and 13:00-18:00 -> the only gap is 12:00-13:00 (lunch), no focus.
    const a = ev({ startMs: new Date(2026, 6, 3, 9, 0).getTime(), endMs: new Date(2026, 6, 3, 12, 0).getTime() })
    const b = ev({ startMs: new Date(2026, 6, 3, 13, 0).getTime(), endMs: new Date(2026, 6, 3, 18, 0).getTime() })
    const out = buildCalendarInsights([a, b])
    expect(out.some((i) => i.kind === 'focus')).toBe(false)
  })

  it('emits multiple distinct insights when several rules fire', () => {
    const a = ev({ startMs: new Date(2026, 6, 3, 11, 0).getTime(), endMs: new Date(2026, 6, 3, 11, 15).getTime() })
    const b = ev({ startMs: new Date(2026, 6, 3, 11, 20).getTime(), endMs: new Date(2026, 6, 3, 12, 0).getTime() })
    const c = ev({ startMs: new Date(2026, 6, 3, 16, 0).getTime(), source: 'local' })
    const out = buildCalendarInsights([a, b, c])
    const kinds = new Set(out.map((i) => i.kind))
    expect(kinds.has('conflict')).toBe(true)
    expect(kinds.has('delegable')).toBe(true)
    expect(kinds.has('focus')).toBe(true) // morning has conflict but 12:00-16:00 afternoon is free
  })
})
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `pnpm --filter @swarm/desktop exec vitest run src/lib/calendar/build-insights.test.ts`
Expected: FAIL with "Failed to resolve import" or "buildCalendarInsights is not defined".

- [ ] **Step 3: Implement `build-insights.ts`**

Create `apps/desktop/src/renderer/src/lib/calendar/build-insights.ts`:

```ts
// Pure derivation of calendar "Agent 洞察" cards from a day's items. No React,
// no side effects. Mirrors the style of lib/formations/build-agent-activity.ts.

export type InsightInput = {
  kind: 'event' | 'projection' | 'run'
  source: 'google' | 'local' | 'task'
  title: string
  startMs: number
  endMs: number
}

export type CalendarInsight = {
  kind: 'conflict' | 'delegable' | 'focus'
  tag: string
  text: string
  tone: 'danger' | 'violet' | 'green'
}

const MIN_GAP_FOR_CONFLICT_MS = 30 * 60 * 1000 // <30min between events = conflict
const MIN_FOCUS_BLOCK_MS = 90 * 60 * 1000 // >=90min contiguous free = focus
const LUNCH_START_HOUR = 12
const LUNCH_END_HOUR = 13
const DAY_START_HOUR = 9
const DAY_END_HOUR = 18

function fmtTime(ms: number): string {
  const d = new Date(ms)
  return `${d.getHours().toString().padStart(2, '0')}:${d.getMinutes().toString().padString(2, '0')}`
}

// Free blocks that are NOT inside the 12:00-13:00 lunch band and fall in work hours.
function freeBlocksOutsideLunch(events: InsightInput[], dayStartMs: number, dayEndMs: number): { startMs: number; endMs: number }[] {
  // Build free gaps between sorted events within [dayStart, dayEnd].
  const sorted = [...events].sort((a, b) => a.startMs - b.startMs)
  const gaps: { startMs: number; endMs: number }[] = []
  let cursor = dayStartMs
  for (const e of sorted) {
    if (e.startMs > cursor) gaps.push({ startMs: cursor, endMs: e.startMs })
    cursor = Math.max(cursor, e.endMs)
  }
  if (cursor < dayEndMs) gaps.push({ startMs: cursor, endMs: dayEndMs })
  // Drop any gap fully inside lunch.
  return gaps.filter((g) => {
    const s = new Date(g.startMs)
    const e = new Date(g.endMs)
    const sInLunch = s.getHours() >= LUNCH_START_HOUR && s.getHours() < LUNCH_END_HOUR
    const eInLunch = e.getHours() > LUNCH_START_HOUR && e.getHours() <= LUNCH_END_HOUR
    return !(sInLunch && eInLunch)
  })
}

export function buildCalendarInsights(items: InsightInput[]): CalendarInsight[] {
  if (items.length === 0) return []
  const out: CalendarInsight[] = []
  const events = items.filter((i) => i.kind === 'event')
  const sortedEvents = [...events].sort((a, b) => a.startMs - b.startMs)

  // Conflict: adjacent events with <30min gap or overlap.
  for (let i = 1; i < sortedEvents.length; i++) {
    const prev = sortedEvents[i - 1]
    const cur = sortedEvents[i]
    const gap = cur.startMs - prev.endMs
    if (gap < MIN_GAP_FOR_CONFLICT_MS) {
      out.push({
        kind: 'conflict',
        tag: '日程冲突',
        text: `${fmtTime(prev.startMs)} 「${prev.title}」与 ${fmtTime(cur.startMs)} 「${cur.title}」之间${gap < 0 ? '时间重叠' : `仅 ${Math.round(gap / 60000)} 分钟缓冲`}。`,
        tone: 'danger',
      })
      break // one conflict insight is enough
    }
  }

  // Delegable: any local event or cron projection.
  const delegated = items.filter((i) => (i.kind === 'event' && i.source === 'local') || i.kind === 'projection')
  if (delegated.length > 0) {
    out.push({
      kind: 'delegable',
      tag: '可委派',
      text: `今日有 ${delegated.length} 个事项已交给 Agent：${delegated.map((d) => d.title).slice(0, 2).join('、')}${delegated.length > 2 ? ' 等' : ''}。`,
      tone: 'violet',
    })
  }

  // Focus: >=90min contiguous free block outside lunch, within 09:00-18:00.
  const firstStart = Math.min(...items.map((i) => i.startMs))
  const d = new Date(firstStart)
  const dayStartMs = new Date(d.getFullYear(), d.getMonth(), d.getDate(), DAY_START_HOUR).getTime()
  const dayEndMs = new Date(d.getFullYear(), d.getMonth(), d.getDate(), DAY_END_HOUR).getTime()
  const focusBlock = freeBlocksOutsideLunch(events, dayStartMs, dayEndMs).find((g) => g.endMs - g.startMs >= MIN_FOCUS_BLOCK_MS)
  if (focusBlock) {
    out.push({
      kind: 'focus',
      tag: '专注时段',
      text: `${fmtTime(focusBlock.startMs)}–${fmtTime(focusBlock.endMs)} 无会议，是连续专注时段。`,
      tone: 'green',
    })
  }

  return out
}
```

Note: `fmtTime` uses `padString` — that's a typo, it must be `padStart`. Fix it in your implementation:

```ts
  return `${d.getHours().toString().padStart(2, '0')}:${d.getMinutes().toString().padStart(2, '0')}`
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `pnpm --filter @swarm/desktop exec vitest run src/lib/calendar/build-insights.test.ts`
Expected: all 9 tests pass.

If the focus-insight test for the "afternoon free" case fails, verify your `freeBlocksOutsideLunch` correctly returns the 10:00-18:00 gap (minus lunch) — adjust the lunch-exclusion filter to only drop gaps **fully** within 12:00-13:00, not partially overlapping.

- [ ] **Step 5: Commit**

```bash
git add apps/desktop/src/renderer/src/lib/calendar/build-insights.ts apps/desktop/src/renderer/src/lib/calendar/build-insights.test.ts
git commit -m "feat(calendar): buildCalendarInsights pure fn + unit tests"
```

---

## Task 5: Render `<CalendarInsights>` in the calendar aside + style alignment

**Rationale:** Mount the insights in the day-detail aside (after items, before legend) and align the calendar's visual tokens (today badge, three-color pills) with the design draft.

**Files:**
- Create: `apps/desktop/src/renderer/src/components/views/calendar-insights.tsx`
- Modify: `apps/desktop/src/renderer/src/components/views/scheduled-calendar-view.tsx` (aside width, mount point, minor style)

**Interfaces:**
- Consumes: `buildCalendarInsights`, `InsightInput`, `CalendarInsight` from Task 4; the view maps its internal `DayItem[]` to `InsightInput[]` at the call site.
- Produces: `<CalendarInsights items={insightInputs} />` that renders nothing when insights is empty.

- [ ] **Step 1: Create `calendar-insights.tsx`**

Create `apps/desktop/src/renderer/src/components/views/calendar-insights.tsx`:

```tsx
import { Sparkles } from 'lucide-react'

import { buildCalendarInsights } from '@/lib/calendar/build-insights'
import type { InsightInput } from '@/lib/calendar/build-insights'
import { cn } from '@/lib/utils'

const TONE: Record<string, { wrap: string; tag: string; icon: string }> = {
  danger: { wrap: 'border-red-500/20 bg-card', tag: 'text-red-600 dark:text-red-400', icon: 'bg-red-500/10 text-red-500' },
  violet: { wrap: 'border-violet-500/20 bg-card', tag: 'text-violet-600 dark:text-violet-400', icon: 'bg-violet-500/10 text-violet-500' },
  green: { wrap: 'border-emerald-500/20 bg-card', tag: 'text-emerald-600 dark:text-emerald-400', icon: 'bg-emerald-500/10 text-emerald-500' },
}

export function CalendarInsights({ items }: { items: InsightInput[] }): React.JSX.Element | null {
  const insights = buildCalendarInsights(items)
  if (insights.length === 0) return null
  return (
    <div className="flex flex-col gap-2">
      <div className="flex items-center gap-1.5">
        <span className="flex size-5 items-center justify-center rounded-md bg-linear-to-br from-violet-500 to-primary">
          <Sparkles className="size-3 text-white" />
        </span>
        <span className="font-medium text-[13px]">Agent 洞察</span>
      </div>
      {insights.map((ins, i) => {
        const tone = TONE[ins.tone]
        return (
          <div className={cn('rounded-lg border p-3 text-[12px]', tone.wrap)} key={`${ins.kind}-${i}`}>
            <div className={cn('mb-1 font-semibold text-[11.5px]', tone.tag)}>{ins.tag}</div>
            <div className="text-foreground/80 leading-5">{ins.text}</div>
          </div>
        )
      })}
    </div>
  )
}
```

- [ ] **Step 2: Wire it into the calendar aside**

In `apps/desktop/src/renderer/src/components/views/scheduled-calendar-view.tsx`:

1. Add imports at the top:
```ts
import { CalendarInsights } from './calendar-insights'
import type { InsightInput } from '@/lib/calendar/build-insights'
```

2. Widen the aside: change `w-[300px]` to `w-[320px]` (line ~290).

3. Inside the aside's `<ScrollArea>` content, **after** the `selectedItems.map(...)` block and **before** the legend (the `<div style="...">` or the color-legend block at the bottom — find the existing legend with the three colored dots), insert:

```tsx
              {/* Agent insights (front-end derived; nothing to show when no rules fire) */}
              <CalendarInsights items={selectedItems.map((it): InsightInput => ({
                kind: it.kind === 'event' ? 'event' : it.kind === 'projection' ? 'projection' : 'run',
                source: it.kind === 'event' ? it.event.source : 'task',
                title: itemLabel(it),
                startMs: it.kind === 'event' ? it.event.startMs : it.at.getTime(),
                endMs: it.kind === 'event' ? it.event.endMs : it.at.getTime(),
              }))} />
```

Place it inside the `<div className="flex flex-col gap-2 p-3">` that wraps the items, after the items list. If `selectedItems.length === 0` the mapping yields `[]` and `<CalendarInsights>` returns null — fine.

4. **Style alignment (light touch):** the existing `eventPillTone`/`eventDot` already use blue (google) / violet (local). The cron/task tone uses emerald-ish via `runTone`. Verify the today badge (`isToday ? 'bg-primary text-primary-foreground'`) matches the draft's red-filled circle — the draft uses `#ff3b30` (system red), but the product uses `primary`. **Leave as `primary`** (consistent with the rest of the app's today treatment; do NOT special-case red). Document this as a deliberate deviation in the commit message.

- [ ] **Step 3: Verify typecheck + manual smoke**

Run: `pnpm --filter @swarm/desktop typecheck`
Expected: clean. If `DayItem` discriminated-union narrowing complains about the mapping, add explicit narrowing (the `it.kind === 'event' ? it.event.startMs : ...` form should narrow correctly).

Manual smoke (dev server): pick days with (a) two close meetings, (b) a local event, (c) a free afternoon — confirm each insight appears/disappears. Confirm the legend still renders below.

- [ ] **Step 4: Commit**

```bash
git add apps/desktop/src/renderer/src/components/views/calendar-insights.tsx apps/desktop/src/renderer/src/components/views/scheduled-calendar-view.tsx
git commit -m "feat(calendar): render Agent insights sidebar + align styles"
```

---

## Task 6: Full verify, cross-cutting review, progress ledger

**Rationale:** Final gate before merge. Confirm the whole branch is green, the spec's success criteria hold, and record what happened.

**Files:**
- Create: `.superpowers/sdd/progress-service-views.md`

- [ ] **Step 1: Full verify**

Run: `pnpm verify`
Expected: typecheck clean; all tests pass (1239 baseline + new tests from Tasks 3 & 4 ≈ +11); `check-boundaries` passes.

If `routeTree.gen.ts` was regenerated by a dev-server run during implementation and the diff is just route registration, include it; otherwise leave it (the parallel weather session owns that file's weather-related changes).

- [ ] **Step 2: Cross-cutting review checklist**

Walk these seams (this is a manual mental check, not a subagent dispatch — or dispatch an Explore agent if you want a second pair of eyes):

1. **Bilibili 分析/转写/保存 chain:** select video → 分析 works; no-subtitle → 本地转写 works; 保存到 Obsidian works; switching videos resets state.
2. **Bilibili empty state:** no video selected → "选择一个视频查看 AI 解析".
3. **Bilibili stat chip:** shows N/M; hidden when M=0.
4. **Calendar insights:** conflict / delegable / focus each appear on the right days; empty day shows nothing.
5. **Calendar preserved features:** "查看运行记录 →" still navigates; local event create/delete works; week stays Monday-first.
6. **Data layer:** no `window.swarm.calendar` refs remain in `use-calendar.ts` or `scheduled-calendar-view.tsx` (settings panel `calendar-view.tsx` intentionally retains them).
7. **Dark mode:** Bilibili panel, calendar insight cards, three-color pills all render legibly.

- [ ] **Step 3: Write the progress ledger**

Create `.superpowers/sdd/progress-service-views.md` modeled on `progress-formations.md`:

```markdown
# Progress — Phase 6a Service Views (Bilibili + Calendar)

Spec: docs/superpowers/specs/2026-07-06-service-views-design.md
Plan: docs/superpowers/plans/2026-07-06-service-views.md
Branch: feat/service-views-bili-cal  Base: 7177bab (develop post Phase 5 + weather)

## Tasks
- [x] Task 1: swarmApi calendar fold (flat names) — complete (commit <hash>)
- [x] Task 2: BilibiliDetailPanel extraction (Sheet → sibling column) — complete (commit <hash>)
- [x] Task 3: Bilibili AI stat chip — complete (commit <hash>)
- [x] Task 4: buildCalendarInsights pure fn + 9 unit tests — complete (commit <hash>)
- [x] Task 5: <CalendarInsights> render + style alignment — complete (commit <hash>)
- [x] Task 6: full verify + review + ledger — complete

## Final review: READY to merge
- Full suite N/N green; typecheck clean; check-boundaries pass.
- Spec deviations honored: Monday-first week, front-end insights (agent version = follow-up), un-analyzed videos stay selectable, today badge stays primary (not draft's red).
- Data layer: use-cron.ts already used swarmApi (no change); settings panel calendar-view.tsz retains direct window.swarm.calendar (out of scope).

## Follow-ups
- Phase 6c: Gmail redesign (separate spec).
- Calendar insights agent version (action buttons like "让 Agent 预订午餐").
```

Fill in the real commit hashes from `git log --oneline feat/service-views-bili-cal ^develop`.

- [ ] **Step 4: Commit the ledger; report merge-readiness**

```bash
git add .superpowers/sdd/progress-service-views.md
git commit -m "docs(service-views): progress ledger for phase 6a"
```

Report to the user: branch is ready to merge into `develop` (fast-forward or PR). GUI smoke per spec §5 deferred to user.

---

## Self-Review (run after writing this plan)

**1. Spec coverage:**
- §1 Bilibili persistent panel → Task 2 ✓
- §1 Bilibili AI stat chip → Task 3 ✓
- §1 日历 Agent 洞察 (front-end) → Tasks 4 & 5 ✓
- §1 日历 style alignment → Task 5 ✓
- §1 Data layer fold → Task 1 ✓
- §1 Success criteria (all bullets) → Task 6 Step 2 walks each ✓
- Non-goals (Gmail, agent insights version, week-start) → respected (no task touches them) ✓

**2. Placeholder scan:** No "TBD"/"TODO"/"implement later". Code blocks contain real code. The one intentional pseudo-typo (`padString` → corrected to `padStart` inline) is called out. Commit hashes in the ledger template are `<hash>` placeholders filled in Task 6 Step 3 — that's an execution-time fill, acceptable.

**3. Type consistency:**
- `InsightInput` defined in Task 4, consumed in Task 5 ✓
- `CalendarInsight` shape (`kind/tag/text/tone`) consistent across Task 4 def, Task 4 tests, Task 5 `TONE` map ✓
- `swarmApi.calendar*` names consistent: Task 1 defines `calendarListInRange`/`calendarCreateLocal`/`calendarDeleteLocal`/`calendarOnStateChanged`; Task 1 Step 2/3 use exactly those ✓
- `BilibiliDetailPanel` props `{ video, onClose }` defined Task 2 Step 1, consumed Task 2 Step 2 ✓
- `formatDuration` exported from `bilibili-view.tsx`, imported in panel ✓

No issues found. Plan is complete.
