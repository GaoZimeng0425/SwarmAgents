# Memory Panel (tabbed with Work Plan) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Show the agent's persisted memory in the Tasks-view right panel, switchable with the Work Plan via tabs, grouped by category, read-only, updating live.

**Architecture:** Complete the half-built `listMemory` read path (service → IPC → preload → renderer), broadcast a `memory.changed` event on every write so a React Query hook refetches, and replace the standalone `PlanPanel` with a tabbed `RightPanel` shell that hosts a Plan body and a new Memory body.

**Tech Stack:** Electron (main + utilityProcess service + preload), React + TanStack Query + Zustand renderer, shadcn `ui/tabs`, pino logging, Vitest.

**Spec:** `docs/superpowers/specs/2026-06-16-memory-panel-design.md`

---

## File Structure

**Service / backend**
- Modify `src/service/memory-store.ts` — fix corruption, implement `list()`, add `onChange`.
- Modify `src/service/memory-store.test.ts` — tests for `list()` + `onChange`.
- Modify `src/service/index.ts` — wire `listMemory` + `onChange` broadcast.
- Modify `src/service/dispatcher.test.ts` — add `listMemory` to test deps + a case test.

**IPC / shared types**
- Modify `src/main/service-client.ts` — add `listMemory`.
- Modify `src/main/ipc/swarm-ipc.ts` — `memory:list` handler + dispose cleanup.
- Modify `src/shared/types/ui.ts` — `memory.changed` UIEvent + `MemoryBridge` + `swarm.memory`.
- Modify `src/preload/index.ts` — `memory` bridge implementation.

**Renderer**
- Modify `src/renderer/src/lib/api.ts` — `swarmApi.listMemory`.
- Create `src/renderer/src/hooks/use-memory.ts` — `MEMORY_KEY` + `useMemory()`.
- Modify `src/renderer/src/hooks/use-events-subscription.ts` — invalidate on `memory.changed`.
- Create `src/renderer/src/components/memory-panel.tsx` — grouped read-only body + `groupByCategory` helper.
- Create `src/renderer/src/components/memory-panel.test.ts` — `groupByCategory` unit test.
- Modify `src/renderer/src/components/plan-panel.tsx` — make content-only (drop collapse/rail).
- Create `src/renderer/src/components/right-panel.tsx` — collapse/rail + tabs shell.
- Modify `src/renderer/src/components/views/tasks-view.tsx` — render `RightPanel`.

---

## Task 1: memory-store — fix corruption, implement `list()`, add `onChange`

**Files:**
- Modify: `src/service/memory-store.ts`
- Test: `src/service/memory-store.test.ts`

- [ ] **Step 1: Add failing tests for `list()` and `onChange`**

Append these tests inside the `describe('createMemoryStore', …)` block in `src/service/memory-store.test.ts` (before the closing `})` on line 93):

```typescript
  it('list returns entries newest-first', () => {
    const { store, cleanup } = makeStore()
    try {
      store.store('ns', 'old', 'first entry', 'note')
      store.store('ns', 'new', 'second entry', 'note')
      const all = store.list()
      expect(all.map((e) => e.key)).toEqual(['new', 'old'])
    } finally {
      cleanup()
    }
  })

  it('list filters by namespace', () => {
    const { store, cleanup } = makeStore()
    try {
      store.store('ns-a', 'k1', 'a', 'note')
      store.store('ns-b', 'k2', 'b', 'note')
      const onlyA = store.list('ns-a')
      expect(onlyA.length).toBe(1)
      expect(onlyA[0].namespace).toBe('ns-a')
    } finally {
      cleanup()
    }
  })

  it('onChange fires on store and forget', () => {
    const dir = mkdtempSync(`${tmpdir()}/swarm-memory-test-`)
    const onChange = vi.fn()
    const store = createMemoryStore(join(dir, 'test.db'), onChange)
    try {
      store.store('ns', 'k1', 'data', 'note')
      expect(onChange).toHaveBeenCalledTimes(1)
      store.forget('ns', 'k1')
      expect(onChange).toHaveBeenCalledTimes(2)
      store.forget('ns', 'missing')
      expect(onChange).toHaveBeenCalledTimes(2) // no-op forget does not fire
    } finally {
      store.close()
    }
  })
```

