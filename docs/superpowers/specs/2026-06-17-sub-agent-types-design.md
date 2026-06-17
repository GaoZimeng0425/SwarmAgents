# Sub-agent types — design

**Date:** 2026-06-17
**Status:** Approved (Feature A). Feature B (global cost-control UI) is a separate follow-up spec.

## Problem

`spawn_sub_agent` always runs the hardcoded `DEFAULT_AGENT_DEF`; it only varies the
tool allowlist via `suggestedTools`. There is no way to delegate to a specialized
sub-agent (different prompt, tools, model). A real `AgentRegistry` with
`researcher`/`executor` definitions exists in `src/main/agents/registry.ts` but is
**dead code** — never imported, never wired to the runner. The default system prompt
doesn't even mention `spawn_sub_agent`, so the model rarely delegates.

This spec makes sub-agent types a first-class, user-extensible concept by **mirroring
the existing skill subsystem** (built-in seed in code + on-disk store with user
override + catalog injected into the prompt + a tool that references entries by name).
That pattern is already used for skills and MCP servers, so it will feel familiar.

## Scope

In scope (Feature A):
- Multiple sub-agent types: built-in (shipped in code) + user-defined (on disk),
  with user definitions overriding built-ins by id.
- `spawn_sub_agent` selects a type; `spawnChild` resolves and applies it.
- The available types are listed into the parent agent's system prompt.

Out of scope (deferred):
- **Feature B — global cost-control UI.** Budgets stay hardcoded as they are today.
  A later spec adds a settings UI to adjust budgets for main + sub agents, pushed to
  the service like `webSearchConfig`. Sub-agent types carry **no** per-type budget.
- Model routing via `modelHint` — removed entirely (see below). Per-type model
  selection is still possible via the explicit `model` field.

## Data model

`src/shared/types/agent.ts`:

- **Remove** `ModelHintSchema`, the `ModelHint` type, and the `modelHint` field from
  `AgentDefinitionSchema`. Nothing reads it.
- **Add** `description: z.string().min(1).max(1024)` to `AgentDefinitionSchema` — the
  one-line purpose shown in the prompt catalog and used by the model to choose a type.
  **Convention:** descriptions MUST be written trigger-first ("Use when …"), not
  feature-first, so the model matches on *when to delegate* — mirroring how skill
  descriptions drive `use_skill`. e.g. `researcher: Use when the task needs upfront
  read-only investigation across many sources and must not mutate the system; runs in
  its own focused context.` (not `Gathers information`). This is a documented authoring
  rule, not a schema-enforced one.
- Keep `model?: string` for per-type model override.
- `id` follows the skill name convention (lowercase a-z/0-9 + single hyphens, ≤64).

Resulting shape:
```ts
AgentDefinition = {
  id: string            // unique key + on-disk folder name
  name: string          // human label
  description: string   // one-line purpose, shown to the model
  systemPrompt: string  // the agent's role prompt (= AGENT.md body)
  toolScope: ToolScope  // capability boundary, fed to deriveAllowlist
  maxIterations: number // main-loop cap (default 25)
  model?: string        // optional explicit model override
}
```

`deriveAllowlist(toolScope)` already exists and is unchanged.

## Built-in definitions

Move the three built-ins (`default`, `researcher`, `executor`) out of the dead
`src/main/agents/registry.ts` into **`src/shared/agents/builtins.ts`**, exporting
`builtinAgents: AgentDefinition[]`. Shared is the correct home: the **service** runs
agents and cannot import from main, but can import shared — exactly like
`src/shared/agents/default-prompt.ts` already does. Add a **trigger-first**
`description` to each (per the convention above): `default` is the catch-all fallback,
`researcher` for read-only multi-source investigation, `executor` for driving on-screen
UI actions. Delete `src/main/agents/registry.ts` and `src/main/agents/registry.test.ts`.

`DEFAULT_AGENT_DEF` in `session-manager.ts` becomes the `default` entry from
`builtinAgents` (single source of truth).

## On-disk store

New `src/service/agents/store.ts` — `createAgentStore({ dir, builtins })`, a direct
structural mirror of `createSkillStore`:

- On-disk layout: `<userData>/agents/<id>/AGENT.md`.
- `AGENT.md` = YAML frontmatter + markdown body, where the body **is** `systemPrompt`:
  ```markdown
  ---
  name: Research Agent
  description: Gathers information and reports findings; read-only.
  toolScope: peekaboo
  maxIterations: 15
  model: claude-haiku-4-5        # optional
  ---

  You are a research agent. Your job is to gather information and report findings.
  ...
  ```
