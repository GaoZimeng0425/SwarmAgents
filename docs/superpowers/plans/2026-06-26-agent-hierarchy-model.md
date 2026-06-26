# Agent Hierarchy Model Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add an optional `parentId` structural edge to `AgentDefinition` so the agent org hierarchy can be arbitrary-depth, with a headless tree builder that prefers `parentId` and falls back to today's team/teamRole inference.

**Architecture:** `parentId` is added to the zod schema and persisted in the AGENT.md frontmatter exactly like `team`/`teamRole`. `save()` gains validation rejecting self-reference, unknown parents, and cycles. A new pure module `src/shared/agents/org-tree.ts` exposes `buildOrgForest(agents)` returning an `OrgNode` forest — the single source of structural truth that Spec 2's UI and Spec 4's overlay will consume. No UI, directory, or `find_agents` changes in this spec.

**Tech Stack:** TypeScript, zod, vitest (run under Electron-as-node).

## Global Constraints

- Code comments and commit messages in English (project CLAUDE.md §0).
- `parentId` is structural only — NOT used by `deriveAllowlist`, NOT a permission boundary, NOT added to the directory/`PeerQuery`/`find_agents`.
- `team`/`teamRole` are kept unchanged; `parentId` is additive.
- Tests run with: `npm test -- <path-filter>` (never bare `npx vitest`; the script wraps vitest in Electron-as-node).
- `parentId` regex matches the `id` shape: `/^[a-z0-9]+(?:-[a-z0-9]+)*$/`, 1–64 chars.

---

### Task 1: Schema field + frontmatter persistence

**Files:**
- Modify: `src/shared/types/agent.ts` (add `parentId` to `AgentDefinitionSchema`)
- Modify: `src/service/agents/store.ts` (`parseAgent` ~line 47-59, `serializeAgent` ~line 71-75)
- Test: `src/service/agents/store.test.ts`

**Interfaces:**
- Produces: `AgentDefinition.parentId?: string` — a valid agent id; persisted as a `parentId:` frontmatter line. Consumed by Task 2 (validation) and Task 3 (`buildOrgForest`).

- [ ] **Step 1: Write the failing test**

Add to `src/service/agents/store.test.ts`, inside the `describe('parseAgent', …)` block (after the existing model round-trip test ~line 28):

```ts
  it('round-trips parentId through serialize + parse', () => {
    const d = def({ id: 'engineer', parentId: 'pm' })
    expect(parseAgent(serializeAgent(d), d.id)).toEqual(d)
  })

  it('omits parentId from frontmatter when absent', () => {
    expect(serializeAgent(def())).not.toContain('parentId')
  })
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npm test -- src/service/agents/store.test.ts`
Expected: FAIL — `parentId` is stripped (not in schema), so `parseAgent(...)` result lacks it and `toEqual` mismatches.

- [ ] **Step 3: Add the schema field**

In `src/shared/types/agent.ts`, inside `AgentDefinitionSchema`, immediately after the `teamRole` field (`teamRole: z.enum(['head']).optional(),`):

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

- [ ] **Step 4: Thread parentId through persistence**

In `src/service/agents/store.ts`, in `parseAgent`'s `safeParse({...})` object, add after the `teamRole: meta.teamRole,` line:

```ts
    parentId: meta.parentId,
```

In `serializeAgent`, add after the `teamRole` push line (`if (def.teamRole) lines.push(...)`):

```ts
  if (def.parentId) lines.push(`parentId: ${JSON.stringify(def.parentId)}`)
```

- [ ] **Step 5: Run tests to verify they pass**

Run: `npm test -- src/service/agents/store.test.ts`
Expected: PASS (all tests in the file, including the two new ones).

- [ ] **Step 6: Commit**

```bash
git add src/shared/types/agent.ts src/service/agents/store.ts src/service/agents/store.test.ts
git commit -m "feat(agents): add optional parentId edge to AgentDefinition"
```

---

### Task 2: `save()` parentId validation

**Files:**
- Modify: `src/service/agents/store.ts` (`save`, ~line 106-119)
- Test: `src/service/agents/store.test.ts`

