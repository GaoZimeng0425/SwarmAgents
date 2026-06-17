# Memory in the right panel, tabbed with Work Plan

**Date:** 2026-06-16
**Status:** Approved (design)

## Goal

Surface the agent's persisted memory in the right-hand panel of the Tasks view,
switchable with the existing Work Plan via a tab control. Memory entries are
grouped by category, read-only, and update live as the agent writes memory.

## Background / current state

- The right panel is `PlanPanel` (`src/renderer/src/components/plan-panel.tsx`),
  rendered in `tasks-view.tsx:97` as `<PlanPanel todos={activePlan ?? []} />`.
  It owns its own `collapsed` state, renders a collapsed rail (w-12), and a
  Codex-style checklist when expanded. It is driven reactively by task events.
- A memory backend is mid-flight (concurrent work):
  - `src/service/memory-store.ts` holds an in-memory `MemoryEntry[]` flushed to a
    JSON file. Its `MemoryStore` interface **declares** `list(namespace?)` but the
    returned object does **not** implement it. The file is also **corrupted**: the
    module closes at line 123, then lines 124–137 are a duplicated, truncated copy
    of `forget`/`close` (`ndex((e) => e.id === id)` …). This breaks the oxc
    transform and fails `memory.test.ts` / `memory-store.test.ts` to parse.
  - `src/service/dispatcher.ts` has a `listMemory` case calling `cfg.listMemory`.
  - `src/shared/types/service-ipc.ts` lists `'listMemory'` as a `ServiceMethod`.
  - `src/shared/types/memory.ts` defines `MemoryView` (structurally identical to
    `MemoryEntry`: `id, namespace, key, content, category, timestamp`).
  - The renderer side is **not** wired: no `swarmApi.listMemory`, no preload
    bridge, no `memory:list` IPC handler, no `listMemory` on the service client.
- `src/renderer/src/components/ui/tabs.tsx` (shadcn) exists and is currently unused.

This spec completes the half-built read path and adds the UI.

## Decisions (locked)

1. **Backend scope:** complete the full read path end-to-end (fix corruption,
   implement `list()`, wire `listMemory` through to the renderer).
2. **Display:** grouped by category, read-only.
3. **Updates:** live, via a broadcast event.

## Architecture

### UI shape

```
 expanded:                      collapsed (rail):
┌─────────────────────────┐    ┌────┐
│ [ Plan ] [ Memory ]   ⟩ │    │ ⟨  │
├─────────────────────────┤    │ ☑  │  ListChecks + done/total
│ (active tab content)    │    │ 🧠 │  Brain (memory)
└─────────────────────────┘    └────┘
```

### Renderer components

- **`right-panel.tsx`** (new) — owns the shared `collapsed` state, the collapsed
  rail (both tab icons; plan keeps its done/total count badge), and, when
  expanded, the `Tabs` header (Plan | Memory) plus the active tab's content.
  Replaces `<PlanPanel>` in `tasks-view.tsx`. Pulls memory via `useMemory()`.
- **`PlanPanel` → content-only** — lift its `collapsed`/rail chrome up into
  `right-panel.tsx`; `PlanPanel` becomes a pure checklist body given `todos`.
  This refactor is required by the shared tab shell (not gratuitous cleanup).
- **`memory-panel.tsx`** (new) — pure presentational. Given `MemoryView[]`, groups
  by `category` with a section header per category; each row shows `key`,
  `content`, and a relative timestamp. Read-only. Calm style matching PlanPanel.
  Handles empty and error states.
- **`use-memory.ts`** (new) — React Query hook:
  `useQuery({ queryKey: MEMORY_KEY, queryFn: () => swarmApi.listMemory() })`.
  Exports `MEMORY_KEY` for invalidation.

### Backend / service

- **`src/service/memory-store.ts`**
  - Delete the corrupted tail (lines 124–137).
  - Implement `list(namespace?)` in the returned object: return entries
    (optionally filtered by `namespace`), sorted newest-first by `timestamp`.
  - Add an optional `onChange?: () => void` parameter to `createMemoryStore`;
    invoke it after mutation inside `store()` and `forget()`.
- **`src/service/index.ts`**
  - Ensure the broadcaster is constructed before the memory store, then create
    the store with `onChange: () => broadcaster.broadcast('memory.changed', { ts: Date.now() })`.
  - Pass `listMemory: (namespace?: string) => memoryStore.list(namespace)` into
    `createDispatcher({ … })`. `MemoryEntry` is structurally identical to
    `MemoryView`, so no mapping is needed.

### IPC chain (mirrors `listSkills`)

- **`src/main/service-client.ts`** — add `listMemory(namespace?): Promise<MemoryView[]>`
  to the `ServiceClient` type and implement as `call('listMemory', [namespace])`.
- **`src/main/ipc/swarm-ipc.ts`** — `ipcMain.handle('memory:list', (_e, ns) => serviceClient.listMemory(ns))`;
  add `ipcMain.removeHandler('memory:list')` to the dispose block.
- **`src/preload/index.ts`** — add a `memory` bridge:
  `memory: { list: (ns?) => ipcRenderer.invoke('memory:list', ns) as Promise<MemoryView[]> }`,
  plus its type on the exposed `swarm` object.
- **`src/renderer/src/lib/api.ts`** — `listMemory: (ns?) => window.swarm.memory.list(ns)`.

### Live-update typing

- **`src/shared/types/ui.ts`** — add `{ kind: 'memory.changed'; ts: number }` to the
  `UIEvent` union. `forward-event.ts` re-attaches the broadcast name as `kind`
  automatically, so no change is needed there.
- **`src/renderer/src/hooks/use-events-subscription.ts`** — on
  `e.kind === 'memory.changed'`, call `qc.invalidateQueries({ queryKey: MEMORY_KEY })`.

## Data flow

Live update:

```
agent memory tool → memoryStore.store() → onChange()
  → broadcaster.broadcast('memory.changed', { ts })
  → service parentPort 'event' frame
  → main service-client onEvent → toRendererEvent → webContents.send
  → preload subscribeEvents → useEventsSubscription
  → qc.invalidateQueries(MEMORY_KEY)
  → useMemory() refetch via memory:list IPC → MemoryPanel re-renders
```

Plan tab is unchanged: task events → `activePlan` prop → `PlanPanel`.

## Error handling

- `memoryStore.list()` reads an in-memory array and never throws.
- IPC / React Query failures put `useMemory()` into an error state; the Memory
  panel shows a small "Couldn't load memory — retry" affordance.

## Testing

- **`memory-store`**: `list()` returns newest-first; namespace filter works;
  `onChange` fires on `store()` and `forget()`. (Fixing the corruption also
  un-breaks the existing `memory.test.ts` parse failure.)
- **`dispatcher`**: a `listMemory` case test mirroring `dispatcher.test.ts`.
- **`memory-panel`**: grouping-by-category render test.

## Out of scope

- No delete/edit of memory from the panel (read-only); no `deleteMemory` IPC.
- No search/filter UI in the panel (recall remains an agent tool).

## Coordination risk

`dispatcher.ts` and `service-ipc.ts` already carry `listMemory` stubs from the
concurrent memory work, and this spec fixes the `memory-store.ts` corruption that
work left behind. If that effort is still active, we may collide on those three
files; coordinate before/while implementing.
