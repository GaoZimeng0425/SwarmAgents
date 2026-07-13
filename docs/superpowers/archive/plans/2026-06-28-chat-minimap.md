# Chat Conversation Minimap Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add a left-edge vertical tick rail to the chat thread — one tick per user turn — that highlights the turn in view, jumps to a turn on click, and shows the user message text on hover.

**Architecture:** A pure helper derives the user-turn list from `tasks`. A presentational `ConversationMinimap` renders an absolutely-positioned rail inside the existing relative `Conversation` container, tracks the active turn with an `IntersectionObserver` over the `[data-task-id]` elements the transcript already emits, and jumps via `scrollIntoView` (the same mechanism the thread's `focusTaskId` deep-link uses).

**Tech Stack:** React, TypeScript, Tailwind, base-ui tooltip (`@/components/ui/tooltip`), Vitest + @testing-library/react under jsdom (run via Electron node).

## Global Constraints

- Reply to the user in Chinese; code comments and commit messages in English (CLAUDE.md §0).
- Surgical changes only — touch only the files below (CLAUDE.md §3).
- Run tests with `npm test` — never bare `npx vitest`, never `pnpm rebuild better-sqlite3` (project memory).
- All scroll containers use the `ScrollArea` component, never raw `overflow-auto` (project memory). The rail here caps height and clips overflow rather than scrolling, so no ScrollArea is needed unless overflow scrolling is added.
- User message text is `task.goal`. Top-level user turns are `tasks` with no `parentTaskId`. (`TaskRecord` in `src/renderer/src/lib/apply-event.ts`.)
- Both user AND assistant messages carry `data-task-id={taskId}`; the user message renders first, so `document.querySelector('[data-task-id="X"]')` returns the user turn — the desired jump/observe target.

---

### Task 1: Pure helper `minimapItems`

**Files:**
- Create: `src/renderer/src/lib/minimap-items.ts`
- Test: `src/renderer/src/lib/minimap-items.test.ts`

**Interfaces:**
- Consumes: `TaskRecord` from `@/lib/apply-event` (`{ id: string; goal: string; startedAt: number; parentTaskId?: string }`).
- Produces: `type MinimapItem = { taskId: string; text: string; ts: number }` and `minimapItems(tasks: TaskRecord[]): MinimapItem[]`.

- [ ] **Step 1: Write the failing test**

```ts
// src/renderer/src/lib/minimap-items.test.ts
// @vitest-environment node
import { describe, expect, it } from 'vitest'

import type { TaskRecord } from './apply-event'
import { minimapItems } from './minimap-items'

function task(over: Partial<TaskRecord>): TaskRecord {
  return {
    id: 't',
    sessionId: 's1',
    goal: 'g',
    status: 'done',
    workerId: null,
    summary: null,
    startedAt: 0,
    attachments: [],
    events: [],
    ...over,
  }
}

describe('minimapItems', () => {
  it('returns [] for no tasks', () => {
    expect(minimapItems([])).toEqual([])
  })

  it('maps top-level tasks to {taskId, text, ts} ordered by startedAt', () => {
    const items = minimapItems([
      task({ id: 'b', goal: 'second', startedAt: 20 }),
      task({ id: 'a', goal: 'first', startedAt: 10 }),
    ])
    expect(items).toEqual([
      { taskId: 'a', text: 'first', ts: 10 },
      { taskId: 'b', text: 'second', ts: 20 },
    ])
  })

  it('excludes sub-agent tasks (parentTaskId set)', () => {
    const items = minimapItems([
      task({ id: 'top', startedAt: 1 }),
      task({ id: 'sub', startedAt: 2, parentTaskId: 'top' }),
    ])
    expect(items.map((i) => i.taskId)).toEqual(['top'])
  })
})
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npm test -- src/renderer/src/lib/minimap-items.test.ts`
Expected: FAIL — cannot resolve `./minimap-items` / `minimapItems is not a function`.

- [ ] **Step 3: Write minimal implementation**

```ts
// src/renderer/src/lib/minimap-items.ts
import type { TaskRecord } from './apply-event'

export type MinimapItem = { taskId: string; text: string; ts: number }

// One item per top-level user turn (sub-agent tasks carry parentTaskId and are
// excluded). The user message text is the task goal. Ordered oldest-first to
// match the transcript's top-to-bottom layout.
export function minimapItems(tasks: TaskRecord[]): MinimapItem[] {
  return tasks
    .filter((t) => !t.parentTaskId)
    .sort((a, b) => a.startedAt - b.startedAt)
    .map((t) => ({ taskId: t.id, text: t.goal, ts: t.startedAt }))
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npm test -- src/renderer/src/lib/minimap-items.test.ts`
Expected: PASS (3 tests).

- [ ] **Step 5: Commit**

```bash
git add src/renderer/src/lib/minimap-items.ts src/renderer/src/lib/minimap-items.test.ts
git commit -m "feat(chat): add minimapItems helper for user-turn navigation"
```

---

### Task 2: `ConversationMinimap` component

**Files:**
- Modify: `src/renderer/test-setup.ts` (add IntersectionObserver stub)
- Create: `src/renderer/src/components/conversation-minimap.tsx`
- Test: `src/renderer/src/components/conversation-minimap.test.tsx`

**Interfaces:**
- Consumes: `minimapItems` + `MinimapItem` from `@/lib/minimap-items`; `TaskRecord` from `@/lib/apply-event`; `Tooltip, TooltipContent, TooltipProvider, TooltipTrigger` from `@/components/ui/tooltip`; `cn` from `@/lib/utils`.
- Produces: `ConversationMinimap({ tasks }: { tasks: TaskRecord[] }): React.JSX.Element | null`. Returns `null` when fewer than 2 top-level turns exist.

- [ ] **Step 1: Add the IntersectionObserver stub to test-setup**

jsdom implements neither `ResizeObserver` (already stubbed) nor `IntersectionObserver`. Add the IO stub next to the existing ResizeObserver stub near the top of `src/renderer/test-setup.ts`:

```ts
// jsdom does not implement IntersectionObserver; ConversationMinimap observes
// user-turn elements to highlight the in-view tick. Provide a no-op stub so the
// component mounts in tests without crashing.
if (!globalThis.IntersectionObserver) {
  class IntersectionObserverStub {
    observe(): void {}
    unobserve(): void {}
    disconnect(): void {}
    takeRecords(): [] {
      return []
    }
  }
  globalThis.IntersectionObserver = IntersectionObserverStub as unknown as typeof IntersectionObserver
}
```

- [ ] **Step 2: Write the failing test**

```tsx
// src/renderer/src/components/conversation-minimap.test.tsx
// @vitest-environment jsdom
import '@testing-library/jest-dom/vitest'
import { cleanup, render, screen } from '@testing-library/react'
import { afterEach, describe, expect, it } from 'vitest'

import type { TaskRecord } from '@/lib/apply-event'
import { ConversationMinimap } from './conversation-minimap'

function task(over: Partial<TaskRecord>): TaskRecord {
  return {
    id: 't',
    sessionId: 's1',
    goal: 'g',
    status: 'done',
    workerId: null,
    summary: null,
    startedAt: 0,
    attachments: [],
    events: [],
    ...over,
  }
}

afterEach(cleanup)

describe('ConversationMinimap', () => {
  it('renders one tick per top-level turn', () => {
    render(
      <ConversationMinimap
        tasks={[
          task({ id: 'a', goal: 'first', startedAt: 1 }),
          task({ id: 'b', goal: 'second', startedAt: 2 }),
          task({ id: 'sub', goal: 'nested', startedAt: 3, parentTaskId: 'a' }),
        ]}
      />
    )
    expect(screen.getAllByRole('button')).toHaveLength(2)
  })

  it('renders nothing with fewer than 2 turns', () => {
    const { container } = render(<ConversationMinimap tasks={[task({ id: 'only' })]} />)
    expect(container).toBeEmptyDOMElement()
  })
})
```

- [ ] **Step 3: Run test to verify it fails**

Run: `npm test -- src/renderer/src/components/conversation-minimap.test.tsx`
Expected: FAIL — cannot resolve `./conversation-minimap`.

- [ ] **Step 4: Write the component**

```tsx
// src/renderer/src/components/conversation-minimap.tsx
import { useEffect, useMemo, useState } from 'react'

import { Tooltip, TooltipContent, TooltipProvider, TooltipTrigger } from '@/components/ui/tooltip'
import type { TaskRecord } from '@/lib/apply-event'
import { minimapItems } from '@/lib/minimap-items'
import { cn } from '@/lib/utils'

type Props = { tasks: TaskRecord[] }

// A left-edge vertical rail: one tick per user turn. Click a tick to jump to
// that turn; hover to preview its text; the in-view turn's tick is highlighted.
export function ConversationMinimap({ tasks }: Props): React.JSX.Element | null {
  const items = useMemo(() => minimapItems(tasks), [tasks])
  const [activeId, setActiveId] = useState<string | null>(null)
  // Stable dep: only changes when a turn is added/removed, not on every stream tick.
  const idsKey = items.map((it) => it.taskId).join('|')

  useEffect(() => {
    const ids = idsKey ? idsKey.split('|') : []
    if (ids.length < 2) return
    const els = ids
      .map((id) => document.querySelector<HTMLElement>(`[data-task-id="${id}"]`))
      .filter((el): el is HTMLElement => el !== null)
    if (els.length === 0) return

    // Active = the in-view turn closest to the viewport top. rootMargin trims the
    // bottom 60% so only turns near the top count as "current".
    const tops = new Map<string, number>()
    const observer = new IntersectionObserver(
      (entries) => {
        for (const e of entries) {
          const id = e.target.getAttribute('data-task-id')
          if (!id) continue
          if (e.isIntersecting) tops.set(id, e.boundingClientRect.top)
          else tops.delete(id)
        }
        let best: string | null = null
        let bestTop = Number.POSITIVE_INFINITY
        for (const [id, top] of tops) {
          if (top < bestTop) {
            bestTop = top
            best = id
          }
        }
        if (best) setActiveId(best)
      },
      { rootMargin: '0px 0px -60% 0px' }
    )
    for (const el of els) observer.observe(el)
    return () => observer.disconnect()
  }, [idsKey])

  if (items.length < 2) return null

  const jump = (taskId: string): void => {
    document
      .querySelector<HTMLElement>(`[data-task-id="${taskId}"]`)
      ?.scrollIntoView({ block: 'center', behavior: 'smooth' })
  }

  return (
    <TooltipProvider delay={150}>
      <nav
        aria-label="Conversation navigation"
        className="absolute bottom-6 left-2 z-20 flex max-h-[60%] flex-col justify-end gap-1.5 overflow-hidden"
      >
        {items.map((it) => {
          const active = it.taskId === activeId
          const label = it.text.trim() ? it.text : '(empty message)'
          const trigger = (
            <button
              aria-label={label.slice(0, 80)}
              className={cn(
                'h-0.5 rounded-full bg-muted-foreground/30 transition-all hover:bg-primary',
                active ? 'w-6 bg-primary' : 'w-4'
              )}
              onClick={() => jump(it.taskId)}
              type="button"
            />
          )
          return (
            <Tooltip key={it.taskId}>
              <TooltipTrigger render={trigger} />
              <TooltipContent align="end" side="right">
                <p className="line-clamp-4 max-w-xs whitespace-pre-wrap">{label}</p>
              </TooltipContent>
            </Tooltip>
          )
        })}
      </nav>
    </TooltipProvider>
  )
}
```

- [ ] **Step 5: Run test to verify it passes**

Run: `npm test -- src/renderer/src/components/conversation-minimap.test.tsx`
Expected: PASS (2 tests).

- [ ] **Step 6: Commit**

```bash
git add src/renderer/test-setup.ts src/renderer/src/components/conversation-minimap.tsx src/renderer/src/components/conversation-minimap.test.tsx
git commit -m "feat(chat): add ConversationMinimap user-turn navigation rail"
```

---

### Task 3: Wire the rail into the chat thread

**Files:**
- Modify: `src/renderer/src/components/conversation-thread.tsx`

**Interfaces:**
- Consumes: `ConversationMinimap` from `@/components/conversation-minimap`. The thread already holds `tasks: TaskRecord[]`.

- [ ] **Step 1: Add the import**

In `src/renderer/src/components/conversation-thread.tsx`, add to the import block (after the `ai-elements/conversation` import, line 11):

```tsx
import { ConversationMinimap } from '@/components/conversation-minimap'
```

- [ ] **Step 2: Render the rail inside the conversation**

In the non-empty return (currently lines 78–106), add `<ConversationMinimap tasks={tasks} />` as a sibling after `</ConversationContent>` and before `<ConversationScrollButton />`. The result reads:

```tsx
      </ConversationContent>
      <ConversationMinimap tasks={tasks} />
      <ConversationScrollButton />
    </Conversation>
```

`Conversation` is `position: relative` (see `ai-elements/conversation.tsx:15`), so the rail's `absolute bottom-6 left-2` anchors to the conversation viewport, clear of the bottom-center scroll button.

- [ ] **Step 3: Verify the full renderer suite passes**

Run: `npm test -- src/renderer`
Expected: PASS — existing thread/transcript tests still green, new minimap tests green.

- [ ] **Step 4: Visual check in the app**

Use the `run-desktop` skill to launch the app, open a session with several user messages, and confirm: the left rail shows one tick per user message; hovering a tick shows that message's text; clicking scrolls to the turn; the in-view turn's tick is highlighted; a session with 0–1 user messages shows no rail.

- [ ] **Step 5: Commit**

```bash
git add src/renderer/src/components/conversation-thread.tsx
git commit -m "feat(chat): render navigation minimap in conversation thread"
```

---

## Self-Review

**Spec coverage:**
- Bottom-left vertical rail → Task 2 (`absolute bottom-6 left-2`, `flex-col justify-end`).
- One tick per top-level user turn → Task 1 (`minimapItems` filter) + Task 2 (map).
- Hover shows user text → Task 2 (`Tooltip` with `it.text`).
- Click jumps to turn → Task 2 (`jump` → `scrollIntoView`).
- Active highlight → Task 2 (`IntersectionObserver` → `activeId`).
- Hidden when `< 2` turns → Task 1 input + Task 2 `return null`.
- Empty `goal` fallback → Task 2 (`'(empty message)'`).
- Sub-agents excluded → Task 1 filter, tested.
- Pure helper unit-tested → Task 1; light component test → Task 2.
- No new logging (renderer-only UI) → matches spec's Logging section.

**Placeholder scan:** none — every code/command step is concrete.

**Type consistency:** `MinimapItem` `{ taskId, text, ts }` defined in Task 1 and consumed unchanged in Task 2; `minimapItems(tasks)` signature identical across tasks; `ConversationMinimap({ tasks })` prop matches the Task 3 call site.
