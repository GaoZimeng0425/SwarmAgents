# Run-Engine W3 — SessionService + Actor-Half Deletion Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Delete the resident/actor half from the LIVE app (spec D1), rework `find_agents` to definition-based discovery and rewrite the coordinator prompts onto delegate trees (spec D6 half), and land the new `SessionService` bound to `launchRun` (new code, unused until W4's switchover).

**Architecture:** Per spec `docs/superpowers/specs/2026-07-04-run-engine-rewrite-design.md` §3/§6 and the 2026-06 review ("actor is over-engineering; freeze/delete the async half"). Task 1 is compiler-guided surgery: the mailbox/resident/messaging machinery, its tables, tools, and registries go; the old one-shot manager keeps running conversation turns unchanged. Task 2 re-bases multi-agent coordination onto spawn trees: `find_agents` lists agent DEFINITIONS (id = the `create_task` `agentType`), and every coordinator prompt drops `send_and_wait` for `create_task`. Task 3 builds `session-service.ts` — the W4 replacement for the manager's execution half — binding `launchRun`'s ports to the real store/seq/terminal/broadcaster, a per-session FIFO ticket queue, the global slot pool, and recursive `delegate`.

**Tech Stack:** TypeScript, vitest via Electron-node, pi-agent-core mocked in SessionService tests.

## Global Constraints

- Work in a dedicated worktree on branch `worktree-run-engine-w3`, cut from `develop` AFTER W2 has merged (`launchRun`/`createEngine` must exist on the base; verify `ls apps/desktop/src/service/run-engine/launch.ts` after entering). Integrate via `git rebase develop` + ff-only merge.
- Run tests as `cd apps/desktop && npm test -- <path-filter>` (Electron-node vitest). NEVER `npx vitest`, NEVER pnpm/turbo at the worktree root. Formatting: `./node_modules/.bin/biome check --write <file>` from the worktree root (npx trips the pnpm deps check in worktrees).
- `git add` exact paths; never `git add -A`. Comments/commits in English. No new dependencies.
- Deletion discipline (CLAUDE.md §3): remove exactly the inventoried symbols/files plus whatever YOUR removals orphan (imports, types, tests). Do not refactor surviving code beyond what compilation requires. When a deletion cascades somewhere not inventoried, follow the compiler, and list every extra site in your report.
- The app must stay fully functional on the OLD manager path after Tasks 1-2 (conversation turns, create_task both branches, cron, permissions). The full desktop suite is the gate after every task.
- Wire vocabulary stays `task.*` everywhere in Tasks 1-2 (the rename is W4). The new SessionService (Task 3) speaks `run.*` natively — it is unused by the app until W4.

---

### Task 1: Delete the actor half from the live app

**Files:**
- Delete: `apps/desktop/src/service/actor/mailbox.ts`, `apps/desktop/src/service/actor/state.ts` (whole `service/actor/` dir), `apps/desktop/src/service/session/reply-registry.ts` + `reply-registry.test.ts`, `apps/desktop/src/service/loop/task-waiters.ts`, `apps/desktop/src/service/tools/wait-for-task.ts` + `wait-for-task.test.ts`, `apps/desktop/src/shared/events.ts` + `events.test.ts`, `apps/desktop/scripts/smoke-company.ts`
- Delete (tests pinning the deleted surface): `apps/desktop/src/service/session/manager.actors.test.ts`, `manager.messaging.test.ts`, `manager.resident.test.ts`, `manager.cross-dormancy.test.ts`, `manager.redrain.test.ts`, `manager.deadlock.test.ts`, `apps/desktop/src/service/session/agent-runner.resident.test.ts`, `apps/desktop/src/service/conversation/store.actors.test.ts`, `apps/desktop/src/service/e2e/company.e2e.test.ts`, `apps/desktop/src/service/e2e/multi-team-company.e2e.test.ts`, `apps/desktop/src/service/e2e/company.startup.test.ts` (verify exact e2e filenames with `ls apps/desktop/src/service/e2e/` — delete every test whose subject is startCompany/actors/messaging)
- Modify: `apps/desktop/src/service/session/manager.ts`, `apps/desktop/src/service/session/agent-runner.ts`, `apps/desktop/src/service/session/terminal-registry.ts` + `terminal-registry.test.ts`, `apps/desktop/src/service/tools/registry.ts`, `apps/desktop/src/service/tools/messaging.ts`, `apps/desktop/src/service/tools/builtins.ts` (+ `builtins.test.ts` if it registers deleted specs), `apps/desktop/src/service/run-engine/launch.ts` + `launch.test.ts`, `apps/desktop/src/service/conversation/store.ts`, `apps/desktop/src/service/index.ts`, `packages/protocol/src/types/actor.ts` (+ its index export if emptied), `packages/protocol/src/types/service-ipc.ts` (remove `startCompany`-adjacent methods if present — verify with grep)
- Possibly modify (compiler-driven): any `ToolRunContext` construction in tool tests that passes the removed fields (`sendMessage`/`sendAndWait`/`send`/`selfAddress`) — the earlier inventory lists ~15 tool test files with a shared ctx stub; strip the removed fields from those stubs.

