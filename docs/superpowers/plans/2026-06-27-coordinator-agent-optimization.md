# Coordinator Agent Optimization Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Append a shared "coordination protocol" (error handling + honest partial reporting + conflict reconciliation), borrowed from the harness plugin, to every coordinating builtin agent (CEO, all team heads, and the planner), with a CEO-only addendum.

**Architecture:** Add two text constants and one pure helper in `src/shared/constants/agents.ts`. Rename the existing agent array literal to `baseAgents` and export `defaultAgents` as `baseAgents.map(applyCoordinationProtocol)`, so the protocol text lives in one place and reaches exactly the coordinators. Non-coordinating agents pass through unchanged.

**Tech Stack:** TypeScript, Vitest (run via Electron-as-node).

## Global Constraints

- Code comments and commit messages in English.
- Run tests with `npm test -- <file>` (Electron-as-node; never bare `npx vitest`, never `pnpm rebuild better-sqlite3`).
- Surgical change: touch ONLY `src/shared/constants/agents.ts` and `src/shared/constants/agents.test.ts`.
- DRY: the protocol text must appear ONCE (in the new constants), not copied into the ten coordinator prompts.
- Coordinators = the CEO (`id: 'ceo'`), every agent with `teamRole === 'head'` (nine of them), and the planner (`id: 'planner'`). The CEO additionally gets the integration addendum. No other agent (ICs, training, default, workers) gets the protocol.
- Existing roster tests in `agents.test.ts` must still pass — only coordinator prompt text grows; ids, teams, scopes, and head-count are unchanged.

---

### Task 1: Apply the shared coordination protocol to coordinators

