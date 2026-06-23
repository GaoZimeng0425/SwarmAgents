# Role-Based Agent Discovery (Receptionist Pattern)

**Date:** 2026-06-23
**Scope:** `src/service` (+ one shared type in `src/shared/types/agent.ts`, builtin agent prompts in `src/shared/agents/builtins.ts`). Session-local only.

## Problem

Agents cannot discover their peers at runtime. The only way one agent reaches
another is to already know a name — and the built-in "software company" preset
hardcodes those names in its prompts (`COMPANY_ROLES = ['ceo','pm','engineer','reviewer']`,
seeded as actors whose `name` equals the agent-def id, with CEO/PM prompts saying
`send_and_wait("pm", …)` / `send_and_wait("engineer", …)`). This couples
collaboration to fixed identities: a PM can only delegate to a teammate literally
named `engineer`. There is no "who can do X?" query.

## Goal

Introduce **capability/role-based service discovery** — the actor *Receptionist*
pattern (cf. Akka Typed `Receptionist`, OTP `pg`, DNS-SD). An agent asks the
directory "find me an agent with role R / capability C / matching query Q" and
gets back the live peers that match, with their addresses. Collaboration is keyed
on **role**, not on a hardcoded instance name. Then rewrite the company prompts to
use it.

## Non-Goals (deliberately excluded — "best", not "most")

- **No cross-session discovery.** The actor space stays session-scoped; the
  directory only sees the caller's session. (User-confirmed.)
- **No push/subscription, no heartbeat/health, no TTL eviction.** Those belong to
  the async-actor half that the 2026-06 lifecycle review froze as over-engineering.
  Discovery here is a **synchronous pull query** over already-authoritative state —
  it unfreezes nothing.
- **No second source of truth.** The directory is a *projection/query layer* over
  existing state (the `actors` table = membership, `residentHandles` = liveness,
  the agent store = role/capabilities/description). Actors are NOT registered into a
  separate registry; "registration" remains the existing actor creation.

## Design

### 1. Data model — `AgentDefinition` gains discoverable attributes

`src/shared/types/agent.ts`:
- `role: string` — the discoverable role handle, distinct from the per-instance
  `name`. Optional in the schema (no cross-field zod default); when unset, the
  directory treats the agent's `id` as its role (see §2 resolution). Builtins set
  it explicitly (= their id).
- `capabilities: string[]` — optional capability tags for finer queries. Builtins
  populate real values (see §5), so the field is never dead weight. `description`
  (already trigger-first prose) remains the natural-language match source.

### 2. `directory/` — a new feature slice (the Receptionist)

New slice `src/service/directory/` with `receptionist.ts` + `receptionist.test.ts`,
mirroring the single-file slice convention (`cron/scheduler.ts`, `memory/store.ts`).

```ts
export type PeerQuery = { role?: string; capability?: string; query?: string }

export type Peer = {
  name: string | null
  address: string
  role: string
  capabilities: string[]
  description: string
  status: 'active' | 'dormant'
}

export type AgentDirectory = {
  /** Live peers in `sessionId` matching `q`, ranked best-first, excluding `selfAddress`. */
  find(sessionId: string, q: PeerQuery, selfAddress?: string): Peer[]
}

export function createAgentDirectory(deps: {
  listActors(sessionId: string): Actor[]            // = store.listActorsForSession
  isLive(address: string): boolean                  // = residentHandles.has(address)
  getAgentDef(agentDefId: string): AgentDefinition | undefined  // = agentStore.get
}): AgentDirectory
```

Pure and accessor-injected → unit-testable with no DB and no live loops.

**Resolution per actor:** `role` / `capabilities` / `description` come from
`getAgentDef(actor.agentDefId)` (falling back to `agentDefId` for role and `[]` /
`''` when no def). `status` = `isLive(actor.address) ? 'active' : 'dormant'`.
`selfAddress` is excluded.

**Filtering + ranking (deterministic, no embeddings):**
1. If `q.role` is set, keep only peers whose `role === q.role`.
2. If `q.capability` is set, keep only peers whose `capabilities` include it.
3. Score each surviving peer for ordering:
   - exact `role` match (when `q.query` names a role) → highest band;
   - token-overlap of `q.query` against `role + name + capabilities + description`
     (lowercased, whitespace-tokenized) → score = number of overlapping tokens;
   - no `q.query` → score 0, preserve insertion order (creation order from the store).
4. Sort by (active-before-dormant, then score desc, then name asc) for stable output.
   Empty query `{}` → every live peer, active first. (This is the `list_agents`
   degenerate case — no separate tool needed.)

### 3. Store — `listActorsForSession`

