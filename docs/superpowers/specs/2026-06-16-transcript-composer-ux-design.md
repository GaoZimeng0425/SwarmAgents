# Transcript & Composer UX Enhancements — Design

**Date:** 2026-06-16
**Status:** Approved

Five independent UI / event-layer enhancements that share the
`UIEvent → TaskRecord → Segment → render` pipeline. Each is independently
shippable. Sequencing: F3 → F5 → F4 → F1 → F2.

---

## F1 — Context-window ring in the composer

**Goal:** Show a circular progress ring in the composer that fills toward the
model's context-window limit.

**Data flow:**
- `agent-runner.ts` already resolves `model` (has `model.contextWindow: number`)
  and receives per-turn `Usage` on `turn_end`. Capture the latest turn's
  context occupancy as `contextTokens = usage.input + usage.output +
  usage.cacheRead + usage.cacheWrite`.
- Extend the `task.usage` `UIEvent` with two optional fields:
  `contextTokens?: number` and `contextWindow?: number`. No change to the
  persisted `ResourceBudget` schema.
- `applyEvent` stores `contextTokens` / `contextWindow` on `TaskRecord`.

**UI:**
- New `ContextRing` component: a small SVG ring whose stroke fills with
  `contextTokens / contextWindow`. Tooltip shows e.g. `12.3k / 200k · $0.07`.
  Stroke color: default below 75%, amber 75–90%, red above 90%.
- Rendered in the composer footer (`ChatInput`, in the `PromptInputTools` row)
  next to the model picker. `tasks-view` passes the active/latest task's
  `contextTokens` / `contextWindow` (and cost from `used.usdCents`) down.
- Hidden when no context data is available yet.

---

## F2 — `ask_user` options tool (human-in-the-loop choice)

**Goal:** Let the agent pause and ask a human to choose between options via
clickable buttons. Supports single-select and multi-select, plus a
"Chat about this" escape that routes the answer through the normal composer.

**Architecture — mirrors the existing permission flow:**

| Permission flow | New ask flow |
|---|---|
| `PermissionRegistry` (service) | `AskRegistry` (service) |
| `task.permission_request` `UIEvent` | `task.ask` `UIEvent` |
| `usePermissionStore` | `useAskStore` |
| `PermissionDrawer` | `AskPanel` |
| `decidePermission` IPC | `respondAsk` IPC |

- **Tool:** new builtin `ask_user` with args
  `{ question: string; options: { label: string; value?: string }[]; mode?: 'single' | 'multi' }`.
  Risk `low` (no permission gate). It calls `ctx.askUser(...)` which blocks
  until the user responds, then returns the chosen value(s) as the tool result
  text. `ToolRunContext` gains an `askUser` method backed by `AskRegistry`.
- **Event:** when the tool is invoked, the service emits `task.ask`
  `{ askId, question, options, mode }` and the task status moves to
  `awaiting_user` (reuses existing in-flight semantics).
- **UI:** `AskPanel` renders above the composer (like `PermissionDrawer`):
  the question + one button per option. `single` → clicking a button submits
  immediately. `multi` → checkboxes + a Submit button. A trailing
  **"Chat about this"** button dismisses the panel and returns control to the
  composer; the user's next submitted message becomes the tool's answer.
- **Response:** `respondAsk(sessionId, askId, answer)` resolves the registry
  promise. The service emits a follow-up event so the transcript records the
  resolved answer ("You chose X").

---

## F3 — Always-present, collapsed-by-default plan panel

**Goal:** The Working Plan panel should always be present (collapsed by
default), not appear only once the agent emits a plan.

- `PlanPanel`: remove the `if (todos.length === 0) return null` guard; default
  `collapsed = true`; when expanded with zero todos, show an empty state
  ("No tasks yet").
- `tasks-view`: always mount `<PlanPanel todos={activePlan ?? []} />`.

---

## F4 — Deep-thinking display

**Goal:** Stream and display model reasoning ("thinking") in a collapsible
block above the answer, on by default for models that support it.

- **Service:** in `agent-runner.ts`, enable thinking
  (`thinkingLevel: 'medium'`) for models where `model.reasoning === true`.
  In the event translator, capture `message_update` events whose
  `assistantMessageEvent.type === 'thinking_delta'`, buffer the deltas, and
  flush them as a new `TaskEvent` of kind `reasoning`
  (`{ kind: 'reasoning', content: string, ts }`), added to `TaskEventSchema`.
  Thinking is flushed before the first answer text / tool call.
- **Renderer:** new `reasoning` `Segment` kind (consecutive deltas
  accumulate, like `assistant`). `conversation-thread` renders a lightweight
  collapsible **"Thinking"** block that auto-collapses once the assistant's
  answer text begins.

---

## F5 — Polish the merged tool card

**Goal:** The tool call/result is already merged into one collapsible card
(`taskSegments` pairs `tool.call` + `tool.result`; `Tool` renders one card).
This is visual polish toward the flat Codex look.

- Denser padding, monospace tool name, status as a compact inline indicator
  (not a pill badge).
- Auto-collapse the card once the tool completes successfully.
- Show a one-line result preview in the header when collapsed.

---

## Testing

- F1: unit-test the context-token derivation and `applyEvent` field storage.
- F2: unit-test `AskRegistry` (request/respond/resolve, abort) and the
  `ask_user` tool result shaping; the segment/store wiring follows the
  permission pattern's existing tests.
- F3: `PlanPanel` renders collapsed empty state with no todos.
- F4: `taskSegments` produces a `reasoning` segment; translator emits
  `reasoning` events from `thinking_delta`.
- F5: visual only; verify the existing `taskSegments` pairing tests still pass.
