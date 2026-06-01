# Tool Registry (P0) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace hardcoded tool construction in `agent-runner` with a metadata-bearing tool registry that enforces `Task.toolAllowlist`, drives permission risk from tool metadata, and reserves an MCP registration seam.

**Architecture:** A `ToolRegistry` holds `ToolSpec` entries (group + name + risk + source + a `build(ctx)` factory). `agent-runner` calls `registry.resolve(task.toolAllowlist, runCtx)` to get the filtered `AgentTool[]` plus a `riskOf(name)` lookup that `beforeToolCall` consults. Existing tools (`see_screen`, `list_apps`, `spawn_sub_agent`) are migrated into the registry as the first registered specs; no new tools are added.

**Tech Stack:** TypeScript, `@earendil-works/pi-agent-core` (`AgentTool`), `@earendil-works/pi-ai` (`Type` for TypeBox schemas), Vitest (run under Electron via `pnpm test`).

**Spec:** `docs/superpowers/specs/2026-06-01-tool-registry-design.md`

---

## File Structure

| File | Responsibility |
|---|---|
| `src/service/tools/registry.ts` *(create)* | `ToolRisk`/`ToolSource`/`ToolRunContext`/`ToolSpec`/`ToolRegistry` types, `createToolRegistry()`, allowlist matching |
| `src/service/tools/spawn.ts` *(create)* | `spawnAgentSpec()` — `spawn_sub_agent` as a `ToolSpec` using `ctx.spawnChild` |
| `src/service/tools/builtins.ts` *(create)* | `peekabooSpecs()` + `registerBuiltinTools(registry)` — seed registration |
| `src/service/tools/registry.test.ts` *(create)* | Registry resolve/risk/MCP-seam unit tests |
| `src/service/tools/builtins.test.ts` *(create)* | Builtins resolve correctly through a registry |
| `src/shared/types/agent.ts` *(modify)* | Add `deriveAllowlist(scope)` |
| `src/shared/types/agent.test.ts` *(create)* | `deriveAllowlist` mapping tests |
| `src/service/agent-runner.ts` *(modify)* | Consume registry; remove inline tool construction; risk from `riskOf` |
| `src/service/agent-runner.test.ts` *(modify)* | Add `toolRegistry` to deps |
| `src/service/session-manager.ts` *(modify)* | Optional `toolRegistry` config (builtin default); thread to runners; corrected default allowlists |
| `src/service/index.ts` *(modify)* | Create registry, register builtins, inject into `createSessionManager` |

`src/service/tools/peekaboo.ts` is **reused unchanged** — `buildPeekabooTools` is wrapped, not rewritten.

---

## Task 1: Tool registry core

**Files:**
- Create: `src/service/tools/registry.ts`
- Test: `src/service/tools/registry.test.ts`

- [ ] **Step 1: Write the failing test**

Create `src/service/tools/registry.test.ts`:

```ts
import { describe, it, expect } from 'vitest'
import type { AgentTool } from '@earendil-works/pi-agent-core'
import { createToolRegistry, type ToolSpec, type ToolRunContext } from './registry'

const fakeTool = (name: string): AgentTool =>
  ({ name, label: name, description: '', parameters: { type: 'object' }, execute: async () => ({ content: [] }) }) as unknown as AgentTool

const spec = (group: string, name: string, risk: 'low' | 'medium' | 'high'): ToolSpec => ({
  group, name, risk, source: 'builtin', build: () => fakeTool(name),
})

const ctx: ToolRunContext = {
  taskId: 't', spawnChild: async () => ({ childTaskId: 'c', result: { summary: '', artifacts: [] } }),
  send: () => undefined, requestPermission: async () => 'grant',
}

describe('ToolRegistry', () => {
  const make = () => {
    const r = createToolRegistry()
    r.register(spec('peekaboo', 'see_screen', 'low'))
    r.register(spec('peekaboo', 'list_apps', 'low'))
    r.register(spec('agent', 'spawn_sub_agent', 'medium'))
    return r
  }

  it('matches group globs and excludes other groups', () => {
    const { tools } = make().resolve(['peekaboo.*'], ctx)
    expect(tools.map((t) => t.name).sort()).toEqual(['list_apps', 'see_screen'])
  })

  it('matches a fully-qualified name', () => {
    const { tools } = make().resolve(['peekaboo.see_screen'], ctx)
    expect(tools.map((t) => t.name)).toEqual(['see_screen'])
  })

  it('matches everything for * and all', () => {
    expect(make().resolve(['*'], ctx).tools).toHaveLength(3)
    expect(make().resolve(['all'], ctx).tools).toHaveLength(3)
  })

  it('riskOf returns spec risk, defaulting unknown to medium', () => {
    const { riskOf } = make().resolve(['*'], ctx)
    expect(riskOf('see_screen')).toBe('low')
    expect(riskOf('spawn_sub_agent')).toBe('medium')
    expect(riskOf('does_not_exist')).toBe('medium')
  })

  it('includes an MCP-sourced tool via the register seam', () => {
    const r = createToolRegistry()
    r.register({ group: 'notion', name: 'search', risk: 'medium', source: 'mcp', build: () => fakeTool('search') })
    const { tools } = r.resolve(['notion.*'], ctx)
    expect(tools.map((t) => t.name)).toEqual(['search'])
  })
})
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm test src/service/tools/registry.test.ts`
Expected: FAIL — `Cannot find module './registry'`.

- [ ] **Step 3: Write minimal implementation**

Create `src/service/tools/registry.ts`:

```ts
import type { AgentTool } from '@earendil-works/pi-agent-core'
import type { Outbound } from '@shared/types/ipc'
import type { PermissionDecision } from '@shared/types/ui'

export type ToolRisk = 'low' | 'medium' | 'high'
export type ToolSource = 'builtin' | 'mcp'

export interface ToolRunContext {
  taskId: string
  spawnChild(
    goal: string,
    suggestedTools?: string[],
    providerKey?: string,
  ): Promise<{ childTaskId: string; result: import('@shared/types/task').TaskResult }>
  send: (msg: Outbound) => void
  requestPermission: (args: {
    toolName: string
    risk: ToolRisk
    summary: string
    payload: unknown
  }) => Promise<PermissionDecision>
}

export interface ToolSpec {
  /** Group / namespace: 'peekaboo' | 'agent' | 'fs' | 'web' | 'memory' | 'skill' | <mcp-server>. */
  group: string
  /** Bare, model-facing tool name, e.g. 'see_screen'. */
  name: string
  risk: ToolRisk
  source: ToolSource
  /** Factory that produces the concrete pi AgentTool with run context injected. */
  build(ctx: ToolRunContext): AgentTool
}

export interface ToolRegistry {
  register(spec: ToolSpec): void
  list(): ToolSpec[]
  resolve(
    allowlist: string[],
    ctx: ToolRunContext,
  ): { tools: AgentTool[]; riskOf: (name: string) => ToolRisk }
}

function specMatches(spec: ToolSpec, allowlist: string[]): boolean {
  return allowlist.some((pattern) => {
    if (pattern === '*' || pattern === 'all') return true
    if (pattern.endsWith('.*')) return spec.group === pattern.slice(0, -2)
    return pattern === `${spec.group}.${spec.name}`
  })
}

export function createToolRegistry(): ToolRegistry {
  const specs: ToolSpec[] = []
  return {
    register(spec) {
      specs.push(spec)
    },
    list() {
      return [...specs]
    },
    resolve(allowlist, ctx) {
      const selected = specs.filter((s) => specMatches(s, allowlist))
      const tools = selected.map((s) => s.build(ctx))
      const riskByName = new Map(selected.map((s) => [s.name, s.risk] as const))
      return { tools, riskOf: (name) => riskByName.get(name) ?? 'medium' }
    },
  }
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `pnpm test src/service/tools/registry.test.ts`
Expected: PASS (5 tests).

- [ ] **Step 5: Commit**

```bash
git add src/service/tools/registry.ts src/service/tools/registry.test.ts
git commit -m "feat(tools): tool registry with allowlist filtering and risk metadata"
```

---

## Task 2: Built-in tool specs (peekaboo + spawn)

**Files:**
- Create: `src/service/tools/spawn.ts`
- Create: `src/service/tools/builtins.ts`
- Test: `src/service/tools/builtins.test.ts`

- [ ] **Step 1: Write the failing test**

Create `src/service/tools/builtins.test.ts`:

```ts
import { describe, it, expect } from 'vitest'
import { createToolRegistry, type ToolRunContext } from './registry'
import { registerBuiltinTools } from './builtins'

