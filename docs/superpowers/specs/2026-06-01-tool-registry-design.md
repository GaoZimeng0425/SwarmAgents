# Tool Registry Design (P0)

**Date:** 2026-06-01  
**Scope:** A metadata-bearing tool registry that replaces hardcoded tool construction in `agent-runner`, enforces per-task tool authorization, drives permission risk from tool metadata, and reserves a seam for MCP-provided tools.  
**Status:** Approved

## Background

The project aims to be a general-purpose conversational execution agent — capable of both macOS desktop automation and knowledge/coding work. The runtime environment is meant to provide tools, Skills, and retrieval. Today only a thin slice of that environment exists, and the tool layer in particular has three "declared but not enforced" inconsistencies:

1. **Tools are hardcoded and unfiltered.** `agent-runner.ts` builds `buildPeekabooTools(...)` inline and appends `spawn_sub_agent` directly. Every agent receives the same tool set regardless of its definition or task.
2. **`toolAllowlist` / `toolScope` are ignored.** `Task.toolAllowlist` (e.g. `['peekaboo.*', 'web.*', 'fs.*']`) and `AgentDefinition.toolScope` (`peekaboo|web|fs|all`) are declared in the type system and populated on every task, but `agent-runner` never reads them to filter the toolset.
3. **Permission risk is hardcoded by name.** `beforeToolCall` decides risk via `toolCall.name === 'see_screen' || 'list_apps' ? 'low' : 'medium'`. Adding any tool requires editing this branch.
4. **Ghost defaults.** Default allowlists reference `web.*` and `fs.*`, but no such tools exist — they match nothing.

This is P0 of a larger blueprint. It is the foundation every later phase plugs into:

| Phase | Subsystem | Depends on |
|---|---|---|
| **P0** | **Tool registry + scope enforcement** | — (this spec) |
| P1 | Core built-in tools (`fs`/`web`/`shell`) | P0 (register into it) |
| P2 | Skill subsystem (Claude-Code-style progressive disclosure) | P0 (Skills declare allowed-tools; surfaced as a tool) |
| P3 | Retrieval / memory (wire in + vector search) | P0 (`recall`/`remember` as tools) |
| P4 | Context & budget management | P1–P3 (token composition changes first) |

## Goals

- Introduce a `ToolRegistry` that holds metadata-bearing `ToolSpec` entries and produces the concrete `AgentTool[]` for a given task.
- Enforce `Task.toolAllowlist` as the single authoritative filter over available tools.
- Move permission risk into tool metadata; `beforeToolCall` reads it instead of branching on names.
- Migrate the existing tools (`see_screen`, `list_apps`, `spawn_sub_agent`) into the registry as the first registered entries — no new tools added.
- Reserve an MCP seam: a single `register(spec)` entry point that an MCP adapter can later call, plus a `source: 'mcp'` discriminator. No MCP implementation in P0.
- Reconcile `toolScope` vs `toolAllowlist` so only one is authoritative.

## Non-Goals

