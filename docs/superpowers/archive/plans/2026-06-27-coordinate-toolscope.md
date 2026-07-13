# Coordinator least-privilege toolScope Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add a least-privilege `coordinate` tool scope (delegation + skills only) and retag the pure-delegator coordinators (CEO, planner, eight non-training heads) to it, so they can no longer run shell / capture the screen / drive the UI; plus fix one stale CEO description.

**Architecture:** `toolScope` is the per-agent capability boundary. Today every coordinator uses `'all'` (= every non-privileged tool group), which is far more than a delegator needs. Add a new `'coordinate'` scope to the `ToolScope` enum and `deriveAllowlist` granting only `['agent.*', 'skill.*']`, surface it in the agent form's scope list, then change the relevant builtin agents' `toolScope` from `'all'` to `'coordinate'`. `training-head` stays `'authoring'` (privileged training team), ICs/workers/default stay `'all'` (they do real work).

**Tech Stack:** TypeScript, Zod (`ToolScopeSchema`), React (agent form), Vitest (Electron-as-node).

## Global Constraints

- Code comments and commit messages in English.
- Run tests with `npm test -- <file>` (Electron-as-node; never bare `npx vitest`, never `pnpm rebuild better-sqlite3`).
- `coordinate` grants exactly `['agent.*', 'skill.*']` — the `agent` group is the coordination tools (`find_agents`, `send_and_wait`, `send_message`, `whoami`, `spawn_sub_agent`, `update_plan`); `skill` is `use_skill`. Nothing else.
- Coordinators retagged to `coordinate`: `ceo`, `planner`, and the eight heads `engineering-lead`, `product-lead`, `design-lead`, `qa-lead`, `ops-lead`, `docs-lead`, `security-lead`, `data-lead`. NOT `training-head` (stays `authoring`).
- ICs, `worker-fast`, `worker-strong`, and `default` keep `'all'` — unchanged.
- Surgical: touch only `src/shared/types/agent.ts`, `src/shared/types/agent.test.ts`, `src/shared/constants/agents.ts`, `src/shared/constants/agents.test.ts`, `src/renderer/src/components/views/agent-form-sheet.tsx`.

---

### Task 1: Add the `coordinate` tool scope

**Files:**
- Modify: `src/shared/types/agent.ts` (`ToolScopeSchema` enum ~line 5; `deriveAllowlist` switch ~line 86)
- Modify: `src/renderer/src/components/views/agent-form-sheet.tsx` (`SCOPES` array ~line 22)
- Test: `src/shared/types/agent.test.ts` (add a `deriveAllowlist('coordinate')` case in the existing `describe('deriveAllowlist', ...)`)

**Interfaces:**
- Produces: `ToolScope` now includes `'coordinate'`; `deriveAllowlist('coordinate')` returns `['agent.*', 'skill.*']`. Task 2 sets `toolScope: 'coordinate'` on coordinators.

- [ ] **Step 1: Write the failing test**

In `src/shared/types/agent.test.ts`, inside `describe('deriveAllowlist', ...)`, add:

```typescript
  it('coordinate grants only the delegation and skill groups', () => {
    expect(deriveAllowlist('coordinate')).toEqual(['agent.*', 'skill.*'])
  })
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npm test -- src/shared/types/agent.test.ts`
Expected: FAIL — TypeScript/runtime: `'coordinate'` is not an accepted `ToolScope` and `deriveAllowlist` has no such case.

- [ ] **Step 3: Add `coordinate` to the enum and `deriveAllowlist`**

In `src/shared/types/agent.ts`, change the enum (line ~5) from:

```typescript
export const ToolScopeSchema = z.enum(['peekaboo', 'web', 'fs', 'memory', 'authoring', 'all'])
```

to:

```typescript
export const ToolScopeSchema = z.enum(['peekaboo', 'web', 'fs', 'memory', 'authoring', 'coordinate', 'all'])
```

Then in the `deriveAllowlist` switch, add a `case` before `case 'all':`:

```typescript
    case 'coordinate':
      // Pure delegator: the coordination tools (find_agents, send_and_wait,
      // spawn_sub_agent, update_plan) plus use_skill — no shell, fs, web, UI or
      // screen capture. For the CEO, planner and team heads, which only break
      // work down and delegate; the ICs they delegate to hold the real tools.
      return ['agent.*', 'skill.*']
```

- [ ] **Step 4: Surface `coordinate` in the agent form**

In `src/renderer/src/components/views/agent-form-sheet.tsx`, change the `SCOPES` array (line ~22) from:

```typescript
const SCOPES: ToolScope[] = ['peekaboo', 'web', 'fs', 'memory', 'authoring', 'all']
```

to:

```typescript
const SCOPES: ToolScope[] = ['peekaboo', 'web', 'fs', 'memory', 'authoring', 'coordinate', 'all']
```

- [ ] **Step 5: Run tests to verify they pass**

