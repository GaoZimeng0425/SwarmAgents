# Session Workspace Four-Tab Refactor — Phase 4

**Date:** 2026-07-06
**Scope:** Phase 4 of the desktop UI redesign — rework the session route's right panel (`RightPanel`) into the design-spec 会话工作台 workspace: a 300px-wide, collapsible panel with four folder-style tabs (计划 / 时间线 / 产出物 / 审批), the last carrying an approval count badge. Replaces the current Plan/Memory/Scheduled three-tab panel.
**Branch:** `feat/session-workspace` (off `refactor/ui-app-shell-rail`).
**Depends on:** Phase 1 (rail/shell), Phase 3a (`swarmApi.listArtifacts` — reused by the 产出物 tab). Phases 2/3b are merged on `refactor/ui-app-shell-rail` and are the base.
**Out of scope:** conversation-flow (chat column) changes, resizable workspace, diff previews, "always allow this session" permission granularity, dashboard-level approval aggregation.

---

## 1. Goal

Replace the session route's right panel with the four-tab workspace per design `Hi-fi Design.dc.html` screens 2b/3b (会话工作台). The conversation column (`ConversationThread` + `ChatInput` + `ComposerOverlay`) stays untouched; only the panel to its right changes.

The four tabs:
- **计划 (Plan)** — reuse existing `PlanPanel` (session-wide plan history) + add a session-level usage footer.
- **时间线 (Timeline)** — NEW. Event-log view derived from `RunRecord.events`.
- **产出物 (Artifacts)** — NEW. Aggregates file paths extracted from the session's tool calls + `swarmApi.listArtifacts({cwd})`, deduplicated.
- **审批 (Approval)** — NEW. Lists the current session's pending permission prompts (reuses `PermissionCard`'s decision logic); the tab label carries an amber count badge.

### Non-goals (explicitly deferred)

- **Conversation-flow redesign.** The design's collapsed tool cards, floating minimap, context donut, and tool-card restyling all live in the chat column — OUT of scope. This phase touches only the right panel.
- **Resizable workspace.** `@swarm/ui` ships a `Resizable*` primitive (unused), but the workspace is fixed 300px + a collapse toggle. Drag-to-resize is deferred.
- **Diff preview ("查看差异 →").** The 产出物 tab lists files and opens them via `window.swarm.openPath`; it does NOT render inline diffs.
- **"Always allow this session" / three-level approval granularity.** The design's approval card shows 允许 / 本会会话始终允许 / 拒绝. The current `PermissionCard` supports Allow / Deny / Skip only; "always allow" requires a permission-protocol change and is deferred. The 审批 tab reuses the existing three actions.
- **"正在执行" dark terminal mini-panel inside the 计划 tab.** Overlaps with the 时间线 tab; deferred.
- **Dashboard-level approval aggregation ("审批不用进会话").** The design caption suggests handling approvals from the dashboard without entering a session. This phase adds the 审批 tab *inside* the session; cross-session approval surfacing on the dashboard is a later phase.

### Success criteria

- The session route (`/session/$sessionId`) shows a 300px right panel with four folder-style tabs; the panel collapses to hidden via a toggle (default expanded).
- 计划 tab renders `PlanPanel` (unchanged behavior) + a footer with session token usage (`Nk tokens`).
- 时间线 tab renders an event log: timestamp + event-type icon + label per `RunRecord.events` row, with `run.progress` collapsed out.
- 产出物 tab renders a deduplicated file list (session tool-call extraction + `listArtifacts({cwd})`); clicking a row calls `window.swarm.openPath(ref)`.
- 审批 tab renders the current session's pending `PermissionPrompt[]` (filtered from `usePermissionStore`), each reusing the existing decision flow; the tab label shows an amber badge with the count when > 0.
- Memory and Scheduled tabs are removed from the workspace (their content remains reachable via the command palette, Settings, the dashboard, and `/scheduled`).
- Existing tests pass; new pure builders + the workspace panel have unit tests.

---

## 2. Design Decisions (locked from brainstorm)

| Decision | Choice | Rationale |
|---|---|---|
| Workspace visibility | Default expanded + manual collapse toggle | Matches existing `RightPanel` behavior; simplest. Design's "collapsed-by-default hover-to-reveal" is aspirational, deferred. |
| Workspace width | Fixed 300px | Per design. No drag-to-resize (`Resizable` primitive available but unused — YAGNI). |
| Approval UI placement | Both: chat floating card (current) + 审批 tab | Chat card stays for the "act now" prompt; tab lists all pending + history. Same `usePermissionStore` source. |
| Timeline tab content | Event-log: timestamp + event-type + tool icon | Reuses the orphaned `task-timeline.tsx` `eventLabel` as a starting point; `run.progress` collapsed (too dense). |
| 产出物 tab data | Session events extraction + `listArtifacts({cwd})`, deduplicated | "Session outputs" alone is often empty; cwd recents fill the tab. Two sources merged. |
| Memory/Scheduled tabs | Removed | Design's four tabs don't include them; their content is reachable elsewhere (palette/Settings/dashboard/`/scheduled`). |
| Resizable | No | YAGNI; fixed 300px + toggle. |
| Approval granularity | Existing Allow/Deny/Skip only | "Always allow" needs protocol change; deferred. |