Add `vi` to the vitest import at the top of the file:

```typescript
import { describe, expect, it, vi } from 'vitest'
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `npm test -- src/service/memory-store.test.ts`
Expected: the whole file currently FAILS to parse (PARSE_ERROR at `memory-store.ts:130`). That parse failure IS the first thing Step 3 fixes; after the file parses, the three new tests fail on missing `list`/`onChange` behavior.

- [ ] **Step 3: Fix corruption, implement `list()`, add `onChange`**

In `src/service/memory-store.ts`:

(a) Delete the corrupted duplicated tail — remove everything from line 124 (`ndex((e) => e.id === id)`) through the final line 137. The file must end at the existing line 123 `}` that closes `createMemoryStore`.

(b) Change the function signature to accept an optional callback:

```typescript
export function createMemoryStore(dbPath: string, onChange?: () => void): MemoryStore {
```

(c) In the returned `store(...)` method, add the notify call as the last statement (after `scheduleFlush()`):

```typescript
      log.debug({ msg: 'stored', namespace, key, category })
      scheduleFlush()
      onChange?.()
    },
```

(d) Add a `list` method to the returned object, immediately after `recall`:

```typescript
    list(namespace?: string): MemoryEntry[] {
      const filtered = namespace ? entries.filter((e) => e.namespace === namespace) : entries
      return [...filtered].sort((a, b) => b.timestamp - a.timestamp)
    },
```

(e) In `forget(...)`, fire `onChange` only on a real removal — add it just before `return true`:

```typescript
      tokenSets.delete(id)
      entries.splice(idx, 1)
      scheduleFlush()
      onChange?.()
      return true
    },
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `npm test -- src/service/memory-store.test.ts`
Expected: PASS (all existing tests + 3 new ones; the prior parse error is gone).

- [ ] **Step 5: Commit**

```bash
git add src/service/memory-store.ts src/service/memory-store.test.ts
git commit -m "fix(memory-store): repair corrupted tail, implement list(), add onChange"
```

---

## Task 2: Wire `listMemory` + `onChange` broadcast into the service

**Files:**
- Modify: `src/service/index.ts:38` (store creation) and `src/service/index.ts:69-79` (dispatcher config)

The `listMemory` case already exists in `src/service/dispatcher.ts`; this task supplies the config function it calls, and wires the change broadcast.

- [ ] **Step 1: Order the broadcaster before the memory store and pass `onChange`**

In `src/service/index.ts`, the broadcaster is currently created on line 40, after the memory store on line 38. Move the broadcaster declaration above the memory store and pass `onChange`. Replace lines 37-40:

```typescript
const store = createConversationStore(dbPath)
const memoryStore = createMemoryStore(memoryPath)
const skillStore = createSkillStore({ dir: skillsPath })
const broadcaster = createBroadcaster((event, data) => parentPort.postMessage({ kind: 'event', event, data }))
```

with:

```typescript
const store = createConversationStore(dbPath)
const broadcaster = createBroadcaster((event, data) => parentPort.postMessage({ kind: 'event', event, data }))
const memoryStore = createMemoryStore(memoryPath, () =>
  broadcaster.broadcast('memory.changed', { ts: Date.now() })
)
const skillStore = createSkillStore({ dir: skillsPath })
```

- [ ] **Step 2: Add `listMemory` to the dispatcher config**

In the `createDispatcher({ … })` call, add after the `deleteSkill` line (currently line 78):

```typescript
  deleteSkill: (name) => skillStore.remove(name),
  listMemory: (namespace) => memoryStore.list(namespace),
})
```

(`MemoryEntry` is structurally identical to `MemoryView`, so no mapping is needed; the dispatcher returns it directly.)

- [ ] **Step 3: Verify it typechecks**

Run: `npm run typecheck:node`
Expected: no errors. (Confirms `DispatcherConfig.listMemory` is satisfied and `memoryStore.list` exists.)

- [ ] **Step 4: Commit**

