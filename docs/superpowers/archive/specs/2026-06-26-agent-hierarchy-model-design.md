# Spec 1 — Agent Hierarchy Model (explicit `parentId` edge)

Date: 2026-06-26
Status: Approved (design)

## Context

The Agents view renders an org chart whose hierarchy is *inferred* from two
fields on `AgentDefinition`:

- `team?: string` — team grouping tag
- `teamRole?: 'head'` — marks a team's entry-point agent

This supports exactly three fixed layers: CEO (`role === 'ceo'`, no team) →
team head (`teamRole === 'head'`) → members. The shape is baked into the
renderer (`agents-view.tsx`), so sub-teams, a head reporting to another head,
or any deeper nesting cannot be expressed.

These same two fields are **load-bearing for the multi-team-company runtime**:
`find_agents({ teamRole: 'head' })` is the CEO's team-discovery mechanism, the
directory/receptionist filters on them, and several builtin system prompts
instruct agents to use them. Replacing them is therefore high-risk.

This spec is the foundation (Spec 1 of 4) for a broader effort whose later
specs cover: UI rebuild with recursive rendering (Spec 2), in-view agent CRUD
(Spec 3), and a delegation/reachability graph overlay (Spec 4).

## Decision

Add a new **optional `parentId` edge** to `AgentDefinition` as the single
source of structural truth, **kept alongside** `team`/`teamRole` rather than
replacing them. `team`/`teamRole` remain purely discovery/filter tags and the
runtime is untouched. This gives arbitrary-depth hierarchy at minimal blast
radius — no changes to `find_agents`, the directory, or builtin prompts.

The org tree is built **parentId-first with fallback inference**: an agent with
a valid `parentId` is attached to that parent; an agent without one falls back
to the existing inference (CEO is a root; a team head's parent is the CEO; a
member's parent is its team head). Existing builtins carry no `parentId`, so
they fall through to inference and render exactly as they do today —
backward-compatible by construction.

## Scope

Backend data model + one headless, unit-testable pure function. **No UI**
(that is Spec 2). **No directory / `find_agents` changes** (delegation
semantics are Spec 4). `parentId` is structural only — it does **not**
participate in `deriveAllowlist` and is **not** a permission boundary.

## Design

### 1. Schema — `src/shared/types/agent.ts`

Add to `AgentDefinitionSchema`:

```ts
/**
 * Optional structural edge to a parent agent's id, used to render the org
 * hierarchy. The org-tree builder prefers this edge and falls back to
 * team/teamRole inference when it is absent. Structural only: NOT a
 * permission boundary and NOT used by deriveAllowlist or the directory.
 */
parentId: z
  .string()
  .min(1)
  .max(64)
  .regex(/^[a-z0-9]+(?:-[a-z0-9]+)*$/, 'parentId must be a valid agent id')
  .optional(),
```

Same id-shaped regex as `id` (it references an agent id).

### 2. Persistence — `src/service/agents/store.ts`

Mirror the existing `team`/`teamRole` handling:

- `parseAgent`: pass `parentId: meta.parentId` into the `safeParse` call.
- `serializeAgent`: append `if (def.parentId) lines.push(\`parentId: ${JSON.stringify(def.parentId)}\`)`.

### 3. Validation — inside `save()`

After the schema `safeParse` succeeds, resolve against the full agent set
(`merged()`), returning the existing `AgentMutationResult` failure shape:

| Condition | `code` | Message |
|---|---|---|
| `parentId === def.id` | `self_parent` | an agent cannot be its own parent |
| `parentId` not in `merged()` | `unknown_parent` | parent `<id>` does not exist |
| following the parent chain revisits a node | `cycle` | parent chain forms a cycle |

Resolution set: `save()` validates *before* writing to disk, so the incoming
`def` is not yet in `merged()`. Build the lookup as `merged()` with `def`
overlaid (overriding any existing agent of the same id), so a cycle introduced
by this very save is caught. Cycle check: walk `parentId` links from `def`
upward through that lookup, tracking a `visited` Set; abort with `cycle` on a
revisit.

### 4. Pure tree builder — `src/shared/agents/org-tree.ts` (new)

```ts
export type OrgNode = { agent: AgentDefinition; children: OrgNode[] }

/** Build an org forest from a flat agent list. parentId-first, with
 *  fallback inference for agents that lack one. Cycle-safe (visited set);
 *  a node whose parent resolution would cycle is treated as a root. */
export function buildOrgForest(agents: AgentDefinition[]): OrgNode[]
```

Edge resolution per agent:

1. **`parentId` present and resolves** to another agent in the list → child of
   that agent.
2. **No `parentId`** → fallback inference:
   - `role === 'ceo' && !team` → root.
   - `teamRole === 'head'` → child of the CEO if one exists, else root.
   - team member (`team` set, not head) → child of that team's head if one
     exists, else root.
   - no team, not CEO (independent) → root.
3. Any agent whose resolution is ambiguous or would form a cycle → root
   (defensive; never loops).

`OrgNode` shape is intentionally minimal — enough for Spec 2 to render
recursively and for Spec 4 to overlay delegation edges on top.

### 5. Tests

- **store** (`store.test.ts`): round-trip `parentId` through `save` + `reload`.
- **save validation**: `self_parent`, `unknown_parent`, `cycle` each rejected
  with the right `code`; a valid `parentId` accepted.
- **`buildOrgForest`** (`org-tree.test.ts`): (a) pure parentId tree of depth
  ≥3; (b) fallback inference reproduces today's CEO→head→members shape from a
  no-parentId builtin set; (c) mixed parentId + fallback in one list; (d)
  cyclic parentId input returns a forest without infinite loop.

## Backward compatibility

Existing builtin agents define no `parentId`, so `buildOrgForest` resolves them
via fallback inference and produces the same hierarchy the current renderer
shows. No builtin files, builtin tests, directory code, or `find_agents`
behavior change in this spec.

## Out of scope (later specs)

- Recursive UI rendering, shared `<AgentDetail>`, layout robustness — **Spec 2**.
- Create/edit/delete agents from the view (incl. editing `parentId`) — **Spec 3**.
- Delegation/reachability graph ("who can call whom") — **Spec 4**.