- New tools (`fs`, `web`, `shell`) — that is P1.
- Skill subsystem, retrieval, context/budget management — P2–P4.
- Any actual MCP server connection — only the registration seam is reserved.
- Aligning `AgentDefinition.systemPrompt` prose (which currently claims click/type tools that don't exist) with the real toolset — deferred to P1, where the registry's `list()` can auto-generate an accurate tool listing for the prompt.

## Architecture

```
ToolRegistry  (built once, holds ToolSpec[])
  register(spec)            ← builtin factories at startup; MCP adapter later
  list()
  resolve(allowlist, ctx) → { tools: AgentTool[], riskOf(name) }
        │
        ▼
AgentRunner.run()
  const { tools, riskOf } = registry.resolve(task.toolAllowlist, runCtx)
  new Agent({ tools, beforeToolCall })
       beforeToolCall: risk = riskOf(toolCall.name)  // metadata, not name branch
```

### ToolSpec

```ts
type ToolRisk   = 'low' | 'medium' | 'high'
type ToolSource = 'builtin' | 'mcp'

interface ToolRunContext {
  taskId: string
  spawnChild(goal: string, suggestedTools?: string[], providerKey?: string):
    Promise<{ childTaskId: string; result: TaskResult }>
  send: (msg: Outbound) => void
  requestPermission: (args: { toolName: string; risk: ToolRisk; summary: string; payload: unknown }) => Promise<PermissionDecision>
}

interface ToolSpec {
  group: string          // 'peekaboo' | 'agent' | 'fs' | 'web' | 'memory' | 'skill' | <mcp-server>
  name: string           // bare, model-facing: 'see_screen'
  risk: ToolRisk
  source: ToolSource
  build(ctx: ToolRunContext): AgentTool   // factory: produces the pi AgentTool with run context injected
}
```

Fully-qualified id = `${group}.${name}` (e.g. `peekaboo.see_screen`).

### Naming model — decision: group metadata (option B)

The model-facing tool `name` stays bare (`see_screen`), and `group` is carried as separate metadata. **Rejected** alternative: renaming tools to `peekaboo.see_screen`.

Rationale:
- Zero behavior regression — the model sees the same tool names it sees today.
- Mirrors MCP's own model (server = group, tool = bare name, `server.tool` = fully-qualified), so the MCP adapter maps cleanly later.
- Avoids OpenAI tool-name character constraints that a dotted name could trip.

### Allowlist matching

`resolve(allowlist, ctx)` includes a `ToolSpec` when any pattern in `allowlist` matches:

- `*` or `all` → matches every spec.
- `<group>.*` → matches by `group` (e.g. `peekaboo.*` matches all peekaboo tools).
- `<group>.<name>` → exact fully-qualified match.

`riskOf(name)` is a closure over the resolved specs: bare tool name → its `risk`. Default for an unknown name is `medium` (defensive — should not occur since only resolved tools can be called).

### `toolScope` vs `toolAllowlist` reconciliation

- `Task.toolAllowlist` becomes the **single source of truth**.
- `AgentDefinition.toolScope` is demoted to a *default generator*: when a task is created without an explicit allowlist, `toolScope` produces one (`peekaboo` → `['peekaboo.*']`, `all` → `['*']`, etc.). It no longer participates in runtime filtering.
- Default allowlist is corrected to reference only tools that exist: **`['peekaboo.*', 'agent.*']`**. `web.*` / `fs.*` are re-added in P1 when those tools land.

### AgentRunner integration (surgical)

- Remove the inline `buildPeekabooTools(...)` call and the `spawn_sub_agent` construction block from `agent-runner.ts`.
- Accept a `ToolRegistry` (and the `runCtx` ingredients already present: `spawnChild`, `task.id`) via `AgentRunnerDeps`.
- Replace tool construction with `const { tools, riskOf } = registry.resolve(task.toolAllowlist, runCtx)`.
- `beforeToolCall`: `const risk = riskOf(toolCall.name)`; keep the existing grant/deny flow otherwise. `low` → auto-allow (unchanged), `medium`/`high` → permission request (unchanged).

### Seed registration

At service startup, register the existing tools as `ToolSpec`s:

| group | name | risk | source | factory wraps |
|---|---|---|---|---|
| `peekaboo` | `see_screen` | `low` | builtin | existing peekaboo factory |
| `peekaboo` | `list_apps` | `low` | builtin | existing peekaboo factory |
| `agent` | `spawn_sub_agent` | `medium` | builtin | new factory closing over `ctx.spawnChild` |

`buildPeekabooTools` is refactored to expose per-tool specs (or wrapped so each emitted `AgentTool` is paired with its `group`/`risk`). `spawn_sub_agent`'s factory uses `ctx.spawnChild` instead of the closure currently inlined in `agent-runner`.

## Data Flow

```
session-manager.submitGoal
  └─ task.toolAllowlist = explicit ?? deriveFromScope(agentDef.toolScope)
        │
        ▼
  createAgentRunner({ registry, task, spawnChild, ... })
        └─ registry.resolve(task.toolAllowlist, { taskId, spawnChild, send, requestPermission })
              → tools handed to new Agent(...)
              → riskOf consulted in beforeToolCall on each call
```

## Error Handling

- **Empty resolved toolset:** if `resolve` yields zero tools (e.g. a misconfigured allowlist), the agent still runs but with no tools; log a warning with the offending allowlist. No crash.
- **Unknown tool name in `riskOf`:** default to `medium` (request permission) rather than `low` — fail safe toward asking.
- **Factory throws during `build`:** surface as the existing `agent_setup_failed` fatal path in `agent-runner` (the try/catch around setup already exists).

## Testing

- `tool-registry.test.ts`:
  - `resolve(['peekaboo.*'])` returns both peekaboo tools and not `spawn_sub_agent`.
  - `resolve(['peekaboo.see_screen'])` returns exactly one tool.
  - `resolve(['*'])` / `resolve(['all'])` returns all registered tools.
  - `riskOf('see_screen')` === `'low'`; `riskOf('spawn_sub_agent')` === `'medium'`; `riskOf('unknown')` === `'medium'`.
  - `register({ source: 'mcp', ... })` then `resolve` includes the MCP-sourced tool — proves the seam.
- `agent-runner.test.ts` (update): assert tools come from the registry and `beforeToolCall` risk is sourced from `riskOf`, not a name branch.
- Existing peekaboo tests remain green (the underlying `AgentTool` behavior is unchanged; only wrapping moves).

## Verification

`pnpm run verify` (typecheck + lint + test + native-feel check) passes. The three inconsistencies are demonstrably resolved:

1. `agent-runner` no longer constructs tools inline.
2. A task with `toolAllowlist: ['peekaboo.*']` cannot call `spawn_sub_agent` (test-proven).
3. Adding a tool requires no edit to `beforeToolCall`.
