# AI Elements Chat Shell (Phase 1) — Design

**Date:** 2026-06-15
**Status:** Approved, pending implementation
**Scope:** Phase 1 of 2. Phase 2 (attachments end-to-end) is a separate spec.

## Problem

The chat UI is hand-built (`ConversationThread`, `ChatInput`) and the user wants
the ai-elements experience: a richer composer (the `prompt-input` look, with an
attachment affordance), and a message list that scrolls to bottom. The user ran
`pnpm dlx ai-elements@latest`, which dropped 48 components into the wrong place
(`src/components/`, a stray root `@/` folder, a root `components.json`) and
re-added the `ai` SDK plus `streamdown`/`shiki`/`nanoid`/`use-stick-to-bottom`.

This phase adopts the **chat-relevant subset** of ai-elements, wired to the
existing `TaskRecord`/`UIEvent` data model — **not** the AI SDK `useChat`/
`UIMessage` flow (the project deliberately migrated off the AI SDK to
`pi-agent-core`). Attachments are UI-only here (no-op), wired in Phase 2.

## Decisions (approved)

- **Approach A — compose primitives from existing data.** Keep ported component
  files near-verbatim; rewrite `ConversationThread` and `ChatInput` to compose
  ai-elements primitives directly from `TaskRecord`/`UIEvent`. No `UIMessage`
  adapter layer.
- Replace the composer's `NativeSelect` "Swarm Active" model row with
  `prompt-input`'s `PromptInputSelect`, reusing the existing provider/model
  switching logic.
- Keep `ai@6` as a **type-only** dependency for Phase 1 (the ported components
  import types like `UIMessage['role']`, `ToolUIPart`). A later cleanup may
  strip it.

## Prerequisites (already satisfied)

- React 19.2 + Tailwind 4.3 (ai-elements targets both). ✅
- Full shadcn base-nova `ui/*` primitives exist under
  `src/renderer/src/components/ui/`. ✅
- Runtime deps already installed: `streamdown`, `@streamdown/{cjk,code,math,mermaid}`,
  `shiki`, `nanoid`, `use-stick-to-bottom`, `@radix-ui/react-use-controllable-state`. ✅
- The `@/*` path alias maps to `src/renderer/src/*`, so ported components'
  `@/components/ui/*` and `@/lib/utils` imports resolve to existing files. ✅

## Components ported

Copied from `src/components/ai-elements/` into
`src/renderer/src/components/ai-elements/`, near-verbatim (only import-path fixes
if a sibling is absent):

| File | Used for | Key exports |
|---|---|---|
| `conversation.tsx` | scroll-to-bottom message list | `Conversation`, `ConversationContent`, `ConversationScrollButton`, `ConversationEmptyState` |
| `message.tsx` | user/assistant bubbles + markdown | `Message`, `MessageContent`, `MessageResponse` (streamdown), `MessageActions`, `MessageAction` |
| `prompt-input.tsx` | composer | `PromptInput`, `PromptInputBody`, `PromptInputTextarea`, `PromptInputToolbar`, `PromptInputTools`, `PromptInputSubmit`, `PromptInputActionAddAttachments`, `PromptInputSelect*` |
| `tool.tsx` | tool call/result cards | `Tool`, `ToolHeader`, `ToolContent`, `ToolInput`, `ToolOutput` |
| `reasoning.tsx` | thinking panel | `Reasoning`, `ReasoningContent`, `ReasoningTrigger` |
| `code-block.tsx` | shiki code blocks (used by tool/message) | `CodeBlock`, `CodeBlockCopyButton` |
| `shimmer.tsx` | loading shimmer (imported by reasoning) | `Shimmer` |

Any additional sibling files these import (discovered at port time, e.g. icon or
helper modules) are copied alongside. No new npm installs.

## Architecture

### Event → segments helper (new, testable)

Extract the current `bubblesFor` logic (in `conversation-thread.tsx`) into a pure
function in a new module `src/renderer/src/lib/task-segments.ts`:

```ts
export type Segment =
  | { kind: 'user'; text: string; key: string; taskId: string }
  | { kind: 'assistant'; text: string; key: string; taskId: string }
  | { kind: 'tool'; tool: string; state: 'input' | 'output'; ok?: boolean; input: unknown; output?: string; key: string; taskId: string }
  | { kind: 'error'; label: 'error' | 'stopped'; detail: string; key: string; taskId: string }

export function taskSegments(task: TaskRecord): Segment[]
```

