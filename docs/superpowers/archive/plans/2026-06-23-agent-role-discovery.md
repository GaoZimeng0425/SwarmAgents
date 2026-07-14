# Role-Based Agent Discovery Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Let an agent discover its peers at runtime by role / capability / free-text query (the actor Receptionist pattern), and rewrite the built-in company prompts to address teammates by role instead of hardcoded names.

**Architecture:** A new `directory/` slice holds a pure `AgentDirectory` that *projects* over existing state (the `actors` table = membership, `residentHandles` = liveness, the agent store = role/capabilities/description) — no second source of truth, no registration step. A new low-risk `find_agents` tool in the `agent` group exposes it; session-manager injects a `findPeers` closure into each run. `AgentDefinition` gains `role` + `capabilities`. Session-local, synchronous pull-query only.

**Tech Stack:** TypeScript, Electron utilityProcess service, Vitest (via Electron node), Zod, better-sqlite3, `@earendil-works/pi-ai` `Type` (TypeBox) for tool params.

## Global Constraints

- **Scope:** `src/service` + `src/shared/types/agent.ts` + `src/shared/agents/builtins.ts` only. No cross-session discovery; no push/subscription/heartbeat/TTL; no first-class `Team` entity.
- **No second source of truth:** the directory only *reads* existing state via injected accessors. Do not add a registry table or a registration call.
- **Discovery and delivery stay separate:** `find_agents` returns addresses; the agent then uses the existing `send_message`/`send_and_wait`. Do NOT teach `send_*` to resolve roles.
- **Behavior preservation:** `npm test` stays green — the existing 572 tests pass, plus the new suites (count rises, 0 failures). The four `e2e/` company tests mock the agent-runner and do NOT read prompts, so the prompt rewrite must not change their outcome.
- **`capabilities` is `z.array(z.string()).optional()`** (NOT `.default([])`) so existing `AgentDefinition` literals don't break; consumers default with `?? []`.
- **Run tests via the Electron-node runner only:** `npm test`, never bare `npx vitest`, never `pnpm rebuild better-sqlite3`. Typecheck: `npm run typecheck` (node+web). Slice run: `cross-env ELECTRON_RUN_AS_NODE=1 electron node_modules/vitest/vitest.mjs run <path>`.
- **Tool naming:** the tool the model sees is `find_agents`, group `agent`, risk `low`.
- **Comments/commits in English.**

---

### Task 1: Shared types — `role`, `capabilities`, `Peer`, `PeerQuery`

**Files:**
- Modify: `src/shared/types/agent.ts`
- Test: `src/shared/types/agent.test.ts` (extend existing)

**Interfaces:**
- Produces: `AgentDefinition` with optional `role?: string` and `capabilities?: string[]`; `PeerQuery = { role?: string; capability?: string; query?: string }`; `Peer = { name: string | null; address: string; role: string; capabilities: string[]; description: string; status: 'active' | 'dormant' }`.

- [ ] **Step 1: Write the failing test**

Add to `src/shared/types/agent.test.ts`:

```ts
import { AgentDefinitionSchema } from './agent'

describe('AgentDefinition role + capabilities', () => {
  const base = {
    id: 'eng',
    name: 'Engineer',
    description: 'Use when code must be written.',
    systemPrompt: 'x',
    toolScope: 'all' as const,
  }

  it('accepts role and capabilities', () => {
    const def = AgentDefinitionSchema.parse({ ...base, role: 'engineer', capabilities: ['code', 'tests'] })
    expect(def.role).toBe('engineer')
    expect(def.capabilities).toEqual(['code', 'tests'])
  })

  it('leaves role and capabilities undefined when omitted (no forced default)', () => {
    const def = AgentDefinitionSchema.parse(base)
    expect(def.role).toBeUndefined()
    expect(def.capabilities).toBeUndefined()
  })
})
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cross-env ELECTRON_RUN_AS_NODE=1 electron node_modules/vitest/vitest.mjs run src/shared/types/agent.test.ts`
Expected: FAIL — `role`/`capabilities` not on the parsed object (or type error).

- [ ] **Step 3: Add the fields + types**

In `src/shared/types/agent.ts`, add to `AgentDefinitionSchema` (after `toolScope: ToolScopeSchema,`):