---

## 3. Workspace Specification (from design `Hi-fi Design.dc.html` §2b/3b)

### 3.1 Geometry & visual

- **Panel:** 300px fixed width, full height, `bg-secondary` (light `#f7f7f5` / dark `#202022`), `border-l border-border/60`. Collapsible to hidden via a toggle; when collapsed the conversation column expands to fill (`flex-1`).
- **Tab strip:** folder-style. Active tab: `bg-background` (white/`#262628`), full border with `border-bottom:none`, `rounded-t-lg` (9px top corners), `font-semibold`. Inactive: muted text (`text-muted-foreground`), no bg, no border. Tabs are text-only (no icons). Strip has `border-b` separating it from content.
- **审批 badge:** amber pill on the 审批 tab label — `min-w-[15px] h-[15px] rounded-full bg-amber-600 text-white text-[9.5px] font-bold flex items-center justify-center px-1`, dark variant inverts text. Renders ONLY when the current session's pending count > 0.
- **Tab content:** scrollable (`cmdscroll`), `p-4`, `flex flex-col gap-1.5`.
- **Collapse toggle:** a small button (chevron) at the panel's top-right or on the left edge; when collapsed, a thin re-expand affordance remains (chevron pointing left) on the conversation column's right edge.

### 3.2 The four tabs (labels verbatim)

`计划` · `时间线` · `产出物` · `审批[badge]`

### 3.3 计划 tab content

- Renders the existing `<PlanPanel groups={planGroups} />` (unchanged). `planGroups` is computed in `TasksView` exactly as today (top-level runs with a non-empty plan, sorted by `startedAt`).
- **NEW footer** pinned to the tab bottom: `用时 {duration} · {tokens} tokens`.
  - `duration`: `now - firstRun.startedAt` formatted via `formatRelativeTime` (reuses the Phase 2 helper), or `—` if no runs.
  - `tokens`: `session.tokensUsed` from `useSessionsStore` (already aggregated server-side), formatted as `N.Nk` or `—` if undefined.
- The footer is a small `text-[11.5px] text-muted-foreground` row with a `flex-1` spacer above it.

### 3.4 时间线 tab content

