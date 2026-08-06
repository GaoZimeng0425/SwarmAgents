# Permission Card Covers Composer — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** While at least one permission prompt is pending, the `PermissionCard`(s) cover the composer box (overlay + backdrop + disabled textarea) so no new message can be sent until the user resolves the top-most prompt.

**Architecture:** Split `ComposerOverlay`'s single in-flow root into two zones: a floating zone (`PlanStatusBar` + queued turns, unchanged in-flow behavior) and a cover zone (permission cards only) rendered as an absolutely-positioned layer with a dimming backdrop. Add a positioning context (`relative`) to `composerRef` in `ChatInput` so the cover anchors to the composer box. Lock the textarea via `disabled` as defense in depth, driven from `TasksView` where `sessionPrompts` already lives.

**Tech Stack:** React 19 + TypeScript, Tailwind utility classes, Vitest + @testing-library/react + jsdom. No new dependencies.

## Global Constraints

- **Conversation language:** Chinese. Code comments and commit messages: English only.
- **Surgical changes:** touch only the three files listed. No refactors, no restyle of adjacent code.
- **Tailwind utilities only** (matches all three target files); no CSS modules, no styled-components, no inline `style={{}}`.
- **Hero variant untouched:** `<ChatInput variant="hero" />` (home dashboard, session index) renders no overlay and must keep working with no visual regressions.
- **Out-of-scope content stays floating:** `PlanStatusBar` and queued-turn rows must keep today's "float above, do not cover" behavior.
- **No behavior change** to the four decision buttons or the `permission.skipTop` Escape binding.

---

## File Structure

| File | Responsibility | Change |
|---|---|---|
| `apps/desktop/src/renderer/src/components/composer-overlay.tsx` | Render pinned items (plan/queued/permissions) as ChatInput's overlay | Split single root into floating region + cover region |
| `apps/desktop/src/renderer/src/components/chat-input.tsx` | The composer; hosts `{overlay}` + `<PromptInput>` | Add `relative` positioning to `composerRef` |
| `apps/desktop/src/renderer/src/components/views/tasks-view.tsx` | Wires `ComposerOverlay` + `ChatInput`; owns `sessionPrompts` | Extend `disabled` to also lock when prompts pending |
| `apps/desktop/src/renderer/src/components/composer-overlay.test.tsx` | Existing + new tests for `ComposerOverlay` | Add cover-positioning assertions; existing tests stay green |

No new files. No type changes (all existing props/signatures are reused as-is).

---

## Task 1: Split ComposerOverlay into floating + cover zones

**Files:**
- Modify: `apps/desktop/src/renderer/src/components/composer-overlay.tsx`
- Test: `apps/desktop/src/renderer/src/components/composer-overlay.test.tsx`

**Interfaces:**
- Consumes: `PermissionPrompt` from `@/stores/permission` (unchanged); `PlanTodo` from `@swarm/protocol` (unchanged); `useCommandBindings` from `@/hooks/use-command-bindings` (unchanged).
- Produces: `ComposerOverlay` with identical props/signature — `ChatInput` and `TasksView` keep mounting it the same way. The only change is internal DOM structure (two regions instead of one in-flow column).

**Context the implementer needs:** Today the component returns a single `<div className="mb-2 flex flex-col gap-2">` containing plan bar, queued, and permission cards mixed together in one in-flow column — that's why it pushes the composer down instead of covering it. After this task, plan/queued stay in-flow (floating) but permission cards move into a separate `absolute inset-0` region (the cover). The `<>` fragment is fine because `ChatInput` mounts `{overlay}` directly inside `composerRef` with no wrapper constraints.

- [ ] **Step 1: Add failing test — permission cards render inside a positioned cover element**

Append to the `describe('ComposerOverlay', ...)` block in `composer-overlay.test.tsx`:

```tsx
  it('renders pending permission cards inside a positioned cover layer', () => {
    const { container } = render(
      <ComposerOverlay onDecide={() => {}} prompts={[prompt('a')]} running={false} todos={[]} />
    )
    // The cover layer is the absolute-positioned wrapper that overlays the
    // composer box. Its presence + positioning is what makes the card COVER
    // the input rather than float above it.
    const cover = container.querySelector('.cover-zone')
    expect(cover).not.toBeNull()
    expect(cover).toHaveClass('absolute', 'inset-0')
    expect(cover).toHaveTextContent('Action requires confirmation')
  })
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd apps/desktop && pnpm vitest run src/renderer/src/components/composer-overlay.test.tsx`
Expected: FAIL — `.cover-zone` not found (current implementation has no cover element).