Run: `npm test -- src/shared/types/agent.test.ts`
Expected: PASS (the new case plus all existing `deriveAllowlist`/`allowlistForAgent` tests).

- [ ] **Step 6: Commit**

```bash
git add src/shared/types/agent.ts src/shared/types/agent.test.ts src/renderer/src/components/views/agent-form-sheet.tsx
git commit -m "feat(agents): add least-privilege coordinate tool scope"
```

---

### Task 2: Retag coordinators and fix the stale CEO description

**Files:**
- Modify: `src/shared/constants/agents.ts` (CEO `description` + `toolScope`; `toolScope` on planner and the eight heads)
- Test: `src/shared/constants/agents.test.ts` (add a scope assertion inside `describe('builtin roster', ...)`)

**Interfaces:**
- Consumes: `'coordinate'` scope from Task 1.
- Produces: `byId.ceo.toolScope === 'coordinate'` (and planner + the eight heads); `byId['training-head'].toolScope === 'authoring'`; ICs unchanged.

- [ ] **Step 1: Write the failing test**

In `src/shared/constants/agents.test.ts`, inside `describe('builtin roster', ...)` (before its closing `})`), add:

```typescript
  it('pure-delegator coordinators use the least-privilege coordinate scope', () => {
    const coordinators = ['ceo', 'planner', 'engineering-lead', 'product-lead', 'design-lead', 'qa-lead', 'ops-lead', 'docs-lead', 'security-lead', 'data-lead']
    for (const id of coordinators) {
      expect(byId[id].toolScope, `${id} should be coordinate`).toBe('coordinate')
    }
    // The training head stays privileged; ICs keep full access.
    expect(byId['training-head'].toolScope).toBe('authoring')
    expect(byId.engineer.toolScope).toBe('all')
    expect(byId['worker-fast'].toolScope).toBe('all')
  })

  it('the CEO description no longer references the renamed PM role', () => {
    expect(byId.ceo.description).not.toContain('PM')
  })
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npm test -- src/shared/constants/agents.test.ts`
Expected: FAIL — coordinators are still `'all'`, and the CEO description still contains `PM`.

- [ ] **Step 3: Retag the coordinators**

In `src/shared/constants/agents.ts`, change `toolScope: 'all'` to `toolScope: 'coordinate'` in exactly these ten agent definition objects, identified by their `id`: `ceo`, `planner`, `engineering-lead`, `product-lead`, `design-lead`, `qa-lead`, `ops-lead`, `docs-lead`, `security-lead`, `data-lead`. Do NOT change `training-head` (keep `authoring`), any IC, `worker-fast`, `worker-strong`, or `default`.

Example — the `ceo` entry's `toolScope: 'all',` becomes `toolScope: 'coordinate',`. Apply the same one-line change in each of the ten objects. (Each `id` is unique; match the `toolScope` line within that object.)

- [ ] **Step 4: Fix the stale CEO description**

In `src/shared/constants/agents.ts`, in the `ceo` definition's `description`, replace the phrase `delegates to the PM` with `delegates to the team heads`. The full current description reads:

```
'Use as the top of a software-company run: receives a high-level goal, delegates to the PM, and produces the final summary. Coordinates only — does not write code.'
```

Change it to:

```
'Use as the top of a software-company run: receives a high-level goal, delegates to the team heads, and produces the final summary. Coordinates only — does not write code.'
```

- [ ] **Step 5: Run tests to verify they pass**

Run: `npm test -- src/shared/constants/agents.test.ts`
Expected: PASS — both new tests green AND all existing roster tests still green (the `AgentDefinitionSchema` validity test confirms `'coordinate'` is now a legal scope for the retagged agents).

- [ ] **Step 6: Commit**

```bash
git add src/shared/constants/agents.ts src/shared/constants/agents.test.ts
git commit -m "feat(agents): retag pure-delegator coordinators to coordinate scope; fix stale CEO copy"
```

---

## Self-Review

**Spec coverage:**
- New `coordinate` scope = `['agent.*', 'skill.*']` → Task 1 Step 3; asserted by Task 1 test. ✓
- Surfaced in agent form → Task 1 Step 4. ✓
- Retag ceo + planner + 8 heads → Task 2 Step 3; asserted by Task 2 test 1. ✓
- training-head stays authoring; ICs/workers/default stay all → Task 2 Step 3 (excluded) + asserted. ✓
- Stale CEO description fixed → Task 2 Step 4; asserted by Task 2 test 2. ✓
- Existing tests pass → schema-validity roster test covers the new scope on retagged objects. ✓

**Placeholder scan:** No TBD/TODO; all code blocks complete; exact ids enumerated. ✓

**Type consistency:** `ToolScope` gains `'coordinate'` in Task 1 and is used in Task 2; `deriveAllowlist('coordinate')` returns `['agent.*', 'skill.*']` consistently in the impl and the test; coordinator id list identical in the constraint, Task 2 Step 3, and Task 2 test. ✓