```ts
  /** Discoverable role handle (distinct from the per-instance actor name). When unset, the directory treats `id` as the role. */
  role: z.string().optional(),
  /** Capability tags for finer discovery queries. */
  capabilities: z.array(z.string()).optional(),
```

At the end of the file add:

```ts
/** A discovery query against the session's live agents. All fields optional; empty → match all. */
export type PeerQuery = { role?: string; capability?: string; query?: string }

/** A discovered peer agent, returned by the directory and surfaced by the find_agents tool. */
export type Peer = {
  name: string | null
  address: string
  role: string
  capabilities: string[]
  description: string
  status: 'active' | 'dormant'
}
```

- [ ] **Step 4: Run test + typecheck to verify pass**

Run: `cross-env ELECTRON_RUN_AS_NODE=1 electron node_modules/vitest/vitest.mjs run src/shared/types/agent.test.ts`
Expected: PASS.
Run: `npm run typecheck`
Expected: 0 errors.

- [ ] **Step 5: Commit**

```bash
git add src/shared/types/agent.ts src/shared/types/agent.test.ts
git commit -m "feat(agent): add role + capabilities to AgentDefinition; Peer/PeerQuery types"
```

---

### Task 2: `directory/receptionist.ts` — the Agent Directory (core)

**Files:**
- Create: `src/service/directory/receptionist.ts`
- Test: `src/service/directory/receptionist.test.ts`

**Interfaces:**
- Consumes: `AgentDefinition`, `Peer`, `PeerQuery` from `@shared/types/agent`; `Actor` from `@shared/types/actor`.
- Produces: `createAgentDirectory(deps: { listActors(sessionId): Actor[]; isLive(address): boolean; getAgentDef(agentDefId): AgentDefinition | undefined }): AgentDirectory` where `AgentDirectory = { find(sessionId: string, q: PeerQuery, selfAddress?: string): Peer[] }`.

- [ ] **Step 1: Write the failing test**

Create `src/service/directory/receptionist.test.ts`:

```ts
import { describe, expect, it } from 'vitest'
import type { AgentDefinition } from '@shared/types/agent'
import type { Actor } from '@shared/types/actor'
import { createAgentDirectory } from './receptionist'

const actor = (address: string, agentDefId: string, name: string | null, createdAt = 0): Actor => ({
  address,
  agentDefId,
  sessionId: 's1',
  name,
  state: null,
  lastTaskId: null,
  createdAt,
  updatedAt: createdAt,
})

const def = (id: string, role: string, capabilities: string[], description = ''): AgentDefinition => ({
  id,
  name: id,
  description,
  systemPrompt: 'x',
  toolScope: 'all',
  maxIterations: 25,
  role,
  capabilities,
})

const defs: Record<string, AgentDefinition> = {
  engineer: def('engineer', 'engineer', ['code', 'tests'], 'Writes code and runs tests.'),
  reviewer: def('reviewer', 'reviewer', ['review'], 'Reviews code against acceptance criteria.'),
}

const build = (actors: Actor[], live: string[] = []) =>
  createAgentDirectory({
    listActors: () => actors,
    isLive: (a) => live.includes(a),
    getAgentDef: (id) => defs[id],
  })

describe('createAgentDirectory.find', () => {
  it('filters by exact role', () => {
    const dir = build([actor('a1', 'engineer', 'eng'), actor('a2', 'reviewer', 'rev')])
    const res = dir.find('s1', { role: 'reviewer' })
    expect(res.map((p) => p.address)).toEqual(['a2'])
  })

  it('filters by capability tag', () => {
    const dir = build([actor('a1', 'engineer', 'eng'), actor('a2', 'reviewer', 'rev')])
    expect(dir.find('s1', { capability: 'tests' }).map((p) => p.address)).toEqual(['a1'])
  })

  it('derives status from isLive', () => {
    const dir = build([actor('a1', 'engineer', 'eng')], ['a1'])
    expect(dir.find('s1', {})[0].status).toBe('active')
    expect(build([actor('a1', 'engineer', 'eng')], []).find('s1', {})[0].status).toBe('dormant')
  })

  it('excludes self', () => {
    const dir = build([actor('a1', 'engineer', 'eng'), actor('a2', 'reviewer', 'rev')])
    expect(dir.find('s1', {}, 'a1').map((p) => p.address)).toEqual(['a2'])
  })

  it('ranks an exact role mention in the query above prose matches, active first', () => {
    const dir = build(
      [actor('a1', 'engineer', 'eng'), actor('a2', 'reviewer', 'rev')],
      ['a1', 'a2']
    )
    // "reviewer" names the reviewer's role → reviewer ranks first
    const res = dir.find('s1', { query: 'need a reviewer' })
    expect(res[0].address).toBe('a2')
  })

  it('empty query returns all, active before dormant', () => {
    const dir = build([actor('a1', 'engineer', 'eng'), actor('a2', 'reviewer', 'rev')], ['a2'])
    const res = dir.find('s1', {})
    expect(res[0].status).toBe('active')
    expect(res.map((p) => p.address).sort()).toEqual(['a1', 'a2'])
  })

  it('falls back to agentDefId/[]/"" when the agent def is unknown', () => {
    const dir = build([actor('a1', 'ghost', 'g')])
    const p = dir.find('s1', {})[0]
    expect(p.role).toBe('ghost')
    expect(p.capabilities).toEqual([])
    expect(p.description).toBe('')
  })
})
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cross-env ELECTRON_RUN_AS_NODE=1 electron node_modules/vitest/vitest.mjs run src/service/directory`
Expected: FAIL — `./receptionist` not found.