```bash
git add src/service/index.ts
git commit -m "feat(service): wire listMemory and memory.changed broadcast"
```

---

## Task 3: dispatcher test for `listMemory`

**Files:**
- Modify: `src/service/dispatcher.test.ts`

- [ ] **Step 1: Add `listMemory` to the shared test deps and a failing case test**

In `src/service/dispatcher.test.ts`, add `listMemory` to the `mcpDeps` helper (after `deleteSkill` on line 23):

```typescript
const mcpDeps = () => ({
  setMcpServers: vi.fn().mockResolvedValue(undefined),
  getMcpStatus: vi.fn().mockReturnValue([]),
  listSkills: vi.fn().mockReturnValue([]),
  saveSkill: vi.fn().mockReturnValue({ ok: true, skills: [] }),
  deleteSkill: vi.fn().mockReturnValue({ ok: true, skills: [] }),
  listMemory: vi.fn().mockReturnValue([]),
})
```

Add this test before the closing `})` of the `describe` block (line 88):

```typescript
  it('listMemory reads through with the namespace arg', () => {
    const deps = mcpDeps()
    deps.listMemory.mockReturnValue([{ id: 'ns:k', namespace: 'ns', key: 'k', content: 'c', category: 'note', timestamp: 1 }])
    const dispatch = createDispatcher({ manager: mockManager(), registerProvider: vi.fn(), ...deps })
    const result = dispatch('listMemory', ['ns'])
    expect(deps.listMemory).toHaveBeenCalledWith('ns')
    expect(result).toEqual([{ id: 'ns:k', namespace: 'ns', key: 'k', content: 'c', category: 'note', timestamp: 1 }])
  })
```

- [ ] **Step 2: Run the test**

Run: `npm test -- src/service/dispatcher.test.ts`
Expected: PASS (all existing tests still pass now that `mcpDeps` supplies `listMemory`, plus the new case).

- [ ] **Step 3: Commit**

```bash
git add src/service/dispatcher.test.ts
git commit -m "test(dispatcher): cover listMemory routing"
```

---

## Task 4: Service client `listMemory`

**Files:**
- Modify: `src/main/service-client.ts`

- [ ] **Step 1: Add `listMemory` to the `ServiceClient` type**

Add the import at the top (after line 5):

```typescript
import type { MemoryView } from '@shared/types/memory'
```

Add to the `ServiceClient` type, after the `deleteSkill` line (line 44):

```typescript
  deleteSkill(name: string): Promise<SkillMutationResult>
  listMemory(namespace?: string): Promise<MemoryView[]>
}
```

- [ ] **Step 2: Implement it in the returned object**

After the `deleteSkill(name) { … }` method (line 131), add:

```typescript
    deleteSkill(name) {
      return call('deleteSkill', [name])
    },
    listMemory(namespace) {
      return call('listMemory', [namespace])
    },
  }
```

- [ ] **Step 3: Verify it typechecks**

Run: `npm run typecheck:node`
Expected: no errors.

- [ ] **Step 4: Commit**

```bash
git add src/main/service-client.ts
git commit -m "feat(service-client): add listMemory"
```

---

## Task 5: Main IPC handler `memory:list`

**Files:**
- Modify: `src/main/ipc/swarm-ipc.ts`

- [ ] **Step 1: Register the handler**

Next to the skills handlers (after `ipcMain.handle('skills:delete', …)` on line 60), add:

```typescript
  ipcMain.handle('memory:list', (_e: Electron.IpcMainInvokeEvent, namespace?: string) =>
    serviceClient.listMemory(namespace)
  )
```

- [ ] **Step 2: Remove the handler on dispose**

In the `dispose()` block, after `ipcMain.removeHandler('skills:delete')` (line 207), add:

```typescript
      ipcMain.removeHandler('memory:list')
```

- [ ] **Step 3: Verify it typechecks**

Run: `npm run typecheck:node`
Expected: no errors.

- [ ] **Step 4: Commit**

```bash
git add src/main/ipc/swarm-ipc.ts
git commit -m "feat(ipc): add memory:list handler"
```

---

## Task 6: Shared types — `memory.changed` event + `MemoryBridge`