- API: `list()`, `get(id)`, `reload()`, `save(def)`, `remove(id)`.
- `merged()`: user definitions override built-ins of the same id (identical to
  skillStore's `merged()`).
- Parsing mirrors `parseSkill`: real YAML frontmatter via the `yaml` package, body
  trimmed. Validate with `AgentDefinitionSchema`; on malformed frontmatter, log a
  warn and skip that folder (don't crash reload).
- `save`/`remove` write/delete `<dir>/<id>/AGENT.md` then `reload()`, returning a
  mutation result shaped like `SkillMutationResult`.

Wiring in `src/service/index.ts` (mirror skillStore):
- `const agentsPath = process.env.SWARM_SERVICE_AGENTS_PATH ?? join(tmpdir(), 'swarm-agent-agents')`
- `const agentStore = createAgentStore({ dir: agentsPath, builtins: builtinAgents })`
- Pass `agentStore` into `createSessionManager(...)` config.
- `src/main/index.ts` sets `SWARM_SERVICE_AGENTS_PATH: join(app.getPath('userData'), 'agents')`.

## Spawn integration

`src/service/tools/spawn.ts`:
- Add optional param `agentType: string` to `SpawnParams` ("Which sub-agent type to
  use; see the available types in your prompt. Defaults to 'default'.").
- Pass it through `ctx.spawnChild(goal, suggestedTools, providerKey, agentType)`.
- Update the tool's top-level `description` to match the prompt's "when to delegate"
  guidance, so the tool schema and the prompt give the model one consistent signal.
- Extend the `ToolRunContext.spawnChild` signature (`registry.ts`) and the
  `agent-runner.ts` plumbing to carry `agentType`.

`spawnChild` in `src/service/session-manager.ts`:
- Resolve `const def = agentStore.get(agentType) ?? DEFAULT_AGENT_DEF`. If `agentType`
  was given but not found, `log.warn` and fall back to default (same shape as the
  existing `providerKey` fallback).
- Child task: `agentDefId: def.id`, `toolAllowlist: suggestedTools ?? deriveAllowlist(def.toolScope)`.
- Runner: `agentDefinition: withSkillPrompt(def)`; pass `def.maxIterations`.
- Model: the runner resolves the model from `ProviderInjection.model`
  (`resolveModel`/`agent-runner.ts`). So apply `def.model` by overriding that field on
  the child's provider: `resolvedProvider = { ...baseProvider, ...(def.model ? { model: def.model } : {}) }`.
  When `def.model` is unset, the child inherits the provider's model unchanged.
- **Budget unchanged** — keep the current hardcoded child budget. Feature B replaces it.

## Prompt catalog

New `src/service/agents/prompt.ts` — `withAgentTypes(base, defs)`, parallel to
`withSkills`:

```
# Sub-agent types

You can delegate a focused sub-task by calling `spawn_sub_agent` with an `agentType`.
Delegate when a sub-task is independent, benefits from its own focused context, or
should run under a narrower capability boundary (e.g. read-only investigation). Do the
work yourself for trivial single-step actions — don't delegate by reflex.
Available types:
- default: <description>
- researcher: <description>
- executor: <description>
```

The "when to delegate" guidance line above is fixed prose in `withAgentTypes`; the
per-type triggers come from each definition's (trigger-first) `description`. The
`spawn_sub_agent` tool description is kept consistent with this guidance so the model
gets the same signal from the tool schema and the prompt.

`session-manager.ts` composes both injections at task time so newly-added agents and
skills appear without a restart:
```ts
const withPrompt = (def) => {
  let p = def.systemPrompt
  if (cfg.skillStore) p = withSkills(p, cfg.skillStore.list())
  if (cfg.agentStore) p = withAgentTypes(p, cfg.agentStore.list())
  return { ...def, systemPrompt: p }
}
```
This also fixes today's gap where the prompt never mentions `spawn_sub_agent`.

## Error handling

- Unknown `agentType` → warn + fall back to `default` (never throw mid-task).
- Malformed `AGENT.md` → warn + skip during reload; other agents still load.
- `save` with an invalid definition → `{ ok: false, code: 'invalid', message }`,
  matching the skill store.
- Every `catch` logs `{ msg, err }` per the project logging rules before
  returning/rethrowing.

## Testing

- `src/service/agents/store.test.ts` — mirror `skills/store.test.ts`: parse round-trip
  (`parseAgent`/`serializeAgent`), built-in + user merge/override by id, malformed
  frontmatter skipped, `save`/`remove` write/delete + reload.
- `src/service/agents/prompt.test.ts` — `withAgentTypes` emits the catalog; empty list
  leaves the base prompt untouched.
- Extend the spawn / session-manager tests: `spawn_sub_agent` with `agentType:
  'researcher'` runs with the researcher prompt + `peekaboo` allowlist; unknown type
  falls back to default with a warn.
- Schema test: `AgentDefinitionSchema` rejects a missing `description`; `modelHint` is
  gone.

Run tests with `npm test` (Electron's node), per project convention.

## Files touched

- `src/shared/types/agent.ts` — drop `modelHint`/`ModelHintSchema`, add `description`.
- `src/shared/agents/builtins.ts` — **new**, `builtinAgents` (moved from main).
- `src/main/agents/registry.ts`, `registry.test.ts` — **deleted** (dead code).
- `src/service/agents/store.ts` — **new**, `createAgentStore`.
- `src/service/agents/prompt.ts` — **new**, `withAgentTypes`.
- `src/service/index.ts` — instantiate + inject `agentStore`; new env var default.
- `src/main/index.ts` — set `SWARM_SERVICE_AGENTS_PATH`.
- `src/service/session-manager.ts` — use `builtinAgents` default, resolve type in
  `spawnChild`, compose `withAgentTypes`.
- `src/service/tools/spawn.ts`, `tools/registry.ts`, `agent-runner.ts` — thread
  `agentType` through `spawnChild`.
- Tests as above.