- [ ] **Step 3: Implement the directory**

Create `src/service/directory/receptionist.ts`:

```ts
import type { Actor } from '@shared/types/actor'
import type { AgentDefinition, Peer, PeerQuery } from '@shared/types/agent'

export type AgentDirectory = {
  /** Live peers in `sessionId` matching `q`, ranked best-first, excluding `selfAddress`. */
  find(sessionId: string, q: PeerQuery, selfAddress?: string): Peer[]
}

const tokens = (s: string): string[] => s.toLowerCase().split(/\s+/).filter(Boolean)

/**
 * The actor "receptionist": a pure projection over existing state (actors table,
 * live-handle set, agent store). No registration, no second source of truth.
 */
export function createAgentDirectory(deps: {
  listActors(sessionId: string): Actor[]
  isLive(address: string): boolean
  getAgentDef(agentDefId: string): AgentDefinition | undefined
}): AgentDirectory {
  const toPeer = (a: Actor): Peer => {
    const def = deps.getAgentDef(a.agentDefId)
    return {
      name: a.name,
      address: a.address,
      role: def?.role ?? a.agentDefId,
      capabilities: def?.capabilities ?? [],
      description: def?.description ?? '',
      status: deps.isLive(a.address) ? 'active' : 'dormant',
    }
  }

  const scoreOf = (p: Peer, query: string | undefined): number => {
    if (!query) return 0
    const q = tokens(query)
    if (q.length === 0) return 0
    const hay = new Set(tokens(`${p.role} ${p.name ?? ''} ${p.capabilities.join(' ')} ${p.description}`))
    let score = q.reduce((n, t) => n + (hay.has(t) ? 1 : 0), 0)
    // A query that names a role exactly outranks an agent that merely mentions
    // the word in prose ("find a reviewer" → the reviewer, not a code agent
    // whose description says "review").
    if (q.includes(p.role.toLowerCase())) score += 10
    return score
  }

  return {
    find(sessionId, q, selfAddress) {
      let peers = deps.listActors(sessionId).map(toPeer)
      if (selfAddress) peers = peers.filter((p) => p.address !== selfAddress)
      if (q.role) peers = peers.filter((p) => p.role === q.role)
      if (q.capability) peers = peers.filter((p) => p.capabilities.includes(q.capability as string))
      return peers
        .map((p) => ({ p, score: scoreOf(p, q.query) }))
        .sort((a, b) => {
          const liveDiff = (a.p.status === 'active' ? 0 : 1) - (b.p.status === 'active' ? 0 : 1)
          if (liveDiff !== 0) return liveDiff
          if (b.score !== a.score) return b.score - a.score
          return (a.p.name ?? '').localeCompare(b.p.name ?? '')
        })
        .map((s) => s.p)
    },
  }
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `cross-env ELECTRON_RUN_AS_NODE=1 electron node_modules/vitest/vitest.mjs run src/service/directory`
Expected: PASS (7 tests).

- [ ] **Step 5: Commit**

```bash
git add src/service/directory/receptionist.ts src/service/directory/receptionist.test.ts
git commit -m "feat(directory): add AgentDirectory receptionist (role/capability/query find)"
```

---

### Task 3: Store — `listActorsForSession`

**Files:**
- Modify: `src/service/conversation/store.ts`
- Test: `src/service/conversation/store.test.ts` (extend existing)

**Interfaces:**
- Produces: `ConversationStore.listActorsForSession(sessionId: string): Actor[]` — actors of a session in creation order.

- [ ] **Step 1: Write the failing test**

Add to `src/service/conversation/store.test.ts` (it already builds a store; mirror its existing actor-test setup — use `upsertActor`):

```ts
describe('listActorsForSession', () => {
  it('returns a session actors in creation order and excludes other sessions', () => {
    const store = createConversationStore(':memory:')
    const mk = (address: string, sessionId: string, createdAt: number) => ({
      address,
      agentDefId: 'default',
      sessionId,
      name: address,
      state: null,
      lastTaskId: null,
      createdAt,
      updatedAt: createdAt,
    })
    store.upsertActor(mk('a2', 'S1', 200))
    store.upsertActor(mk('a1', 'S1', 100))
    store.upsertActor(mk('b1', 'S2', 150))
    expect(store.listActorsForSession('S1').map((a) => a.address)).toEqual(['a1', 'a2'])
    expect(store.listActorsForSession('S2').map((a) => a.address)).toEqual(['b1'])
    store.close()
  })
})
```

(If the test file imports `createConversationStore` differently or uses a temp-file path helper, follow the file's existing convention instead of `':memory:'`.)

- [ ] **Step 2: Run test to verify it fails**

Run: `cross-env ELECTRON_RUN_AS_NODE=1 electron node_modules/vitest/vitest.mjs run src/service/conversation/store.test.ts`
Expected: FAIL — `listActorsForSession` is not a function.

- [ ] **Step 3: Implement**

In `src/service/conversation/store.ts`:

1. Add to the `ConversationStore` interface, right after `getActorByName(...)`:
```ts
  listActorsForSession(sessionId: string): Actor[]
