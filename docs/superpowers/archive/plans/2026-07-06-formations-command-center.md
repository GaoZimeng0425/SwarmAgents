# Formation Command Center (Phase 5) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Promote agent management out of the Settings modal into a first-level route `/formations` (编队命令中心): a full-page org tree with live "who's working" status, click-to-highlight delegation targets, and the existing detail/edit/CRUD surface relocated. The rail is reorganized per design; Settings → Agents is removed.

**Architecture:** The existing `OrgTree` (presentational, already exported from `org-tree-view.tsx`) + `AgentDetail` + `AgentFormSheet` + `DelegationLinks` are reused unchanged. The stateful wrapper `OrgTreeView` + the data-fetch/hot-reload logic from `agents-view.tsx` are relocated into a new `FormationsView` mounted at `/formations`, with selection/sheets lifted to that parent (the detail panel becomes a sibling column instead of an overlay Sheet). A new pure `buildAgentActivity(runs, sessions)` + `useAgentActivity()` hook feed the live status; the existing `buildDelegationEdges` drives the amber-ring highlight. The rail's 编队 entry changes from an action (opening Settings) to a route; Settings → Agents section is deleted (only `'agents'`, NOT weather's `'weather'`).

**Tech Stack:** React 19, TanStack Router (file-based) + Query, Zustand, `@swarm/ui` (Sheet/Tabs/AlertDialog), lucide-react, Tailwind v4, Vitest + @testing-library/react + jsdom.

---

## Global Constraints

(verbatim from spec §2026-07-06-formations-command-center-design — every task inherits these)

- **Org tree column:** `bg-background`, 52px header (`{N} 个 Agent` + `{activeCount} 正在工作` pill + `新建 Agent` button), scrollable body.
- **Detail panel:** `w-[328px] bg-secondary border-l border-border/60`, sibling column (NOT an overlay Sheet).
- **Live status:** running node = blue 5px dot + `运行中 · {task} · {n/m 步}` (text `text-[#3478f6]`, omit step part if no plan); idle = `空闲` muted. Header count pill only when `activeCount > 0`, dot has `shadow-[0_0_0_3px_rgba(52,120,246,.18)]` halo.
- **Delegation highlight:** selected agent's `buildDelegationEdges` outbound targets get amber ring (`ring-1 ring-amber-400/70` — already implemented in `AgentNodeCard`) + a `被「{X}」委派` line.
- **Rail (post-reorg):** scenes = 任务台/对话/编队(route)/日历; services = Gmail/trending/Bilibili; footer = 用量/设置. 编队 from `action` → `route '/formations'`. 自动化 removed. 用量 moves scenes → footer.
- **Copy rule:** user-facing strings Chinese (AGENTS.md §0). Code comments + commit messages English.
- **Tab/section labels verbatim:** 编队 (rail), 新建 Agent (button), 运行中/空闲/正在工作 (status).

### Deviations from spec (locked — do NOT "fix")

1. **Status colors use Tailwind tokens where possible.** Spec hardcodes `#3478f6` (macOS blue). Use `text-primary` for the running text/dot where it tracks the system accent; fall back to the literal `text-[#3478f6]` only where the design's specific blue is required for fidelity. The amber delegation ring already uses `ring-amber-400/70` in `AgentNodeCard` — keep that (don't repalce with the literal `rgba(226,176,107,.4)`).
2. **`PermissionCard` is reused as-is** (now has 4 actions including `grant_always` from the develop merge). Phase 5 does NOT touch it.
3. **Settings removal targets ONLY `'agents'`.** The weather branch added `'weather'` to `SettingsSection` + `SECTIONS`. Do NOT remove `'weather'`.
4. **No avatar/icon tile.** Nodes stay text-only (name + role id + chips).
5. **`AgentFormSheet` fields unchanged** (the `skills`/`thinkingLevel` gap is pre-existing, deferred).

### Branch

Already created: `feat/formations-command-center` off `develop` (`f67036c`, post UI-1-4 + weather + permission merges).

### File Structure (locked from spec §4.1)

**New:**
- `apps/desktop/src/renderer/src/routes/formations.tsx` — TanStack route stub.
- `apps/desktop/src/renderer/src/components/views/formations-view.tsx` — the page (state owner: selection, sheet, activity, delegation; renders OrgTree + detail column + AgentFormSheet).
- `apps/desktop/src/renderer/src/lib/formations/build-agent-activity.ts` — pure `buildAgentActivity`.
- `apps/desktop/src/renderer/src/hooks/use-agent-activity.ts` — `useAgentActivity()`.

**Modified:**
- `apps/desktop/src/renderer/src/components/views/org-tree-view.tsx` — `OrgTreeView` wrapper DELETED (relocated to `FormationsView`); `AgentNodeCard` gains an optional `activity` prop + status line. `OrgTree`/`OrgTreeNode` unchanged except threading `activity` through.
- `apps/desktop/src/renderer/src/components/rail-config.ts` — 编队 route change; 自动化 removed; 用量 moved scenes→footer-array (footer rendered in `app-rail.tsx`).
- `apps/desktop/src/renderer/src/components/app-rail.tsx` — drop the `runAction` special-case; add 用量 to footer.
- `apps/desktop/src/renderer/src/components/settings-dialog.tsx` — delete the `'agents'` SECTIONS entry + `AgentsView` + `Users` imports.
- `apps/desktop/src/renderer/src/stores/settings-dialog.ts` — delete `'agents'` from union + array.
- `apps/desktop/src/renderer/src/lib/palette/build-items.ts` — `cb.openSettings('agents')` → `cb.navigate('/formations')`.

**Deleted:**
- `apps/desktop/src/renderer/src/components/views/agents-view.tsx` (replaced by `formations-view.tsx`).