**Files:**
- Modify: `src/shared/constants/agents.ts` (add constants + helper near line 252; rename array at line 253; add mapped export after the array's closing `]` near line 555)
- Test: `src/shared/constants/agents.test.ts` (append three `it` blocks inside the existing `describe('builtin roster', ...)`)

**Interfaces:**
- Consumes: `AgentDefinition` type (already imported), the existing agent array.
- Produces: `export const defaultAgents: AgentDefinition[]` unchanged in name/type/order (so `DEFAULT_AGENT_DEF = defaultAgents[0]` and all importers keep working), but coordinators' `systemPrompt` now ends with the protocol text. New internal names: `COORDINATION_PROTOCOL`, `CEO_COORDINATION_ADDENDUM`, `applyCoordinationProtocol(def)`.

- [ ] **Step 1: Write the failing tests**

In `src/shared/constants/agents.test.ts`, append these three `it` blocks inside the `describe('builtin roster', ...)` block (just before its closing `})`):

```typescript
  it('coordinators carry the borrowed coordination protocol', () => {
    // CEO + every head + the planner delegate, so they get the shared protocol.
    expect(byId.ceo.systemPrompt).toContain('retry once')
    expect(byId.planner.systemPrompt).toContain('retry once')
    for (const a of defaultAgents) {
      if (a.teamRole === 'head') {
        expect(a.systemPrompt, `head ${a.id} missing protocol`).toContain('retry once')
      }
    }
  })

  it('only the CEO carries the goal-integration addendum', () => {
    expect(byId.ceo.systemPrompt).toContain('assumptions you are delegating under')
    expect(byId['engineering-lead'].systemPrompt).not.toContain('assumptions you are delegating under')
  })

  it('non-coordinating ICs do not get the coordination protocol', () => {
    expect(byId.engineer.systemPrompt).not.toContain('retry once')
    expect(byId.reviewer.systemPrompt).not.toContain('retry once')
  })
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npm test -- src/shared/constants/agents.test.ts`
Expected: the three new tests FAIL (no coordinator prompt contains `retry once` yet); the pre-existing roster tests still PASS.

- [ ] **Step 3: Add the constants and helper**

In `src/shared/constants/agents.ts`, immediately AFTER the `PLANNER_SYSTEM_PROMPT` constant (it ends at the line `  5. Report a concise final summary ... say so explicitly.\``, around line 251) and BEFORE the agent array declaration, insert:

```typescript
// Orchestrator craft borrowed from the harness plugin: every coordinating agent
// (the CEO, each team head, and the planner) gets the same delegation protocol —
// error handling, conflict reconciliation, and honest partial-result reporting —
// appended once from a single source of truth rather than copied into each prompt.
const COORDINATION_PROTOCOL = `Coordination protocol (applies whenever you delegate):
- If a delegatee fails or returns nothing, retry once. If it still fails, proceed without that piece and record the gap explicitly in your final report.
- If a critical part — or the majority of delegatees — fails, stop and report that you could not meet the goal, with what is missing and why.
- When results conflict, keep both and note their source; never silently drop one.
- Your final summary must honestly state what succeeded, what failed, and what was skipped. Never claim a deliverable you did not actually receive.`

// Extra clauses only the CEO needs: it receives the raw, possibly vague goal and
// integrates deliverables across multiple teams.
const CEO_COORDINATION_ADDENDUM = `- The goal may be under-specified. Do not stall: state the assumptions you are delegating under in your message to each head, so their work is anchored.
- For goals spanning multiple teams, integrate the heads' deliverables into one coherent result — reconcile overlaps and contradictions explicitly rather than concatenating.`

/**
 * Append the coordination protocol to every agent that delegates: the CEO, any
 * team head (teamRole 'head'), and the standalone planner. The CEO additionally
 * gets the goal-integration addendum. Non-coordinating agents pass through
 * unchanged. Keeps the protocol text in one place instead of duplicated across
 * the coordinator prompts.
 */
function applyCoordinationProtocol(def: AgentDefinition): AgentDefinition {
  const isCoordinator = def.id === 'ceo' || def.teamRole === 'head' || def.id === 'planner'
  if (!isCoordinator) return def
  const addendum = def.id === 'ceo' ? `\n${CEO_COORDINATION_ADDENDUM}` : ''
  return { ...def, systemPrompt: `${def.systemPrompt}\n\n${COORDINATION_PROTOCOL}${addendum}` }
}
```

- [ ] **Step 4: Rename the array literal and add the mapped export**

In `src/shared/constants/agents.ts`, change the array declaration line (currently `export const defaultAgents: AgentDefinition[] = [`, ~line 253) to:

```typescript
const baseAgents: AgentDefinition[] = [
```

Then, immediately AFTER that array's closing `]` (the line `]` near line 555, right before the `/** The default agent type ... */` comment), insert a blank line and:

```typescript
/**
 * The builtin roster, with the borrowed coordination protocol applied to every
 * coordinating agent. This is the exported source of truth; `baseAgents` is the
 * raw definitions before the protocol is appended.
 */
export const defaultAgents: AgentDefinition[] = baseAgents.map(applyCoordinationProtocol)
```

Leave `export const DEFAULT_AGENT_DEF: AgentDefinition = defaultAgents[0]` unchanged — `defaultAgents[0]` is still the `default` agent (a non-coordinator, returned unchanged by the helper).

- [ ] **Step 5: Run tests to verify they pass**

Run: `npm test -- src/shared/constants/agents.test.ts`
Expected: PASS — all three new tests green AND every pre-existing roster test still green (the `it('every builtin is a valid AgentDefinition ...')` test confirms the mapped objects still satisfy `AgentDefinitionSchema`).

- [ ] **Step 6: Commit**

```bash
git add src/shared/constants/agents.ts src/shared/constants/agents.test.ts
git commit -m "feat(agents): add borrowed coordination protocol to CEO, heads, planner"
```

---

## Self-Review

**Spec coverage:**
- Shared `COORDINATION_PROTOCOL` on CEO + all heads → Step 3 + Step 4 map; asserted by test 1. ✓
- `CEO_COORDINATION_ADDENDUM` on CEO only → Step 3 helper branch; asserted by test 2. ✓
- planner included (scope change confirmed in plan) → `applyCoordinationProtocol` predicate `|| def.id === 'planner'`; asserted by test 1. ✓
- DRY single source → text in two constants, applied via `.map`. ✓
- ICs untouched → predicate returns `def` unchanged; asserted by test 3. ✓
- Non-goals (no `_workspace/`, no model mandate, no IC/training/default changes) → none introduced. ✓
- Existing roster tests pass → only `systemPrompt` text grows; schema-validity test covers the mapped objects. ✓

**Placeholder scan:** No TBD/TODO; all code blocks complete; full constant text present. ✓

**Type consistency:** `applyCoordinationProtocol(def: AgentDefinition): AgentDefinition`; `baseAgents`/`defaultAgents` both `AgentDefinition[]`; sentinels `'retry once'` and `'assumptions you are delegating under'` consistent across Step 1 tests and Step 3 constants. ✓