```
2. Add a prepared statement near `stmtGetActorByName`:
```ts
  const stmtListActorsForSession = db.prepare('SELECT * FROM actors WHERE session_id = ? ORDER BY created_at')
```
3. Add the method right after the `getActorByName` implementation:
```ts
    listActorsForSession(sessionId) {
      return (stmtListActorsForSession.all(sessionId) as ActorRow[]).map(rowToActor)
    },
```

- [ ] **Step 4: Run test to verify it passes**

Run: `cross-env ELECTRON_RUN_AS_NODE=1 electron node_modules/vitest/vitest.mjs run src/service/conversation/store.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/service/conversation/store.ts src/service/conversation/store.test.ts
git commit -m "feat(store): add listActorsForSession"
```

---

### Task 4: Wire `findPeers` through context, runner, and manager

**Files:**
- Modify: `src/service/tools/registry.ts` (ToolRunContext)
- Modify: `src/service/session/agent-runner.ts` (AgentRunnerDeps + buildToolContext)
- Modify: `src/service/session/manager.ts` (create directory + inject at 3 deps sites)
- Test: `src/service/session/agent-runner.context.test.ts` (extend existing)

**Interfaces:**
- Consumes: `createAgentDirectory` (Task 2), `store.listActorsForSession` (Task 3), `Peer`/`PeerQuery` (Task 1).
- Produces: `ToolRunContext.findPeers(q: PeerQuery): Peer[]`; `AgentRunnerDeps.findPeers?(q: PeerQuery): Peer[]`.

- [ ] **Step 1: Write the failing test**

Add to `src/service/session/agent-runner.context.test.ts` (it already imports `buildToolContext` dynamically via `await import('./agent-runner')` — follow that style):

```ts
it('exposes findPeers that delegates to deps.findPeers', async () => {
  const { buildToolContext } = await import('./agent-runner')
  const peer = {
    name: 'pm', address: 'a1', role: 'pm', capabilities: [], description: '', status: 'active' as const,
  }
  const ctx = buildToolContext({
    task: { id: 't1', goal: 'g', cwd: undefined, attachments: [] },
    sessionId: 's1',
    findPeers: (q) => (q.role === 'pm' ? [peer] : []),
    spawnChild: async () => ({ childTaskId: 'c', result: { summary: '', artifacts: [] } }),
  } as never)
  expect(ctx.findPeers({ role: 'pm' })).toEqual([peer])
  expect(ctx.findPeers({ role: 'none' })).toEqual([])
})

