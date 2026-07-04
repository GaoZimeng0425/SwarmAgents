# Run-Engine Rewrite — Design

**Date:** 2026-07-04
**Status:** Approved (user reviewed §1–§8 in full)
**Supersedes at switchover:** the execution half of `service/session/manager.ts` + `agent-runner.ts`; the actor/resident/company-via-actors runtime; the `task.*` wire vocabulary.
**Relates to:** the 7-spec runner/task decoupling trail (2026-07-02 → 2026-07-04). This design keeps that redesign's end state (runs as event streams, one `run_events` table, agent-driven verify) and replaces its leftover execution plumbing with a new module.

## 1. Motivation

A 5-agent code survey (runner core, session manager, delegation tools, specs-vs-reality, cross-cutting audit) produced 68 evidenced findings. They cluster into:

1. **Split vocabulary.** The Task table/type is gone (4b), but every wire event is `task.*`, the correlation key is `taskId`, one ULID has four names (`turnId`/`runId`/`childRunId`/`correlationId`), and the runner deliberately aliases its RunContext local back to `task` (agent-runner.ts:566-568).
2. **The goal round-trip.** Callers bake the goal as the last `initialMessages` user turn; `run()` re-extracts it by position heuristic, slices it off the seed, and pi's `prompt()` re-appends it (agent-runner.ts:584-591, 1223-1232). Two hotfix commits in one day (2890285, 7452dba); a non-string user tail silently degrades to `goal=''`.
3. **Four near-duplicate launch paths** (`submitGoal`'s runTurn, `runTaskTurn`, `spawnChild`'s startChild, `spawnResident`) each hand-assemble ~30 deps lines; the shared helper is used by one of them. Tool capability drifts per path: `send_message` silently fakes success outside residents (agent-runner.ts:315-317), `set_delegation_plan` errors for resident Leaders — the tool's designed user (delegation-plan.ts:83), `ctx.createTask` is wired only for conversation turns.
4. **Concrete behavior bugs** (see §7 ledger): aborted runs double-emit terminals; `task.complete` payload shape mismatch leaves `RunRecord.summary` permanently empty; gmail-analyze crashes on `task.attachments!.map`; spawnChild abort-registration race; constructible CEO→Leader→IC slot-pool deadlock; child failure status discarded.
5. **Structure and dead weight.** `buildAgentSession` is ~580 lines with a ~215-line `promptOnce` closure and shared mutable locals; `budget.tokens` is configured but never enforced; `toolScope` collapses to `*` for everything but authoring; ~300 lines of frozen actor/company machinery reachable only through half-wired entry points; EventBus has zero production users.

## 2. Decisions

- **D1 — Delete the resident/actor half.** All multi-agent work runs as one-shot spawn trees. Rationale: matches the 2026-06 architecture review ("actor is over-engineering; freeze the async half"); `startCompany` has no production caller; the actor path is the root of the largest weirdness cluster. Teams/company remain a *feature*, re-based onto delegate trees (agentType selects the role).
- **D2 — Rewrite, not layered surgery.** Build a new `service/run-engine/` module and port behavior into it; switch consumers once; delete the old code. Chosen by the user over a 5-phase in-place refactor.
- **D3 — No runtime flag.** Single-user desktop app; a flag means maintaining two engines. The "switch" is one atomic PR (rewire dispatcher/index/tools + delete old files + DB migration on the same branch).
- **D4 — Explicit prompt/history contract.** Deps carry `prompt: string` and `history: AgentMessage[]` separately. This deliberately reverts 4c's "fold goal into initialMessages" (the unification was cosmetic: pi requires a separate prompt argument, so 4c bought a fragile pack/unpack dance).
- **D5 — Full `task.*` → `run.*` wire rename with history migration.** Old persisted events are rewritten by SQL at schema bootstrap; old sessions stay renderable (we do NOT take the "disposable history" escape hatch this time).
- **D6 — Tool surface rename.** `create_task` → `delegate` (`topLevel?: boolean`); delete `wait_for_task`, `send_message`, `send_and_wait`, `whoami`; `find_agents` re-reads agent definitions (team/teamRole filters) instead of actor rows.

## 3. Architecture