**Files:**
- Modify: `src/shared/types/ui.ts`

- [ ] **Step 1: Add the `memory.changed` UIEvent variant**

In the `UIEvent` union, after the `session.updated` line (line 73), add:

```typescript
  | { kind: 'session.updated'; sessionId: string; title: string | null; lastActiveAt: number; ts: number }
  | { kind: 'memory.changed'; ts: number }
```

- [ ] **Step 2: Add the `MemoryBridge` type and attach it to `SwarmBridge`**

Add the `MemoryView` import. At the top of `ui.ts`, after the existing `./task` import (line 14):

```typescript
import type { MemoryView } from './memory'
```

Define the bridge type just above `export type SwarmBridge = {` (line 148):

```typescript
export type MemoryBridge = {
  list(namespace?: string): Promise<MemoryView[]>
}
```

Add the field to `SwarmBridge`, after `skills: SkillBridge` (line 179):

```typescript
  skills: SkillBridge
  memory: MemoryBridge
}
```

- [ ] **Step 3: Verify it typechecks (will surface the missing preload impl next)**

Run: `npm run typecheck:node`
Expected: an error in `src/preload/index.ts` that `memory` is missing on the `swarm: SwarmBridge` object. That is expected and fixed in Task 7. (Type-only commit is fine; the build is restored in Task 7.)

- [ ] **Step 4: Commit**

```bash
git add src/shared/types/ui.ts
git commit -m "feat(types): add memory.changed event and MemoryBridge"
```

---

## Task 7: Preload `memory` bridge

**Files:**
- Modify: `src/preload/index.ts`

- [ ] **Step 1: Add the `memory` bridge object**

Mirror the `skills` bridge. After the `const skills: SkillBridge = { … }` block (line 90), add:

```typescript
const memory: MemoryBridge = {
  list: (namespace?: string) =>
    ipcRenderer.invoke('memory:list', namespace) as Promise<import('../shared/types/memory').MemoryView[]>,
}
```

- [ ] **Step 2: Attach it to the exposed `swarm` object**

In the `const swarm: SwarmBridge = { … }` object, add `memory` to the trailing bridge list (after `skills,` near line 134):

```typescript
  providers,
  mcp,
  skills,
  memory,
}
```

- [ ] **Step 3: Import the `MemoryBridge` type**

Add `MemoryBridge` to the existing type import from `../shared/types/ui` at the top of the file (it already imports `UIEvent`, `SwarmBridge`, etc. — add `MemoryBridge` to that import list).

- [ ] **Step 4: Verify it typechecks**

Run: `npm run typecheck:node`
Expected: no errors (the Task 6 gap is now closed).

- [ ] **Step 5: Commit**

```bash
git add src/preload/index.ts
git commit -m "feat(preload): expose swarm.memory.list bridge"
```

---

## Task 8: Renderer API `swarmApi.listMemory`

**Files:**
- Modify: `src/renderer/src/lib/api.ts`

- [ ] **Step 1: Add the method**

Add the `MemoryView` import at the top:

```typescript
import type { MemoryView } from '@shared/types/memory'
```

Add to the `swarmApi` object, after `setSessionPinned` (line 19):

```typescript
  listMemory: (namespace?: string): Promise<MemoryView[]> => window.swarm.memory.list(namespace),
}
```

- [ ] **Step 2: Verify it typechecks**

Run: `npm run typecheck:web`
Expected: no errors.

- [ ] **Step 3: Commit**

```bash
git add src/renderer/src/lib/api.ts
git commit -m "feat(api): add swarmApi.listMemory"
```

---

## Task 9: `useMemory` hook

**Files:**
- Create: `src/renderer/src/hooks/use-memory.ts`

- [ ] **Step 1: Create the hook**

```typescript
import type { MemoryView } from '@shared/types/memory'
import { useQuery } from '@tanstack/react-query'

import { swarmApi } from '@/lib/api'

export const MEMORY_KEY = ['memory'] as const

export function useMemory(): { entries: MemoryView[]; isError: boolean; refetch: () => void } {
  const { data, isError, refetch } = useQuery<MemoryView[]>({
    queryKey: MEMORY_KEY,
    queryFn: () => swarmApi.listMemory(),
  })
  return { entries: data ?? [], isError, refetch: () => void refetch() }
}
```

