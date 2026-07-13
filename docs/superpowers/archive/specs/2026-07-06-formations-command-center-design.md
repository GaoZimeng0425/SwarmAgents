# Formation Command Center (Phase 5) Design

**Date:** 2026-07-06
**Scope:** Phase 5 of the desktop UI redesign — promote agent management out of the Settings modal into a dedicated first-level route `/formations` (编队命令中心): a full-page org-tree of agents with live "who's working" status, click-to-highlight delegation targets, and the existing edit/detail/CRUD surface migrated from Settings. The rail is fully reorganized per design into 场景 / 服务 two segments. Settings → Agents section is removed.
**Branch:** `feat/formations-command-center` (off `refactor/ui-app-shell-rail`).
**Depends on:** Phase 1 (rail/shell). The org-tree + CRUD + static delegation graph already exist (merged) inside the Settings modal — this phase relocates and augments them.
**Out of scope:** agent avatars/icon tiles, runtime delegation visualization, animations (pulse/glow), recent-runs history in the detail panel, AgentFormSheet field additions, agent storage-path stabilization.

---

## 1. Goal

Build the design-spec 编队命令中心 (formation command center, design `Hi-fi Design.dc.html` §4a/4b) by **relocating** the existing `OrgTreeView` + detail panel + `AgentFormSheet` from the Settings modal into a new full-page route `/formations`, and **augmenting** them with a live status layer:

- **Org tree** (existing, relocated): CEO root → team groups → leaf agents, plus an independent-agents grid. Same `buildOrgForest` + node cards.
- **Live status** (NEW): each node shows a blue dot + "运行中 · {task} · {n/m 步}" when its agent has an active run anywhere (cross-session, global). Header shows "{N} 正在工作" with a haloed blue dot.
- **Delegation highlight** (NEW): selecting an agent lights up its prompt-parsed delegation targets with an amber ring + "被「{X}」委派" label. Reuses the existing `buildDelegationEdges`.
- **Detail panel + edit drawer** (existing, relocated): click a node → inline right detail panel (system prompt, delegation links, edit/duplicate/delete). Edit → right-side `AgentFormSheet` drawer.
- **Settings → Agents removed**: the section is deleted from `SettingsDialog`; the rail's 编队 item changes from an action (opening the modal) to a route (navigating to `/formations`).

### Non-goals (explicitly deferred)

