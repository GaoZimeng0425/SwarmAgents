# Service Views Redesign (Phase 6a) Design

**Date:** 2026-07-06
**Scope:** Phase 6a of the desktop UI redesign — redesign two service pages
(**Bilibili** 收藏 and **日历** 月视图) to promote agent value from a tucked-away
interaction to a first-class page citizen. Bilibili's AI summary becomes a
persistent right-hand detail panel (replacing the current Sheet); the calendar
gains a front-end-derived "Agent 洞察" sidebar (日程冲突 / 可委派 / 专注时段).
As a surgical carry-over, calendar's `window.swarm.calendar.*` calls are folded
into a `swarmApi.calendar` namespace (signatures unchanged).
**Branch:** `feat/service-views-bili-cal` (off `develop` @ `7177bab`).
**Depends on:** Phase 1 (rail/shell). The three target views (`bilibili-view.tsx`,
`scheduled-calendar-view.tsx`) already exist and render; this phase restructures
their layout and adds the calendar-insights capability.
**Out of scope:** Gmail redesign (→ Phase 6c, separate spec); background-agent
generation of calendar insights (→ follow-up); Bilibili unrelated features;
changing the week start day (stays Monday-first).

---

## 1. Goal & Scope

Promote agent value in two service pages to a first-class surface:

- **Bilibili:** the AI structured summary (`BiliSummary`: gist + 核心要点 /
  可复用经验 / 踩坑注意 / 可执行步骤) moves from "click a video → Sheet" to a
  persistent right-hand detail column that is always visible. A global
  "AI 已解析 N / M" chip in the toolbar surfaces the knowledge-base angle.
- **日历 (Calendar):** the existing three-color month view (Google read-only /
  app-local / cron-task — already implemented) gains an **Agent 洞察** block in
  the day-detail aside. Insights are derived by a pure front-end function from
  the selected day's items (no new backend, no agent run).
- **Data layer (surgical carry-over):** fold `window.swarm.calendar.*` direct
  calls into a typed `swarmApi.calendar` namespace. The calendar hooks' public
  signatures stay identical; only their bodies change the call site.

### Non-goals (explicitly deferred)

- **Gmail redesign.** Agent grouping, thread-level 助手卡, todo extraction, and
  suggested replies depend on undefined backend capabilities. Tracked as
  Phase 6c with its own brainstorm → spec → plan cycle.
- **Background-agent calendar insights.** The design draft's "让 Agent 预订午餐"
  action buttons imply an agent capability that does not exist. This spec ships
  only the front-end rule-based version. An agent-authored version is a
  follow-up.
- **Bilibili "新建编队" or other unrelated features.** Out.
- **Week start day change.** The draft draws Sunday-first (US); the product
  keeps Monday-first (CN convention). Recorded deviation below.
- **Bilibili interaction for un-analyzed videos per the draft.** The draft
  makes un-analyzed videos non-clickable (`onClick: v.analyzed ? select : noop`).
  This spec deviates: un-analyzed videos **remain selectable**, and the right
  panel shows an empty state with an "AI 分析" trigger button — preserving the
  existing trigger affordance and being more useful than a dead click.

### Confirmed deviations from the design draft

1. **Week starts Monday** (draft: Sunday) — CN convention, matches current code.
2. **Calendar insights are front-end-derived** (draft implies an agent
   capability) — scope control; agent version is a follow-up.
3. **Un-analyzed Bilibili videos stay selectable** (draft: dead click) — keeps
   the existing trigger interaction.

### Success criteria

- Bilibili: clicking a video populates a persistent right detail panel
  (summary, or empty state + trigger when un-analyzed). The 分析 / 本地转写 /
  保存到 Obsidian flows still work end-to-end. Selecting another video
  refreshes the panel.
- Bilibili: a global "AI 已解析 N / M" chip renders in the toolbar when M > 0
  (hidden when M === 0).
- 日历: selecting a day with a triggerable rule shows the corresponding
  insight card(s) in the aside, after the day's items and before the legend.
  Days with no triggerable rule show no insights block.