- [ ] **Step 2: Verify it typechecks**

Run: `npm run typecheck:web`
Expected: no errors.

- [ ] **Step 3: Commit**

```bash
git add src/renderer/src/hooks/use-memory.ts
git commit -m "feat(renderer): add useMemory hook"
```

---

## Task 10: Invalidate memory query on `memory.changed`

**Files:**
- Modify: `src/renderer/src/hooks/use-events-subscription.ts`

- [ ] **Step 1: Import `MEMORY_KEY`**

Add after the `TASKS_KEY` import (line 5):

```typescript
import { MEMORY_KEY } from '@/hooks/use-memory'
```

- [ ] **Step 2: Handle the event**

Inside the `subscribeEvents` callback, after the `session.created`/`session.updated` block (line 58, before the `task.permission_request` block), add:

```typescript
      if (e.kind === 'memory.changed') {
        void qc.invalidateQueries({ queryKey: MEMORY_KEY })
      }
```

- [ ] **Step 3: Verify it typechecks**

Run: `npm run typecheck:web`
Expected: no errors (the `memory.changed` variant from Task 6 makes `e.kind === 'memory.changed'` valid).

- [ ] **Step 4: Commit**

```bash
git add src/renderer/src/hooks/use-events-subscription.ts
git commit -m "feat(renderer): refetch memory on memory.changed"
```

---

## Task 11: Memory panel — grouping helper + component

**Files:**
- Create: `src/renderer/src/components/memory-panel.tsx`
- Create: `src/renderer/src/components/memory-panel.test.ts`

- [ ] **Step 1: Write the failing grouping test**

`src/renderer/src/components/memory-panel.test.ts`:

```typescript
import type { MemoryView } from '@shared/types/memory'
import { describe, expect, it } from 'vitest'

import { groupByCategory } from './memory-panel'

const entry = (over: Partial<MemoryView>): MemoryView => ({
  id: 'ns:k',
  namespace: 'ns',
  key: 'k',
  content: 'c',
  category: 'note',
  timestamp: 0,
  ...over,
})

describe('groupByCategory', () => {
  it('groups entries by category, newest-first within a group, groups sorted by label', () => {
    const groups = groupByCategory([
      entry({ id: '1', key: 'a', category: 'fact', timestamp: 1 }),
      entry({ id: '2', key: 'b', category: 'action', timestamp: 2 }),
      entry({ id: '3', key: 'c', category: 'fact', timestamp: 3 }),
    ])
    expect(groups.map((g) => g.category)).toEqual(['action', 'fact'])
    const fact = groups.find((g) => g.category === 'fact')!
    expect(fact.entries.map((e) => e.key)).toEqual(['c', 'a'])
  })

  it('returns an empty array for no entries', () => {
    expect(groupByCategory([])).toEqual([])
  })
})
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `npm test -- src/renderer/src/components/memory-panel.test.ts`
Expected: FAIL — cannot import `groupByCategory` (module/file does not exist yet).

- [ ] **Step 3: Create the component with the exported helper**

`src/renderer/src/components/memory-panel.tsx`:

```tsx
import type { MemoryView } from '@shared/types/memory'
import { Brain } from 'lucide-react'

import { ScrollArea } from '@/components/ui/scroll-area'

export type MemoryGroup = { category: string; entries: MemoryView[] }

/** Group memory entries by category; groups alphabetical, entries newest-first within each. */
export function groupByCategory(entries: MemoryView[]): MemoryGroup[] {
  const byCategory = new Map<string, MemoryView[]>()
  for (const e of entries) {
    const bucket = byCategory.get(e.category) ?? []
    bucket.push(e)
    byCategory.set(e.category, bucket)
  }
  return [...byCategory.entries()]
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([category, list]) => ({
      category,
      entries: [...list].sort((a, b) => b.timestamp - a.timestamp),
    }))
}

