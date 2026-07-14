# Home Dashboard Polish Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Close three fidelity gaps with the design draft on the home dashboard — composer pill chips, a unified corner-radius/spacing rhythm, and one refined empty-state component.

**Architecture:** Composer chips are restyled in the two composer-private prompt-input wrappers (`PromptInputSelectTrigger`, `PromptInputActionMenuTrigger`) plus per-chip icon tints at the chat-input call sites — leaving the shared `@swarm/ui` primitives untouched. The dashboard sections adopt one radius (`rounded-2xl`) and a shared `<DashboardEmpty>` component.

**Tech Stack:** React 19, TypeScript, Tailwind, lucide-react, `cn` (tailwind-merge), Vitest + Testing Library (jsdom).

## Global Constraints

- **Language:** code comments + commit messages in **English**; UI copy stays Chinese (unchanged text).
- **No new dependencies.**
- **Icons:** lucide only (NOT emoji) — "colored" = per-category icon tint on a theme-aware pill.
- **Blast radius:** style the composer-private wrappers in `ai-elements/prompt-input.tsx` (imported ONLY by `chat-input.tsx`) and the chat-input call sites — NEVER the shared `@swarm/ui` `InputGroupButton` / `SelectTrigger`.
- **Preserve composer behavior:** the self-measuring compact collapse, thinking slider, submit, menus, tooltips, and all callbacks are unchanged. Chip changes are className-only.
- **Theme-aware:** subtle fills use tokens (`bg-muted/60`), never hardcoded `rgba(255,255,255,.x)`.
- **Radius scale:** all dashboard cards/containers = `rounded-2xl`; no `rounded-xl` list wrappers.
- **Desktop tests:** run scoped from `apps/desktop` as `npm test -- <path>` (NOT `npm test -- run <path>` — the script already ends in `run`; a 2nd `run` becomes a filename filter). Full suite = bare `npm test`. Renderer tests need `// @vitest-environment jsdom` on line 1.
- **Gate:** `apps/desktop` typecheck (`npm run typecheck`) + the touched test files green before completion. Never run pnpm/turbo at the worktree root.

---

### Task 1: Composer pill chips (wrappers + icon tints)

**Files:**
- Modify: `apps/desktop/src/renderer/src/components/ai-elements/prompt-input.tsx` (`PromptInputSelectTrigger` base ~line 1098-1108; `PromptInputActionMenuTrigger` ~line 1014-1018)
- Modify: `apps/desktop/src/renderer/src/components/chat-input.tsx` (icon tints at the team/permission/model triggers ~lines 458, 481, 512)
- Test: none new (className-only). Gate = existing `chat-input.test.tsx` + `chat-input.thinking.test.tsx` stay green + typecheck.

**Interfaces:**
- Consumes: nothing new.
- Produces: no API change — pure styling. `PromptInputSelectTrigger` / `PromptInputActionMenuTrigger` keep their prop types.

**Why no new test:** the change is CSS classNames only; the existing `chat-input.test.tsx` asserts the controls' text + folder-dialog behavior (工作目录/询问权限/目标模式/project/完全操作权限/计划模式), which must remain intact. A className snapshot would be brittle and low-value. Manual visual check is Task 4.

- [ ] **Step 1: Restyle the select-trigger wrapper to a resting pill**

In `prompt-input.tsx`, `PromptInputSelectTrigger` — change the first line of the `cn(...)` base from:

```
      'h-8 gap-1 rounded-md border-none bg-transparent px-2.5 font-medium text-muted-foreground shadow-none transition-colors',
```

to (resting muted fill + pill radius; hover line below is unchanged):

```
      'h-8 gap-1 rounded-[10px] border-none bg-muted/60 px-2.5 font-medium text-muted-foreground shadow-none transition-colors',
```

(Leave the existing `hover:bg-muted … aria-expanded:…`, dark-mode, and `[&>svg:last-child]:opacity-60` lines untouched.)

- [ ] **Step 2: Give the action-menu triggers the same pill**

In `prompt-input.tsx`, `PromptInputActionMenuTrigger` — wrap the passed className so the `+` and cwd triggers get the matching resting pill. `cn` is already imported in this file. Change:

```tsx
export const PromptInputActionMenuTrigger = ({ className, children, ...props }: PromptInputActionMenuTriggerProps) => (
  <DropdownMenuTrigger render={<PromptInputButton className={className} {...props} />}>
    {children ?? <PlusIcon className="size-4" />}
  </DropdownMenuTrigger>
)
```

