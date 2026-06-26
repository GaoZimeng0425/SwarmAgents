# Built-in Agents: Disk Seeding + CEO Resilience + Detail Drawer

Date: 2026-06-26

## Problem

Built-in agents (`ceo`, `pm`, `engineer`, `reviewer`, `training-head`, `training-author`,
`default`, `researcher`, `executor`) live **only in code** (`src/shared/agents/builtins.ts`)
and are overlaid at runtime by `AgentStore.merged()`. They are never written to disk.

Two consequences:

1. **CEO execution breaks silently.** `startCompany` seeds a fixed roster
   (`COMPANY_ROLES`) of addressable actors and rpc-kicks the agent addressed `'ceo'`.
   `spawnResident` resolves the agent definition with
   `cfg.agentStore?.get(actor.agentDefId) ?? DEFAULT_AGENT_DEF`. When the requested
   def is missing, it **silently falls back to the default agent** — no warning log.
   A "CEO" running the default system prompt no longer discovers team heads or
   delegates, so the whole company run misbehaves. Deleting / failing to resolve a
   company-critical agent degrades the run with no trace in the log file.

2. **Built-ins are not user-manageable.** Because they live in code, the UI marks them
   read-only (Duplicate-only, no Edit/Delete). The user cannot treat them as real,
   editable files they own.

Additionally, the Agents settings tab renders the selected agent's detail **inline**
below the org tree, which is inconsistent with the create/edit flow that uses a
right-side sheet.

## Goals

- Ship the agent definitions as **default seed data** copied to disk on first init, so
  built-ins become real, editable, deletable `AGENT.md` files the user owns.
- Make company runs **robust**: a missing company-critical role self-heals at company
  start, and any def-resolution fallback is logged.
- Make the agent **detail view a right-side read-only drawer**, consistent with the
  create/edit sheet.

## Non-Goals

- No change to the **skills** store (it keeps its own code-overlay; out of scope).
- No "reset to defaults" UI. Re-seeding happens only on empty-dir init and company-start
  self-heal.
- No new fields on `AgentDefinition`.

## Design

### 1. Constant source: `src/shared/constants/agents.ts`

Move `src/shared/agents/builtins.ts` → `src/shared/constants/agents.ts`.

- Rename the exported array `builtinAgents` → **`defaultAgents`**.
- Keep `DEFAULT_AGENT_DEF = defaultAgents[0]` (the `default` agent) — still the single
  source for the spawn fallback definition.
- Update all importers: `src/service/index.ts`, `src/service/session/manager.ts`
  (only if it imports the defs), `scripts/smoke-company.ts`, and the tests
  (`builtins.test.ts`, `builtins.company.test.ts`, company e2e/startup tests).
  Test file names may be renamed to match, but renaming is optional and secondary.

### 2. Seed-on-init (service startup)

In `src/service/index.ts`, before/at `createAgentStore` construction, seed the agents
directory **only when it is empty or absent**:

```
if agentsPath has no agent subdirs:
  for each def in defaultAgents:
    write `<agentsPath>/<def.id>/AGENT.md` via serializeAgent(def)
```

- "Empty or absent" = the directory does not exist, or contains no `*/AGENT.md`.
- Whole-roster seed, **not** per-id top-up: once seeded, a user's later deletion of a
  built-in **sticks** across restarts (it is not resurrected on every boot). This
  matches "copy the defaults at initialization time".
- Seeding reuses the store's existing `serializeAgent` so the on-disk format is
  identical to a user-saved agent. Implement the seed as a small exported helper
  (e.g. `seedDefaultAgents(dir, defs)`) in the agents store module so it is unit-testable
  and shares `serializeAgent`.

### 3. AgentStore becomes pure-disk

`createAgentStore({ dir })` no longer takes a `builtins` overlay:

- Remove the `builtins` option and the `merged()` overlay. `list()` returns the on-disk
  agents directly; `get(id)` reads only on-disk agents.
- Remove `isBuiltin` from the store and from `AgentListItem` (`builtin` flag). Every agent
  is now a real file, uniformly **editable and deletable** in the UI.
- `listAgents` in `src/service/index.ts` drops the `builtin` annotation:
  `listAgents: () => agentStore.list()`.
