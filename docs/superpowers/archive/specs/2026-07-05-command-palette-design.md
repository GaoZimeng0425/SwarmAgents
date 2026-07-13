# Unified Command Palette (⌘K) Refactor — Phase 3

**Date:** 2026-07-05
**Scope:** Phase 3 of the desktop UI redesign — replace the session-only `SessionSearchDialog` with the design-spec ⌘K unified command palette: 760×660 frosted-glass two-column palette with four prefix scopes (`>`/`@`/`#`/`/`) + mixed mode, seven result categories, a right-side preview pane with five preview types, full keyboard navigation, and a mixed-mode hero dispatch.
**Branches:** Phase 3a `feat/cmd-palette-backend` (service + IPC + preload + protocol), Phase 3b `feat/cmd-palette-ui` (renderer), both from `refactor/ui-app-shell-rail` (Phase 1).
**Depends on:** Phase 1 (`refactor/ui-app-shell-rail`). Phase 2 is independent (can land before or after).
**Out of scope:** 会话工作台 four-tab workspace, 编队 command center, service-view redesigns, settings routing.

---

## 1. Goal

Build the design-spec ⌘K palette end-to-end. Split into two sub-projects delivered on separate branches:

- **Phase 3a — Backend:** the data services the palette needs that don't exist yet — (1) session-Markdown export, (2) an observable-artifact index (cwd-recent-files + session attachments + bilibili analyses). Adds IPC channels, preload bridge methods, and protocol types; exposes them via `swarmApi`. No UI changes.
- **Phase 3b — Frontend:** the palette itself — custom two-column shell, scope parsing, grouped results, five preview types, keyboard nav, hero dispatch. Replaces `SessionSearchDialog`. Consumes Phase 3a's APIs plus existing hooks (`useRuns`, `useAllCronJobs`, `useSessionsStore`, `useTeamOptions`, `useMemory`, `useSkills`).

### Non-goals (explicitly deferred)

- **Agent-runtime artifact reporting.** Today the service returns `artifacts: []` for every run; making tools actually report produced files is a deep change in the agent/tool layer and is OUT of scope. The `/` scope uses *observable* outputs only (cwd-recent-files + composer attachments + bilibili analyses), accepting that agent-produced files not under cwd won't appear.
- **Per-task "上次结果" / chat-message preview richness.** Lazy-hydrated where cheap; simplified (status-only) where not. Tracked as follow-up.
- **A real "formation" entity.** The design's 研究编队 / 日报编队 are aspirational; in code, "formation" = an agent with `teamRole: 'head'` via `useTeamOptions()`. The hero dispatch's formation picker selects among team heads + `ceo` default — no new persistence.
- **`新建定时任务` creator UI.** No creator exists today (cron jobs are made by the agent via tools). The `>` command surfaces but routes to the system session ("定时任务") rather than a true creator flow.
- **`新建编队` creator UI.** Routes to Settings → Agents.
- **`⌘N` global accelerator.** The `新建对话` command navigates to `/`; registering the native ⌘N hotkey is a separate main-process menu change, deferred.

### Success criteria

**Phase 3a:**
- `swarmApi.exportSessionMarkdown(sessionId)` writes a `.md` file to `userData/exports/` and opens it; returns `{ path }`.
- `swarmApi.listArtifacts(query?)` returns a flat `ArtifactEntry[]` derived from cwd-recent-files + composer attachments across sessions + bilibili analyses; queryable by substring.
- Both have IPC channels wired through main → service, preload bridge methods, and `SwarmBridge`/`swarmApi` typings.
- Existing tests pass; new service methods have unit tests against a temp DB / temp dir.

**Phase 3b:**
- ⌘K (and the dashboard/sidebar search buttons) open the new palette.
- Four prefix scopes parse and colorize the input row correctly; Backspace on a lone prefix clears scope; Escape clears query then closes.
- Each scope surfaces its category(ies); mixed mode shows empty-state (continue/suggestions/recent/shortcuts) and with-query state (hero dispatch + filtered groups).
- Right preview pane renders all five types (dispatch/chat/taskRun/taskSched/info) bound to the selected item.
- Keyboard navigation (↑/↓/Enter/Escape/Backspace) works; selection drives the preview.
- Hero dispatch's Enter submits via `useSubmitGoal` with the picked formation's `agentType`; navigates to the new session.
- Per-kind `run()` actions fire (navigate/open settings/toggle theme/open file/submit/edit memory/manage skill).
- The dashboard "搜索" button and the session-list search row both open the new palette (reuse `useSearchDialog` store).
- Existing renderer tests pass; new palette has unit tests for scope parsing + the item-aggregation selector (pure logic).

---