to:

```tsx
export const PromptInputActionMenuTrigger = ({ className, children, ...props }: PromptInputActionMenuTriggerProps) => (
  <DropdownMenuTrigger
    render={<PromptInputButton className={cn('rounded-[10px] bg-muted/60 hover:bg-muted', className)} {...props} />}
  >
    {children ?? <PlusIcon className="size-4" />}
  </DropdownMenuTrigger>
)
```

- [ ] **Step 3: Add per-category icon tints in chat-input.tsx**

Ensure `cn` is imported at the top of `chat-input.tsx` (`import { cn } from '@/lib/utils'` — add it if missing). Then:

- Team trigger (~line 458): `<Users className="size-4" />` → `<Users className="size-4 text-indigo-500 dark:text-indigo-400" />`
- Permission trigger (~line 481): `<Shield className="size-4" />` → `<Shield className={cn('size-4', permissionMode === 'full' ? 'text-amber-500' : 'text-muted-foreground')} />`  (`permissionMode` is the in-scope prop; values are only `'ask'` | `'full'`.)
- Model trigger (~line 512, the `compact` branch): `<Cpu className="size-4" />` → `<Cpu className="size-4 text-emerald-600 dark:text-emerald-400" />`
- Leave the cwd `Folder` (in `ComposerCwdMenu`) and the `+` `PlusIcon` neutral (no tint) — they are neutral affordances per the spec.

Keep icon size at `size-4` (do NOT change to 3.5 — it would shift the compact-measuring baseline).

- [ ] **Step 4: Run the existing composer tests + typecheck**

Run (from `apps/desktop`):
`npm test -- src/renderer/src/components/chat-input.test.tsx src/renderer/src/components/chat-input.thinking.test.tsx`
Expected: PASS (all existing assertions intact).
Then `npm run typecheck` — Expected: clean.

- [ ] **Step 5: Commit**

```bash
git add apps/desktop/src/renderer/src/components/ai-elements/prompt-input.tsx apps/desktop/src/renderer/src/components/chat-input.tsx
git commit -m "feat(composer): pill chips with per-category icon tints"
```

---

### Task 2: `DashboardEmpty` shared component

**Files:**
- Create: `apps/desktop/src/renderer/src/components/views/dashboard/dashboard-empty.tsx`
- Test: `apps/desktop/src/renderer/src/components/views/dashboard/dashboard-empty.test.tsx`

**Interfaces:**
- Produces: `export function DashboardEmpty({ icon, children }: { icon: LucideIcon; children: React.ReactNode }): React.JSX.Element` — a solid `rounded-2xl` card with a centered muted icon + the children as copy. Consumed by Task 3.

- [ ] **Step 1: Write the failing test**

Create `dashboard-empty.test.tsx`:

```tsx
// @vitest-environment jsdom
import '@testing-library/jest-dom/vitest'
import { cleanup, render, screen } from '@testing-library/react'
import { Inbox } from 'lucide-react'
import { afterEach, describe, expect, it } from 'vitest'

import { DashboardEmpty } from './dashboard-empty'

afterEach(cleanup)

describe('DashboardEmpty', () => {
  it('renders the copy and a single solid card container (no dashed border)', () => {
    const { container } = render(<DashboardEmpty icon={Inbox}>暂无内容</DashboardEmpty>)
    expect(screen.getByText('暂无内容')).toBeInTheDocument()
    const card = container.firstElementChild as HTMLElement
    expect(card.className).toContain('rounded-2xl')
    expect(card.className).not.toContain('border-dashed')
  })
})
```

- [ ] **Step 2: Run test to verify it fails**

Run (from `apps/desktop`): `npm test -- src/renderer/src/components/views/dashboard/dashboard-empty.test.tsx`
Expected: FAIL — module not found.

- [ ] **Step 3: Create the component**

Create `dashboard-empty.tsx`:

```tsx
// Shared empty-state card for the dashboard sections: a solid rounded card with
// a centered muted icon and a single line of copy. Replaces the ad-hoc dashed /
// solid boxes the sections used before, so every empty state reads identically.
import type { LucideIcon } from 'lucide-react'

export function DashboardEmpty({
  icon: Icon,
  children,
}: {
  icon: LucideIcon
  children: React.ReactNode
}): React.JSX.Element {
  return (
    <div className="flex flex-col items-center gap-2 rounded-2xl border border-border bg-card px-4 py-8 text-center">
      <Icon aria-hidden="true" className="size-5 text-muted-foreground/70" />
      <p className="text-[13px] text-muted-foreground">{children}</p>
    </div>
  )
}
```

