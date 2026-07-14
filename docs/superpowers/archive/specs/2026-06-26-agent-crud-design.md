# Spec 3 — In-view Agent CRUD

Date: 2026-06-26
Status: Approved (design)

## Context

The Agents settings view (rebuilt in Spec 2) is read-only: it lists agents as
an org tree and shows each agent's detail. There is no way to create, edit, or
delete an agent from the UI — users must hand-author `AGENT.md` files on disk.
The agent store already supports persistence: `save(def): AgentMutationResult`
and `remove(id): AgentMutationResult` exist (`src/service/agents/store.ts`),
including the Spec 1 `parentId` validation (`self_parent` / `unknown_parent` /
`cycle`). Only the renderer IPC surface is missing — `swarmApi` exposes just
`listAgents()`.

This is Spec 3 of 4. It adds create/edit/delete from the view, mirroring the
existing skills CRUD IPC pattern (`window.swarm.skills.remove` →
`dispatcher.deleteSkill` → store). No delegation-graph work (that is Spec 4).

## Decision

Add an IPC write path for agents and a right-side **Sheet** form to
create/edit, plus per-node edit/delete actions in the org tree. Built-in agents
are **read-only**: they cannot be edited or deleted, but a **Duplicate** action
prefills the form so a user can derive a custom copy. `listAgents()` tags each
returned agent with a derived `builtin: boolean` so the UI knows which are
editable. `AgentDefinitionSchema` is unchanged — `builtin` is a list-time view
field, never persisted.

## Architecture

### Data model / types (`src/shared/types/agent.ts`)
- Add `export type AgentListItem = AgentDefinition & { builtin: boolean }`.
  `builtin` is NOT added to `AgentDefinitionSchema` (not persisted).

### Service
- `src/service/agents/store.ts`: `list()` is unchanged (`AgentDefinition[]`,
  consumed by the directory/session). Add a small helper so the IPC layer can
  tag entries — `isBuiltin(id: string): boolean` (true when `id` is a built-in
  AND not overridden by a user agent of the same id). `save`/`remove` already
  exist and are reused as-is.
- `src/service/ipc/dispatcher.ts`: `listAgents()` returns `AgentListItem[]`
  (maps `store.list()` and sets `builtin: store.isBuiltin(a.id)`). Add
  `saveAgent(def): AgentMutationResult` and `deleteAgent(id): AgentMutationResult`
  delegating to the store, mirroring `saveSkill`/`deleteSkill`.

### IPC bridge
- `src/main/ipc/swarm-ipc.ts`: add `agents:save` and `agents:delete` handlers
  mirroring `skills:save`/`skills:delete`.
- preload + `src/renderer/src/lib/api.ts`: add
  `window.swarm.agents.save(def)` / `.remove(id)`; `swarmApi.saveAgent` /
  `swarmApi.removeAgent`. `swarmApi.listAgents()` return type becomes
  `Promise<AgentListItem[]>`.

### Renderer
- `useAgentMutations` (new hook, mirrors the skills mutation pattern): wraps
  `saveAgent`/`removeAgent`, invalidates `['agents','settings']` on success,
  surfaces `AgentMutationResult` failures.
- `AgentFormSheet` (new): a right-side `Sheet` controlled form (create or edit).
- `OrgTreeView` gains: a **New agent** button (opens an empty form); per-node
  **edit**/**delete** actions for user agents; a **Duplicate** action for
  built-ins. Delete confirms via `alert-dialog`.

`AgentNodeCard` receives the `builtin` flag and the action callbacks; built-in
cards show only Duplicate, user cards show Edit + Delete.

## Form (`AgentFormSheet`)

Right-side `Sheet`, scrollable, grouped fields:

| Group | Fields |
|---|---|
| Identity | `id` (text; editable on create, **read-only on edit** — it is the folder name), `name` (text), `description` (textarea) |
| Behavior | `systemPrompt` (large textarea), `toolScope` (`native-select`: peekaboo / web / fs / memory / authoring / all) |
| Org | `parentId` (`select` dropdown of existing agents by id+name, default "(none)", excludes the agent being edited), `team` (text), `teamRole` (checkbox "Team head" → `'head'` | undefined), `role` (text) |
| Advanced | `capabilities` (comma-separated text ↔ `string[]`), `model` (text), `maxIterations` (number, default 25) |

- **Create**: empty form; on submit builds an `AgentDefinition` and calls
  `saveAgent`. Empty optional fields are omitted (not sent as empty strings).
- **Edit**: prefilled from the agent; `id` read-only; submit calls `saveAgent`
  (same id overwrites its `AGENT.md`).
- **Duplicate** (from a built-in): prefill all fields from the built-in but
  clear `id` (user types a new one) — produces a new user agent. (Reusing the
  same id would instead override the built-in; the user chooses the id.)
- **Validation surfacing**: on a non-ok `AgentMutationResult`, show the
  `message` (toast) and an inline error near the relevant field where it maps
  cleanly (`self_parent`/`unknown_parent`/`cycle` → near `parentId`; `invalid`
  → form-level). The `parentId` dropdown already prevents `unknown_parent` and
  self-reference for the common path; the store remains the source of truth.

## Data flow

`listAgents()` → `AgentListItem[]` → `OrgTreeView` (builds the tree via
`buildOrgForest`, which ignores the extra `builtin` field — structural
subtype). Editing/creating opens `AgentFormSheet`; submit → `useAgentMutations`
→ `saveAgent` → store writes `AGENT.md` → `agents.changed` broadcast (Spec 2
live-reload) + query invalidation refresh the tree. Delete → confirm →
`removeAgent` → same refresh.

## Components are isolated and testable

- `AgentFormSheet` is prop-driven: takes an optional `agent` (edit/duplicate)
  or none (create), the list of agents (for the `parentId` dropdown), and
  `onSubmit(def)` / `onClose` callbacks. It owns local field state only; the
  mutation/IPC lives in `useAgentMutations`, so the form tests without IPC
  mocking (matching the repo's prop-driven component-test precedent).
- `useAgentMutations` is tested at the store/dispatcher level; the form is
  tested for field round-trip, the parentId dropdown contents, and that submit
  calls `onSubmit` with the assembled `AgentDefinition`.

## Testing

- **store** (`store.test.ts`): `isBuiltin` true for a shipped builtin, false
  after a user agent overrides it and false for a pure user agent; save (create
  + update overwrite) and remove round-trip (extend existing coverage).
- **dispatcher** (`dispatcher.test.ts` or the IPC test that covers skills):
  `listAgents` tags `builtin`; `saveAgent`/`deleteAgent` delegate to the store
  and return its `AgentMutationResult`.
- **AgentFormSheet** (RTL): create-mode submit assembles the right
  `AgentDefinition` (omitting empty optionals); edit-mode prefills and makes
  `id` read-only; the `parentId` dropdown lists other agents and excludes the
  edited agent; a non-ok result shows the error message.
- **OrgTreeView** (RTL, extend): a user-agent node exposes Edit + Delete; a
  built-in node exposes only Duplicate (no Delete).

## Backward compatibility

`listAgents()` gains a `builtin` field but remains a superset of
`AgentDefinition`, so `buildOrgForest` and the Spec 2 tree render unchanged.
`store.list()` (used by the directory/session) keeps returning
`AgentDefinition[]`. No change to agent on-disk format, `find_agents`, or the
directory.

## Out of scope (later spec)

- Delegation/reachability graph ("who can call whom") — **Spec 4**.
