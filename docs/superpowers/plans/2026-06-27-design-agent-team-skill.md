# design-agent-team Skill Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Ship a builtin skill `design-agent-team` that teaches the training team (training-head + training-author) how to design, author, validate, and evolve agents/teams using SwarmAgents' own primitives.

**Architecture:** Add a second builtin skill alongside `swarmagent-operations` in `src/service/skills/builtins.ts` (returned by `builtinSkills()`, merged into the skill store in `src/service/index.ts`). The skill is pure instructional markdown — no runtime code logic. Then add a one-line pointer to the skill in the two training agent system prompts in `src/shared/constants/agents.ts`.

**Tech Stack:** TypeScript, Zod (`SkillSchema`), Vitest (run via Electron-as-node).

## Global Constraints

- Code comments and commit messages in English (CLAUDE.md §0).
- Skill `name` must match `/^[a-z0-9]+(?:-[a-z0-9]+)*$/`, ≤64 chars; `description` ≤1024 chars (`SkillSchema` in `src/shared/types/skill.ts`).
- Run tests with `npm test -- <file>` (Electron-as-node; never bare `npx vitest`, never `pnpm rebuild better-sqlite3`).
- Surgical changes only — touch only `builtins.ts`, its new test, `agents.ts`, and `agents.test.ts`.
- Validation is static (no agent spawning) per the spec's non-goals.

---

### Task 1: Add the `design-agent-team` builtin skill

**Files:**
- Modify: `src/service/skills/builtins.ts`
- Test: `src/service/skills/builtins.test.ts` (create)

**Interfaces:**
- Consumes: `builtinSkills(opts: { mcpConfigPath: string }): Skill[]` (existing), `Skill` type, `SkillSchema` from `@shared/types/skill`.
- Produces: `builtinSkills()` now returns an array that also contains a skill with `name === 'design-agent-team'`. A new top-level function `designAgentTeam(): Skill` (no args — it needs no config path; the changelog path is a literal in the body).

- [ ] **Step 1: Write the failing test**

Create `src/service/skills/builtins.test.ts`:

```typescript
import { SkillSchema } from '@shared/types/skill'
import { describe, expect, it } from 'vitest'

import { builtinSkills } from './builtins'

describe('builtinSkills', () => {
  const skills = builtinSkills({ mcpConfigPath: '/tmp/mcp.json' })
  const byName = Object.fromEntries(skills.map((s) => [s.name, s]))

  it('ships the design-agent-team skill as a valid Skill', () => {
    const skill = byName['design-agent-team']
    expect(skill).toBeDefined()
    expect(SkillSchema.safeParse(skill).success).toBe(true)
  })

  it('design-agent-team has a trigger-first description within the length limit', () => {
    const { description } = byName['design-agent-team']
    expect(description.length).toBeLessThanOrEqual(1024)
    expect(description).toMatch(/Use when/i)
  })

  it('design-agent-team body covers the five authoring steps', () => {
    const { body } = byName['design-agent-team']
    for (const anchor of [
      'Step 1 — Dedup',
      'Step 2 — Pick a team architecture pattern',
      'Step 3 — Authoring conventions',
      'Step 4 — Static dry-run validation',
      'Step 5 — Evolution',
    ]) {
      expect(body, `missing section: ${anchor}`).toContain(anchor)
    }
  })

  it('still ships the operations manual alongside it', () => {
    expect(byName['swarmagent-operations']).toBeDefined()
  })
})
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npm test -- src/service/skills/builtins.test.ts`
Expected: FAIL — `byName['design-agent-team']` is `undefined` (skill not added yet).

- [ ] **Step 3: Add the skill to `builtins.ts`**

In `src/service/skills/builtins.ts`, change the `builtinSkills` return to include the new skill, and add the `designAgentTeam()` function. Edit the return line:

```typescript
export function builtinSkills(opts: { mcpConfigPath: string }): Skill[] {
  return [operationsManual(opts.mcpConfigPath), designAgentTeam()]
}
```

Then append this function at the end of the file:

```typescript
function designAgentTeam(): Skill {
  return {
    name: 'design-agent-team',
    description:
      'How to design, author, validate and evolve agents, skills and whole teams for this company. ' +
      'Use when asked to create a new agent, add a team, author or improve a skill, or grow the ' +
      "company's capabilities — i.e. before calling write_agent or write_skill.",
    body: `# Designing agents, skills and teams

