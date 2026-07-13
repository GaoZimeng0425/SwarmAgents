# Multi-Team Company Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add a multi-team company layer (CEO cross-team router → team heads → ICs) on the existing actor substrate, with a privileged "Agent training" team whose meta-tools author new agents/skills, and a composer team-selector that routes to a team head bypassing the CEO.

**Architecture:** Org structure is expressed as two lightweight tags on `AgentDefinition` (`team`, `teamRole`) plus prompt conventions; discovery is `find_agents` extended to filter by team/teamRole; no first-class Team/Org entity. The training team's differentiation is a real capability boundary: `write_agent`/`write_skill` live in a **privileged tool group** excluded from the `*` wildcard, reachable only by the new `authoring` toolScope. The composer select reuses the existing `options.agentType` plumbing.

**Tech Stack:** TypeScript, Electron (main/preload/renderer + a bundled `service/`), Zod schemas, Vitest (run via Electron node), pi-agent-core, React + TanStack Query (renderer).

## Global Constraints

- Run tests via Electron node: `npm test` (NEVER bare `npx vitest`; NEVER `pnpm rebuild better-sqlite3` — breaks the app ABI; restore with `npm run postinstall`).
- `src/service/**` is NOT in `pnpm typecheck` scope (electron-vite bundles it); rely on vitest to catch service type errors.
- Code comments and commit messages in English; conversation in Chinese.
- Implement in a dedicated git worktree on a branch off `develop` (CLAUDE.md §6).
- Structured logging (pino) on every business path: entry `info`, every `catch` `error`, branch surprises `warn` (CLAUDE.md §5). Match existing call sites.
- Surgical edits: every changed line traces to this plan. Follow existing factory+closure / builtins-array / single-file-slice patterns.
- The capability boundary is the allowlist, not the prompt (per the comment in `agent.ts` `deriveAllowlist`). Authoring tools must be unreachable by non-training agents.
- `teamRole: 'head'` is the single source of truth for "is a team entry point" — selector derivation, CEO discovery, and e2e assertions all read it; never duplicate the notion.

---

## Phase 1 — Data model + discovery (service, no UI)

### Task 1: Add `team`/`teamRole` to AgentDefinition + persist role/capabilities/team/teamRole

**Files:**
- Modify: `src/shared/types/agent.ts` (`AgentDefinitionSchema`, ~6-33)
- Modify: `src/service/agents/store.ts` (`parseAgent` ~38-47, `serializeAgent` ~50-60)
- Test: `src/service/agents/store.test.ts`

**Interfaces:**
- Produces: `AgentDefinition` gains `team?: string` and `teamRole?: 'head'`. `parseAgent`/`serializeAgent` now round-trip `role`, `capabilities`, `team`, `teamRole` in addition to the existing fields.

- [ ] **Step 1: Write the failing test**

Add to `src/service/agents/store.test.ts` (a fresh temp-dir store; mirror existing tests in that file for `tmpDir`/`createAgentStore` setup):

```ts
it('round-trips role, capabilities, team and teamRole through save + reload', () => {
  const store = createAgentStore({ dir: tmpDir })
  const def = {
    id: 'training-head',
    name: 'Training Lead',
    description: 'Use to coordinate the agent-training team.',
    systemPrompt: 'You lead the training team.',
    toolScope: 'authoring' as const,
    role: 'training-head',
    capabilities: ['agent-authoring', 'skill-authoring'],
    team: 'training',
    teamRole: 'head' as const,
    maxIterations: 20,
  }
  const res = store.save(def)
  expect(res.ok).toBe(true)
  store.reload()
  const got = store.get('training-head')
  expect(got).toMatchObject({
    role: 'training-head',
    capabilities: ['agent-authoring', 'skill-authoring'],
    team: 'training',
    teamRole: 'head',
  })
})
```

> Note: this test also exercises `toolScope: 'authoring'`, added in Task 4. If running Task 1 in isolation before Task 4, temporarily use `toolScope: 'all'`; switch back to `'authoring'` once Task 4 lands. (Subagent-driven execution runs tasks in order, so prefer `'authoring'`.)

- [ ] **Step 2: Run test to verify it fails**

Run: `npm test -- src/service/agents/store.test.ts`
Expected: FAIL — `got.team`/`teamRole`/`capabilities` are `undefined` (not persisted) and/or `toolScope: 'authoring'` rejected by the enum.

- [ ] **Step 3: Add the two schema fields**

In `src/shared/types/agent.ts`, inside `AgentDefinitionSchema`, after the `capabilities` field (~29):

```ts
  /** Team grouping tag for org-chart discovery; absent = not a team member (e.g. CEO, generic builtins). */
  team: z.string().optional(),
  /** Marks the team's entry-point agent (the "head"); absent = an individual contributor. */
  teamRole: z.enum(['head']).optional(),
```

- [ ] **Step 4: Persist the fields in the store**

In `src/service/agents/store.ts` `parseAgent`, extend the `safeParse` object (~38-46) to include:

```ts
    role: meta.role,
    capabilities: meta.capabilities,
    team: meta.team,
    teamRole: meta.teamRole,
```

In `serializeAgent` (~50-59), after the `maxIterations` line and before the `model` line, add:

```ts
  if (def.role) lines.push(`role: ${JSON.stringify(def.role)}`)
  if (def.capabilities?.length) lines.push(`capabilities: ${JSON.stringify(def.capabilities)}`)
  if (def.team) lines.push(`team: ${JSON.stringify(def.team)}`)
  if (def.teamRole) lines.push(`teamRole: ${JSON.stringify(def.teamRole)}`)
```

(YAML flow arrays like `["a","b"]` parse back to a JS array via `parseYaml`, so capabilities round-trips.)

- [ ] **Step 5: Run the tests and make sure they pass**

Run: `npm test -- src/service/agents/store.test.ts`
Expected: PASS, including the existing store tests.

- [ ] **Step 6: Commit**

```bash
git add src/shared/types/agent.ts src/service/agents/store.ts src/service/agents/store.test.ts
git commit -m "feat(agents): add team/teamRole fields and persist role/capabilities/team/teamRole on disk"
```

---

### Task 2: Extend discovery to filter by team / teamRole

**Files:**
- Modify: `src/shared/types/agent.ts` (`PeerQuery` ~37, `Peer` ~40-47)
- Modify: `src/service/directory/receptionist.ts` (`toPeer` ~20-30, `find` ~46-60)
- Test: `src/service/directory/receptionist.test.ts`

**Interfaces:**
- Consumes: `AgentDefinition.team`/`teamRole` (Task 1).
- Produces: `PeerQuery` gains `team?: string` and `teamRole?: 'head'`. `Peer` gains `team?: string` and `teamRole?: 'head'`. `AgentDirectory.find` filters on both.

- [ ] **Step 1: Write the failing test**