**Interfaces:**
- Consumes: `AgentDefinition.parentId` (Task 1).
- Produces: `save(def)` returns `{ ok: false, code }` with `code` one of `'self_parent' | 'unknown_parent' | 'cycle'` when `parentId` is invalid; otherwise unchanged behavior.

- [ ] **Step 1: Write the failing tests**

Add a new `describe` block at the end of `src/service/agents/store.test.ts` (before the file's final closing brace is not needed — append as a sibling `describe`):

```ts
describe('save parentId validation', () => {
  let dir: string
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'agents-parent-'))
  })
  afterEach(() => {
    rmSync(dir, { recursive: true, force: true })
  })

  it('rejects an agent that is its own parent', () => {
    const store = createAgentStore({ dir })
    const res = store.save(def({ id: 'a', parentId: 'a' }))
    expect(res).toMatchObject({ ok: false, code: 'self_parent' })
  })

  it('rejects an unknown parent', () => {
    const store = createAgentStore({ dir })
    const res = store.save(def({ id: 'a', parentId: 'ghost' }))
    expect(res).toMatchObject({ ok: false, code: 'unknown_parent' })
  })

  it('rejects a parent cycle', () => {
    const store = createAgentStore({ dir })
    // a -> b exists on disk; saving b -> a closes the loop.
    expect(store.save(def({ id: 'b' })).ok).toBe(true)
    expect(store.save(def({ id: 'a', parentId: 'b' })).ok).toBe(true)
    const res = store.save(def({ id: 'b', parentId: 'a' }))
    expect(res).toMatchObject({ ok: false, code: 'cycle' })
  })

  it('accepts a valid parent', () => {
    const store = createAgentStore({ dir })
    expect(store.save(def({ id: 'pm' })).ok).toBe(true)
    expect(store.save(def({ id: 'engineer', parentId: 'pm' })).ok).toBe(true)
  })
})
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npm test -- src/service/agents/store.test.ts`
Expected: FAIL — the three rejection tests fail because `save` currently accepts any `parentId` (no validation), returning `ok: true`.

- [ ] **Step 3: Implement validation in `save`**

In `src/service/agents/store.ts`, inside `save`, after the schema `safeParse` success check and before the `try {` that writes the file, insert:

```ts
    // parentId is a structural edge; reject self-reference, dangling targets,
    // and cycles so the org tree is always a forest. Resolve against the
    // current agents with the incoming def overlaid (it is not yet on disk).
    const { parentId, id } = parsed.data
    if (parentId) {
      if (parentId === id) return { ok: false, code: 'self_parent', message: 'an agent cannot be its own parent' }
      const byId = new Map(merged().map((a) => [a.id, a]))
      byId.set(id, parsed.data)
      if (!byId.has(parentId)) return { ok: false, code: 'unknown_parent', message: `parent "${parentId}" does not exist` }
      const visited = new Set<string>([id])
      let cursor = parentId
      while (cursor) {
        if (visited.has(cursor)) return { ok: false, code: 'cycle', message: 'parent chain forms a cycle' }
        visited.add(cursor)
        cursor = byId.get(cursor)?.parentId ?? ''
      }
    }
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `npm test -- src/service/agents/store.test.ts`
Expected: PASS (full file).

- [ ] **Step 5: Commit**

```bash
git add src/service/agents/store.ts src/service/agents/store.test.ts
git commit -m "feat(agents): validate parentId (self/unknown/cycle) on save"
```

---

### Task 3: `buildOrgForest` pure tree builder

**Files:**
- Create: `src/shared/agents/org-tree.ts`
- Test: `src/shared/agents/org-tree.test.ts`

**Interfaces:**
- Consumes: `AgentDefinition` with optional `parentId`, `team`, `teamRole`, `role` (Task 1).
- Produces:
  - `type OrgNode = { agent: AgentDefinition; children: OrgNode[] }`
  - `function buildOrgForest(agents: AgentDefinition[]): OrgNode[]` — roots in input order; children in input order; cycle-safe.

- [ ] **Step 1: Write the failing tests**

Create `src/shared/agents/org-tree.test.ts`:

```ts
import type { AgentDefinition } from '@shared/types/agent'
import { describe, expect, it } from 'vitest'

import { buildOrgForest } from './org-tree'

const a = (over: Partial<AgentDefinition> & { id: string }): AgentDefinition => ({
  name: over.id,
  description: 'd',
  systemPrompt: 'p',
  toolScope: 'all',
  maxIterations: 25,
  ...over,
})

// Flatten a forest to "id:parentId-or-root" pairs for order-independent assertions.
const edges = (forest: ReturnType<typeof buildOrgForest>): string[] => {
  const out: string[] = []
  const walk = (n: ReturnType<typeof buildOrgForest>[number], parent: string): void => {
    out.push(`${n.agent.id}:${parent}`)
    for (const c of n.children) walk(c, n.agent.id)
  }
  for (const r of forest) walk(r, 'root')
  return out.sort()
}

describe('buildOrgForest', () => {
  it('builds an arbitrary-depth tree from parentId', () => {
    const forest = buildOrgForest([
      a({ id: 'ceo' }),
      a({ id: 'pm', parentId: 'ceo' }),
      a({ id: 'eng', parentId: 'pm' }),
      a({ id: 'intern', parentId: 'eng' }),
    ])
    expect(edges(forest)).toEqual(['ceo:root', 'eng:pm', 'intern:eng', 'pm:ceo'].sort())
  })

  it('falls back to team/teamRole inference when parentId is absent', () => {
    const forest = buildOrgForest([
      a({ id: 'ceo', role: 'ceo' }),
      a({ id: 'pm', role: 'pm', team: 'dev', teamRole: 'head' }),
      a({ id: 'engineer', role: 'engineer', team: 'dev' }),
      a({ id: 'reviewer', role: 'reviewer', team: 'dev' }),
    ])
    expect(edges(forest)).toEqual(['ceo:root', 'engineer:pm', 'pm:ceo', 'reviewer:pm'].sort())
  })

  it('mixes explicit parentId with fallback inference', () => {
    const forest = buildOrgForest([
      a({ id: 'ceo', role: 'ceo' }),
      a({ id: 'pm', team: 'dev', teamRole: 'head' }), // inferred -> ceo
      a({ id: 'specialist', parentId: 'pm' }), // explicit -> pm, no team
    ])
    expect(edges(forest)).toEqual(['ceo:root', 'pm:ceo', 'specialist:pm'].sort())
  })

  it('treats an independent agent (no team, not ceo) as a root', () => {
    const forest = buildOrgForest([a({ id: 'researcher', role: 'researcher' })])
    expect(edges(forest)).toEqual(['researcher:root'])
  })

  it('does not loop on a cyclic parentId; breaks the cycle into roots', () => {
    const forest = buildOrgForest([
      a({ id: 'a', parentId: 'b' }),
      a({ id: 'b', parentId: 'a' }),
    ])
    // No infinite loop; both nodes appear exactly once.
    const ids = edges(forest).map((e) => e.split(':')[0]).sort()
    expect(ids).toEqual(['a', 'b'])
  })
})
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npm test -- src/shared/agents/org-tree.test.ts`
Expected: FAIL — `./org-tree` does not exist (import error).

- [ ] **Step 3: Implement `buildOrgForest`**

Create `src/shared/agents/org-tree.ts`:

```ts
import type { AgentDefinition } from '@shared/types/agent'

/** A node in the agent org forest. Minimal by design: enough for recursive
 *  rendering (Spec 2) and for overlaying delegation edges (Spec 4). */
export type OrgNode = { agent: AgentDefinition; children: OrgNode[] }

/**
 * Build an org forest from a flat agent list.
 *
 * Edge resolution per agent, parentId-first with fallback inference:
 *  1. valid `parentId` (resolves to another agent) -> child of that agent.
 *  2. no parentId -> inferred:
 *     - role 'ceo' with no team        -> root
 *     - teamRole 'head'                -> child of the CEO if one exists, else root
 *     - team member (team, not head)   -> child of that team's head if one exists, else root
 *     - otherwise (independent)        -> root
 *
 * Cycle-safe: an agent whose parent chain would revisit itself is promoted to
 * a root, so the result is always a forest and never loops.
 */
export function buildOrgForest(agents: AgentDefinition[]): OrgNode[] {
  const byId = new Map(agents.map((agent) => [agent.id, agent]))
  const ceo = agents.find((agent) => agent.role === 'ceo' && !agent.team)
  const headByTeam = new Map<string, AgentDefinition>()
  for (const agent of agents) {
    if (agent.team && agent.teamRole === 'head') headByTeam.set(agent.team, agent)
  }

  // Resolve each agent's parent id (or undefined for a root).
  const parentOf = (agent: AgentDefinition): string | undefined => {
    if (agent.parentId && byId.has(agent.parentId) && agent.parentId !== agent.id) return agent.parentId
    if (agent.parentId) return undefined // self-ref or dangling -> root
    if (agent.role === 'ceo' && !agent.team) return undefined
    if (agent.teamRole === 'head') return ceo && ceo.id !== agent.id ? ceo.id : undefined
    if (agent.team) {
      const head = headByTeam.get(agent.team)
      return head && head.id !== agent.id ? head.id : undefined
    }
    return undefined
  }

  // Detect agents in a parent cycle; promote them to roots.
  const inCycle = (agent: AgentDefinition): boolean => {
    const visited = new Set<string>()
    let cursor: string | undefined = agent.id
    while (cursor) {
      if (visited.has(cursor)) return true
      visited.add(cursor)
      const next = byId.get(cursor)
      cursor = next ? parentOf(next) : undefined
    }
    return false
  }

  const nodes = new Map<string, OrgNode>(agents.map((agent) => [agent.id, { agent, children: [] }]))
  const roots: OrgNode[] = []
  for (const agent of agents) {
    const parentId = inCycle(agent) ? undefined : parentOf(agent)
    const node = nodes.get(agent.id)!
    const parent = parentId ? nodes.get(parentId) : undefined
    if (parent) parent.children.push(node)
    else roots.push(node)
  }
  return roots
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `npm test -- src/shared/agents/org-tree.test.ts`
Expected: PASS (5 tests).

- [ ] **Step 5: Run the full agents test surface as a regression check**

Run: `npm test -- src/shared/agents src/service/agents`
Expected: PASS — no existing builtin/store tests regress.

- [ ] **Step 6: Commit**

```bash
git add src/shared/agents/org-tree.ts src/shared/agents/org-tree.test.ts
git commit -m "feat(agents): add buildOrgForest tree builder (parentId-first, fallback inference)"
```

---

## Self-Review

**Spec coverage:**
- Schema field (§Design 1) → Task 1 ✓
- Persistence parse/serialize (§Design 2) → Task 1 ✓
- save() validation self/unknown/cycle (§Design 3) → Task 2 ✓
- `buildOrgForest` + `OrgNode` (§Design 4) → Task 3 ✓
- Tests: store round-trip, save validation, forest 4 cases (§Design 5) → Tasks 1–3 ✓ (forest has 5 cases incl. independent-root — superset, fine)
- Backward compat (fallback reproduces today's shape) → Task 3 Step 1 test "falls back to team/teamRole inference" ✓

**Placeholder scan:** none — every code step shows full code and exact commands.

**Type consistency:** `OrgNode = { agent, children }`, `buildOrgForest(agents): OrgNode[]`, and `AgentMutationResult` codes (`self_parent`/`unknown_parent`/`cycle`) are used identically across Task 2 and Task 3. `parentOf` and `inCycle` are local helpers, consistent within Task 3.

**Note on cycle semantics:** Task 2 *rejects* cyclic saves at the store boundary, so on-disk data is always acyclic. Task 3's cycle defense is belt-and-suspenders for inputs assembled in-memory (e.g. builtins + user agents merged) and never triggers on validated store data — both are intentional and consistent.
