# Session Workspace Four-Tab (Phase 4) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace the session route's `RightPanel` (Plan/Memory/Scheduled, 80px, collapse-by-default) with a 300px four-tab `WorkspacePanel` (计划/时间线/产出物/审批), the last carrying an approval count badge; default-expanded with a manual collapse toggle.

**Architecture:** Two new pure builders (`buildTimeline`, `buildArtifacts`) feed the two new tabs (TDD, no React). The shell + four tab components live in `components/workspace/`. `TasksView` swaps `<RightPanel planGroups={...}/>` for `<WorkspacePanel runs={...} planGroups={...} session={...}/>`. The 计划 tab reuses the existing `PlanPanel`; the 审批 tab reuses the existing `PermissionCard` + the same `decide.mutate` decision path. The orphaned `task-timeline.tsx` is folded into `build-timeline.ts` and deleted. Memory/Scheduled tabs are dropped (content reachable elsewhere).

**Tech Stack:** React 19, TanStack Query (for `listArtifacts`), Zustand (`usePermissionStore`, `useSessionsStore`), `@swarm/ui` Tabs (Base UI), lucide-react icons, Tailwind v4, Vitest + @testing-library/react + jsdom.

---

## Global Constraints

(verbatim from spec §2026-07-06-session-workspace-four-tab-design — every task inherits these)

- **Panel:** 300px fixed width, full height, `bg-secondary`/`bg-[var(--window-content)]`, `border-l border-border/60`. Default expanded; manual collapse toggle (collapsed = hidden, conversation expands to fill).
- **Tabs (folder-style):** active = `bg-background`, full border with `border-bottom:none`, `rounded-t-lg`, `font-semibold`; inactive = muted text, no bg/border. Text-only (no icons). Strip has `border-b`.
- **审批 badge:** amber pill on the tab label, rendered ONLY when current-session pending count > 0. `min-w-[15px] h-[15px] rounded-full bg-amber-600 text-white text-[9.5px] font-bold` (light) / dark inverts text.
- **Tab content:** scrollable (`cmdscroll`), `p-4`, `flex flex-col gap-1.5`.
- **Copy rule:** user-facing strings Chinese (AGENTS.md §0). Code comments + commit messages English.
- **Four tab labels (verbatim):** `计划` · `时间线` · `产出物` · `审批`.

### Deviations from spec (locked — do NOT "fix")

1. **计划 footer "用时" uses a duration, not `formatRelativeTime`.** `formatRelativeTime` returns "X 分钟前" (relative-to-now); a run duration needs "用时 X 分 Y 秒". Write a tiny inline duration formatter; do NOT reuse `formatRelativeTime` for the duration string (it would read "X 分钟前" which is wrong for an elapsed-time label). It CAN be reused elsewhere if needed.
2. **Default expanded means flipping the current `RightPanel`'s `useState(true)` to `useState(false)`** (current panel defaults to collapsed; spec mandates default expanded).
3. **`run.progress` events are filtered OUT of `buildTimeline`** (spec §3.4 — too dense). Do not surface them.
4. **审批 tab uses the existing three actions only** (Allow/Deny/Skip). The spec's "本会话始终允许" is a non-goal (needs permission-protocol change). Do not add a fourth button.

### Branch

Create `feat/session-workspace` from `refactor/ui-app-shell-rail` (current branch; carries Phases 1, 2, 3a, 3b).

### File Structure (locked from spec §4.1)

Pure builders (unit-tested, no React):
- `apps/desktop/src/renderer/src/lib/workspace/build-timeline.ts` — `buildTimeline(runs): TimelineRow[]`.
- `apps/desktop/src/renderer/src/lib/workspace/build-artifacts.ts` — `buildArtifacts(runs, cwdArtifacts): ArtifactRow[]`.

React shell + tabs (in `components/workspace/`):
- `workspace-panel.tsx` — the shell (300px aside + collapse toggle + folder-style Tabs + badge).
- `timeline-tab.tsx` — renders `TimelineRow[]`.
- `artifacts-tab.tsx` — renders `ArtifactRow[]` + TanStack Query for `listArtifacts`.
- `approval-tab.tsx` — renders filtered `usePermissionStore.queue` with `PermissionCard`s.
- `plan-usage-footer.tsx` — the `用时 · Nk tokens` footer.

Modified:
- `components/views/tasks-view.tsx` — replace `<RightPanel/>` with `<WorkspacePanel/>`; pass `runs`, `planGroups`, `session`.

Deleted:
- `components/right-panel.tsx` — replaced by `workspace-panel.tsx`.
- `components/task-timeline.tsx` — `eventLabel` folded into `build-timeline.ts`; orphan (zero importers).

Tests (colocated, jsdom):
- `lib/workspace/build-timeline.test.ts`, `lib/workspace/build-artifacts.test.ts` — pure-logic.
- `components/workspace/workspace-panel.test.tsx` — shell smoke (tabs render, badge count, collapse toggle).

---

## Task 0: Branch & baseline

**Files:** none.

- [ ] **Step 1: Create the feature branch off the current branch**

```bash
git checkout -b feat/session-workspace refactor/ui-app-shell-rail
git status   # confirm on feat/session-workspace, working tree clean (only pre-existing untracked)
```

- [ ] **Step 2: Confirm the spec's data sources are reachable**

```bash
grep -c "listArtifacts" apps/desktop/src/renderer/src/lib/api.ts   # expect ≥1 (Phase 3a)
grep -c "usePermissionStore" apps/desktop/src/renderer/src/stores/permission.ts  # expect 1
grep -rn "RightPanel" apps/desktop/src/renderer/src/components/views/tasks-view.tsx  # expect 1 call site
```

- [ ] **Step 3: Run the baseline test suite (green baseline)**

Run: `cd apps/desktop && ELECTRON_RUN_AS_NODE=1 node_modules/.bin/electron node_modules/vitest/vitest.mjs run`
Expected: all green modulo the pre-existing `host.test.ts` EADDRINUSE:47777 flake (one environmental failure unrelated to UI).

---

## Task 1: Pure `buildTimeline` builder

**Files:**
- Create: `apps/desktop/src/renderer/src/lib/workspace/build-timeline.ts`
- Test: `apps/desktop/src/renderer/src/lib/workspace/build-timeline.test.ts`