- **Agent avatars / icon tiles.** Design shows 28px icon tiles per node; current rendering is text-only (name + role id). Stays text-only this phase.
- **Runtime delegation visualization.** Design caption is explicit: "委派关系由提示词解析,非运行时调用" — delegation is the existing static, prompt-parsed graph. `run.delegation_plan` / `parentRunId` runtime edges are NOT drawn.
- **Animations (pulse/glow).** The design file has zero `@keyframes`/`animation` rules. "Lighting up" = static color + `box-shadow`; no pulsing.
- **Recent-runs history in the detail panel.** Design shows only the current-task pill ("运行中 · n/m 步"); no list of past runs. The transcript remains the history source.
- **`AgentFormSheet` field additions.** The form omits `skills` and `thinkingLevel` (a pre-existing gap noted in review). Not widened in this phase.
- **Agent storage path stabilization.** `SWARM_SERVICE_AGENTS_PATH` defaults to `tmpdir`; user-authored agents don't survive a tmpdir clear. Tracked as a follow-up; not changed here.
- **"新建编队/团队" creator flow.** Design only draws "新建 Agent"; teams form implicitly via the agent's `team` field. No team-creation UI.
- **`/agents` alias route.** Only `/formations` is added (matching the rail label 编队 and the design's `data-screen-label`). No `/agents` alias.

### Success criteria

- The rail's 编队 entry navigates to `/formations` (a real route, not a modal action). The route renders the org tree full-width with a right detail panel.
- Selecting an agent populates the detail panel (system prompt, delegation links, edit/duplicate/delete). Editing opens the `AgentFormSheet` drawer. Creating (header "新建 Agent" button) opens the same drawer blank.
- Each agent node shows live status: blue dot + "运行中 · {task} · {n/m 步}" when its agent has an active run (any session), else "空闲". The header shows "{N} 正在工作" when N > 0.
- Selecting an agent highlights its `buildDelegationEdges` targets with an amber ring + "被「{X}」委派" label; deselecting clears it.
- Settings → Agents section is gone; the rail's Settings opens the modal without an Agents tab. The 命令面板 (Phase 3b) "新建编队" command + agent items navigate to `/formations` instead of `openSettings('agents')`.
- The rail is reorganized: 场景 = 任务台/对话/编队/日历; 服务 = Gmail/trending/Bilibili; footer = 用量/设置. 自动化 (duplicate of 日历's `/scheduled` route) is removed; 用量 moves to footer.
- Existing tests pass; new `buildAgentActivity` + the relocated view have unit/integration tests.

---

## 2. Design Decisions (locked from brainstorm)

| Decision | Choice | Rationale |
|---|---|---|
| Settings → Agents fate | Removed; all agent management at `/formations` | Design: "Agents 从设置弹窗提到 rail 一级". Single source of truth. |
| Live status scope | Cross-session global: any active run lights the node | Matches "谁在干活" intent; dashboard runs already global. |
| Delegation highlight trigger | Selecting an agent lights its static (prompt-parsed) targets | Design caption: delegation is prompt-parsed, not runtime. Reuses `buildDelegationEdges`. |
| Agent avatar | None (text-only, as today) | YAGNI; design's icon tile deferred. |
| Rail reorg | Full, per design | 场景 4 / 服务 3 / footer 2; 编队 action→route; 自动化 merged into 日历; 用量 → footer. |
| Multi-active-run display | Show only the newest active run per agent | Simpler; an agent with 3 concurrent runs shows the latest one's task/progress. |
| 自动化 / 日历 | Merged (both → `/scheduled`); only 日历 stays | They share a route; one rail entry suffices. |

---

## 3. Formation Center Specification (from design `Hi-fi Design.dc.html` §4a/4b)

### 3.1 Geometry & visual

- **Route layout:** 3 columns inside the route component: rail (global, unchanged) / org tree `flex-1` / detail panel `w-[328px]`. (The rail is the global AppRail; the route itself is the org-tree + detail-panel pair, sized to fill `SidebarInset`.)
- **Org-tree column:** `bg-background`, 52px header bar (title "{N} 个 Agent" + "{activeCount} 正在工作" pill + "新建 Agent" button), then a scrollable body `p-[22px_28px]`.
- **Detail panel:** `w-[328px] bg-secondary border-l border-border/60`, scrollable. Shows the selected agent or an empty state.
- **Tokens** (map to existing Tailwind/CSS vars): running blue `text-[#3478f6]` (use `text-primary` where it tracks the system accent; design hardcodes macOS blue); amber `text-[#a3690f]` / `rgba(226,176,107,.4)` ring; selected ring `border-primary + shadow-[0_0_0_2px_rgba(28,28,30,.08)]`; idle `text-muted-foreground`.

### 3.2 Org tree (relocated, augmented)

- `buildOrgForest(agents)` (existing) → forest of `OrgNode`. Rendered as today: root CEO card full-width; team groups indented under a `border-l` connector (`margin-left:15px; padding-left:16px; border-color: rgba(0,0,0,.1)` / dark equivalent); independent agents (no team/parent) as a 2-col grid at the bottom.
- **Node card** (existing layout, + status line): name (font-medium) + role id (mono muted) + scope chip + capability chips + a NEW status line (running blue / idle muted). Selected = `border-primary` + soft ring. Delegation target = amber `box-shadow` ring.
- No avatar tile (text-only, per locked decision).

### 3.3 Live status (NEW)

- **`buildAgentActivity(runs, sessions): Map<agentId, AgentActivity>`** — pure function in `lib/formations/build-agent-activity.ts`.
  ```ts
  type AgentActivity = {
    status: 'running' | 'idle'
    currentTask?: string   // newest active run's goal, truncated 40 chars
    stepProgress?: string  // "n/m 步" from that run's plan; omitted if no plan
  }
  ```
  - Filter `runs` to `status === 'running' || 'pending'`.
  - Resolve agentId per run: `run.agentDefId` if present (sub-run); else `sessions.find(s => s.id === run.sessionId)?.agentType` (top-level). Skip runs whose agentId resolves to undefined.
  - Group by agentId; for each, take the run with the largest `startedAt`. Derive `currentTask` (truncate `goal` to 40 chars) and `stepProgress` (`${plan.filter(p => p.status === 'completed').length}/${plan.length} 步`, only if `plan?.length`).
  - The map contains ONLY agents with active runs. Agents not in the map = idle.
- **`useAgentActivity()`** — hook in `hooks/use-agent-activity.ts`: subscribes to `useRuns()` + `useSessionsStore`, returns the `Map` (memoized via `useMemo`).
- **Render on node:** running → blue 5px dot + `运行中 · {currentTask}${stepProgress ? ' · ' + stepProgress : ''}`; idle → `空闲` muted.
- **Header count:** `{activeCount} 正在工作` where `activeCount = unique agentIds in the activity map`. Prefix with a 6px blue dot carrying `shadow-[0_0_0_3px_rgba(52,120,246,.18)]`. Hidden when `activeCount === 0`.

### 3.4 Delegation highlight (NEW)

- On selecting an agent `X`, compute `highlightedTargets = new Set(delegationEdges.filter(e => e.from === X.id).map(e => e.to))` where `delegationEdges = buildDelegationEdges(agents)` (existing).
- Nodes in `highlightedTargets` get: `box-shadow: 0 0 0 2px rgba(226,176,107,.4)` ring + a status line `<ArrowRight className="size-3" style={{color:'#c77d1e'}}/>` + `text-[#a3690f]` `被「{X.name}」委派`.
- Deselecting (or selecting a different agent) recomputes the set. Selecting an agent with no outbound delegation edges highlights nothing.

### 3.5 Detail panel (relocated)

- The existing `AgentDetail` + `DelegationLinks` content moves into the route's right panel (328px). Sections: header (name + role·team + running pill + edit pencil), 工具范围 chips (derived from `capabilities`), 系统提示 box (truncated 140px), 委派给/被调用 chips (existing `DelegationLinks`), footer (编辑 / copy / delete).
- Running pill mirrors design: `bg-[rgba(52,120,246,.09)] text-[#3478f6] rounded-full` + 5px blue dot + `运行中${stepProgress ? ' · ' + stepProgress : ''}`. Filled from the selected agent's `AgentActivity` (if any).
- Empty state (no selection): `选择一个 Agent 查看详情` muted.
- 编辑 button opens the `AgentFormSheet` drawer (relocated, unchanged fields).

### 3.6 Edit drawer (relocated, unchanged)

`AgentFormSheet` (existing) is reused verbatim — same fields (id/name/description/systemPrompt/authoring/parentId/team/teamHead/role/capabilities/model/maxIterations), same create/edit/duplicate flows. Only its mount point changes (from inside SettingsDialog → inside the `/formations` route's state). The drawer's title/CTA already swap on create vs edit.

### 3.7 Rail reorganization (per design §4a rail)

`RAIL_SECTIONS` in `rail-config.ts` becomes:
- **scenes** (4): 任务台 `/` · 对话 `/session/` · 编队 `/formations` (route, exact) · 日历 `/scheduled`.
- **services** (3): Gmail `/gmail` · GitHub 趋势 `/trending` · Bilibili `/bilibili`.
- **footer (rendered in app-rail.tsx, not RAIL_SECTIONS):** 用量 `/usage` · 设置 (action, opens SettingsDialog).

Changes from current:
- 编队: `target.kind` `'action'` → `'route'`, `to: '/formations'`, `match: 'exact'`.
- 自动化 item: **removed** (duplicate of 日历's `/scheduled`).
- 用量: moved from scenes → footer.
- `app-rail.tsx`: the `if (item.key === 'formation') openSettings('agents')` special-case is deleted (编队 is now a normal route item).
- 用量 as a footer item: `app-rail.tsx` already renders 设置 in the footer; add 用量 beside it (route item, `/usage`).

---

## 4. Architecture

### 4.1 File structure

**New:**
- `apps/desktop/src/renderer/src/routes/formations.tsx` — the route (`/formations`).
- `apps/desktop/src/renderer/src/components/views/formations-view.tsx` — the 3-column page (org-tree + detail panel; owns selection + drawer state).
- `apps/desktop/src/renderer/src/lib/formations/build-agent-activity.ts` — pure `buildAgentActivity`.
- `apps/desktop/src/renderer/src/hooks/use-agent-activity.ts` — `useAgentActivity()` hook.

**Modified:**
- `apps/desktop/src/renderer/src/components/views/org-tree-view.tsx` — accept NEW props: `activity?: Map<string, AgentActivity>`, `highlightedTargets?: Set<string>`, `selectedId?: string`, `onSelect?: (id: string) => void`. Render the status line + amber ring + selection ring from these. **Decomposition:** today `OrgTreeView` owns selection (`expanded` state), the detail `Sheet` (containing `AgentDetail` + `DelegationLinks`), and the `AgentFormSheet`. This phase **splits responsibilities**: `OrgTreeView` keeps node-card rendering + `buildOrgForest` + per-node callbacks (`onSelect`/`onEdit`/`onDuplicate`/`onDelete`), but DROPS its internal `Sheet`/`SheetState`/`expanded` — selection + the form sheet lift to `FormationsView`. The detail `AgentDetail`+`DelegationLinks` moves out of a `Sheet` into `FormationsView`'s sibling detail column (always visible, not overlay). Concretely `OrgTreeView`'s body becomes: header (title/count/新建 button) + the indented forest; the two `Sheet`s at the bottom of the current file are deleted (their content moves to `FormationsView`).
- `apps/desktop/src/renderer/src/components/rail-config.ts` — `RAIL_SECTIONS` reorganization + the 编队 route change.
- `apps/desktop/src/renderer/src/components/app-rail.tsx` — drop the 编队 special-case; add 用量 to the footer.
- `apps/desktop/src/renderer/src/components/settings-dialog.tsx` — remove the `agents` section entry from `SECTIONS`.
- `apps/desktop/src/renderer/src/stores/settings-dialog.ts` — remove `'agents'` from the `SettingsSection` union.
- `apps/desktop/src/renderer/src/lib/palette/build-items.ts` (Phase 3b) — the "新建编队" command and any `openSettings('agents')` calls become `navigate('/formations')`.

**Deleted (now-unused after Settings removal):**
- `apps/desktop/src/renderer/src/components/views/agents-view.tsx` — only ever mounted inside SettingsDialog; replaced by `formations-view.tsx`.

**Kept (relocated implicitly, file path unchanged):**
- `agent-form-sheet.tsx`, `agent-detail.tsx`, `delegation-links.tsx` — mounted by `FormationsView` instead of `OrgTreeView`/`AgentsView`. Their code is unchanged.

### 4.2 Data flow

```
/formations route (FormationsView)
  ├─ useQuery(['agents','settings'], swarmApi.listAgents)  // existing
  ├─ useAgentActivity()  → Map<agentId, AgentActivity>     // NEW
  ├─ buildDelegationEdges(agents)                          // existing
  ├─ state: selectedId, sheetState (create/edit/duplicate/null)
  ├─ <OrgTreeView
  │     agents activity highlightedTargets={outbound of selected}
  │     selectedId onSelect={setSelectedId}
  │     onEdit={openSheet(edit)} onDuplicate onNewAgent onDeleted />
  ├─ <FormationDetailPanel agent={selected} activity={...} onEdit .../>  // relocated AgentDetail
  └─ <AgentFormSheet ... />  // when sheetState != null
```

The activity map + delegation edges are derived once in `FormationsView` and passed down; `OrgTreeView` becomes a controlled presentational component (it currently owns selection + sheets — those lift to `FormationsView`).

### 4.3 Selection model

- `FormationsView` owns `selectedId: string | null` (the previous in-`OrgTreeView` `useState`).
- `onSelect(id)` sets it; the detail panel reads it; `highlightedTargets` is derived from it + delegation edges.
- The previous `OrgTreeView` mounted the detail as a `Sheet` (overlay) and the form as another `Sheet`. In the route, the detail is a sibling column (always visible, not a Sheet); only the form remains a `Sheet`/drawer.

---

## 5. Risks & Verification

| Risk | Mitigation |
|---|---|
| Lifting selection + sheet state out of `OrgTreeView` is invasive (it currently owns both). | Do it carefully: `OrgTreeView` keeps node rendering + `buildOrgForest`; selection/sheets lift to `FormationsView`. Test the create/edit/duplicate/delete flows still work end-to-end. |
| Removing Settings → Agents orphans the `agents-view.tsx` import. | Delete `agents-view.tsx`; grep for stale `AgentsView` importers. |
| `'agents'` removal from `SettingsSection` breaks `openSettings('agents')` callers. | Sweep before merge: palette (`build-items.ts`), any other caller. All become `navigate('/formations')`. |
| 自动化 rail-item removal — confirm nothing else links the `automation` key. | Grep `key === 'automation'` + the `Clock` icon import. |
| Top-level run with `agentType === undefined` (optimistic session). | `buildAgentActivity` skips runs whose agentId resolves undefined — they don't light any node. |
| `useAgentActivity` recomputes each render. | Memoize on `[runs, sessions]`. Volume is bounded (active runs only). |

### Manual smoke test (after implementation)

1. Click rail 编队 → navigates to `/formations`; org tree renders; rail 编队 tile shows active.
2. Click an agent node → detail panel populates; amber rings appear on its delegation targets.
3. Trigger a run (any session) → the running agent's node shows a blue dot + task + step progress; header count increments.
4. Click 新建 Agent → drawer opens blank; create flows through; new agent appears in tree.
5. Click 编辑 on a node → drawer opens prefilled; save updates the node.
6. Open Settings → no Agents section.
7. Open ⌘K palette → "新建编队" + agent items navigate to `/formations`.
8. Rail: 场景 = 任务台/对话/编队/日历; 服务 = Gmail/trending/Bilibili; footer = 用量/设置. 自动化 gone; 用量 in footer.
9. Dark mode renders correctly (amber ring, blue dot, selected ring).

---

## 6. Phases After This One (context only)

6. service views · 7. settings routing. Each gets its own spec → plan → branch.

---

## Implementation order

1. **Spec → plan → branch `feat/formations-command-center` → implement → review → merge.** (Write `docs/superpowers/plans/2026-07-06-formations-command-center.md` next.)