## 2. Design Decisions (locked from brainstorm)

| Decision | Choice | Rationale |
|---|---|---|
| Phase 3 split | 3a backend, then 3b frontend (separate branches) | 3b consumes 3a's real API; reviewing 40 commits in one PR is too much. |
| `/` artifact source | Observable only: cwd-recent-files + composer attachments + bilibili analyses | Agent-runtime artifact reporting is a deeper change; deferred. Honest about the gap. |
| Export Markdown | Full implementation in 3a | Reuses persisted `RunEvent[]`; no agent-layer change. |
| Preview pane | All 5 types (dispatch/chat/taskRun/taskSched/info) | Per design spec. |
| Hero dispatch | Full — hero card + dispatch preview with formation picker + Enter submits | Core design-spec innovation. Formation picker uses `useTeamOptions()` (ceo + team heads). |
| Existing `useSearchDialog` store | Reuse (`open`/`openSearch`/`toggle`/`close`) | API fits; only the component body changes. ⌘K hotkey stays registered inside the component. |
| cmdk primitive | Replace the shell; keep cmdk for the input/list primitives if feasible, else custom | `@swarm/ui` `CommandDialog` geometry can't fit two columns + custom selection model. |

---

## 3. Palette Specification (from design `统一命令台.dc.html`)

### 3.1 Geometry & visual

- Container: 760×660 max, frosted glass (`backdrop-filter: blur(40px) saturate(1.4)`, `bg: rgba(250,249,247,.82)` light / `.dark` equivalent), `rounded-2xl`, top-anchored (~96px from top, centered horizontally).
- **Input row:** scope icon (21px, scope-colored) + optional pill (scope-colored, with `×` clear) + 20px text input + result count (`N 结果`).
- **Body — two columns:**
  - Left results: `flex-1`, scrollable, 8px gutter. Grouped sections with headings; each item is a row with icon + title + subtitle + optional badge/progress/meta.
  - Right preview: **296px fixed**, scrollable, hairline left border, subtler bg. Renders one of five preview types per the selected item.
- **Footer:** action label + primary verb + `↵` + `操作 ⌘K` hint.

### 3.2 Prefix scopes (`getScope`)

| Prefix | mode | pill | color | placeholder |
|---|---|---|---|---|
| `>` | `command` | 命令 | blue (`text-primary`) | 运行命令… |
| `@` | `agent` | 指派 | indigo (`text-indigo-500`) | 选择编队或 Agent… |
| `#` | `task` | 任务 | orange (`text-orange-500`) | 查找运行中 / 定时任务… |
| `/` | `file` | 文件 | green (`text-emerald-500`) | 查找 Agent 产出的文件… |
| (none) | `mixed` | (no pill) | indigo | 搜索、输入命令,或直接把目标交给 Agent… |

Prefix stripped via `query.slice(1).trim()`; the remaining `term` filters within the scope.

### 3.3 Result categories (left column, by scope)

- **`command` scope** → group 「命令」: 新建对话 / 新建定时任务 / 新建编队 / 打开设置 / 切换外观 / 导出当前对话为 Markdown.
- **`agent` scope** → group 「编队 & Agent · 回车即指派」: agents from `useTeamOptions()` (ceo + heads).
- **`task` scope** → two groups: 「运行中」(from `selectDashboardRuns`-style filter) + 「定时任务」(from `useAllCronJobs`).
- **`file` scope** → group 「文件 & 产出」: from `swarmApi.listArtifacts()` (Phase 3a).
- **`mixed` empty** → four groups: 「继续未完成」(resume latest running task) + 「建议操作」(top commands + first agent) + 「最近对话」(recent sessions) + 「快捷入口」(service routes).
- **`mixed` with-query** → six groups in order: 「指派给 Agent」(hero dispatch) + 「命令」(filtered) + 「对话」(filtered) + 「文件 & 产出」(filtered) + 「任务」(filtered run+cron) + 「服务 · 记忆 · 技能」(filtered services/memory/skills).
- **Empty results** → fallback card: `没有匹配「{query}」的结果` + hint to dispatch to agent.

### 3.4 Preview types (right column, by selected item's kind)

| kind | preview shows |
|---|---|
| `dispatch` | hero: 「{term}」 title, formation picker (default ceo/research-head), 预计步骤 list (planning/search/synthesize). |
| `chat` | recent messages (lazy-hydrated from `getRunEvents`), role-colored; footer `更新于 {time} · {count} 条消息`. |
| `taskRun` | stepText + progress (plan-based %), 实时日志 (recent `tool.call`/`llm.message` events as monospace lines). |
| `taskSched` | key/value rows (cron, next run, last run) + 上次结果 (latest `CronRun.status` — text simplified to status/error since `CronRun` lacks summary). |
| `info` | generic: optional `desc` + key/value `rows`. Covers command/agent/file/service/memory/skill. |

