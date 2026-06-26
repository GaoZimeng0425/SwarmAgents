# Spec 4 — Delegation Intent Graph (parsed from prompts)

Date: 2026-06-26
Status: Approved (design)

## Context

The Agents view (Specs 1–3) shows the org *membership* tree and lets users
CRUD agents. It does not show *delegation* — who calls whom. In this system
delegation is **open + prompt-guided**, not a hard ACL:

- `deriveAllowlist` gives `agent.*` (the find_agents / send_and_wait toolset) to
  every scope except `peekaboo`, so almost any agent *can* delegate; `peekaboo`
  agents are terminal.
- `find_agents` is open — a delegator can discover and message any peer,
  filtered only by a `PeerQuery` (role / capability / team / teamRole / query).

So a literal "who CAN call whom" graph is nearly complete and uninsightful. The
useful signal is the **designed intent**: builtin prompts contain structured
calls like `find_agents({ teamRole: 'head' })`, `find_agents({ team: 'dev',
role: 'engineer' })`. Parsing these yields the delegation paths the author
intended.

This is Spec 4 of 4 — the final piece. It is read-only visualization: no
changes to prompts, the runtime `find_agents`, or the directory.

## Decision

Add a headless pure parser `buildDelegationEdges(agents)` that scans each
agent's `systemPrompt` for `find_agents({...})` calls, resolves each query to
the matching target agents (using the directory's matching semantics), and
returns directed edges. Surface the edges in the existing org tree: on
selecting a node, show its **Delegates to** (outgoing) and **Called by**
(incoming) agents as clickable chips below the detail, and highlight the
selected node's delegation targets in the tree. No node-link graph engine.

The UI labels this explicitly as **designed intent parsed from prompts** — not
runtime-observed calls and not an enforced constraint.

## Architecture

### Core parser — `src/shared/agents/delegation.ts` (new)

```ts
export type DelegationEdge = { from: string; to: string }

/** Parse find_agents({...}) calls from every agent's systemPrompt and resolve
 *  each to the agents it would match, producing deduped directed edges. This
 *  is DESIGN INTENT (what the prompt asks to discover), not runtime calls. */
export function buildDelegationEdges(agents: AgentDefinition[]): DelegationEdge[]
```

Algorithm per agent (the `from`):
1. Regex-scan `systemPrompt` for `find_agents(` followed by an object literal
   `{ ... }`. (Calls with no object, or `find_agents()`, are skipped.)
2. From the object body, extract string-valued fields by key: `role`, `team`,
   `teamRole`, `capability`. (Free-text `query` is ignored — it cannot be
   resolved deterministically.) A call whose only field is `query` yields no
   edges.
3. Resolve targets: the agents matching ALL provided fields (intersection),
   mirroring the receptionist's filter — `a.role === role`, `a.team === team`,
   `a.teamRole === teamRole`, `capability` ∈ `a.capabilities`. Exclude the
   source agent itself.
4. Emit `{ from: source.id, to: target.id }` per match.
Dedupe the full edge list (two queries resolving to the same target collapse to
one edge). Edges are returned in a deterministic order (by `from` then `to`).

Pure, no I/O, fully unit-testable — the same shape as `buildOrgForest`.

### UI

- `OrgTreeView` computes `edges = buildDelegationEdges(agents)` once.
- On selection, derive `delegatesTo = edges.filter(e => e.from === sel)` and
  `calledBy = edges.filter(e => e.to === sel)`.
- `DelegationLinks` (new, `src/renderer/src/components/views/delegation-links.tsx`):
  given the selected agent id, the edges, the agent list (for names), and an
  `onSelect(id)` callback, renders two labeled rows of clickable chips
  ("Delegates to", "Called by"). Each chip shows the target agent's name and
  calls `onSelect(id)` to navigate. Renders nothing for a row with no edges; a
  short caption notes the edges are parsed design intent.
- `OrgTreeView` passes `highlightedIds: Set<string>` (the selected node's
  delegation-target ids) into `OrgTree` → `OrgTreeNode` → `AgentNodeCard`, which
  adds a highlight style when its id is in the set.

`AgentDetail` is unchanged (stays a pure single-agent component);
`DelegationLinks` renders alongside it.

## Data flow

`listAgents()` → `AgentListItem[]` → `OrgTreeView`. Edges are derived once via
`buildDelegationEdges`. Selecting a node updates both the detail panel
(`AgentDetail` + `DelegationLinks`) and the tree highlight. Clicking a chip
selects that target (same single-select state already in `OrgTreeView`).

## Components are isolated and testable

- `buildDelegationEdges` is pure and headless — unit-tested directly.
- `DelegationLinks` is prop-driven (id, edges, agents, onSelect) — tests
  without IPC/query, matching the repo's prop-driven precedent.
- The tree-highlight is a presentational prop (`highlightedIds`) threaded
  through existing components.

## Testing

- **delegation** (`delegation.test.ts`): single-field query (`teamRole:'head'`)
  resolves to all heads; `team`+`role` intersection; `capability` membership;
  source excluded from its own targets; a `find_agents()` / `query`-only call
  yields no edges; duplicate targets collapse to one edge; deterministic order.
- **DelegationLinks** (RTL): renders Delegates-to and Called-by chips for the
  given edges; clicking a chip calls `onSelect` with that id; renders empty
  (no row) when an agent has no edges of that direction.
- **OrgTreeView** (RTL, extend): selecting a node that delegates marks its
  target nodes highlighted (assert the highlight attribute/class on targets and
  its absence on non-targets).

## Backward compatibility

Purely additive and read-only. Agents whose prompts contain no `find_agents`
calls simply produce no edges. No change to agent data, the store, the runtime
`find_agents`, the directory, or any earlier spec's behavior.

## Honesty / scope notes

- The graph is **design intent parsed from prompt text**, surfaced as such in
  the UI caption. It is NOT runtime-observed delegation and NOT an enforced
  capability boundary (delegation remains open per `deriveAllowlist`).
- Parsing is heuristic: a prompt that discovers peers by free-text `query`, or
  constructs the call dynamically, will not produce edges. This is an accepted
  limitation, not a bug — the parser only draws edges it can resolve to
  specific agents.

## Out of scope

- Runtime-observed delegation (actual send_and_wait / sub-task history).
- A node-link graph layout (force-directed / layered SVG).
- Any change to how agents discover or message peers at runtime.