const ctx: ToolRunContext = {
  taskId: 't', spawnChild: async () => ({ childTaskId: 'c', result: { summary: 'done', artifacts: [] } }),
  send: () => undefined, requestPermission: async () => 'grant',
}

describe('registerBuiltinTools', () => {
  const make = () => {
    const r = createToolRegistry()
    registerBuiltinTools(r)
    return r
  }

  it('registers the two peekaboo tools and the spawn tool', () => {
    const ids = make().list().map((s) => `${s.group}.${s.name}`).sort()
    expect(ids).toEqual(['agent.spawn_sub_agent', 'peekaboo.list_apps', 'peekaboo.see_screen'])
  })

  it('peekaboo.* excludes the spawn tool', () => {
    const { tools, riskOf } = make().resolve(['peekaboo.*'], ctx)
    expect(tools.map((t) => t.name).sort()).toEqual(['list_apps', 'see_screen'])
    expect(riskOf('see_screen')).toBe('low')
  })

  it('spawn tool delegates to ctx.spawnChild and returns its summary', async () => {
    const { tools } = make().resolve(['agent.*'], ctx)
    const spawn = tools.find((t) => t.name === 'spawn_sub_agent')
    expect(spawn).toBeDefined()
    const result = await spawn!.execute('call-1', { goal: 'do a thing' })
    expect(result.content[0]).toEqual({ type: 'text', text: 'done' })
  })
})
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm test src/service/tools/builtins.test.ts`
Expected: FAIL — `Cannot find module './builtins'`.

- [ ] **Step 3: Write minimal implementation**

Create `src/service/tools/spawn.ts`:

```ts
import type { AgentTool } from '@earendil-works/pi-agent-core'
import { Type } from '@earendil-works/pi-ai'
import type { ToolRunContext, ToolSpec } from './registry'

const SpawnParams = Type.Object({
  goal: Type.String({ description: 'The goal for the sub-agent to accomplish.' }),
  suggestedTools: Type.Optional(
    Type.Array(Type.String(), { description: 'Tool scopes to make available (e.g. ["peekaboo"]).' }),
  ),
  providerKey: Type.Optional(
    Type.String({
      description: 'Key of a configured provider to use for this sub-agent. Defaults to current session provider.',
    }),
  ),
})

export function spawnAgentSpec(): ToolSpec {
  return {
    group: 'agent',
    name: 'spawn_sub_agent',
    risk: 'medium',
    source: 'builtin',
    build: (ctx: ToolRunContext): AgentTool => ({
      name: 'spawn_sub_agent',
      label: 'Spawn sub-agent',
      description:
        'Delegate a sub-task to a specialized agent. Use for research, analysis, or actions that benefit from a focused context. The sub-agent runs independently and returns its result.',
      parameters: SpawnParams,
      execute: async (_toolCallId: string, params: unknown) => {
        const p = params as { goal: string; suggestedTools?: string[]; providerKey?: string }
        const { childTaskId, result } = await ctx.spawnChild(p.goal, p.suggestedTools, p.providerKey)
        return {
          content: [{ type: 'text', text: result.summary }],
          details: { childTaskId, summary: result.summary },
        }
      },
    }),
  }
}
```

Create `src/service/tools/builtins.ts`:

```ts
import type { ToolRegistry, ToolRisk, ToolSpec } from './registry'
import { buildPeekabooTools } from './peekaboo'
import { spawnAgentSpec } from './spawn'

const PEEKABOO_RISK: Record<string, ToolRisk> = {
  see_screen: 'low',
  list_apps: 'low',
}