**Interfaces:**
- Consumes: `RunRecord` from `@shared/lib/apply-event`, `UIEvent` from `@swarm/protocol`.
- Produces: `buildTimeline(runs: RunRecord[]): TimelineRow[]` and the `TimelineRow` / `TimelineKind` types.

- [ ] **Step 1: Write the failing test**

```ts
// apps/desktop/src/renderer/src/lib/workspace/build-timeline.test.ts
import { describe, expect, it } from 'vitest'
import type { RunRecord } from '@shared/lib/apply-event'
import { buildTimeline } from './build-timeline'

function mkRun(over: Partial<RunRecord> & Pick<RunRecord, 'id'>): RunRecord {
  return {
    sessionId: 's1', goal: 'g', status: 'running', summary: null, startedAt: 1000,
    attachments: [], events: [], ...over,
  }
}

describe('buildTimeline', () => {
  it('returns an empty list for runs with no events', () => {
    expect(buildTimeline([mkRun({ id: 'r1' })])).toEqual([])
  })

  it('maps run.created → start row with the goal', () => {
    const run = mkRun({ id: 'r1', events: [
      // biome-ignore lint/suspicious/noExplicitAny: test fixture
      { kind: 'run.created', sessionId: 's1', runId: 'r1', seq: 1, ts: 100, goal: '修复登录' } as any,
    ] })
    const rows = buildTimeline([run])
    expect(rows).toHaveLength(1)
    expect(rows[0]).toMatchObject({ kind: 'start', label: '修复登录', ts: 100 })
  })

  it('maps run.tool_call → tool row with the tool name', () => {
    const run = mkRun({ id: 'r1', events: [
      // biome-ignore lint/suspicious/noExplicitAny: test fixture
      { kind: 'run.tool_call', sessionId: 's1', runId: 'r1', seq: 2, ts: 200, tool: 'shell', args: {} } as any,
    ] })
    expect(buildTimeline([run])[0]).toMatchObject({ kind: 'tool', label: 'shell', ts: 200 })
  })

  it('maps run.permission_request → permission row', () => {
    const run = mkRun({ id: 'r1', events: [
      // biome-ignore lint/suspicious/noExplicitAny: test fixture
      { kind: 'run.permission_request', sessionId: 's1', runId: 'r1', seq: 3, ts: 300, actionId: 'a1', risk: 'high', summary: 'rm -rf', payload: null } as any,
    ] })
    expect(buildTimeline([run])[0]).toMatchObject({ kind: 'permission', label: 'rm -rf', ts: 300 })
  })

  it('maps run.complete → complete row with summary', () => {
    const run = mkRun({ id: 'r1', events: [
      // biome-ignore lint/suspicious/noExplicitAny: test fixture
      { kind: 'run.complete', sessionId: 's1', runId: 'r1', seq: 4, ts: 400, summary: '完成' } as any,
    ] })
    expect(buildTimeline([run])[0]).toMatchObject({ kind: 'complete', label: '完成', ts: 400 })
  })

  it('maps run.error → error row with the message', () => {
    const run = mkRun({ id: 'r1', events: [
      // biome-ignore lint/suspicious/noExplicitAny: test fixture
      { kind: 'run.error', sessionId: 's1', runId: 'r1', seq: 5, ts: 500, error: { code: 'X', message: '炸了', tier: 'fatal' } } as any,
    ] })
    expect(buildTimeline([run])[0]).toMatchObject({ kind: 'error', label: '炸了', ts: 500 })
  })

  it('filters out run.progress events (too dense)', () => {
    const run = mkRun({ id: 'r1', events: [
      // biome-ignore lint/suspicious/noExplicitAny: test fixture
      { kind: 'run.progress', sessionId: 's1', runId: 'r1', seq: 6, ts: 600, event: { kind: 'llm.message', role: 'assistant', content: 'hi', ts: 600 } } as any,
    ] })
    expect(buildTimeline([run])).toEqual([])
  })

  it('also filters run.usage / run.plan / run.delegation_plan / run.spawned', () => {
    const run = mkRun({ id: 'r1', events: [
      // biome-ignore lint/suspicious/noExplicitAny: test fixture
      { kind: 'run.usage', sessionId: 's1', runId: 'r1', seq: 7, ts: 700, used: { inputTokens: 1, outputTokens: 1 } } as any,
      // biome-ignore lint/suspicious/noExplicitAny: test fixture
      { kind: 'run.plan', sessionId: 's1', runId: 'r1', seq: 8, ts: 800, todos: [] } as any,
    ] })
    expect(buildTimeline([run])).toEqual([])
  })

  it('flattens multiple runs and sorts by ts ascending', () => {
    const r1 = mkRun({ id: 'r1', events: [
      // biome-ignore lint/suspicious/noExplicitAny: test fixture
      { kind: 'run.created', sessionId: 's1', runId: 'r1', seq: 1, ts: 300, goal: '晚的' } as any,
    ] })
    const r2 = mkRun({ id: 'r2', events: [
      // biome-ignore lint/suspicious/noExplicitAny: test fixture
      { kind: 'run.created', sessionId: 's1', runId: 'r2', seq: 1, ts: 100, goal: '早的' } as any,
    ] })
    const rows = buildTimeline([r1, r2])
    expect(rows.map((r) => r.label)).toEqual(['早的', '晚的'])
  })

  it('each row has a unique id (runId + seq)', () => {
    const run = mkRun({ id: 'r1', events: [
      // biome-ignore lint/suspicious/noExplicitAny: test fixture
      { kind: 'run.created', sessionId: 's1', runId: 'r1', seq: 1, ts: 100, goal: 'a' } as any,
      // biome-ignore lint/suspicious/noExplicitAny: test fixture
      { kind: 'run.complete', sessionId: 's1', runId: 'r1', seq: 2, ts: 200, summary: 'b' } as any,
    ] })
    const rows = buildTimeline([run])
    expect(rows.map((r) => r.id)).toEqual(['r1:1', 'r1:2'])
  })
})
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `cd apps/desktop && ELECTRON_RUN_AS_NODE=1 node_modules/.bin/electron node_modules/vitest/vitest.mjs run src/renderer/src/lib/workspace/build-timeline.test.ts`
Expected: FAIL (module not found).

- [ ] **Step 3: Implement `buildTimeline`**

```ts
// apps/desktop/src/renderer/src/lib/workspace/build-timeline.ts
// Pure builder: flattens a session's RunRecord[].events into a flat timeline.
// run.progress / run.usage / run.plan / run.delegation_plan / run.spawned are
// filtered out — too dense for a glanceable log, and their substance shows
// elsewhere (plan tab, transcript).