- [ ] **Step 3: Add failing test — plan/queued render in a separate floating zone**

Append:

```tsx
  it('keeps the plan progress bar in a floating zone, not the cover zone', () => {
    const todos: PlanTodo[] = [{ content: 'first step', status: 'in_progress' }]
    const { container } = render(
      <ComposerOverlay onDecide={() => {}} prompts={[]} running todos={todos} />
    )
    const cover = container.querySelector('.cover-zone')
    expect(cover).toBeNull()
    const floating = container.querySelector('.floating-zone')
    expect(floating).not.toBeNull()
    expect(floating).toHaveTextContent('第 1/2 步')
  })
```

- [ ] **Step 4: Run test to verify it fails**

Run: `cd apps/desktop && pnpm vitest run src/renderer/src/components/composer-overlay.test.tsx`
Expected: FAIL — `.floating-zone` not found.

- [ ] **Step 5: Implement the split in `composer-overlay.tsx`**

Replace the existing `return` block (the whole `<div className="mb-2 flex flex-col gap-2">…</div>`) with the two-zone structure below. Update the JSDoc above the function to match.

New `return` (replaces lines ~58–86 of `composer-overlay.tsx`):

```tsx
  return (
    <>
      {/* Floating zone — informational (plan progress, queued turns). Stays
          in-flow above the composer; never covers the input. Renders nothing
          when empty so it takes no vertical space. */}
      {(planVisible || queued.length > 0) && (
        <div className="floating-zone mb-2 flex flex-col gap-2">
          <PlanStatusBar running={running} todos={todos} />
          {queued.map((q) => (
            <div
              className="flex items-center justify-between gap-2 rounded-xl border border-border bg-popover px-3 py-1.5 text-sm shadow-sm"
              key={q.id}
            >
              <span className="flex min-w-0 items-center gap-2">
                <span aria-hidden={true} className="text-muted-foreground">
                  ⏳
                </span>
                <span className="truncate">{q.prompt}</span>
              </span>
              <span className="flex shrink-0 items-center gap-1">
                <Button aria-label="打断" onClick={() => onInterrupt?.(q.id)} size="icon-sm" variant="ghost">
                  <ZapIcon className="size-4" />
                </Button>
                <Button aria-label="取消排队" onClick={() => onCancelQueued?.(q.id)} size="icon-sm" variant="ghost">
                  <XIcon className="size-4" />
                </Button>
              </span>
            </div>
          ))}
        </div>
      )}

      {/* Cover zone — pending permissions only. Absolute inset-0 over the
          composer box (anchored by `relative` on composerRef in ChatInput),
          with a dimming backdrop so the disabled input reads as locked. */}
      {prompts.length > 0 && (
        <div className="cover-zone absolute inset-0 z-10 flex flex-col gap-2 overflow-hidden rounded-xl bg-background/80 p-2 backdrop-blur-sm">
          {prompts.map((p, i) => (
            <PermissionCard autoFocusDeny={i === 0} key={p.actionId} onDecide={onDecide} prompt={p} />
          ))}
        </div>
      )}
    </>
  )
```

Update the JSDoc (lines ~22–30) to:

```tsx
/**
 * Pinned items for the composer, in two zones:
 *
 * - Floating zone (plan progress bar, queued turns): in-flow cards above the
 *   composer box, never covering it. Pure status/information.
 * - Cover zone (pending permissions): an absolute-positioned layer that
 *   overlays the composer box with a dimming backdrop, so while a permission
 *   decision is pending the input is visually and interactionally blocked.
 *   Anchored by `relative` on `composerRef` in ChatInput.
 *
 * Renders nothing when there is nothing to pin. Owned by ChatInput via its
 * `overlay` prop.
 */
```

- [ ] **Step 6: Run all tests in the file to verify they pass**

Run: `cd apps/desktop && pnpm vitest run src/renderer/src/components/composer-overlay.test.tsx`
Expected: PASS — all existing tests (renders nothing, stacks prompts, Escape skips top, plan bar while running, hides when not running, hides when all completed, queued cards) AND the two new tests pass.