- [ ] **Step 4: Run test to verify it passes**

Run (from `apps/desktop`): `npm test -- src/renderer/src/components/views/dashboard/dashboard-empty.test.tsx`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add apps/desktop/src/renderer/src/components/views/dashboard/dashboard-empty.tsx apps/desktop/src/renderer/src/components/views/dashboard/dashboard-empty.test.tsx
git commit -m "feat(dashboard): shared DashboardEmpty component"
```

---

### Task 3: Apply empty state + unify radius/rhythm across sections

**Files:**
- Modify: `apps/desktop/src/renderer/src/components/views/dashboard/running-cards.tsx`
- Modify: `apps/desktop/src/renderer/src/components/views/dashboard/scheduled-list.tsx`
- Modify: `apps/desktop/src/renderer/src/components/views/dashboard/recent-list.tsx`
- Modify: `apps/desktop/src/renderer/src/components/views/home-dashboard.tsx` (gap-7 → gap-6)
- Test: `apps/desktop/src/renderer/src/components/views/dashboard/dashboard-sections.test.tsx` (new — empty-state render assertions)

**Interfaces:**
- Consumes: `DashboardEmpty` (Task 2).

- [ ] **Step 1: Write the failing test**

Create `dashboard-sections.test.tsx`:

```tsx
// @vitest-environment jsdom
import '@testing-library/jest-dom/vitest'
import { cleanup, render, screen } from '@testing-library/react'
import { afterEach, describe, expect, it } from 'vitest'
import { createMemoryHistory, createRootRoute, createRouter, RouterProvider } from '@tanstack/react-router'

import { RecentList } from './recent-list'
import { ScheduledList } from './scheduled-list'

// These sections call useNavigate(), so render them inside a minimal router.
function inRouter(ui: React.ReactNode) {
  const route = createRootRoute({ component: () => <>{ui}</> })
  const router = createRouter({ routeTree: route, history: createMemoryHistory({ initialEntries: ['/'] }) })
  return <RouterProvider router={router} />
}

afterEach(cleanup)

describe('dashboard section empty states', () => {
  it('ScheduledList empty renders the DashboardEmpty copy in a solid card', () => {
    const { container } = render(inRouter(<ScheduledList rows={[]} />))
    expect(screen.getByText(/暂无定时任务/)).toBeInTheDocument()
    expect(container.querySelector('.border-dashed')).toBeNull()
  })
  it('RecentList empty renders the DashboardEmpty copy', () => {
    render(inRouter(<RecentList now={Date.now()} rows={[]} />))
    expect(screen.getByText(/还没有完成的任务/)).toBeInTheDocument()
  })
})
```

(If rendering through the router proves heavy in this env, fall back to asserting `RunningCards` — which takes no router — for the empty copy + no `.border-dashed`; keep at least one section asserted per the two behaviors: copy present, no dashed border.)

- [ ] **Step 2: Run test to verify it fails**

Run (from `apps/desktop`): `npm test -- src/renderer/src/components/views/dashboard/dashboard-sections.test.tsx`
Expected: FAIL — the sections still render the old `<p>` boxes (running-cards uses `border-dashed`; assertions on `DashboardEmpty` copy container fail) or `border-dashed` still present.

- [ ] **Step 3: Swap each section's empty state to `DashboardEmpty` + unify radius**

**`running-cards.tsx`** — add `import { Inbox } from 'lucide-react'` and `import { DashboardEmpty } from './dashboard-empty'`. Replace the empty `<p className="... border-dashed ...">` with:

```tsx
        <DashboardEmpty icon={Inbox}>暂无运行中的任务。从上方描述一个目标开始。</DashboardEmpty>
```

**`scheduled-list.tsx`** — add `import { ArrowRight, CalendarClock } from 'lucide-react'` (merge with the existing `ArrowRight` import) and `import { DashboardEmpty } from './dashboard-empty'`. Replace the empty `<p>` with:

```tsx
        <DashboardEmpty icon={CalendarClock}>暂无定时任务。在「对话」中创建一个定时任务后会显示在这里。</DashboardEmpty>