```
apps/desktop/src/service/run-engine/
├─ launch.ts      launchRun(spec, ports) — the ONLY way any run starts
├─ engine.ts      pi Agent wrapper: construction, iteration cap, budget/context/permission gates
├─ retry.ts       model-chain fallback + transient-retry policy (pure, unit-testable)
├─ translator.ts  pi AgentEvents → run.* emits (captures stopReason 'error' AND 'aborted')
└─ emit.ts        single-mode emit factory: seq stamp → run_events append → terminal registry → broadcast
```

**Boundary.** run-engine owns everything from a `launchRun()` call to the terminal event. It does not know about sessions-as-UI-objects, queues, or IPC.

**Ports (injected into `launchRun`):** store (run_events append, snapshot save), permissionRegistry, toolRegistry, terminalRegistry, broadcaster, model/provider resolution, budgets. `SessionService` binds the standard ports. `gmail/analyze` binds its own emit port and calls the same `launchRun` — no more hand-assembled deps literals.

**SessionService** (`service/session/`, slimmed from today's manager): owns the `sessions` table CRUD, the per-session message buffer + `agent_snapshot` persistence, the per-session FIFO turn queue, and the IPC-facing method surface (`createSession`, `submitGoal`, `cancelRun`, `interruptWith`, `deleteSession`, metadata methods, `listSessions`, `getRunEvents`, `getUsageStats`, `markInterruptedRunsTerminal`, `ensureSystemSession`). Every execution request becomes a `launchRun` call. `reply-registry` is deleted with the actors; `seq-counter` moves into `emit.ts`.

**RunSpec** (declarative — three run kinds are spec values, not code paths):

```ts
interface RunSpec {
  kind: 'turn' | 'work' | 'child'
  sessionId: string
  agent: ResolvedAgentDefinition
  prompt: string                 // explicit; engine calls pi prompt(prompt)
  history: AgentMessage[]        // seed only; never contains the prompt
  attachments?: Attachment[]     // defaults to []
  budget: ResourceBudget         // main for turn/work, sub for child
  parentRunId?: string           // child only
  tools?: string[]               // optional allowlist narrowing
}
```

Kind-specific behavior is declared in one table inside `launch.ts`: `turn` → queued via SessionService pump, snapshot saved per turn; `work` → top-level card, main budget, no snapshot; `child` → nested card (`parentRunId`), sub budget. Everything else (runId mint, `run.created`/`run.dispatched` emits, abort registration, slot acquisition, deps assembly, terminal classification, cleanup) is identical shared code.

## 4. Run contract & concurrency

- **Seeding:** engine seeds pi with `history`, then calls `prompt(prompt, images)`. No extraction, no slicing, no positional heuristics. `attachments` defaults to `[]` (kills the `attachments!` crash class).
- **Uniform tool wiring:** the tool context is assembled in `launch.ts` once, identically for every kind. `delegate` is available in all runs. `setDelegationPlan` is wired in all runs (emit moves from the `run()` wrapper into launch). `writeAgent`/`writeSkill` remain gated by the training-team allowlist, but the gate is data (allowlist), not which code path built the run.
- **Child results:** `delegate` returns `{ status: 'completed' | 'failed' | 'cancelled', summary: string }`. Parents can distinguish a failed child's partial prose from a deliverable. Prompts (COORDINATION_PROTOCOL) updated to reference `status`.
- **Concurrency:** a parent blocking on `delegate` **releases its slot** for the duration of the await and reacquires it before resuming. Fan-out at any depth can no longer starve the pool (kills the CEO→Leader→IC deadlock by construction). Abort handles are always registered BEFORE slot acquisition (today only 2 of 3 paths do this).
- **Terminal classification:** exactly one `terminalStatusFor(event)` rule lives in `packages/protocol` and is imported by emit.ts and the renderer reducer; the store's boot-scan SQL CASE is asserted equivalent to it by a unit test (TS is the single source of truth). Today's three hand-synced copies already drifted once (manager.ts:875-880).
- **Recovery:** with actors gone, the redrain pass disappears; boot recovery is the single `markInterruptedRunsTerminal` sweep (the 4b ordering hole — redrain flipping sessions `active` before the sweep filters on `interrupted` — is deleted, not fixed). `getInterruptedSessions` is renamed `markInterruptedSessions` and its caller's redundant re-write loop removed.
- **Model fallback:** `contextWindow` and any per-model value are read from the *current* chain entry, not frozen at session construction.

## 5. Wire protocol v2

- **Event kinds:** `run.created`, `run.dispatched`, `run.progress`, `run.tool_call`, `run.permission_request`, `run.complete`, `run.error`, `run.usage`, `run.plan`, `run.delegation_plan`, `run.spawned` (replaces `task.handoff.spawned`; `task.handoff.completed` is dropped — terminal events carry the linkage via `parentRunId`).
- **Payload keys:** `taskId`/`parentTaskId` → `runId`/`parentRunId`. `workerId` dropped. `seq`/`ts` stamped exactly once, by emit.ts; emit does not mutate caller objects.
- **`run.complete` shape:** flat `{ runId, summary, ts, seq }` — matches the protocol type and the reducer (kills the forever-empty summary).
- **IPC/API:** `swarm:cancelTask` → `swarm:cancelRun`; `SubmitGoalResult.taskId` → `runId`; protocol types `TaskOptions`/`TaskResult` → `RunOptions`/`DelegateResult`. `submitGoal` keeps its name (it submits a goal; that was never the confusing part).
- **Renderer rename scope (sized by inventory):** `apply-event.ts` reducer + `RunRecord`, `use-tasks.ts` (`RUNS_KEY`), `use-events-subscription.ts`, ~8 lib modules (`task-segments`, `build-timeline-items`, `composer-turns`, `minimap-items`, `session-usage`, `scheduled-rows`, `choice-notification`, `api.ts`), ~12 components, 4 protocol files. Internal identifiers follow (`useTasks` → `useRuns`, etc.).
- **DB migration:** at schema bootstrap, one idempotent SQL pass over `run_events` rewrites `$.kind` (`task.X` → `run.X`, `task.handoff.spawned` → `run.spawned`) and renames `$.taskId`/`$.parentTaskId` keys via `json_remove`+`json_set`. Guarded by a `schema_meta` version so it runs once. Verified against a fixture copy of a real dev DB.

## 6. Deletion inventory

**Actor/resident half:** `runResident`, `ResidentHooks`, mailbox module, actor state codecs, `spawnResident`, `sendMessage`, `redrainAddress`, `ensureActor`, `resolveAddress`, `startCompany`, `endSession`, `deliverToActor`, `reply-registry.ts`, `residentHandles`, `__ensureActorForTest`/`__sendMessageForTest` hooks.
**Storage:** `actors`, `messages`, `task_waiters` tables (DROP at bootstrap) + their store methods (`upsertActor`…`bumpRetries`, `saveTaskWaiter`…`deleteTaskWaiter`) and the already-dead `markConsumed`/`nextUnconsumedFor`.
**Services/tools:** `loop/task-waiters.ts`, `wait_for_task`, `send_message`, `send_and_wait`, `whoami`, `shared/events.ts` EventBus, `scripts/smoke-company.ts` (already broken import), actor/company e2e tests (rewritten as delegate-tree e2e). `registerTerminalListener` + the terminal registry's single-listener slot go with task-waiters (its only production registrant, index.ts:114); cron's `isTerminal`/`getStatus` queries and `submitGoal`'s `onComplete` remain the supported completion signals.
**Dead knobs:** `ResourceBudget.tokens` (removed from schema, defaults, and UI), `toolScope` (replaced by a boolean authoring gate), `ToolRunContext.send`, `workerId`.
**Prompts:** CEO/Leader prompts rewritten — remove `send_and_wait` instructions, the ghost `spawn()` reference (agents.ts:42), and the contradictory dual delegation mechanisms; one mechanism remains: `delegate` trees + `set_delegation_plan` declaration. `find_agents` documentation updated to definition-based discovery.

## 7. Bug ledger (fixed by construction unless noted)

| # | Bug (evidence) | Fix locus |
|---|---|---|
| 1 | Aborted runs double-emit `task.complete` then `task.error`; live registry says completed, replay says cancelled (translator matches only stopReason `'error'`) | translator.ts captures `'aborted'`; single terminal emit per run, asserted by test |
| 2 | `task.complete` nests summary under `result.*`; protocol/reducer expect flat → summary never renders (agent-runner.ts:525 vs ui.ts:103) | wire v2 flat shape; translator tests use REAL emitted payloads |
| 3 | gmail-analyze crashes: `task.attachments!.map` on undefined (agent-runner.ts:1208) | `attachments` defaults `[]`; gmail uses `launchRun` (also hotfixed in W0) |
| 4 | spawnChild registers abort handle AFTER slot acquisition — cancel during queue wait no-ops (manager.ts:592-594) | launch.ts single ordering: register → acquire |
| 5 | CEO→Leader→IC fan-out deadlocks the slot pool (parents hold slots while awaiting children) | slot released during `delegate` await |
| 6 | Child failure status discarded; parent gets partial prose as if delivered (manager.ts:621, 640) | `DelegateResult.status` |
| 7 | Recovery ordering hole: redrain flips sessions `active` before orphan sweep filters `interrupted` (manager.ts:663 vs 851) | redrain deleted with actors |
| 8 | `session.contextWindow` frozen at primary model; stale after fallback (agent-runner.ts:1196) | read from current chain entry |
| 9 | Terminal-status rule hand-copied in TS/SQL/reducer; already drifted once | single `terminalStatusFor` in protocol |
| 10 | `getInterruptedSessions` mutates as a getter; caller re-applies the same write (store.ts:426-430, manager.ts:263-265) | renamed, redundant loop removed |
| 11 | `send_message`/`send_and_wait` fake success outside residents | tools deleted (D1) |
| 12 | `set_delegation_plan` unavailable exactly for resident Leaders | uniform wiring + residents deleted |
| 13 | emit factory dual-mode + mutates caller payload + double `ts` (manager.ts:293-323) | emit.ts single mode, no mutation |
| 14 | `budget.tokens` accepted, never enforced | knob deleted |

## 8. Delivery plan

- **W0 (hotfix, ships first, old engine):** three surgical fixes on develop via worktree — gmail `attachments` crash, translator `'aborted'` capture (double-terminal), `task.complete` flat-summary shim at the emit site. Keeps production usable while the rewrite proceeds.
- **W1:** `packages/protocol` v2 types (`run.*`, `RunRecord` keys, `terminalStatusFor`) + run-engine skeleton (`emit.ts`, `translator.ts`, `retry.ts`) with unit tests. New code is unused by the app at this point.
- **W2:** `engine.ts` + `launch.ts` — port gates (iteration cap, budget, context, permission), retry/fallback, cancel semantics; port the existing agent-runner behavior tests over to the new units.
- **W3:** SessionService rewrite on top of `launchRun`; actor-half deletion (code, tables, tools, prompts); `delegate`/`find_agents` rework; dispatcher/index rewiring behind the still-unswitched surface.
- **W4:** renderer + IPC rename, DB migration, e2e rewrite (company scenario as delegate tree), the atomic switchover commit (old `agent-runner.ts`/manager execution half deleted), full `npm test` + run-desktop smoke.

Each W# is its own worktree/branch, integrated via rebase onto develop + ff-only merge (house rule). W1–W4 are sequential; W0 is independent and lands immediately.

## 9. Testing

- **Unit:** retry.ts pure tests (chain walk, permanent-failure short-circuit, abort during backoff); translator tests fed real pi event fixtures, asserting exactly one terminal emit and wire-v2 shapes; launch tests for abort-before-slot, slot release during delegate, status propagation, kind table behavior.
- **Migration:** fixture DB with pre-v2 `task.*` rows → bootstrap → assert renderable `run.*` rows and idempotency on second boot.
- **Regression:** deadlock test with fan-out ≥ maxConcurrent at depth 3; summary-renders test through the real reducer; cancelled-run terminal-consistency test (live registry vs replay).
- **e2e:** delegate-tree company scenario; existing session/permission e2e ported; final gate = full `npm test` (Electron node, house rule) + run-desktop smoke of a real conversation turn with a delegate call.

## 10. Out of scope

- Renderer visual/UX changes (rename-only touches).
- Re-introducing any system-level verify loop (agent-driven verify stands, per 3b).
- A materialized `runs` read-model for usage stats (4b's deferred projection stays deferred; the JSON-extract queries are unchanged).
- Cross-run persistent agent memory (the deleted residency's "cross-turn memory" is not replaced in this design).
