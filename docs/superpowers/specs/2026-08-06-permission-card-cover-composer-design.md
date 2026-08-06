# Permission Card Covers Composer — Design

**Date:** 2026-08-06
**Scope:** Renderer (desktop app), active-session detail view only
**Status:** Approved (verbal), pending spec review

## Problem

When an action needs approval, the `PermissionCard` is rendered **above** the
`PromptInput` composer as an in-flow sibling (`mb-2 flex flex-col gap-2` inside
`composerRef`). It pushes the input down instead of covering it. The user can
keep typing and submit new messages while a permission decision is pending,
which is ambiguous: does a new message queue after the approval, interrupt it,
or race with it?

**Goal:** while at least one permission prompt is pending, the approval card(s)
must **cover** the composer so no new message can be sent until the user
resolves the top-most prompt.

## Scope Boundaries

In scope:

- Active-session detail view (`TasksView` → `ChatInput` with an `overlay`).
- The visual + interaction change for pending **permission prompts** only.

Out of scope (explicitly preserved as-is):

- `PlanStatusBar` and queued-turn rows keep their current "float above the
  composer, do not cover it" behavior. They are informational/status, not
  blocking decisions, so they must not lock the input.
- The home-dashboard hero variant and session-index route use `<ChatInput
  variant="hero" />` with **no** overlay; this design does not touch them.
- The four decision buttons (Skip / Allow / Always allow / Deny) and their
  semantics are unchanged. Escape-to-skip (`permission.skipTop` command binding
  in `ComposerOverlay`) keeps working.

## Current Structure (reference)

`apps/desktop/src/renderer/src/components/chat-input.tsx` (around line 438–457):

```jsx
<div className={hero ? undefined : 'shrink-0 px-4 pt-2 pb-4'} ref={containerRef}>
  <div
    className={hero ? '...hero input-group styles...' : 'mx-auto max-w-3xl [&_[data-slot=input-group]]:rounded-xl'}
    ref={composerRef}
  >
    {overlay}                 // ComposerOverlay — in-flow, ABOVE PromptInput
    <PromptInput ...>
      ...
      <PromptInputTextarea autoFocus disabled={disabled} ... />
      ...
    </PromptInput>
  </div>
  ...
</div>
```

`composerRef` has **no positioning context** today, and `ComposerOverlay`'s
root is a plain `mb-2 flex flex-col gap-2` column. That is why the overlay
stacks above rather than overlays.

`ComposerOverlay` renders three kinds of children in one column:

1. `<PlanStatusBar>` — plan progress (informational)
2. queued-turn rows (status)
3. `<PermissionCard>` list — approval decisions (blocking)

Only (3) should cover the composer.

## Design

### Approach

Split the overlay into two positioning zones, both still produced by the single
`ComposerOverlay` component (so `ChatInput` keeps one `overlay` slot and the
escape-command wiring stays centralized):

- **Floating zone** (unchanged): `PlanStatusBar` + queued turns. Stays in-flow,
  sits above the composer, never covers it.
- **Cover zone** (new): the pending `PermissionCard`s. Rendered as an
  absolutely-positioned layer over `PromptInput` with a dimming backdrop.

To host the cover layer, give `composerRef` a positioning context (`relative`)
and have `ChatInput` reserve a single stable slot where the cover layer mounts.
The cover layer fills the composer box, so it visually replaces the input while
permissions are pending.

### Why a positioning context on `composerRef`

The cover layer must overlap exactly the `PromptInput` box — same width, pinned
to its top/bottom. The natural anchor is the existing `composerRef` div that
already wraps `{overlay}` + `<PromptInput>`. Making it `relative` and mounting
the cover as an `absolute inset-0` child keeps the cover aligned to the input
even when the hero variant's wider styles are in play (hero has no overlay, so
this path never runs there — but the anchoring stays correct if it ever does).

### Component changes

**`composer-overlay.tsx`** — split the single root into two regions:

```jsx
return (
  <>
    {/* Floating zone — informational, never covers input. Renders nothing
        when empty so it takes no space. */}
    {(planVisible || queued.length > 0) && (
      <div className="mb-2 flex flex-col gap-2">
        <PlanStatusBar running={running} todos={todos} />
        {queued.map((q) => ( ... ))}
      </div>
    )}

    {/* Cover zone — only permission cards. absolute inset-0 over the composer,
        with a dimming backdrop so the disabled input reads as locked. */}
    {prompts.length > 0 && (
      <div className="absolute inset-0 z-10 flex flex-col gap-2 overflow-hidden rounded-xl bg-background/80 p-2 backdrop-blur-sm">
        {prompts.map((p, i) => (
          <PermissionCard autoFocusDeny={i === 0} key={p.actionId} onDecide={onDecide} prompt={p} />
        ))}
      </div>
    )}
  </>
)
```

Notes:

