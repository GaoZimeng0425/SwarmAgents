# Home Dashboard Polish — Composer Chips + Spacing Rhythm + Empty States

**Status:** Approved (brainstorming complete)
**Date:** 2026-07-07
**Branch:** `worktree-dashboard-polish`
**Scope:** Three bounded polish passes on the home dashboard (`/`) to close the
gap with the design draft (`docs/design/首页 Dashboard.dc.html` + screenshots
`dash-fit.png` / `dashboard-full.png`): (1) composer control chips → pill chips,
(2) spacing / rhythm / radius consistency, (3) unified refined empty states.

Explicitly out of scope (deferred to their own rounds): topbar/app-shell nav,
统一命令台, Settings, Service Views.

---

## 1. Background

The dashboard chrome already largely matches the design; this is fidelity
polish, not a rebuild. Three concrete deltas remain, confirmed with the user:

1. **Composer chips** — the control row (cwd / team / permission / execution /
   model) renders as bare ghost buttons; the design shows compact **pill chips**
   (subtle rounded background, small padding, colored icon).
2. **Spacing / radius drift** — the dashboard mixes `rounded-2xl` (16px) and
   `rounded-xl` (12px) somewhat arbitrarily, and section rhythm (gaps, header
   margins, card padding) isn't on one scale.
3. **Empty states** — inconsistent: 进行中 uses a **dashed** box, 定时任务 /
   最近完成 use **solid** boxes; none has an icon. The design language wants one
   refined, consistent empty state.

Icon decision (recorded): the design draft uses emoji (📁🧊🛡). We keep the
**lucide** icon system instead — emoji render inconsistently across platforms and
the team/model chips are dynamic with no fixed emoji. "Colored" is delivered via
a per-category icon tint on a theme-aware pill, not emoji.

---

## 2. Area 1 — Composer Pill Chips (global, composer-private layer)

### 2.1 Where the styling lives (blast-radius rule)

The composer toolbar triggers are built from two composer-private wrappers in
`apps/desktop/src/renderer/src/components/ai-elements/prompt-input.tsx`:
- `PromptInputButton` (→ `@swarm/ui` `InputGroupButton`) — used by the `+` action
  menu and the **cwd** action-menu trigger.
- `PromptInputSelectTrigger` (→ `@swarm/ui` `SelectTrigger`) — used by the
  **team**, **permission**, **execution-mode**, and **model** selects.

`prompt-input.tsx` is imported **only** by `chat-input.tsx` (verified), so styling
these two wrappers is correctly scoped to "all composers" (the chosen global
scope) without touching the shared `InputGroupButton` / `SelectTrigger`
primitives, which are used app-wide and must **not** be restyled.

### 2.2 Chip geometry (from the design tokens)

A shared chip treatment applied to both wrappers' base `className`:

