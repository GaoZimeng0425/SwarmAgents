# Chat Conversation Minimap (User-Turn Navigation Rail)

**Date:** 2026-06-28
**Status:** Approved design — ready for implementation plan

## Problem

The chat thread (`ConversationThread`) is a single scrolling transcript of all
session tasks. In a long session there is no fast way to jump to an earlier
user message — you scroll and hunt. We want a compact navigation rail that
lists every user message as a tick, lets you click a tick to jump to that
turn, shows the message text on hover, and reflects the current scroll
position.

## Goals

- A vertical "virtual scrollbar" rail anchored at the **bottom-left** of the
  conversation viewport.
- One tick per **top-level user turn**.
- **Hover** a tick → tooltip showing that user message's text.
- **Click** a tick → smooth-scroll the corresponding turn into view.
- **Active highlight** → the tick for the turn currently in view is emphasized.
- Hidden when there is nothing to navigate (`< 2` user turns).

## Non-Goals

- No proportional/true-minimap tick positioning (offset-based). Ticks are
  evenly spaced, bottom-anchored. Rationale: streaming output constantly grows
  the scroll height; offset-based positioning would thrash. Even spacing +
  IntersectionObserver active tracking is stable.
- No ticks for assistant messages, tool calls, or sub-agent turns — user
  turns only.
- No persistence, no settings toggle.

## Architecture

### New component: `src/renderer/src/components/conversation-minimap.tsx`

```
ConversationMinimap({ tasks }: { tasks: TaskRecord[] })
```

Rendered as a child of `<Conversation>` (which is `position: relative`),
sibling to `ConversationContent` and `ConversationScrollButton`. Absolutely
positioned: `absolute bottom-4 left-2 z-20`, a bottom-anchored vertical
column. Pointer events only on the ticks so it never blocks text selection in
the left gutter.

### Data derivation: pure helper

Extract a pure function (testable, no DOM):

```ts
// src/renderer/src/lib/minimap-items.ts
export type MinimapItem = { taskId: string; text: string; ts: number }
export function minimapItems(tasks: TaskRecord[]): MinimapItem[]
```

- Filter `!t.parentTaskId` (top-level turns only; sub-agents excluded).
- Sort ascending by `startedAt`.
- Map to `{ taskId: t.id, text: t.goal, ts: t.startedAt }`.

The user message text is `task.goal` (confirmed in `task-segments.ts`: the
`'user'` segment's `text` is `task.goal`).

### Rendering

- Column of tick buttons, ascending top→bottom (oldest at top, newest at
  bottom), bottom-aligned within the rail.
- Each tick: a thin horizontal bar button. Default `h-0.5 w-4` muted; on
  hover/active `w-6` and `bg-primary`. `aria-label` = truncated text.
- Each tick wrapped in `@/components/ui/tooltip` with `side="right"`; tooltip
  content shows the message text, `line-clamp` to a few lines, `max-w`
  constrained.
- If the rail's natural height exceeds the available viewport height, wrap the
  tick column in `ScrollArea` (project rule: all scroll containers use
  `ScrollArea`, never raw `overflow-auto`). `max-height` caps the rail.

### Active tracking

- `IntersectionObserver` over every `[data-task-id]` user-turn element inside
  the scroll viewport. Observe on mount and whenever the item set changes.
- The active turn = the top-most user turn currently intersecting the
  viewport (fallback: last passed turn). Store its `taskId` in state; the
  matching tick gets the active style.
- Clean up the observer on unmount / re-subscribe when `items` change.

### Click → jump

Reuse the existing `focusTaskId` pattern from `ConversationThread`:

```ts
document
  .querySelector<HTMLElement>(`[data-task-id="${taskId}"]`)
  ?.scrollIntoView({ block: 'center', behavior: 'smooth' })
```

No new scroll plumbing needed; the user turn elements already carry
`data-task-id`.

### Integration point

`src/renderer/src/components/conversation-thread.tsx` — inside the non-empty
`<Conversation>` return, add `<ConversationMinimap tasks={tasks} />` as a
sibling of `ConversationContent`. Pass the same `tasks` prop the thread
already receives.

## Edge cases

- `< 2` user turns → component returns `null`.
- Empty/whitespace `goal` → tooltip falls back to a placeholder ("(empty
  message)").
- Sub-agent tasks (`parentTaskId` set) → never produce a tick.
- Bottom-center `ConversationScrollButton` and the left rail do not overlap.

## Testing

- **Unit (pure):** `minimap-items.test.ts` — filters sub-agent tasks, orders
  by `startedAt`, maps `goal`→`text`, handles empty input.
- **Component (light):** render `ConversationMinimap` with a few tasks; assert
  it renders one tick button per top-level turn and returns `null` for `< 2`.
  IntersectionObserver / `scrollIntoView` are jsdom-unfriendly; mock or skip
  the observer-driven assertions and keep the logic in the tested pure helper.

## Logging

This is renderer-only presentational UI with no business/IPC path, so the
pino structured-logging requirement (CLAUDE.md §5, main-process business
paths) does not apply. No new logs.

## Files

- **New:** `src/renderer/src/lib/minimap-items.ts`
- **New:** `src/renderer/src/lib/minimap-items.test.ts`
- **New:** `src/renderer/src/components/conversation-minimap.tsx`
- **Edit:** `src/renderer/src/components/conversation-thread.tsx` (render the rail)
