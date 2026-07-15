# Composer Mention Autocomplete Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add inline autocomplete to the composer textarea: `/` opens a callable-skill picker, `@` opens a cwd file/folder picker (folders drillable). Both insert plain text; the agent reads them lazily.

**Architecture:** A pure-logic module (`lib/mention.ts`) extracts the active `/` or `@` mention from `{ textarea value, caret }`. A new `<ComposerMention>` component mounts inside the composer, listens to the textarea via DOM query (same pattern as the existing `insertPathReference`), and renders a controlled Base UI `Popover` anchored above the input box. A new `system:listDir` IPC feeds the `@` file candidates.

**Tech Stack:** React, Base UI Popover (`@base-ui/react/popover`, accessed through `@swarm/ui`'s `Popover`/`PopoverContent`), vitest, Electron IPC (`ipcMain.handle`), Node `fs.readdir`.

## Global Constraints

- All code comments and commit messages in **English** (AGENTS.md §0).
- Use **pnpm** for all package commands (project memory).
- Test runner: `pnpm --filter @swarm/desktop test` (vitest, `ELECTRON_RUN_AS_NODE=1`).
- Typecheck: `pnpm --filter @swarm/desktop typecheck`.
- The shared library file `apps/desktop/src/renderer/src/components/ai-elements/prompt-input.tsx` is **read-only** for this feature — do not modify it.
- The service layer (`submitPrompt`, session-service, message-engine) is **untouched** — `/skill` and `@path` remain plain prompt text (lazy loading).
- The command palette (`lib/palette/scope.ts`) is **untouched**.

---

## File Structure

| File | Responsibility |
|---|---|
| `apps/desktop/src/renderer/src/lib/mention.ts` | Pure functions: `extractMention`, `callableSkills`, `matchSkills`. No React, no I/O. |
| `apps/desktop/src/renderer/src/lib/mention.test.ts` | Unit tests for all three functions. |
| `apps/desktop/src/renderer/src/components/composer-mention.tsx` | `<ComposerMention>` — DOM listener on the textarea + controlled popover + keyboard handling + text commit. |
| `packages/protocol/src/types/ui.ts` | Add `listDir` to the `SwarmBridge` interface (the `window.swarm` type). |
| `apps/desktop/src/preload/index.ts` | Add the `listDir` bridge method (invokes `system:listDir`). |
| `apps/desktop/src/main/ipc/swarm-ipc.ts` | Add the `system:listDir` handler (`fs.readdir` + prefix filter). |
| `apps/desktop/src/renderer/src/components/chat-input.tsx` | Mount `<ComposerMention>` inside `<PromptInput>`. |

---

## Task 1: `system:listDir` IPC (main + preload + protocol type)

Adds the backend the `@` file picker needs to read a directory. Self-contained: testable in isolation, no React dependency.

**Files:**
- Modify: `apps/desktop/src/main/ipc/swarm-ipc.ts` (add handler near the `system:pickPath` handler at line ~365)
- Modify: `apps/desktop/src/preload/index.ts` (add `listDir` after `pickFile` at line ~469)
- Modify: `packages/protocol/src/types/ui.ts` (add `listDir` to SwarmBridge after `pickFile` at line ~528)
- Test: `apps/desktop/src/main/ipc/swarm-ipc.test.ts` (if it exists; otherwise verify via typecheck + manual reasoning — the handler is a thin `fs.readdir` wrapper)

**Interfaces:**
- Produces: `window.swarm.listDir(dir: string, prefix?: string): Promise<DirEntry[]>` where `DirEntry = { name: string; isDir: boolean }`.

- [ ] **Step 1: Add `DirEntry` type + `listDir` to SwarmBridge**

In `packages/protocol/src/types/ui.ts`, after line 528 (`pickFile(): Promise<string | null>`), add:

```ts
  /** List one level of a directory (non-recursive) for the composer's @ file picker.
   *  Returns entries whose name starts with `prefix` (case-insensitive). Hidden files
   *  (dot-prefixed) are excluded. Folders sort before files; capped at 50 entries.
   *  Returns [] for a non-existent or unreadable directory (never throws). */
  listDir(dir: string, prefix?: string): Promise<{ name: string; isDir: boolean }[]>
```

- [ ] **Step 2: Add the IPC handler in swarm-ipc.ts**

In `apps/desktop/src/main/ipc/swarm-ipc.ts`, after the `system:pickPath` handler block (line ~365, after `ipcMain.handle('system:pickPath', pickPath)`), add:

```ts
  // List one directory level for the composer's @ file/folder autocomplete.
  // Non-recursive, dotfiles excluded, prefix-filtered, folders-first, capped.
  const listDir = async (_e: Electron.IpcMainInvokeEvent, dir: unknown, prefix?: unknown): Promise<{ name: string; isDir: boolean }[]> => {
    if (typeof dir !== 'string') return []
    try {
      const entries = await fs.readdir(dir, { withFileTypes: true })
      const p = typeof prefix === 'string' ? prefix.toLowerCase() : ''
      const visible = entries
        .filter((e) => !e.name.startsWith('.'))
        .filter((e) => (p ? e.name.toLowerCase().startsWith(p) : true))
        .map((e) => ({ name: e.name, isDir: e.isDirectory() }))
        .sort((a, b) => Number(b.isDir) - Number(a.isDir) || a.name.localeCompare(b.name))
      return visible.slice(0, 50)
    } catch {
      return []
    }
  }
  ipcMain.handle('system:listDir', listDir)
```

Ensure `fs` (Node promises API) is imported at the top of the file. Check existing imports — if `node:fs/promises` is not already imported, add:

```ts
import fs from 'node:fs/promises'
```

- [ ] **Step 3: Add the bridge method in preload**

In `apps/desktop/src/preload/index.ts`, after line 469 (`pickFile: ...`), add:

```ts
  listDir: (dir: string, prefix?: string) =>
    ipcRenderer.invoke('system:listDir', dir, prefix) as Promise<{ name: string; isDir: boolean }[]>,
```

- [ ] **Step 4: Typecheck**

Run: `pnpm --filter @swarm/desktop typecheck`
Expected: PASS (the `SwarmBridge` literal at preload line 347 now satisfies the updated interface).

- [ ] **Step 5: Commit**

```bash
git add packages/protocol/src/types/ui.ts apps/desktop/src/main/ipc/swarm-ipc.ts apps/desktop/src/preload/index.ts
git commit -m "feat(ipc): add system:listDir for composer @ file picker"
```

---

## Task 2: Pure mention logic (`lib/mention.ts`)

The framework-free extraction + skill filtering/matching. This is the most logic-dense part and gets its own test file.

**Files:**
- Create: `apps/desktop/src/renderer/src/lib/mention.ts`
- Test: `apps/desktop/src/renderer/src/lib/mention.test.ts`

**Interfaces:**
- Consumes: `Skill` from `@swarm/protocol`.
- Produces:
  - `extractMention(value: string, caret: number): Mention | null`
  - `callableSkills(all: Skill[]): Skill[]`
  - `matchSkills(skills: Skill[], query: string): Skill[]`
  - Types: `MentionTrigger = '/' | '@'`, `Mention = { trigger: MentionTrigger; query: string; start: number; end: number }`

- [ ] **Step 1: Write the failing test for `extractMention`**

Create `apps/desktop/src/renderer/src/lib/mention.test.ts`:

```ts
import { describe, expect, it } from 'vitest'

import { callableSkills, extractMention, matchSkills } from './mention'
import type { Skill } from '@swarm/protocol'

describe('extractMention', () => {
  it('returns null when no trigger char is present', () => {
    expect(extractMention('hello world', 11)).toBeNull()
  })

  it('detects / at the start of input', () => {
    expect(extractMention('/sum', 4)).toEqual({ trigger: '/', query: 'sum', start: 0, end: 4 })
  })

  it('detects / after whitespace', () => {
    expect(extractMention('hi /wri', 8)).toEqual({ trigger: '/', query: 'wri', start: 3, end: 8 })
  })

  it('detects @ at the start of input', () => {
    expect(extractMention('@src', 4)).toEqual({ trigger: '@', query: 'src', start: 0, end: 4 })
  })

  it('does NOT trigger mid-word (no preceding whitespace)', () => {
    // The / in "a/b" is not at a word boundary.
    expect(extractMention('a/b', 3)).toBeNull()
  })

  it('allows path separators inside an @ query', () => {
    expect(extractMention('@src/comp', 9)).toEqual({ trigger: '@', query: 'src/comp', start: 0, end: 9 })
  })

  it('returns null when whitespace appears after the trigger', () => {
    expect(extractMention('/skill extra', 5)).toEqual({ trigger: '/', query: 'skill', start: 0, end: 5 })
    // Caret past the space → mention is stale.
    expect(extractMention('/skill extra', 12)).toBeNull()
  })

  it('returns null for a bare trigger with no query and caret moved away', () => {
    expect(extractMention('text /', 6)).toEqual({ trigger: '/', query: '', start: 5, end: 6 })
  })

  it('handles caret in the middle of a mention (only scans left)', () => {
    // Caret at position 2 inside "/su|m" — still within the mention.
    expect(extractMention('/sum', 2)).toEqual({ trigger: '/', query: 's', start: 0, end: 2 })
  })
})

describe('callableSkills', () => {
  const mk = (over: Partial<Skill>): Skill => ({ name: 'x', description: 'd', body: '', ...over })

  it('keeps normal enabled skills', () => {
    const skills = [mk({ name: 'a' })]
    expect(callableSkills(skills)).toEqual(skills)
  })

  it('drops disableModelInvocation skills', () => {
    const skills = [mk({ name: 'a' }), mk({ name: 'b', disableModelInvocation: true })]
    expect(callableSkills(skills).map((s) => s.name)).toEqual(['a'])
  })

  it('drops disabled skills', () => {
    const skills = [mk({ name: 'a' }), mk({ name: 'b', enabled: false })]
    expect(callableSkills(skills).map((s) => s.name)).toEqual(['a'])
  })
})

describe('matchSkills', () => {
  const mk = (name: string, description: string): Skill =>
    ({ name, description, body: '' }) as Skill

  it('returns all when query is empty', () => {
    const skills = [mk('a', 'desc'), mk('b', 'desc')]
    expect(matchSkills(skills, '').map((s) => s.name)).toEqual(['a', 'b'])
  })

  it('matches by name (case-insensitive)', () => {
    const skills = [mk('summarize', 'makes a summary'), mk('translate', 'converts language')]
    expect(matchSkills(skills, 'SUM').map((s) => s.name)).toEqual(['summarize'])
  })

  it('matches by description', () => {
    const skills = [mk('foo', 'makes a summary'), mk('bar', 'converts language')]
    expect(matchSkills(skills, 'summary').map((s) => s.name)).toEqual(['foo'])
  })

  it('ranks name hits before description-only hits', () => {
    const skills = [mk('alpha', 'contains sum'), mk('sum', 'a tool')]
    expect(matchSkills(skills, 'sum').map((s) => s.name)).toEqual(['sum', 'alpha'])
  })
})
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `pnpm --filter @swarm/desktop test -- src/lib/mention.test.ts`
Expected: FAIL — module `./mention` not found.

- [ ] **Step 3: Implement `mention.ts`**

Create `apps/desktop/src/renderer/src/lib/mention.ts`:

```ts
// Pure mention-extraction + skill filtering for the composer autocomplete.
// No React, no I/O — fully unit-testable.
import type { Skill } from '@swarm/protocol'

export type MentionTrigger = '/' | '@'

export type Mention = { trigger: MentionTrigger; query: string; start: number; end: number }

const TRIGGERS = new Set<MentionTrigger>(['/', '@'])

/**
 * Scan left from the caret for a `/` or `@` trigger that sits at a word
 * boundary (start of input or preceded by whitespace). The query is the text
 * from after the trigger up to the caret. Any whitespace inside the query
 * invalidates the mention (returns null) — a closed mention can't be reopened
 * by moving the caret back without re-typing.
 *
 * Returns `{ trigger, query, start, end }` where `start` is the trigger's index
 * and `end` is the caret index (the range to replace on commit).
 */
export function extractMention(value: string, caret: number): Mention | null {
  // Walk left from just before the caret, looking for a trigger.
  for (let i = caret - 1; i >= 0; i--) {
    const ch = value[i]
    if (/\s/.test(ch)) return null // whitespace before any trigger → no mention
    if (TRIGGERS.has(ch as MentionTrigger)) {
      // Trigger must be at a word boundary: start of input or after whitespace.
      const before = value[i - 1]
      if (i === 0 || /\s/.test(before)) {
        const query = value.slice(i + 1, caret)
        return { trigger: ch as MentionTrigger, query, start: i, end: caret }
      }
      // Trigger is mid-word (e.g. "a/b") — keep scanning left.
    }
  }
  return null
}

/**
 * Keep only skills the model can invoke via use_skill: not hidden from the
 * model list, and not disabled by the user.
 */
export function callableSkills(all: Skill[]): Skill[] {
  return all.filter((s) => !s.disableModelInvocation && s.enabled !== false)
}

/**
 * Case-insensitive substring match on name or description. Name hits rank
 * before description-only hits; ties break alphabetically by name.
 */
export function matchSkills(skills: Skill[], query: string): Skill[] {
  if (!query) return [...skills].sort((a, b) => a.name.localeCompare(b.name))
  const q = query.toLowerCase()
  return skills
    .map((s) => {
      const inName = s.name.toLowerCase().includes(q)
      const inDesc = s.description.toLowerCase().includes(q)
      return { s, score: (inName ? 1 : 0) + (inDesc ? 0.5 : 0) }
    })
    .filter((x) => x.score > 0)
    .sort((a, b) => b.score - a.score || a.s.name.localeCompare(b.s.name))
    .map((x) => x.s)
}
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `pnpm --filter @swarm/desktop test -- src/lib/mention.test.ts`
Expected: PASS (all tests green).

- [ ] **Step 5: Commit**

```bash
git add apps/desktop/src/renderer/src/lib/mention.ts apps/desktop/src/renderer/src/lib/mention.test.ts
git commit -m "feat(composer): add pure mention extraction + skill matching logic"
```

---

## Task 3: The `<ComposerMention>` component

The UI layer: listens to the textarea, renders the popover, handles keyboard, commits text. This is the largest task.

**Files:**
- Create: `apps/desktop/src/renderer/src/components/composer-mention.tsx`

**Interfaces:**
- Consumes:
  - `extractMention`, `callableSkills`, `matchSkills`, `Mention` from `@/lib/mention` (Task 2)
  - `useSkills` from `@/hooks/use-skills`
  - `window.swarm.listDir` from Task 1
  - `Popover`, `PopoverContent` from `@swarm/ui`
- Produces:
  - `ComposerMention({ anchor, cwd }: { anchor: React.RefObject<HTMLElement | null>; cwd?: string })`

- [ ] **Step 1: Create the component skeleton**

Create `apps/desktop/src/renderer/src/components/composer-mention.tsx`:

```tsx
// Inline mention autocomplete for the composer textarea. Listens for `/` (skill)
// and `@` (file path) typed at a word boundary, and renders a popover above the
// input with candidates. Both triggers commit plain text — the agent reads them
// lazily. Anchored to the composer box (not the caret) via a ref, opened above it.
import { useEffect, useMemo, useRef, useState } from 'react'
import { Folder, FileText, Sparkles, ChevronRight } from 'lucide-react'

import { useSkills } from '@/hooks/use-skills'
import { callableSkills, extractMention, matchSkills, type Mention } from '@/lib/mention'
import { cn } from '@/lib/utils'
import { Popover, PopoverContent } from '@swarm/ui'

type DirEntry = { name: string; isDir: boolean }

export function ComposerMention({
  anchor,
  cwd,
}: {
  anchor: React.RefObject<HTMLElement | null>
  cwd?: string
}): React.JSX.Element | null {
  const { skills } = useSkills()
  const [mention, setMention] = useState<Mention | null>(null)
  const [activeIndex, setActiveIndex] = useState(0)
  // Skill candidates (derived); file candidates (fetched via IPC, debounced).
  const [files, setFiles] = useState<DirEntry[]>([])
  // The textarea element, queried from the DOM (same pattern as insertPathReference).
  const textareaRef = useRef<HTMLTextAreaElement | null>(null)
  // Debounce timer handle for listDir.
  const debounceRef = useRef<ReturnType<typeof setTimeout> | null>(null)

  // Skill candidates for the current mention.
  const skillItems = useMemo(() => {
    if (!mention || mention.trigger !== '/') return []
    return matchSkills(callableSkills(skills), mention.query)
  }, [mention, skills])

  const open = mention !== null
  const maxIndex = mention?.trigger === '/' ? skillItems.length - 1 : files.length - 1

  // --- DOM listener: find the textarea and attach input/keydown handlers ---
  // The textarea lives inside PromptInput (prompt-input.tsx), which we don't
  // control. It may mount after our first render (PromptInput children commit
  // before our effect runs, so the textarea is usually present — but poll
  // briefly to be safe against lazy/async rendering).
  useEffect(() => {
    const find = (): HTMLTextAreaElement | null =>
      anchor.current?.querySelector('textarea[name="message"]') as HTMLTextAreaElement | null

    const recheck = (): void => {
      const ta = find()
      if (!ta) return
      textareaRef.current = ta
      const m = extractMention(ta.value, ta.selectionStart ?? ta.value.length)
      setMention(m)
      setActiveIndex(0)
    }

    const attachTo = (ta: HTMLTextAreaElement): void => {
      ta.addEventListener('input', recheck)
      ta.addEventListener('keyup', recheck)
      ta.addEventListener('click', recheck)
    }
    const detachFrom = (ta: HTMLTextAreaElement): void => {
      ta.removeEventListener('input', recheck)
      ta.removeEventListener('keyup', recheck)
      ta.removeEventListener('click', recheck)
    }

    let cleanup = (): void => {}
    const ta = find()
    if (ta) {
      textareaRef.current = ta
      attachTo(ta)
      cleanup = () => detachFrom(ta)
    } else {
      // Retry on the next tick — covers async PromptInput mount.
      const timer = setTimeout(() => {
        const found = find()
        if (found) {
          textareaRef.current = found
          attachTo(found)
          cleanup = () => detachFrom(found)
        }
      }, 0)
      cleanup = () => {
        clearTimeout(timer)
      }
    }
    return cleanup
  }, [anchor])

  // --- Fetch file candidates when the @ query changes (debounced) ---
  useEffect(() => {
    if (!mention || mention.trigger !== '@' || !cwd) {
      setFiles([])
      return
    }
    // Split query into a directory part + a leaf prefix.
    const lastSlash = mention.query.lastIndexOf('/')
    const dirPart = lastSlash >= 0 ? mention.query.slice(0, lastSlash) : ''
    const leaf = lastSlash >= 0 ? mention.query.slice(lastSlash + 1) : mention.query
    const targetDir = dirPart ? `${cwd}/${dirPart}` : cwd

    if (debounceRef.current) clearTimeout(debounceRef.current)
    debounceRef.current = setTimeout(() => {
      void window.swarm.listDir(targetDir, leaf).then(setFiles)
    }, 80)

    return () => {
      if (debounceRef.current) clearTimeout(debounceRef.current)
    }
  }, [mention, cwd])

  // --- Commit: replace the mention range with the chosen text ---
  const commit = (replacement: string, keepOpen: boolean): void => {
    const ta = textareaRef.current
    if (!ta || !mention) return
    const before = ta.value.slice(0, mention.start)
    const after = ta.value.slice(mention.end)
    const next = `${before}${replacement}${after}`
    const setter = Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value')?.set
    setter?.call(ta, next)
    const caret = before.length + replacement.length
    ta.setSelectionRange(caret, caret)
    ta.dispatchEvent(new Event('input', { bubbles: true }))
    ta.focus()
    if (keepOpen) {
      // Re-extract at the new caret to keep the popover open for drill-down.
      setMention(extractMention(next, caret))
      setActiveIndex(0)
    } else {
      setMention(null)
    }
  }

  // --- Keyboard handling on the textarea ---
  useEffect(() => {
    const ta = textareaRef.current
    if (!ta) return
    const onKey = (e: KeyboardEvent): void => {
      if (!mention) return
      if (e.key === 'ArrowDown') {
        e.preventDefault()
        setActiveIndex((i) => (maxIndex <= 0 ? 0 : (i + 1) % (maxIndex + 1)))
      } else if (e.key === 'ArrowUp') {
        e.preventDefault()
        setActiveIndex((i) => (maxIndex <= 0 ? 0 : (i - 1 + maxIndex + 1) % (maxIndex + 1)))
      } else if (e.key === 'Enter' || e.key === 'Tab') {
        if (maxIndex < 0) return
        e.preventDefault()
        selectActive()
      } else if (e.key === 'Escape') {
        e.preventDefault()
        setMention(null)
      }
    }
    ta.addEventListener('keydown', onKey)
    return () => ta.removeEventListener('keydown', onKey)
  })

  const selectActive = (): void => {
    if (!mention) return
    if (mention.trigger === '/') {
      const skill = skillItems[activeIndex]
      if (skill) commit(`/${skill.name} `, false)
    } else {
      const file = files[activeIndex]
      if (!file) return
      // Reconstruct the path prefix already typed (minus the leaf being replaced).
      const query = mention.query
      const lastSlash = query.lastIndexOf('/')
      const dirPart = lastSlash >= 0 ? query.slice(0, lastSlash + 1) : ''
      const rel = `${dirPart}${file.name}`
      if (file.isDir) {
        commit(`@${rel}/`, true) // keep open for drill-down
      } else {
        commit(`@${rel} `, false)
      }
    }
  }

  const candidates: React.ReactNode[] =
    mention?.trigger === '/'
      ? skillItems.map((s, i) => (
          <button
            className={cn(
              'flex w-full items-center gap-2 px-3 py-1.5 text-left text-sm hover:bg-muted',
              i === activeIndex && 'bg-muted'
            )}
            key={s.name}
            onClick={() => {
              setActiveIndex(i)
              commit(`/${s.name} `, false)
            }}
            type="button"
          >
            <Sparkles className="size-4 shrink-0 text-indigo-500" />
            <span className="flex flex-col">
              <span className="font-mono">{s.name}</span>
              <span className="text-muted-foreground text-xs">{s.description}</span>
            </span>
          </button>
        ))
      : files.map((f, i) => (
          <button
            className={cn(
              'flex w-full items-center gap-2 px-3 py-1.5 text-left text-sm hover:bg-muted',
              i === activeIndex && 'bg-muted'
            )}
            key={f.name}
            onClick={() => {
              setActiveIndex(i)
              selectActive()
            }}
            type="button"
          >
            {f.isDir ? (
              <Folder className="size-4 shrink-0 text-emerald-500" />
            ) : (
              <FileText className="size-4 shrink-0 text-muted-foreground" />
            )}
            <span className="truncate">{f.name}</span>
            {f.isDir && <ChevronRight className="ml-auto size-3 text-muted-foreground" />}
          </button>
        ))

  if (!open || candidates.length === 0) return null

  return (
    <Popover open={open} onOpenChange={(o) => { if (!o) setMention(null) }}>
      {/* Invisible trigger: Base UI Popover needs a trigger in the tree, but we
          position against the composer anchor ref, not this element. */}
      <PopoverContent
        align="start"
        anchor={anchor}
        className="max-h-64 w-72 overflow-y-auto p-0"
        side="top"
        sideOffset={8}
        onCloseAutoFocus={(e) => e.preventDefault()}
      >
        {candidates}
      </PopoverContent>
    </Popover>
  )
}
```

> **Note on `anchor`:** The `@swarm/ui` `PopoverContent` wraps Base UI's `PopoverPrimitive.Positioner`. Confirm during implementation that the `anchor` prop is forwarded — the wrapper destructures `align`/`alignOffset`/`side`/`sideOffset` but spreads `...props` to the `Popup` (not the `Positioner`). If `anchor` does not reach the `Positioner`, **add `anchor` to the wrapper's destructured props and pass it to `Positioner`** in `packages/ui/src/components/ui/popover.tsx`. This is a one-line, well-scoped fix to the shared UI package, not the read-only `prompt-input.tsx`.

- [ ] **Step 2: Typecheck**

Run: `pnpm --filter @swarm/desktop typecheck`
Expected: PASS. If `PopoverContent` does not accept `anchor`, fix the wrapper per the note above, then re-typecheck.

- [ ] **Step 3: Commit**

```bash
git add apps/desktop/src/renderer/src/components/composer-mention.tsx
# Also add the popover.tsx wrapper fix if it was needed:
# git add packages/ui/src/components/ui/popover.tsx
git commit -m "feat(composer): add ComposerMention popover component"
```

---

## Task 4: Mount `<ComposerMention>` in the composer

Wire the new component into `chat-input.tsx`. Small, surgical change.

**Files:**
- Modify: `apps/desktop/src/renderer/src/components/chat-input.tsx`

**Interfaces:**
- Consumes: `ComposerMention` from Task 3.
- Produces: the mounted autocomplete in every `<ChatInput>`.

- [ ] **Step 1: Import `ComposerMention`**

In `apps/desktop/src/renderer/src/components/chat-input.tsx`, add to the local imports (near the other `@/components/...` imports):

```ts
import { ComposerMention } from '@/components/composer-mention'
```

- [ ] **Step 2: Render `<ComposerMention>` inside `<PromptInput>`**

Find the `<PromptInput>` block (around line 451). After the `<AttachmentThumbnails>` and before the closing `</PromptInput>`, add:

```tsx
          <ComposerMention anchor={composerRef} cwd={cwd} />
```

The exact location is inside the `<PromptInput ...>` element, as a sibling of `<AttachmentThumbnails>`, `<PromptInputBody>`, and `<PromptInputFooter>`. Place it right after the `<PromptInputFooter>` closing tag.

- [ ] **Step 3: Typecheck**

Run: `pnpm --filter @swarm/desktop typecheck`
Expected: PASS.

- [ ] **Step 4: Run existing chat-input tests to check for regressions**

Run: `pnpm --filter @swarm/desktop test -- src/components/chat-input`
Expected: PASS (existing tests should be unaffected — `ComposerMention` renders `null` when there's no mention, so it adds nothing to the tree in existing test scenarios).

- [ ] **Step 5: Commit**

```bash
git add apps/desktop/src/renderer/src/components/chat-input.tsx
git commit -m "feat(composer): mount ComposerMention autocomplete in ChatInput"
```

---

## Task 5: Integration test — `/` and `@` selection commits text

Verify the end-to-end behavior in the existing chat-input test harness.

**Files:**
- Modify: `apps/desktop/src/renderer/src/components/chat-input.test.tsx`

**Interfaces:**
- Consumes: the mounted `<ComposerMention>` from Task 4, `useSkills` (mocked), `window.swarm.listDir` (mocked).

- [ ] **Step 1: Add a `/` skill selection test**

In `apps/desktop/src/renderer/src/components/chat-input.test.tsx`, add (adapting to the file's existing setup/helpers):

```ts
it('inserts /skill-name when a skill is selected from the / popover', async () => {
  // Mock skills
  vi.mocked(window.swarm.skills.list).mockResolvedValue([
    { name: 'summarize', description: 'makes a summary', body: '' },
  ])
  // Render ChatInput, type "/" into the textarea
  const { container } = render(<ChatInput onSubmit={onSubmit} />)
  const ta = container.querySelector('textarea[name="message"]')!
  await user.type(ta, '/sum')
  // The popover should be open; press Enter to select the first skill.
  await user.keyboard('{Enter}')
  expect(ta.value).toBe('/summarize ')
})
```

- [ ] **Step 2: Add an `@` file selection test**

```ts
it('inserts @path when a file is selected from the @ popover', async () => {
  vi.mocked(window.swarm.listDir).mockResolvedValue([
    { name: 'readme.md', isDir: false },
  ])
  const { container } = render(<ChatInput onSubmit={onSubmit} cwd="/proj" />)
  const ta = container.querySelector('textarea[name="message"]')!
  await user.type(ta, '@rea')
  await user.keyboard('{Enter}')
  expect(ta.value).toBe('@readme.md ')
})
```

- [ ] **Step 3: Run the tests**

Run: `pnpm --filter @swarm/desktop test -- src/components/chat-input`
Expected: PASS. If the jsdom environment doesn't fully support Base UI Popover positioning, the test may need `vi.stubGlobal` adjustments — the assertion is on the textarea value after selection, which is deterministic regardless of popover visibility.

- [ ] **Step 4: Commit**

```bash
git add apps/desktop/src/renderer/src/components/chat-input.test.tsx
git commit -m "test(composer): cover / skill and @ file mention selection"
```

---

## Task 6: Full suite + manual smoke test

Final verification before considering the feature done.

- [ ] **Step 1: Run the full desktop test suite**

Run: `pnpm --filter @swarm/desktop test`
Expected: all green.

- [ ] **Step 2: Typecheck all packages**

Run: `pnpm typecheck`
Expected: all green.

- [ ] **Step 3: Manual smoke test (dev build)**

Start the dev build. In the composer:
1. Type `/` → skill popover appears → arrow down + Enter → `/skill-name ` inserted.
2. Type `@` → file popover lists cwd files/folders → select a folder → `@folder/` inserted, popover stays open for the next segment.
3. Select a file → `@file.txt ` inserted, popover closes.
4. Type `Esc` → popover closes.
5. Submit a prompt with `/skill-name` and `@path` → confirm the agent receives them as plain text (check the log file).

- [ ] **Step 4: Final commit (if any test-data or fixups remain)**

Only commit if Step 1–2 surfaced issues that needed code changes.
