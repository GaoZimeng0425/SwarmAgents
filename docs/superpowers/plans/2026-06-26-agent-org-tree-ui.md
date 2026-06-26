# Agent Org Tree UI Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace the hardcoded 3-layer agent org chart with a recursive indented tree driven by `buildOrgForest`, drop the redundant card grid, and extract a shared `<AgentDetail>` — after first landing the existing live-reload WIP as its own commit.

**Architecture:** A thin `AgentsView` does the query + `agents.changed` subscription and renders a prop-driven `<OrgTreeView agents={...} />`. `OrgTreeView` owns single-select state and composes `<OrgTree>` (recursive indented render of `buildOrgForest(agents)`) with one `<AgentDetail>` for the selected agent. All logic-bearing components are prop-driven so they test directly with React Testing Library (matching the repo's prop-driven component-test precedent).

**Tech Stack:** React, @tanstack/react-query, Tailwind utility classes, vitest + @testing-library/react (jsdom env for `src/renderer/**`).

## Global Constraints

- UI-only. No backend, directory, `find_agents`, `deriveAllowlist`, CRUD, or delegation-graph changes.
- Tree structure comes ONLY from `buildOrgForest` (`@shared/agents/org-tree`); do not re-derive hierarchy in the view.
- Capabilities: show the first 3, then `+M more` when there are more than 3 — never silently truncate.
- Code comments and commit messages in English.
- Tests run with: `npm test -- <path-filter>` (never bare `npx vitest`; the script wraps vitest in Electron-as-node). Renderer tests run under jsdom automatically via `environmentMatchGlobs`.
- Import aliases: `@shared/...` for shared types/logic, `@/...` for renderer-local modules.
- Single-select: clicking the selected node again clears the selection.

---

### Task 1: Land live-reload as its own commit (pre-step)

The working tree already contains the user's live-reload WIP across 4 files. This task lands the live-reload feature alone: the 3 backend files as-is, and `agents-view.tsx` reduced to the ORIGINAL card grid plus the `agents.changed` subscription (the WIP's first-cut org chart is NOT included — Task 4 builds the new tree).

**Files:**
- Keep as-is (already modified in working tree): `src/service/agents/store.ts`, `src/service/index.ts`, `src/shared/types/ui.ts`
- Overwrite: `src/renderer/src/components/views/agents-view.tsx` (original card grid + subscription only)

**Interfaces:**
- Consumes: `swarmApi.subscribeEvents((e: UIEvent) => void): () => void`; `UIEvent` includes `{ kind: 'agents.changed'; ts: number }` (from the backend WIP).
- Produces: an `agents-view.tsx` whose query invalidates on `agents.changed`. Task 4 replaces its body with `<OrgTreeView>`.

- [ ] **Step 1: Overwrite `agents-view.tsx` with the card grid + subscription**

Write `src/renderer/src/components/views/agents-view.tsx` exactly:

```tsx
import { useEffect, useState } from 'react'
import { useQuery, useQueryClient } from '@tanstack/react-query'

import { swarmApi } from '@/lib/api'
import { cn } from '@/lib/utils'
import { SettingsHeader } from './settings-primitives'

export function AgentsView(): React.JSX.Element {
  const queryClient = useQueryClient()
  const { data: agents, isLoading } = useQuery({
    queryKey: ['agents', 'settings'],
    queryFn: () => swarmApi.listAgents(),
    staleTime: 60_000,
  })
  const [expanded, setExpanded] = useState<string | null>(null)

  // Hot-reload: invalidate the query when agent files change on disk
  // (the agents store watches its directory and broadcasts `agents.changed`).
  useEffect(
    () =>
      swarmApi.subscribeEvents((e) => {
        if (e.kind === 'agents.changed') {
          void queryClient.invalidateQueries({ queryKey: ['agents', 'settings'] })
        }
      }),
    [queryClient]
  )

  return (
    <div className="space-y-4">
      <SettingsHeader
        title="Agents"
        description="Specialised sub-agents the main agent can delegate to. Each card shows the agent's role and capabilities; click to view its full system prompt."
      />

      {isLoading ? (
        <p className="text-muted-foreground text-sm">Loading agents…</p>
      ) : !agents || agents.length === 0 ? (
        <p className="text-muted-foreground text-sm">No agents available.</p>
      ) : (
        <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
          {agents.map((a) => {
            const isOpen = expanded === a.id
            return (
              <div
                className={cn('rounded-xl border bg-card p-4', isOpen && 'sm:col-span-2 lg:col-span-3')}
                key={a.id}
              >
                <div className="flex items-start gap-3">
                  <button
                    className="min-w-0 flex-1 text-left"
                    onClick={() => setExpanded(isOpen ? null : a.id)}
                    type="button"
                  >
                    <p className="truncate font-medium text-sm">{a.name}</p>
                    <p className="truncate font-mono text-muted-foreground text-xs">{a.id}</p>
                    <p className={cn('text-muted-foreground text-sm', !isOpen && 'line-clamp-2')}>
                      {a.description}
                    </p>
                  </button>
                </div>

                <div className="mt-2 flex flex-wrap items-center gap-1.5">
                  {a.team && (
                    <span className="rounded bg-primary/10 px-1.5 py-0.5 font-medium text-primary text-xs">
                      {a.team}
                    </span>
                  )}
                  {a.role && (
                    <span className="rounded bg-secondary px-1.5 py-0.5 font-medium text-secondary-foreground text-xs">
                      {a.role}
                    </span>
                  )}
                  {a.toolScope && (
                    <span className="text-muted-foreground text-xs">scope: {a.toolScope}</span>
                  )}
                </div>

                {isOpen && (
                  <div className="mt-3 flex flex-col gap-3 border-t pt-3">
                    {a.systemPrompt && (
                      <pre className="overflow-x-auto whitespace-pre-wrap rounded bg-muted p-3 font-mono text-xs">
                        {a.systemPrompt}
                      </pre>
                    )}
                  </div>
                )}
              </div>
            )
          })}
        </div>
      )}
    </div>
  )
}
```

- [ ] **Step 2: Typecheck and run the full suite**

Run: `npx tsc --noEmit -p tsconfig.node.json && npm test 2>&1 | tail -4`
Expected: typecheck exits 0; suite passes (720+ tests, 0 failures). No new tests here — the live-reload watcher is existing WIP; a chokidar timing test would be flaky and is out of scope.

- [ ] **Step 3: Commit live-reload only**

```bash
git add src/service/agents/store.ts src/service/index.ts src/shared/types/ui.ts src/renderer/src/components/views/agents-view.tsx
git commit -m "feat(agents): live-reload the Agents view when agent files change on disk"
```

Note: this stages exactly the 4 live-reload files. Any other working-tree changes are left untouched.

---

### Task 2: Extract shared `<AgentDetail>` component

**Files:**
- Create: `src/renderer/src/components/views/agent-detail.tsx`
- Test: `src/renderer/src/components/views/agent-detail.test.tsx`

**Interfaces:**
- Consumes: `AgentDefinition` from `@shared/types/agent`.
- Produces: `export function AgentDetail({ agent }: { agent: AgentDefinition }): React.JSX.Element` — renders name, id, description, and (when present) the systemPrompt in a `<pre>`.

- [ ] **Step 1: Write the failing test**

Create `src/renderer/src/components/views/agent-detail.test.tsx`:

```tsx
import '@testing-library/jest-dom/vitest'
import type { AgentDefinition } from '@shared/types/agent'
import { cleanup, render, screen } from '@testing-library/react'
import { afterEach, describe, expect, it } from 'vitest'

import { AgentDetail } from './agent-detail'

const agent: AgentDefinition = {
  id: 'pm',
  name: 'Product Manager',
  description: 'Plans the work.',
  systemPrompt: 'You are the PM.',
  toolScope: 'all',
  maxIterations: 25,
}

afterEach(cleanup)

describe('AgentDetail', () => {
  it('shows the name, id, description and system prompt', () => {
    render(<AgentDetail agent={agent} />)
    expect(screen.getByText('Product Manager')).toBeInTheDocument()
    expect(screen.getByText('pm')).toBeInTheDocument()
    expect(screen.getByText('Plans the work.')).toBeInTheDocument()
    expect(screen.getByText('You are the PM.')).toBeInTheDocument()
  })
})
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npm test -- src/renderer/src/components/views/agent-detail.test.tsx`
Expected: FAIL — `./agent-detail` does not exist (import error).