**Kept (relocated implicitly, file unchanged):**
- `agent-detail.tsx`, `agent-form-sheet.tsx`, `delegation-links.tsx`, `org-tree-view.tsx`'s `OrgTree`/`OrgTreeNode`/`AgentNodeCard`.

---

## Task 0: Branch & baseline

**Files:** none.

- [ ] **Step 1: Confirm branch + base**

```bash
git branch --show-current   # MUST be feat/formations-command-center
git log --oneline -1        # MUST be f67036c (develop merge tip) or a descendant
```

- [ ] **Step 2: Confirm spec's preconditions**

```bash
grep -c "OrgTreeView\|OrgTree " apps/desktop/src/renderer/src/components/views/org-tree-view.tsx   # OrgTree present
grep -c "buildDelegationEdges" packages/shared/src/agents/delegation.ts                            # ≥1
grep -c "'agents'" apps/desktop/src/renderer/src/stores/settings-dialog.ts                          # 2 (union + array)
```

- [ ] **Step 3: Green baseline**

Run: `cd apps/desktop && ELECTRON_RUN_AS_NODE=1 node_modules/.bin/electron node_modules/vitest/vitest.mjs run`
Expected: all green modulo the pre-existing `host.test.ts` EADDRINUSE:47777 flake (one environmental failure).

---

## Task 1: Pure `buildAgentActivity` builder

**Files:**
- Create: `apps/desktop/src/renderer/src/lib/formations/build-agent-activity.ts`
- Test: `apps/desktop/src/renderer/src/lib/formations/build-agent-activity.test.ts`

**Interfaces:**
- Consumes: `RunRecord` from `@shared/lib/apply-event`, `SessionSummary` from `@swarm/protocol`.
- Produces: `buildAgentActivity(runs, sessions): Map<string, AgentActivity>` + the `AgentActivity` type.

- [ ] **Step 1: Write the failing test**

```ts
// apps/desktop/src/renderer/src/lib/formations/build-agent-activity.test.ts
import { describe, expect, it } from 'vitest'
import type { RunRecord } from '@shared/lib/apply-event'
import type { SessionSummary } from '@swarm/protocol'
import { buildAgentActivity } from './build-agent-activity'

function mkRun(over: Partial<RunRecord> & Pick<RunRecord, 'id'>): RunRecord {
  return {
    sessionId: 's1', goal: 'do something', status: 'running', summary: null,
    startedAt: 1000, attachments: [], events: [], ...over,
  }
}
function mkSession(over: Partial<SessionSummary> & Pick<SessionSummary, 'id'>): SessionSummary {
  return {
    id: 's1', title: null, status: 'active', lastActiveAt: 1, taskCount: 0,
    pinned: false, sortOrder: 0, isSystem: false, ...over,
  }
}

describe('buildAgentActivity', () => {
  it('returns an empty map when no runs are active', () => {
    expect(buildAgentActivity([], [])).toEqual(new Map())
    expect(buildAgentActivity([mkRun({ id: 'r1', status: 'completed' })], [])).toEqual(new Map())
  })

  it('maps a sub-run (with agentDefId) to that agent id', () => {
    const runs = [mkRun({ id: 'r1', status: 'running', agentDefId: 'engineer', goal: '修复登录', startedAt: 100 })]
    const out = buildAgentActivity(runs, [])
    expect(out.get('engineer')).toMatchObject({ status: 'running', currentTask: '修复登录' })
  })

  it('maps a top-level run (no agentDefId) via the session agentType', () => {
    const runs = [mkRun({ id: 'r1', status: 'running', sessionId: 'sX', goal: '发布产品' })]
    const sessions = [mkSession({ id: 'sX', agentType: 'ceo' })]
    const out = buildAgentActivity(runs, sessions)
    expect(out.get('ceo')).toMatchObject({ status: 'running', currentTask: '发布产品' })
  })

  it('skips runs whose agent resolves to undefined', () => {
    const runs = [mkRun({ id: 'r1', status: 'running', sessionId: 'sX', goal: 'g' })]  // no agentDefId
    const sessions = [mkSession({ id: 'sX' })]  // no agentType
    expect(buildAgentActivity(runs, sessions)).toEqual(new Map())
  })

  it('keeps only pending/running; drops awaiting_user/completed/etc', () => {
    const runs = [
      mkRun({ id: 'r1', status: 'running', agentDefId: 'a' }),
      mkRun({ id: 'r2', status: 'pending', agentDefId: 'b' }),
      mkRun({ id: 'r3', status: 'awaiting_user', agentDefId: 'c' }),
      mkRun({ id: 'r4', status: 'completed', agentDefId: 'd' }),
    ]
    const out = buildAgentActivity(runs, [])
    expect([...out.keys()].sort()).toEqual(['a', 'b'])
  })

  it('stepProgress = "n/m 步" from the plan, counting completed only', () => {
    const runs = [mkRun({
      id: 'r1', status: 'running', agentDefId: 'engineer',
      plan: [
        { content: 'a', status: 'completed' },
        { content: 'b', status: 'in_progress' },
        { content: 'c', status: 'pending' },
      ],
    })]
    const out = buildAgentActivity(runs, [])
    expect(out.get('engineer')?.stepProgress).toBe('1/3 步')
  })

  it('omits stepProgress when the run has no plan', () => {
    const runs = [mkRun({ id: 'r1', status: 'running', agentDefId: 'a' })]
    expect(buildAgentActivity(runs, []).get('a')?.stepProgress).toBeUndefined()
  })

  it('truncates currentTask to 40 chars', () => {
    const long = 'x'.repeat(80)
    const runs = [mkRun({ id: 'r1', status: 'running', agentDefId: 'a', goal: long })]
    expect(buildAgentActivity(runs, []).get('a')?.currentTask).toBe('x'.repeat(37) + '…')
  })

  it('keeps only the newest active run per agent (max startedAt)', () => {
    const runs = [
      mkRun({ id: 'r1', status: 'running', agentDefId: 'a', goal: '旧的', startedAt: 100 }),
      mkRun({ id: 'r2', status: 'running', agentDefId: 'a', goal: '新的', startedAt: 500 }),
    ]
    expect(buildAgentActivity(runs, []).get('a')?.currentTask).toBe('新的')
  })
})
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd apps/desktop && ELECTRON_RUN_AS_NODE=1 node_modules/.bin/electron node_modules/vitest/vitest.mjs run src/renderer/src/lib/formations/build-agent-activity.test.ts`
Expected: FAIL (module not found).

