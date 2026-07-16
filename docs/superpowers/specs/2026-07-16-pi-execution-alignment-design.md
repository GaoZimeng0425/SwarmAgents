# Execution-Layer Alignment with pi (engine v3)

- **Date:** 2026-07-16
- **Status:** Approved (design); pending implementation plan
- **Scope:** single-agent execution layer only. The multi-agent scheduling layer
  (DAG dispatcher, verify gates, slot governance) is explicitly out of scope and
  gets its own spec after this lands.

## 1. Context and motivation

The current runtime (`service/message-engine/` + `session/session-service.ts`,
built in the 2026-07 run-engine rewrite) drives pi-agent-core's low-level `Agent`
directly and re-implements, partially, what pi's upper layers already solve.
A comparative study of `@earendil-works/pi-coding-agent` and pi-agent-core's
`AgentHarness` tier (both at the pinned version 0.80.6 we already depend on)
identified structural defects:

1. **Dual sources of truth.** `message_events` (UI replay) and `agentSnapshot`
   (LLM context) are written independently and drift — fork reconstruction loses
   all tool history; the snapshot doesn't round-trip `skills`/`thinkingLevel`.
2. **Fragmented streaming messages.** The translator chops assistant deltas into
   immutable `message.progress` fragments at sentence/200-char boundaries. One
   assistant message becomes N anonymous fragments with no message identity and
   no authoritative final version; every fragment is a synchronous sqlite write.
3. **Closed entry union.** History is pure LLM `Message[]`; the wire union is a
   fixed enum. There is no slot for compaction summaries, environment snapshots,
   or any future entry kind without touching five layers.
4. **No steering.** A prompt submitted while a run is active queues behind it or
   aborts-and-restarts (`promoteQueuedMessage`); pi injects steering messages
   between tool batches and follow-ups before agent_end.
5. **Fragile retry.** Fixed 5s x10 backoff, no jitter, no per-request timeout,
   and retries reset the transcript to a pre-prompt baseline — already-executed
   tools are replayed (non-idempotent). pi retries by stripping the trailing
   error and calling `agent.continue()` — continue, not replay.
6. **No compaction.** Context-window overflow is a hard failure.
7. **Vocabulary split-brain.** task/run/message coexist across layers.

## 2. Decisions (settled with the user, 2026-07-16)

| # | Decision | Rationale |
|---|----------|-----------|
| D1 | Existing persisted session data is **discarded** — no migration, no legacy render path. | Dev-phase personal project; frees the wire redesign completely. |
| D2 | Naming baseline is **pi-native vocabulary** (session entry, message_start/update/end, turn, agent run). All `task.*`/`run.*`/`message.*` wire kinds retire. | With D1 the migration-cost argument for keeping `message.*` is gone; zero translation layer against pi source from now on. |
| D3 | Scope is the **execution layer only**. | One spec covering scheduling too would be unfocused; scheduling depends on this foundation. |
| D4 | Route **B: self-build mirroring the harness design**. No runtime dependency on the `AgentHarness` class (pre-1.0, zero in-repo consumers, self-described "pi 2.0" target). Pure data-in/data-out functions ARE imported from pi-agent-core (`compaction` module, `convertToLlm`) — coding-agent itself consumes them the same way. | Full control, no moving-target risk, while not re-implementing tested pure logic. |
| D5 | History is **linear with `parent_entry_id` reserved** in the schema. No branching UI, no leaf moves, no branch summaries this round. | Data model stays isomorphic to pi's tree; future branching needs no schema change; near-zero present cost. |

## 3. Design

### 3.1 Concepts and naming

Domain nouns, fixed once: **Session** (conversation container), **SessionEntry**
(persisted unit, open union), **Message** (AgentMessage incl. custom types),
**Turn** (one assistant response + its tool batch), **Run** (one
agent_start→agent_end drive).

