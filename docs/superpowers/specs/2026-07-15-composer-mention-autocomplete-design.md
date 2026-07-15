# Composer Mention Autocomplete (`/` skills, `@` file paths)

**Date:** 2026-07-15
**Status:** Design (pending implementation plan)

## Goal

Add two inline autocomplete triggers to the composer's prompt textarea:

- **`/`** — opens a popover listing callable skills (filtered to those the model can
  invoke via `use_skill`). Selecting one inserts `/skill-name ` (name + trailing space).
- **`@`** — opens a popover listing files and folders under the composer's current
  working directory (`cwd`). Folders are drillable (selecting a folder inserts
  `@folder/` and keeps the popover open for the next path segment); selecting a file
  inserts the full relative path and closes the popover.

Both triggers insert **plain text only**. No change to the downstream pipeline — the
agent reads `/skill-name` or `@path/to/file` as ordinary prompt text and decides
whether to act (lazy loading, model-driven). This intentionally matches Claude Code's
"bare path" semantics, not its client-side `@`-content-injection.

## Non-goals

- No client-side file-content injection (eager loading). The agent still reads files
  itself via the `fs` tools.
- No parsing of `@path` or `/skill` tokens in the service layer / message-engine.
  `submitPrompt` is untouched.
- No change to the command palette (`lib/palette/scope.ts`), which keeps its own
  prefix convention (`/` = file, `@` = agent). The composer uses an independent
  convention; the two scopes do not collide because they are different entry points.
- No change to `prompt-input.tsx` (the shared ai-elements library file).

## Prefix convention decision

The command palette (⌘K) already defines `>` = command, `@` = agent, `#` = task,
`/` = file (`lib/palette/scope.ts:32`). The composer uses a different convention:
`/` = skill (a slash-command, hence "command-class"), `@` = file path (an
@-mention, hence "invoke/mention-class").

The user's guiding principle is: `/` is command-class, `@` is invoke/mention-class.
Under that lens the composer's `/` = skill fits (a skill invocation is a command),
and `@` = file path fits (referencing a file is a mention). The command palette's
`@` = agent also fits (calling an agent is an invocation). The one genuine mismatch
is the command palette's `/` = file, which is **not** command-class — but unifying
that is a separate change to the palette and is explicitly out of scope here. The
palette is left untouched in this spec; the known `/` semantic divergence between
the two entry points is accepted for this iteration.

## Architecture

Two layers, cleanly separated:

1. **Pure logic** (`lib/mention.ts`) — framework-free, unit-testable. Extracts the
   active mention from `{ value, caret }`.
2. **UI** (`components/composer-mention.tsx`) — a hidden listener component that
   mounts inside the composer, watches the textarea, and renders a popover.

### Approach chosen (A): new component mounted in composer

A new `<ComposerMention>` sits alongside the existing `ComposerAddMenu` and
`ComposerCwdMenu` in `chat-input.tsx`. It does **not** render its own trigger button;
it is an invisible listener attached to the textarea. This mirrors the two existing
composer popovers (anchored to `composerRef`, opened with `side="top"`), so the new
component is structurally consistent with established patterns. It does not touch the
shared `prompt-input.tsx` library file.

Rejected alternatives:
- **(B) Modify `PromptInputTextarea` in the shared library** — rejected: touching a
  1231-line shared file for a single consumer violates surgical-changes; the mention
  state would have to coexist with the component's dual controlled/uncontrolled modes.
- **(C) Switch the composer to controlled mode via `PromptInputProvider`** — rejected:
  changing the textarea from uncontrolled to controlled ripples into `handleSubmit`
  (reads `FormData`), `insertPathReference` (native value setter), and
  `field-sizing-content` behavior. Large regression surface for marginal benefit.

## Pure logic: `lib/mention.ts`

### `extractMention(value, caret)`

```ts
export type MentionTrigger = '/' | '@'
export type Mention = { trigger: MentionTrigger; query: string; start: number; end: number }

/**
 * Scan left from the caret for a `/` or `@` trigger. The trigger is valid only when
 * it sits at a word boundary (preceded by whitespace or string start). The query is
 * the text between the trigger and the caret. A whitespace inside the query
 * invalidates the mention (returns null). `start`..`end` is the char range to
 * replace on selection (start = trigger index, end = caret).
 */
export function extractMention(value: string, caret: number): Mention | null
```