`src/service/conversation/store.ts`: add
`listActorsForSession(sessionId: string): Actor[]` →
`SELECT * FROM actors WHERE session_id = ? ORDER BY created_at`, reusing the existing
`idx_actors_session_name` index, mapped through the existing row→Actor mapper. Add to
the `ConversationStore` interface.

### 4. Wiring — mirror the existing messaging path

- **`session/manager.ts`:** construct one `AgentDirectory` via `createAgentDirectory`
  with `listActors = store.listActorsForSession`, `isLive = (a) => residentHandles.has(a)`,
  `getAgentDef = (id) => cfg.agentStore?.get(id)`. Pass a `findPeers(q)` closure into
  `AgentRunnerDeps` for each run (bound to that run's `sessionId` + `selfAddress`).
- **`session/agent-runner.ts`:** `AgentRunnerDeps` gains
  `findPeers?(q: PeerQuery): Peer[]`; `buildToolContext` exposes
  `ctx.findPeers = (q) => deps.findPeers?.(q) ?? []`.
- **`tools/registry.ts`:** `ToolRunContext` gains `findPeers(q: PeerQuery): Peer[]`.
- **`tools/messaging.ts`:** add `findAgentsSpec()` — group `agent`, risk `low`. Tool
  `find_agents({ role?, capability?, query? })` returns the ranked peers formatted as
  readable lines:
  `- <name> (role <role>) · <address> · <status> · <description>`
  (capabilities appended when present). Registered in `tools/builtins.ts`
  `registerBuiltinTools`. Reachable by every scope that has `agent.*` (all/web/fs/memory),
  same as `send_message`; `researcher` (peekaboo) stays excluded by design.

Messaging is unchanged: `find_agents` returns an **address**, which the agent passes
to the existing `send_message`/`send_and_wait`. Discovery and delivery stay as separate,
composable steps (no role-overloading of `send`, which would reintroduce
"which engineer?" ambiguity).

### 5. Rewrite the company prompts (`src/shared/agents/builtins.ts`)

Set explicit `role` (= id) and real `capabilities` on the builtins, e.g.:
- `ceo` — caps `['delegation','summary']`
- `pm` — caps `['planning','coordination']`
- `engineer` — caps `['code','tests','shell']`
- `reviewer` — caps `['review','verify']`
- `researcher` — caps `['observe','read-only']`; `executor` — caps `['ui','click','type']`;
  `default` — caps `[]`.

Rewrite CEO and PM prompts to discover by role instead of naming teammates:
- **CEO:** "Use `find_agents({ role: 'pm' })` to locate the project manager, then
  `send_and_wait(<its address>, <goal + constraints>)`."
- **PM:** "Use `find_agents({ role: 'engineer' })` and `find_agents({ role: 'reviewer' })`
  to locate your engineer and reviewer, then delegate via `send_and_wait(<address>, …)`;
  run the fix/review loop (≤10 rounds) against the discovered addresses."

`COMPANY_ROLES` seeding in `startCompany` is unchanged — all four roles are still
pre-seeded as live actors, so discovery finds them immediately. Only the *addressing
mechanism* in the prompts changes (role lookup, not literal name).

## Testing

- **`directory/receptionist.test.ts`** (the core): role filter; capability filter;
  query token-overlap ranking; `active` vs `dormant` from `isLive`; self-exclusion;
  empty query returns all (active first); unknown `agentDefId` falls back to
  role=agentDefId / caps=[] / desc=''.
- **`conversation/store.test.ts`**: `listActorsForSession` returns a session's actors
  in creation order and excludes other sessions'.
- **`tools/messaging.test.ts`**: `find_agents` formats the directory output; empty
  result yields a clear "no matching agents" message; args pass through to `findPeers`.
- **Behavior preservation:** full `npm test` stays green. The four `e2e/` company
  tests mock the agent-runner (they don't read prompts), so the prompt rewrite does
  not change their outcome; they remain the regression guard for the messaging path.
- **Honest limitation:** the real-LLM effect of the rewritten prompts (CEO/PM actually
  calling `find_agents`) cannot be asserted in unit tests; it is verified by a manual
  run. The spec records this rather than pretending coverage.

## Verification

1. `npm run typecheck` — 0 errors.
2. `npm test` — all prior tests pass (572) plus the new suites; count rises, 0 failures.
3. `git diff` — changes confined to: `shared/types/agent.ts`, `shared/agents/builtins.ts`,
   `service/directory/*`, `service/conversation/store.ts`, `service/session/manager.ts`,
   `service/session/agent-runner.ts`, `service/tools/registry.ts`,
   `service/tools/messaging.ts`, `service/tools/builtins.ts`.