it('findPeers returns [] when no delegate is wired', async () => {
  const { buildToolContext } = await import('./agent-runner')
  const ctx = buildToolContext({
    task: { id: 't1', goal: 'g', cwd: undefined, attachments: [] },
    sessionId: 's1',
    spawnChild: async () => ({ childTaskId: 'c', result: { summary: '', artifacts: [] } }),
  } as never)
  expect(ctx.findPeers({})).toEqual([])
})
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cross-env ELECTRON_RUN_AS_NODE=1 electron node_modules/vitest/vitest.mjs run src/service/session/agent-runner.context.test.ts`
Expected: FAIL — `ctx.findPeers` is not a function.

- [ ] **Step 3: Implement the wiring**

(a) `src/service/tools/registry.ts` — add an import and a method to `ToolRunContext` (place after `sendAndWait`):
```ts
import type { Peer, PeerQuery } from '@shared/types/agent'
```
```ts
  /** Discover peer agents in this session by role/capability/free-text. Empty query → all live peers. */
  findPeers(q: PeerQuery): Peer[]
```

(b) `src/service/session/agent-runner.ts`:
- Add to the imports:
```ts
import type { Peer, PeerQuery } from '@shared/types/agent'
```
- Add to `AgentRunnerDeps` (after `sendMessage?...`):
```ts
  /** Discover peer agents in this session. */
  findPeers?(q: PeerQuery): Peer[]
```
- In `buildToolContext`, add to the returned object (after the `sendAndWait` entry):
```ts
    findPeers: (q) => deps.findPeers?.(q) ?? [],
```

(c) `src/service/session/manager.ts`:
- Add the import:
```ts
import { createAgentDirectory } from '../directory/receptionist'
```
- After `residentHandles` is declared (`const residentHandles = new Map(...)`), construct the directory:
```ts
  const directory = createAgentDirectory({
    listActors: (s) => store.listActorsForSession(s),
    isLive: (address) => residentHandles.has(address),
    getAgentDef: (id) => cfg.agentStore?.get(id),
  })
```
- Add `findPeers` to all THREE `AgentRunnerDeps` / `createAgentRunner({...})` objects:
  - In `spawnResident` (the `const deps: AgentRunnerDeps = {...}` with `selfAddress: actor.address`), add:
    ```ts
      findPeers: (q) => directory.find(sessionId, q, actor.address),
    ```
  - In `spawnChild` (the `createAgentRunner({...})` with no `selfAddress`), add:
    ```ts
      findPeers: (q) => directory.find(sessionId, q),
    ```
  - In `submitGoal`'s `runTurn` (the `createAgentRunner({...})` with `initialMessages: session.messages`), add:
    ```ts
      findPeers: (q) => directory.find(sessionId, q),
    ```

- [ ] **Step 4: Run test + typecheck + full suite**

Run: `cross-env ELECTRON_RUN_AS_NODE=1 electron node_modules/vitest/vitest.mjs run src/service/session/agent-runner.context.test.ts`
Expected: PASS.
Run: `npm run typecheck` → 0 errors.
Run: `npm test` → all pass (baseline + new), 0 failures.

- [ ] **Step 5: Commit**

```bash
git add src/service/tools/registry.ts src/service/session/agent-runner.ts src/service/session/manager.ts src/service/session/agent-runner.context.test.ts
git commit -m "feat(session): wire findPeers (directory) into tool run context"
```

---

### Task 5: `find_agents` tool

**Files:**
- Modify: `src/service/tools/messaging.ts` (add `findAgentsSpec`)
- Modify: `src/service/tools/builtins.ts` (register it)
- Test: `src/service/tools/messaging.test.ts` (extend existing)

**Interfaces:**
- Consumes: `ToolRunContext.findPeers` (Task 4); `PeerQuery` (Task 1).
- Produces: `findAgentsSpec(): ToolSpec` — group `agent`, model-facing name `find_agents`.

- [ ] **Step 1: Write the failing test**

Add to `src/service/tools/messaging.test.ts`:

```ts
import { findAgentsSpec } from './messaging'