**Interfaces:**
- Consumes: the current live code (this is surgery, not new construction).
- Produces: a live app with NO actor/mailbox/messaging/waiter machinery. Specifically:
  - `ToolRunContext` loses `send`, `selfAddress`, `sendMessage`, `sendAndWait` (registry.ts) — Task 3's SessionService and W2's launch.ts both stop stubbing them.
  - `SessionManager` type loses `startCompany`, `deliverToActor`, `endSession`, `registerTerminalListener`, `__ensureActorForTest`, `__sendMessageForTest`.
  - `TerminalRegistry` loses `onTerminal` (single-listener slot; its only registrant was task-waiters).
  - `ConversationStore` loses `saveTaskWaiter`/`listTaskWaitersForTask`/`listAllTaskWaiters`/`deleteTaskWaiter`/`upsertActor`/`getActor`/`getActorByName`/`listActorsForSession`/`enqueueMessage`/`nextUnconsumedFor`/`allUnconsumedFor`/`listUnconsumedAddresses`/`markConsumed`/`consumeAndPersist`/`markDead`/`bumpRetries`; the `actors`/`messages`/`task_waiters` tables become `DROP TABLE IF EXISTS` statements in the bootstrap block (mirroring the existing legacy-table drops at store.ts:134-140).
  - `AgentRunnerDeps` loses `selfAddress` and `sendMessage`; `agent-runner.ts` loses `runResident`, `ResidentHooks`, and the mailbox/state imports.
  - Tool registration loses `send_message`, `send_and_wait`, `whoami`, `wait_for_task` (`find_agents` SURVIVES — Task 2 reworks it).

- [ ] **Step 1: Inventory-guided deletion in manager.ts**

In `apps/desktop/src/service/session/manager.ts` remove, with their doc comments:
- Imports: `createMailbox`, `decodeActorState`, `createReplyRegistry`, `runResident`, `ResidentHooks`, `ActorMessage` (type). KEEP `createAgentDirectory` (Task 2 reworks its deps).
- Constants: `COMPANY_ROLES`, `IDLE_TIMEOUT_MS`, `MAX_RETRIES`, `RPC_TIMEOUT_MS`.
- State: `residentHandles`, `replyRegistry`.
- The `directory` construction changes in Task 2 — for THIS task, keep it compiling by replacing its deps object with `{ listAgentDefs: () => cfg.agentStore?.list() ?? [] }` ONLY IF you also do Task 2 first — otherwise leave `directory` construction as-is and let Task 2 change it. (Recommended order: do Task 1 exactly as written; the old deps reference `store.listActorsForSession` and `residentHandles` — since both are being deleted, replace the directory construction with the Task-2 form now and adjust `directory.find` call sites from `(sessionId, q, self?)` to `(q)`; Task 2 then only touches receptionist.ts + messaging.ts + prompts.)
- Functions: `ensureActor`, `resolveAddress`, `spawnResident`, `sendMessage`, `redrainAddress`, and the startup redrain loop (`for (const address of store.listUnconsumedAddresses()) …`).
- Public methods: `startCompany`, `deliverToActor`, `endSession`, `registerTerminalListener`, `__ensureActorForTest`, `__sendMessageForTest` — from both the `SessionManager` type and the returned object.
- In `submitGoal`/`runTaskTurn`/`spawnChild` deps: nothing to remove (they never wired `sendMessage`/`selfAddress`) — verify by grep after the type loses the fields.

- [ ] **Step 2: agent-runner.ts + registry.ts + launch.ts surgery**