It preserves all current behavior:
- coalesce consecutive assistant `llm.message` deltas into one growing segment;
- suppress the `update_plan` tool call **and** its following `tool.result`
  (rendered by `PlanPanel`, not the transcript);
- pair `tool.call` with the next non-suppressed `tool.result` into one `tool`
  segment (input + output), instead of two separate rows;
- map `task.error` → `error` segment, with label `'stopped'` when
  `error.code === 'cancelled'`, else `'error'`.

### `ConversationThread` (rewrite)

Renders `taskSegments` through ai-elements:
- Outer: `Conversation` → `ConversationContent`; include `ConversationScrollButton`
  (replaces the manual `bottomRef`/`scrollIntoView`; `use-stick-to-bottom` drives
  sticky scroll). `ConversationEmptyState` for the zero-task case.
- `user` / `assistant` → `Message from="user|assistant"` → `MessageContent` →
  `MessageResponse` (streamdown markdown: CJK/code/math/mermaid).
- `tool` → `Tool` → `ToolHeader` (name + status badge) → `ToolContent` with
  `ToolInput`/`ToolOutput`.
- `error` → keep a compact inline row (reuse `Message`/muted styling); the label
  is "stopped" or "error".
- `reasoning.tsx` is ported so the primitive is available, but it is **not wired
  in Phase 1**: the `UIEvent` stream has no separate reasoning channel today
  (assistant text is a single `llm.message` stream). Wiring `Reasoning` is
  deferred until a reasoning channel exists.
- Preserve copy/delete affordances via `MessageActions`/`MessageAction` (copy)
  and the existing delete handler (remove task from the Query cache).
- The "thinking…/queued…" busy indicator stays, driven by the last task's
  `running`/`pending` status (unchanged logic).

### `ChatInput` (rewrite as a thin `PromptInput` wrapper)

- `PromptInput` (form) → `PromptInputBody` → `PromptInputTextarea` +
  `PromptInputToolbar`.
- `PromptInputToolbar`: `PromptInputTools` containing
  `PromptInputActionAddAttachments` (**rendered disabled / no-op in Phase 1**)
  and `PromptInputSelect*` for model selection (reusing the existing
  `useProviders` + `buildModelOptions` logic and `providers.setActive/setModel`).
- `PromptInputSubmit` with `status` derived from `activeTask`: `'streaming'`
  while a run is active (renders the native Stop button → calls the existing
  cancel path), otherwise `'ready'` (submit). This **absorbs** the Send→Stop
  feature already built.
- Preserve the `!ready` provider gate, Enter-to-send, and IME-safe composition
  handling.

### `tasks-view.tsx`

Swap to the new `ConversationThread` and `ChatInput`. The `activeTask`
derivation and `useCancelTask` wiring stay; they feed the composer's `status`
and stop action.

## Cleanup (after the new path builds and renders)

- Delete the misplaced install: stray root `@/` directory, root
  `components.json`, and `src/components/` (only after the chosen files are
  ported into `src/renderer/src/components/ai-elements/`).
- The uncommitted composer padding tweak in the old `chat-input.tsx` is dropped
  (superseded by `prompt-input`).
- `ai`, `streamdown`, `shiki`, `nanoid`, `use-stick-to-bottom`,
  `@radix-ui/react-use-controllable-state` remain in `package.json` (now used).

## Testing

- **Unit:** `task-segments.test.ts` covering delta coalescing, `update_plan`
  call+result suppression, tool call/result pairing, and the
  cancelled→"stopped" / other→"error" label mapping.
- **Existing:** `apply-event.test.ts` and the rest of `npm test` stay green
  (reducer unchanged).
- **Build:** `npm run typecheck` and `npm run build` pass.
- **Manual:** `pnpm dev` — confirm the new composer (textarea + model select +
  disabled attach button + submit/stop), streamdown rendering (including CJK and
  a fenced code block), tool cards, scroll-to-bottom, and that stopping a run
  shows "stopped".

## Out of scope (Phase 2)

- Functional attachments (image picker → `submitGoal` → IPC → `agent.prompt(goal, images)`),
  persistence, transcript rendering of attachments, vision-model gating.
- Stripping the `ai` type-only dependency.
- Message branching/versioning (`MessageBranch*`), and the unused ~40 other
  ai-elements components.