- 日历: week stays Monday-first; three-color event pills and today styling
  align with the draft (google blue / local violet / task green; today badge).
- Data layer: `swarmApi.calendar` namespace exists; `use-calendar.ts` calls it;
  hook public signatures unchanged; existing calendar-related tests stay green.
- `buildCalendarInsights` is unit-tested for empty / single / overlap /
  adjacent / long-focus / lunch-exclusion / combined cases.
- Full suite green; typecheck clean; `check-boundaries` passes.

---

## 2. Design Decisions (locked from brainstorm)

| Decision | Choice | Rationale |
|---|---|---|
| Spec scope | Bilibili + 日历 together; Gmail separate (Phase 6c) | Both pages are predominantly front-end restructure; Gmail depends on undefined backend. |
| Bilibili detail | Persistent right column (472px) | Draft's "knowledge-base" framing; master-detail is coherent and matches Phase 5 formations layout. Sheet deleted. |
| Un-analyzed video | Selectable; panel shows empty state + trigger | More useful than draft's dead click; preserves existing trigger. Deviation recorded. |
| Calendar insight source | Pure front-end rules | Zero new backend / token cost; real-time; testable. Agent version is a follow-up. |
| Calendar insight actions | Not rendered (no "预订午餐" buttons) | Those imply agent capability — out of scope. |
| Week start day | Monday-first (deviation) | CN convention; matches current code. |
| Data access layer | Fold `window.swarm.calendar.*` → `swarmApi.calendar` | User-requested tidy-up; signatures unchanged; surgical. |
| Implementation slicing | Single branch, 6 sequential tasks | Linear, controllable; matches Phase 5 rhythm; precise `git add` mitigates parallel-session pollution. |

---

## 3. Specification (from design `Service Views.dc.html` §bili / §cal)

### 3.1 Bilibili geometry & interaction

- **Layout:** `BilibiliView` becomes a flex row: a 56px toolbar, then a body of
  `flex min-h-0 flex-1` containing the video grid (`flex-1`) and a detail
  panel (`w-[472px] shrink-0 border-l`).
- **Toolbar:** existing Tabs (收藏夹 / 稍后再看) + folder Select (favorites mode
  only) + a NEW AI-stat chip on the trailing side. The current `uname` label
  coexists or yields position based on density.
- **Grid:** the virtualized grid (row-chunked by measured column count) is
  preserved as-is; only its container changes from full-width to `flex-1`.
- **Detail panel (`BilibiliDetailPanel`):**
  - `video === null` → empty state "选择一个视频查看 AI 解析".
  - analyzed → `SummaryView` (gist card + four labelled sections).
  - un-analyzed → empty state + "AI 分析" button (deviation: trigger kept).
  - no-subtitle → existing "本地转写" branch with `TranscribeProgress`.
  - analysis/text tab switching preserved (default analysis when summary
    exists; default text when only full-text exists).
- **AI-stat chip:** `N = analyzedSet.size`, `M = Σ folder videos + watchLater.length`.
  Style: gradient `from-violet-500/10 to-primary/10`, `border-violet-500/20`,
  Sparkles icon, "AI 已解析 N / M", `tabular-nums`. Hidden when `M === 0`.

### 3.2 Calendar insights (front-end rules)

- **`buildCalendarInsights(items: DayItem[], date: Date): CalendarInsight[]`** —
  pure function in `lib/calendar/build-insights.ts` (mirrors Phase 5's
  `build-agent-activity.ts`).
  ```ts
  type CalendarInsight = {
    kind: 'conflict' | 'delegable' | 'focus'
    tag: string        // "日程冲突" / "可委派" / "专注时段"
    text: string
    tone: 'danger' | 'violet' | 'green'
  }
  ```
  - **conflict:** among the day's `event`-kind items (exclude cron projections),
    sorted by start; if adjacent pair overlaps (`a.endMs > b.startMs`) or gap
    `< 30min` and no event between them mentions "午餐" → emit a conflict
    insight citing the two times. Does NOT emit "建议预订午餐" (action wording).
  - **delegable:** if the day has any `event` with `source === 'local'` or any
    `projection` (cron task) → emit "可委派" summarizing what's handed to the
    agent.
  - **focus:** scan event-kind gaps; if a contiguous free block `≥ 90min`
    exists outside the 12:00–13:00 lunch band → emit "专注时段" citing it.
  - **Boundaries:** empty day → `[]`. Rules emit at most one insight each and
    do not double-describe the same slot. Pure, side-effect-free.