```

Also change the populated list wrapper `<ul className="overflow-hidden rounded-xl border border-border bg-card">` → `rounded-2xl`.

**`recent-list.tsx`** — add `import { Check, CheckCircle2 } from 'lucide-react'` (merge with existing `Check`) and `import { DashboardEmpty } from './dashboard-empty'`. Replace the empty `<p>` with:

```tsx
        <DashboardEmpty icon={CheckCircle2}>还没有完成的任务。完成的会话会显示在这里。</DashboardEmpty>
```

Also change the populated list wrapper `<ul className="overflow-hidden rounded-xl border border-border bg-card">` → `rounded-2xl`.

- [ ] **Step 4: Unify section rhythm in home-dashboard.tsx**

In `home-dashboard.tsx`, the scroll container line — change `gap-7` → `gap-6`:

```
      <div className="mx-auto flex w-full max-w-[1088px] flex-1 flex-col gap-6 overflow-y-auto px-6 py-5">
```

- [ ] **Step 5: Run tests + typecheck**

Run (from `apps/desktop`): `npm test -- src/renderer/src/components/views/dashboard/dashboard-sections.test.tsx`
Expected: PASS.
Then `npm run typecheck` — Expected: clean.

- [ ] **Step 6: Commit**

```bash
git add apps/desktop/src/renderer/src/components/views/dashboard/running-cards.tsx apps/desktop/src/renderer/src/components/views/dashboard/scheduled-list.tsx apps/desktop/src/renderer/src/components/views/dashboard/recent-list.tsx apps/desktop/src/renderer/src/components/views/home-dashboard.tsx apps/desktop/src/renderer/src/components/views/dashboard/dashboard-sections.test.tsx
git commit -m "feat(dashboard): unified empty state + rounded-2xl + section rhythm"
```

---

### Task 4: Full verification + manual visual check

**Files:** none (verification only).

- [ ] **Step 1: Typecheck**

Run (from `apps/desktop`): `npm run typecheck` — Expected: clean. (If stale `.tsbuildinfo` lies, `find .. -name '*.tsbuildinfo' -not -path '*/node_modules/*' -delete` and re-run.)

- [ ] **Step 2: Full desktop suite (regression)**

Run (from `apps/desktop`): `npm test` (bare — full suite) — Expected: all pass (prior baseline 1324; +the new dashboard-empty + dashboard-sections tests).

- [ ] **Step 3: Lint touched files**

Run (from `apps/desktop`): `npx biome check --write src/renderer/src/components/ai-elements/prompt-input.tsx src/renderer/src/components/chat-input.tsx src/renderer/src/components/views/home-dashboard.tsx src/renderer/src/components/views/dashboard/`
Expected: no remaining diagnostics (info-level acceptable if pre-existing).

- [ ] **Step 4: Manual visual check (run-desktop skill)**

Build (`CI=true node_modules/.bin/electron-vite build` from `apps/desktop`) then launch via the run-desktop driver. On the home dashboard confirm: (a) the composer control row reads as pill chips with tinted icons (team indigo, model emerald, permission amber when 完全操作权限); (b) all cards/lists/empty states share the `rounded-2xl` corner; (c) each empty state (进行中/定时任务/最近完成) shows a centered muted icon + copy in a solid card. Compare against `docs/design/screenshots/dash-fit.png`.

- [ ] **Step 5: Commit any lint fixups**

```bash
git add -A && git commit -m "chore(dashboard): lint fixups" || echo "nothing to commit"
```

---

## Self-Review Notes

- **Spec coverage:** §2 composer chips → Task 1 (wrappers + tints, scope-correct); §3 spacing/radius → Task 3 (rounded-2xl on list wrappers + gap-6); §4 empty states → Tasks 2+3 (DashboardEmpty + apply). §6 testing → tests in Tasks 2/3 + existing composer tests kept green (Task 1) + full suite (Task 4).
- **Deviations from spec (recorded):** icon size stays `size-4` (spec §2.2 said 3.5) to preserve the compact-measuring baseline; permission tint uses the two real options (`ask`/`full`), not the fuller PermissionMode set the spec listed (composer only exposes those two). Execution-mode is NOT a chip (it lives in the `+` menu) — spec §2.3's table row for it is dropped.
- **Type consistency:** `DashboardEmpty({ icon, children })` signature identical in Task 2 (definition), Task 2 test, and Task 3 call sites. `icon` typed `LucideIcon`.
- **No placeholders:** every code step shows exact before/after strings. Task 1 has no new test by explicit, justified choice (className-only; existing behavior tests are the guard).