You are building the company's own workforce. An **agent** is *who* does the work
(a role with a system prompt and a tool scope); a **skill** is *how* a procedure
is done (reusable instructions any agent can load). The training head designs the
team and writes the specs; the author materializes them with \`write_agent\` /
\`write_skill\`. Follow the steps below in order.

## Step 1 — Dedup before you create

Repeatedly building teams accumulates near-duplicate agents under different names.
Before authoring anything, discover what already exists:

- \`find_agents({ team })\`, \`find_agents({ role })\`, \`find_agents({ capability })\`,
  or \`find_agents({ query })\` to search the live roster.

Classify any overlap and act accordingly:

- **Reuse** — an existing agent already covers the need → delegate to it, author nothing.
- **Extend** — close but its description misses the new trigger → rewrite the
  description (overwrite via \`write_agent\`), don't fork a twin.
- **New** — genuinely uncovered → proceed to Step 2.

Never create a second agent that does what an existing one already does.

## Step 2 — Pick a team architecture pattern

Choose the coordination shape deliberately instead of defaulting to head→IC. Map
each pattern to our primitives (\`send_and_wait\`, \`spawn\`, \`find_agents\`):

| Pattern | When | SwarmAgents shape |
|---|---|---|
| Pipeline | sequential, each step depends on the last | head chains \`send_and_wait\` IC→IC |
| Fan-out / Fan-in | independent parallel sub-tasks | head \`spawn\`s in parallel, then integrates |
| Expert Pool | one of several specialists fits per request | head selects an IC by \`capability\` via \`find_agents\` |
| Producer-Reviewer | output needs a quality gate | IC produces, reviewer reviews, head loops (= the dev team) |
| Supervisor | dynamic, stateful task distribution | head holds state and dispatches as work emerges |
| Hierarchical Delegation | large scope, recursive breakdown | head → sub-head → IC (= CEO → heads → ICs) |

**Where to draw agent boundaries** — split a new agent out only when one of these
holds, otherwise fold the work into an existing role:

- **Specialty** — distinct expertise needing its own system prompt.
- **Parallelism** — runs concurrently with other work.
- **Context** — needs an isolated context window to avoid bleed.
- **Reuse** — other teams will call it too.

## Step 3 — Authoring conventions

When you call \`write_agent\`, follow these conventions:

- **Description is trigger-first** — \`"Use when …"\`, describing *when to delegate*,
  not a feature list. It is the only signal a parent uses to route work.
- **A team head sets \`teamRole: 'head'\`** — otherwise it is invisible to the CEO's
  \`find_agents({ teamRole: 'head' })\` discovery and to the team selector. Each team
  has exactly one head.
- **ICs carry \`role\` and \`capabilities\`** so heads can discover them by tag.
- **\`toolScope\` is least privilege.** Pick the narrowest of
  \`all | fs | web | memory | peekaboo | authoring\`. \`authoring\` is privileged
  (it grants \`write_agent\` / \`write_skill\`) — grant it ONLY to training-type agents.
- **The head discovers teammates at runtime** — its system prompt must use
  \`find_agents({ team, role })\` and message the returned address. NEVER hardcode a
  teammate's instance name; names are per-run.
- **State the workflow and bound the loops** — a head's prompt spells out its
  numbered workflow and caps any fix/review loop (≤10 rounds) so it cannot spin.

For \`write_skill\`: trigger-first description, imperative body, explain *why* not just
*what*, and keep it lean (move long detail into the body's own sections, not a wall
of rules).

## Step 4 — Static dry-run validation

After writing, verify WITHOUT spawning any agent:

1. **Discoverability** — \`find_agents\` returns the head and every IC with the
   correct \`team\` / \`role\` / \`teamRole\` tags. If one is missing, the write was
   wrong — fix and re-author.
2. **Dead-link check** — every teammate \`role\` referenced in a head's system prompt
   resolves via \`find_agents\`. A head that messages a role nobody fills will hang.
3. **Trigger self-check** — write 3 phrasings that SHOULD route to the new agent and
   2 near-miss phrasings that should NOT. Read the description and confirm it matches
   the 3 and rejects the 2. Tighten the description if a near-miss would match.
4. **Honest errors** — if \`write_agent\` / \`write_skill\` returned an error, report it
   verbatim and fix it. Never claim a creation that was rejected.

## Step 5 — Evolution

Authoring is an overwrite, not an append — so evolve deliberately:

- **Read before you overwrite** — fetch the existing definition first, preserve what
  works, and change only what the feedback targets.
- **Log the change** — append one line to \`~/.swarm-agents/agents/CHANGELOG.md\`:
  \`YYYY-MM-DD — what changed (agent/skill id) — why\`. This gives the roster a
  traceable history and makes regressions visible.`,
  }
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npm test -- src/service/skills/builtins.test.ts`
Expected: PASS (all four `it` blocks green).

- [ ] **Step 5: Commit**

```bash
git add src/service/skills/builtins.ts src/service/skills/builtins.test.ts
git commit -m "feat(skills): add design-agent-team builtin skill"
```

---

### Task 2: Point the training team at the skill

**Files:**
- Modify: `src/shared/constants/agents.ts` (`TRAINING_HEAD_SYSTEM_PROMPT`, `TRAINING_AUTHOR_SYSTEM_PROMPT`)
- Test: `src/shared/constants/agents.test.ts`

**Interfaces:**
- Consumes: `defaultAgents` (existing export), the `byId` map in the existing test.
- Produces: both training prompts contain the substring `design-agent-team`.

- [ ] **Step 1: Write the failing test**

Append to the `describe('builtin roster', ...)` block in `src/shared/constants/agents.test.ts`:

```typescript
  it('the training team is pointed at the design-agent-team skill', () => {
    expect(byId['training-head'].systemPrompt).toContain('design-agent-team')
    expect(byId['training-author'].systemPrompt).toContain('design-agent-team')
  })
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npm test -- src/shared/constants/agents.test.ts`
Expected: FAIL — neither prompt contains `design-agent-team` yet.

- [ ] **Step 3: Add the pointer to both prompts**

In `src/shared/constants/agents.ts`, in `TRAINING_HEAD_SYSTEM_PROMPT`, replace the line:

```
  1. Read the request (e.g. "create a UI team", "add a docs-writer agent", "teach the company to do X").