The per-session runtime object is **`SessionAgent`** (the self-built equivalent
of pi's AgentSession/AgentHarness responsibilities), living in
`service/session-agent/`, which replaces `service/message-engine/`.
`SessionService` remains but shrinks to: SessionAgent registry, global slot
pool, permission registry, session CRUD.

### 3.2 Persistence: single source of truth

New table replaces both `message_events` and `agentSnapshot`:

```sql
CREATE TABLE session_entries (
  id              INTEGER PRIMARY KEY AUTOINCREMENT,  -- order key + cursor
  entry_id        TEXT NOT NULL UNIQUE,               -- uuid, pi-style identity
  session_id      TEXT NOT NULL,
  parent_entry_id TEXT,                               -- reserved (D5); linear writes point at previous entry
  type            TEXT NOT NULL,                      -- message | compaction | custom | custom_message | model_change | thinking_level_change
  entry           TEXT NOT NULL,                      -- JSON, SessionTreeEntry-shaped
  ts              INTEGER NOT NULL
);
CREATE INDEX idx_entries_session ON session_entries(session_id, id);
```

- The storage class **implements pi's `SessionStorage` interface contract**
  (`pi-agent-core` `harness/types.ts:441-455`, 10 methods) as a type-only
  import. This is free insurance: swapping in the real harness later (route A)
  would need no schema or storage change.
- Old tables are `DROP`ped at startup (established pattern); no migration (D1).
- LLM context build = entries `ORDER BY id` → custom-entry projectors →
  `convertToLlm` (imported). With linear history, leaf→root path equals full
  table order.
- The **entry union is open**: `custom` (app data, excluded from model context
  by default) and `custom_message` (model-visible) carry a `customType`
  discriminator, mirroring pi (`harness/types.ts:379-391`). Delegation plans,
  plan todos, and usage snapshots move onto `custom` entries — the closed
  `ProgressEvent` union retires.
- Crash-recovery semantics simplify: run state is no longer persisted. Entries
  record what happened; live phase is in-memory. After a restart every session
  is idle by construction — `markInterruptedRunsTerminal` and synthetic
  terminal events are deleted. A partial (in-memory) streaming message is lost
  on crash; finalized entries are not. This matches pi.

### 3.3 SessionAgent

One per session; lazily created from entries; disposable. Lifecycle rules:
lazy-create on first prompt, dispose on session delete, **discard and rebuild
from entries after an error terminal** (bad in-memory state lives at most one
run), reuse across turns otherwise.

- **Owns:** the pi low-level `Agent` (session-bound instance), a phase state
  machine (`idle | turn | compaction | retry`), steer/followUp/nextTurn queues
  (wired via the loop's `getSteeringMessages`/`getFollowUpMessages`), one
  AbortController per run.
- **Hooks installed once, reading a swappable RunContext** (the closure
  inversion — pi installs hooks permanently and reads mutable fields at call
  time): `beforeToolCall` (permission gate + budget + abort check),
  `transformContext` (compaction summary reconstruction; future env injection),
  `prepareNextTurn` (maxTurns backstop).
- **Persistence timing:** finalized message on `message_end` → one entry write.
  Model/thinking changes → change entries. Deltas are never persisted.
- **Auto-retry** (mirrors `agent-session.ts:2587-2637`): on agent_end with a
  retryable error — strip the trailing error message from live agent state
  (keep it in entries), exponential backoff `baseDelayMs * 2^(attempt-1)`
  (abortable), then `agent.continue()`. **Continue, not replay** — executed
  tool results stay in context, eliminating non-idempotent replay. Emits
  `auto_retry_start/end`. Additionally pass `timeoutMs` to the stream options
  so a hung connection can no longer occupy a slot forever.
- **Auto-compaction** (mirrors `agent-session.ts:1900-1989`): on agent_end,
  threshold check via imported `shouldCompact` with real usage; on
  context-overflow error — strip error, compact, auto-continue exactly once
  (single-shot guard). Compaction uses imported `prepareCompaction`/`compact`;
  the result is written as a `compaction` entry; `transformContext` applies it
  when rebuilding context (`firstKeptEntryId` onward + summary).

### 3.4 Events and delivery

Wire events are pi-native pass-through plus a small owned set:
`agent_start/end`, `turn_start/end` (usage), `message_start/update/end`,
`tool_execution_start/update/end`, `entry_appended` (fired after the entry is
persisted; carries the row `id` as cursor), `compaction`, `auto_retry_start/end`,
plus SwarmAgents-owned `permission_request`.

Delivery rules:

- **Delta-class events are broadcast-only**, coalesced per frame (~40ms) before
  crossing IPC. Never persisted.
- **`entry_appended` is persist-then-broadcast.**
- Renderer: pull history by cursor (`WHERE session_id = ? AND id > ? ORDER BY
  id`), subscribe live, render streaming messages in place by `messageId`,
  and on a detected `id` gap re-pull from cursor — lost broadcasts self-heal.
- The seq machinery (`seq-counter.ts`, seq stamping, terminal registry) is
  deleted; the AUTOINCREMENT `id` is the only order key.
- web/mobile clients upgrade to the same protocol (breaking change, D1/D2).

### 3.5 turn/work/child in the new model

Aligned with pi's "one agent, one session":

- **turn** = `SessionAgent.prompt()` on the session itself.
- **work** (cron / top-level delegate) = a prompt on a dedicated (system)
  session.
- **child** (delegate) = an ephemeral child session with its own SessionAgent.
  The parent writes a `custom` entry (`customType: 'delegation'`, holding
  `childSessionId`); the renderer resolves child blocks by fetching the child
  session's entries. This replaces parentMessageId event interleaving.
- The slot pool, `withSlotReleased` slot-yield, `report_result`, and the
  permission registry are **unchanged this round** (scheduling-layer spec).

### 3.6 Delivery phases (one worktree each; app usable after each)

- **P1 (core, largest):** protocol types (pi-native), `session_entries` +
  sqlite SessionStorage, SessionAgent base loop (prompt/abort, finalized
  persistence, event pass-through), renderer transcript path. Deletes
  message-engine, old tables, seq-counter, terminal-registry, synthetic
  terminals. The wire swap is breaking, so renderer must switch in the same
  phase — P1 cannot be split further.
- **P2:** steer/followUp/nextTurn + composer UX (Enter = steer while running,
  explicit queue action for follow-up; align with pi's interaction model).
- **P3:** auto-retry + per-request `timeoutMs`.
- **P4:** auto-compaction + custom-entry projectors (delegation/plan/usage
  migrate onto `custom` entries).

### 3.7 Testing and observability

- Storage tests mirror the case shapes of pi's `test/harness/storage.test.ts`.
- SessionAgent tests drive a deterministic fake streamFn (pi's faux-provider
  technique) covering: finalize-on-message_end, retry-continue (no tool
  replay), overflow→compact→continue-once, phase gating, abort at each phase.
- Renderer: jsdom tests for in-place streaming update, cursor catch-up, and
  gap-triggered re-pull.
- Logging per CLAUDE.md §5: one child logger per SessionAgent run; entry
  writes, phase transitions, retry/compaction triggers all at `info` with
  `sessionId`/`runId`.
- Each phase ends with an end-to-end `run-desktop` verification of live
  streaming in the real app.

## 4. Out of scope

- Multi-agent scheduling: DAG dispatcher, verify gates, slot reservation,
  fan-out caps (next spec).
- Branching UI, leaf navigation, branch summaries (schema is ready, D5).
- Data migration or legacy rendering (D1).
- Adopting the `AgentHarness` class itself (revisit when pi 2.0 stabilizes;
  our storage implements its contract so the option stays cheap).

## 5. Risks and mitigations

| Risk | Mitigation |
|------|------------|
| P1 is a big-bang wire swap | It is the smallest coherent cut (renderer + wire + storage must move together); D1 removes migration risk; e2e verification before merge. |
| Self-built phase machine/queues regress in edge cases | Mirror pi's tested semantics; port the relevant test cases from `test/harness/agent-harness.test.ts` shapes. |
| Imported pure functions change under a future pi upgrade | Version pinned at 0.80.6; upgrades are deliberate and reviewed. |
| Session-bound instance accumulates bad state | Error-terminal → discard + rebuild from entries (state bugs live ≤ 1 run). |

## 6. References

- pi repo (source of the mirrored design): `packages/agent/src/harness/`
  (`agent-harness.ts`, `types.ts:441-455` SessionStorage, `types.ts:379-391`
  custom entries, `compaction/compaction.ts`), coding-agent
  `core/agent-session.ts` (retry `:2587`, auto-compaction `:1900`),
  `core/session-manager.ts`.
- This repo (replaced): `service/message-engine/*`,
  `session/seq-counter.ts`, `session/terminal-registry.ts`,
  `conversation/store.ts` (`message_events`, `agentSnapshot`).
- Prior art: `docs/run-engine-rewrite-summary.md` (the v2 rewrite this
  supersedes in vocabulary and message model).