Add to `src/service/directory/receptionist.test.ts` (mirror its existing `createAgentDirectory({ listActors, isLive, getAgentDef })` setup with fake actors + defs):

```ts
it('filters peers by team and by teamRole', () => {
  // Set up 3 defs: pm (team dev, head), engineer (team dev), training-head (team training, head).
  // and 3 live actors pointing at them in one session. (Follow the file's existing helpers.)
  const dir = makeDirectoryWith([
    { id: 'pm', team: 'dev', teamRole: 'head' },
    { id: 'engineer', team: 'dev' },
    { id: 'training-head', team: 'training', teamRole: 'head' },
  ])
  expect(dir.find('s1', { team: 'dev' }).map((p) => p.role).sort()).toEqual(['engineer', 'pm'])
  expect(dir.find('s1', { teamRole: 'head' }).map((p) => p.role).sort()).toEqual(['pm', 'training-head'])
  expect(dir.find('s1', { team: 'dev', teamRole: 'head' }).map((p) => p.role)).toEqual(['pm'])
})
```

> `makeDirectoryWith` is shorthand — use the file's actual fixture style (build `Actor[]` + a `getAgentDef` map). Repeat the setup inline if no helper exists.

- [ ] **Step 2: Run test to verify it fails**

Run: `npm test -- src/service/directory/receptionist.test.ts`
Expected: FAIL — `team`/`teamRole` are not on `Peer` and `find` ignores them.

- [ ] **Step 3: Extend the types**

In `src/shared/types/agent.ts`, replace `PeerQuery` (~37):

```ts
/** A discovery query against the session's live agents. All fields optional; empty → match all. */
export type PeerQuery = { role?: string; capability?: string; query?: string; team?: string; teamRole?: 'head' }
```

In the `Peer` type (~40-47), add two fields:

```ts
  team?: string
  teamRole?: 'head'
```

- [ ] **Step 4: Populate + filter in the receptionist**

In `src/service/directory/receptionist.ts` `toPeer` (~20-30), add to the returned object:

```ts
      team: def?.team,
      teamRole: def?.teamRole,
```

In `find` (~46-60), after the existing `q.capability` filter line, add:

```ts
      if (q.team) peers = peers.filter((p) => p.team === q.team)
      if (q.teamRole) peers = peers.filter((p) => p.teamRole === q.teamRole)
```

- [ ] **Step 5: Run the tests and make sure they pass**

Run: `npm test -- src/service/directory/receptionist.test.ts`
Expected: PASS, including existing role/capability/query tests.

- [ ] **Step 6: Commit**

```bash
git add src/shared/types/agent.ts src/service/directory/receptionist.ts src/service/directory/receptionist.test.ts
git commit -m "feat(directory): filter discovery by team and teamRole"
```

---

### Task 3: Pass team/teamRole through the find_agents tool

**Files:**
- Modify: `src/service/tools/messaging.ts` (`FindParams` ~55-59, `findAgentsSpec` output ~78-81)
- Test: `src/service/tools/messaging.test.ts`

**Interfaces:**
- Consumes: `ctx.findPeers(q: PeerQuery)` (already passes the raw params object through).
- Produces: `find_agents` accepts `team`/`teamRole`; output lines show the team when present.

- [ ] **Step 1: Write the failing test**

Add to `src/service/tools/messaging.test.ts` (mirror its existing `findAgentsSpec().build(ctx)` pattern with a fake `ctx.findPeers`):

```ts
it('forwards team/teamRole to findPeers and shows team in output', async () => {
  const seen: unknown[] = []
  const ctx = makeCtx({
    findPeers: (q) => {
      seen.push(q)
      return [{ name: 'PM', address: 'a1', role: 'pm', capabilities: [], description: 'lead', status: 'active', team: 'dev', teamRole: 'head' }]
    },
  })
  const tool = findAgentsSpec().build(ctx)
  const res = await tool.execute('1', { team: 'dev', teamRole: 'head' })
  expect(seen[0]).toEqual({ team: 'dev', teamRole: 'head' })
  expect(textOf(res)).toContain('team dev')
})
```

> `makeCtx`/`textOf` — use the file's existing helpers (or inline a minimal `ToolRunContext` stub + read `res.content[0].text`).

- [ ] **Step 2: Run test to verify it fails**

Run: `npm test -- src/service/tools/messaging.test.ts`
Expected: FAIL — params lack team/teamRole (TypeBox strips unknown keys) and output has no team.

- [ ] **Step 3: Add params + output**

In `src/service/tools/messaging.ts`, extend `FindParams` (~55-59):

```ts
  team: Type.Optional(Type.String({ description: 'Filter to agents on this team, e.g. "dev" or "training".' })),
  teamRole: Type.Optional(Type.String({ description: 'Filter to a team role; use "head" to find each team\'s entry-point agent.' })),
```

In the output `lines` map (~78-81), append a team marker:

```ts
        const lines = peers.map((p) => {
          const caps = p.capabilities.length ? ` · caps: ${p.capabilities.join(', ')}` : ''
          const team = p.team ? ` · team ${p.team}${p.teamRole === 'head' ? ' (head)' : ''}` : ''
          return `- ${p.name ?? '(unnamed)'} (role ${p.role}) · ${p.address} · ${p.status}${team} · ${p.description}${caps}`
        })
```

- [ ] **Step 4: Run the tests and make sure they pass**

Run: `npm test -- src/service/tools/messaging.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/service/tools/messaging.ts src/service/tools/messaging.test.ts
git commit -m "feat(tools): find_agents accepts team/teamRole and shows team in results"
```

---

## Phase 2 — Privileged authoring capability (training team)

### Task 4: Privileged tool group excluded from `*`, plus the `authoring` toolScope

**Files:**
- Modify: `src/service/tools/registry.ts` (`specMatches` ~112-119)
- Modify: `src/shared/types/agent.ts` (`ToolScopeSchema` ~3, `deriveAllowlist` ~54-70)
- Test: `src/service/tools/registry.test.ts`, `src/shared/types/agent.test.ts` (create the latter if absent)

**Interfaces:**
- Produces: tools in group `authoring` are NOT granted by `*`/`all`; they require an explicit `authoring.*` (or `authoring.<name>`) pattern. New toolScope `'authoring'` → allowlist `['authoring.*', 'agent.*', 'fs.*', 'web.*', 'shell.*']`.

- [ ] **Step 1: Write the failing tests**

Add to `src/service/tools/registry.test.ts` (mirror its registry-creation + `resolve` style; register a throwaway spec in group `authoring`):