- [ ] **Step 3: Implement `buildAgentActivity`**

```ts
// apps/desktop/src/renderer/src/lib/formations/build-agent-activity.ts
// Pure builder: resolves each active run to an agent id and aggregates the
// newest activity per agent. Sub-runs carry agentDefId; top-level runs resolve
// via their session's agentType.

import type { RunRecord } from '@shared/lib/apply-event'
import type { SessionSummary } from '@swarm/protocol'

export type AgentActivity = {
  status: 'running' | 'idle'
  /** Newest active run's goal, truncated to 40 chars. */
  currentTask?: string
  /** "n/m 步" from that run's plan; omitted when the run has no plan. */
  stepProgress?: string
}

const ACTIVE = new Set(['pending', 'running'])
const MAX_TASK = 40

function truncate(s: string): string {
  return s.length > MAX_TASK ? s.slice(0, MAX_TASK - 1) + '…' : s
}

function stepProgressOf(plan: { status: string }[] | undefined): string | undefined {
  if (!plan || plan.length === 0) return undefined
  const done = plan.filter((p) => p.status === 'completed').length
  return `${done}/${plan.length} 步`
}

/** Resolve the agent id for a run: agentDefId (sub-run) or session.agentType (top-level). */
function agentIdOf(run: RunRecord, sessionAgentBySession: Map<string, string | undefined>): string | undefined {
  return run.agentDefId ?? sessionAgentBySession.get(run.sessionId)
}

/** Build a Map<agentId, AgentActivity> from active runs. Idle agents are absent. */
export function buildAgentActivity(
  runs: RunRecord[],
  sessions: SessionSummary[],
): Map<string, AgentActivity> {
  const sessionAgent = new Map(sessions.map((s) => [s.id, s.agentType]))
  // Track the newest active run per agent.
  const newest = new Map<string, RunRecord>()
  for (const r of runs) {
    if (!ACTIVE.has(r.status)) continue
    const aid = agentIdOf(r, sessionAgent)
    if (!aid) continue
    const prev = newest.get(aid)
    if (!prev || r.startedAt > prev.startedAt) newest.set(aid, r)
  }
  const out = new Map<string, AgentActivity>()
  for (const [aid, r] of newest) {
    out.set(aid, {
      status: 'running',
      currentTask: truncate(r.goal),
      stepProgress: stepProgressOf(r.plan),
    })
  }
  return out
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `cd apps/desktop && ELECTRON_RUN_AS_NODE=1 node_modules/.bin/electron node_modules/vitest/vitest.mjs run src/renderer/src/lib/formations/build-agent-activity.test.ts`
Expected: PASS (9 tests).

- [ ] **Step 5: Commit**

```bash
git add apps/desktop/src/renderer/src/lib/formations/build-agent-activity.ts apps/desktop/src/renderer/src/lib/formations/build-agent-activity.test.ts
git commit -m "feat(formations): pure buildAgentActivity resolving runs to agents"
```

---

## Task 2: `useAgentActivity` hook

**Files:**
- Create: `apps/desktop/src/renderer/src/hooks/use-agent-activity.ts`

**Interfaces:**
- Consumes: `useRuns()` from `@/hooks/use-runs`, `useSessionsStore` from `@/stores/sessions`, `buildAgentActivity` (Task 1).
- Produces: `useAgentActivity(): Map<string, AgentActivity>`.

- [ ] **Step 1: Implement the hook**

```ts
// apps/desktop/src/renderer/src/hooks/use-agent-activity.ts
import { useMemo } from 'react'
import { buildAgentActivity } from '@/lib/formations/build-agent-activity'
import { useRuns } from '@/hooks/use-runs'
import { useSessionsStore } from '@/stores/sessions'

/** Live per-agent activity map, derived from all runs + sessions. */
export function useAgentActivity() {
  const runs = useRuns()
  const sessions = useSessionsStore((s) => s.sessions)
  return useMemo(() => buildAgentActivity(runs, sessions), [runs, sessions])
}
```

- [ ] **Step 2: Verify it typechecks**

Run: `cd apps/desktop && npx tsc --noEmit -p tsconfig.web.json 2>&1 | head -10`
Expected: no errors.

- [ ] **Step 3: Commit**

```bash
git add apps/desktop/src/renderer/src/hooks/use-agent-activity.ts
git commit -m "feat(formations): useAgentActivity hook"
```

---

## Task 3: Route stub + status-line plumbing into OrgTree

The smallest verifiable slice: create the `/formations` route, give `OrgTree` an `activity` prop, render a status line on each node card. No relocation yet — just the new prop + visual.

**Files:**
- Create: `apps/desktop/src/renderer/src/routes/formations.tsx`
- Modify: `apps/desktop/src/renderer/src/components/views/org-tree-view.tsx` — add `activity?: Map<string, AgentActivity>` to `OrgTree` + `OrgTreeNode` + `AgentNodeCard`; render the status line.

**Interfaces:**
- Consumes: `AgentActivity` from Task 1.
- Produces: `<OrgTree ... activity={map} />` accepts an optional activity map; `<FormationsView>` (Task 5) supplies it.

- [ ] **Step 1: Create the route stub**

```ts
// apps/desktop/src/renderer/src/routes/formations.tsx
import { createFileRoute } from '@tanstack/react-router'