const fakeCtx = (overrides: Partial<import('./registry').ToolRunContext>) =>
  ({ sessionId: 's1', findPeers: () => [], ...overrides }) as unknown as import('./registry').ToolRunContext

describe('find_agents tool', () => {
  it('formats discovered peers into readable lines and passes the query through', async () => {
    let seen: unknown
    const ctx = fakeCtx({
      findPeers: (q) => {
        seen = q
        return [
          { name: 'pm', address: 'a1', role: 'pm', capabilities: ['planning'], description: 'Coordinates work.', status: 'active' },
          { name: 'eng', address: 'a2', role: 'engineer', capabilities: [], description: 'Writes code.', status: 'dormant' },
        ]
      },
    })
    const tool = findAgentsSpec().build(ctx)
    const res = await tool.execute('id', { role: 'pm' })
    expect(seen).toEqual({ role: 'pm' })
    const text = res.content.map((c) => (c.type === 'text' ? c.text : '')).join('')
    expect(text).toContain('pm (role pm)')
    expect(text).toContain('a1')
    expect(text).toContain('active')
    expect(text).toContain('caps: planning')
  })

  it('reports clearly when nobody matches', async () => {
    const tool = findAgentsSpec().build(fakeCtx({ findPeers: () => [] }))
    const res = await tool.execute('id', {})
    const text = res.content.map((c) => (c.type === 'text' ? c.text : '')).join('')
    expect(text).toMatch(/no matching agents/i)
  })
})
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cross-env ELECTRON_RUN_AS_NODE=1 electron node_modules/vitest/vitest.mjs run src/service/tools/messaging.test.ts`
Expected: FAIL — `findAgentsSpec` is not exported.

- [ ] **Step 3: Implement**

(a) In `src/service/tools/messaging.ts`, add the import and the spec (the file already imports `Type` from `@earendil-works/pi-ai` and `ToolRunContext`/`ToolSpec` from `./registry`):

```ts
import type { PeerQuery } from '@shared/types/agent'
```

```ts
const FindParams = Type.Object({
  role: Type.Optional(Type.String({ description: 'Filter to agents whose role exactly equals this, e.g. "engineer".' })),
  capability: Type.Optional(Type.String({ description: 'Filter to agents advertising this capability tag.' })),
  query: Type.Optional(Type.String({ description: 'Free text to rank matches by (matched against role, name, capabilities, description).' })),
})

export function findAgentsSpec(): ToolSpec {
  return {
    group: 'agent',
    name: 'find_agents',
    risk: 'low',
    source: 'builtin',
    build: (ctx: ToolRunContext): AgentTool => ({
      name: 'find_agents',
      label: 'Find agents',
      description:
        'Discover other agents in this session by role, capability, or free-text query. Returns their names and addresses so you can reach them with send_message / send_and_wait. Call with no arguments to list everyone available.',
      parameters: FindParams,
      execute: async (_id: string, params: unknown) => {
        const peers = ctx.findPeers((params ?? {}) as PeerQuery)
        if (peers.length === 0) {
          return { content: [{ type: 'text', text: 'No matching agents in this session.' }] }
        }
        const lines = peers.map((p) => {
          const caps = p.capabilities.length ? ` · caps: ${p.capabilities.join(', ')}` : ''
          return `- ${p.name ?? '(unnamed)'} (role ${p.role}) · ${p.address} · ${p.status} · ${p.description}${caps}`
        })
        return { content: [{ type: 'text', text: lines.join('\n') }], details: { count: peers.length } }
      },
    }),
  }
}
```

(b) In `src/service/tools/builtins.ts`, update the messaging import and register the spec:
- Change the existing import line `import { sendAndWaitSpec, sendMessageSpec, whoamiSpec } from './messaging'` to also include `findAgentsSpec`:
```ts
import { findAgentsSpec, sendAndWaitSpec, sendMessageSpec, whoamiSpec } from './messaging'
```
- Add a registration line next to `registry.register(whoamiSpec())`:
```ts
  registry.register(findAgentsSpec())