```ts
it('excludes privileged "authoring" group from the * wildcard but grants it on explicit authoring.*', () => {
  const reg = createToolRegistry()
  const spec = { group: 'authoring', name: 'write_agent', risk: 'medium' as const, source: 'builtin' as const, build: () => ({ name: 'write_agent', label: 'x', description: 'x', parameters: {} as never, execute: async () => ({ content: [] }) }) }
  reg.register(spec)
  const ctx = {} as never
  expect(reg.resolve(['*'], ctx).tools.map((t) => t.name)).not.toContain('write_agent')
  expect(reg.resolve(['authoring.*'], ctx).tools.map((t) => t.name)).toContain('write_agent')
})
```

Add to `src/shared/types/agent.test.ts`:

```ts
import { describe, expect, it } from 'vitest'
import { deriveAllowlist } from './agent'

describe('deriveAllowlist', () => {
  it('maps the authoring scope to the authoring group plus coordination tools', () => {
    expect(deriveAllowlist('authoring')).toEqual(['authoring.*', 'agent.*', 'fs.*', 'web.*', 'shell.*'])
  })
})
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npm test -- src/service/tools/registry.test.ts src/shared/types/agent.test.ts`
Expected: FAIL — `*` currently grants every group; `deriveAllowlist('authoring')` is a type error / unhandled case.

- [ ] **Step 3: Add the privileged-group exclusion**

In `src/service/tools/registry.ts`, above `specMatches` (~112), add:

```ts
// Privileged groups are NOT granted by the `*`/`all` wildcard — they must be
// listed explicitly (e.g. `authoring.*`). This is how a capability stays
// exclusive to specific agents even though most agents run with toolScope 'all'.
const PRIVILEGED_GROUPS = new Set(['authoring'])
```

Replace the wildcard branch in `specMatches` (~114-118):

```ts
function specMatches(spec: ToolSpec, allowlist: string[]): boolean {
  return allowlist.some((pattern) => {
    if (pattern === '*' || pattern === 'all') return !PRIVILEGED_GROUPS.has(spec.group)
    if (pattern.endsWith('.*')) return spec.group === pattern.slice(0, -2)
    return pattern === `${spec.group}.${spec.name}`
  })
}
```

- [ ] **Step 4: Add the `authoring` scope**

In `src/shared/types/agent.ts`, extend `ToolScopeSchema` (~3):

```ts
export const ToolScopeSchema = z.enum(['peekaboo', 'web', 'fs', 'memory', 'authoring', 'all'])
```

Add a case in `deriveAllowlist` (before `case 'memory'` or after — any spot in the switch):

```ts
    case 'authoring':
      // Privileged: authoring.* is excluded from '*' (see tools/registry PRIVILEGED_GROUPS),
      // so only this scope can reach write_agent/write_skill. Plus the coordination
      // tools a team head needs to delegate and read.
      return ['authoring.*', 'agent.*', 'fs.*', 'web.*', 'shell.*']
```

- [ ] **Step 5: Run the tests and make sure they pass**

Run: `npm test -- src/service/tools/registry.test.ts src/shared/types/agent.test.ts`
Expected: PASS. Also run the full suite once to confirm no count-based assertion elsewhere assumed `*` grants a (currently nonexistent) authoring group: `npm test`.

- [ ] **Step 6: Commit**

```bash
git add src/service/tools/registry.ts src/shared/types/agent.ts src/service/tools/registry.test.ts src/shared/types/agent.test.ts
git commit -m "feat(tools): privileged group exclusion from wildcard + authoring toolScope"
```

---

### Task 5: Wire `writeAgent`/`writeSkill` through the run context

**Files:**
- Modify: `src/service/tools/registry.ts` (`ToolRunContext` ~13-44)
- Modify: `src/service/session/agent-runner.ts` (`AgentRunnerDeps` ~140-170, `buildToolContext` ~205-235)
- Modify: `src/service/session/manager.ts` (the three `AgentRunnerDeps` construction sites: ~330, ~508, ~726)
- Test: `src/service/session/agent-runner.test.ts` (buildToolContext) — or wherever `buildToolContext` is currently tested

**Interfaces:**
- Consumes: `AgentStore.save(def): AgentMutationResult` and `SkillStore.save(skill): SkillMutationResult` (existing).
- Produces: `ToolRunContext.writeAgent?(def): AgentMutationResult` and `ToolRunContext.writeSkill?(skill): SkillMutationResult`; `AgentRunnerDeps` gains the same optional functions; `buildToolContext` forwards them.

- [ ] **Step 1: Write the failing test**

Add to the file that tests `buildToolContext` (mirror existing `buildToolContext(deps)` tests):

```ts
it('forwards writeAgent/writeSkill from deps to the tool context', () => {
  const calls: string[] = []
  const ctx = buildToolContext({
    ...baseDeps, // the file's existing minimal AgentRunnerDeps fixture
    writeAgent: () => { calls.push('agent'); return { ok: true, agents: [] } },
    writeSkill: () => { calls.push('skill'); return { ok: true, skills: [] } },
  })
  ctx.writeAgent?.({} as never)
  ctx.writeSkill?.({} as never)
  expect(calls).toEqual(['agent', 'skill'])
})
```

> Use the file's existing `baseDeps`/fixture name. `SkillMutationResult`'s ok shape is `{ ok: true, skills: Skill[] }` — confirm against `@shared/types/skill` and adjust the stub if the property differs.

- [ ] **Step 2: Run test to verify it fails**

Run: `npm test -- src/service/session/agent-runner.test.ts`
Expected: FAIL — `writeAgent`/`writeSkill` are not on `ToolRunContext`/`AgentRunnerDeps`.

- [ ] **Step 3: Add to ToolRunContext**

In `src/service/tools/registry.ts`, add imports at top:

```ts
import type { AgentDefinition } from '@shared/types/agent'
import type { AgentMutationResult } from '../agents/store'
import type { Skill, SkillMutationResult } from '@shared/types/skill'
```

> `AgentMutationResult` is exported from `../agents/store`. `SkillMutationResult` is in `@shared/types/skill` (confirm; the skills store imports it from there). If importing from `../agents/store` introduces an unwanted module cycle in bundling, instead inline the result type: `type WriteResult = { ok: true } | { ok: false; code: string; message: string }` and use it for both. Prefer the real types if no cycle appears (service is bundled, cycles among type-only imports are erased).

Add to the `ToolRunContext` interface (after `findPeers`, ~43):

```ts
  /** Author/overwrite an agent definition on disk (training team only; absent for other agents). */
  writeAgent?(def: AgentDefinition): AgentMutationResult
  /** Author/overwrite a skill on disk (training team only; absent for other agents). */
  writeSkill?(skill: Skill): SkillMutationResult
```

- [ ] **Step 4: Add to AgentRunnerDeps + buildToolContext**

In `src/service/session/agent-runner.ts`, add the same two optional members to `AgentRunnerDeps` (after `findPeers?`, ~166). Add the imports for `AgentDefinition`/`Skill`/result types if not already present (mirror Step 3). Then in `buildToolContext` (~205-235), after the `findPeers` line, add:

```ts
    writeAgent: deps.writeAgent,
    writeSkill: deps.writeSkill,
```

- [ ] **Step 5: Bind them in the manager**

In `src/service/session/manager.ts`, at each of the three `AgentRunnerDeps` objects (search for `findPeers: (q) => directory.find`), add directly beneath the `findPeers` line:

```ts
      writeAgent: (def) => cfg.agentStore?.save(def) ?? { ok: false, code: 'no_store', message: 'agent store unavailable' },
      writeSkill: (skill) => cfg.skillStore?.save(skill) ?? { ok: false, code: 'no_store', message: 'skill store unavailable' },
```

(`cfg.agentStore`/`cfg.skillStore` already exist on the manager config, ~73-74.)

- [ ] **Step 6: Run the tests and make sure they pass**

Run: `npm test -- src/service/session/agent-runner.test.ts`
Expected: PASS.

- [ ] **Step 7: Commit**

```bash
git add src/service/tools/registry.ts src/service/session/agent-runner.ts src/service/session/manager.ts src/service/session/agent-runner.test.ts
git commit -m "feat(session): wire writeAgent/writeSkill through the tool run context"
```

---

### Task 6: The `write_agent` / `write_skill` tools

**Files:**
- Create: `src/service/tools/authoring.ts`
- Modify: `src/service/tools/builtins.ts` (`registerBuiltinTools` ~62-101)
- Test: `src/service/tools/authoring.test.ts`

**Interfaces:**
- Consumes: `ctx.writeAgent`/`ctx.writeSkill` (Task 5).
- Produces: `writeAgentSpec(): ToolSpec` and `writeSkillSpec(): ToolSpec`, both `group: 'authoring'`, `risk: 'medium'`, registered in `registerBuiltinTools`.

- [ ] **Step 1: Write the failing test**

Create `src/service/tools/authoring.test.ts`:

```ts
import { describe, expect, it } from 'vitest'
import { writeAgentSpec, writeSkillSpec } from './authoring'
import type { ToolRunContext } from './registry'

const textOf = (r: { content: { type: string; text?: string }[] }): string =>
  r.content.map((c) => c.text ?? '').join('')

function ctxWith(over: Partial<ToolRunContext>): ToolRunContext {
  return { sessionId: 's', findPeers: () => [], ...over } as unknown as ToolRunContext
}

describe('write_agent', () => {
  it('builds an AgentDefinition and calls ctx.writeAgent, reporting success', async () => {
    let saved: { id?: string } = {}
    const tool = writeAgentSpec().build(ctxWith({ writeAgent: (def) => { saved = def; return { ok: true, agents: [] } } }))
    const res = await tool.execute('1', {
      id: 'docs-writer', name: 'Docs Writer', description: 'Use to write docs.',
      systemPrompt: 'You write docs.', toolScope: 'all', team: 'docs', role: 'docs-writer',
    })
    expect(saved.id).toBe('docs-writer')
    expect(textOf(res)).toMatch(/created|saved/i)
  })

  it('reports the validation error when the store rejects the definition', async () => {
    const tool = writeAgentSpec().build(ctxWith({ writeAgent: () => ({ ok: false, code: 'invalid', message: 'bad id' }) }))
    const res = await tool.execute('1', { id: 'X', name: 'n', description: 'd', systemPrompt: 'p', toolScope: 'all' })
    expect(textOf(res)).toContain('bad id')
  })

  it('errors clearly when authoring is unavailable to this agent', async () => {
    const tool = writeAgentSpec().build(ctxWith({})) // no writeAgent injected
    const res = await tool.execute('1', { id: 'a', name: 'n', description: 'd', systemPrompt: 'p', toolScope: 'all' })
    expect(textOf(res)).toMatch(/not available|unavailable/i)
  })
})

describe('write_skill', () => {
  it('builds a Skill and calls ctx.writeSkill', async () => {
    let saved: { name?: string } = {}
    const tool = writeSkillSpec().build(ctxWith({ writeSkill: (s) => { saved = s; return { ok: true, skills: [] } } }))
    const res = await tool.execute('1', { name: 'my-skill', description: 'Use to do X.', body: '# steps' })
    expect(saved.name).toBe('my-skill')
    expect(textOf(res)).toMatch(/created|saved/i)
  })
})
```

> Confirm `SkillMutationResult`'s success property name (`skills`) against `@shared/types/skill`; adjust stubs if different.

- [ ] **Step 2: Run test to verify it fails**

Run: `npm test -- src/service/tools/authoring.test.ts`
Expected: FAIL — `./authoring` does not exist.

- [ ] **Step 3: Implement the tools**

Create `src/service/tools/authoring.ts`:

```ts
import type { AgentTool } from '@earendil-works/pi-agent-core'
import { Type } from '@earendil-works/pi-ai'
import { createLogger } from '@shared/logger'
import type { AgentDefinition } from '@shared/types/agent'
import type { Skill } from '@shared/types/skill'

import type { ToolRunContext, ToolSpec } from './registry'

const log = createLogger({ process: 'service' }).child({ component: 'tools' })

const WriteAgentParams = Type.Object({
  id: Type.String({ description: 'Folder-name id: lowercase a-z/0-9 with single hyphens, ≤64 chars.' }),
  name: Type.String({ description: 'Human-readable display name.' }),
  description: Type.String({ description: 'Trigger-first one-liner ("Use when …") shown in the sub-agent catalog.' }),
  systemPrompt: Type.String({ description: 'The agent\'s full system prompt (its job, teammates, conventions).' }),
  toolScope: Type.String({ description: "Capability scope: 'all' | 'fs' | 'web' | 'memory' | 'peekaboo' | 'authoring'." }),
  team: Type.Optional(Type.String({ description: 'Team tag, e.g. "dev" or "ui".' })),
  teamRole: Type.Optional(Type.String({ description: "Set to 'head' to make this the team's entry-point agent." })),
  role: Type.Optional(Type.String({ description: 'Discoverable role handle; defaults to the id when unset.' })),
  capabilities: Type.Optional(Type.Array(Type.String(), { description: 'Capability tags for discovery.' })),
  maxIterations: Type.Optional(Type.Number({ description: 'Max agent loop iterations (default 25).' })),
})

export function writeAgentSpec(): ToolSpec {
  return {
    group: 'authoring',
    name: 'write_agent',
    risk: 'medium',
    source: 'builtin',
    build: (ctx: ToolRunContext): AgentTool => ({
      name: 'write_agent',
      label: 'Author an agent',
      description:
        'Create or overwrite an agent definition on disk (in ~/.swarm-agents/agents). The new agent becomes immediately discoverable via find_agents. Use to grow the company with new roles or teams.',
      parameters: WriteAgentParams,
      execute: async (_id: string, params: unknown) => {
        const p = params as Partial<AgentDefinition>
        if (!ctx.writeAgent) {
          return { content: [{ type: 'text', text: 'Authoring is not available to this agent.' }] }
        }
        log.info({ msg: 'write_agent', id: p.id, team: p.team })
        const res = ctx.writeAgent(p as AgentDefinition)
        if (!res.ok) {
          log.warn({ msg: 'write_agent rejected', id: p.id, code: res.code })
          return { content: [{ type: 'text', text: `Could not create agent: ${res.message}` }] }
        }
        return { content: [{ type: 'text', text: `Agent "${p.id}" created. It is now discoverable via find_agents.` }] }
      },
    }),
  }
}

const WriteSkillParams = Type.Object({
  name: Type.String({ description: 'Skill folder name (becomes ~/.swarm-agents/skills/<name>/SKILL.md).' }),
  description: Type.String({ description: 'Trigger-first one-liner describing when to use the skill.' }),
  body: Type.String({ description: 'The skill body (markdown instructions).' }),
})

export function writeSkillSpec(): ToolSpec {
  return {
    group: 'authoring',
    name: 'write_skill',
    risk: 'medium',
    source: 'builtin',
    build: (ctx: ToolRunContext): AgentTool => ({
      name: 'write_skill',
      label: 'Author a skill',
      description:
        'Create or overwrite a skill on disk (in ~/.swarm-agents/skills). The skills directory hot-reloads, so the skill becomes usable shortly after. Use to teach the company a reusable procedure.',
      parameters: WriteSkillParams,
      execute: async (_id: string, params: unknown) => {
        const p = params as Skill
        if (!ctx.writeSkill) {
          return { content: [{ type: 'text', text: 'Authoring is not available to this agent.' }] }
        }
        log.info({ msg: 'write_skill', name: p.name })
        const res = ctx.writeSkill(p)
        if (!res.ok) {
          log.warn({ msg: 'write_skill rejected', name: p.name, code: res.code })
          return { content: [{ type: 'text', text: `Could not create skill: ${res.message}` }] }
        }
        return { content: [{ type: 'text', text: `Skill "${p.name}" created.` }] }
      },
    }),
  }
}
```

- [ ] **Step 4: Register the tools**

In `src/service/tools/builtins.ts`, add the import near the messaging import (~8):

```ts
import { writeAgentSpec, writeSkillSpec } from './authoring'
```

In `registerBuiltinTools`, after `registry.register(findAgentsSpec())` (~92):

```ts
  registry.register(writeAgentSpec())
  registry.register(writeSkillSpec())
```

- [ ] **Step 5: Run the tests and make sure they pass**

Run: `npm test -- src/service/tools/authoring.test.ts`
Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add src/service/tools/authoring.ts src/service/tools/builtins.ts src/service/tools/authoring.test.ts
git commit -m "feat(tools): write_agent and write_skill authoring tools (privileged authoring group)"
```

---

## Phase 3 — Roster + collaboration e2e

### Task 7: Tag the dev team, rewrite CEO/PM prompts, add the training team

**Files:**
- Modify: `src/shared/agents/builtins.ts` (prompts ~40-75; ceo/pm/engineer/reviewer defs ~119-163; add two training defs + their prompts)
- Test: `src/shared/agents/builtins.test.ts` (create if absent)

**Interfaces:**
- Consumes: `team`/`teamRole` (Task 1), `authoring` scope (Task 4).
- Produces: `builtinAgents` contains `ceo` (no team), `pm`(team `dev`, teamRole `head`), `engineer`/`reviewer`(team `dev`), `training-head`(team `training`, teamRole `head`, scope `authoring`), `training-author`(team `training`, scope `authoring`).

- [ ] **Step 1: Write the failing test**

Create `src/shared/agents/builtins.test.ts`:

```ts
import { describe, expect, it } from 'vitest'
import { AgentDefinitionSchema } from '@shared/types/agent'
import { builtinAgents } from './builtins'

describe('builtin roster', () => {
  const byId = Object.fromEntries(builtinAgents.map((a) => [a.id, a]))

  it('every builtin is a valid AgentDefinition with a unique id', () => {
    const ids = builtinAgents.map((a) => a.id)
    expect(new Set(ids).size).toBe(ids.length)
    for (const a of builtinAgents) expect(AgentDefinitionSchema.safeParse(a).success).toBe(true)
  })

  it('dev team is tagged with pm as head', () => {
    expect(byId.pm).toMatchObject({ team: 'dev', teamRole: 'head' })
    expect(byId.engineer).toMatchObject({ team: 'dev' })
    expect(byId.reviewer).toMatchObject({ team: 'dev' })
    expect(byId.ceo.team).toBeUndefined()
  })

  it('ships a training team with a head and an authoring IC', () => {
    expect(byId['training-head']).toMatchObject({ team: 'training', teamRole: 'head', toolScope: 'authoring' })
    expect(byId['training-author']).toMatchObject({ team: 'training', toolScope: 'authoring' })
  })

  it('exactly two teams have a head (dev, training)', () => {
    const heads = builtinAgents.filter((a) => a.teamRole === 'head').map((a) => a.team).sort()
    expect(heads).toEqual(['dev', 'training'])
  })

  it('CEO discovers heads and PM discovers the dev team by tag', () => {
    expect(byId.ceo.systemPrompt).toContain("teamRole: 'head'")
    expect(byId.pm.systemPrompt).toContain("team: 'dev'")
  })
})
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npm test -- src/shared/agents/builtins.test.ts`
Expected: FAIL — no team tags, no training defs.

- [ ] **Step 3: Tag dev team + rewrite CEO/PM prompts**

In `src/shared/agents/builtins.ts`, replace `CEO_SYSTEM_PROMPT` with a heads-discovery version:

```ts
const CEO_SYSTEM_PROMPT = `You are the CEO of a software company with multiple teams. You receive a single high-level goal and deliver the finished result by coordinating team heads.

Your teams are discovered at runtime — do NOT assume names.

Workflow:
  1. Read the goal. Do NOT do the work yourself.
  2. Discover the team leads: call find_agents({ teamRole: 'head' }). Each result is one team's entry point.
  3. Pick the team(s) whose remit fits the goal and delegate with full context: send_and_wait(<head address>, <the goal plus any constraints>). For work spanning teams, delegate the parts and integrate the replies.
  4. When the head(s) return their deliverables, produce a concise final summary of what was built and its status.
  5. Your reply to the original request IS that final summary — it is the result of the entire run.`