import { FormationsView } from '@/components/views/formations-view'

export const Route = createFileRoute('/formations')({ component: FormationsView })
```

(If `FormationsView` doesn't exist yet, this will typecheck-fail until Task 5 — create a placeholder now in Step 2 of Task 5, OR temporarily point the route at a `<div>formations placeholder</div>` until Task 5 lands. Decision: point at a placeholder `<div>` for now; Task 5 swaps it for `FormationsView`.)

```ts
// apps/desktop/src/renderer/src/routes/formations.tsx — TEMPORARY until Task 5
import { createFileRoute } from '@tanstack/react-router'

export const Route = createFileRoute('/formations')({
  component: (): React.JSX.Element => <div className="p-8">formations placeholder</div>,
})
```

- [ ] **Step 2: Add the `activity` prop + status line to `AgentNodeCard`**

In `apps/desktop/src/renderer/src/components/views/org-tree-view.tsx`, modify `AgentNodeCard` (lines ~30-99). Import the activity type at the top:

```ts
import type { AgentActivity } from '@/lib/formations/build-agent-activity'
```

Add `activity?: AgentActivity` to the `AgentNodeCard` props (after `onDelete`), and render a status line inside the `<button>` block (after the chips `<div className="mt-1 flex flex-wrap items-center gap-1.5">...</div>`):

```tsx
{activity && activity.status === 'running' ? (
  <div className="mt-1 flex items-center gap-1.5 text-[11.5px] text-[#3478f6]">
    <span className="size-[5px] rounded-full bg-[#3478f6]" />
    <span>运行中 · {activity.currentTask}{activity.stepProgress ? ` · ${activity.stepProgress}` : ''}</span>
  </div>
) : (
  <div className="mt-1 text-[11.5px] text-muted-foreground">空闲</div>
)}
```

Thread `activity?: Map<string, AgentActivity>` through `OrgTreeNode` and `OrgTree` the same way `highlightedIds` is threaded: each looks up its own `activity?.get(node.agent.id)` and passes the single `AgentActivity | undefined` down to `AgentNodeCard`. (Don't pass the whole map down — resolve per node.)

Concretely in `OrgTreeNode` (lines ~104-149): add `activity?: Map<string, AgentActivity>` to props, compute `const nodeActivity = activity?.get(node.agent.id)`, pass `activity={nodeActivity}` to `<AgentNodeCard>`. Same in `OrgTree` (lines ~153-211) — it forwards `activity` to each `<OrgTreeNode>`.

- [ ] **Step 3: Verify it typechecks + existing tests pass**

Run: `cd apps/desktop && npx tsc --noEmit -p tsconfig.web.json 2>&1 | head -10`
Run: `cd apps/desktop && ELECTRON_RUN_AS_NODE=1 node_modules/.bin/electron node_modules/vitest/vitest.mjs run src/renderer/src/components/views 2>&1 | tail -8`
Expected: typecheck clean; existing org-tree-view tests pass (the new prop is optional).

- [ ] **Step 4: Commit**

```bash
git add apps/desktop/src/renderer/src/routes/formations.tsx apps/desktop/src/renderer/src/components/views/org-tree-view.tsx
git commit -m "feat(formations): /formations route stub + OrgTree activity status line"
```

---

## Task 4: Rail reorganization

Decouple this from the big Task 5 so it can ship + smoke independently.

**Files:**
- Modify: `apps/desktop/src/renderer/src/components/rail-config.ts`
- Modify: `apps/desktop/src/renderer/src/components/app-rail.tsx`

**Interfaces:**
- Produces: rail 编队 navigates to `/formations`; 自动化 gone; 用量 in footer.

- [ ] **Step 1: Reorganize `RAIL_SECTIONS` in `rail-config.ts`**

In `apps/desktop/src/renderer/src/components/rail-config.ts`:
- Delete the comment at lines ~48-49 ("Agents live inside the SettingsDialog today...").
- Change the 编队 item (line ~50) from `{ key: 'formation', label: '编队', icon: Network, target: { kind: 'action' } }` to `{ key: 'formation', label: '编队', icon: Network, target: { kind: 'route', to: '/formations', match: 'exact' } }`.
- Delete the 自动化 item (line ~57, the one with `key: 'automation'`, icon `Clock`).
- Delete the 用量 item from the scenes array (line ~58, `key: 'usage'`). It will be re-added in the footer (Task 4 Step 2).

After these edits the scenes array contains exactly 4 items: 任务台, 对话, 编队, 日历.

If `Clock` and `BarChart3` become unused imports after the deletions, remove them from the import block (lines ~6-16). Keep `Network` (still used by 编队).

- [ ] **Step 2: Add 用量 to the footer in `app-rail.tsx`**

In `apps/desktop/src/renderer/src/components/app-rail.tsx`:
- Add a 用量 tooltip block before the 设置 footer block (around line ~75). It uses `BarChart3` icon + `navigate({ to: '/usage' })`. Pattern mirrors the existing Settings tooltip:

```tsx
<Tooltip>
  <TooltipTrigger
    render={
      <button
        aria-label="用量"
        className={cn(iconBtn, isActive({ key: 'usage', label: '用量', icon: BarChart3, target: { kind: 'route', to: '/usage', match: 'exact' } }, location.pathname) && 'bg-accent')}
        onClick={() => navigate({ to: '/usage' })}
        type="button"
      >
        <BarChart3 />
      </button>
    }
  />
  <TooltipContent side="right">用量</TooltipContent>