```

- [ ] **Step 4: Run test to verify it passes**

Run: `cross-env ELECTRON_RUN_AS_NODE=1 electron node_modules/vitest/vitest.mjs run src/service/tools/messaging.test.ts`
Expected: PASS.
Run: `npm run typecheck` → 0 errors.

- [ ] **Step 5: Commit**

```bash
git add src/service/tools/messaging.ts src/service/tools/builtins.ts src/service/tools/messaging.test.ts
git commit -m "feat(tools): add find_agents discovery tool (agent group, low risk)"
```

---

### Task 6: Builtin roles/capabilities + role-based company prompts

**Files:**
- Modify: `src/shared/agents/builtins.ts`
- Test: `src/shared/agents/builtins.company.test.ts` (extend existing)

**Interfaces:**
- Consumes: `find_agents` tool (Task 5), `role`/`capabilities` schema (Task 1).
- Produces: every builtin agent carries `role` (= its id) and `capabilities`; CEO/PM prompts discover teammates via `find_agents` instead of naming them.

- [ ] **Step 1: Write the failing test**

Add to `src/shared/agents/builtins.company.test.ts`:

```ts
import { builtinAgents } from './builtins'
import { AgentDefinitionSchema } from '@shared/types/agent'

describe('builtin role + capability metadata', () => {
  it('every builtin validates and carries role (= id) and a capabilities array', () => {
    for (const a of builtinAgents) {
      expect(() => AgentDefinitionSchema.parse(a)).not.toThrow()
      expect(a.role).toBe(a.id)
      expect(Array.isArray(a.capabilities)).toBe(true)
    }
  })

  it('CEO and PM prompts discover teammates via find_agents (no hardcoded names)', () => {
    const ceo = builtinAgents.find((a) => a.id === 'ceo')!
    const pm = builtinAgents.find((a) => a.id === 'pm')!
    expect(ceo.systemPrompt).toContain('find_agents')
    expect(pm.systemPrompt).toContain('find_agents')
    // The PM must look up both teammates by role.
    expect(pm.systemPrompt).toContain("role: 'engineer'")
    expect(pm.systemPrompt).toContain("role: 'reviewer'")
  })
})
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cross-env ELECTRON_RUN_AS_NODE=1 electron node_modules/vitest/vitest.mjs run src/shared/agents/builtins.company.test.ts`
Expected: FAIL — `role`/`capabilities` undefined; prompts lack `find_agents`.

- [ ] **Step 3: Implement**

(a) In `src/shared/agents/builtins.ts`, add `role` (= id) and `capabilities` to each of the 7 entries in `builtinAgents`. Exact values:
- `default`: `role: 'default', capabilities: []`
- `researcher`: `role: 'researcher', capabilities: ['observe', 'read-only']`
- `executor`: `role: 'executor', capabilities: ['ui', 'click', 'type']`
- `ceo`: `role: 'ceo', capabilities: ['delegation', 'summary']`
- `pm`: `role: 'pm', capabilities: ['planning', 'coordination']`
- `engineer`: `role: 'engineer', capabilities: ['code', 'tests', 'shell']`
- `reviewer`: `role: 'reviewer', capabilities: ['review', 'verify']`

(b) Replace `CEO_SYSTEM_PROMPT` with:

```ts
const CEO_SYSTEM_PROMPT = `You are the CEO of a small software company. You receive a single high-level goal and are responsible for delivering the finished result.

Your team is discovered at runtime — do NOT assume teammates' names.

Workflow:
  1. Read the goal. Do NOT write code yourself.
  2. Locate the project manager: call find_agents({ role: 'pm' }) and take the first result's address.
  3. Delegate the whole goal to that address with full context: send_and_wait(<pm address>, <the goal plus any constraints>).
  4. When the PM returns the deliverable, review it at a high level and produce a concise final summary of what was built and its status.
  5. Your reply to the original request IS that final summary — it is the result of the entire run.`