```

Replace `PM_SYSTEM_PROMPT` to discover within the dev team:

```ts
const PM_SYSTEM_PROMPT = `You are the head of the DEVELOPMENT team (Project Manager). You turn a goal into a concrete deliverable by coordinating your team's engineer and reviewer.

Discover your teammates at runtime within your team — do NOT assume names:
  - engineer: find_agents({ team: 'dev', role: 'engineer' }) — implements code and runs tests.
  - reviewer: find_agents({ team: 'dev', role: 'reviewer' }) — reviews the engineer's output.
Take the first result's address for each and message that address.

Workflow:
  1. Break the goal into a concrete implementation task (what to build, where, acceptance criteria).
  2. send_and_wait(<engineer address>, <the concrete task, including the working directory to use>).
  3. When the engineer reports done, request a review: send_and_wait(<reviewer address>, <what to review and the artifact location>).
  4. If the reviewer reports issues, send the fixes back to the engineer, then review again.
  5. Repeat the fix/review loop AT MOST 10 times. If still not passing, stop and summarize with an explicit "did not meet bar" note.
  6. Return a consolidated deliverable summary (what was built, where, test/review status) to whoever delegated to you.`
```

Add the team tags to the four dev defs (~119-163):
- `ceo`: leave as-is (no `team`).
- `pm`: add `team: 'dev',` and `teamRole: 'head',`.
- `engineer`: add `team: 'dev',`.
- `reviewer`: add `team: 'dev',`.

- [ ] **Step 4: Add the training team**

In `src/shared/agents/builtins.ts`, add two prompt constants (near the others):

```ts
const TRAINING_HEAD_SYSTEM_PROMPT = `You are the head of the AGENT TRAINING team. Your team designs, builds and improves the company's own agents and skills.

Discover your teammate at runtime — do NOT assume names:
  - author: find_agents({ team: 'training' }) — has the write_agent and write_skill tools.

Workflow:
  1. Read the request (e.g. "create a UI team", "add a docs-writer agent", "teach the company to do X").
  2. Decide what agents/skills are needed. For a new team, define a head (teamRole: 'head') plus its ICs.
  3. Delegate the authoring to your team's author: send_and_wait(<author address>, <exact agent/skill specs: id, name, description, systemPrompt, toolScope, team, teamRole, role>).
  4. When the author reports the artifacts written, summarize what was created and where, and that they are now discoverable via find_agents.
  Do NOT write code or drive UIs — your team's product is agents and skills.`

const TRAINING_AUTHOR_SYSTEM_PROMPT = `You are an Agent/Skill Author on the training team. You materialize agent and skill specifications onto disk.

You have write_agent and write_skill (no other team has these).

Workflow:
  1. Read the spec you were given (the agent's id, name, description, systemPrompt, toolScope, and optional team/teamRole/role/capabilities; or a skill's name/description/body).
  2. For a new team, the head agent MUST have teamRole: 'head' so it appears in the company's team selector and in CEO discovery.
  3. Call write_agent / write_skill once per artifact. Use a trigger-first description ("Use when …").
  4. Report back exactly what you created (ids/names) and confirm each was accepted. If a write was rejected, report the error verbatim — do not claim success you did not get.`
```

Add the two defs to the `builtinAgents` array (after `reviewer`):

```ts
  {
    id: 'training-head',
    name: 'Training Lead',
    description:
      'Use when the company needs a new agent, a new team, or a new skill authored — coordinates designing and writing agent/skill definitions.',
    systemPrompt: TRAINING_HEAD_SYSTEM_PROMPT,
    toolScope: 'authoring',
    maxIterations: 20,
    role: 'training-head',
    capabilities: ['agent-design', 'team-design'],
    team: 'training',
    teamRole: 'head',
  },
  {
    id: 'training-author',
    name: 'Agent Author',
    description:
      'Use to write an agent or skill definition to disk from a concrete spec; the only agent with write_agent / write_skill.',
    systemPrompt: TRAINING_AUTHOR_SYSTEM_PROMPT,
    toolScope: 'authoring',
    maxIterations: 20,
    role: 'training-author',
    capabilities: ['agent-authoring', 'skill-authoring'],
    team: 'training',
  },
```

- [ ] **Step 5: Run the tests and make sure they pass**

Run: `npm test -- src/shared/agents/builtins.test.ts`
Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add src/shared/agents/builtins.ts src/shared/agents/builtins.test.ts
git commit -m "feat(agents): tag dev team, rewrite CEO/PM discovery prompts, add training team"
```

---

### Task 8: Multi-team collaboration e2e (stub-agent)

**Files:**
- Create: `src/service/e2e/multi-team-company.e2e.test.ts` (mirror the existing `company.e2e.test.ts` / `agent-cluster*.e2e.test.ts` stub-agent harness)
- Test: itself

**Interfaces:**
- Consumes: the seeded roster (Task 7), `find_agents` team/teamRole filtering (Tasks 2-3), `startCompany` or the manager's actor seeding (existing).

- [ ] **Step 1: Read the existing harness**

Open `src/service/e2e/company.e2e.test.ts` and reuse its exact setup: how it builds a `SessionManager` with a stub agent-runner, how it seeds actors / calls `startCompany`, and how the stub script drives `find_agents`/`send_and_wait` per role. Do NOT invent a new harness.

- [ ] **Step 2: Write the e2e test**

Create `src/service/e2e/multi-team-company.e2e.test.ts`. The stub agent-runner branches on the actor's `agentDefId` (or role), driving:

```
ceo: find_agents({ teamRole: 'head' }) → assert it returns pm + training-head →
     send_and_wait(<pm address>, goal)
pm:  find_agents({ team: 'dev', role: 'engineer' }) → send_and_wait(<engineer>, task) →
     find_agents({ team: 'dev', role: 'reviewer' }) → send_and_wait(<reviewer>, review) →
     reply "deliverable: <summary>"
engineer: reply "built X, tests pass"
reviewer: reply "APPROVED"
```

Assertions:
- The session seeds named actors for ceo, pm, engineer, reviewer, training-head, training-author (assert via the directory: `find('s', {})` contains all six roles).
- `find('s', { teamRole: 'head' })` returns exactly `pm` and `training-head`.
- `find('s', { team: 'dev' })` returns `pm`, `engineer`, `reviewer`.
- The CEO's final reply (the run result) contains the deliverable summary that flowed pm→engineer→reviewer→pm→ceo.

> Drive discovery through the real `createAgentDirectory` wired to the manager (so team/teamRole filtering is exercised end-to-end), with only the agent-runner stubbed.

- [ ] **Step 3: Run the test**

Run: `npm test -- src/service/e2e/multi-team-company.e2e.test.ts`
Expected: PASS (write the stub to make the assertions hold; iterate until green).

- [ ] **Step 4: Run the full suite (regression)**

Run: `npm test`
Expected: all prior e2e (company / agent-cluster) + Phase 1-3 suites green, 0 failures.

- [ ] **Step 5: Commit**