- `DEFAULT_AGENT_DEF` is imported from the constants module for the spawn fallback; it is
  not part of the store overlay.

UI impact (`org-tree-view.tsx`): remove the `agent.builtin ? <Duplicate-only> :
<Edit/Delete>` branch — show Edit / Duplicate / Delete for every agent.

### 4. CEO resilience (the core fix)

In `src/service/session/manager.ts`:

- **Self-heal at company start.** In `startCompany`, before seeding the actors, ensure
  every `COMPANY_ROLES` id exists on disk; for any missing id, re-seed it from
  `defaultAgents` (write `AGENT.md` + `agentStore.reload()`). Then proceed to
  `ensureActor` + rpc-kick `'ceo'`. This guarantees `get('ceo')`, `get('pm')`, etc.
  resolve to the correct definition even if the user deleted one. The store exposes a
  helper for this (reuse `seedDefaultAgents` filtered to the missing company ids, or a
  dedicated `ensureSeeded(ids)` method).
- **No silent degradation.** In `spawnResident`, change
  `cfg.agentStore?.get(actor.agentDefId) ?? DEFAULT_AGENT_DEF` to log a `warn`
  when `get` returns undefined (the def was not found and we are falling back to the
  default agent), including `{ agentDefId, address, sessionId }`. The fallback behavior
  is preserved; only the silence is removed (per the project logging rules: branch
  surprises at `warn`).

Semantic consequence (intended, per the chosen "self-heal on company start" option):
the user may edit or delete any agent, but deleting a company-critical role
(`ceo`/`pm`/`engineer`/`reviewer`/`training-head`/`training-author`) is automatically
restored — and re-written to disk, so it reappears in the Agents list — the next time a
company goal runs.

### 5. Detail drawer (read-only)

In `src/renderer/src/components/views/org-tree-view.tsx`:

- Replace the inline `{selected && <AgentDetail .../>}` + `<DelegationLinks .../>`
  (currently rendered below the tree) with a **right-side read-only `Sheet`**
  (`@/components/ui/sheet`, same primitive as `AgentFormSheet`).
- Clicking an agent sets `expanded` (unchanged); the detail sheet's `open` is
  `expanded !== null`, and closing it clears `expanded`. The tree's delegation-edge
  highlight continues to key off `expanded`.
- The sheet body shows the existing `AgentDetail` content (name, id, description, system
  prompt) plus `DelegationLinks`. It is **purely read-only** — no Edit/Delete buttons in
  the drawer. CRUD affordances stay on the tree-node hover row.
- Create/edit/duplicate continue to use the existing `AgentFormSheet`; the two sheets are
  mutually exclusive states and do not need to coexist.

## Testing

- **Store unit tests** (`src/service/agents/store.test.ts`): drop `isBuiltin`/overlay
  assertions; add `seedDefaultAgents` writes one `AGENT.md` per def and is a no-op when
  the dir already has agents; `list`/`get` are pure-disk.
- **Seed-on-init**: empty dir → all defaults written; non-empty dir → no seeding
  (user deletions persist).
- **Company self-heal** (`manager` test, extend `builtins.company.test.ts` or a new
  test): delete the `ceo` (and `pm`) from disk, run `startCompany`, assert the roles are
  re-seeded to disk and `get('ceo')` resolves to the CEO def (not `default`).
- **spawnResident warn**: when `get` returns undefined, a `warn` is logged and the run
  falls back to `DEFAULT_AGENT_DEF` (assert via logger spy or behavior).
- **Detail drawer** (`agent-detail.test.tsx` / org-tree-view test): clicking an agent
  opens the sheet with its name/prompt; closing clears selection. Update any test that
  asserted inline detail rendering.
- Existing company e2e/startup tests updated for the renamed export and pure-disk store.

## Risks / Notes

- Tests and scripts importing `builtinAgents` will break on the rename → mechanical
  update to `defaultAgents` and the new path.
- `AgentListItem.builtin` removal touches the preload/renderer types — confirm no other
  consumer reads `.builtin`.
- Seeding writes to `userData` on first run; ensure it runs once and is resilient to a
  partially-seeded dir (treat "has any `*/AGENT.md`" as already-initialized).