function relativeTime(ts: number): string {
  const secs = Math.max(0, Math.round((Date.now() - ts) / 1000))
  if (secs < 60) return `${secs}s ago`
  const mins = Math.round(secs / 60)
  if (mins < 60) return `${mins}m ago`
  const hours = Math.round(mins / 60)
  if (hours < 24) return `${hours}h ago`
  return `${Math.round(hours / 24)}d ago`
}

type Props = { entries: MemoryView[]; isError: boolean; onRetry: () => void }

/** Read-only memory list grouped by category. Lives inside RightPanel's Memory tab. */
export function MemoryPanel({ entries, isError, onRetry }: Props): React.JSX.Element {
  if (isError) {
    return (
      <div className="flex flex-col items-center justify-center gap-2 px-4 py-16 text-center text-muted-foreground/60">
        <Brain className="size-6 opacity-40" />
        <span className="text-[13px]">Couldn't load memory</span>
        <button className="text-[12px] text-primary hover:underline" onClick={onRetry} type="button">
          Retry
        </button>
      </div>
    )
  }
  const groups = groupByCategory(entries)
  return (
    <ScrollArea className="min-h-0 flex-1">
      {groups.length === 0 ? (
        <div className="flex flex-col items-center justify-center gap-2 px-4 py-16 text-center text-muted-foreground/60">
          <Brain className="size-6 opacity-40" />
          <span className="text-[13px]">No memory yet</span>
        </div>
      ) : (
        <div className="flex flex-col gap-5 px-4 py-6">
          {groups.map((g) => (
            <section className="flex flex-col gap-2" key={g.category}>
              <h4 className="font-bold text-[10px] text-muted-foreground/70 uppercase tracking-wider">{g.category}</h4>
              <ul className="flex flex-col gap-3">
                {g.entries.map((e) => (
                  <li className="flex flex-col gap-1" key={e.id}>
                    <div className="flex items-baseline justify-between gap-2">
                      <span className="font-semibold text-[12px] text-foreground/90">{e.key}</span>
                      <span className="shrink-0 text-[10px] text-muted-foreground/50 tabular-nums">
                        {relativeTime(e.timestamp)}
                      </span>
                    </div>
                    <span className="text-[13px] text-muted-foreground/80 leading-relaxed">{e.content}</span>
                  </li>
                ))}
              </ul>
            </section>
          ))}
        </div>
      )}
    </ScrollArea>
  )
}
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `npm test -- src/renderer/src/components/memory-panel.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/renderer/src/components/memory-panel.tsx src/renderer/src/components/memory-panel.test.ts
git commit -m "feat(renderer): add MemoryPanel with category grouping"
```

---

## Task 12: Make `PlanPanel` content-only

**Files:**
- Modify: `src/renderer/src/components/plan-panel.tsx`

The collapse state and collapsed rail move up to `RightPanel` (Task 13). `PlanPanel` becomes the expanded checklist body only (no outer `w-80`/`border-l` wrapper — `RightPanel` owns the frame and header).

- [ ] **Step 1: Replace the file contents**

```tsx
import type { PlanTodo } from '@shared/types/task'
import { Check, Circle, ListChecks, Loader2 } from 'lucide-react'

import { ScrollArea } from '@/components/ui/scroll-area'
import { cn } from '@/lib/utils'

type Props = { todos: PlanTodo[] }

/** Codex-style working plan checklist. Rendered inside RightPanel's Plan tab. */
export function PlanPanel({ todos }: Props): React.JSX.Element {
  return (
    <ScrollArea className="min-h-0 flex-1">
      {todos.length === 0 ? (
        <div className="flex flex-col items-center justify-center gap-2 px-4 py-16 text-center text-muted-foreground/60">
          <ListChecks className="size-6 opacity-40" />
          <span className="text-[13px]">No tasks yet</span>
        </div>
      ) : (
        <ul className="flex flex-col gap-2 px-4 py-6">
          {todos.map((t) => (
            <li className="group flex items-start gap-3" key={t.content}>
              <div className="mt-0.5 flex size-5 shrink-0 items-center justify-center rounded-full">
                {t.status === 'completed' ? (
                  <div className="flex size-5 items-center justify-center rounded-full bg-emerald-500/10">
                    <Check className="size-3 stroke-[3px] text-emerald-600" />
                  </div>
                ) : t.status === 'in_progress' ? (
                  <div className="flex size-5 items-center justify-center rounded-full bg-primary/10">
                    <Loader2 className="size-3 animate-spin text-primary" />
                  </div>
                ) : (
                  <div className="flex size-5 items-center justify-center rounded-full bg-muted/40">
                    <Circle className="size-2 fill-muted-foreground/10 text-muted-foreground/30" />
                  </div>
                )}
              </div>
              <span
                className={cn(
                  'text-[13px] leading-relaxed transition-colors',
                  t.status === 'completed' && 'text-muted-foreground/60 line-through',
                  t.status === 'in_progress' && 'font-semibold text-foreground',
                  t.status === 'pending' && 'text-muted-foreground/80'
                )}
              >
                {t.content}
              </span>
            </li>
          ))}
        </ul>
      )}
    </ScrollArea>
  )
}
```