If the existing "renders nothing when there are no prompts and no running plan" test now fails because the fragment returns a fragment instead of an empty container: that test uses `{ container } = render(...)` and `expect(container).toBeEmptyDOMElement()`. A `<>` fragment with no children renders nothing into the container, so this stays green — no change needed. If it does fail for any reason, the fix is structural in the component, not the test.

- [ ] **Step 7: Commit**

```bash
git add apps/desktop/src/renderer/src/components/composer-overlay.tsx apps/desktop/src/renderer/src/components/composer-overlay.test.tsx
git commit -m "feat(desktop): split ComposerOverlay into floating + cover zones

Plan progress and queued turns stay in an in-flow floating zone above the
composer; pending permission cards move into an absolute-positioned cover
zone with a dimming backdrop. The cover anchors to composerRef (positioned in
the next task) so permission cards overlay the input instead of pushing it
down."
```

---

## Task 2: Add positioning context to composerRef in ChatInput

**Files:**
- Modify: `apps/desktop/src/renderer/src/components/chat-input.tsx:439–448`

**Interfaces:**
- Consumes: the `composerRef` div and its existing className logic (the ternary on `hero`).
- Produces: a `relative` positioning context on `composerRef`. The cover zone from Task 1 (`absolute inset-0`) now anchors to the composer box instead of the nearest positioned ancestor (which would be the `relative` on `TasksView`'s outer container — wrong target).

**Context the implementer needs:** `composerRef` is the div wrapping both `{overlay}` and `<PromptInput>`. Without `relative` here, Task 1's `absolute inset-0` cover would anchor to `TasksView`'s outer `relative flex h-full` container (line ~106 of `tasks-view.tsx`) and cover the whole session panel — including the header and thread — instead of just the composer box. Adding `relative` to `composerRef` is what scopes the cover to the composer box alone. Hero variant never renders an overlay, so adding `relative` there too is harmless and keeps both branches consistent.

- [ ] **Step 1: Add `relative` to both branches of the `composerRef` className ternary**

In `chat-input.tsx`, the `composerRef` div (currently lines ~439–449) has this ternary:

```tsx
        className={
          hero
            ? '[&_[data-slot=input-group]]:rounded-2xl [&_[data-slot=input-group]]:border-border [&_[data-slot=input-group]]:bg-secondary [&_[data-slot=input-group]]:shadow-black/20 [&_[data-slot=input-group]]:shadow-lg'
            : 'mx-auto max-w-3xl [&_[data-slot=input-group]]:rounded-xl'
        }
```

Change it to (only addition: leading `relative ` in both branches):

```tsx
        className={
          hero
            ? 'relative [&_[data-slot=input-group]]:rounded-2xl [&_[data-slot=input-group]]:border-border [&_[data-slot=input-group]]:bg-secondary [&_[data-slot=input-group]]:shadow-black/20 [&_[data-slot=input-group]]:shadow-lg'
            : 'relative mx-auto max-w-3xl [&_[data-slot=input-group]]:rounded-xl'
        }
```

No test for this step — `relative` is a pure CSS positioning primitive with no observable DOM behavior in jsdom (jsdom does not compute layout). The observable effect (cover anchors to composer box, not the whole panel) is verified manually in Task 4. Adding a unit test would just assert the class string is present, which tests nothing meaningful.

- [ ] **Step 2: Verify existing chat-input tests still pass**

Run: `cd apps/desktop && pnpm vitest run src/renderer/src/components/chat-input.thinking.test.tsx`
Expected: PASS — adding a class cannot break existing behavior; this is a regression sanity check.

- [ ] **Step 3: Commit**

```bash
git add apps/desktop/src/renderer/src/components/chat-input.tsx
git commit -m "feat(desktop): position composerRef so the overlay cover anchors to the composer

Adding `relative` to composerRef scopes Task 1's absolute-positioned cover
zone to the composer box itself, not the session panel's outer relative
container."
```

---

## Task 3: Lock the textarea while permission prompts are pending

**Files:**
- Modify: `apps/desktop/src/renderer/src/components/views/tasks-view.tsx:131`

**Interfaces:**
- Consumes: `sessionPrompts` (already defined at `tasks-view.tsx:56` as `queue.filter((p) => p.sessionId === selectedSessionId)`); the `disabled` prop on `<ChatInput>` (which flows to `PromptInputTextarea disabled={disabled}` at `chat-input.tsx:460`).
- Produces: a composer that is both visually covered (Task 1) and interactionally disabled whenever `sessionPrompts.length > 0`. This is defense in depth — the visual cover alone would fail open (allow input) for AT users or if the cover render ever breaks; the `disabled` textarea fails closed.

**Context the implementer needs:** Currently `disabled={!ready}` at line 131 — the textarea is disabled only while the session is not yet ready. We extend that condition to also disable while there are pending permission prompts. `ChatInput` already passes `disabled` straight through to `PromptInputTextarea`, so no `ChatInput` change is needed.

- [ ] **Step 1: Extend the `disabled` prop**

At `tasks-view.tsx:131`, change:

```tsx
          disabled={!ready}
```

to:

```tsx
          disabled={!ready || sessionPrompts.length > 0}
```

- [ ] **Step 2: Verify nothing regressed**

Run: `cd apps/desktop && pnpm vitest run`
Expected: PASS — all renderer tests green. (`tasks-view.tsx` has no dedicated unit test; the change is a one-line boolean widening with no new logic, verified manually in Task 4.)

- [ ] **Step 3: Commit**

```bash
git add apps/desktop/src/renderer/src/components/views/tasks-view.tsx
git commit -m "feat(desktop): disable composer while a permission prompt is pending

Defense in depth on top of the visual cover: the textarea is also disabled,
so the input cannot be submitted while an approval decision is outstanding —
including for AT users for whom the visual cover is irrelevant."
```

---

## Task 4: Manual verification matrix

**Files:** none modified — manual QA.

**Context the implementer needs:** This is a layout/interaction change; the meaningful test of "does the cover actually overlay the composer and block input" requires a real browser with computed layout, which jsdom cannot provide. The seven scenarios below map one-to-one to the spec's testing section and are the acceptance gate.

- [ ] **Step 1: Start the dev server**

Run: `cd apps/desktop && pnpm dev` (or the project's standard dev command).
Open the app and navigate to an active session (the route that renders `TasksView`, e.g. pick a session from the sidebar).

- [ ] **Step 2: Baseline — no overlay content**

Scenario: a session with no running plan, no queued turns, no pending permissions.
Verify: composer input is live, typeable, submittable. No cover layer visible.

- [ ] **Step 3: Plan running, no permission**

Trigger an agent run that has a plan (todos). Without any permission prompt firing.
Verify: plan progress bar floats above the composer. Input is live, typeable, submittable. The cover zone does NOT appear (no `.cover-zone` element).

- [ ] **Step 4: CORE — one permission prompt**

Trigger an agent action that requires approval (medium or high risk, anything that reaches the renderer — low risk is auto-allowed by the permission gate and won't show).
Verify:
- The approval card covers the composer box (overlaps the input area, not floating above it).
- A dimmed backdrop is visible over the input beneath the card.
- The textarea underneath is disabled — try clicking into the area behind the cover; you cannot focus or type in it.
- The submit button does not fire (covered by the backdrop; even if reachable, textarea is disabled).

- [ ] **Step 5: Two permission prompts**

Trigger two pending approvals.
Verify:
- Both cards stack inside the cover zone, scrollable if they exceed the box height (each `PermissionCard` self-scrolls via its own `ScrollArea` at `max-h-[50vh]`).
- Resolve the top card (Allow / Deny / Skip) → the next card becomes top, keeps focus-on-Deny if high-risk.
- Resolve the last card → cover disappears, input re-enables, plan bar (if still running) remains floating.

- [ ] **Step 6: Plan + permission simultaneously**

Have a plan running AND a permission prompt pending.
Verify: plan progress bar floats above the composer (NOT covered). Permission card overlays only the input. The two regions do not visually collide.

- [ ] **Step 7: Escape skips top prompt**

With one or more prompts pending, press Escape.
Verify: top prompt is skipped (existing `permission.skipTop` binding). If more prompts remain, the cover stays with the next prompt; otherwise it clears.

- [ ] **Step 8: Hero variant regression check**

Navigate to the home dashboard and to the session index route (both use `<ChatInput variant="hero" />` with no overlay).
Verify: composer renders normally, no `relative` side effects, input is live. No overlay/cover appears.

- [ ] **Step 9: Final commit (only if any fixups were needed)**

If scenarios 4–6 revealed issues and you fixed code, stage and commit those fixes now with a descriptive message. If everything passed first try, skip this step.