```

(c) Replace `PM_SYSTEM_PROMPT` with:

```ts
const PM_SYSTEM_PROMPT = `You are the Project Manager of a small software company. You turn a goal into a concrete deliverable by coordinating an engineer and a reviewer.

Your team is discovered at runtime — do NOT assume teammates' names. Locate them by role:
  - engineer: find_agents({ role: 'engineer' }) — implements code and runs tests.
  - reviewer: find_agents({ role: 'reviewer' }) — reviews the engineer's output and reports issues.
Take the first result's address for each and message that address.

Workflow:
  1. Break the CEO's goal into a concrete implementation task (what to build, where, acceptance criteria).
  2. send_and_wait(<engineer address>, <the concrete task, including the working directory to use>).
  3. When the engineer reports done, request a review: send_and_wait(<reviewer address>, <what to review and the artifact location>).
  4. If the reviewer reports issues, send the fixes back: send_and_wait(<engineer address>, <the issues to fix>), then review again.
  5. Repeat the fix/review loop AT MOST 10 times. If still not passing after 10 rounds, stop and summarize with an explicit "did not meet bar" note.
  6. Return a consolidated deliverable summary (what was built, where, test/review status) to the CEO.`
```

(Leave `ENGINEER_SYSTEM_PROMPT` and `REVIEWER_SYSTEM_PROMPT` unchanged — they don't address teammates by name.)

- [ ] **Step 4: Run test + full suite**

Run: `cross-env ELECTRON_RUN_AS_NODE=1 electron node_modules/vitest/vitest.mjs run src/shared/agents/builtins.company.test.ts`
Expected: PASS.
Run: `npm test`
Expected: all pass (incl. the four `e2e/` company tests — they mock the agent-runner and don't read prompts, so they are unaffected), 0 failures.

- [ ] **Step 5: Commit**

```bash
git add src/shared/agents/builtins.ts src/shared/agents/builtins.company.test.ts
git commit -m "feat(agents): role/capabilities on builtins; CEO/PM discover teammates via find_agents"
```

---

### Task 7: Final verification

**Files:** none (verification only).

- [ ] **Step 1: Full typecheck**

Run: `npm run typecheck` → 0 errors (node + web).

- [ ] **Step 2: Full suite**

Run: `npm test`
Expected: all prior tests (572) pass plus the new suites (directory 7, store +1, agent-runner context +2, messaging +2, builtins +2); 0 failures.

- [ ] **Step 3: Confirm scope of the branch diff**

Run: `git diff --stat $(git merge-base develop HEAD)..HEAD`
Expected: only `src/shared/types/agent.ts`, `src/shared/agents/builtins.ts`, `src/service/directory/*`, `src/service/conversation/store.ts`, `src/service/session/manager.ts`, `src/service/session/agent-runner.ts`, `src/service/tools/registry.ts`, `src/service/tools/messaging.ts`, `src/service/tools/builtins.ts`, and the touched test files.

---

## Self-Review

**Spec coverage:**
- Data model (`role`, `capabilities`, `Peer`, `PeerQuery`) → Task 1. ✓
- `directory/` receptionist with filter+rank+status+self-exclusion → Task 2. ✓
- `listActorsForSession` → Task 3. ✓
- Wiring (ToolRunContext.findPeers, AgentRunnerDeps, buildToolContext, manager directory + 3 inject sites) → Task 4. ✓
- `find_agents` tool, `agent` group, low risk, formatted output → Task 5. ✓
- Builtin role/capabilities + CEO/PM prompt rewrite (company seeding unchanged) → Task 6. ✓
- Reachability (agent.* scopes get it, researcher excluded) → inherited from group `agent`, no extra work (deriveAllowlist unchanged). ✓
- Honest limitation (real-LLM prompt effect not unit-tested) → recorded in spec; Task 6 verifies via string assertions + green e2e. ✓

**Placeholder scan:** No TBD/TODO; every code step has complete code; every test step has real assertions; every command has expected output. ✓

**Type consistency:** `Peer`/`PeerQuery` defined in Task 1 and imported identically in Tasks 2/4/5. `findPeers(q: PeerQuery): Peer[]` signature identical across ToolRunContext (T4a), AgentRunnerDeps (T4b), buildToolContext (T4b), and the tool's `ctx.findPeers` call (T5). `createAgentDirectory` accessor names (`listActors`/`isLive`/`getAgentDef`) match between Task 2 definition and Task 4 manager construction. `find` signature `(sessionId, q, selfAddress?)` matches the 3 inject sites. ✓

**Known acceptable note:** `capabilities` is `.optional()` (not `.default([])`) by Global Constraint, so the inferred type is `capabilities?: string[]`; every consumer (`toPeer`, tool formatting via peers from `toPeer`) defaults with `?? []`, and the Task-6 builtins populate it explicitly.