- **`<CalendarInsights>` component** (`calendar-insights.tsx`): renders the
  array as cards (tag chip in `tone` color + text). Mounted in the calendar
  aside **after** the day's item list and **before** the color legend. Renders
  only when `insights.length > 0` (including the "Agent 洞察" heading + icon).
  Does NOT render the draft's action buttons.

### 3.3 Data layer unification

- `swarmApi.calendar` namespace added to `lib/api.ts` (mirrors the existing
  `swarmApi.bilibili` shape):
  ```ts
  calendar: {
    getStatus: () => window.swarm.calendar.getStatus(),
    listInRange: (from: number, to: number) => window.swarm.calendar.listInRange(from, to),
    createLocal: (input) => window.swarm.calendar.createLocal(input),
    deleteLocal: (id: string) => window.swarm.calendar.deleteLocal(id),
    onStateChanged: (cb) => window.swarm.calendar.onStateChanged(cb),
    // ...remaining calendar.* methods ported verbatim
  }
  ```
- `hooks/use-calendar.ts`: bodies change `window.swarm.calendar.X` →
  `swarmApi.calendar.X`; **public hook signatures unchanged**.
- `scheduled-calendar-view.tsx`: the `onStateChanged` call site is updated.
- `hooks/use-cron.ts`: grep `window.swarm` first; if it calls `window.swarm`
  directly, port those into `swarmApi` too. If it routes through another path,
  leave it. (Not forced, to avoid scope creep.)

---

## 4. Architecture

### 4.1 File structure

**New:**
- `apps/desktop/src/renderer/src/lib/calendar/build-insights.ts` — pure
  `buildCalendarInsights`.
- `apps/desktop/src/renderer/src/lib/calendar/build-insights.test.ts` — unit
  tests.
- `apps/desktop/src/renderer/src/components/views/bilibili-detail-panel.tsx` —
  the extracted persistent detail panel.
- `apps/desktop/src/renderer/src/components/views/calendar-insights.tsx` —
  the insights sidebar section.

**Modified:**
- `apps/desktop/src/renderer/src/lib/api.ts` — add `swarmApi.calendar`.
- `apps/desktop/src/renderer/src/hooks/use-calendar.ts` — call `swarmApi.calendar`.
- `apps/desktop/src/renderer/src/hooks/use-cron.ts` — (conditional) port direct
  `window.swarm` calls to `swarmApi`.
- `apps/desktop/src/renderer/src/components/views/bilibili-view.tsx` — drop
  `VideoDetailSheet`; new two-column layout; AI-stat chip; clean orphan imports.
- `apps/desktop/src/renderer/src/components/views/scheduled-calendar-view.tsx`
  — aside 300→320px; insert `<CalendarInsights>`; style/color alignment.

**Kept unchanged (reused as-is):**
- `SummaryView`, `FullTextView`, `TranscribeProgress` (consumed by the new
  detail panel).
- `bilibili-settings-view.tsx`, `calendar-view.tsx` (settings panels).
- Routes `routes/bilibili.tsx`, `routes/scheduled.tsx`.
- `rail-config.ts`.

### 4.2 Data flow (Bilibili, after restructure)

```
BilibiliView
  ├─ useQuery(['bilibili','list']) → grid
  ├─ useQuery(['bilibili','analyzedBvids']) → AI-stat chip + card AI badges
  ├─ state: selected (BiliVideo | null)
  ├─ <VideoGrid flex-1 selected onSelect />
  └─ <BilibiliDetailPanel w-[472px] video={selected} onClose />
       ├─ useQuery(['bilibili','analysis',bvid])
       ├─ useMutation(process / transcribe / save)   ← moved verbatim from VideoDetailSheet
       └─ <SummaryView /> / <FullTextView />          ← reused unchanged
```