</Tooltip>
```

(Alternatively, factor a small inline RailFooterButton helper to avoid the verbose isActive inline — but for one button the inline form is fine. The `cn` util is already imported in app-rail; verify. If `cn` is not imported, add `import { cn } from '@/lib/utils'`. Check existing imports first.)

- Add `BarChart3` to the lucide-react import (line ~10) if not already present.

- [ ] **Step 3: Drop the `runAction` special-case in `app-rail.tsx`**

Now that 编队 is a route, there are NO action items left in `RAIL_SECTIONS`. In `app-rail.tsx`:
- Delete the `runAction` function (lines ~23-26: `const runAction = (item: RailItem) => { if (item.key === 'formation') openSettings('agents') }`).
- Simplify `onClick` (lines ~28-36) to just the route branch:

```tsx
const onClick = (item: RailItem) => {
  if (item.target.kind !== 'route') return
  navigate({ to: item.target.to === '/session/' ? '/' : item.target.to })
}
```

(The `/session/` prefix→`/` fallback stays — it's still a prefix-match target.)

- Verify `openSettings` is still used (footer Settings button uses it) — keep the `useSettingsDialog` hook + destructure. Don't remove `openSettings`.

- [ ] **Step 4: Verify typecheck + smoke**

Run: `cd apps/desktop && npx tsc --noEmit -p tsconfig.web.json 2>&1 | head -10`
Run: `cd apps/desktop && ELECTRON_RUN_AS_NODE=1 node_modules/.bin/electron node_modules/vitest/vitest.mjs run src/renderer/src/components 2>&1 | tail -8`
Expected: typecheck clean; tests green.

- [ ] **Step 5: Commit**

```bash
git add apps/desktop/src/renderer/src/components/rail-config.ts apps/desktop/src/renderer/src/components/app-rail.tsx
git commit -m "feat(rail): 编队 → /formations route; drop 自动化; move 用量 to footer"
```

---

## Task 5: `FormationsView` + relocate OrgTreeView state

The largest task: create the new state-owning page, relocate the body of `OrgTreeView` + the data-fetch/hot-reload logic from `agents-view.tsx` into it, mount the detail as a sibling column (not a Sheet), and swap the route stub to the real view.

**Files:**
- Create: `apps/desktop/src/renderer/src/components/views/formations-view.tsx`
- Modify: `apps/desktop/src/renderer/src/components/views/org-tree-view.tsx` — DELETE the `OrgTreeView` wrapper + its imports + the `Sheet`/`SheetContent`/`SheetHeader`/`SheetTitle`/`AlertDialog*` imports that only it used. KEEP `OrgTree`/`OrgTreeNode`/`AgentNodeCard`.
- Modify: `apps/desktop/src/renderer/src/routes/formations.tsx` — swap the placeholder for `<FormationsView/>`.
- Delete: `apps/desktop/src/renderer/src/components/views/agents-view.tsx` (replaced).

**Interfaces:**
- Consumes: `OrgTree` (existing, presentational), `AgentDetail`, `AgentFormSheet`, `DelegationLinks` (all unchanged), `useAgentActivity` (Task 2), `useAgentMutations`, the agents query + `agents.changed` subscription (relocated from `agents-view.tsx`).
- Produces: `<FormationsView/>` mounted at `/formations`.

- [ ] **Step 1: Create `FormationsView`**

Combine the relocated state from `OrgTreeView` (selection/sheet/pendingDelete/error, `buildDelegationEdges`+`highlightedIds`, `toggle`/`selected`, `onSubmit`, `confirmDelete`) with the data layer from `agents-view.tsx` (`useQuery(['agents','settings'])`, `agents.changed` invalidate, `restoreDefaults`). Layout: header + a `flex` row of `<OrgTree flex-1>` + a `w-[328px]` detail `<aside>`. Detail shows `<AgentDetail>` + `<DelegationLinks>` (in a div, not a Sheet). The `AgentFormSheet` + delete `AlertDialog` render at the page root (portaled).

```tsx
// apps/desktop/src/renderer/src/components/views/formations-view.tsx
import { useEffect, useState } from 'react'
import { useQuery, useQueryClient } from '@tanstack/react-query'
import {
  AlertDialog, AlertDialogAction, AlertDialogCancel, AlertDialogContent,
  AlertDialogDescription, AlertDialogFooter, AlertDialogHeader, AlertDialogTitle,
  Button,
} from '@swarm/ui'
import type { AgentDefinition, AgentListItem } from '@swarm/protocol'
import { Plus } from 'lucide-react'
import { toast } from 'sonner'

import { AgentDetail } from './agent-detail'
import { AgentFormSheet } from './agent-form-sheet'
import { DelegationLinks } from './delegation-links'
import { OrgTree } from './org-tree-view'
import { useAgentActivity } from '@/hooks/use-agent-activity'
import { useAgentMutations } from '@/hooks/use-agent-mutations'
import { swarmApi } from '@/lib/api'
import { buildDelegationEdges } from '@swarm/shared'

type SheetState = { open: false } | { open: true; mode: 'create' | 'edit' | 'duplicate'; agent?: AgentListItem }