- The cover root uses `absolute inset-0` to fill `composerRef`. `bg-background/80`
  + `backdrop-blur-sm` dims the input beneath so it visibly reads as "locked,
  look up here". `rounded-xl p-2` matches the composer box's actual rounding
  (the `PromptInput` box is the `InputGroup`, which default-variant styles in
  `chat-input.tsx` shape via `[&_[data-slot=input-group]]:rounded-xl`; the cover
  sibling must mirror that radius so corners align). Hero variant is
  `rounded-2xl` but never renders an overlay, so a single `rounded-xl` on the
  cover is correct for the only path that runs it.
- `PermissionCard` itself needs **no change** — it already has `max-h-[50vh]`
  and its own `ScrollArea`, so multiple cards stack and scroll within the cover.
- The `permission.skipTop` command binding and the `top = prompts[0]` logic
  stay in `ComposerOverlay`; behavior is unchanged.
- `planVisible` is computed exactly as today
  (`running && todos.some(t => t.status !== 'completed')`).

**`chat-input.tsx`** — two surgical changes:

1. Add a positioning context to `composerRef` so the cover anchors to the
   composer box, not the page:

   ```jsx
   className={
     hero
       ? '...existing hero styles... relative'
       : 'relative mx-auto max-w-3xl [&_[data-slot=input-group]]:rounded-xl'
   }
   ```

   (Hero adds `relative` too for safety, though hero never renders an overlay.)

2. Treat a pending permission as a hard lock, not just a visual cover. Compute
   the lock from whether the overlay contains permission cards and pass it to
   `disabled`. The cleanest source is the prop `ChatInput` already controls:
   `TasksView` passes `disabled={sessionPrompts.length > 0 ? true : <existing>}`.
   Concretely, in `tasks-view.tsx`, the `disabled` passed to `<ChatInput>` becomes
   a union of its existing condition **or** `sessionPrompts.length > 0`.

   This is a **defense in depth**: the cover already hides the textarea, but if
   the cover ever fails to render (e.g. a render bug, or a screen reader / AT
   user for whom the visual cover is irrelevant), the underlying textarea is
   still `disabled` and cannot submit. Without it, the "cannot send" guarantee
   rests solely on CSS.

### Visual result

- No pending permissions, plan/queue may be visible → today's behavior exactly
  (informational cards float above the input, input is live).
- Pending permission(s): the approval card(s) fill the composer box on a dimmed
  surface; the input underneath is disabled and visually muted by the backdrop.
  Resolving the top card reveals either the next card or the live input.

### Edge cases

- **Multiple pending prompts:** stack vertically inside the cover; each card's
  own `max-h-[50vh]` + `ScrollArea` keeps them readable. The cover's
  `overflow-hidden` clips anything exceeding the composer box; inner scroll
  areas handle overflow per-card.
- **Cover taller than composer box:** `PermissionCard` already caps at
  `max-h-[50vh]` and self-scrolls. The cover is `flex flex-col`, so multiple
  cards distribute; if they exceed the box height, the inner cards scroll within
  their own `ScrollArea`. No new overflow handling needed.
- **`PlanStatusBar` + permission at once:** plan bar floats above as today;
  permission cover overlays only the input. The two regions do not overlap.
- **Permission dismissed, plan still running:** cover disappears (prompts empty),
  plan bar remains floating, input re-enables. Standard transition.
- **Escape pressed:** `permission.skipTop` skips the top prompt; if more prompts
  remain the cover stays, otherwise it clears. Unchanged behavior, new visual.

## Files Touched

1. `apps/desktop/src/renderer/src/components/composer-overlay.tsx` — split into
   floating region (plan/queued) + cover region (permissions). ~15 lines changed.
2. `apps/desktop/src/renderer/src/components/chat-input.tsx` — add `relative` to
   `composerRef` className (both variants). 2 lines.
3. `apps/desktop/src/renderer/src/components/views/tasks-view.tsx` — extend the
   `disabled` prop to also lock when `sessionPrompts.length > 0`. 1 line.

No new files, no type changes, no new dependencies.

## Testing

Manual verification matrix (this is a layout/interaction change, no new logic
branches to unit-test):

1. No overlay content → input live, no cover. **(baseline)**
2. Plan running, no permission → plan bar floats, input live. **(floating zone
   intact)**
3. One permission prompt → cover fills composer, input disabled, textarea
   cannot submit. **(core)**
4. Two permission prompts → both in cover, stack + scroll; resolve top → next
   shows; resolve last → input live. **(stacking)**
5. Plan running + permission → plan bar floats above, cover overlays only
   input. **(regions coexist)**
6. Escape with permission pending → skips top prompt per existing
   `permission.skipTop` binding. **(keyboard path intact)**
7. Hero variant (home/session index) → no overlay, no `relative` side effects,
   input live. **(out-of-scope untouched)**

Success criterion: in state 3–6, there is **no code path** that lets the user
submit a new message while a permission prompt is pending — both via the
disabled textarea and via the visual cover blocking interaction with the input.