### 3.5 Keyboard

- **↑/↓** — move selection, clamp to `[0, len-1]` (no wrap).
- **Enter** — `run(selected)`.
- **Escape** — if query non-empty, clear it; else close palette.
- **Backspace** — when query is exactly the lone prefix char, clear to mixed.
- Hover sets selection (drives preview).

### 3.6 Per-kind `run()` actions

| kind | action |
|---|---|
| `command: 新建对话` | `navigate('/')` |
| `command: 新建定时任务` | `navigate('/scheduled')` (system session) |
| `command: 新建编队` | `openSettings('agents')` |
| `command: 打开设置` | `openSettings()` |
| `command: 切换外观` | `useTheme().setTheme(next)` cycling system→light→dark→system |
| `command: 导出 Markdown` | `swarmApi.exportSessionMarkdown(selectedSessionId)` (needs an active session; disabled/no-op if none) |
| `agent` | `navigate('/')` + prefill composer's `agentType` via `useComposerDefaults.setAgentType(id)` (assign-on-next-message) |
| `chat` | `navigate('/session/:id')` |
| `taskRun` | `navigate('/session/:sessionId')` |
| `taskSched` | `navigate('/scheduled')` |
| `file` | `swarmApi.openPath(path)` |
| `service` | `navigate('/bilibili'|'/gmail'|'/scheduled'|'/trending')` |
| `memory` | `openSettings('memory')` if exists, else `navigate('/session/:id')` of owning session |
| `skill` | `openSettings('skills')` |
| `dispatch` (hero) | `useSubmitGoal({ goal: term, options: { agentType: pickedFormation } })` → `navigate('/session/:newId')` |

---

## 4. Phase 3a — Backend

### 4.1 Export Markdown

**New service method** on the conversation service (alongside `getRunEvents`):
```ts
exportSessionMarkdown(sessionId: string): Promise<{ path: string }>
```
- Reduces the session's `RunEvent[]` (via `store.getRunEvents`) into a markdown document:
  - One `##` per top-level run; nested runs indented under their parent.
  - User `llm.message` → `**You:** …`; assistant `llm.message` → `**Agent:** …`; `tool.call`/`tool.result` → fenced code with tool name + truncated payload; `permission`/`error` → blockquote.
  - Truncates long payloads (e.g. >2KB) to keep the file readable.
- Writes to `app.getPath('userData')/exports/{sessionId}-{timestamp}.md` (create dir if missing).
- Calls back to main to `shell.openPath(path)` (or returns path and renderer opens via existing `system:openPath`).
- Pure-ish: the *markdown builder* is a pure function `buildMarkdown(runs: RunEvent[]): string`, unit-tested in isolation. The file-write + open is the thin wrapper.

**IPC channel:** `swarm:exportSessionMarkdown` (renderer→main→service), registered in `swarm-ipc.ts`.

**Preload bridge:** `window.swarm.exportSessionMarkdown(sessionId)`.

**Protocol types:** none new (reuses `RunEvent`, `{ path: string }` inline).

### 4.2 Observable artifact index

**New service method:**
```ts
listArtifacts(filter?: { query?: string; cwd?: string; limit?: number }): Promise<ArtifactEntry[]>
```
```ts
type ArtifactEntry = {
  kind: 'file' | 'attachment' | 'bilibili-analysis'
  name: string
  /** Absolute path (file) or bvid (bilibili) or session+attachmentId. */
  ref: string
  size?: number
  modifiedAt?: number
  /** Origin label: cwd path / session title / "Bilibili". */
  origin: string
}
```
Aggregates three sources, then filters by `query` substring (name/origin), then truncates to `limit` (default 50):
1. **cwd-recent-files** — `fs.readdir(cwd ?? defaultCwd, { recursive: true })`, filter to files modified within last 14 days, skip `node_modules`/`.git`/hidden, cap per-directory depth at 3, sort by mtime desc. Size from `fs.stat`.
2. **Composer attachments** — iterate `store.listSessions()` → for each, hydrate and scan for `attachment` events (or read from a cheaper persisted field if available). Skip if expensive; in 3a, limit to the system session + 5 most recent sessions.
3. **Bilibili analyses** — reuse the existing bilibili subsystem's `analyzedBvids()` + per-bvid metadata.

**IPC channel:** `swarm:listArtifacts`.

**Preload bridge:** `window.swarm.listArtifacts(filter?)`.

**Protocol types:** `ArtifactEntry` (new, in `packages/protocol/src/types/ui.ts`).