```bash
git add src/service/e2e/multi-team-company.e2e.test.ts
git commit -m "test(e2e): multi-team company routing (CEO→heads, dev head→team ICs)"
```

---

## Phase 4 — Composer team selector (UI)

### Task 9: Expose the agent roster to the renderer

**Files:**
- Modify: `src/main/service-client.ts` (interface ~50, impl ~151 — mirror `listSkills`)
- Modify: the service-side RPC surface that backs `serviceClient` calls (mirror how `listSkills` resolves to `agentStore.list()` — find the handler that answers `'listSkills'`)
- Modify: `src/main/ipc/swarm-ipc.ts` (~81, add an `agents:list` handle)
- Modify: `src/preload/index.ts` (add an `agents.list` bridge, mirroring the skills bridge)
- Modify: `src/renderer/src/lib/api.ts` (add `listAgents`)
- Test: an existing service test that already covers `listSkills`/store wiring, extended; or a focused unit on the new service method

**Interfaces:**
- Produces: `swarmApi.listAgents(): Promise<AgentDefinition[]>` in the renderer, returning `agentStore.list()` (builtins merged with disk).

- [ ] **Step 1: Trace the `listSkills` path end-to-end**

`serviceClient.listSkills` (`src/main/service-client.ts:151` → `call('listSkills', [])`) resolves on the service side wherever `listSkills` is handled (it returns `skillStore.list()`). Find that handler and the preload `skills` bridge entry. You will mirror each hop for `listAgents`.

- [ ] **Step 2: Add the service method**

On the service RPC surface (next to `listSkills`), add:

```ts
listAgents(): AgentDefinition[] {
  return agentStore.list()
}
```

In `src/main/service-client.ts`, add to the interface (~50) and impl (~151):

```ts
  listAgents(): Promise<AgentDefinition[]>
```
```ts
    listAgents() {
      return call('listAgents', [])
    },
```

(Import `AgentDefinition` from `@shared/types/agent` in `service-client.ts`.)

- [ ] **Step 3: Add the IPC handle**

In `src/main/ipc/swarm-ipc.ts`, beside the `skills:list` handle (~81):

```ts
  ipcMain.handle('agents:list', () => serviceClient.listAgents())
```

- [ ] **Step 4: Add the preload bridge + renderer api**

In `src/preload/index.ts`, mirror the skills bridge with:

```ts
  agents: {
    list: () => ipcRenderer.invoke('agents:list') as Promise<import('@shared/types/agent').AgentDefinition[]>,
  },
```

In `src/renderer/src/lib/api.ts`, add to `swarmApi`:

```ts
  listAgents: () => window.api.agents.list(),
```

