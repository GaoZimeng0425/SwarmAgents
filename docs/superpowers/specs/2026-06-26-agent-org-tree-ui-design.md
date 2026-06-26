# Spec 2 — Agent Org Tree UI (recursive indented tree)

Date: 2026-06-26
Status: Approved (design)

## Context

The Agents settings view (`src/renderer/src/components/views/agents-view.tsx`)
renders an org chart whose hierarchy is hardcoded to three fixed layers
(CEO → team head → members) via a pure-CSS horizontal bus that only lays out a
single row of teams. It also renders a redundant card grid of the same agents
below the chart, and duplicates the "expanded agent detail" markup in two
places (the card-grid expansion and the org-chart inline panel).

Spec 1 (merged) added the `parentId` structural edge and the headless
`buildOrgForest(agents): OrgNode[]` builder (`src/shared/agents/org-tree.ts`),
which resolves arbitrary-depth hierarchy parentId-first with fallback to the
existing team/teamRole inference. Spec 2 rebuilds the view's rendering on top
of that builder.

This is Spec 2 of 4. It is UI-only: no backend, directory, `find_agents`,
CRUD (Spec 3), or delegation-graph (Spec 4) changes.

## Decision

Replace the hardcoded 3-layer org chart with a **recursive indented tree**
(file-tree style) driven entirely by `buildOrgForest`. Drop the redundant card
grid; the tree becomes the single agent listing. Extract the duplicated detail
markup into one shared `<AgentDetail>` component. Fix the silent
`capabilities.slice(0, 2)` truncation.

The existing uncommitted live-reload WIP (store `watch` + `index.ts` broadcast
+ `ui.ts` `agents.changed` event + the view's subscription) is **committed
first as a separate, self-contained change** so Spec 2 starts from a clean
base and concerns stay separated.

## Pre-step: commit live-reload separately

Before the UI rebuild, land the live-reload feature as its own commit:

- `src/service/agents/store.ts` — the `watch(onChange)` method (chokidar).
- `src/service/index.ts` — `agentStore.watch(...)` → broadcast `agents.changed`; `offAgentWatch()` on dispose.
- `src/shared/types/ui.ts` — `UIEvent` gains `{ kind: 'agents.changed'; ts: number }`.
- `src/renderer/.../agents-view.tsx` — add ONLY the `agents.changed` subscription `useEffect` (invalidate the `['agents','settings']` query) to the **original card-grid view**. The WIP's inline `OrgChart` is NOT included here; Spec 2 builds the new tree on top.

This commit is the user's existing WIP minus the first-cut org chart. Spec 2's
UI work then supersedes that first-cut chart.

## Architecture

```
AgentsView (agents-view.tsx)
  - useQuery(['agents','settings']) → listAgents()
  - useEffect: subscribe agents.changed → invalidate query  (from pre-step)
  - expanded selection state (single-select, agent id | null)
  - renders <OrgTree> + <AgentDetail> (no card grid)

OrgTree (org-tree-view.tsx)
  - calls buildOrgForest(agents) (shared, already tested)
  - splits roots: hierarchy roots (have children OR are CEO/team-tagged) vs
    "independent" leaf roots (no team, no children, not CEO)
  - renders hierarchy roots as recursive trees, then an "Independent Agents"
    group for the leaf roots

OrgTreeNode (org-tree-view.tsx)
  - recursive: one <AgentNodeCard> + an indented child container that maps
    node.children to <OrgTreeNode> (depth+1)
  - indent + left guide line per level; cycle-safe by construction (the forest
    is acyclic — buildOrgForest guarantees it)

AgentNodeCard (org-tree-view.tsx)
  - name, role-or-id, team + toolScope badges, capabilities (first 3 + "+M more" when there are more than 3)
  - click → onToggle(agent.id); active styling when selected

AgentDetail (agent-detail.tsx)  ← extracted, single source
  - given an AgentDefinition: name, id, description, systemPrompt (<pre>)
  - used once, below the tree, for the selected agent
```

File split: keep `agents-view.tsx` as the thin container; move the tree
components into `org-tree-view.tsx` and the detail panel into
`agent-detail.tsx`. This keeps each file focused and small.

## Data flow

`listAgents()` → `AgentDefinition[]` → `buildOrgForest()` → `OrgNode[]` forest
→ recursive render. Selection is a single `expanded: string | null` in
`AgentsView`; clicking a node toggles it; `AgentDetail` renders the agent whose
id matches. The `agents.changed` subscription invalidates the query so external
edits reload live (behavior preserved from the pre-step).

## Layout

- Indented nesting: each level adds left padding and a left border guide line;
  `├─`/`└─` connectors via CSS pseudo-elements or literal characters.
- Arbitrary depth supported natively; the container scrolls vertically when
  tall and horizontally only inside its own `overflow-x:auto` wrapper if a deep
  indent exceeds width (the page body never scrolls horizontally).
- Root ordering: hierarchy trees first (in forest order), then the "Independent
  Agents" group — matching the approved mockup.

## Components are isolated and testable

- `buildOrgForest` is pure and already unit-tested (Spec 1).
- `OrgTree`/`OrgTreeNode`/`AgentNodeCard` are presentational — given a forest
  and a selection, they render deterministically.
- `AgentDetail` is a pure presentational component of one `AgentDefinition`.

## Testing (React Testing Library + jsdom)

Mirror existing component tests (`permission-card.test.tsx`,
`composer-overlay.test.tsx`). New `agents-view.test.tsx` (or
`org-tree-view.test.tsx`) cases:

1. **Hierarchy renders nested:** given agents with multi-level `parentId`
   (e.g. ceo → pm → engineer → intern), the rendered child appears inside its
   parent's indented container (assert DOM nesting / indent depth).
2. **Fallback inference renders:** given builtins with team/teamRole and no
   parentId, the tree reproduces CEO → head → members.
3. **Selection shows detail:** clicking a node renders `AgentDetail` with that
   agent's `systemPrompt` text; clicking again hides it.
4. **Capabilities overflow:** an agent with > 3 capabilities shows the first 3
   plus a "+M more" affordance (no silent truncation).
5. **Independent group:** a team-less, childless, non-CEO agent renders under
   the "Independent Agents" group, not as a hierarchy root child.

## Backward compatibility

Existing builtins (no `parentId`) render via `buildOrgForest`'s fallback
inference, reproducing today's CEO → head → members shape. No agent data, store,
directory, or `find_agents` behavior changes.

## Out of scope (later specs)

- Create/edit/delete agents from the view (incl. editing `parentId`) — **Spec 3**.
- Delegation/reachability graph ("who can call whom") — **Spec 4**.