The detail panel owns its mutation/query lifecycle (moved verbatim from
`VideoDetailSheet`); `BilibiliView` stays thin (only selection state).

---

## 5. Risks & Verification

| Risk | Mitigation |
|---|---|
| Detail-panel extraction breaks 分析/转写/保存 lifecycle. | Move all mutations + queries + `useEffect`s (bvid-change reset, transcribe-progress subscription) verbatim. Smoke the three chains. |
| Orphan references after `VideoDetailSheet` deletion. | Grep `VideoDetailSheet` before/after; remove only imports orphaned by this change (CLAUDE.md §3). |
| `buildCalendarInsights` rule edge bugs (empty, overlap, lunch). | Dedicated unit test covering empty / single / overlap / adjacent(<30min) / long-focus(≥90min) / lunch-exclusion / combined. Mirror `build-agent-activity.test.ts` density. |
| Aside widening 300→320px squeezes the month grid. | Aside is `shrink-0`, grid is `flex-1`; +20px impact is minor. Smoke at narrow widths. |
| Data-layer unification silently changes hook signatures. | Public hook signatures are **unchanged**; only bodies swap the call site. typecheck + existing calendar tests (including indirect session/tasks-page dependents) guard it. |
| `use-cron.ts` data source unclear (recon incomplete). | Grep `window.swarm` in it first; port if direct, leave if routed elsewhere. Not forced. |
| Virtualized grid vs persistent panel layout conflict. | Grid's `measureRef` still measures the `flex-1` region; the `shrink-0 w-[472px]` panel is excluded. Column derivation unchanged. |
| Parallel-session worktree pollution (weather/settings files). | Every commit uses `git add <specific files>`, never `-A`. `git status` before each commit. Baseline `develop`. |

### Success criteria (restated, verifiable)

See §1 Success criteria.

### Manual smoke (after implementation)

1. Bilibili: log in → select a video → right panel shows AI analysis; 保存到
   Obsidian succeeds; switching videos refreshes the panel.
2. Bilibili: un-analyzed video → select → panel shows empty state + button →
   click 分析 → panel fills on completion.
3. Bilibili: AI-stat chip shows "AI 已解析 N / M"; hidden when no videos.
4. 日历: pick a conflict day → "日程冲突" insight; a day with local/projection
   items → "可委派"; an afternoon-free day → "专注时段".
5. 日历: "查看运行记录 →" still navigates to the system session (preserved).
6. 日历: Monday-first preserved; three-color pills and today badge render.
7. Dark mode: Bilibili panel, calendar insight cards, three-color pills all OK.

---

## 6. Phases After This One (context only)

- **Phase 6c:** Gmail redesign — agent grouping, thread-level 助手卡, todo
  extraction, suggested replies. Separate brainstorm → spec → plan.
- **Phase 7:** settings routing.
- **Follow-up (this spec's non-goals):** background-agent calendar insights
  (action buttons like "让 Agent 预订午餐").

---

## Implementation order

1. **Spec → plan → branch `feat/service-views-bili-cal` → implement → review
   → merge.** (Write `docs/superpowers/plans/2026-07-06-service-views.md` next,
   via the writing-plans skill.)

Task breakdown (6 tasks, single branch, sequential):

```
Task 1: Data layer — swarmApi.calendar namespace (hooks keep signatures)
Task 2: Bilibili detail panel extraction (Sheet → persistent right column)
Task 3: Bilibili AI-stat chip
Task 4: Calendar buildCalendarInsights pure fn + unit tests
Task 5: Calendar <CalendarInsights> render + style alignment
Task 6: Full verify + cross-cutting review + progress ledger
```

Dependencies: Task 1 first (data layer); Task 4 before Task 5 (pure fn before
render). Tasks 2–3 (Bilibili) and 4–5 (日历) are independent but kept linear
for review cadence.