export function FormationsView(): React.JSX.Element {
  const queryClient = useQueryClient()
  const { save, remove, restoreDefaults } = useAgentMutations()
  const [restoring, setRestoring] = useState(false)
  const { data: agents, isLoading } = useQuery({
    queryKey: ['agents', 'settings'],
    queryFn: () => swarmApi.listAgents(),
    staleTime: 60_000,
  })
  const activity = useAgentActivity()

  // Hot-reload when agent files change on disk.
  useEffect(
    () =>
      swarmApi.subscribeEvents((e) => {
        if (e.kind === 'agents.changed') void queryClient.invalidateQueries({ queryKey: ['agents', 'settings'] })
      }),
    [queryClient],
  )

  const [selectedId, setSelectedId] = useState<string | null>(null)
  const [sheet, setSheet] = useState<SheetState>({ open: false })
  const [pendingDelete, setPendingDelete] = useState<AgentListItem | null>(null)
  const [error, setError] = useState<string | undefined>(undefined)

  const list = agents ?? []
  const edges = buildDelegationEdges(list)
  const highlightedIds = new Set(edges.filter((e) => e.from === selectedId).map((e) => e.to))
  const selected = selectedId ? list.find((a) => a.id === selectedId) : undefined
  const activeCount = activity.size

  const onSubmit = async (def: AgentDefinition): Promise<void> => {
    const r = await save(def)
    if (r.ok) {
      setSheet({ open: false })
      setError(undefined)
    } else {
      setError(r.message)
      toast.error(r.message)
    }
  }
  const confirmDelete = async (): Promise<void> => {
    if (!pendingDelete) return
    const r = await remove(pendingDelete.id)
    if (!r.ok) toast.error(r.message)
    setPendingDelete(null)
  }
  const onRestoreDefaults = async (): Promise<void> => {
    setRestoring(true)
    try { await restoreDefaults() } finally { setRestoring(false) }
  }

  if (isLoading) return <div className="p-8 text-muted-foreground text-sm">Loading agents…</div>

  return (
    <div className="flex h-full min-h-0 flex-col">
      {/* Header */}
      <div className="flex h-[52px] shrink-0 items-center justify-between border-b border-border/60 px-6">
        <div className="flex items-center gap-3">
          <h1 className="text-sm font-semibold">{list.length} 个 Agent</h1>
          {activeCount > 0 && (
            <span className="flex items-center gap-1.5 text-xs text-[#3478f6]">
              <span className="size-[6px] rounded-full bg-[#3478f6] shadow-[0_0_0_3px_rgba(52,120,246,.18)]" />
              {activeCount} 正在工作
            </span>
          )}
        </div>
        <div className="flex items-center gap-2">
          <Button disabled={restoring} onClick={onRestoreDefaults} size="sm" variant="outline">
            {restoring ? '恢复中…' : '恢复默认'}
          </Button>
          <Button className="gap-1.5" onClick={() => setSheet({ open: true, mode: 'create' })} size="sm">
            <Plus className="size-4" />
            新建 Agent
          </Button>
        </div>
      </div>

      {/* Body: tree + detail */}
      <div className="flex min-h-0 flex-1">
        <div className="cmdscroll min-w-0 flex-1 overflow-y-auto p-[22px_28px]">
          {list.length === 0 ? (
            <p className="text-muted-foreground text-sm">暂无 Agent。</p>
          ) : (
            <OrgTree
              activity={activity}
              agents={list}
              expanded={selectedId}
              highlightedIds={highlightedIds}
              onDelete={(a) => setPendingDelete(a)}
              onDuplicate={(a) => setSheet({ open: true, mode: 'duplicate', agent: a })}
              onEdit={(a) => setSheet({ open: true, mode: 'edit', agent: a })}
              onToggle={(id) => setSelectedId((prev) => (prev === id ? null : id))}
            />
          )}
        </div>

        {/* Detail column (sibling, NOT a Sheet) */}
        <aside className="cmdscroll w-[328px] shrink-0 overflow-y-auto border-l border-border/60 bg-secondary p-4">
          {selected ? (
            <>
              <AgentDetail agent={selected} />
              <DelegationLinks
                agentId={selected.id}
                agents={list}
                edges={edges}
                onSelect={(id) => setSelectedId(id)}
              />
            </>
          ) : (
            <p className="text-muted-foreground text-sm">选择一个 Agent 查看详情</p>
          )}
        </aside>
      </div>

      {/* Form sheet + delete dialog (portaled at page root) */}
      <AgentFormSheet
        agent={sheet.open ? sheet.agent : undefined}
        agents={list}
        error={error}
        mode={sheet.open ? sheet.mode : 'create'}
        onOpenChange={(o) => { if (!o) { setSheet({ open: false }); setError(undefined) } }}
        onSubmit={onSubmit}
        open={sheet.open}
      />
      <AlertDialog onOpenChange={(o) => !o && setPendingDelete(null)} open={pendingDelete !== null}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Delete agent "{pendingDelete?.name}"?</AlertDialogTitle>
            <AlertDialogDescription>This removes its AGENT.md from disk. This cannot be undone.</AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>Cancel</AlertDialogCancel>
            <AlertDialogAction onClick={() => void confirmDelete()}>Delete</AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </div>
  )
}
```

- [ ] **Step 2: Strip the `OrgTreeView` wrapper from `org-tree-view.tsx`**

Delete from `org-tree-view.tsx`:
- The `SheetState` type (~L213).
- The entire `OrgTreeView` function body (~L216-313).
- Imports now used only by that wrapper: `useState` (L1, IF nothing else in the file uses it — verify; `OrgTree`/`OrgTreeNode`/`AgentNodeCard` are stateless), `AgentListItem` (still used by the `OrgTree`/`OrgTreeNode`/`AgentNodeCard` prop types — KEEP), `buildDelegationEdges` (L3 — only the wrapper used it; the file still uses `buildOrgForest` + `OrgNode`, so keep those imports), the `@swarm/ui` Sheet/AlertDialog primitives (`Sheet, SheetContent, SheetHeader, SheetTitle`, AlertDialog*) + `Button` (L4-18) — UNLESS `AgentNodeCard` uses `Button` (it does, for the edit/duplicate/delete buttons at L81-95) — so KEEP `Button`; drop only the Sheet + AlertDialog primitives. The lucide icons `Copy, Pencil, Plus, Trash2` (L19): `Copy/Pencil/Trash2` are used by `AgentNodeCard` (KEEP); `Plus` was only the wrapper's "New Agent" button — drop it. `toast` (L20) — only the wrapper used it; drop. `useAgentMutations` (L22) — only the wrapper; drop. `AgentDetail/AgentFormSheet/DelegationLinks` (L24-26) — only the wrapper; drop.

After this, the file exports `OrgTree`, `OrgTreeNode`, `AgentNodeCard` and imports only what those need: `AgentDefinition, AgentListItem` types, `buildOrgForest, OrgNode` from shared, `cn`, `Button` + the activity type (added in Task 3), and `Copy/Pencil/Trash2` icons.

- [ ] **Step 3: Swap the route stub + delete `agents-view.tsx`**

`apps/desktop/src/renderer/src/routes/formations.tsx`:
```ts
import { createFileRoute } from '@tanstack/react-router'
import { FormationsView } from '@/components/views/formations-view'
export const Route = createFileRoute('/formations')({ component: FormationsView })
```

Delete `apps/desktop/src/renderer/src/components/views/agents-view.tsx`. (It's still imported by `settings-dialog.tsx` until Task 6 — that's fine, Task 6 removes the import. If typecheck fails here because settings-dialog still imports it, leave `agents-view.tsx` deletion for Task 6's final step. Decision: leave the file until Task 6, OR temporarily make it re-export from formations-view. Cleaner: do Task 5 + Task 6 together — but they're separate gates. Pragmatic call: leave `agents-view.tsx` alive but unused after Task 5; delete it as the LAST step of Task 6 once its last importer is gone.)

- [ ] **Step 4: Verify**

Run: `cd apps/desktop && npx tsc --noEmit -p tsconfig.web.json 2>&1 | head -20`
Run: `cd apps/desktop && ELECTRON_RUN_AS_NODE=1 node_modules/.bin/electron node_modules/vitest/vitest.mjs run src/renderer/src/components/views 2>&1 | tail -8`
Expected: typecheck clean; tests green (the old `org-tree-view.test.tsx` tests `OrgTreeView` — that export is gone, so the test must be updated/deleted. Read `org-tree-view.test.tsx`: if it tests `OrgTreeView` specifically, update it to test `OrgTree` with props instead, or delete the now-inapplicable cases.)

- [ ] **Step 5: Commit**

```bash
git add apps/desktop/src/renderer/src/components/views/formations-view.tsx apps/desktop/src/renderer/src/components/views/org-tree-view.tsx apps/desktop/src/renderer/src/routes/formations.tsx
git commit -m "feat(formations): FormationsView with relocated state + sibling detail column"
```

---

## Task 6: Settings → Agents removal + palette wiring + cleanup

**Files:**
- Modify: `apps/desktop/src/renderer/src/components/settings-dialog.tsx` — delete the `'agents'` SECTIONS entry + `AgentsView` + `Users` imports.
- Modify: `apps/desktop/src/renderer/src/stores/settings-dialog.ts` — delete `'agents'` from union + array.
- Modify: `apps/desktop/src/renderer/src/lib/palette/build-items.ts` — `cb.openSettings('agents')` → `cb.navigate('/formations')` (line ~102, the 新建编队 command).
- Delete: `apps/desktop/src/renderer/src/components/views/agents-view.tsx`.

**Interfaces:** none new.

- [ ] **Step 1: Remove the `'agents'` Settings section**

In `apps/desktop/src/renderer/src/components/settings-dialog.tsx`:
- Delete line ~44: `{ key: 'agents', label: 'Agents', icon: Users, View: AgentsView },`.
- Delete the `AgentsView` import (~L20: `import { AgentsView } from '@/components/views/agents-view'`).
- Delete `Users` from the lucide-react import block (L14) IF it's not used elsewhere in the file. Grep first: `grep -n "Users" settings-dialog.tsx`. If `Users` only appeared on the deleted line, drop it from imports.

In `apps/desktop/src/renderer/src/stores/settings-dialog.ts`:
- Delete `| 'agents'` (L14) from the `SettingsSection` union.
- Delete `'agents',` (L29) from the `SECTIONS` array.
- Do NOT touch `'weather'` (L10/L25).

- [ ] **Step 2: Wire the palette "新建编队" to `/formations`**

In `apps/desktop/src/renderer/src/lib/palette/build-items.ts`, line ~102:
```ts
run: () => cb.openSettings('agents'),
```
becomes:
```ts
run: () => cb.navigate('/formations'),
```
Optionally update the desc on L104 (`'在设置中创建新的 Agent 编队'` → `'创建新的 Agent 编队'`).

- [ ] **Step 3: Delete `agents-view.tsx`**

```bash
rm apps/desktop/src/renderer/src/components/views/agents-view.tsx
```

Grep to confirm zero importers remain:
```bash
grep -rn "agents-view\|AgentsView" apps/desktop/src --include="*.ts" --include="*.tsx" | grep -v "formations"
```
Expected: no matches (Task 6 Step 1 removed the only importer).

- [ ] **Step 4: Verify**

Run: `cd apps/desktop && npx tsc --noEmit -p tsconfig.web.json 2>&1 | head -20`
Run: `cd apps/desktop && ELECTRON_RUN_AS_NODE=1 node_modules/.bin/electron node_modules/vitest/vitest.mjs run 2>&1 | tail -10`
Expected: typecheck clean; full suite green modulo the pre-existing `host.test.ts` flake.

- [ ] **Step 5: Commit**

```bash
git rm apps/desktop/src/renderer/src/components/views/agents-view.tsx
git add apps/desktop/src/renderer/src/components/settings-dialog.tsx apps/desktop/src/renderer/src/stores/settings-dialog.ts apps/desktop/src/renderer/src/lib/palette/build-items.ts
git commit -m "feat(formations): remove Settings→Agents; palette 新建编队 → /formations"
```

---

## Task 7: Smoke test + finish

**Files:**
- Create: `apps/desktop/src/renderer/src/components/views/formations-view.test.tsx`

- [ ] **Step 1: Write a focused smoke test**

Render `<FormationsView/>` with mocked `swarmApi.listAgents` (return 2-3 agents forming a small tree), mocked `useAgentActivity` (return one active agent), mocked `useAgentMutations`. Assert:
- Header shows `N 个 Agent` + `1 正在工作` pill.
- Clicking an agent node selects it → detail column shows its name.
- Selecting an agent with outbound delegation edges lights up the target nodes (amber ring via `data-delegation-target="true"` — already asserted in existing org-tree tests; reuse the selector).

```tsx
// apps/desktop/src/renderer/src/components/views/formations-view.test.tsx
// @vitest-environment jsdom
import '@testing-library/jest-dom/vitest'
import { cleanup, fireEvent, render, screen, within } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'