**Trigger rules:**
- A `/` or `@` is a trigger only if the character before it is whitespace, or it is
  at index 0 (start of input).
- For `@` (file paths), the query may contain `/` path separators — these do **not**
  terminate the query. `@src/compo` has query `src/compo`.
- For `/` (skills), the query matches skill names (lowercase, hyphenated); a `/`
  inside the skill query would be unusual but the same rule applies — the query ends
  only at whitespace.
- Once any whitespace appears between the trigger and the caret, `extractMention`
  returns null (mention is stale / closed).

### Skill filter + matcher

```ts
export function callableSkills(all: Skill[]): Skill[]
// Keeps skills where !disableModelInvocation && enabled !== false.

export function matchSkills(skills: Skill[], query: string): Skill[]
// Case-insensitive substring match on name OR description.
// Name hits rank before description-only hits; ties break alphabetically by name.
```

## Candidate data sources

### `/` skills

Reuse the existing `useSkills()` hook (`hooks/use-skills.ts`), which returns
`{ skills: Skill[], ... }` and subscribes to `skills.changed` for hot-reload. Filter
with `callableSkills()`, match with `matchSkills()`. **No new IPC.**

### `@` file paths

**New IPC: `system:listDir`.** There is no existing directory-listing IPC
(`system:pickPath` opens a native dialog; it does not list contents). The renderer
cannot `readdir` directly.

```ts
// preload bridge
window.swarm.listDir(dir: string, prefix?: string): Promise<{ name: string; isDir: boolean }[]>
```

Main-process handler (`swarm-ipc.ts`):
- `fs.readdir(dir, { withFileTypes: true })` — single level, non-recursive.
- Filter: drop entries whose `name` starts with `.` (hidden), then keep names
  starting with `prefix` (case-insensitive) when `prefix` is provided.
- Sort: folders first, then alphabetical.
- Cap at 50 entries (avoids flooding the popover / IPC for huge directories).
- Non-existent / unreadable directory → return `[]` (never throw; the renderer just
  shows an empty list).

**Path resolution for drill-down:** The renderer maintains the "current mention
query" (e.g. `src/compo`). It splits this into a directory part (`src`) and a leaf
prefix (`compo`), resolves the directory against `cwd`, and calls
`listDir(join(cwd, dirPart), leafPrefix)`.

**Debounce:** The renderer debounces `listDir` calls by ~80ms on query change so each
keystroke does not fire an IPC round-trip.

## UI: `components/composer-mention.tsx`

### Mounting

```tsx
<PromptInput ...>
  <AttachmentThumbnails ... />
  <PromptInputBody><PromptInputTextarea ... /></PromptInputBody>
  <PromptInputFooter>
    <ComposerAddMenu ... />
    <ComposerCwdMenu ... />
    ...
  </PromptInputFooter>
  <ComposerMention anchor={composerRef} cwd={cwd} />
</PromptInput>
```

### Accessing the textarea

`ComposerMention` gets the textarea the same way `insertPathReference` already does:
`containerRef.current?.querySelector('textarea[name="message"]')`. It attaches
`input`/`keydown`/`click`/`blur` listeners via `addEventListener` (the textarea is
inside `prompt-input.tsx`, so no React ref is available to `chat-input.tsx`). The
query is re-run on every caret-affecting event.

### Popover positioning

Fixed above the input box, anchored to `composerRef` — identical to `ComposerAddMenu`
(`side="top"`, `sideOffset={8}`). **No caret-coordinate measurement** (the
caret-tracking-mirror-div technique is rejected as too fragile for the value).

### Candidate rendering