- Shape: `rounded-[10px]`, `px-2.5 py-1`, `gap-1.5`, `text-[12px]`, `font-medium`.
- Background: theme-aware subtle fill — `bg-muted/60` at rest, `hover:bg-muted`
  (NOT the design's hardcoded `rgba(255,255,255,.06)`, which only works in dark).
- Icon: lucide `size-3.5`, aligned; label truncates as today.
- The `+` action trigger stays icon-only (`size-icon-sm`) — it is an affordance,
  not a state chip; it gets the same pill background for visual unity but no label.

### 2.3 Colored icon tint (per category)

Each chip's icon carries a subtle, fixed tint so the row reads as "colored chips"
without fragile per-state emoji:

| Chip | Icon | Tint |
|---|---|---|
| Working dir | `Folder` | `text-muted-foreground` (neutral — path is neutral) |
| Team | `Users` | `text-indigo-500 dark:text-indigo-400` |
| Permission | (mode icon) | **by mode** (semantic): ask → `text-muted-foreground`; plan → `text-blue-500`; acceptEdits → `text-amber-500`; bypassPermissions → `text-red-500`. (Exact `PermissionMode` values + their existing icons pinned in the plan from the current select options.) |
| Execution mode | (goal/plan icon) | `text-muted-foreground` |
| Model | `Cpu` | `text-emerald-600 dark:text-emerald-400` |

The tint applies to the icon only; label text stays `text-foreground` /
`text-muted-foreground` as today. Applied at the chat-input trigger call sites
(icon `className`), since the tint is per-chip, while the pill geometry lives in
the two wrappers (shared).

### 2.4 Preserve behavior

The self-measuring **compact** collapse (icons-only when the row is too narrow),
the thinking-level slider, the action-menu contents, tooltips, and all callbacks
are unchanged. Only the trigger chrome (pill background + icon tint) changes.

---

## 3. Area 2 — Spacing / Rhythm / Radius Consistency (dashboard-local)

Touches `home-dashboard.tsx` and the five section components. No behavior change.

### 3.1 Radius scale (pick one, apply consistently)

- **Cards & card-like containers** (composer shell, weather strip, running cards,
  empty-state boxes, list wrappers): `rounded-2xl` (16px).
- **Inner list rows / small controls**: no independent radius (rows are flush
  inside the `rounded-2xl` list; only the list wrapper rounds).

Removes the current `rounded-xl` (12px) list wrappers → `rounded-2xl`, matching
the cards, so every dashboard surface shares one corner radius.

### 3.2 Section rhythm

- Outer container keeps `mx-auto w-full max-w-[1088px] px-6 py-5`; the inter-section
  gap standardizes to `gap-6` (currently `gap-7`) so all sections breathe evenly
  (composer → weather → 进行中 → 定时/最近 two-col).
- Every section header: `mb-3`, `font-semibold text-[13px] text-foreground`, with
  the count/link affordance right-aligned (`ml-auto`) — unify the four section
  headers (进行中 / 定时任务 / 最近完成 already close; align exactly, including the
  count-badge style `text-[12px] text-muted-foreground tabular-nums`).
- Card inner padding standardizes: cards `p-4`, list rows `px-4 py-3` (already the
  case in most; audit + align the outliers).

### 3.3 What does NOT change

The composer hero title (`text-[26px]`), the two-column `lg:grid-cols-2` layout,
and the running-cards `sm:grid-cols-2 lg:grid-cols-3` grid stay as-is.

---

## 4. Area 3 — Unified Refined Empty State (dashboard-local)

### 4.1 Shared component

New `apps/desktop/src/renderer/src/components/views/dashboard/dashboard-empty.tsx`:

```tsx
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

- Solid border + `bg-card` + `rounded-2xl` (kills the inconsistent dashed box).
- Centered muted lucide icon (`size-5`) + the existing copy.

### 4.2 Applied in the three sections

Replace the ad-hoc empty `<p>`/dashed boxes with `<DashboardEmpty>`:

- **进行中** (`running-cards.tsx`): icon `Inbox`; keep copy "暂无运行中的任务。从上方描述一个目标开始。"
- **定时任务** (`scheduled-list.tsx`): icon `CalendarClock`; keep copy "暂无定时任务。在「对话」中创建一个定时任务后会显示在这里。"
- **最近完成** (`recent-list.tsx`): icon `CheckCircle2`; keep copy "还没有完成的任务。完成的会话会显示在这里。"

Section headers still render above the empty state (unchanged).

---

## 5. Module Boundaries & Files

```
apps/desktop/src/renderer/src/components/ai-elements/prompt-input.tsx
  → PromptInputButton + PromptInputSelectTrigger: add shared pill-chip base class (Area 1)

apps/desktop/src/renderer/src/components/chat-input.tsx
  → per-chip icon tint className at the 5 trigger call sites (Area 1 §2.3)

apps/desktop/src/renderer/src/components/views/home-dashboard.tsx
  → gap-7 → gap-6 (Area 2 §3.2)

apps/desktop/src/renderer/src/components/views/dashboard/dashboard-empty.tsx  (NEW)
  → shared empty-state (Area 3)

apps/desktop/src/renderer/src/components/views/dashboard/running-cards.tsx
apps/desktop/src/renderer/src/components/views/dashboard/scheduled-list.tsx
apps/desktop/src/renderer/src/components/views/dashboard/recent-list.tsx
  → use DashboardEmpty; rounded-xl → rounded-2xl on list wrappers; header/padding align (Areas 2+3)

apps/desktop/src/renderer/src/components/views/dashboard/weather-card.tsx
  → radius audit only (already rounded-2xl; verify no drift)
```

---

## 6. Testing Strategy

This is visual polish; tests assert structure/props, not pixels.

| Layer | Test |
|---|---|
| `dashboard-empty.tsx` | Renders the icon + children text; is a single card container (no dashed border). |
| `running-cards.tsx` / `scheduled-list.tsx` / `recent-list.tsx` | Empty state renders `DashboardEmpty` with the right copy (existing empty-state tests, if any, updated; else add focused render tests). |
| `chat-input.tsx` | Existing tests must stay green (the compact-measuring + submit tests). Chip restyle is className-only — assert a representative trigger carries the chip class (light-touch) rather than snapshotting. |
| Manual | Build + run-desktop: composer chips read as pills with tinted icons; dashboard corners/gaps uniform; each empty state shows icon + copy in a solid card. Compare to `dash-fit.png`. |

recharts / jsdom caveats do not apply here (no charts touched). Renderer tests
use the `// @vitest-environment jsdom` pragma.

---

## 7. Out of Scope

- No change to composer behavior (compact logic, slider, submit, callbacks).
- No change to the shared `@swarm/ui` `InputGroupButton` / `SelectTrigger` (broad
  blast radius) — styling stays in the composer-private wrappers.
- No topbar/app-shell, 统一命令台, Settings, or Service Views work.
- No new dependencies.

---

## 8. Open Questions

None — icon system (lucide, not emoji), chip scope (global via composer-private
wrappers), radius scale (`rounded-2xl`), and per-category tints are all decided
above. Exact `PermissionMode` icon/color mapping is pinned in the plan from the
current select options.