- `agent-runner.ts`: delete `runResident` and `ResidentHooks` (lines ~1243-1327) and the `IdleTimeoutError, type Mailbox` / `encodeActorState` imports; delete `selfAddress` and `sendMessage` from `AgentRunnerDeps`; in `buildToolContext` delete the `send`, `selfAddress`, `sendMessage`, `sendAndWait` entries. Do NOT touch anything else in the file.
- `tools/registry.ts`: delete the `send`, `requestPermission`? — NO: keep `requestPermission` (still part of the contract); delete exactly `send`, `selfAddress`, `sendMessage`, `sendAndWait` from `ToolRunContext`, and the now-unused `Outbound` import.
- `run-engine/launch.ts`: delete the `send`, `sendMessage`, `sendAndWait` stub lines (and their comments) from the ctx literal. `run-engine/launch.test.ts`: delete the test `'messaging context REJECTS instead of faking success (ledger #11 hardening)'`.
- `tools/messaging.ts`: delete `sendMessageSpec`, `sendAndWaitSpec`, `whoamiSpec` (keep `findAgentsSpec` and its `FindParams`); `tools/builtins.ts`: remove their registrations + the `waitForTaskSpecs` registration and its import + the `taskWaiters` field from its config type (grep `taskWaiters` in builtins.ts).
- `tools/wait-for-task.ts` + test: delete files. `loop/task-waiters.ts`: delete file (the `loop/` dir may retain other files — check `ls`).
- `terminal-registry.ts`: remove `onTerminal` from the type and implementation (the `listener` slot and its invocation in `markTerminal`); update `terminal-registry.test.ts` accordingly (drop listener assertions; keep first-terminal-wins ones).

- [ ] **Step 3: store.ts + protocol + index.ts surgery**