vi.mock('@/lib/api', () => ({ swarmApi: { listAgents: vi.fn().mockResolvedValue([
  { id: 'ceo', name: 'CEO', description: 'd', systemPrompt: '', role: 'ceo' },
  { id: 'eng', name: 'Engineer', description: 'd', systemPrompt: 'Use find_agents({role:"reviewer"})', role: 'engineer', team: 'eng', parentId: 'ceo' },
  { id: 'rev', name: 'Reviewer', description: 'd', systemPrompt: '', role: 'reviewer', team: 'eng', parentId: 'ceo' },
]) } }))
vi.mock('@/hooks/use-agent-mutations', () => ({ useAgentMutations: () => ({ save: vi.fn(), remove: vi.fn(), restoreDefaults: vi.fn() }) }))
vi.mock('@/hooks/use-agent-activity', () => ({ useAgentActivity: () => new Map([['eng', { status: 'running', currentTask: '修复登录', stepProgress: '1/3 步' }]]) }))
vi.mock('@/hooks/use-runs', () => ({ useRuns: () => [], hydrateSession: vi.fn() }))
vi.mock('@/stores/sessions', () => ({ useSessionsStore: () => ({}) }))
vi.mock('sonner', () => ({ toast: { error: vi.fn() } }))

import { FormationsView } from './formations-view'