(Match the file's actual bridge access pattern — adjust `window.api...` to however `swarmApi` reaches preload in that file.)

- [ ] **Step 5: Smoke-build + verify wiring compiles**

Run: `npm test` (the main/preload/renderer ARE in typecheck scope, unlike service). Also run `npm run typecheck`.
Expected: 0 type errors; tests green.

- [ ] **Step 6: Commit**

```bash
git add src/main/service-client.ts src/main/ipc/swarm-ipc.ts src/preload/index.ts src/renderer/src/lib/api.ts
git commit -m "feat(ipc): expose agent roster (listAgents) to the renderer"
```

---

### Task 10: Team selector in the composer

**Files:**
- Create: `src/renderer/src/hooks/use-agents.ts` (TanStack Query hook over `swarmApi.listAgents`)
- Modify: `src/renderer/src/components/chat-input.tsx` (props ~36-55; controls row ~340-360 near `ComposerCwdMenu`)
- Modify: `src/renderer/src/components/views/tasks-view.tsx` (`taskOptions` ~59; `SessionSettings`; pass team props to `ChatInput`)
- Modify: `src/renderer/src/components/views/home-composer.tsx` (same wiring for the first-turn composer)
- Modify: `src/shared/types/task.ts` (`SessionSettings` — add `agentType?`, if that type carries cwd/permissionMode/executionMode)
- Test: `src/renderer/src/components/chat-input.test.tsx`

**Interfaces:**
- Consumes: `swarmApi.listAgents` (Task 9); `options.agentType` (already plumbed through `useSubmitGoal` → `swarmApi.submitGoal`).
- Produces: a `<Select>` listing "公司 (CEO)" + one entry per `teamRole === 'head'` agent; the chosen value flows into `taskOptions.agentType`.

- [ ] **Step 1: Write the failing test**

Add to `src/renderer/src/components/chat-input.test.tsx` (mirror its existing render + control assertions; the team list is passed in as a prop so the test needs no IPC mock):

```ts
it('shows a team selector with the company default plus team heads and submits the chosen head', async () => {
  const onSubmit = vi.fn()
  const teams = [
    { id: 'ceo', label: '公司 (CEO)' },
    { id: 'pm', label: '开发团队' },
    { id: 'training-head', label: 'Agent 训练团队' },
  ]
  render(
    <ChatInput
      executionMode="goal" permissionMode="ask" onSubmit={onSubmit}
      teamOptions={teams} agentType="ceo" onAgentTypeChange={vi.fn()}
    />
  )
  expect(screen.getByText('公司 (CEO)')).toBeInTheDocument()
  expect(screen.getByText('Agent 训练团队')).toBeInTheDocument()
})
```

> If `chat-input.test.tsx` does not assert on select internals elsewhere, keep this to "renders the options"; the agentType-change → submit path is covered by the parent (tasks-view) and the existing submit tests. Match the file's query style (`getByRole('combobox')` etc.).

- [ ] **Step 2: Run test to verify it fails**

Run: `npm test -- src/renderer/src/components/chat-input.test.tsx`
Expected: FAIL — `teamOptions`/`agentType` props don't exist; nothing renders the labels.

- [ ] **Step 3: Add the agents hook**

Create `src/renderer/src/hooks/use-agents.ts`:

```ts
import { useQuery } from '@tanstack/react-query'
import { swarmApi } from '@/lib/api'

export type TeamOption = { id: string; label: string }

/** Team-selector options: the company (CEO) default plus one entry per team head. */
export function useTeamOptions(): TeamOption[] {
  const { data } = useQuery({
    queryKey: ['agents'],
    queryFn: () => swarmApi.listAgents(),
    staleTime: 60_000,
  })
  const heads = (data ?? [])
    .filter((a) => a.teamRole === 'head')
    .map((a) => ({ id: a.id, label: a.name }))
  return [{ id: 'ceo', label: '公司 (CEO)' }, ...heads]
}
```

- [ ] **Step 4: Add the selector to ChatInput**

In `src/renderer/src/components/chat-input.tsx`, add to `Props` (~36-55):

```ts
  teamOptions?: { id: string; label: string }[]
  agentType?: string
  onAgentTypeChange?: (id: string) => void
```

Destructure them in the component and render a `<Select>` (reuse the existing `@/components/ui/select` imports already in this file) in the controls row beside `ComposerCwdMenu` (~346). Render only when `teamOptions` has entries:

```tsx
{teamOptions && teamOptions.length > 0 && (
  <Select value={agentType ?? 'ceo'} onValueChange={(v) => onAgentTypeChange?.(v)}>
    <SelectTrigger className="h-8 w-auto gap-1">
      <SelectValue />
    </SelectTrigger>
    <SelectContent>
      {teamOptions.map((t) => (
        <SelectItem key={t.id} value={t.id}>{t.label}</SelectItem>
      ))}
    </SelectContent>
  </Select>
)}
```

(Match the exact `Select*` primitive names/styles already imported in the file.)

- [ ] **Step 5: Thread agentType through the parents**

In `src/shared/types/task.ts`, if `SessionSettings` carries `cwd`/`permissionMode`/`executionMode`, add `agentType?: string` to it.

In `src/renderer/src/components/views/tasks-view.tsx`:
- read `const agentType = session?.agentType` (alongside `cwd` ~47),
- add `const setAgentType = (id: string): void => persistSettings({ agentType: id })`,
- include `agentType` in `taskOptions` (~59): `const taskOptions = { cwd, permissionMode, executionMode, agentType }`,
- import `useTeamOptions` and pass `teamOptions={useTeamOptions()} agentType={agentType} onAgentTypeChange={setAgentType}` to `<ChatInput>`.

In `src/renderer/src/components/views/home-composer.tsx`: mirror the same three props on its `<ChatInput>`, defaulting `agentType` to `'ceo'` for the first turn and storing the choice in whatever local/session state it uses for cwd/permissionMode.

- [ ] **Step 6: Run the tests and make sure they pass**

Run: `npm test -- src/renderer/src/components/chat-input.test.tsx`
Then: `npm test` and `npm run typecheck`.
Expected: PASS; 0 type errors.

- [ ] **Step 7: Commit**

```bash
git add src/renderer/src/hooks/use-agents.ts src/renderer/src/components/chat-input.tsx src/renderer/src/components/views/tasks-view.tsx src/renderer/src/components/views/home-composer.tsx src/shared/types/task.ts src/renderer/src/components/chat-input.test.tsx
git commit -m "feat(ui): composer team selector routes to a team head (default CEO)"
```

---

## Phase 5 — Manual verification

### Task 11: Manual real-LLM smoke (documented, not CI)

**Files:** none (record the run in the PR description or a `docs/` note if desired).

- [ ] **Step 1: Launch the app**

Use the `run-desktop` skill (or `pnpm dev`). If Electron complains "uninstall": `pnpm exec install-electron`. If better-sqlite3 misbehaves: `npm run postinstall` (NEVER `pnpm rebuild better-sqlite3`).

- [ ] **Step 2: Default CEO path**

With the team selector on "公司 (CEO)", send a goal that spans the dev team (e.g. "在一个临时目录实现并测试一个 isPalindrome 工具函数"). Observe in `swarm-dev.log`: CEO `find_agents({teamRole:'head'})` → delegates to the dev head (PM) → PM `find_agents({team:'dev', ...})` → engineer/reviewer → deliverable returns.

- [ ] **Step 3: Training-team path (the capability proof)**

Select "Agent 训练团队" and ask it to create a new agent (e.g. "创建一个 docs-writer agent,负责写 README,属于一个新的 docs 团队,并作为该团队 head"). Verify:
  - a folder `~/.swarm-agents/agents/docs-writer/AGENT.md` appears with `team`/`teamRole`/`role` in its frontmatter,
  - the team selector gains a "docs" entry (head with `teamRole: 'head'`) after the agents query refetches (reopen composer / invalidate),
  - selecting it and chatting reaches the new agent.

- [ ] **Step 4: Boundary check**

Confirm a non-training agent cannot author: in the dev path, the engineer/reviewer/PM must NOT have `write_agent` available (privileged group excluded from `*`). Spot-check by confirming the tool list for an `all`-scope agent omits `authoring.*` (the Task 4 unit test already asserts this; this is just an in-app sanity look).

- [ ] **Step 5: Finish the branch**

Use the `superpowers:finishing-a-development-branch` skill to merge/PR back to `develop` and remove the worktree.

---

## Self-Review

**1. Spec coverage:**
- §4.1 three-layer org → Tasks 7 (roster/prompts) + 8 (e2e routing). ✓
- §4.2 data model (`team`/`teamRole`) + persist role/caps/team/teamRole → Task 1. ✓
- §4.3 discovery extension → Tasks 2 (receptionist) + 3 (find_agents tool). ✓
- §4.4 training meta-tools (write_agent/write_skill) + injection + schema validation → Tasks 5 (wiring) + 6 (tools); privileged boundary → Task 4. ✓ (`eval_agent` is a spec non-goal — correctly absent.)
- §4.5 composer selector derived from `teamRole:'head'`, writes `options.agentType` → Tasks 9 (roster IPC) + 10 (selector). ✓
- §4.6 runtime data flow (CEO default, head bypass) → Tasks 7 prompts + 10 routing + 8 e2e. ✓
- §5 roster (ceo/dev/training; generic builtins untouched; UI team deferred) → Task 7. ✓
- §6 error handling (invalid def rejected, unknown agentType fallback exists, authoring unavailable) → Tasks 6 (reject/unavailable) + existing fallback (manager). ✓
- §7 testing (store round-trip, receptionist filters, find_agents, write_agent reject, e2e, renderer) → Tasks 1-3, 6, 8, 10. ✓
- §9 non-goals (no Team entity, no eval, no UI team builtin, no group chat, no skeleton-on-disk seed) → respected; nothing in the plan builds them. ✓

**2. Placeholder scan:** No TBD/TODO/"add error handling" left vague — each tool reports concrete error text; each test has real code. The two "mirror the existing X" notes (e2e harness in Task 8, listSkills path in Task 9, Select primitives in Task 10) point at a NAMED existing symbol with its file:line, which is a concrete instruction, not a placeholder. ✓

**3. Type consistency:**
- `AgentMutationResult` (`{ ok: true; agents } | { ok: false; code; message }`) used identically in Tasks 5/6. `SkillMutationResult` success shape flagged for confirmation against `@shared/types/skill` in Tasks 5/6 (not assumed). ✓
- `teamRole: 'head'` literal type consistent across schema (Task 1), PeerQuery/Peer (Task 2), tool params as `string` then narrowed (Task 3), builtins (Task 7), selector filter (Task 10). ✓
- `deriveAllowlist('authoring')` value identical in Task 4 impl and its test. ✓
- `ToolRunContext.writeAgent`/`writeSkill` optional everywhere; tools guard on absence (Task 6). ✓

No issues found that aren't already flagged inline for confirmation.