- `store.ts`: replace the `CREATE TABLE IF NOT EXISTS actors …`, `messages …`, `task_waiters …` statements (and their indexes) with three `DROP TABLE IF EXISTS` lines appended to the existing legacy-drop block (`DROP TABLE IF EXISTS task_waiters; DROP TABLE IF EXISTS messages; DROP TABLE IF EXISTS actors;`); delete the 16 interface methods listed in Interfaces plus their implementations and prepared statements; delete the now-unused `Actor`/`ActorMessage`/`StoredTaskWaiter` imports/types. Also delete any `deleteSessionTx` lines touching those tables (grep `actors\|messages\|task_waiters` in store.ts until only the DROP block matches).
- `packages/protocol/src/types/actor.ts`: delete `Actor`, `ActorMessage`, `StoredTaskWaiter` (grep first — `StoredTaskWaiter` may live in another file); KEEP `Peer`/`PeerQuery` (move them into `actor.ts`'s remains or wherever they already live; if the file empties except Peer types, keep the file with just them). Update `actor.test.ts` to only cover what survives (or delete it if it only tested Actor rows).
- `service/index.ts`: remove `createTaskWaiterService` import + the `taskWaiters` construction + `manager.registerTerminalListener(…)` + `taskWaiters.start()` (KEEP `manager.markInterruptedRunsTerminal()`), and the `taskWaiters` entry in `registerBuiltinTools`.
- `packages/protocol/src/types/service-ipc.ts` + `service-client.ts`: grep `startCompany|deliverToActor|endSession` — remove any method entries found (the earlier inventory says the dispatcher never exposed them, but the protocol may declare them).
- `shared/events.ts` + test, `scripts/smoke-company.ts`: delete files.

- [ ] **Step 4: Test-suite reconciliation**

Delete the test files listed under **Files**. Then fix compilation of the surviving tool tests: the shared ctx stubs (e.g. `tools/shell.test.ts:9` and ~14 siblings) pass `sendMessage`/`sendAndWait`/`send`/`selfAddress` — strip those fields. `manager.test.ts` and `manager.turnslot.test.ts` survive but may reference deleted methods (`endSession` in dispatcher.test mocks, `deps.emit` fixtures are fine) — follow the compiler. `dispatcher.test.ts`: remove `endSession` from its manager mock if present.

- [ ] **Step 5: Gates**

```bash
cd apps/desktop && npm test -- src/service src/shared
```
Expected: all green (the deleted tests are gone; every surviving suite passes).
```bash
grep -rniE "mailbox|runResident|send_and_wait|sendAndWait|wait_for_task|task_waiters|startCompany|deliverToActor|redrain|replyRegistry|selfAddress" apps/desktop/src packages/protocol/src --include="*.ts" | grep -v "\.claude"
```
Expected: no hits (report any residual with justification — e.g. a historical comment is acceptable ONLY in docs/, not in src/).
Then the full desktop suite: `npm test` (from apps/desktop) — expected green.
Typecheck: `npx tsc --noEmit -p tsconfig.node.json --composite false && npx tsc --noEmit -p tsconfig.web.json --composite false` (from apps/desktop) — expected clean.

- [ ] **Step 6: Format and commit**

Format every modified file with `./node_modules/.bin/biome check --write <files>`. Then commit with exact paths (list every deleted/modified file in `git add`; `git add` handles deletions of tracked files when given their paths):

```bash
git commit -m "refactor(session)!: delete the resident/actor half (spec D1)

Removes runResident/mailbox/messaging/waiters end-to-end: manager actor
machinery, send_message/send_and_wait/whoami/wait_for_task tools,
actors/messages/task_waiters tables (DROP at bootstrap), reply-registry,
terminal-registry listener slot, EventBus, smoke-company, and the actor
e2e/tests. ToolRunContext loses send/selfAddress/sendMessage/sendAndWait.
Multi-agent coordination re-bases onto create_task trees (prompts in the
follow-up commit). The one-shot conversation path is untouched."
```

---

### Task 2: Definition-based `find_agents` + coordinator-prompt rewrite

**Files:**
- Modify: `apps/desktop/src/service/directory/receptionist.ts` (+ `receptionist.test.ts` if present — check `ls apps/desktop/src/service/directory/`), `apps/desktop/src/service/tools/messaging.ts` (findAgentsSpec description), `apps/desktop/src/service/session/manager.ts` (directory wiring, if not already adjusted in Task 1), `packages/shared/src/constants/agents.ts`

**Interfaces:**
- Consumes: `AgentDefinition` list from the agent store (`cfg.agentStore.list()`).
- Produces: `createAgentDirectory(deps: { listAgentDefs(): AgentDefinition[] }): AgentDirectory` with `find(q: PeerQuery): Peer[]` — `Peer.address` is now the DEFINITION ID (the value to pass as `create_task`'s `agentType`), `status` is always `'active'`, name/role/capabilities/description/team/teamRole come from the def. Ranking logic (token scoring, exact-role boost) is unchanged.

- [ ] **Step 1: Rework receptionist.ts**

Replace the deps + `toPeer` of `createAgentDirectory`:

```ts
export type AgentDirectory = {
  /** Agent definitions matching `q`, ranked best-first. `address` is the definition id — pass it as create_task's agentType. */
  find(q: PeerQuery): Peer[]
}

export function createAgentDirectory(deps: { listAgentDefs(): AgentDefinition[] }): AgentDirectory {
  const toPeer = (def: AgentDefinition): Peer => ({
    name: def.name,
    address: def.id,
    role: def.role ?? def.id,
    capabilities: def.capabilities ?? [],
    description: def.description ?? '',
    status: 'active',
    team: def.team,
    teamRole: def.teamRole,
  })
  // scoreOf unchanged (verbatim from the current file)
  return {
    find(q) {
      let peers = deps.listAgentDefs().map(toPeer)
      if (q.role) peers = peers.filter((p) => p.role === q.role)
      if (q.capability) peers = peers.filter((p) => p.capabilities.includes(q.capability as string))
      if (q.team) peers = peers.filter((p) => p.team === q.team)
      if (q.teamRole) peers = peers.filter((p) => p.teamRole === q.teamRole)
      return peers
        .map((p) => ({ p, score: scoreOf(p, q.query) }))
        .sort((a, b) => (b.score !== a.score ? b.score - a.score : (a.p.name ?? '').localeCompare(b.p.name ?? '')))
        .map((s) => s.p)
    },
  }
}
```

In `manager.ts`, wire `const directory = createAgentDirectory({ listAgentDefs: () => cfg.agentStore?.list() ?? [] })` and change all `directory.find(sessionId, q, …)` call sites to `directory.find(q)`. NOTE: if `cfg.agentStore.list()` returns `AgentListItem[]` (a slim projection) rather than full defs, adapt the deps type to the projection — it carries id/name/description/team/teamRole/role/capabilities; verify against `service/agents/store.ts` and report which shape you used.

- [ ] **Step 2: findAgentsSpec description rewrite (messaging.ts)**

Replace the `find_agents` description and line format so it teaches delegation, not messaging:
- description: `'Discover the agent types available for delegation, filtered by role, team, or free-text query. Each result's id is the agentType to pass to create_task. Call with no arguments to list everyone.'`
- The per-peer line drops the address/status vocabulary: `` `- ${p.address} — ${p.name ?? p.address} (role ${p.role})${team} · ${p.description}${caps}` `` where `team` is the existing team suffix. Update `FindParams`'s `teamRole` doc to mention "head" = each team's coordinating Lead.

- [ ] **Step 3: Prompt rewrite (packages/shared/src/constants/agents.ts)**

Apply these EXACT text replacements (each old fragment appears exactly once):
1. CEO step 3: `delegate with full context: send_and_wait(<head address>, <the goal plus any constraints>)` → `delegate with full context: create_task({ goal: <the goal plus any constraints>, agentType: <the head's id from find_agents> })`
2. ENGINEERING_LEAD: `send_and_wait(<engineer address>, <the concrete task, including the working directory to use>)` → `create_task({ goal: <the concrete task, including the working directory to use>, agentType: <the engineer's id> })`; `request a review: send_and_wait(<reviewer address>, <what to review and the artifact location>)` → `request a review: create_task({ goal: <what to review and the artifact location>, agentType: <the reviewer's id> })`; and in its discovery lines `Take the first result's address for each and message that address.` → `Take the first result's id for each — that id is the agentType you delegate to.`
3. ENGINEER: `you may delegate throwaway pieces with spawn().` → `you may delegate throwaway pieces with create_task (default spawn path).`
4. TRAINING_HEAD step 3: `send_and_wait(<author address>, <exact agent/skill specs: …>)` → `create_task({ goal: <exact agent/skill specs: …>, agentType: <the author's id> })`
5. PRODUCT_LEAD: `send_and_wait(<analyst address>, <the goal plus any known constraints, asking for users, requirements and risks>)` → `create_task({ goal: …same payload…, agentType: <the analyst's id> })`; `Take the first result's address and message it.` → `Take the first result's id — that is the agentType you delegate to.` (this "Take the first result's address and message it." line appears in SIX lead prompts — replace ALL occurrences identically; use replace-all)
6. DESIGN_LEAD / QA_LEAD / OPS_LEAD / DOCS_LEAD / SECURITY_LEAD / DATA_LEAD: replace each `send_and_wait(<X address>, <payload>)` with `create_task({ goal: <payload>, agentType: <the X's id> })` (six sites, one per prompt).
7. LEADER_DELEGATION_ADDENDUM final bullet: `- For the DAG pipeline above, use create_task without asTopLevel (it enables parallel dispatch); for a simple linear handoff (e.g. the dev team's engineer→reviewer loop) send_and_wait is fine. Reserve create_task with asTopLevel: true for substantial work you will own and do yourself.` → `- Always delegate via create_task without asTopLevel (it enables parallel dispatch; linear handoffs are just sequential create_task calls). Reserve create_task with asTopLevel: true for substantial work you will own and do yourself.`
8. CEO_SYSTEM_PROMPT workflow line 2 keeps find_agents discovery; verify no other `send_and_wait`/`send_message`/`whoami`/`address` coaching remains: `grep -n "send_and_wait\|send_message\|whoami" packages/shared/src/constants/agents.ts` → no hits; `grep -n "address" packages/shared/src/constants/agents.ts` → only hits inside the replaced "id" phrasing should be gone too — rephrase any leftover `<… address>` to `<… id>`.

- [ ] **Step 4: Gates, format, commit**

`cd apps/desktop && npm test -- src/service` → green. `grep` gates from Step 3.8 clean. Format touched files. Commit:

```bash
git commit -m "refactor(agents): definition-based find_agents + delegate-tree prompts

find_agents now lists agent DEFINITIONS (id = create_task agentType,
always active) instead of actor rows; receptionist drops the
actor/liveness deps. Every coordinator prompt (CEO, 8 team leads,
training head, engineer's spawn() ghost, Leader addendum) delegates via
create_task instead of send_and_wait addresses."
```

---

### Task 3: `session-service.ts` — the new session host on `launchRun`

**Files:**
- Create: `apps/desktop/src/service/session/session-service.ts`
- Create: `apps/desktop/src/service/session/session-service.test.ts`

**Interfaces:**
- Consumes: `launchRun`/`RunSpec`/`LaunchPorts`/`DelegateResult` from `../run-engine/launch`; `RunEmitPorts` from `../run-engine/emit`; `createSeqCounter`, `createTerminalRegistry`, `createPermissionRegistry` (existing modules); `ConversationStore`, `Broadcaster`, `AgentStore`, `SkillStore`, tool registry; `withSkills`/`withAgentTypes` prompt composition; `applyAgentModel`, `DEFAULT_AGENT_DEF`, `SYSTEM_SESSION_ID`, `allowlistForAgent`, `defaultBudgetConfig`.
- Produces (the W4 dispatcher binds to this):

```ts
export type SessionService = {
  createSession(provider: ProviderInjection): { sessionId: string }
  ensureSystemSession(fromSessionId: string): string
  submitPrompt(
    sessionId: string,
    prompt: string,
    attachments?: Attachment[],
    onComplete?: (status: 'completed' | 'failed' | 'cancelled', error?: string) => void,
    options?: TaskOptions
  ): { runId: string }
  runWork(sessionId: string, goal: string, options?: TaskOptions): Promise<{ runId: string; status: string; summary: string }>
  resolvePermission(sessionId: string, actionId: string, decision: PermissionDecision): void
  cancelRun(sessionId: string, runId: string): void
  interruptWith(sessionId: string, runId: string): void
  deleteSession(sessionId: string): void
  renameSession/setSessionPinned/updateSessionSettings/reorderSessions/listSessions/getRunEvents/getUsageStats  // store passthroughs, same shapes as the manager's
  terminalRegistry: TerminalRegistry
  markInterruptedRunsTerminal(): void
}
export function createSessionService(cfg: SessionServiceConfig): SessionService
```
(`SessionServiceConfig` mirrors `SessionManagerConfig`: store, broadcaster, maxConcurrent, getProvider, toolRegistry?, skillStore?, agentStore?, getBudgetConfig?, isSkillEnabled?.)

- Behavior contract:
  - ONE emit-port adapter: `nextSeq` → shared seq counter; `appendEvent(evt)` → `store.appendRunEvent(evt.sessionId, evt.runId, evt.parentRunId ?? null, evt as unknown as UIEvent)` (the cast is transitional — W4 widens the store's event type to the run.* union); `markTerminal` → the registry; `broadcast(evt)` → `broadcaster.broadcast(evt.kind, evt)`.
  - Per-session FIFO via `waitTurn`: `submitPrompt` calls `launchRun` IMMEDIATELY (so `run.created` renders as a pending card) with a `waitTurn` port backed by a ticket queue; the service tracks `{ current, queue }` per session, grants the next ticket when the current run's `launchRun` promise settles, and removes an aborted-while-queued run from the queue when its (early) settlement arrives.
  - `cancelRun` = fire the abort registered by launch (`abortRegistry`); no queued-branch needed — launch registers BEFORE its waits, so a queued run cancels cleanly through the same handle (W0/W2 ledger #4 by construction).
  - `interruptWith(sessionId, runId)`: promote the runId's ticket to the queue front, then abort the current run (its settlement grants the promoted ticket). Idle session: the promoted ticket is granted immediately by the same settle→pump path (pump also runs on promote).
  - `delegate` port (bound into every launch): resolve agentType/providerKey exactly like the old `spawnChild` (agent store lookup with default fallback + warn; provider lookup with session fallback + warn; `applyAgentModel`), then a nested `launchRun({ kind: 'child', parentRunId, budget: budgets().sub, tools: suggestedTools ?? allowlistForAgent(def), … })` and return `{ runId, status, summary }` — the child's STATUS survives to the tool layer (spec §4, ledger #6; the create_task tool surfaces it in W4).
  - `runWork` (create_task asTopLevel) = `launchRun({ kind: 'work', budget: budgets().main, tools: plan-mode aware allowlist, … })`, awaited, no snapshot. `createTask` and `delegate` are wired for EVERY run (uniform capability — kills the per-path drift class).
  - Turn runs (`kind: 'turn'`) seed `history` from the session buffer and persist via `saveSnapshot` (buffer + `store.saveAgentSnapshot`); the PROMPT IS NOT in history (spec D4). The user message emits as a real `run.progress` llm.message event right after `run.created` (port of the 4c behavior), and first-goal titling + `session.updated` broadcast port over verbatim.
  - Sessions map/rehydration (`getOrRehydrate`), system-session bootstrap, permission registries per session (constructed with an emit adapter that persists + broadcasts `task.permission_request` events with the payload-derived runId — port the makeRunEmit legacy-mode behavior for THIS event only, as a small dedicated function), settings passthroughs: all ported from the manager with the same semantics.
  - `markInterruptedRunsTerminal`: same algorithm as the manager's but over BOTH vocabularies (`task.created|run.created` start; `task.complete|task.error|run.complete|run.error` terminal) and the synthetic close-out event is `run.error` with code `cancelled` — pre-W4 rows are task.*, post-W4 rows are run.*, and this service only goes live in W4 alongside the migration, so reading both kinds keeps it correct during the switch WITHOUT depending on migration ordering.
  - Plan mode: `PLAN_READONLY_ALLOWLIST` moves (copy verbatim) into session-service.ts.
  - Logging: entry/outcome at info with sessionId/runId; every catch at error (launch never rejects, so catches are for store/port failures only).

- [ ] **Step 1: Write the failing tests**

Create `session-service.test.ts` with a mocked pi Agent (auto-completing, the retry.test.ts pattern), a real in-memory-ish fake store (implement the ~12 store methods the service touches as a plain object over Maps — createSession/getSession/updateSessionStatus/saveAgentSnapshot/getAgentSnapshot/appendRunEvent (collecting rows)/getRunEvents/getTerminalRunStatuses/updateSessionLastActive/setSessionTitle/getSessionSettings/setSessionSettings/listSessions/deleteSession/updateSessionProvider), and a stub broadcaster collecting `(event, data)` pairs. Cover, at minimum (10 tests):
1. `submitPrompt` happy path: events in order `run.created` → `run.progress`(user message) → `run.dispatched` → … → `run.complete`; the store received the same rows; session buffer updated via saveSnapshot; first-goal titling set + `session.updated` broadcast.
2. FIFO: two submits — the second's `run.dispatched` only after the first's terminal (assert by seq ordering of collected events).
3. `cancelRun` on the QUEUED second run: it terminates cancelled without dispatching, and the first run is unaffected.
4. `interruptWith`: submit A (running, held prompt) + B (queued); interruptWith(B) → A terminates cancelled, B dispatches next.
5. `runWork`: bypasses the queue (dispatches while a turn is running — use a held first turn), main budget, returns status+summary.
6. `delegate` via ctx.spawnChild during a run: child run gets `parentRunId` stamped on its events, sub budget, and the parent receives the child's summary; child agentType resolution falls back to default with a warn when unknown.
7. Uniform wiring: ctx.createTask is available inside a CHILD run (delegate a child; inside it, calling createTask works — assert via captured ctx from a stub tool registry).
8. `markInterruptedRunsTerminal` closes a run with `run.created` but no terminal (fake store rows) AND one with legacy `task.created` — both get a synthetic `run.error` code cancelled + registry terminal.
9. Permission event: with a risky tool + ask mode (riskOf → medium via stub registry), the permission request is broadcast AND appended to run_events with the running runId (port of legacy-mode makeRunEmit) — resolvePermission unblocks it.
10. `deleteSession` aborts the running + queued runs (both reach cancelled terminals) and drops the store rows.

Run: `cd apps/desktop && npm test -- src/service/session/session-service.test.ts` — expected FAIL (module missing).

- [ ] **Step 2: Implement session-service.ts**

Port structure from `manager.ts` (you have it in the same repo — read it) with the launch bindings described in the Behavior contract. Skeleton (fill the passthroughs verbatim from the manager):

```ts
export function createSessionService(cfg: SessionServiceConfig): SessionService {
  const { store, broadcaster } = cfg
  const toolRegistry = cfg.toolRegistry ?? buildDefaultRegistry()
  const sessions = new Map<string, SessionState>()   // { id, provider, permissionRegistry, messages }
  const budgets = () => cfg.getBudgetConfig?.() ?? defaultBudgetConfig()
  const seqCounter = createSeqCounter((sid) => store.getRunEvents(sid))
  const terminalRegistry = createTerminalRegistry(store.getTerminalRunStatuses())
  const emitPorts: RunEmitPorts = { /* the adapter from the Behavior contract */ }

  // Global slot pool → launch's acquireSlot(signal): Promise<() => void>
  let active = 0
  const waiters: Array<() => void> = []
  const acquireSlot = async (_signal: AbortSignal): Promise<(() => void)> => {
    if (active >= cfg.maxConcurrent) await new Promise<void>((r) => waiters.push(r))
    else active++
    let released = false
    return () => {
      if (released) return
      released = true
      const next = waiters.shift()
      if (next) next()
      else active--
    }
  }

  // Abort registry (launch registers before its waits)
  const aborts = new Map<string, () => void>()

  // Per-session FIFO ticket queue → launch's waitTurn
  type Ticket = { runId: string; grant: () => void }
  const turnQueues = new Map<string, { current: string | null; queue: Ticket[] }>()
  const q = (sid: string) => turnQueues.get(sid) ?? turnQueues.set(sid, { current: null, queue: [] }).get(sid)!
  const pumpTurns = (sid: string): void => { /* grant next when idle */ }
  const waitTurn = (sid: string, runId: string, _signal: AbortSignal): Promise<void> =>
    new Promise<void>((grant) => { q(sid).queue.push({ runId, grant }); pumpTurns(sid) })
  const settleTurn = (sid: string, runId: string): void => { /* clear current or drop queued; pumpTurns */ }

  const basePorts = (session: SessionState): LaunchPorts => ({
    emit: emitPorts,
    toolRegistry,
    permissionRegistry: session.permissionRegistry,
    acquireSlot,
    registerAbort: (id, abort) => aborts.set(id, abort),
    unregisterAbort: (id) => aborts.delete(id),
    waitTurn,
    delegate: (parentRunId, goal, opts) => delegate(session.id, parentRunId, goal, opts),
    writeAgent: (def) => cfg.agentStore?.save(def) ?? { ok: false, code: 'no_store', message: 'agent store unavailable' },
    writeSkill: (skill) => cfg.skillStore?.save(skill) ?? { ok: false, code: 'no_store', message: 'skill store unavailable' },
    findAgents: (query) => directory.find(query),
  })
  // …delegate(), runWork(), submitPrompt() building RunSpecs per the contract;
  // submitPrompt fires launchRun asynchronously, tracks settlement for the
  // queue + onComplete; createTask wired via spec-level ports override
  //  (LaunchPorts has no createTask — it rides ToolRunContext.createTask, which
  //  launch builds from ports.delegate? NO: createTask is runWork — add it to
  //  LaunchPorts? See note below.)
}
```

IMPORTANT wiring note: W2's `launch.ts` builds `ctx.spawnChild` from `ports.delegate` but does NOT set `ctx.createTask`. Extend `LaunchPorts` in `run-engine/launch.ts` with an optional `createTask?: (goal: string, agentType?: string) => Promise<{ taskId: string; result: TaskResult }>` and one ctx line `createTask: ports.createTask` (+ a launch.test assertion that it's passed through). This is a 3-line W2-module change owned by THIS task — list it in the commit. SessionService binds it to `runWork` for every run.

- [ ] **Step 3: Green + module suite**

`npm test -- src/service/session/session-service.test.ts` → 10/10. Then `npm test -- src/service/run-engine src/service/session` → green.

- [ ] **Step 4: Full gate, format, commit**

Full desktop suite green; both tsconfig typechecks clean. Commit:

```bash
git commit -m "feat(session): SessionService — the launchRun-native session host

Binds the run-engine to production ports: shared seq/terminal/store
emit adapter, per-session FIFO turn tickets, the global slot pool,
recursive delegate with agentType/provider resolution (child status
survives to the tool layer), uniform createTask/delegate wiring, ported
recovery + permission plumbing. Unused by the app until W4's switchover.
Extends LaunchPorts with a createTask passthrough."
```

---

### Task 4: Full gate + integration

- [ ] **Step 1:** From apps/desktop: full `npm test` green; both typechecks clean. Guard greps from Task 1 Step 5 still clean.
- [ ] **Step 2:** Verify the app still boots on the old path: `grep -n "createSessionManager" apps/desktop/src/service/index.ts` (still the manager — SessionService is dark until W4).
- [ ] **Step 3:** Integrate: rebase onto develop + ff-only merge (main checkout clean first). Worktree teardown: delete node_modules symlinks BEFORE `git worktree remove`; verify `readlink <main>/apps/desktop/node_modules/cross-env` doesn't point into the worktree.

---

## Forward pointer

W4 (final plan): protocol UIEvent task.* members → the run.* union; renderer reducer/hooks/libs/components rename; IPC `swarm:cancelTask`→`cancelRun` + SubmitGoalResult.runId; `create_task`→`delegate` tool rename with DelegateResult.status surfaced; run_events SQL migration (idempotent, schema_meta-versioned); dispatcher/index switch to SessionService; DELETE manager execution half + agent-runner.ts + their remaining tests; e2e rewrite as delegate trees; the two spec-§6 dead knobs (`ResourceBudget.tokens` removal from schema/defaults/UI; `toolScope` collapse to an authoring boolean) ride this protocol-touching wave; full gate + run-desktop smoke.