### 4.3 Files (3a task list, indicative)

1. `ArtifactEntry` protocol type + zod schema.
2. Pure `buildMarkdown(runs)` + tests.
3. Service `exportSessionMarkdown` (thin wrapper writing file).
4. Service `listArtifacts` (cwd scan + attachments + bilibili aggregation) + tests (temp dir).
5. `ServiceClient` method additions.
6. Main IPC handlers (`swarm:exportSessionMarkdown`, `swarm:listArtifacts`).
7. Preload bridge additions + `SwarmBridge` type.
8. `swarmApi` facade additions.

(Detailed step-by-step plan written separately as `docs/superpowers/plans/2026-07-05-cmd-palette-3a-backend.md` before 3a implementation begins.)

---

## 5. Phase 3b — Frontend (architecture; detailed plan written after 3a)

### 5.1 File structure (indicative)

- `lib/palette/scope.ts` — `getScope(query)` pure + tests.
- `lib/palette/build-items.ts` — aggregates all sources into a flat `PaletteItem[]` per scope; pure; tested.
- `lib/palette/select-palette.ts` — given scope + query + items, returns grouped sections + flattened selection list; pure; tested.
- `components/palette/palette-dialog.tsx` — the shell (custom Dialog-like, two columns, frosted glass).
- `components/palette/palette-input.tsx` — input row (scope icon + pill + input + count).
- `components/palette/palette-results.tsx` — left column (grouped sections + items + empty state).
- `components/palette/palette-item.tsx` — one item row (rich rendering).
- `components/palette/preview/*` — five preview components (`dispatch.tsx`, `chat.tsx`, `task-run.tsx`, `task-sched.tsx`, `info.tsx`).
- `components/palette/use-palette-state.ts` — query/sel/preview state + keyboard handling hook.
- `hooks/use-palette-data.ts` — gathers all data sources into the form `build-items` expects.
- Modify `components/session-search-dialog.tsx` — replace internals with `<PaletteDialog/>`; keep the store/hotkey wiring.

(Detailed step-by-step plan written as `docs/superpowers/plans/2026-07-05-cmd-palette-3b-ui.md` after 3a lands.)

---

## 6. Risks & Verification

| Risk | Mitigation |
|---|---|
| `@swarm/ui` `CommandDialog` can't fit two columns + custom selection. | 3b builds a custom shell using `Dialog` primitives directly (or a portal + overlay), bypassing `CommandDialog`. Validate in 3b Task 1 (shell skeleton). |
| `listArtifacts` cwd scan is slow on large repos. | Cap depth at 3, skip `node_modules`/`.git`, mtime filter, hard `limit`. Run in service process (off main thread). Cache per-cwd for 60s. |
| Export Markdown payload truncation loses info. | Truncate at 2KB with `… (truncated)` marker; full payload available in the session transcript anyway. |
| Hero dispatch formation picker has no "research formation" reality. | Picker shows real options: 公司 (CEO) + team heads from `useTeamOptions()`. Default to CEO. |
| Preview "实时日志" / chat-message preview needs hydration, may lag. | Hydrate lazily on selection; show a "加载中…" skeleton; cap to last 20 lines. |
| 3b scope creep (40+ commits). | Strict task decomposition in the 3b plan; each task independently shippable; pause for review at preview-pane milestone. |

### Manual smoke test (after 3b)

1. ⌘K opens palette from anywhere (incl. focused text fields).
2. Each prefix (`>`/`@`/`#`/`/`) shows the right scope, pill, color, placeholder.
3. Backspace on lone prefix → mixed; Escape clears query then closes.
4. ↑/↓ moves selection; preview updates; Enter runs.
5. Mixed empty: 4 groups; Mixed with-query: hero + 5 groups.
6. Hero dispatch: type a goal → Enter → new session created → navigated.
7. Each command runs its action (new chat / settings / theme cycle / export MD).
8. Export MD: with an active session, produces a `.md` and opens it.
9. `/` scope: lists cwd files + attachments + bilibili analyses; click opens file.
10. Service entries navigate; memory/skill entries open settings sections.
11. Frosted-glass + dark mode render correctly.

---

## 7. Phases After This One (context only)

4. 会话工作台 four-tab · 5. 编队 command center · 6. service views · 7. settings routing. Each gets its own spec → plan → branch.

---

## Implementation order

1. **Phase 3a spec → plan → branch `feat/cmd-palette-backend` → implement → review → merge.** (Write `docs/superpowers/plans/2026-07-05-cmd-palette-3a-backend.md` next.)
2. **Phase 3b spec section §5 → detailed plan → branch `feat/cmd-palette-ui` (off 3a) → implement → review → merge.**