export function peekabooSpecs(): ToolSpec[] {
  // Peekaboo executors ignore deps (permission is enforced centrally in
  // beforeToolCall), so building once at registration is safe — the tool
  // objects are reused across runs.
  const tools = buildPeekabooTools({
    send: () => undefined,
    requestPermission: () => Promise.resolve('grant' as const),
  })
  return tools.map((tool) => ({
    group: 'peekaboo',
    name: tool.name,
    risk: PEEKABOO_RISK[tool.name] ?? 'medium',
    source: 'builtin' as const,
    build: () => tool,
  }))
}

export function registerBuiltinTools(registry: ToolRegistry): void {
  for (const spec of peekabooSpecs()) registry.register(spec)
  registry.register(spawnAgentSpec())
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `pnpm test src/service/tools/builtins.test.ts`
Expected: PASS (3 tests).

- [ ] **Step 5: Commit**

```bash
git add src/service/tools/spawn.ts src/service/tools/builtins.ts src/service/tools/builtins.test.ts
git commit -m "feat(tools): migrate peekaboo + spawn_sub_agent into registry specs"
```

---

## Task 3: `deriveAllowlist` helper

**Files:**
- Modify: `src/shared/types/agent.ts`
- Test: `src/shared/types/agent.test.ts` *(create)*

- [ ] **Step 1: Write the failing test**

Create `src/shared/types/agent.test.ts`:

```ts
import { describe, it, expect } from 'vitest'
import { deriveAllowlist } from './agent'

describe('deriveAllowlist', () => {
  it('all -> wildcard', () => {
    expect(deriveAllowlist('all')).toEqual(['*'])
  })
  it('peekaboo -> peekaboo group only', () => {
    expect(deriveAllowlist('peekaboo')).toEqual(['peekaboo.*'])
  })
  it('web -> web + agent', () => {
    expect(deriveAllowlist('web')).toEqual(['web.*', 'agent.*'])
  })
  it('fs -> fs + agent', () => {
    expect(deriveAllowlist('fs')).toEqual(['fs.*', 'agent.*'])
  })
})
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm test src/shared/types/agent.test.ts`
Expected: FAIL — `deriveAllowlist is not a function` / import error.

- [ ] **Step 3: Write minimal implementation**

Append to `src/shared/types/agent.ts` (after the existing exports):

```ts
/**
 * Default tool allowlist generated from an agent's coarse `toolScope`.
 * Used when a task is created without an explicit allowlist. `toolAllowlist`
 * remains the authoritative runtime filter; this only seeds its default.
 */
export function deriveAllowlist(scope: ToolScope): string[] {
  switch (scope) {
    case 'all':
      return ['*']
    case 'peekaboo':
      return ['peekaboo.*']
    case 'web':
      return ['web.*', 'agent.*']
    case 'fs':
      return ['fs.*', 'agent.*']
  }
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `pnpm test src/shared/types/agent.test.ts`
Expected: PASS (4 tests).

- [ ] **Step 5: Commit**

```bash
git add src/shared/types/agent.ts src/shared/types/agent.test.ts
git commit -m "feat(agent): deriveAllowlist generates default tool allowlist from toolScope"
```

---

## Task 4: Wire registry into `agent-runner`

**Files:**
- Modify: `src/service/agent-runner.ts`
- Modify: `src/service/agent-runner.test.ts`

- [ ] **Step 1: Update the test first (it will fail to compile)**

In `src/service/agent-runner.test.ts`, add this import near the top (after the existing imports):

```ts
import { createToolRegistry } from './tools/registry'
```

Add `toolRegistry: createToolRegistry(),` to the deps object in **both** `createAgentRunner({ ... })` calls (the empty-apiKey test and the initialMessages test). For example the first becomes:

```ts
    const runner = createAgentRunner({
      task: mkTask('t-1'),
      provider: { id: 'anthropic', model: 'claude-haiku-4-5-20251001', apiKey: '' },
      agentDefinition: { id: 'default', name: 'Default', systemPrompt: '', toolScope: 'all', maxIterations: 1 },
      emit: (event, data) => emitted.push({ event, data }),
      permissionRegistry: { request: vi.fn(), resolve: vi.fn() },
      spawnChild: vi.fn(),
      sessionId: 'ses-1',
      initialMessages: [],
      toolRegistry: createToolRegistry(),
    })
```

(An empty registry is fine: `mkTask` sets `toolAllowlist: []`, so zero tools resolve.)

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm test src/service/agent-runner.test.ts`
Expected: FAIL — TypeScript error: `toolRegistry` does not exist on `AgentRunnerDeps` (the property is not yet declared).

- [ ] **Step 3: Modify `agent-runner.ts`**

3a. Replace the peekaboo import (line 12):

```ts
import type { AgentTool } from '@earendil-works/pi-agent-core'
import type { ToolRegistry, ToolRisk, ToolRunContext } from './tools/registry'
```

(Remove `import { buildPeekabooTools } from './tools/peekaboo'`. Note `AgentEvent, AgentMessage` are already imported from pi-agent-core on line 2 — add `AgentTool` to a type import; if simpler, extend the existing line 2 type import to include `AgentTool`.)

3b. Add `toolRegistry` to `AgentRunnerDeps` (after `permissionRegistry: PermissionRegistry`):

```ts
  permissionRegistry: PermissionRegistry
  toolRegistry: ToolRegistry
```

3c. Add `toolRegistry` to the destructure at the top of `run()` (currently destructures from `deps`):

```ts
      const { task, provider, agentDefinition, sessionId, emit, permissionRegistry, spawnChild, initialMessages, toolRegistry } = deps
```

3d. Replace the entire tool-construction try block (current lines ~201-259: `let tools: ReturnType<typeof buildPeekabooTools>` through the spawn-tool append and `model = resolveModel(provider)`) with:

```ts
      let tools: AgentTool[]
      let riskOf: (name: string) => ToolRisk
      let model: Model<Api>
      try {
        const runCtx: ToolRunContext = {
          taskId: task.id,
          spawnChild: (goal, suggestedTools, providerKey) =>
            spawnChild(task.id, goal, suggestedTools, providerKey),
          send: () => undefined,
          requestPermission: () => Promise.resolve('grant' as const),
        }
        const resolved = toolRegistry.resolve(task.toolAllowlist, runCtx)
        tools = resolved.tools
        riskOf = resolved.riskOf
        model = resolveModel(provider)
      } catch (err) {
        taskLog.error({
          msg: 'setup threw before agent could start',
          err: err instanceof Error ? { name: err.name, message: err.message, stack: err.stack } : String(err),
        })
        emit('task.error', {
          taskId: task.id,
          error: {
            code: 'agent_setup_failed',
            message: err instanceof Error ? err.message : String(err),
            tier: 'fatal',
          },
          ts: Date.now(),
        })
        return { status: 'failed', summary: '', messages: initialMessages }
      }
```

3e. Replace the hardcoded risk logic inside `beforeToolCall` (current lines ~301-305) so it reads:

```ts
        beforeToolCall: async ({ toolCall, args }) => {
          const risk = riskOf(toolCall.name)

          if (risk === 'low') return undefined

          const decision = await permissionRegistry.request({
            taskId: task.id,
            toolName: toolCall.name,
            risk,
            summary: `Run tool: ${toolCall.name}`,
            payload: args,
          })

          if (decision === 'grant') return undefined
          return { block: true, reason: `User ${decision} the action.` }
        },
```

(Removes the `toolCall.name === 'see_screen' || ... ? 'low' : 'medium'` branch. The rest of the `new Agent({...})` config is unchanged.)

- [ ] **Step 4: Run tests to verify they pass**

Run: `pnpm test src/service/agent-runner.test.ts`
Expected: PASS (2 tests). The empty-apiKey test still returns before tool resolution; the initialMessages test resolves zero tools and proceeds.

- [ ] **Step 5: Commit**

```bash
git add src/service/agent-runner.ts src/service/agent-runner.test.ts
git commit -m "refactor(runner): resolve tools + risk from registry instead of hardcoding"
```

---

## Task 5: Thread registry through `session-manager` and `index`

**Files:**
- Modify: `src/service/session-manager.ts`
- Modify: `src/service/index.ts`

- [ ] **Step 1: Modify `session-manager.ts`**

1a. Add imports (near the existing imports):

```ts
import { createToolRegistry, type ToolRegistry } from './tools/registry'
import { registerBuiltinTools } from './tools/builtins'
import { deriveAllowlist } from '@shared/types/agent'
```

1b. Add an optional `toolRegistry` field to `SessionManagerConfig`:

```ts
type SessionManagerConfig = {
  store: ConversationStore
  broadcaster: SseBroadcaster
  maxConcurrent: number
  getProvider(key: string): ProviderInjection | undefined
  toolRegistry?: ToolRegistry
}
```

1c. Inside `createSessionManager`, resolve the registry once (after `const { store, broadcaster } = cfg`):

```ts
  const toolRegistry =
    cfg.toolRegistry ??
    (() => {
      const r = createToolRegistry()
      registerBuiltinTools(r)
      return r
    })()
```

1d. Pass `toolRegistry` into **both** `createAgentRunner({ ... })` calls. In `spawnChild`'s runner (after `permissionRegistry: session.permissionRegistry,`) and in `submitGoal`'s `runTurn` runner (after `permissionRegistry: session.permissionRegistry,`):

```ts
          toolRegistry,
```

1e. Correct the child task's default allowlist in `spawnChild` (currently `suggestedTools ?? ['peekaboo.*', 'web.*', 'fs.*']`):

```ts
      toolAllowlist: suggestedTools ?? ['peekaboo.*', 'agent.*'],
```

1f. In `submitGoal`, replace the hardcoded task allowlist (currently `toolAllowlist: ['peekaboo.*', 'web.*', 'fs.*'],`) with one derived from the agent's scope:

```ts
        toolAllowlist: deriveAllowlist(agentDef.toolScope),
```

- [ ] **Step 2: Run the session-manager tests to verify nothing broke**

Run: `pnpm test src/service/session-manager.test.ts`
Expected: PASS. Existing call sites omit `toolRegistry`, so the internal builtin-seeded default is used; behavior for `toolScope: 'all'` (the default agent) resolves `['*']` → all tools, matching prior behavior where spawn + peekaboo were available.

- [ ] **Step 3: Modify `index.ts`**

3a. Add imports (after the existing `./session-manager` import):

```ts
import { createToolRegistry } from './tools/registry'
import { registerBuiltinTools } from './tools/builtins'
```

3b. Create + seed the registry (after `const broadcaster = createSseBroadcaster()`):

```ts
const toolRegistry = createToolRegistry()
registerBuiltinTools(toolRegistry)
```

3c. Inject it into `createSessionManager`:

```ts
const manager = createSessionManager({
  store,
  broadcaster,
  maxConcurrent: 4,
  getProvider: (key) => providerRegistry.get(key),
  toolRegistry,
})
```

- [ ] **Step 4: Verify the full suite + typecheck + lint**

Run: `pnpm run verify`
Expected: PASS — typecheck, lint, all tests, and the native-feel check are green.

- [ ] **Step 5: Commit**

```bash
git add src/service/session-manager.ts src/service/index.ts
git commit -m "feat(service): inject tool registry; enforce toolAllowlist per task"
```

---

## Done criteria

- `agent-runner.ts` constructs no tools inline; all tools come from `toolRegistry.resolve(...)`.
- A task with `toolAllowlist: ['peekaboo.*']` resolves only the two peekaboo tools (no `spawn_sub_agent`) — proven by `builtins.test.ts`.
- Permission risk is sourced from `riskOf(name)`; adding a tool requires no edit to `beforeToolCall`.
- The MCP seam exists: `registry.register({ source: 'mcp', ... })` makes a tool resolvable — proven by `registry.test.ts`.
- Default allowlists no longer reference non-existent `web.*`/`fs.*` tools (re-added in P1).
- `pnpm run verify` is green.