- [ ] **Step 3: Implement `AgentDetail`**

Create `src/renderer/src/components/views/agent-detail.tsx`:

```tsx
import type { AgentDefinition } from '@shared/types/agent'

/** Detail panel for a single agent: name, id, description, and full system
 *  prompt. Single source for the agent detail view (previously duplicated). */
export function AgentDetail({ agent }: { agent: AgentDefinition }): React.JSX.Element {
  return (
    <div className="mt-4 border-t pt-3">
      <div className="flex items-center gap-2">
        <p className="font-medium text-sm">{agent.name}</p>
        <p className="font-mono text-muted-foreground text-xs">{agent.id}</p>
      </div>
      <p className="mt-1 text-muted-foreground text-sm">{agent.description}</p>
      {agent.systemPrompt && (
        <pre className="mt-2 overflow-x-auto whitespace-pre-wrap rounded bg-muted p-3 font-mono text-xs">
          {agent.systemPrompt}
        </pre>
      )}
    </div>
  )
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npm test -- src/renderer/src/components/views/agent-detail.test.tsx`
Expected: PASS (1 test).

- [ ] **Step 5: Commit**

```bash
git add src/renderer/src/components/views/agent-detail.tsx src/renderer/src/components/views/agent-detail.test.tsx
git commit -m "feat(agents): extract shared AgentDetail component"
```

---

### Task 3: Recursive `OrgTree` (indented tree) + `OrgTreeView`

**Files:**
- Create: `src/renderer/src/components/views/org-tree-view.tsx`
- Test: `src/renderer/src/components/views/org-tree-view.test.tsx`

**Interfaces:**
- Consumes: `buildOrgForest` and `OrgNode` from `@shared/agents/org-tree`; `AgentDefinition` from `@shared/types/agent`; `AgentDetail` from `./agent-detail` (Task 2); `cn` from `@/lib/utils`.
- Produces:
  - `export function OrgTree({ agents, expanded, onToggle }: { agents: AgentDefinition[]; expanded: string | null; onToggle: (id: string) => void }): React.JSX.Element`
  - `export function OrgTreeView({ agents }: { agents: AgentDefinition[] }): React.JSX.Element` — owns single-select state, renders `<OrgTree>` + `<AgentDetail>` for the selection. Consumed by Task 4.

- [ ] **Step 1: Write the failing tests**

Create `src/renderer/src/components/views/org-tree-view.test.tsx`:

```tsx
import '@testing-library/jest-dom/vitest'
import type { AgentDefinition } from '@shared/types/agent'
import { cleanup, fireEvent, render, screen, within } from '@testing-library/react'
import { afterEach, describe, expect, it } from 'vitest'

import { OrgTree, OrgTreeView } from './org-tree-view'

const a = (over: Partial<AgentDefinition> & { id: string }): AgentDefinition => ({
  name: over.id,
  description: 'd',
  systemPrompt: `prompt-${over.id}`,
  toolScope: 'all',
  maxIterations: 25,
  ...over,
})

afterEach(cleanup)

describe('OrgTree', () => {
  it('renders children nested inside their parent (multi-level parentId)', () => {
    render(
      <OrgTree
        agents={[
          a({ id: 'ceo', name: 'CEO', role: 'ceo' }),
          a({ id: 'pm', name: 'PM', parentId: 'ceo' }),
          a({ id: 'engineer', name: 'Engineer', parentId: 'pm' }),
        ]}
        expanded={null}
        onToggle={() => {}}
      />
    )
    const pmItem = screen.getByText('PM').closest('li') as HTMLElement
    expect(within(pmItem).getByText('Engineer')).toBeInTheDocument()
    const ceoItem = screen.getByText('CEO').closest('li') as HTMLElement
    expect(within(ceoItem).getByText('PM')).toBeInTheDocument()
  })

  it('reproduces CEO -> head -> members from team/teamRole when parentId is absent', () => {
    render(
      <OrgTree
        agents={[
          a({ id: 'ceo', name: 'CEO', role: 'ceo' }),
          a({ id: 'pm', name: 'PM', role: 'pm', team: 'dev', teamRole: 'head' }),
          a({ id: 'engineer', name: 'Engineer', role: 'engineer', team: 'dev' }),
        ]}
        expanded={null}
        onToggle={() => {}}
      />
    )
    const pmItem = screen.getByText('PM').closest('li') as HTMLElement
    expect(within(pmItem).getByText('Engineer')).toBeInTheDocument()
  })

  it('shows the first 3 capabilities plus a "+N more" affordance', () => {
    render(
      <OrgTree
        agents={[a({ id: 'x', name: 'X', capabilities: ['c1', 'c2', 'c3', 'c4', 'c5'] })]}
        expanded={null}
        onToggle={() => {}}
      />
    )
    expect(screen.getByText('c1')).toBeInTheDocument()
    expect(screen.getByText('c3')).toBeInTheDocument()
    expect(screen.queryByText('c4')).not.toBeInTheDocument()
    expect(screen.getByText('+2 more')).toBeInTheDocument()
  })

  it('renders a team-less childless non-CEO agent under Independent Agents', () => {
    render(
      <OrgTree
        agents={[
          a({ id: 'ceo', name: 'CEO', role: 'ceo' }),
          a({ id: 'researcher', name: 'Researcher', role: 'researcher' }),
        ]}
        expanded={null}
        onToggle={() => {}}
      />
    )
    const group = screen.getByText('Independent Agents').closest('div') as HTMLElement
    expect(within(group).getByText('Researcher')).toBeInTheDocument()
  })
})

describe('OrgTreeView', () => {
  it('shows the selected agent detail on click and hides it on a second click', () => {
    render(<OrgTreeView agents={[a({ id: 'pm', name: 'PM' })]} />)
    const card = (): HTMLElement => screen.getByRole('button', { name: /PM/ })
    expect(screen.queryByText('prompt-pm')).not.toBeInTheDocument()
    fireEvent.click(card())
    expect(screen.getByText('prompt-pm')).toBeInTheDocument()
    fireEvent.click(card())
    expect(screen.queryByText('prompt-pm')).not.toBeInTheDocument()
  })
})
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npm test -- src/renderer/src/components/views/org-tree-view.test.tsx`
Expected: FAIL — `./org-tree-view` does not exist (import error).

- [ ] **Step 3: Implement `org-tree-view.tsx`**

Create `src/renderer/src/components/views/org-tree-view.tsx`:

```tsx
import { useState } from 'react'

import { type OrgNode, buildOrgForest } from '@shared/agents/org-tree'
import type { AgentDefinition } from '@shared/types/agent'
import { cn } from '@/lib/utils'
import { AgentDetail } from './agent-detail'

const MAX_CAPS = 3

/** One agent card: name, role/id, team + scope badges, capped capabilities. */
function AgentNodeCard({
  agent,
  isActive,
  onClick,
}: {
  agent: AgentDefinition
  isActive: boolean
  onClick: () => void
}): React.JSX.Element {
  const caps = agent.capabilities ?? []
  const shown = caps.slice(0, MAX_CAPS)
  const extra = caps.length - shown.length
  return (
    <button
      type="button"
      onClick={onClick}
      className={cn(
        'w-full rounded-lg border bg-card p-2.5 text-left transition-colors hover:bg-accent',
        isActive && 'border-primary ring-1 ring-primary'
      )}
    >
      <div className="flex items-center gap-2">
        <span className="truncate font-medium text-sm">{agent.name}</span>
        <span className="truncate font-mono text-muted-foreground text-xs">{agent.role ?? agent.id}</span>
      </div>
      <div className="mt-1 flex flex-wrap items-center gap-1.5">
        {agent.team && (
          <span className="rounded bg-primary/10 px-1.5 py-0.5 font-medium text-primary text-xs">{agent.team}</span>
        )}
        <span className="text-muted-foreground text-xs">scope: {agent.toolScope}</span>
        {shown.map((c) => (
          <span key={c} className="rounded bg-secondary px-1 py-0.5 text-secondary-foreground text-[10px]">
            {c}
          </span>
        ))}
        {extra > 0 && <span className="text-muted-foreground text-[10px]">+{extra} more</span>}
      </div>
    </button>
  )
}

/** Recursive node: a card plus an indented, guide-lined list of children. */
function OrgTreeNode({
  node,
  expanded,
  onToggle,
}: {
  node: OrgNode
  expanded: string | null
  onToggle: (id: string) => void
}): React.JSX.Element {
  return (
    <li>
      <AgentNodeCard
        agent={node.agent}
        isActive={expanded === node.agent.id}
        onClick={() => onToggle(node.agent.id)}
      />
      {node.children.length > 0 && (
        <ul className="mt-1 ml-4 flex flex-col gap-1 border-l pl-3">
          {node.children.map((child) => (
            <OrgTreeNode key={child.agent.id} node={child} expanded={expanded} onToggle={onToggle} />
          ))}
        </ul>
      )}
    </li>
  )
}

/** Indented org tree from buildOrgForest. Hierarchy trees first, then a
 *  flat "Independent Agents" group for team-less, childless, non-CEO roots. */
export function OrgTree({
  agents,
  expanded,
  onToggle,
}: {
  agents: AgentDefinition[]
  expanded: string | null
  onToggle: (id: string) => void
}): React.JSX.Element {
  const forest = buildOrgForest(agents)
  const isIndependent = (n: OrgNode): boolean =>
    n.children.length === 0 && n.agent.role !== 'ceo' && !n.agent.team
  const hierarchy = forest.filter((n) => !isIndependent(n))
  const independents = forest.filter(isIndependent)
  return (
    <div className="flex flex-col gap-4 overflow-x-auto">
      <ul className="flex flex-col gap-1">
        {hierarchy.map((node) => (
          <OrgTreeNode key={node.agent.id} node={node} expanded={expanded} onToggle={onToggle} />
        ))}
      </ul>
      {independents.length > 0 && (
        <div className="flex flex-col gap-1">
          <span className="font-medium text-muted-foreground text-xs uppercase tracking-wide">
            Independent Agents
          </span>
          <ul className="flex flex-col gap-1">
            {independents.map((node) => (
              <OrgTreeNode key={node.agent.id} node={node} expanded={expanded} onToggle={onToggle} />
            ))}
          </ul>
        </div>
      )}
    </div>
  )
}

/** Stateful wrapper: single-select org tree with a detail panel below. */
export function OrgTreeView({ agents }: { agents: AgentDefinition[] }): React.JSX.Element {
  const [expanded, setExpanded] = useState<string | null>(null)
  const toggle = (id: string): void => setExpanded((prev) => (prev === id ? null : id))
  const selected = expanded ? agents.find((agent) => agent.id === expanded) : undefined
  return (
    <div>
      <OrgTree agents={agents} expanded={expanded} onToggle={toggle} />
      {selected && <AgentDetail agent={selected} />}
    </div>
  )
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `npm test -- src/renderer/src/components/views/org-tree-view.test.tsx`
Expected: PASS (5 tests).

- [ ] **Step 5: Commit**

```bash
git add src/renderer/src/components/views/org-tree-view.tsx src/renderer/src/components/views/org-tree-view.test.tsx
git commit -m "feat(agents): recursive indented org tree with shared detail"
```

---

### Task 4: Wire `OrgTreeView` into `AgentsView` (drop card grid)

**Files:**
- Modify: `src/renderer/src/components/views/agents-view.tsx`

**Interfaces:**
- Consumes: `OrgTreeView` from `./org-tree-view` (Task 3).
- Produces: final `AgentsView` — query + `agents.changed` subscription + `<OrgTreeView agents={agents} />`. No card grid, no inline selection state.

- [ ] **Step 1: Replace `agents-view.tsx` body with `OrgTreeView`**

Overwrite `src/renderer/src/components/views/agents-view.tsx`:

```tsx
import { useEffect } from 'react'
import { useQuery, useQueryClient } from '@tanstack/react-query'

import { swarmApi } from '@/lib/api'
import { SettingsHeader } from './settings-primitives'
import { OrgTreeView } from './org-tree-view'