- [ ] **Step 2: Verify it typechecks**

Run: `npm run typecheck:web`
Expected: an error in `tasks-view.tsx` is NOT expected yet (it still calls `<PlanPanel todos=… />`, which remains valid). Confirm `plan-panel.tsx` itself compiles. The `done` count moves to `RightPanel`.

- [ ] **Step 3: Commit**

```bash
git add src/renderer/src/components/plan-panel.tsx
git commit -m "refactor(plan-panel): reduce to content-only checklist body"
```

---

## Task 13: `RightPanel` shell with tabs

**Files:**
- Create: `src/renderer/src/components/right-panel.tsx`

- [ ] **Step 1: Create the tabbed shell**

```tsx
import type { PlanTodo } from '@shared/types/task'
import { Brain, ListChecks, PanelRightClose, PanelRightOpen } from 'lucide-react'
import { useState } from 'react'

import { MemoryPanel } from '@/components/memory-panel'
import { PlanPanel } from '@/components/plan-panel'
import { Button } from '@/components/ui/button'
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs'
import { useMemory } from '@/hooks/use-memory'

type Props = { plan: PlanTodo[] }

/** Collapsible right-hand panel hosting the Working Plan and Memory tabs. */
export function RightPanel({ plan }: Props): React.JSX.Element {
  const [collapsed, setCollapsed] = useState(true)
  const [tab, setTab] = useState<'plan' | 'memory'>('plan')
  const { entries, isError, refetch } = useMemory()
  const done = plan.filter((t) => t.status === 'completed').length

  if (collapsed) {
    return (
      <div className="flex h-full w-12 shrink-0 flex-col items-center gap-3 border-l bg-sidebar/50 py-4 backdrop-blur-sm">
        <Button
          aria-label="Expand panel"
          className="size-8 rounded-lg transition-colors hover:bg-primary/10 hover:text-primary"
          onClick={() => setCollapsed(false)}
          size="icon"
          variant="ghost"
        >
          <PanelRightOpen className="size-5" />
        </Button>
        <button
          aria-label="Open plan"
          className="flex flex-col items-center gap-1"
          onClick={() => {
            setTab('plan')
            setCollapsed(false)
          }}
          type="button"
        >
          <ListChecks className="size-5 text-primary/60" />
          {plan.length > 0 && (
            <span className="font-bold text-[10px] text-primary/80 tabular-nums">
              {done}/{plan.length}
            </span>
          )}
        </button>
        <button
          aria-label="Open memory"
          className="flex flex-col items-center gap-1"
          onClick={() => {
            setTab('memory')
            setCollapsed(false)
          }}
          type="button"
        >
          <Brain className="size-5 text-primary/60" />
        </button>
      </div>
    )
  }

  return (
    <div className="flex h-full w-80 shrink-0 flex-col border-l bg-sidebar/50 backdrop-blur-sm">
      <Tabs className="flex min-h-0 flex-1 flex-col gap-0" onValueChange={(v) => setTab(v as 'plan' | 'memory')} value={tab}>
        <div className="flex h-11 items-center justify-between border-border/40 border-b px-2">
          <TabsList className="bg-transparent">
            <TabsTrigger value="plan">Plan</TabsTrigger>
            <TabsTrigger value="memory">Memory</TabsTrigger>
          </TabsList>
          <Button
            aria-label="Collapse panel"
            className="size-7 rounded-lg text-muted-foreground transition-colors hover:bg-muted/50 hover:text-foreground"
            onClick={() => setCollapsed(true)}
            size="icon"
            variant="ghost"
          >
            <PanelRightClose className="size-4" />
          </Button>
        </div>
        <TabsContent className="flex min-h-0 flex-1 flex-col" value="plan">
          <PlanPanel todos={plan} />
        </TabsContent>
        <TabsContent className="flex min-h-0 flex-1 flex-col" value="memory">
          <MemoryPanel entries={entries} isError={isError} onRetry={refetch} />
        </TabsContent>
      </Tabs>
    </div>
  )
}
```