```

with:

```
  0. Before anything, use_skill('design-agent-team') and follow its method (dedup, pattern choice, authoring conventions, validation, evolution).
  1. Read the request (e.g. "create a UI team", "add a docs-writer agent", "teach the company to do X").
```

In `TRAINING_AUTHOR_SYSTEM_PROMPT`, replace the line:

```
  1. Read the spec you were given (the agent's id, name, description, systemPrompt, toolScope, and optional team/teamRole/role/capabilities; or a skill's name/description/body).
```

with:

```
  0. Before authoring, use_skill('design-agent-team') and follow its authoring conventions and the static dry-run validation it describes.
  1. Read the spec you were given (the agent's id, name, description, systemPrompt, toolScope, and optional team/teamRole/role/capabilities; or a skill's name/description/body).
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npm test -- src/shared/constants/agents.test.ts`
Expected: PASS (including the existing roster tests, which still hold — only the two training prompts changed).

- [ ] **Step 5: Commit**

```bash
git add src/shared/constants/agents.ts src/shared/constants/agents.test.ts
git commit -m "feat(agents): point training team at design-agent-team skill"
```

---

## Self-Review

**Spec coverage:**
- Delivery (builtin skill in `builtins.ts` + training-prompt pointers) → Tasks 1 & 2. ✓
- Body Step 1 dedup / Step 2 patterns / Step 3 conventions / Step 4 static dry-run / Step 5 evolution+changelog → all present in Task 1 Step 3 body, asserted by Task 1 test. ✓
- Non-goals (no A/B, no references split, no CLAUDE.md, no opus mandate, no file translator) → none introduced. ✓
- Testing section (builtins.test.ts schema + anchors; agents.test.ts prompt pointers) → Tasks 1 & 2. ✓
- Changelog at `~/.swarm-agents/agents/CHANGELOG.md` → literal in body Step 5. ✓

**Placeholder scan:** No TBD/TODO; all code blocks complete; skill body is full text, not a summary. ✓

**Type consistency:** `designAgentTeam(): Skill` returns `{ name, description, body }` matching `Skill`; `name === 'design-agent-team'` consistent across body anchors, test, and both prompt pointers. ✓