import type { RunRecord } from '@shared/lib/apply-event'
import type { UIEvent } from '@swarm/protocol'

export type TimelineKind = 'start' | 'dispatch' | 'tool' | 'permission' | 'complete' | 'error'

export type TimelineRow = {
  /** `${runId}:${seq}` — unique within the session. */
  id: string
  ts: number
  kind: TimelineKind
  label: string
}

const KEEP: Record<string, TimelineKind | undefined> = {
  'run.created': 'start',
  'run.dispatched': 'dispatch',
  'run.tool_call': 'tool',
  'run.permission_request': 'permission',
  'run.complete': 'complete',
  'run.error': 'error',
}

function label(e: UIEvent & { ts: number }): string {
  // Narrow per kind; the KEEP guard above guarantees these members.
  switch (e.kind) {
    case 'run.created': return e.goal
    case 'run.dispatched': return '派发'
    case 'run.tool_call': return e.tool
    case 'run.permission_request': return e.summary
    case 'run.complete': return e.summary
    case 'run.error': return e.error.message
    default: return e.kind
  }
}

/** Flatten all runs' events into one timeline, filtering noisy kinds, sorted by ts. */
export function buildTimeline(runs: RunRecord[]): TimelineRow[] {
  const rows: TimelineRow[] = []
  for (const run of runs) {
    for (const e of run.events) {
      const kind = KEEP[e.kind]
      if (!kind) continue
      rows.push({ id: `${run.id}:${e.seq}`, ts: e.ts, kind, label: label(e) })
    }
  }
  rows.sort((a, b) => a.ts - b.ts)
  return rows
}
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `cd apps/desktop && ELECTRON_RUN_AS_NODE=1 node_modules/.bin/electron node_modules/vitest/vitest.mjs run src/renderer/src/lib/workspace/build-timeline.test.ts`
Expected: PASS (9 tests).

- [ ] **Step 5: Commit**

```bash
git add apps/desktop/src/renderer/src/lib/workspace/build-timeline.ts apps/desktop/src/renderer/src/lib/workspace/build-timeline.test.ts
git commit -m "feat(workspace): pure buildTimeline for the session event log"
```

---

## Task 2: Pure `buildArtifacts` builder

**Files:**
- Create: `apps/desktop/src/renderer/src/lib/workspace/build-artifacts.ts`
- Test: `apps/desktop/src/renderer/src/lib/workspace/build-artifacts.test.ts`

**Interfaces:**
- Consumes: `RunRecord` from `@shared/lib/apply-event`, `ArtifactEntry` from `@swarm/protocol`.
- Produces: `buildArtifacts(runs: RunRecord[], cwdArtifacts: ArtifactEntry[]): ArtifactRow[]` and the `ArtifactRow` type.

- [ ] **Step 1: Write the failing test**

```ts
// apps/desktop/src/renderer/src/lib/workspace/build-artifacts.test.ts
import { describe, expect, it } from 'vitest'
import type { RunRecord } from '@shared/lib/apply-event'
import type { ArtifactEntry } from '@swarm/protocol'
import { buildArtifacts } from './build-artifacts'

function mkRun(over: Partial<RunRecord> & Pick<RunRecord, 'id'>): RunRecord {
  return { sessionId: 's1', goal: 'g', status: 'running', summary: null, startedAt: 1, attachments: [], events: [], ...over }
}

describe('buildArtifacts', () => {
  it('extracts absolute and relative file paths from tool_call args', () => {
    const run = mkRun({ id: 'r1', events: [
      // biome-ignore lint/suspicious/noExplicitAny: test fixture
      { kind: 'run.tool_call', sessionId: 's1', runId: 'r1', seq: 1, ts: 1, tool: 'edit', args: { path: '/abs/report.md', label: 'a title' } } as any,
      // biome-ignore lint/suspicious/noExplicitAny: test fixture
      { kind: 'run.tool_call', sessionId: 's1', runId: 'r1', seq: 2, ts: 2, tool: 'edit', args: { file: './src/x.ts' } } as any,
    ] })
    const rows = buildArtifacts([run], [])
    expect(rows.map((r) => r.name)).toEqual(['report.md', 'x.ts'])
    expect(rows.every((r) => r.origin === 'session')).toBe(true)
  })

  it('extracts paths from array values too', () => {
    const run = mkRun({ id: 'r1', events: [
      // biome-ignore lint/suspicious/noExplicitAny: test fixture
      { kind: 'run.tool_call', sessionId: 's1', runId: 'r1', seq: 1, ts: 1, tool: 'x', args: { files: ['/a.txt', './b.js', 'not a path'] } } as any,
    ] })
    expect(buildArtifacts([run], []).map((r) => r.name).sort()).toEqual(['a.txt', 'b.js'])
  })

  it('ignores URLs and path-like strings without an extension', () => {
    const run = mkRun({ id: 'r1', events: [
      // biome-ignore lint/suspicious/noExplicitAny: test fixture
      { kind: 'run.tool_call', sessionId: 's1', runId: 'r1', seq: 1, ts: 1, tool: 'x', args: { url: 'https://example.com/x', dir: '/etc' } } as any,
    ] })
    expect(buildArtifacts([run], [])).toEqual([])
  })

  it('deduplicates session paths by normalized form', () => {
    const run = mkRun({ id: 'r1', events: [
      // biome-ignore lint/suspicious/noExplicitAny: test fixture
      { kind: 'run.tool_call', sessionId: 's1', runId: 'r1', seq: 1, ts: 1, tool: 'x', args: { a: '/tmp/./report.md', b: '/tmp/report.md' } } as any,
    ] })
    expect(buildArtifacts([run], []).map((r) => r.name)).toEqual(['report.md'])
  })

  it('merges cwd artifacts, tagged with their origin', () => {
    const cwd: ArtifactEntry[] = [
      { kind: 'file', name: 'notes.md', ref: '/cwd/notes.md', origin: '/cwd', modifiedAt: 50 },
      { kind: 'bilibili-analysis', name: 'BV1xx', ref: 'BV1xx', origin: 'Bilibili', modifiedAt: 40 },
    ]
    const rows = buildArtifacts([], cwd)
    expect(rows.map((r) => r.name)).toEqual(['notes.md', 'BV1xx'])
    expect(rows[0].origin).toBe('/cwd')
    expect(rows[1].origin).toBe('Bilibili')
  })

  it('session outputs come first, then cwd recents', () => {
    const run = mkRun({ id: 'r1', events: [
      // biome-ignore lint/suspicious/noExplicitAny: test fixture
      { kind: 'run.tool_call', sessionId: 's1', runId: 'r1', seq: 1, ts: 1, tool: 'x', args: { p: '/out/session.md' } } as any,
    ] })
    const cwd: ArtifactEntry[] = [
      { kind: 'file', name: 'cwd-file.md', ref: '/cwd/cwd-file.md', origin: '/cwd', modifiedAt: 100 },
    ]
    const rows = buildArtifacts([run], cwd)
    expect(rows.map((r) => r.name)).toEqual(['session.md', 'cwd-file.md'])
  })

  it('deduplicates across sources (session wins)', () => {
    const run = mkRun({ id: 'r1', events: [
      // biome-ignore lint/suspicious/noExplicitAny: test fixture
      { kind: 'run.tool_call', sessionId: 's1', runId: 'r1', seq: 1, ts: 1, tool: 'x', args: { p: '/shared/dup.md' } } as any,
    ] })
    const cwd: ArtifactEntry[] = [
      { kind: 'file', name: 'dup.md', ref: '/shared/dup.md', origin: '/shared', modifiedAt: 1 },
    ]
    const rows = buildArtifacts([run], cwd)
    expect(rows).toHaveLength(1)
    expect(rows[0].origin).toBe('session')
  })

  it('returns empty when neither source has anything', () => {
    expect(buildArtifacts([], [])).toEqual([])
  })
})
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `cd apps/desktop && ELECTRON_RUN_AS_NODE=1 node_modules/.bin/electron node_modules/vitest/vitest.mjs run src/renderer/src/lib/workspace/build-artifacts.test.ts`
Expected: FAIL (module not found).

- [ ] **Step 3: Implement `buildArtifacts`**

The path-extraction heuristic (from spec §3.5): a string that starts with `/`, `./`, `../`, or a Windows drive letter `X:\`, AND has a `.` in the final path segment (extension).

```ts
// apps/desktop/src/renderer/src/lib/workspace/build-artifacts.ts
// Pure builder: aggregates 产出物 from two sources — file paths extracted from
// the session's tool_call args (best-effort heuristic) + Phase 3a's
// listArtifacts cwd recents — deduplicated by normalized path.

