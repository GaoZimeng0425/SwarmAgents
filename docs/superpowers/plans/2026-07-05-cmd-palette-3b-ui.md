# Unified Command Palette UI (Phase 3b) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace `session-search-dialog.tsx` with the design-spec 760×660 two-column frosted-glass ⌘K palette — four prefix scopes (`>`/`@`/`#`/`/`) + mixed mode, grouped results, five right-pane preview types, full keyboard navigation, and a mixed-mode hero dispatch.

**Architecture:** Build a custom shell on `@swarm/ui` `Dialog` primitives (NOT `CommandDialog`/cmdk — the custom scope/selection/preview model conflicts with cmdk's internals). Pure logic lives in `lib/palette/*` (scope parsing, item aggregation, selection grouping) and is unit-tested in isolation; the React shell (`components/palette/*`) consumes those pure functions plus existing renderer hooks/stores and the Phase 3a `swarmApi.listArtifacts` / `exportSessionMarkdown` / `getRunEvents` APIs. The existing `useSearchDialog` Zustand store and `useHotkey('Mod+K')` registration stay; only the component body changes.

**Tech Stack:** React 19, TanStack Router + Query, Zustand, `@swarm/ui` (Base UI Dialog), lucide-react icons, Tailwind v4 (CSS-var theming, stock palette colors), Vitest + @testing-library/react + jsdom.

---

## Global Constraints

(verbatim from spec §2026-07-05-command-palette-design — every task inherits these)

- **Geometry:** container 760×660 max, frosted glass (`backdrop-filter: blur(40px) saturate(1.4)`, `bg: rgba(250,249,247,.82)` light / dark equivalent), `rounded-2xl`, top-anchored (~96px from top, centered).
- **Input row:** scope icon (21px, scope-colored) + optional pill (scope-colored, with `×` clear) + 20px text input + result count (`N 结果`).
- **Left results:** `flex-1`, scrollable, 8px gutter; grouped sections with headings; each item is a row (icon + title + subtitle + optional badge/progress/meta).
- **Right preview:** **296px fixed**, scrollable, hairline left border, subtler bg; renders one of five preview types per selected item.
- **Footer:** action label + primary verb + `↵` + `操作 ⌘K` hint.
- **Scopes:** `>` command (blue/`text-primary`), `@` agent (indigo/`text-indigo-500`), `#` task (orange/`text-orange-500`), `/` file (green/`text-emerald-500`), none = mixed (indigo).
- **Keyboard:** ↑/↓ move (clamp `[0,len-1]`, no wrap); Enter `run(selected)`; Escape clears query then closes; Backspace on lone prefix → mixed.
- **Copy rule:** user-facing strings are Chinese (per AGENTS.md §0). Code comments and commit messages are English.

### Deviations from spec (locked — do NOT "fix" by re-introducing)

These were settled during code exploration before this plan was written:

1. **`ArtifactEntry.kind` has only `'file' | 'bilibili-analysis'`** — Phase 3a dropped `'attachment'`. The `/` scope's file items use these two kinds. Do not synthesize an `'attachment'` kind.
2. **`SettingsSection` has no `'memory'` tab.** Memory items route to `openSettings('general')` (NOT a memory tab). Agents→`'agents'`, Skills→`'skills'`.
3. **No `useSessionEvents` hook exists.** Chat/task previews use a fresh `useQuery(['session-preview', sessionId], () => swarmApi.getRunEvents(sessionId))`. Do NOT call `hydrateSession` — it writes into the shared `['runs']` cache and clobbers the active session.
4. **`openPath` is not on the `swarmApi` facade.** Call `window.swarm.openPath(ref)` directly (it is typed on `SwarmBridge`).
5. **Composer attachments are not a cross-session source.** The `/` scope is backed solely by `swarmApi.listArtifacts()`. Do not scan sessions for `run.created` attachments.

### Branch

Create `feat/cmd-palette-ui` from `refactor/ui-app-shell-rail` (current branch; carries Phase 1 + Phase 3a).

### File Structure (locked from spec §5.1)

Pure logic (unit-tested, no React):
- `apps/desktop/src/renderer/src/lib/palette/scope.ts` — `getScope(query)` pure.
- `apps/desktop/src/renderer/src/lib/palette/types.ts` — shared `PaletteItem` / `PaletteSection` / `PaletteScope` types.
- `apps/desktop/src/renderer/src/lib/palette/build-items.ts` — aggregate all sources into flat `PaletteItem[]` per scope; pure.
- `apps/desktop/src/renderer/src/lib/palette/select-palette.ts` — given scope + query + items, return grouped sections + flat selection list; pure.

React shell (in `components/palette/`):
- `palette-dialog.tsx` — the shell (Dialog primitives, two columns, frosted glass, keyboard handler).
- `palette-input.tsx` — input row.
- `palette-results.tsx` — left column (grouped sections + empty state).
- `palette-item.tsx` — one item row.
- `preview/dispatch.tsx`, `preview/chat.tsx`, `preview/task-run.tsx`, `preview/task-sched.tsx`, `preview/info.tsx` — five preview components.
- `preview/index.tsx` — switches on `item.kind` to render the right preview.
- `use-palette-state.ts` — query/sel/preview state + keyboard handling hook.

Data hook:
- `hooks/use-palette-data.ts` — gathers all sources into the shape `build-items` expects.

Mount:
- Modify `components/session-search-dialog.tsx` — replace internals with `<PaletteDialog/>`; keep the store + hotkey wiring. (Alternative: delete the file and mount `<PaletteDialog/>` directly in `__root.tsx`. This plan keeps the file as a thin wrapper to minimize the diff to `__root.tsx` and `session-list.tsx`, which import it.)

Tests (colocated, jsdom, `*.test.ts(x)`):
- `lib/palette/scope.test.ts`, `lib/palette/build-items.test.ts`, `lib/palette/select-palette.test.ts` — pure-logic tests.
- `components/palette/palette-dialog.test.tsx` — keyboard nav + scope parsing integration (smoke).
- `hooks/use-palette-data.test.tsx` — data aggregation with mocked `swarmApi`.

---

## Task 0: Branch & scaffolding

**Files:**
- Create: `apps/desktop/src/renderer/src/lib/palette/.gitkeep` (removed in Task 1)

- [ ] **Step 1: Create the feature branch off the current branch**

```bash
git checkout -b feat/cmd-palette-ui refactor/ui-app-shell-rail
git status   # confirm on feat/cmd-palette-ui, working tree clean
```

- [ ] **Step 2: Confirm the Phase 3a APIs are reachable from the renderer**

Run: `grep -n "listArtifacts\|exportSessionMarkdown" apps/desktop/src/renderer/src/lib/api.ts`
Expected: two matches (lines ~91-94). If missing, STOP — Phase 3a is not merged into this branch.

- [ ] **Step 3: Run the existing test suite to establish a green baseline**

Run: `cd apps/desktop && cross-env ELECTRON_RUN_AS_NODE=1 electron node_modules/vitest/vitest.mjs run`
Expected: all green. (If some pre-existing tests fail unrelated to this work, note them and proceed — do not fix them.)

---

## Task 1: Pure scope parser (`getScope`)

**Files:**
- Create: `apps/desktop/src/renderer/src/lib/palette/scope.ts`
- Test: `apps/desktop/src/renderer/src/lib/palette/scope.test.ts`

**Interfaces:**
- Produces: `getScope(query: string): { mode: PaletteScope; term: string }` where `PaletteScope = 'command' | 'agent' | 'task' | 'file' | 'mixed'` (defined in Task 2's `types.ts`; for this task, inline the type to keep the file standalone, then refactor in Task 2). Also produces `SCOPE_META: Record<PaletteScope, { pill: string | null; color: string; placeholder: string; icon: ... }>`.
- Consumes: nothing.

- [ ] **Step 1: Write the failing test**

```ts
// apps/desktop/src/renderer/src/lib/palette/scope.test.ts
import { describe, expect, it } from 'vitest'
import { SCOPE_META, getScope } from './scope'

describe('getScope', () => {
  it('detects the command prefix ">"', () => {
    expect(getScope('>settings')).toEqual({ mode: 'command', term: 'settings' })
    expect(getScope('>')).toEqual({ mode: 'command', term: '' })
  })
  it('detects the agent prefix "@"', () => {
    expect(getScope('@research')).toEqual({ mode: 'agent', term: 'research' })
  })
  it('detects the task prefix "#"', () => {
    expect(getScope('#running')).toEqual({ mode: 'task', term: 'running' })
  })
  it('detects the file prefix "/"', () => {
    expect(getScope('/readme')).toEqual({ mode: 'file', term: 'readme' })
  })
  it('falls back to mixed when no prefix', () => {
    expect(getScope('hello')).toEqual({ mode: 'mixed', term: 'hello' })
    expect(getScope('')).toEqual({ mode: 'mixed', term: '' })
  })
  it('treats a lone space or non-prefix char as mixed', () => {
    expect(getScope(' !')).toEqual({ mode: 'mixed', term: '!' })
    expect(getScope('  ')).toEqual({ mode: 'mixed', term: '' })
  })
  it('trims the term and collapses internal whitespace (kept as-is)', () => {
    // We only trim the term; internal spaces are the user's query.
    expect(getScope('>  new chat  ')).toEqual({ mode: 'command', term: 'new chat' })
  })
})

describe('SCOPE_META', () => {
  it('has the four prefix scopes + mixed, each with pill/color/placeholder', () => {
    const modes = Object.keys(SCOPE_META).sort()
    expect(modes).toEqual(['agent', 'command', 'file', 'mixed', 'task'])
    expect(SCOPE_META.command.color).toBe('text-primary')
    expect(SCOPE_META.agent.color).toBe('text-indigo-500')
    expect(SCOPE_META.task.color).toBe('text-orange-500')
    expect(SCOPE_META.file.color).toBe('text-emerald-500')
    expect(SCOPE_META.mixed.pill).toBeNull()
    expect(SCOPE_META.command.pill).toBe('命令')
    expect(SCOPE_META.agent.pill).toBe('指派')
    expect(SCOPE_META.task.pill).toBe('任务')
    expect(SCOPE_META.file.pill).toBe('文件')
  })
})
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `cd apps/desktop && cross-env ELECTRON_RUN_AS_NODE=1 electron node_modules/vitest/vitest.mjs run src/lib/palette/scope.test.ts`
Expected: FAIL with "Cannot find module './scope'".

- [ ] **Step 3: Write minimal implementation**

```ts
// apps/desktop/src/renderer/src/lib/palette/scope.ts
// Pure scope parser for the ⌘K command palette input row.

// Inline the union here; Task 2 promotes it to types.ts and this file re-exports.
export type PaletteScope = 'command' | 'agent' | 'task' | 'file' | 'mixed'

export type ScopeMeta = {
  /** Chinese pill label, or null for mixed (no pill rendered). */
  pill: string | null
  /** Tailwind text-color class applied to icon, pill, and input caret accent. */
  color: string
  /** Placeholder shown in the input when term is empty. */
  placeholder: string
  /** lucide-react icon name component (resolved in the React layer, not here). */
  icon: 'Command' | 'Users' | 'ListChecks' | 'Folder' | 'Search'
}

export const SCOPE_META: Record<PaletteScope, ScopeMeta> = {
  command: { pill: '命令', color: 'text-primary', placeholder: '运行命令…', icon: 'Command' },
  agent:   { pill: '指派', color: 'text-indigo-500', placeholder: '选择编队或 Agent…', icon: 'Users' },
  task:    { pill: '任务', color: 'text-orange-500', placeholder: '查找运行中 / 定时任务…', icon: 'ListChecks' },
  file:    { pill: '文件', color: 'text-emerald-500', placeholder: '查找 Agent 产出的文件…', icon: 'Folder' },
  mixed:   { pill: null,   color: 'text-indigo-500', placeholder: '搜索、输入命令,或直接把目标交给 Agent…', icon: 'Search' },
}

const PREFIX_TO_MODE: Record<string, PaletteScope> = {
  '>': 'command',
  '@': 'agent',
  '#': 'task',
  '/': 'file',
}

/** Parse the raw input into a scope mode + the remaining search term. */
export function getScope(query: string): { mode: PaletteScope; term: string } {
  const trimmed = query.trimStart()
  const first = trimmed[0] ?? ''
  const mode = PREFIX_TO_MODE[first] ?? 'mixed'
  const term = mode === 'mixed' ? trimmed.trim() : trimmed.slice(1).trim()
  return { mode, term }
}
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `cd apps/desktop && cross-env ELECTRON_RUN_AS_NODE=1 electron node_modules/vitest/vitest.mjs run src/lib/palette/scope.test.ts`
Expected: PASS (8 tests).

- [ ] **Step 5: Commit**

```bash
git add apps/desktop/src/renderer/src/lib/palette/scope.ts apps/desktop/src/renderer/src/lib/palette/scope.test.ts
git commit -m "feat(palette): pure getScope parser + SCOPE_META for ⌘K palette"
```

---

## Task 2: Shared types

**Files:**
- Create: `apps/desktop/src/renderer/src/lib/palette/types.ts`
- Modify: `apps/desktop/src/renderer/src/lib/palette/scope.ts` (re-export `PaletteScope` from `types.ts`)

**Interfaces:**
- Produces: `PaletteScope`, `PaletteItemKind`, `PaletteItem`, `PaletteSection`. These are the shared vocabulary every later task uses; get the names exactly right.

- [ ] **Step 1: Define the palette domain types**

```ts
// apps/desktop/src/renderer/src/lib/palette/types.ts
// Shared domain types for the ⌘K command palette.

// Re-exported here so downstream modules import from a single barrel.
export type PaletteScope = 'command' | 'agent' | 'task' | 'file' | 'mixed'

/**
 * Discriminator for both the left-row rendering and the right preview pane.
 * - `dispatch` is the mixed-mode hero "把这个目标交给 Agent" item.
 * - `info` is the generic preview fallback (command/agent/file/service/memory/skill).
 */
export type PaletteItemKind =
  | 'command'
  | 'agent'
  | 'chat'
  | 'taskRun'
  | 'taskSched'
  | 'file'
  | 'service'
  | 'memory'
  | 'skill'
  | 'dispatch'

/**
 * One selectable row in the left column. `kind` drives icon/color/preview;
 * `run()` is invoked on Enter; `preview` carries the data the right pane needs.
 */
export type PaletteItem = {
  id: string
  kind: PaletteItemKind
  /** Primary row title. */
  title: string
  /** Secondary row subtitle (path, agent, cron, etc.). */
  subtitle?: string
  /** Optional trailing badge (status, role, etc.). */
  badge?: string
  /** Optional 0..1 progress for running tasks. */
  progress?: number
  /** lucide icon name; resolved to a component in the React layer. */
  icon: string
  /** Run on Enter or click. Returns void; navigation/side-effects happen inside. */
  run: () => void
  /** Right-pane preview payload; shape depends on `kind`. */
  preview: PreviewData
  /** Lowercased string used by the pure filter. Usually `${title} ${subtitle ?? ''}`. */
  searchText: string
}

/** Discriminated preview payload. `kind` on the item selects which preview renders. */
export type PreviewData =
  | { type: 'dispatch'; term: string; formations: { id: string; label: string }[] }
  | { type: 'chat'; sessionId: string; title: string }
  | { type: 'taskRun'; run: { id: string; goal: string; summary: string | null; status: string; plan?: { content: string; status: 'pending' | 'in_progress' | 'completed' }[] } }
  | { type: 'taskSched'; task: { id: string; name: string | null; cron: string; nextRun: number | null; lastRun: number | null; lastStatus: string | null; sessionId: string } }
  | { type: 'info'; title: string; desc?: string; rows: { label: string; value: string }[] }

/** A grouped section in the left column. */
export type PaletteSection = {
  /** Chinese heading (e.g. 「命令」, 「运行中」). */
  heading: string
  items: PaletteItem[]
}
```

- [ ] **Step 2: Refactor `scope.ts` to re-export from `types.ts`**

In `apps/desktop/src/renderer/src/lib/palette/scope.ts`, delete the local `export type PaletteScope = ...` line and add at the top:

```ts
import type { PaletteScope } from './types'
export type { PaletteScope }
```

(Keep `ScopeMeta`, `SCOPE_META`, `getScope` exactly as-is.)

- [ ] **Step 3: Run the scope test again to confirm no regression**

Run: `cd apps/desktop && cross-env ELECTRON_RUN_AS_NODE=1 electron node_modules/vitest/vitest.mjs run src/lib/palette/scope.test.ts`
Expected: PASS (8 tests).

- [ ] **Step 4: Commit**

```bash
git add apps/desktop/src/renderer/src/lib/palette/types.ts apps/desktop/src/renderer/src/lib/palette/scope.ts
git commit -m "feat(palette): shared PaletteItem / PaletteSection / PreviewData types"
```

---

## Task 3: Pure item builder (`buildItems`)

Aggregates all data sources into a flat `PaletteItem[]` filtered by scope. Pure: takes data + callbacks, returns items. No React, no hooks.

**Files:**
- Create: `apps/desktop/src/renderer/src/lib/palette/build-items.ts`
- Test: `apps/desktop/src/renderer/src/lib/palette/build-items.test.ts`

**Interfaces:**
- Consumes: `PaletteScope`, `PaletteItem`, `PreviewData` (Task 2). Plus a `BuildInputs` bag of raw data and a `Callbacks` bag of `run` closures.
- Produces: `buildItems(scope, term, inputs, cb): PaletteItem[]` — flat list already filtered for the scope AND the `term` substring. Used by `select-palette` (Task 4) for grouping.

- [ ] **Step 1: Define the input contracts (top of `build-items.ts`)**

```ts
// apps/desktop/src/renderer/src/lib/palette/build-items.ts
// Pure aggregator: turns raw renderer data into a flat PaletteItem[] for one scope.
import type { PaletteItem, PaletteScope } from './types'

/** Raw data the builder needs. Gathered by hooks/use-palette-data.ts. */
export type BuildInputs = {
  /** Non-system sessions (the 「对话」 group). */
  sessions: { id: string; title: string | null; lastActiveAt: number; agentType?: string }[]
  /** Running or pending runs. */
  runningRuns: { id: string; sessionId: string; goal: string; status: string; summary: string | null; plan?: { content: string; status: 'pending' | 'in_progress' | 'completed' }[] }[]
  /** Scheduled (cron) tasks. */
  cronJobs: { id: string; sessionId: string; name: string | null; cron: string; nextRun: number | null; lastRun: number | null; lastStatus: string | null }[]
  /** Formation/team options for the dispatch picker. */
  formations: { id: string; label: string }[]
  /** Phase 3a artifacts for the `/` scope. */
  artifacts: { kind: 'file' | 'bilibili-analysis'; name: string; ref: string; origin: string; modifiedAt?: number }[]
  /** Memory entries. */
  memory: { id: string; key: string; namespace: string; category: string; content: string; timestamp: number }[]
  /** Skills. */
  skills: { name: string; description: string; enabled?: boolean }[]
  /** Service routes for mixed "快捷入口". */
  services: { id: string; label: string; route: string }[]
}

/** Side-effect callbacks the builder wires into each item's `run`. */
export type Callbacks = {
  navigate: (to: string) => void
  openSettings: (section?: string) => void
  cycleTheme: () => void
  exportMarkdown: (sessionId: string) => void
  setComposerAgent: (agentId: string) => void
  openArtifact: (ref: string) => void
  /** Submit the hero dispatch; returns the new session id for navigation. */
  submitGoal: (goal: string, agentType: string) => Promise<{ sessionId: string }>
}
```

- [ ] **Step 2: Write the failing test (key cases — see comments)**

```ts
// apps/desktop/src/renderer/src/lib/palette/build-items.test.ts
import { describe, expect, it, vi } from 'vitest'
import { buildItems, type BuildInputs, type Callbacks } from './build-items'

const baseInputs: BuildInputs = {
  sessions: [
    { id: 's1', title: 'Gmail 摘要', lastActiveAt: 1, agentType: 'ceo' },
    { id: 's2', title: 'Bilibili 分析', lastActiveAt: 2 },
  ],
  runningRuns: [
    { id: 'r1', sessionId: 's1', goal: '抓取邮件', status: 'running', summary: null, plan: [{ content: 'a', status: 'completed' }, { content: 'b', status: 'pending' }] },
  ],
  cronJobs: [
    { id: 'c1', sessionId: 's-sched', name: '每日日报', cron: '0 9 * * *', nextRun: 100, lastRun: 50, lastStatus: 'ok' },
  ],
  formations: [{ id: 'ceo', label: '公司 (CEO)' }, { id: 'research-head', label: '研究编队' }],
  artifacts: [
    { kind: 'file', name: 'report.md', ref: '/tmp/report.md', origin: '/tmp', modifiedAt: 99 },
    { kind: 'bilibili-analysis', name: 'BV1xx', ref: 'BV1xx', origin: 'Bilibili', modifiedAt: 88 },
  ],
  memory: [{ id: 'm1', key: 'pref', namespace: 'user', category: '偏好', content: '偏好深色', timestamp: 5 }],
  skills: [{ name: 'imagegen', description: '生成图像', enabled: true }],
  services: [{ id: 'bilibili', label: 'Bilibili', route: '/bilibili' }],
}

const cb: Callbacks = {
  navigate: vi.fn(),
  openSettings: vi.fn(),
  cycleTheme: vi.fn(),
  exportMarkdown: vi.fn(),
  setComposerAgent: vi.fn(),
  openArtifact: vi.fn(),
  submitGoal: vi.fn().mockResolvedValue({ sessionId: 'new-1' }),
}

describe('buildItems — command scope', () => {
  it('surfaces all built-in commands when term is empty', () => {
    const items = buildItems('command', '', baseInputs, cb)
    const titles = items.map((i) => i.title)
    expect(titles).toEqual(expect.arrayContaining([
      '新建对话', '新建定时任务', '新建编队', '打开设置', '切换外观', '导出当前对话为 Markdown',
    ]))
  })
  it('filters commands by term substring', () => {
    const items = buildItems('command', '设置', baseInputs, cb)
    expect(items.map((i) => i.title)).toEqual(['打开设置'])
  })
  it('export Markdown command run() calls exportMarkdown with NO selected session yields nothing (guarded upstream)', () => {
    // The command's run() always calls exportMarkdown — the upstream caller
    // decides whether it's a no-op. We only assert the wiring here.
    const items = buildItems('command', '导出', baseInputs, cb)
    expect(items[0].title).toBe('导出当前对话为 Markdown')
    items[0].run()
    expect(cb.exportMarkdown).toHaveBeenCalled()
  })
})

describe('buildItems — agent scope', () => {
  it('lists formations filtered by term', () => {
    const items = buildItems('agent', '研究', baseInputs, cb)
    expect(items.map((i) => i.title)).toEqual(['研究编队'])
    expect(items[0].kind).toBe('agent')
  })
  it('agent run() prefills composer and navigates home', () => {
    const items = buildItems('agent', '', baseInputs, cb)
    items.find((i) => i.title === '研究编队')!.run()
    expect(cb.setComposerAgent).toHaveBeenCalledWith('research-head')
    expect(cb.navigate).toHaveBeenCalledWith('/')
  })
})

describe('buildItems — task scope', () => {
  it('emits taskRun + taskSched kinds', () => {
    const items = buildItems('task', '', baseInputs, cb)
    const kinds = new Set(items.map((i) => i.kind))
    expect(kinds.has('taskRun')).toBe(true)
    expect(kinds.has('taskSched')).toBe(true)
  })
})

describe('buildItems — file scope', () => {
  it('lists artifacts filtered by name', () => {
    const items = buildItems('file', 'report', baseInputs, cb)
    expect(items.map((i) => i.title)).toEqual(['report.md'])
    items[0].run()
    expect(cb.openArtifact).toHaveBeenCalledWith('/tmp/report.md')
  })
})

describe('buildItems — mixed scope', () => {
  it('empty term yields hero dispatch + recent sessions + commands + services', () => {
    const items = buildItems('mixed', '', baseInputs, cb)
    const titles = items.map((i) => i.title)
    expect(titles).toContain('把目标交给 Agent')   // hero dispatch item
    expect(items.find((i) => i.kind === 'dispatch')).toBeTruthy()
    expect(items.some((i) => i.kind === 'command')).toBe(true)
    expect(items.some((i) => i.kind === 'service')).toBe(true)
  })
  it('with-query hero dispatch run() submits goal + navigates', async () => {
    const items = buildItems('mixed', '分析这段视频', baseInputs, cb)
    const hero = items.find((i) => i.kind === 'dispatch')!
    expect(hero).toBeTruthy()
    await hero.run()
    expect(cb.submitGoal).toHaveBeenCalledWith('分析这段视频', 'ceo') // default formation
    expect(cb.navigate).toHaveBeenCalledWith('/session/new-1')
  })
  it('with-query filters sessions/commands by term', () => {
    const items = buildItems('mixed', 'Gmail', baseInputs, cb)
    const chats = items.filter((i) => i.kind === 'chat').map((i) => i.title)
    expect(chats).toEqual(['Gmail 摘要'])
  })
})
```

- [ ] **Step 3: Run the test to verify it fails**

Run: `cd apps/desktop && cross-env ELECTRON_RUN_AS_NODE=1 electron node_modules/vitest/vitest.mjs run src/lib/palette/build-items.test.ts`
Expected: FAIL (module not found).

- [ ] **Step 4: Implement `buildItems`**

Implement the function so that:
- For `command`: emit the 6 built-in commands (新建对话→`navigate('/')`; 新建定时任务→`navigate('/scheduled')`; 新建编队→`openSettings('agents')`; 打开设置→`openSettings()`; 切换外观→`cycleTheme()`; 导出当前对话为 Markdown→`exportMarkdown('<currentSessionId>')` — pass the empty string `''` as a placeholder; the React layer overrides `run` with the real selected session id, OR simpler: the command builder takes a `currentSessionId` from `BuildInputs`. **Decision: add `currentSessionId: string | null` to `BuildInputs`** and call `exportMarkdown(currentSessionId!)` (no-op guard in the React layer when null).
- For `agent`: emit one `agent` item per formation; `run()` = `setComposerAgent(id); navigate('/')`.
- For `task`: emit `taskRun` items from `runningRuns` + `taskSched` items from `cronJobs`.
- For `file`: emit `file` items from `artifacts`; `run()` = `openArtifact(ref)`.
- For `mixed` empty: emit `[hero dispatch item, ...commands(new chat only), ...recent sessions(as chat items), ...services]`.
- For `mixed` with query: emit `[hero dispatch item (term=query), ...commands(filtered), ...sessions(filtered), ...artifacts(filtered), ...runs+cron(filtered), ...memory+skills(filtered)]`.
- Always filter by `term` lowercased against each item's `searchText` (the hero item is exempt — it always shows in mixed-with-query).
- Each item's `preview` is filled per `PreviewData` (Task 2). For `command`/`agent`/`service`/`memory`/`skill`/`file`, use `info` preview. For `chat`, `chat`. For runs, `taskRun`. For cron, `taskSched`. For hero, `dispatch`.

Add `currentSessionId: string | null` to `BuildInputs` (update the type and the test's `baseInputs`).

Skeleton:

```ts
export function buildItems(scope: PaletteScope, term: string, inputs: BuildInputs, cb: Callbacks): PaletteItem[] {
  const t = term.trim().toLowerCase()
  const match = (text: string) => !t || text.toLowerCase().includes(t)
  switch (scope) {
    case 'command': return commandItems(inputs, cb).filter((i) => match(i.searchText))
    case 'agent':   return agentItems(inputs.formations, cb).filter((i) => match(i.searchText))
    case 'task':    return [...taskRunItems(inputs.runningRuns, cb), ...taskSchedItems(inputs.cronJobs, cb)].filter((i) => match(i.searchText))
    case 'file':    return fileItems(inputs.artifacts, cb).filter((i) => match(i.searchText))
    case 'mixed':   return mixedItems(term, inputs, cb)
  }
}
```

Each `*Items` helper returns `PaletteItem[]` with stable `id`s (e.g. `cmd:new-chat`, `agent:ceo`, `run:r1`, `cron:c1`, `file:/tmp/report.md`, `chat:s1`, `service:bilibili`, `memory:m1`, `skill:imagegen`, `dispatch:hero`).

`mixedItems` order (with-query): `[hero, ...commandItems filtered to those matching, ...chatItems from sessions, ...fileItems, ...taskRunItems, ...taskSchedItems, ...memoryItems, ...skillItems]`. The hero is always first when `term` is non-empty; when `term` is empty, the order is `[hero(disabled-looking but present), 新建对话 command, ...top-3 recent chats, ...services]` (see test).

- [ ] **Step 5: Run the test to verify it passes**

Run: `cd apps/desktop && cross-env ELECTRON_RUN_AS_NODE=1 electron node_modules/vitest/vitest.mjs run src/lib/palette/build-items.test.ts`
Expected: PASS (all cases).

- [ ] **Step 6: Commit**

```bash
git add apps/desktop/src/renderer/src/lib/palette/build-items.ts apps/desktop/src/renderer/src/lib/palette/build-items.test.ts
git commit -m "feat(palette): pure buildItems aggregator for all five scopes"
```

---

## Task 4: Pure selector (`selectPalette`)

Groups a flat `PaletteItem[]` into ordered `PaletteSection[]` and produces the flattened selection list. Pure.

**Files:**
- Create: `apps/desktop/src/renderer/src/lib/palette/select-palette.ts`
- Test: `apps/desktop/src/renderer/src/lib/palette/select-palette.test.ts`

**Interfaces:**
- Consumes: `PaletteScope`, `PaletteItem`, `PaletteSection` (Task 2).
- Produces: `selectPalette(scope, items): { sections: PaletteSection[]; flat: PaletteItem[] }`.

- [ ] **Step 1: Write the failing test**

```ts
// apps/desktop/src/renderer/src/lib/palette/select-palette.test.ts
import { describe, expect, it } from 'vitest'
import { selectPalette } from './select-palette'
import type { PaletteItem } from './types'

const mk = (id: string, kind: PaletteItem['kind']): PaletteItem => ({
  id, kind, title: id, icon: 'Search', run: () => {}, preview: { type: 'info', title: id, rows: [] }, searchText: id,
})

describe('selectPalette', () => {
  it('command scope → single 「命令」 section', () => {
    const out = selectPalette('command', [mk('a', 'command'), mk('b', 'command')])
    expect(out.sections).toHaveLength(1)
    expect(out.sections[0].heading).toBe('命令')
    expect(out.flat.map((i) => i.id)).toEqual(['a', 'b'])
  })
  it('agent scope → 「编队 & Agent · 回车即指派」', () => {
    const out = selectPalette('agent', [mk('a', 'agent')])
    expect(out.sections[0].heading).toBe('编队 & Agent · 回车即指派')
  })
  it('task scope → 「运行中」 then 「定时任务」 (empty sections dropped)', () => {
    const out = selectPalette('task', [mk('r1', 'taskRun'), mk('c1', 'taskSched'), mk('c2', 'taskSched')])
    expect(out.sections.map((s) => s.heading)).toEqual(['运行中', '定时任务'])
    expect(out.flat.map((i) => i.id)).toEqual(['r1', 'c1', 'c2'])
  })
  it('file scope → 「文件 & 产出」', () => {
    const out = selectPalette('file', [mk('f', 'file')])
    expect(out.sections[0].heading).toBe('文件 & 产出')
  })
  it('mixed scope → 「指派给 Agent」「命令」「对话」「文件 & 产出」「任务」「服务 · 记忆 · 技能」 (empty dropped)', () => {
    const items = [
      mk('d', 'dispatch'), mk('c', 'command'), mk('s', 'chat'),
      mk('f', 'file'), mk('r', 'taskRun'), mk('svc', 'service'), mk('m', 'memory'),
    ]
    const out = selectPalette('mixed', items)
    expect(out.sections.map((s) => s.heading)).toEqual([
      '指派给 Agent', '命令', '对话', '文件 & 产出', '任务', '服务 · 记忆 · 技能',
    ])
  })
  it('flat order matches section order', () => {
    const items = [mk('r', 'taskRun'), mk('d', 'dispatch')]
    const out = selectPalette('mixed', items)
    expect(out.flat.map((i) => i.id)).toEqual(['d', 'r'])
  })
})
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `cd apps/desktop && cross-env ELECTRON_RUN_AS_NODE=1 electron node_modules/vitest/vitest.mjs run src/lib/palette/select-palette.test.ts`
Expected: FAIL.

- [ ] **Step 3: Implement `selectPalette`**

Group by kind per scope, drop empty sections, preserve source order within a group.

```ts
// apps/desktop/src/renderer/src/lib/palette/select-palette.ts
import type { PaletteItem, PaletteScope, PaletteSection } from './types'

type GroupDef = { heading: string; kinds: PaletteItem['kind'][] }

const GROUPS: Record<PaletteScope, GroupDef[]> = {
  command: [{ heading: '命令', kinds: ['command'] }],
  agent:   [{ heading: '编队 & Agent · 回车即指派', kinds: ['agent'] }],
  task:    [{ heading: '运行中', kinds: ['taskRun'] }, { heading: '定时任务', kinds: ['taskSched'] }],
  file:    [{ heading: '文件 & 产出', kinds: ['file'] }],
  mixed:   [
    { heading: '指派给 Agent', kinds: ['dispatch'] },
    { heading: '命令', kinds: ['command'] },
    { heading: '对话', kinds: ['chat'] },
    { heading: '文件 & 产出', kinds: ['file'] },
    { heading: '任务', kinds: ['taskRun', 'taskSched'] },
    { heading: '服务 · 记忆 · 技能', kinds: ['service', 'memory', 'skill'] },
  ],
}

export function selectPalette(scope: PaletteScope, items: PaletteItem[]): { sections: PaletteSection[]; flat: PaletteItem[] } {
  const sections = GROUPS[scope]
    .map((g) => ({ heading: g.heading, items: items.filter((i) => g.kinds.includes(i.kind)) }))
    .filter((s) => s.items.length > 0)
  return { sections, flat: sections.flatMap((s) => s.items) }
}
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `cd apps/desktop && cross-env ELECTRON_RUN_AS_NODE=1 electron node_modules/vitest/vitest.mjs run src/lib/palette/select-palette.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add apps/desktop/src/renderer/src/lib/palette/select-palette.ts apps/desktop/src/renderer/src/lib/palette/select-palette.test.ts
git commit -m "feat(palette): pure selectPalette grouping for the left column"
```

---

## Task 5: Data hook (`usePaletteData`)

Gathers all renderer sources into `BuildInputs`. React-side; wraps the existing hooks.

**Files:**
- Create: `apps/desktop/src/renderer/src/hooks/use-palette-data.ts`
- Test: `apps/desktop/src/renderer/src/hooks/use-palette-data.test.tsx`

**Interfaces:**
- Consumes: `useSessionsStore`, `useRuns`, `useAllCronJobs`, `useTeamOptions`, `useMemory`, `useSkills`, plus `swarmApi.listArtifacts` (via TanStack Query), the running-runs filter pattern, and a `services` constant.
- Produces: `usePaletteData(): BuildInputs` (memoized).

- [ ] **Step 1: Pin down the `services` list**

The mixed "快捷入口" group navigates to the four service routes. Hardcode it in the hook:

```ts
const SERVICES = [
  { id: 'bilibili', label: 'Bilibili', route: '/bilibili' },
  { id: 'gmail',    label: 'Gmail',    route: '/gmail' },
  { id: 'scheduled',label: '定时任务',  route: '/scheduled' },
  { id: 'trending', label: '热点',     route: '/trending' },
]
```

- [ ] **Step 2: Write the failing test (mock the hooks)**

Mock `useSessionsStore`, `useRuns`, `useAllCronJobs`, `useTeamOptions`, `useMemory`, `useSkills`, and `swarmApi.listArtifacts`. Use `vi.mock` to replace each module. Assert the returned `BuildInputs.sessions` excludes the system session, `runningRuns` is filtered to `status==='running'||'pending'`, etc.

```tsx
// apps/desktop/src/renderer/src/hooks/use-palette-data.test.tsx
// @vitest-environment jsdom
import '@testing-library/jest-dom/vitest'
import { describe, expect, it, vi } from 'vitest'
import { renderHook } from '@testing-library/react'

vi.mock('../stores/sessions', () => ({
  useSessionsStore: (sel: (s: any) => any) =>
    sel({
      sessions: [
        { id: 'sys', title: '系统', isSystem: true, lastActiveAt: 0, sortOrder: 0, pinned: false, status: 'active', taskCount: 0 },
        { id: 's1',  title: 'Chat', isSystem: false, lastActiveAt: 1, sortOrder: 1, pinned: false, status: 'active', taskCount: 0, agentType: 'ceo' },
      ],
      selectedSessionId: 's1',
    }),
}))
vi.mock('./use-runs', () => ({ useRuns: () => [
  { id: 'r1', sessionId: 's1', goal: 'g', status: 'running',   summary: null, events: [] },
  { id: 'r2', sessionId: 's2', goal: 'g', status: 'completed', summary: null, events: [] },
]}))
vi.mock('./use-cron', () => ({ useAllCronJobs: () => ({ data: [{ id: 'c1', sessionId: 'sys', name: '日报', cron: '0 9 * * *', nextRun: 1, lastRun: 0, lastStatus: null, originSessionId: null, sessionTitle: null, originSessionTitle: null, createdAt: 0, goal: '' }] }) }))
vi.mock('./use-agents', () => ({ useTeamOptions: () => [{ id: 'ceo', label: '公司 (CEO)' }] }))
vi.mock('./use-memory', () => ({ useMemory: () => ({ entries: [], isError: false, refetch: () => {} }) }))
vi.mock('./use-skills', () => ({ useSkills: () => ({ skills: [], setSkills: () => {}, reload: () => {} }) }))
vi.mock('../lib/api', () => ({ swarmApi: { listArtifacts: vi.fn().mockResolvedValue([]) } }))

import { usePaletteData } from './use-palette-data'

describe('usePaletteData', () => {
  it('excludes the system session from sessions', () => {
    const { result } = renderHook(() => usePaletteData())
    expect(result.current.sessions.map((s) => s.id)).toEqual(['s1'])
    expect(result.current.currentSessionId).toBe('s1')
  })
  it('keeps only running/pending runs', () => {
    const { result } = renderHook(() => usePaletteData())
    expect(result.current.runningRuns.map((r) => r.id)).toEqual(['r1'])
  })
})
```

- [ ] **Step 3: Run the test to verify it fails**

Run: `cd apps/desktop && cross-env ELECTRON_RUN_AS_NODE=1 electron node_modules/vitest/vitest.mjs run src/hooks/use-palette-data.test.tsx`
Expected: FAIL.

- [ ] **Step 4: Implement `usePaletteData`**

```ts
// apps/desktop/src/renderer/src/hooks/use-palette-data.ts
import { useQuery } from '@tanstack/react-query'
import { useMemo } from 'react'
import { swarmApi } from '../lib/api'
import { useSessionsStore } from '../stores/sessions'
import { useAllCronJobs } from './use-cron'
import { useMemory } from './use-memory'
import { useRuns } from './use-runs'
import { useSkills } from './use-skills'
import { useTeamOptions } from './use-agents'
import type { BuildInputs } from '../lib/palette/build-items'

const SERVICES = [
  { id: 'bilibili', label: 'Bilibili', route: '/bilibili' },
  { id: 'gmail',    label: 'Gmail',    route: '/gmail' },
  { id: 'scheduled',label: '定时任务',  route: '/scheduled' },
  { id: 'trending', label: '热点',     route: '/trending' },
] as const

/** Gather every data source the palette needs into the BuildInputs shape. */
export function usePaletteData(): BuildInputs {
  const sessions = useSessionsStore((s) => s.sessions)
  const currentSessionId = useSessionsStore((s) => s.selectedSessionId)
  const allRuns = useRuns()
  const cron = useAllCronJobs()
  const formations = useTeamOptions()
  const memory = useMemory()
  const skills = useSkills()
  const artifacts = useQuery({
    queryKey: ['palette', 'artifacts'],
    queryFn: () => swarmApi.listArtifacts({ limit: 50 }),
    staleTime: 60_000,
  })

  return useMemo<BuildInputs>(() => ({
    sessions: sessions.filter((s) => !s.isSystem).map((s) => ({ id: s.id, title: s.title, lastActiveAt: s.lastActiveAt, agentType: s.agentType })),
    currentSessionId,
    runningRuns: allRuns.filter((r) => r.status === 'running' || r.status === 'pending')
      .map((r) => ({ id: r.id, sessionId: r.sessionId, goal: r.goal, status: r.status, summary: r.summary, plan: r.plan?.map((p) => ({ content: p.content, status: p.status })) })),
    cronJobs: (cron.data ?? []).map((c) => ({ id: c.id, sessionId: c.sessionId, name: c.name, cron: c.cron, nextRun: c.nextRun, lastRun: c.lastRunAt, lastStatus: null })),
    formations,
    artifacts: (artifacts.data ?? []).map((a) => ({ kind: a.kind, name: a.name, ref: a.ref, origin: a.origin, modifiedAt: a.modifiedAt })),
    memory: memory.entries.map((m) => ({ id: m.id, key: m.key, namespace: m.namespace, category: m.category, content: m.content, timestamp: m.timestamp })),
    skills: skills.skills.map((s) => ({ name: s.name, description: s.description, enabled: s.enabled })),
    services: SERVICES.map((s) => ({ id: s.id, label: s.label, route: s.route })),
  }), [sessions, currentSessionId, allRuns, cron.data, formations, memory.entries, skills.skills, artifacts.data])
}
```

(`PlanTodo` is `{ content: string; status: 'pending' | 'in_progress' | 'completed' }` per `packages/protocol/src/types/task.ts:67-71` — verified. Progress % = `done/total` where `done = plan.filter(p => p.status === 'completed').length`.)

- [ ] **Step 5: Run the test to verify it passes**

Run: `cd apps/desktop && cross-env ELECTRON_RUN_AS_NODE=1 electron node_modules/vitest/vitest.mjs run src/hooks/use-palette-data.test.tsx`
Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add apps/desktop/src/renderer/src/hooks/use-palette-data.ts apps/desktop/src/renderer/src/hooks/use-palette-data.test.tsx
git commit -m "feat(palette): usePaletteData hook aggregating all renderer sources"
```

---

## Task 6: State + keyboard hook (`usePaletteState`)

Owns query/sel/preview state and the keyboard handler. The single piece of "controller" logic.

**Files:**
- Create: `apps/desktop/src/renderer/src/components/palette/use-palette-state.ts`

**Interfaces:**
- Consumes: `getScope` (Task 1), `buildItems` (Task 3), `selectPalette` (Task 4), `PaletteItem`.
- Produces: `usePaletteState({ inputs, cb, open, close }): { query, setQuery, scope, sections, flat, selIndex, selected, setSelIndex, preview }`.

- [ ] **Step 1: Implement the hook**

Logic:
- `const [query, setQuery] = useState('')`
- `const { mode, term } = getScope(query)` (re-derived each render).
- `const items = useMemo(() => buildItems(mode, term, inputs, cb), [mode, term, inputs, cb])`
- `const { sections, flat } = useMemo(() => selectPalette(mode, items), [mode, items])`
- `const [selIndex, setSelIndex] = useState(0)`
- Reset `selIndex` to 0 whenever `query` changes (use `useEffect([query])`).
- `const selected = flat[selIndex] ?? null`
- `onKeyDown(e)`:
  - `ArrowDown` → `e.preventDefault(); setSelIndex((i) => Math.min(i + 1, flat.length - 1))`
  - `ArrowUp` → `e.preventDefault(); setSelIndex((i) => Math.max(i - 1, 0))`
  - `Enter` → `e.preventDefault(); selected?.run()`
  - `Escape` → if `query` non-empty `setQuery('')`; else `close()`
  - `Backspace` → if `query` is exactly a lone prefix char (`'>'|'@'|'#'|'/'`) `setQuery('')`
- Return `{ query, setQuery, scope: mode, sections, flat, selIndex, selected, setSelIndex, preview: selected?.preview ?? null }`.

Keep the file under ~70 lines.

```ts
// apps/desktop/src/renderer/src/components/palette/use-palette-state.ts
import { useEffect, useMemo, useState } from 'react'
import { buildItems, type BuildInputs, type Callbacks } from '../../lib/palette/build-items'
import { getScope } from '../../lib/palette/scope'
import { selectPalette } from '../../lib/palette/select-palette'

const PREFIX_CHARS = new Set(['>', '@', '#', '/'])

export function usePaletteState(args: {
  inputs: BuildInputs
  cb: Callbacks
  open: boolean
  close: () => void
}) {
  const { inputs, cb, open, close } = args
  const [query, setQuery] = useState('')
  const { mode, term } = getScope(query)

  const items = useMemo(() => buildItems(mode, term, inputs, cb), [mode, term, inputs, cb])
  const { sections, flat } = useMemo(() => selectPalette(mode, items), [mode, items])

  const [selIndex, setSelIndex] = useState(0)
  useEffect(() => { setSelIndex(0) }, [query])
  useEffect(() => { if (!open) setQuery('') }, [open]) // reset on close

  const selected = flat[selIndex] ?? null

  const onKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === 'ArrowDown') { e.preventDefault(); setSelIndex((i) => Math.min(i + 1, Math.max(flat.length - 1, 0))) }
    else if (e.key === 'ArrowUp') { e.preventDefault(); setSelIndex((i) => Math.max(i - 1, 0)) }
    else if (e.key === 'Enter') { e.preventDefault(); selected?.run() }
    else if (e.key === 'Escape') { if (query) setQuery(''); else close() }
    else if (e.key === 'Backspace' && PREFIX_CHARS.has(query)) { e.preventDefault(); setQuery('') }
  }

  return { query, setQuery, scope: mode, sections, flat, selIndex, setSelIndex, selected, preview: selected?.preview ?? null, onKeyDown }
}
```

- [ ] **Step 2: Commit (no separate test — covered by Task 9's integration smoke)**

```bash
git add apps/desktop/src/renderer/src/components/palette/use-palette-state.ts
git commit -m "feat(palette): usePaletteState controller (query/sel/keyboard)"
```

---

## Task 7: Palette shell + input + results + item rows

The visual shell. Built on `@swarm/ui` `Dialog` primitives.

**Files:**
- Create: `apps/desktop/src/renderer/src/components/palette/palette-dialog.tsx`
- Create: `apps/desktop/src/renderer/src/components/palette/palette-input.tsx`
- Create: `apps/desktop/src/renderer/src/components/palette/palette-results.tsx`
- Create: `apps/desktop/src/renderer/src/components/palette/palette-item.tsx`
- Modify: `apps/desktop/src/renderer/src/components/session-search-dialog.tsx` (gut it, mount `<PaletteDialog/>`)

**Interfaces:**
- Consumes: `usePaletteData`, `usePaletteState`, the navigation/settings/theme/export callbacks wired via `useNavigate`/`useSettingsDialog`/`useTheme`/`swarmApi.exportSessionMarkdown`/`useComposerDefaults`/`useSubmitGoal`.
- Produces: `<PaletteDialog open onClose />`.

- [ ] **Step 1: Wire the callbacks in `palette-dialog.tsx`**

Top of `PaletteDialog`:

```tsx
const navigate = useNavigate()
const openSettings = useSettingsDialog((s) => s.openSettings)
const { theme, setTheme } = useTheme()
const setComposerAgent = useComposerDefaults((s) => s.setAgentType)
const submitGoal = useSubmitGoal()
const inputs = usePaletteData()
const close = useSearchDialog((s) => s.close)

const cb: Callbacks = useMemo(() => ({
  navigate: (to) => { close(); navigate({ to }) },
  openSettings: (section) => { close(); openSettings(section) },
  cycleTheme: () => { const order = ['system','light','dark'] as const; const next = order[(order.indexOf(theme ?? 'system') + 1) % order.length]; setTheme(next) },
  exportMarkdown: (sid) => { if (sid) { void swarmApi.exportSessionMarkdown(sid); close() } },
  setComposerAgent: (id) => setComposerAgent(id),
  openArtifact: (ref) => { void window.swarm.openPath(ref); close() },
  submitGoal: async (goal, agentType) => { const r = await submitGoal.mutateAsync({ goal, options: { agentType }, forceNew: true }); close(); navigate({ to: '/session/$sessionId', params: { sessionId: r.sessionId } }); return r },
}), [theme, setTheme, setComposerAgent, submitGoal, openSettings, close, navigate])
```

Note `close()` is called inside each callback so navigation happens after the palette is dismissed.

- [ ] **Step 2: Build the shell layout**

```tsx
return (
  <Dialog open={open} onOpenChange={(o) => { if (!o) close() }}>
    <DialogPortal>
      <DialogOverlay className="fixed inset-0 z-50 bg-black/30 backdrop-blur-[2px]" />
      <DialogContent
        className="left-1/2 top-[96px] z-50 w-[760px] max-w-[760px] -translate-x-1/2 rounded-2xl border-border/60 bg-popover/82 p-0 text-popover-foreground shadow-2xl backdrop-blur-[40px] backdrop-saturate-150 dark:bg-popover/82 supports-[backdrop-filter]:bg-popover/70"
        onKeyDown={state.onKeyDown}
      >
        <DialogTitle className="sr-only">命令面板</DialogTitle>
        <DialogDescription className="sr-only">搜索对话、命令、任务、文件,或直接指派 Agent。</DialogDescription>
        <PaletteInput ... />
        <div className="flex min-h-0 flex-1">
          <PaletteResults className="flex-1" ... />
          <aside className="w-[296px] flex-none border-l border-border/60 bg-muted/30 overflow-y-auto cmdscroll">
            <PreviewSwitch preview={state.preview} />
          </aside>
        </div>
        <PaletteFooter selected={state.selected} />
      </DialogContent>
    </DialogPortal>
  </Dialog>
)
```

(Use the `cmdscroll` class for both scroll regions. It is NOT in `globals.css` yet — add it there in this step:

```css
/* apps/desktop/src/renderer/src/styles/globals.css — append */
.cmdscroll::-webkit-scrollbar { width: 8px; height: 8px }
.cmdscroll::-webkit-scrollbar-thumb { background: rgba(0,0,0,.16); border-radius: 8px; border: 2px solid transparent; background-clip: padding-box }
.cmdscroll::-webkit-scrollbar-track { background: transparent }
.dark .cmdscroll::-webkit-scrollbar-thumb { background: rgba(255,255,255,.18) }
```
)

- [ ] **Step 3: Implement `PaletteInput`**

Icon via `SCOPE_META[scope].icon` mapped to a lucide component (`Search`/`Command`/`Users`/`ListChecks`/`Folder`). Render the pill when `scope !== 'mixed'` (from `SCOPE_META[scope].pill`), with an `×` button that calls `setQuery('')`. Input is `<input value={query} onChange={(e) => setQuery(e.target.value)} placeholder={SCOPE_META[scope].placeholder} className="h-9 flex-1 bg-transparent text-[20px] outline-none" />`. Trailing `{flat.length} 结果`.

- [ ] **Step 4: Implement `PaletteResults`**

Render `sections.map(s => <section><h3>{s.heading}</h3>{s.items.map(it => <PaletteItemRow ... />)}</section>)`. Each row is a `<button>` (focusable) with `data-sel={selIndex === idx}` driving `data-active:` Tailwind variants. `onClick` calls `setSelIndex(idx)` then `it.run()`. `onMouseEnter` calls `setSelIndex(idx)`.

Empty state: if `flat.length === 0`, render `<div className="p-8 text-center text-muted-foreground">没有匹配「{query}」的结果</div>` (and a hint to dispatch if scope is mixed).

- [ ] **Step 5: Implement `PaletteItemRow`**

`icon` (lucide, 18px) + `title` (font-medium) + optional `subtitle` (text-muted-foreground, text-xs, truncate) + optional `badge` (rounded bg-muted px-1.5 text-[11px]) + optional `progress` (a 2px bar). Use `cn()` from `@swarm/ui`.

- [ ] **Step 6: Replace `session-search-dialog.tsx` body**

Keep the file (it's imported by `__root.tsx` and `session-list.tsx`). Replace its body:

```tsx
// apps/desktop/src/renderer/src/components/session-search-dialog.tsx
import { useHotkey } from '@tanstack/react-hotkeys'
import { PaletteDialog } from './palette/palette-dialog'
import { useSearchDialog } from '../stores/search-dialog'

export function SessionSearchDialog() {
  const open = useSearchDialog((s) => s.open)
  const toggle = useSearchDialog((s) => s.toggle)
  useHotkey('Mod+K', () => toggle(), { stopPropagation: false })
  return <PaletteDialog open={open} />
}
```

(`PaletteDialog` reads `close` from the store itself.)

- [ ] **Step 7: Manually smoke-test in the running app**

Run: `pnpm dev` (or the project's dev command), press ⌘K, verify:
- Palette opens, 760×660, frosted.
- Typing `>`, `@`, `#`, `/` switches scope, shows pill + icon color change.
- Backspace on lone prefix → mixed.
- ↑/↓ moves selection; right pane updates.
- Enter on 「新建对话」 navigates home.

- [ ] **Step 8: Commit**

```bash
git add apps/desktop/src/renderer/src/components/palette/ apps/desktop/src/renderer/src/components/session-search-dialog.tsx
git commit -m "feat(palette): two-column frosted shell + input/results/item rows"
```

---

## Task 8: Five preview components

The right pane. Each renders one `PreviewData` variant.

**Files:**
- Create: `apps/desktop/src/renderer/src/components/palette/preview/dispatch.tsx`
- Create: `apps/desktop/src/renderer/src/components/palette/preview/chat.tsx`
- Create: `apps/desktop/src/renderer/src/components/palette/preview/task-run.tsx`
- Create: `apps/desktop/src/renderer/src/components/palette/preview/task-sched.tsx`
- Create: `apps/desktop/src/renderer/src/components/palette/preview/info.tsx`
- Create: `apps/desktop/src/renderer/src/components/palette/preview/index.tsx`

**Interfaces:**
- Consumes: `PreviewData` (Task 2), `swarmApi.getRunEvents` (via `useQuery(['session-preview', id])` for chat + task-run live log).
- Produces: `<PreviewSwitch preview={preview} />` rendered by the shell.

- [ ] **Step 1: `info.tsx` (generic — covers command/agent/file/service/memory/skill)**

```tsx
export function InfoPreview({ data }: { data: Extract<PreviewData, { type: 'info' }> }) {
  return (
    <div className="p-4">
      <h4 className="text-sm font-semibold">{data.title}</h4>
      {data.desc && <p className="mt-1 text-xs text-muted-foreground">{data.desc}</p>}
      {data.rows.length > 0 && (
        <dl className="mt-3 space-y-1.5 text-xs">
          {data.rows.map((r) => (
            <div key={r.label} className="flex justify-between gap-3">
              <dt className="text-muted-foreground">{r.label}</dt>
              <dd className="font-medium text-right truncate">{r.value}</dd>
            </div>
          ))}
        </dl>
      )}
    </div>
  )
}
```

- [ ] **Step 2: `dispatch.tsx` (hero)**

Shows the term as title, a formation picker (a `<select>` bound to a local state, default `ceo`), and a 预计步骤 list (`规划`/`检索`/`综合`). The picker's value must feed back into the dispatch item's `run()` — since `run()` is baked at build time, instead store the picked formation in `usePaletteState` and have the dispatch item's `run()` read it. **Decision:** add `pickedFormation` to `usePaletteState` state; the dispatch `buildItems` callback reads `cb.submitGoal(term, pickedFormation)` — but `buildItems` is pure and doesn't know `pickedFormation`. **Resolution:** the dispatch item's `run` calls `cb.submitGoal(term, '<defaultFormation>')` and the `dispatch.tsx` preview renders the picker whose `onChange` calls a setter passed via context/prop that updates the default. Simplest: lift `pickedFormation` into `usePaletteState`, and rebuild `cb` (via `useMemo`) when it changes so the dispatch item captures the latest. The `cb` in Task 7 already depends on `[...]` — add `pickedFormation` there.

```tsx
export function DispatchPreview({ data, formations, picked, onPick }: {
  data: Extract<PreviewData, { type: 'dispatch' }>
  formations: { id: string; label: string }[]
  picked: string
  onPick: (id: string) => void
}) {
  return (
    <div className="p-4">
      <div className="text-xs text-muted-foreground">指派给 Agent</div>
      <h4 className="mt-1 text-base font-semibold leading-snug">「{data.term}」</h4>
      <label className="mt-3 block text-xs text-muted-foreground">编队
        <select className="mt-1 w-full rounded-md border border-border bg-background px-2 py-1 text-xs" value={picked} onChange={(e) => onPick(e.target.value)}>
          {formations.map((f) => <option key={f.id} value={f.id}>{f.label}</option>)}
        </select>
      </label>
      <div className="mt-3 text-xs text-muted-foreground">预计步骤</div>
      <ol className="mt-1 list-decimal space-y-0.5 pl-4 text-xs">
        <li>规划:拆解目标,选择 Agent</li>
        <li>检索:收集所需上下文</li>
        <li>综合:产出结果并汇报</li>
      </ol>
    </div>
  )
}
```

- [ ] **Step 3: `chat.tsx` (lazy-hydrate recent messages)**

```tsx
import { useQuery } from '@tanstack/react-query'
import { swarmApi } from '../../../lib/api'

export function ChatPreview({ data }: { data: Extract<PreviewData, { type: 'chat' }> }) {
  const q = useQuery({
    queryKey: ['session-preview', data.sessionId],
    queryFn: () => swarmApi.getRunEvents(data.sessionId),
    enabled: !!data.sessionId,
    staleTime: 30_000,
  })
  if (q.isLoading) return <div className="p-4 text-xs text-muted-foreground">加载中…</div>
  const msgs = (q.data ?? []).filter((r) => r.event.kind === 'run.progress' && (r.event as any).event?.kind === 'llm.message').slice(-20)
  return (
    <div className="p-4">
      <h4 className="text-sm font-semibold">{data.title}</h4>
      <div className="mt-2 space-y-2 text-xs">
        {msgs.map((m, i) => {
          const msg = (m.event as any).event
          const role = msg.role === 'user' ? '你' : msg.role === 'assistant' ? 'Agent' : '工具'
          return <p key={i}><span className="font-medium">{role}:</span> {String(msg.content ?? '').slice(0, 200)}</p>
        })}
        {msgs.length === 0 && <p className="text-muted-foreground">暂无消息</p>}
      </div>
    </div>
  )
}
```

- [ ] **Step 4: `task-run.tsx` + `task-sched.tsx`**

`task-run` shows goal + progress (compute `%` from `plan` done/total) + a 实时日志 (last 20 lines from the session's `getRunEvents` filtered to `tool.call`/`llm.message`, monospace). `task-sched` shows key/value rows (cron expression, next run, last run) + 上次结果 (text). Both reuse the `useQuery(['session-preview', id])` pattern where they need events.

- [ ] **Step 5: `index.tsx` (switch)**

```tsx
import type { PreviewData } from '../../../lib/palette/types'
import { ChatPreview } from './chat'
import { DispatchPreview } from './dispatch'
import { InfoPreview } from './info'
import { TaskRunPreview } from './task-run'
import { TaskSchedPreview } from './task-sched'

export function PreviewSwitch(props: { preview: PreviewData | null; formations: { id: string; label: string }[]; picked: string; onPick: (id: string) => void }) {
  if (!props.preview) return <div className="p-4 text-xs text-muted-foreground">选择左侧条目查看详情</div>
  switch (props.preview.type) {
    case 'info':     return <InfoPreview data={props.preview} />
    case 'dispatch': return <DispatchPreview data={props.preview} formations={props.formations} picked={props.picked} onPick={props.onPick} />
    case 'chat':     return <ChatPreview data={props.preview} />
    case 'taskRun':  return <TaskRunPreview data={props.preview} />
    case 'taskSched':return <TaskSchedPreview data={props.preview} />
  }
}
```

- [ ] **Step 6: Wire `pickedFormation` into `usePaletteState` and pass `formations` + `onPick` down from `palette-dialog.tsx`**

Add to `usePaletteState`:
```ts
const [pickedFormation, setPickedFormation] = useState('ceo')
```
and return it. In `palette-dialog.tsx`, add `pickedFormation` to the `cb` `useMemo` deps and to the `submitGoal` callback (replace the hardcoded `'ceo'`).

- [ ] **Step 7: Commit**

```bash
git add apps/desktop/src/renderer/src/components/palette/preview/
git commit -m "feat(palette): five right-pane preview components + switch"
```

---

## Task 9: Footer + integration smoke test

**Files:**
- Modify: `apps/desktop/src/renderer/src/components/palette/palette-dialog.tsx` (add `<PaletteFooter/>`)
- Create: `apps/desktop/src/renderer/src/components/palette/palette-dialog.test.tsx`

- [ ] **Step 1: Footer**

```tsx
function PaletteFooter({ selected }: { selected: PaletteItem | null }) {
  return (
    <div className="flex items-center justify-between border-t border-border/60 px-4 py-2 text-xs text-muted-foreground">
      <span>{selected?.title ?? '未选择'}</span>
      <span className="flex items-center gap-2">
        <kbd className="rounded bg-muted px-1.5 py-0.5 text-[10px]">↵</kbd>
        <span>执行</span>
        <span className="opacity-50">·</span>
        <kbd className="rounded bg-muted px-1.5 py-0.5 text-[10px]">⌘K</kbd>
        <span>操作</span>
      </span>
    </div>
  )
}
```

- [ ] **Step 2: Write the integration smoke test**

Mock `useSearchDialog` to force `open: true`, mock the data hooks to return a known small set. Render `<SessionSearchDialog/>`. Assert:
- Input is focused.
- Typing `>set` filters commands to 「打开设置」.
- `ArrowDown` + `Enter` calls the navigate mock with `'general'` settings.
- Backspace on `>` clears the input.

```tsx
// apps/desktop/src/renderer/src/components/palette/palette-dialog.test.tsx
// @vitest-environment jsdom
import '@testing-library/jest-dom/vitest'
import { fireEvent, render, screen, within } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
// …mock the same modules as use-palette-data.test.tsx, plus useSearchDialog open:true…
// Assert scope filtering, keyboard nav, run() invocation.
```

- [ ] **Step 3: Run all palette tests**

Run: `cd apps/desktop && cross-env ELECTRON_RUN_AS_NODE=1 electron node_modules/vitest/vitest.mjs run src/lib/palette src/hooks/use-palette-data src/components/palette`
Expected: all PASS.

- [ ] **Step 4: Run the full test suite**

Run: `cd apps/desktop && cross-env ELECTRON_RUN_AS_NODE=1 electron node_modules/vitest/vitest.mjs run`
Expected: green (modulo pre-existing unrelated failures noted in Task 0).

- [ ] **Step 5: Commit**

```bash
git add apps/desktop/src/renderer/src/components/palette/palette-dialog.tsx apps/desktop/src/renderer/src/components/palette/palette-dialog.test.tsx
git commit -m "feat(palette): footer + integration smoke test"
```

---

## Task 10: Manual smoke + dark mode + finish

- [ ] **Step 1: Manual smoke against spec §6 checklist**

Run the app. Walk through every item of the spec §6 "Manual smoke test" list (11 items). Note any visual deviation; fix small CSS issues inline.

- [ ] **Step 2: Verify dark mode**

Toggle dark mode (palette `>外观` command or the theme toggle). Confirm the frosted glass + scope colors render correctly on the dark wallpaper.

- [ ] **Step 3: Announce finishing-a-development-branch**

> I'm using the finishing-a-development-branch skill to complete this work.

Then follow superpowers:finishing-a-development-branch: re-run tests, present options (merge to `refactor/ui-app-shell-rail`? open PR?), execute the chosen option.

---

## Self-Review (filled in after writing)

- **Spec coverage:** §3.1 geometry → Task 7; §3.2 scopes → Task 1; §3.3 result categories → Tasks 3+4; §3.4 preview types → Task 8; §3.5 keyboard → Task 6; §3.6 run() actions → Task 3 (callbacks wired in Task 7). ✅
- **Placeholder scan:** No TBDs. (Verified `PlanTodo` shape against `packages/protocol/src/types/task.ts:67` during review — `content`/`status` enum, not the `text`/`done` first drafted; plan body and all 4 touch-points corrected. Confirmed `cmdscroll` is absent from `globals.css` — plan now says to add it.)
- **Type consistency:** `PaletteItem`/`PreviewData`/`BuildInputs`/`Callbacks` defined once (Task 2/3) and reused by name everywhere. ✅
- **Spec §5.1 file structure match:** All 9 files from the spec exist in the plan. The `lib/palette/types.ts` is added beyond the spec (split out from `scope.ts`); this is a minor, justified deviation. ✅