- **Data:** `RunRecord[]` for the session → flatten each run's `.events` → sort by `ts` asc → filter out `run.progress` events (too dense; their substance shows in 计划/产出物) → map to `TimelineRow[]`.
- **`TimelineRow` shape:** `{ id: string; ts: number; kind: TimelineKind; label: string; tool?: string }`.
- **`TimelineKind` + icon + label** (derived from `UIEvent.kind`, reusing the orphan `task-timeline.tsx`'s `eventLabel` logic):
  | `UIEvent.kind` | TimelineKind | icon (lucide) | label source |
  |---|---|---|---|
  | `run.created` | `start` | `Rocket` | goal (truncated 60 chars) |
  | `run.dispatched` | `dispatch` | `PlayCircle` | (static "派发") |
  | `run.tool_call` | `tool` | `Wrench` | the `tool` field |
  | `run.permission_request` | `permission` | `ShieldAlert` (amber) | `summary` (truncated) |
  | `run.complete` | `complete` | `CheckCircle2` (green) | `summary` (truncated) |
  | `run.error` | `error` | `XCircle` (red) | `error.message` |
  | `run.usage` / `run.plan` / `run.spawned` / `run.delegation_plan` | (filtered out) | — | — |
- **Row render:** `mono text-[11px]` timestamp (`HH:mm`, absolute short — NEW tiny helper or inline) + icon + label. Hover shows full label via `title` attr. No click action in this phase (clicking to jump into the transcript is a follow-up).
- **Pure builder:** `buildTimeline(runs: RunRecord[]): TimelineRow[]` in `lib/workspace/build-timeline.ts`, unit-tested.

### 3.5 产出物 tab content

- **Two sources merged, deduplicated by normalized path:**
  1. **Session outputs** — scan the session's `RunRecord.events` for `run.tool_call` events; extract file-path-like strings from `args` using this explicit heuristic: a string value (or string element of an array value) in the `args` object that matches `/^(\.{0,2}\/|[A-Za-z]:\\)/` (i.e. starts with `/`, `./`, `../`, or a Windows drive) AND contains at least one `.` in the final segment (extension). This catches absolute/relative file paths while ignoring URLs, identifiers, and prose. Normalize, dedupe, tag `origin: 'session'`. Tools that don't pass such a string simply contribute nothing — the extraction is best-effort by design.
  2. **cwd recents** — `swarmApi.listArtifacts({ cwd })` where `cwd` is the session's `cwd` (from `SessionSummary.cwd` via `useSessionsStore`). Returns `ArtifactEntry[]` (kind `'file'|'bilibili-analysis'`). Map files to rows, tag `origin: <cwd short>`.
- **`ArtifactRow` shape:** `{ id: string; name: string; ref: string; origin: string; modifiedAt?: number }`.
- **Dedup:** normalize paths (resolve `.`, `..`, trailing `/`); session outputs win on collision (shown first).
- **Order:** session outputs first (most recent modifiedAt desc), then cwd recents (modifiedAt desc).
- **Row render:** file icon (`FileText` for session/files, `Film` for bilibili) + name (font-medium) + origin badge (muted) + relative time. Click → `window.swarm.openPath(ref)` for files; `window.swarm.bilibili.open(ref)` for bilibili analyses.
- **Empty state:** `暂无产出物` muted text.
- **Pure builder:** `buildArtifacts(runs: RunRecord[], cwdArtifacts: ArtifactEntry[]): ArtifactRow[]` in `lib/workspace/build-artifacts.ts`, unit-tested (mock both inputs).

### 3.6 审批 tab content

- **Data:** `usePermissionStore((s) => s.queue)` filtered by `p.sessionId === currentSessionId`. The decision flow reuses the existing `PermissionCard`'s `onDecide(actionId, 'grant'|'deny'|'skip')` against `swarmApi` (the same path `ComposerOverlay` uses today).
- **Each item:** a compact card (reuses `PermissionCard`'s visual + the three existing actions Allow / Deny / Skip). Risk color-coding per existing `PermissionCard`.
- **History:** when a prompt is decided it leaves the queue (existing `remove`), so the tab naturally shows only pending. NO persistent history of past decisions in this phase (the transcript's inline `<details>` permission row remains the history record).
- **Empty state:** `暂无待审批` muted text; badge hidden.
- **Badge count:** `queue.filter(p => p.sessionId === currentSessionId).length`, rendered on the tab label.

### 3.7 Collapse behavior

- The panel's collapse toggle flips a local state (mirroring today's `RightPanel`). Collapsed = `hidden` (conversation expands to fill). A re-expand chevron remains anchored on the conversation column's right edge.
- The collapse state is component-local `useState` (NOT persisted across sessions or route changes) — matches current behavior; persistence is a follow-up.

---

## 4. Architecture

### 4.1 File structure

**Pure builders (unit-tested, no React) — new:**
- `apps/desktop/src/renderer/src/lib/workspace/build-timeline.ts` — `buildTimeline(runs): TimelineRow[]`.
- `apps/desktop/src/renderer/src/lib/workspace/build-artifacts.ts` — `buildArtifacts(runs, cwdArtifacts): ArtifactRow[]`.
- (Each with a colocated `.test.ts`.)

**React components — new:**
- `apps/desktop/src/renderer/src/components/workspace/workspace-panel.tsx` — the shell (300px aside + collapse toggle + folder-style Tabs).
- `apps/desktop/src/renderer/src/components/workspace/timeline-tab.tsx` — renders `TimelineRow[]`.
- `apps/desktop/src/renderer/src/components/workspace/artifacts-tab.tsx` — renders `ArtifactRow[]` + calls `listArtifacts` via TanStack Query.
- `apps/desktop/src/renderer/src/components/workspace/approval-tab.tsx` — renders filtered `usePermissionStore.queue` with `PermissionCard`s.
- `apps/desktop/src/renderer/src/components/workspace/plan-usage-footer.tsx` — the small `用时 · Nk tokens` footer.

**Modified:**
- `apps/desktop/src/renderer/src/components/views/tasks-view.tsx` — replace `<RightPanel planGroups={...} />` with `<WorkspacePanel {...} />`; compute the new props (`runs`, `session`, `cwd`); the `planGroups` computation stays.
- `apps/desktop/src/renderer/src/components/right-panel.tsx` — DELETED (replaced by `workspace-panel.tsx`). Its `MemoryPanel`/`CronPanel` imports are dropped from the session route (their content remains mounted elsewhere: Memory via the palette/settings, Cron via dashboard/`/scheduled`).
- `apps/desktop/src/renderer/src/components/plan-panel.tsx` — UNCHANGED (reused as-is inside 计划 tab).

**Deleted (orphan after removal):**
- `apps/desktop/src/renderer/src/components/task-timeline.tsx` — fold its `eventLabel` logic into `build-timeline.ts`, then delete the orphan.

### 4.2 Data flow

```
TasksView
  ├─ useSessionsStore → currentSessionId, session.cwd, session.tokensUsed
  ├─ sessionTasks: RunRecord[] (existing selector)
  ├─ planGroups (existing derivation)
  ├─ <ConversationThread .../>         (UNCHANGED)
  ├─ <ChatInput ... overlay={<ComposerOverlay/>}/>  (UNCHANGED — incl. floating approval)
  └─ <WorkspacePanel
        runs={sessionTasks}
        planGroups={planGroups}
        session={session}          // for cwd, tokensUsed
        permissionQueue={filtered} // computed inside via usePermissionStore
     />

WorkspacePanel
  ├─ Tabs (folder-style): 计划 | 时间线 | 产出物 | 审批[badge]
  ├─ 计划 → <PlanPanel groups={planGroups}/> + <PlanUsageFooter session={session}/>
  ├─ 时间线 → buildTimeline(runs) → <TimelineTab rows={...}/>
  ├─ 产出物 → useQuery(listArtifacts, cwd) + buildArtifacts(runs, data) → <ArtifactsTab rows={...}/>
  └─ 审批 → usePermissionStore filtered → <ApprovalTab prompts={...}/>  (badge count on tab)
```

### 4.3 Folder-style Tabs implementation

Use `@swarm/ui`'s `Tabs`/`TabsList`/`TabsTrigger`/`TabsContent` (Base UI underneath, already used by the old `RightPanel`). Apply className overrides for the folder look:
- `TabsList`: `bg-transparent border-b border-border/60 p-0 gap-0.5 px-3 pt-3`.
- `TabsTrigger` active state via `data-[state=active]:bg-background data-[state=active]:border data-[state=active]:border-b-0 data-[state=active]:border-border/60 data-[state=active]:rounded-t-lg data-[state=active]:font-semibold`; inactive `text-muted-foreground`.
- The 审批 `TabsTrigger` contains the tab text + a conditional `{count > 0 && <span className="badge...">{count}</span>}`.

### 4.4 Approval badge + chat card coexistence

The chat's floating `PermissionCard` (in `ComposerOverlay`) and the 审批 tab both read `usePermissionStore.queue` filtered to the session. They are two views of the same data:
- Chat card = the head of the queue (the "act now" prompt), rendered by `ComposerOverlay` as today.
- 审批 tab = the full pending list (could be > 1 if multiple tools requested in parallel).
Decisions made in either place call the same `onDecide` path; the store updates and both views reconcile.

---

## 5. Risks & Verification

| Risk | Mitigation |
|---|---|
| File-path extraction from `tool_call` args is unreliable (tools vary). | Best-effort heuristic; misses are acceptable (the tab falls back to cwd recents). Document the heuristic in `build-artifacts.ts`. |
| `listArtifacts({cwd})` is slow on large repos. | Already mitigated in Phase 3a (depth cap, mtime filter, 60s cache via TanStack Query `staleTime`). |
| Removing Memory/Scheduled tabs loses discoverability. | Confirm both are reachable elsewhere before merge: Memory via palette `>`/settings, Cron via dashboard + `/scheduled`. |
| Folder-style Tabs className override is fragile against Base UI internals. | Validate in the shell-skeleton task; fall back to a simpler active style if the data-attributes don't cooperate. |
| Approval badge count diverges from chat card. | Both derive from the same `usePermissionStore` selector; no separate state. |
| `task-timeline.tsx` deletion orphans an import. | grep sweep after fold; the orphan is currently unmounted (verified). |

### Manual smoke test (after implementation)

1. Open a session — workspace shows 300px with 4 folder tabs; 计划 active.
2. 计划 tab: plan history renders; footer shows `用时 · Nk tokens`.
3. 时间线 tab: events listed with timestamps + icons; `run.progress` absent.
4. 产出物 tab: files from session + cwd listed; click opens via `openPath`; bilibili items open via `bilibili.open`.
5. Trigger a permission request: chat floating card appears AND 审批 badge shows count; deciding in either place clears both.
6. Collapse toggle: panel hides, conversation expands; re-expand restores.
7. Memory/Scheduled: confirm no longer in workspace; Memory still in palette/Settings; Scheduled still on dashboard + `/scheduled`.
8. Dark mode: folder tabs, badge amber, surfaces render correctly.

---

## 6. Phases After This One (context only)

5. 编队 command center · 6. service views · 7. settings routing. Each gets its own spec → plan → branch.

---

## Implementation order

1. **Spec → plan → branch `feat/session-workspace` → implement → review → merge.** (Write `docs/superpowers/plans/2026-07-06-session-workspace-four-tab.md` next.)