- [ ] **Step 2: Verify it typechecks**

Run: `npm run typecheck:web`
Expected: no errors (confirms the `ui/tabs` exports `Tabs/TabsList/TabsTrigger/TabsContent` and the props line up).

- [ ] **Step 3: Commit**

```bash
git add src/renderer/src/components/right-panel.tsx
git commit -m "feat(renderer): add tabbed RightPanel (Plan + Memory)"
```

---

## Task 14: Render `RightPanel` in the Tasks view

**Files:**
- Modify: `src/renderer/src/components/views/tasks-view.tsx:7` (import) and `:97` (render)

- [ ] **Step 1: Swap the import**

Replace line 7:

```typescript
import { PlanPanel } from '@/components/plan-panel'
```

with:

```typescript
import { RightPanel } from '@/components/right-panel'
```

- [ ] **Step 2: Swap the render**

Replace line 97:

```tsx
      <PlanPanel todos={activePlan ?? []} />
```

with:

```tsx
      <RightPanel plan={activePlan ?? []} />
```

- [ ] **Step 3: Verify it typechecks**

Run: `npm run typecheck:web`
Expected: no errors.

- [ ] **Step 4: Commit**

```bash
git add src/renderer/src/components/views/tasks-view.tsx
git commit -m "feat(renderer): mount RightPanel in tasks view"
```

---

## Task 15: Full verification

**Files:** none (verification only)

- [ ] **Step 1: Typecheck both projects**

Run: `npm run typecheck`
Expected: both `typecheck:node` and `typecheck:web` pass with no errors.

- [ ] **Step 2: Run the whole test suite**

Run: `npm test`
Expected: all test files pass — including `memory-store.test.ts`, `dispatcher.test.ts`, and `memory-panel.test.ts`. The pre-existing `memory.test.ts` / `memory-store.test.ts` parse failure must be gone.

- [ ] **Step 3: Lint the changed files**

Run: `npx biome check --write src/service/memory-store.ts src/service/index.ts src/main/service-client.ts src/main/ipc/swarm-ipc.ts src/shared/types/ui.ts src/preload/index.ts src/renderer/src/lib/api.ts src/renderer/src/hooks/use-memory.ts src/renderer/src/hooks/use-events-subscription.ts src/renderer/src/components/memory-panel.tsx src/renderer/src/components/plan-panel.tsx src/renderer/src/components/right-panel.tsx src/renderer/src/components/views/tasks-view.tsx`
Expected: no remaining diagnostics (auto-fixes applied). Commit any formatting changes.

- [ ] **Step 4: Manual smoke test (run the app)**

Use the `run-desktop` skill to launch the app. Verify:
- The right panel rail shows both the plan (☑) and memory (🧠) icons; clicking either expands to that tab.
- The expanded panel shows `Plan | Memory` tabs; switching works.
- With memory present (run an agent task that writes memory, or pre-seed the memory JSON), the Memory tab lists entries grouped by category.
- Writing new memory updates the Memory tab live without a manual refresh (confirms the `memory.changed` → invalidate path).

- [ ] **Step 5: Final commit (if lint produced changes)**

```bash
git add -A
git commit -m "chore: format memory-panel feature files"
```