export function AgentsView(): React.JSX.Element {
  const queryClient = useQueryClient()
  const { data: agents, isLoading } = useQuery({
    queryKey: ['agents', 'settings'],
    queryFn: () => swarmApi.listAgents(),
    staleTime: 60_000,
  })

  // Hot-reload: invalidate the query when agent files change on disk
  // (the agents store watches its directory and broadcasts `agents.changed`).
  useEffect(
    () =>
      swarmApi.subscribeEvents((e) => {
        if (e.kind === 'agents.changed') {
          void queryClient.invalidateQueries({ queryKey: ['agents', 'settings'] })
        }
      }),
    [queryClient]
  )

  return (
    <div className="space-y-4">
      <SettingsHeader
        title="Agents"
        description="Specialised sub-agents the main agent can delegate to. The tree shows the org hierarchy; click an agent to view its full system prompt."
      />

      {isLoading ? (
        <p className="text-muted-foreground text-sm">Loading agents…</p>
      ) : !agents || agents.length === 0 ? (
        <p className="text-muted-foreground text-sm">No agents available.</p>
      ) : (
        <OrgTreeView agents={agents} />
      )}
    </div>
  )
}
```

- [ ] **Step 2: Typecheck, run renderer view tests + full suite**

Run: `npx tsc --noEmit -p tsconfig.web.json && npm test -- src/renderer/src/components/views 2>&1 | tail -6`
Expected: typecheck exits 0; the agent-detail and org-tree-view tests pass; no other view test regresses. (If `tsconfig.web.json` does not exist, use the renderer tsconfig the project provides — check `tsconfig.*.json`; the renderer config is the one whose `include` covers `src/renderer`.)

- [ ] **Step 3: Verify the running app (manual)**

Use the `run-desktop` skill (or `npm run dev`) to open Settings → Agents and confirm: the indented tree renders the builtin hierarchy (CEO → pm → engineer/reviewer; training-head → author), independent builtins (default/researcher/executor) appear under "Independent Agents", clicking a node shows its system prompt, and clicking again hides it.

- [ ] **Step 4: Commit**

```bash
git add src/renderer/src/components/views/agents-view.tsx
git commit -m "feat(agents): render the Agents view as an org tree, drop the card grid"
```

---

## Self-Review

**Spec coverage:**
- Pre-step: commit live-reload separately (spec §Pre-step) → Task 1 ✓
- Recursive indented tree from `buildOrgForest` (spec §Architecture/§Layout) → Task 3 ✓
- Drop card grid, single tree listing (spec §Decision) → Task 4 ✓
- Shared `<AgentDetail>` dedup (spec §Architecture) → Task 2 ✓
- Capabilities first 3 + "+M more" (spec §AgentNodeCard) → Task 3 (`MAX_CAPS=3`, `+{extra} more`) ✓
- Independent group for team-less/childless/non-CEO roots (spec §OrgTree) → Task 3 ✓
- Single-select toggle (spec §Data flow / Global Constraints) → Task 3 `OrgTreeView` ✓
- Tests: hierarchy nested, fallback inference, selection→detail, capabilities overflow, independent group (spec §Testing) → Tasks 2–3 (5 OrgTree/View cases + AgentDetail) ✓
- Backward compat via fallback inference (spec §Backward compatibility) → Task 3 fallback-inference test ✓

**Placeholder scan:** none — every code step has full code; the only conditional instruction (Step 2 of Task 4) names how to resolve the renderer tsconfig path explicitly rather than leaving it vague.

**Type consistency:** `OrgTree({ agents, expanded, onToggle })` and `OrgTreeView({ agents })` signatures match between Task 3's definition and Task 4's usage. `AgentDetail({ agent })` matches between Task 2 and Task 3. `OrgNode`/`buildOrgForest` names match the Spec 1 module (`@shared/agents/org-tree`). `MAX_CAPS = 3` aligns with the "+2 more" assertion (5 caps − 3 shown = 2).

**Note on testability deviation from spec diagram:** the spec's architecture diagram placed `expanded` state in `AgentsView`; this plan moves it to a prop-driven `OrgTreeView` so the selection→detail behavior tests without query/IPC mocking (matching the repo's prop-driven component-test precedent). `AgentsView` stays a thin query+subscription shell. Same behavior, more testable boundary.