describe('FormationsView', () => {
  afterEach(cleanup)
  it('renders the agent count + active-count pill', async () => {
    render(<FormationsView />)
    expect(await screen.findByText(/3 个 Agent/)).toBeInTheDocument()
    expect(screen.getByText(/1 正在工作/)).toBeInTheDocument()
  })
  it('shows the running task on the active agent node', async () => {
    render(<FormationsView />)
    expect(await screen.findByText(/运行中 · 修复登录 · 1\/3 步/)).toBeInTheDocument()
  })
  it('selects a node on click and lights up its delegation target', async () => {
    render(<FormationsView />)
    const engineerBtn = await screen.findByRole('button', { name: /Edit Engineer/i })
    // Click the Engineer's name button (the card body, not the edit pencil)
    fireEvent.click(screen.getByText('Engineer'))
    // Reviewer should now carry the delegation-target marker
    const rev = screen.getByText('Reviewer').closest('[data-delegation-target]')
    expect(rev).toHaveAttribute('data-delegation-target', 'true')
  })
})
```

- [ ] **Step 2: Run the smoke + full suite**

Run: `cd apps/desktop && ELECTRON_RUN_AS_NODE=1 node_modules/.bin/electron node_modules/vitest/vitest.mjs run src/renderer/src/components/views/formations-view.test.tsx 2>&1 | tail -10`
Run: `cd apps/desktop && ELECTRON_RUN_AS_NODE=1 node_modules/.bin/electron node_modules/vitest/vitest.mjs run 2>&1 | tail -8`
Expected: smoke PASS; full suite green modulo pre-existing flake.

- [ ] **Step 3: Commit**

```bash
git add apps/desktop/src/renderer/src/components/views/formations-view.test.tsx
git commit -m "test(formations): FormationsView smoke (count, activity, delegation highlight)"
```

- [ ] **Step 4: Manual smoke (deferred to user)**

Per spec §5, the user verifies: rail 编队 navigates to `/formations`; selection populates detail + amber rings; live run lights a node; create/edit/delete flows; Settings has no Agents; palette 新建编队 → `/formations`; rail reorg (scenes 4 / services 3 / footer 2); dark mode.

- [ ] **Step 5: Announce finishing-a-development-branch**

> I'm using the finishing-a-development-branch skill to complete this work.

Then per superpowers:finishing-a-development-branch: re-run tests, present options (merge to `develop`? open PR?), execute choice.

---

## Self-Review (filled in after writing)

- **Spec coverage:** §3.1 geometry → Task 5; §3.2 org tree → Tasks 3+5 (OrgTree reused + activity status); §3.3 live status → Tasks 1+2+3 (buildAgentActivity + hook + render); §3.4 delegation highlight → Task 5 (highlightedIds from selectedId, reuses existing amber ring); §3.5 detail panel → Task 5 (sibling aside with AgentDetail+DelegationLinks); §3.6 edit drawer → Task 5 (AgentFormSheet relocated unchanged); §3.7 rail reorg → Task 4; Settings removal + palette → Task 6. ✅
- **Placeholder scan:** No TBDs. Task 3 Step 1 has a TEMPORARY placeholder route (intentional, swapped in Task 5 Step 3) — flagged in-band, not a hidden TODO. Task 5 Step 3 has a conditional decision on `agents-view.tsx` deletion timing (resolved: defer to Task 6) — explicit, not ambiguous. ✅
- **Type consistency:** `AgentActivity` (Task 1) consumed by Task 2 (hook) + Task 3 (OrgTree prop) + Task 5 (FormationsView); `Map<string, AgentActivity>` shape consistent. `SheetState` type moves verbatim from org-tree-view.tsx to formations-view.tsx (Task 5). `OrgTree` props in Task 3 match the existing signature plus the new `activity`. ✅
- **Spec §5 risks:** OrgTreeView split (Task 5) is invasive — mitigated by reusing the already-presentational `OrgTree` + lifting state mechanically; permission-card untouched (Deviation #2); weather section untouched (Deviation #3); automation grep in Task 4. ✅