Uses `@swarm/ui`'s `Popover` for the floating layer. The candidate list is rendered
with plain markup styled to match `ComposerAddMenu` items (no cmdk dependency —
filtering and keyboard navigation are both handled in-component, since cmdk's
built-in filtering/keyboard expect a `CommandInput` that we don't have here):

- **Skill rows:** `Sparkles` icon, `name` in mono, `description` in muted subtitle.
- **File rows:** `FileText` icon + name.
- **Folder rows:** `Folder` icon + name + trailing `/`.
- Folders sort before files (matching `listDir`'s order).

### Keyboard interaction

The textarea and popover share one keyboard stream. While the popover is open, the
textarea's `keydown` handler intercepts:

| Key | Behavior |
|---|---|
| `↑` / `↓` | Move the active highlight (preventDefault — caret must not move) |
| `Enter` | Select the highlighted item and commit (preventDefault — must not submit) |
| `Tab` | Select the highlighted item and commit |
| `Esc` | Close the popover |
| Other | Normal input; `extractMention` re-runs on the `input` event |

**Active-item management:** The component maintains its own `activeIndex` state
(ring-buffer over the candidate list) and does its own substring filtering — it does
not rely on cmdk. With candidate lists of <20 items, a simple `activeIndex` is
straightforward and fully controllable.

### Selection + commit

Commit uses the native value setter technique already proven by
`insertPathReference` (`chat-input.tsx:323`), since the textarea is uncontrolled:

```ts
const setter = Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value')?.set
setter?.call(ta, next)
ta.dispatchEvent(new Event('input', { bubbles: true }))
ta.focus()
```

- **Skill selected:** replace `start..end` with `/${name} ` (name + trailing space),
  set caret after the space, close the popover.
- **Folder selected (drill):** replace `start..end` with `@${relativePath}/` (trailing
  slash), set caret after it, **keep popover open**, clear the leaf query and list the
  folder's contents.
- **File selected:** replace `start..end` with `@${relativePath}`, set caret after it,
  close the popover.

### Close conditions

The popover closes when: `extractMention` returns null (caret left the mention region
or whitespace was typed), `Esc` is pressed, a file is selected, or the textarea blurs
(blur closes on a short timeout so a click on a candidate row still registers first).

## File change manifest

| Action | File | Notes |
|---|---|---|
| Create | `apps/desktop/src/renderer/src/lib/mention.ts` | `extractMention`, `callableSkills`, `matchSkills`. |
| Create | `apps/desktop/src/renderer/src/lib/mention.test.ts` | Unit tests for all pure functions. |
| Create | `apps/desktop/src/renderer/src/components/composer-mention.tsx` | `ComposerMention` component. |
| Modify | `apps/desktop/src/preload/index.ts` | Add `listDir` to the bridge (~3 lines). |
| Modify | `apps/desktop/src/main/ipc/swarm-ipc.ts` | Add `handle('system:listDir', ...)` (~15 lines). |
| Modify | `apps/desktop/src/renderer/src/components/chat-input.tsx` | Import + render `<ComposerMention>` (~5 lines). |

**Explicitly untouched:** `prompt-input.tsx`, the service layer (`submitPrompt`,
`session-service`, `message-engine`), `lib/palette/scope.ts` and the command palette.

## Testing strategy

- **`mention.test.ts` (primary):** `extractMention` branches — trigger at index 0,
  trigger after whitespace, trigger mid-word (must not fire), `@` query with path
  separators, query terminated by whitespace, caret in the middle vs. end of the
  mention. Plus `callableSkills` (excludes `disableModelInvocation` and disabled) and
  `matchSkills` (name-rank ordering).
- **`listDir` handler:** empty dir → `[]`, non-existent dir → `[]` (no throw), prefix
  filtering, hidden-file exclusion, 50-entry cap, folders-first ordering.
- **`chat-input.test.tsx` (add cases):** simulate typing `/` to open the skill popover,
  keyboard-select, and assert the textarea value becomes `/skill-name `. Same for `@`
  with a mocked `listDir` (jsdom cannot `readdir`).

## Open questions (none blocking)

- Whether `listDir` should respect a `.gitignore`-like exclusion (e.g. skip
  `node_modules`). Out of scope for v1; the 50-entry cap and hidden-file filter are
  the only v1 limits. Can revisit if the popover floods for `node_modules`-heavy cwds.
- Whether to surface a "no callable skills" empty state with a link to the skills
  settings page. Deferred — an empty `Command.Empty` row suffices for v1.