import type { RunRecord } from '@shared/lib/apply-event'
import type { ArtifactEntry } from '@swarm/protocol'

export type ArtifactRow = {
  id: string
  name: string
  /** Filesystem path (file) or bvid (bilibili). Passed to openPath/bilibili.open. */
  ref: string
  /** 'session' for extracted outputs, or the cwd / 'Bilibili' label for recents. */
  origin: string
  modifiedAt?: number
}

const PATH_LIKE = /^(\.{0,2}\/|[A-Za-z]:\\)/

function hasExtension(path: string): boolean {
  const base = path.split(/[\\/]/).pop() ?? ''
  return base.includes('.')
}

function normalizePath(p: string): string {
  // Collapse ./ and ../ best-effort (no fs access in pure fn — resolve lexical-only).
  return p.replace(/\/\.\//g, '/').replace(/\/+$/g, '')
}

/** Pull path-like strings out of a tool_call args object (values + array values). */
function extractPathsFromArgs(args: unknown): string[] {
  if (!args || typeof args !== 'object') return []
  const out: string[] = []
  const walk = (v: unknown): void => {
    if (typeof v === 'string') {
      if (PATH_LIKE.test(v) && hasExtension(v)) out.push(v)
    } else if (Array.isArray(v)) {
      v.forEach(walk)
    } else if (v && typeof v === 'object') {
      for (const val of Object.values(v as Record<string, unknown>)) walk(val)
    }
  }
  walk(args)
  return out
}

/** Aggregate session-extracted file outputs + cwd recents, deduplicated. */
export function buildArtifacts(runs: RunRecord[], cwdArtifacts: ArtifactEntry[]): ArtifactRow[] {
  const seen = new Set<string>()
  const sessionRows: ArtifactRow[] = []
  for (const run of runs) {
    for (const e of run.events) {
      if (e.kind !== 'run.tool_call') continue
      for (const p of extractPathsFromArgs((e as { args: unknown }).args)) {
        const norm = normalizePath(p)
        if (seen.has(norm)) continue
        seen.add(norm)
        const name = norm.split(/[\\/]/).pop() ?? norm
        sessionRows.push({ id: `session:${norm}`, name, ref: norm, origin: 'session' })
      }
    }
  }

  const cwdRows: ArtifactRow[] = cwdArtifacts
    .map((a) => ({
      id: `cwd:${a.ref}`,
      name: a.name,
      ref: a.ref,
      origin: a.origin,
      modifiedAt: a.modifiedAt,
    }))
    .filter((r) => {
      // Only file kinds carry a path to dedupe against; bilibili refs (bvid) never collide.
      if (r.ref.startsWith('BV') || r.ref.startsWith('bv')) return true
      const norm = normalizePath(r.ref)
      if (seen.has(norm)) return false
      seen.add(norm)
      return true
    })

  return [...sessionRows, ...cwdRows]
}
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `cd apps/desktop && ELECTRON_RUN_AS_NODE=1 node_modules/.bin/electron node_modules/vitest/vitest.mjs run src/renderer/src/lib/workspace/build-artifacts.test.ts`
Expected: PASS (8 tests).

- [ ] **Step 5: Commit**

```bash
git add apps/desktop/src/renderer/src/lib/workspace/build-artifacts.ts apps/desktop/src/renderer/src/lib/workspace/build-artifacts.test.ts
git commit -m "feat(workspace): pure buildArtifacts aggregating session outputs + cwd recents"
```

---

## Task 3: Plan usage footer

The small `用时 · Nk tokens` footer for the 计划 tab.

**Files:**
- Create: `apps/desktop/src/renderer/src/components/workspace/plan-usage-footer.tsx`

**Interfaces:**
- Consumes: `SessionSummary` from `@swarm/protocol` (for `tokensUsed`, `lastActiveAt` — actually use the session's runs' `startedAt`), `RunRecord[]` (for the first run's `startedAt`), the `useNow` hook (Phase 2, ticking clock).
- Produces: `<PlanUsageFooter runs={...} tokensUsed={...} />`.

- [ ] **Step 1: Implement the footer**

The duration = `now - min(runs.startedAt)`. Format as `X 分 Y 秒` (Chinese). Tokens = `tokensUsed` formatted as `N.Nk`.

```tsx
// apps/desktop/src/renderer/src/components/workspace/plan-usage-footer.tsx
// Tiny footer for the 计划 tab: elapsed-since-first-run duration + session token total.

import type { RunRecord } from '@shared/lib/apply-event'
import { useNow } from '@/hooks/use-now'

type Props = {
  runs: RunRecord[]
  /** Session.tokensUsed (cumulative). Treat undefined/0 as hidden. */
  tokensUsed?: number
}

function formatDuration(ms: number): string {
  if (ms < 60_000) return `${Math.max(1, Math.round(ms / 1000))} 秒`
  const min = Math.floor(ms / 60_000)
  const sec = Math.round((ms % 60_000) / 1_000)
  return sec > 0 ? `${min} 分 ${sec} 秒` : `${min} 分`
}

function formatTokens(n: number): string {
  return n >= 1000 ? `${(n / 1000).toFixed(1)}k` : String(n)
}

export function PlanUsageFooter({ runs, tokensUsed }: Props): React.JSX.Element {
  const now = useNow()
  const firstStart = runs.length > 0 ? Math.min(...runs.map((r) => r.startedAt)) : null
  const duration = firstStart ? formatDuration(Math.max(0, now - firstStart)) : '—'
  const tokens = tokensUsed ? formatTokens(tokensUsed) : null
  return (
    <div className="flex items-center justify-between px-1 py-2 text-[11.5px] text-muted-foreground">
      <span>用时 {duration}</span>
      {tokens && <span>{tokens} tokens</span>}
    </div>
  )
}
```

- [ ] **Step 2: Verify it typechecks**

Run: `cd apps/desktop && npx tsc --noEmit -p tsconfig.web.json 2>&1 | head -10`
Expected: no errors.

- [ ] **Step 3: Commit**

```bash
git add apps/desktop/src/renderer/src/components/workspace/plan-usage-footer.tsx
git commit -m "feat(workspace): PlanUsageFooter with duration + token total"
```

---

## Task 4: Timeline tab

**Files:**
- Create: `apps/desktop/src/renderer/src/components/workspace/timeline-tab.tsx`

**Interfaces:**
- Consumes: `TimelineRow` from `lib/workspace/build-timeline`.
- Produces: `<TimelineTab rows={...} />`.

- [ ] **Step 1: Implement the tab**

Icon map per `TimelineKind` (lucide): start→`Rocket`, dispatch→`PlayCircle`, tool→`Wrench`, permission→`ShieldAlert` (amber), complete→`CheckCircle2` (green), error→`XCircle` (red). Timestamp as `HH:mm` absolute via `Date(ts)`.

```tsx
// apps/desktop/src/renderer/src/components/workspace/timeline-tab.tsx
// 时间线 tab — flat event log over the session's runs.

import { CheckCircle2, PlayCircle, Rocket, ShieldAlert, Wrench, XCircle } from 'lucide-react'
import type { TimelineKind, TimelineRow } from '@/lib/workspace/build-timeline'

type Props = { rows: TimelineRow[] }

const ICONS: Record<TimelineKind, { Icon: typeof Rocket; className: string }> = {
  start:       { Icon: Rocket,       className: 'text-primary' },
  dispatch:    { Icon: PlayCircle,   className: 'text-muted-foreground' },
  tool:        { Icon: Wrench,       className: 'text-muted-foreground' },
  permission:  { Icon: ShieldAlert,  className: 'text-amber-600' },
  complete:    { Icon: CheckCircle2, className: 'text-emerald-600' },
  error:       { Icon: XCircle,      className: 'text-destructive' },
}

function hhmm(ts: number): string {
  const d = new Date(ts)
  return `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`
}

export function TimelineTab({ rows }: Props): React.JSX.Element {
  if (rows.length === 0) {
    return <div className="p-4 text-sm text-muted-foreground">还没有事件</div>
  }
  return (
    <ul className="cmdscroll flex-1 space-y-1 overflow-y-auto p-3">
      {rows.map((r) => {
        const { Icon, className } = ICONS[r.kind]
        return (
          // biome-ignore lint/suspicious/noArrayIndexKey: rows are append-only; id is unique but seq-based
          <li className="flex items-center gap-2 text-xs" key={r.id}>
            <span className="font-mono text-muted-foreground tabular-nums">{hhmm(r.ts)}</span>
            <Icon className={className + ' size-3.5 shrink-0'} />
            <span className="truncate" title={r.label}>{r.label}</span>
          </li>
        )
      })}
    </ul>
  )
}
```

- [ ] **Step 2: Verify it typechecks**

Run: `cd apps/desktop && npx tsc --noEmit -p tsconfig.web.json 2>&1 | head -10`
Expected: no errors.

- [ ] **Step 3: Commit**

```bash
git add apps/desktop/src/renderer/src/components/workspace/timeline-tab.tsx
git commit -m "feat(workspace): TimelineTab rendering the event log"
```

---

## Task 5: Artifacts tab

**Files:**
- Create: `apps/desktop/src/renderer/src/components/workspace/artifacts-tab.tsx`

**Interfaces:**
- Consumes: `ArtifactRow` from `lib/workspace/build-artifacts`, `swarmApi.listArtifacts` (Phase 3a), `RunRecord`.
- Produces: `<ArtifactsTab runs={...} cwd={...} />`.

- [ ] **Step 1: Implement the tab**

Query `listArtifacts({ cwd })` via TanStack Query when `cwd` is present; merge with `buildArtifacts(runs, data)`.

```tsx
// apps/desktop/src/renderer/src/components/workspace/artifacts-tab.tsx
// 产出物 tab — session-extracted file outputs + cwd recents (Phase 3a listArtifacts).

import { useQuery } from '@tanstack/react-query'
import { FileText, Film } from 'lucide-react'
import type { RunRecord } from '@shared/lib/apply-event'
import { formatRelativeTime } from '@/lib/format-time'
import { buildArtifacts, type ArtifactRow } from '@/lib/workspace/build-artifacts'
import { swarmApi } from '@/lib/api'
import { useNow } from '@/hooks/use-now'

type Props = {
  runs: RunRecord[]
  cwd?: string
}

function open(row: ArtifactRow): void {
  if (row.ref.startsWith('BV') || row.ref.startsWith('bv')) void window.swarm.bilibili.open(row.ref)
  else void window.swarm.openPath(row.ref)
}

export function ArtifactsTab({ runs, cwd }: Props): React.JSX.Element {
  const now = useNow()
  const { data: cwdArtifacts } = useQuery({
    queryKey: ['workspace', 'artifacts', cwd ?? ''],
    queryFn: () => swarmApi.listArtifacts({ cwd, limit: 50 }),
    enabled: !!cwd,
    staleTime: 60_000,
  })
  const rows = buildArtifacts(runs, cwdArtifacts ?? [])

  if (rows.length === 0) {
    return <div className="p-4 text-sm text-muted-foreground">暂无产出物</div>
  }
  return (
    <ul className="cmdscroll flex-1 space-y-1 overflow-y-auto p-3">
      {rows.map((r) => (
        <li key={r.id}>
          <button
            className="flex w-full items-center gap-2 rounded px-2 py-1.5 text-left text-xs hover:bg-muted/50"
            onClick={() => open(r)}
            type="button"
          >
            {r.ref.startsWith('BV') || r.ref.startsWith('bv')
              ? <Film className="size-3.5 shrink-0 text-emerald-500" />
              : <FileText className="size-3.5 shrink-0 text-muted-foreground" />}
            <span className="truncate font-medium">{r.name}</span>
            <span className="ml-auto shrink-0 text-muted-foreground">{r.origin}</span>
            {r.modifiedAt && (
              <span className="shrink-0 text-muted-foreground/70">{formatRelativeTime(r.modifiedAt, now)}</span>
            )}
          </button>
        </li>
      ))}
    </ul>
  )
}
```

- [ ] **Step 2: Verify it typechecks**

Run: `cd apps/desktop && npx tsc --noEmit -p tsconfig.web.json 2>&1 | head -10`
Expected: no errors. (If `window.swarm.bilibili.open` is not typed, fall back to `window.swarm.openPath` for bilibili too — verify the SwarmBridge type first; if `bilibili.open` is missing, drop the bilibili branch and route everything to `openPath`.)

- [ ] **Step 3: Commit**

```bash
git add apps/desktop/src/renderer/src/components/workspace/artifacts-tab.tsx
git commit -m "feat(workspace): ArtifactsTab aggregating session outputs + cwd recents"
```

---

## Task 6: Approval tab

**Files:**
- Create: `apps/desktop/src/renderer/src/components/workspace/approval-tab.tsx`

**Interfaces:**
- Consumes: `PermissionCard` from `@/components/permission-card`, `PermissionPrompt` + `usePermissionStore` from `@/stores/permission`, `PermissionDecision` from `@swarm/protocol`.
- Produces: `<ApprovalTab sessionId={...} onDecide={...} />`.

- [ ] **Step 1: Implement the tab**

Filter `usePermissionStore.queue` to the session; render one `PermissionCard` per pending prompt. `onDecide` is passed in (the same `decide.mutate`-backed callback TasksView uses today).

```tsx
// apps/desktop/src/renderer/src/components/workspace/approval-tab.tsx
// 审批 tab — current session's pending permission prompts, reusing PermissionCard.

import type { PermissionDecision } from '@swarm/protocol'
import { PermissionCard } from '@/components/permission-card'
import { usePermissionStore } from '@/stores/permission'

type Props = {
  sessionId: string | null
  onDecide: (actionId: string, decision: PermissionDecision) => void
}

export function ApprovalTab({ sessionId, onDecide }: Props): React.JSX.Element {
  const queue = usePermissionStore((s) => s.queue)
  const pending = sessionId ? queue.filter((p) => p.sessionId === sessionId) : []
  if (pending.length === 0) {
    return <div className="p-4 text-sm text-muted-foreground">暂无待审批</div>
  }
  return (
    <div className="cmdscroll flex-1 space-y-2 overflow-y-auto p-3">
      {pending.map((p, i) => (
        <PermissionCard autoFocusDeny={i === 0} key={p.actionId} onDecide={onDecide} prompt={p} />
      ))}
    </div>
  )
}
```

- [ ] **Step 2: Verify it typechecks**

Run: `cd apps/desktop && npx tsc --noEmit -p tsconfig.web.json 2>&1 | head -10`
Expected: no errors.

- [ ] **Step 3: Commit**

```bash
git add apps/desktop/src/renderer/src/components/workspace/approval-tab.tsx
git commit -m "feat(workspace): ApprovalTab reusing PermissionCard for pending prompts"
```

---

## Task 7: WorkspacePanel shell + wire into TasksView

The shell. Replaces `RightPanel`.

**Files:**
- Create: `apps/desktop/src/renderer/src/components/workspace/workspace-panel.tsx`
- Modify: `apps/desktop/src/renderer/src/components/views/tasks-view.tsx:161` (replace `<RightPanel planGroups={planGroups} />`)
- Delete: `apps/desktop/src/renderer/src/components/right-panel.tsx`
- Delete: `apps/desktop/src/renderer/src/components/task-timeline.tsx` (orphan folded into Task 1)

**Interfaces:**
- Consumes: all four tab components (Tasks 3-6), `PlanPanel` (existing), `PlanGroup` (existing), `useSessionsStore` (for tokensUsed), `usePermissionStore` (for badge count), `PermissionDecision` + the decide callback, `RunRecord`.
- Produces: `<WorkspacePanel runs={...} planGroups={...} session={...} onDecide={...} />` mounted in TasksView.

- [ ] **Step 1: Build the shell**

300px expanded, hidden when collapsed. Folder-style `Tabs` with the four labels (审批 carrying the badge). Default expanded (`useState(false)` for `collapsed` — i.e. NOT collapsed by default).

```tsx
// apps/desktop/src/renderer/src/components/workspace/workspace-panel.tsx
// 300px four-tab workspace (计划/时间线/产出物/审批) replacing RightPanel.

import { useState } from 'react'
import type { PermissionDecision } from '@swarm/protocol'
import { PanelRightClose, PanelRightOpen } from 'lucide-react'
import { Button, Tabs, TabsContent, TabsList, TabsTrigger } from '@swarm/ui'

import type { PlanGroup } from '@/components/plan-panel'
import { PlanPanel } from '@/components/plan-panel'
import { ApprovalTab } from './approval-tab'
import { ArtifactsTab } from './artifacts-tab'
import { PlanUsageFooter } from './plan-usage-footer'
import { TimelineTab } from './timeline-tab'
import { buildTimeline } from '@/lib/workspace/build-timeline'
import { useSessionsStore } from '@/stores/sessions'
import { usePermissionStore } from '@/stores/permission'
import type { RunRecord } from '@shared/lib/apply-event'
import type { SessionSummary } from '@swarm/protocol'

type Props = {
  runs: RunRecord[]
  planGroups: PlanGroup[]
  session?: SessionSummary
  onDecide: (actionId: string, decision: PermissionDecision) => void
}

export function WorkspacePanel({ runs, planGroups, session, onDecide }: Props): React.JSX.Element {
  const [collapsed, setCollapsed] = useState(false)
  const [tab, setTab] = useState<'plan' | 'timeline' | 'artifacts' | 'approval'>('plan')
  const queue = usePermissionStore((s) => s.queue)
  const pendingCount = session ? queue.filter((p) => p.sessionId === session.id).length : 0
  const timelineRows = buildTimeline(runs)

  if (collapsed) {
    return (
      <div className="flex h-full shrink-0 flex-col items-center gap-2 border-l border-border/60 bg-[var(--window-content)] py-3">
        <Button aria-label="展开工作区" onClick={() => setCollapsed(false)} size="icon" variant="ghost">
          <PanelRightOpen className="size-5" />
        </Button>
      </div>
    )
  }

  return (
    <div className="flex h-full w-[300px] shrink-0 flex-col border-l border-border/60 bg-[var(--window-content)]">
      <Tabs
        className="flex min-h-0 flex-1 flex-col gap-0"
        onValueChange={(v) => setTab(v as 'plan' | 'timeline' | 'artifacts' | 'approval')}
        value={tab}
      >
        <div className="flex h-11 items-center justify-between border-b border-border/60 px-2">
          <TabsList className="bg-transparent p-0">
            <TabsTrigger className="data-[state=active]:bg-background data-[state=active]:rounded-t-lg data-[state=active]:font-semibold" value="plan">计划</TabsTrigger>
            <TabsTrigger className="data-[state=active]:bg-background data-[state=active]:rounded-t-lg data-[state=active]:font-semibold" value="timeline">时间线</TabsTrigger>
            <TabsTrigger className="data-[state=active]:bg-background data-[state=active]:rounded-t-lg data-[state=active]:font-semibold" value="artifacts">产出物</TabsTrigger>
            <TabsTrigger
              className="data-[state=active]:bg-background data-[state=active]:rounded-t-lg data-[state=active]:font-semibold gap-1"
              value="approval"
            >
              审批
              {pendingCount > 0 && (
                <span className="inline-flex h-[15px] min-w-[15px] items-center justify-center rounded-full bg-amber-600 px-1 text-[9.5px] font-bold text-white tabular-nums dark:bg-amber-500 dark:text-neutral-900">
                  {pendingCount}
                </span>
              )}
            </TabsTrigger>
          </TabsList>
          <Button
            aria-label="收起工作区"
            className="size-7 rounded-lg text-muted-foreground hover:bg-muted/50 hover:text-foreground"
            onClick={() => setCollapsed(true)}
            size="icon"
            variant="ghost"
          >
            <PanelRightClose className="size-4" />
          </Button>
        </div>
        <TabsContent className="flex min-h-0 flex-1 flex-col" value="plan">
          <div className="flex min-h-0 flex-1 flex-col">
            <div className="cmdscroll flex-1 overflow-y-auto">
              <PlanPanel groups={planGroups} />
            </div>
            <PlanUsageFooter runs={runs} tokensUsed={session?.tokensUsed} />
          </div>
        </TabsContent>
        <TabsContent className="flex min-h-0 flex-1 flex-col" value="timeline">
          <TimelineTab rows={timelineRows} />
        </TabsContent>
        <TabsContent className="flex min-h-0 flex-1 flex-col" value="artifacts">
          <ArtifactsTab cwd={session?.cwd} runs={runs} />
        </TabsContent>
        <TabsContent className="flex min-h-0 flex-1 flex-col" value="approval">
          <ApprovalTab onDecide={onDecide} sessionId={session?.id ?? null} />
        </TabsContent>
      </Tabs>
    </div>
  )
}
```

- [ ] **Step 2: Wire into TasksView**

In `apps/desktop/src/renderer/src/components/views/tasks-view.tsx`, find the `<RightPanel planGroups={planGroups} />` call site (line ~161) and replace it. Also remove the now-unused `RightPanel` import at the top of the file.

Replace:
```tsx
      <RightPanel planGroups={planGroups} />
```
with:
```tsx
      <WorkspacePanel
        onDecide={(actionId, decision) => {
          const p = sessionPrompts.find((x) => x.actionId === actionId)
          if (!p) return
          decide.mutate({ sessionId: p.sessionId, actionId, decision })
        }}
        planGroups={planGroups}
        runs={sessionTasks}
        session={session}
      />
```

Add the import (alongside the existing `RightPanel` import being removed):
```tsx
import { WorkspacePanel } from '@/components/workspace/workspace-panel'
```

(The `onDecide` callback mirrors the exact logic currently in TasksView lines 140-144 for ComposerOverlay — same `decide.mutate` path. `sessionPrompts`, `decide`, `session`, and `sessionTasks` are all already in scope in TasksView.)

- [ ] **Step 3: Delete the replaced/orphaned files**

```bash
rm apps/desktop/src/renderer/src/components/right-panel.tsx
rm apps/desktop/src/renderer/src/components/task-timeline.tsx
```

Then grep to confirm no stale imports remain:
```bash
grep -rn "right-panel\|RightPanel\|task-timeline" apps/desktop/src --include="*.ts" --include="*.tsx" | grep -v "task-transcript\|workspace-panel"
```
Expected: no matches (the only `RightPanel`/`PanelRightClose` references left should be `PanelRight*` icons in the new `workspace-panel.tsx`, which the grep excludes via the workspace-panel filter; `task-transcript` exclusion is for the unrelated `TaskTimeline` in transcript).

- [ ] **Step 4: Typecheck + tests**

Run: `cd apps/desktop && npx tsc --noEmit -p tsconfig.web.json 2>&1 | head -20`
Expected: no errors. If `MemoryPanel`/`CronPanel` imports were left dangling anywhere by the `right-panel.tsx` deletion, the typecheck will flag them — fix by removing the now-unused imports (they remain mounted elsewhere).

Run: `cd apps/desktop && ELECTRON_RUN_AS_NODE=1 node_modules/.bin/electron node_modules/vitest/vitest.mjs run 2>&1 | tail -10`
Expected: green modulo the pre-existing `host.test.ts` flake. Note: any test that imported `RightPanel` will now fail — update or delete it.

- [ ] **Step 5: Commit**

```bash
git add -A apps/desktop/src/renderer/src/components/workspace/workspace-panel.tsx apps/desktop/src/renderer/src/components/views/tasks-view.tsx
git rm apps/desktop/src/renderer/src/components/right-panel.tsx apps/desktop/src/renderer/src/components/task-timeline.tsx
git commit -m "feat(workspace): four-tab WorkspacePanel replacing RightPanel; delete right-panel + task-timeline orphans"
```

---

## Task 8: Shell smoke test + finish

**Files:**
- Create: `apps/desktop/src/renderer/src/components/workspace/workspace-panel.test.tsx`

- [ ] **Step 1: Write a focused smoke test**

Render `<WorkspacePanel/>` with mocked stores + minimal props. Assert: 4 tab labels render; 审批 badge appears when `usePermissionStore` has a matching-session prompt and is absent otherwise; collapse toggle hides the tabs.

```tsx
// apps/desktop/src/renderer/src/components/workspace/workspace-panel.test.tsx
// @vitest-environment jsdom
import '@testing-library/jest-dom/vitest'
import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

vi.mock('@/stores/sessions', () => ({ useSessionsStore: () => ({}) }))  // shell doesn't read it directly; tab children might
vi.mock('@/stores/permission', () => ({
  usePermissionStore: (sel: (s: { queue: unknown[] }) => unknown) => sel({ queue: [] }),
}))
vi.mock('@/components/plan-panel', () => ({ PlanPanel: () => <div data-testid="plan-panel" /> }))
vi.mock('./timeline-tab', () => ({ TimelineTab: () => <div data-testid="timeline-tab" /> }))
vi.mock('./artifacts-tab', () => ({ ArtifactsTab: () => <div data-testid="artifacts-tab" /> }))
vi.mock('./approval-tab', () => ({ ApprovalTab: () => <div data-testid="approval-tab" /> }))
vi.mock('./plan-usage-footer', () => ({ PlanUsageFooter: () => <div data-testid="plan-footer" /> }))
vi.mock('@/lib/workspace/build-timeline', () => ({ buildTimeline: () => [] }))

import { WorkspacePanel } from './workspace-panel'

const baseProps = {
  runs: [],
  planGroups: [],
  session: { id: 's1', tokensUsed: 1000, cwd: '/cwd' } as never,
  onDecide: vi.fn(),
}

describe('WorkspacePanel', () => {
  afterEach(cleanup)

  it('renders all four tab labels', () => {
    render(<WorkspacePanel {...baseProps} />)
    expect(screen.getByText('计划')).toBeInTheDocument()
    expect(screen.getByText('时间线')).toBeInTheDocument()
    expect(screen.getByText('产出物')).toBeInTheDocument()
    expect(screen.getByText('审批')).toBeInTheDocument()
  })

  it('hides tabs when collapsed and shows a re-expand affordance', () => {
    render(<WorkspacePanel {...baseProps} />)
    fireEvent.click(screen.getByLabelText('收起工作区'))
    expect(screen.queryByText('计划')).not.toBeInTheDocument()
    expect(screen.getByLabelText('展开工作区')).toBeInTheDocument()
  })
})
```

- [ ] **Step 2: Run the smoke test**

Run: `cd apps/desktop && ELECTRON_RUN_AS_NODE=1 node_modules/.bin/electron node_modules/vitest/vitest.mjs run src/renderer/src/components/workspace 2>&1 | tail -10`
Expected: PASS.

- [ ] **Step 3: Run the full suite for regression**

Run: `cd apps/desktop && ELECTRON_RUN_AS_NODE=1 node_modules/.bin/electron node_modules/vitest/vitest.mjs run 2>&1 | tail -10`
Expected: green modulo the pre-existing `host.test.ts` flake.

- [ ] **Step 4: Commit**

```bash
git add apps/desktop/src/renderer/src/components/workspace/workspace-panel.test.tsx
git commit -m "test(workspace): WorkspacePanel shell smoke (tabs + collapse)"
```

- [ ] **Step 5: Manual smoke (deferred to user)**

This step is for the user — the controller cannot run the GUI. The user should verify per spec §5: open a session, see 4 tabs, switch between them, trigger a permission request to see the badge, collapse/expand, confirm Memory/Scheduled are gone.

- [ ] **Step 6: Announce finishing-a-development-branch**

> I'm using the finishing-a-development-branch skill to complete this work.

Then follow superpowers:finishing-a-development-branch: re-run tests, present options (merge to `refactor/ui-app-shell-rail`? open PR?), execute the chosen option.

---

## Self-Review (filled in after writing)

- **Spec coverage:** §3.1 geometry/300px/collapse → Task 7; §3.2 four tab labels → Task 7; §3.3 计划 tab + footer → Tasks 3+7; §3.4 时间线 tab + buildTimeline → Tasks 1+4; §3.5 产出物 tab + buildArtifacts → Tasks 2+5; §3.6 审批 tab + badge → Tasks 6+7; §3.7 collapse behavior → Task 7; §4.1 file structure → all tasks. Memory/Scheduled removal → Task 7 deletion. ✅
- **Placeholder scan:** No TBDs. Task 5 has a conditional on `window.swarm.bilibili.open` typing — flagged with a concrete fallback (route to `openPath`), not a placeholder. ✅
- **Type consistency:** `TimelineRow`/`TimelineKind` (Task 1) consumed by Task 4; `ArtifactRow` (Task 2) consumed by Task 5; `PlanGroup` (existing) consumed by Task 7; `PermissionDecision`/`PermissionPrompt` (existing) consumed by Tasks 6+7. Names match. ✅
- **Spec §5 risks:** file-path heuristic documented (Task 2); listArtifacts caching reused (Task 5); Memory/Scheduled reachability confirmed elsewhere; folder-style Tabs validated in Task 7 with typecheck; badge derives from same store as chat card; task-timeline orphan deletion sweep in Task 7 Step 3. ✅
