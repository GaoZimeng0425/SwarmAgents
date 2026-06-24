# SwarmAgents — Per-Agent Memory System

Design spec — 2026-06-24

## 1. Overview

This spec defines a persistent **memory system** for SwarmAgents: durable knowledge that an agent accumulates across tasks and sessions, distinct from a task's transient `history`/`events.jsonl`. Each persistent agent identity (CEO, heads, team members) owns its own memory; memory is also shareable at the team and organization layers. Recall is hybrid (semantic + keyword), fully local, and multilingual.

This system is the concrete implementation of the **P3 retrieval** phase of the agent-environment blueprint, and it layers on top of the existing orchestrator + workers architecture (see [`2026-05-23-swarm-agents-design.md`](2026-05-23-swarm-agents-design.md)).

### 1.1 Motivation

The base design has two forms of state:

- **Task history** — the per-task event stream (`Task.history`, `sessions/<taskId>/events.jsonl`). Lives and dies with the task.
- **World state** — an orchestrator-maintained fact list, rewritten as subtasks complete. Lives and dies with the root goal.

Neither survives across tasks or sessions, and neither is scoped to an *agent*. An agent that learned "the Acme portal's login button is inside an iframe" on Monday has no way to know it on Tuesday. This system adds the missing layer.

### 1.2 Key terms

- **Agent identity** — a persistent, named agent (role/persona) from the multi-team model: CEO, a team head, a team member. Stable across sessions. The owner of memory.
- **Worker** — an ephemeral `utilityProcess` that *embodies* an agent identity for the duration of one task. Workers are recycled; they do not own memory. When a worker is assigned a task, it loads the memory of the agent it is embodying.
- **Memory item** — one durable unit of knowledge (a fact, an episode, or a procedure).

### 1.3 Goals (v1)

- Per-agent private memory that persists across tasks and app restarts.
- Layered sharing: **private** (agent) → **team** → **org**, with read visibility and write privilege rules tied to the existing `team`/`teamRole` system.
- Hybrid retrieval: semantic (vector) + keyword (full-text), fused, ranked, multilingual (Chinese + English).
- Two write paths: an explicit `remember` tool the agent calls, and automatic post-task reflection that extracts durable learnings.
- Deduplication on write and periodic consolidation, so the store stays sharp and bounded.
- Fully local / offline. No external service, no cloud dependency by default.

### 1.4 Non-goals (v1)

- Multi-device or cross-machine sync (the `MemoryStore` interface leaves a seam for it — §12).
- A cross-encoder reranking stage (designed as a seam — §7.4 — but not built in v1).
- A user-facing memory browser/editor UI (a future surface; v1 exposes memory through agent tools + logs).
- Replacing the skills system. Procedural memory *complements* skills; it does not author or execute them.

### 1.5 Top-level decisions

| Decision | Choice | Rationale |
|----------|--------|-----------|
| Scope model | Layered: private + team + org | Fits the multi-team "company" metaphor; agents build on shared knowledge. |
| Write path | Explicit `remember` tool **and** auto-reflection | Curated quality plus capture of what the agent forgets to record. |
| Storage | One embedded SQLite DB (`memory.sqlite`) | Already in the stack (`better-sqlite3`); one transactional store; local-only. |
| Vector index | `sqlite-vec` (`vec0` virtual table) | Embedded, zero external infra, co-located with the keyword index. |
| Keyword index | SQLite FTS5 (BM25) | Exact-name/ID recall that vectors fuzz; zero new dependency. |
| Fusion | Reciprocal Rank Fusion (RRF) | Combines vector + keyword with no weight tuning. |
| Embeddings | Local `multilingual-e5-small` (384-d) via transformers.js | Offline, multilingual (CN + EN), small. Pluggable; optional cloud embedder. |
| Process | Dedicated Memory Service `utilityProcess` | Single owner of DB + model (no write contention, model loads once). Mirrors the "MCP owned by Main" invariant. |
| External service (Qdrant/Mem0/Docker) | **Rejected for v1** | Breaks the local-only desktop story; no quality gain at single-user scale. Seam preserved via `MemoryStore`. |

---

## 2. Architecture

### 2.1 Process topology

The Memory Service is a new `utilityProcess`, owned by Main, sibling to the worker pool. It is the **sole** owner of `memory.sqlite` and the embedding model.

```
┌─────────────────────────────────────────────────────────────────────┐
│ Main process                                                        │
│   Orchestrator · Worker Supervisor · MCP Registry · Memory Proxy    │
└───────┬─────────────────────────────┬───────────────────────────────┘
        │ MessagePort × N             │ MessagePort × 1
        ▼                             ▼
  Workers #1..#N            ┌──────────────────────────────┐
  (embody an agent)         │ Memory Service (utilityProcess)│
  recall/remember ──proxy──▶│  · MemoryStore (sqlite-vec)   │
                            │  · Embedder (local model)     │
                            │  · MemoryWriter (dedup)       │
                            │  · ReflectionJob runner       │
                            │  owns memory.sqlite           │
                            └──────────────────────────────┘
```

### 2.2 Key invariants

- **Memory Service is owned by Main, never by workers.** Workers issue `recall`/`remember`/… requests that round-trip through Main. This matches the existing MCP invariant: worker crashes/restarts never corrupt memory-side state.
- **Agent identity is stamped by Main, not claimed by the worker.** Main knows which agent identity a worker is embodying (from the dispatch). It attaches the authenticated `agentId` (and the agent's `team`/`teamRole`) to every memory request before forwarding. A worker **cannot** spoof another agent's identity or escalate its write scope. This is the security boundary for the layered model.
- **Single writer to `memory.sqlite`.** Only the Memory Service opens the DB for writes. No multi-process SQLite contention; WAL mode for read concurrency within the service.
- **The embedding model loads once,** in the Memory Service, and is reused for every embed call. It never crosses an IPC boundary.

### 2.3 Module boundaries (inside the Memory Service)

| Module | Responsibility | Depends on |
|--------|----------------|------------|
| `MemoryStore` (interface) | CRUD + hybrid search over memory items. Backend-agnostic. | — |
| `SqliteVecStore` (impl) | The default `MemoryStore`: SQLite + FTS5 + `vec0`. | `better-sqlite3`, `sqlite-vec` |
| `Embedder` (interface) | `embed(texts) → vectors`, `dim`, `id`. | — |
| `LocalEmbedder` (impl) | transformers.js + onnxruntime-node, `multilingual-e5-small`. | `@huggingface/transformers` |
| `MemoryWriter` | The single write choke point: privilege check → dedup → embed → persist. | `MemoryStore`, `Embedder` |
| `Retriever` | Hybrid recall: vector + FTS → RRF → boost → budget-trim → usage feedback. | `MemoryStore`, `Embedder` |
| `ReflectionJob` | On task completion, extract candidate memories via a cheap LLM, route through `MemoryWriter`. | `MemoryWriter`, LLM provider |
| `Consolidator` | Periodic merge/prune/decay pass. | `MemoryStore`, `Embedder` |
| `MemoryServiceServer` | IPC endpoint; resolves identity-stamped requests to the modules above. | all of the above |

Each module is independently unit-testable: `MemoryStore` against an in-memory SQLite, `Retriever`/`MemoryWriter` against a **fake deterministic `Embedder`** (no model download in CI).

---

## 3. Memory model

### 3.1 Memory item

```ts
type MemoryScope =
  | { kind: 'private'; agentId: string }
  | { kind: 'team'; teamId: string }
  | { kind: 'org' }

type MemoryType = 'semantic' | 'episodic' | 'procedural'

type MemoryItem = {
  id: string                 // ulid
  scope: MemoryScope
  authorAgentId: string      // who created it (always a concrete agent)
  type: MemoryType
  title: string              // short, human + embedding friendly
  body: string               // the content
  tags: string[]
  salience: number           // 0..1 importance, set on write, adjusted on consolidation
  createdAt: number
  lastUsedAt: number         // bumped each time this item is returned by recall
  useCount: number           // bumped each time returned by recall
  sourceTaskId: string | null
  supersedesId: string | null // points at an item this one replaces (dedup/merge)
  expiresAt: number | null    // TTL for known-temporary facts
  related: string[]           // ids of linked memories ([[id]] graph edges)
  embeddingModel: string      // model id used to produce the vector (migration guard)
}
```

`type` semantics (cognitive-memory analogy):

- **semantic** — a durable fact, preference, or piece of knowledge. *"User prefers metric units."* *"Acme's API base is api.acme.test."*
- **episodic** — something that happened during a task, including failures. *"On 2026-06-20, filling the Acme form by CSS selector failed; the field is in a shadow DOM — used role-based locator instead."*
- **procedural** — a reusable how-to / recipe. *"To export an Acme report: open Reports → set range → click ⋯ → Export CSV."* Bridges toward the skills system but is not a skill.

This extends the frontmatter model already used for Claude Code memory (`name`/`description`/`type`) with ranking signals (`salience`, `lastUsedAt`, `useCount`) and lifecycle fields (`supersedesId`, `expiresAt`).

### 3.2 Layered scope rules

| Scope | Stored as | Write privilege | Read visibility |
|-------|-----------|-----------------|-----------------|
| **private** | `private` / `agentId` | the owning agent only | the owning agent only |
| **team** | `team` / `teamId` | any agent who is a member of that team | all agents in that team |
| **org** | `org` / — | privileged agents only: `teamRole` ∈ {CEO, head} or the training meta-team | every agent |

`canWrite(agent, scope)` and `visibleScopes(agent)` are pure functions of the agent's identity (`agentId`, `team`, `teamRole`), evaluated in the Memory Service against the **Main-stamped** identity (§2.2).

```ts
function visibleScopes(agent: AgentIdentity): ScopeFilter {
  return {
    private: agent.id,
    team: agent.team ?? null,   // null → no team layer for this agent
    org: true,
  }
}
```

**Conflict precedence on recall: private > team > org.** When two recalled items conflict (same subject, contradictory body — detected at consolidation time and flagged with `supersedesId`, or surfaced inline), the higher-precedence layer wins and the lower one is demoted in ranking, not deleted.

---

## 4. Storage

### 4.1 Layout

A dedicated database file, separate from `db.sqlite`, so memory can be backed up or cleared independently and does not contend on the task-event WAL:

```
~/Library/Application Support/SwarmAgents/
├── db.sqlite          # tasks, events, workers, usage  (existing)
├── memory.sqlite      # memory items + FTS5 + vectors   (new)
└── models/            # cached embedding model files     (new)
    └── multilingual-e5-small/
```

### 4.2 Schema

```sql
PRAGMA journal_mode = WAL;

CREATE TABLE memories (
  rowid           INTEGER PRIMARY KEY,           -- FTS/vec join key
  id              TEXT UNIQUE NOT NULL,          -- ulid
  scope_kind      TEXT NOT NULL,                 -- 'private' | 'team' | 'org'
  scope_owner     TEXT,                          -- agentId | teamId | NULL(org)
  author_agent_id TEXT NOT NULL,
  type            TEXT NOT NULL,                 -- semantic|episodic|procedural
  title           TEXT NOT NULL,
  body            TEXT NOT NULL,
  tags            TEXT NOT NULL DEFAULT '[]',    -- JSON array
  salience        REAL NOT NULL DEFAULT 0.5,
  created_at      INTEGER NOT NULL,
  last_used_at    INTEGER NOT NULL,
  use_count       INTEGER NOT NULL DEFAULT 0,
  source_task_id  TEXT,
  supersedes_id   TEXT,
  expires_at      INTEGER,
  related         TEXT NOT NULL DEFAULT '[]',    -- JSON array of ids
  embedding_model TEXT NOT NULL,
  archived        INTEGER NOT NULL DEFAULT 0     -- soft-delete for decay
);

CREATE INDEX idx_mem_scope ON memories(scope_kind, scope_owner) WHERE archived = 0;
CREATE INDEX idx_mem_type  ON memories(type)                    WHERE archived = 0;
CREATE INDEX idx_mem_used  ON memories(last_used_at)            WHERE archived = 0;

-- Keyword index (external-content FTS5 over title/body/tags)
CREATE VIRTUAL TABLE memories_fts USING fts5(
  title, body, tags,
  content='memories', content_rowid='rowid', tokenize='unicode61'
);

-- Sync triggers
CREATE TRIGGER mem_ai AFTER INSERT ON memories BEGIN
  INSERT INTO memories_fts(rowid, title, body, tags)
  VALUES (new.rowid, new.title, new.body, new.tags);
END;
CREATE TRIGGER mem_ad AFTER DELETE ON memories BEGIN
  INSERT INTO memories_fts(memories_fts, rowid, title, body, tags)
  VALUES ('delete', old.rowid, old.title, old.body, old.tags);
END;
CREATE TRIGGER mem_au AFTER UPDATE ON memories BEGIN
  INSERT INTO memories_fts(memories_fts, rowid, title, body, tags)
  VALUES ('delete', old.rowid, old.title, old.body, old.tags);
  INSERT INTO memories_fts(rowid, title, body, tags)
  VALUES (new.rowid, new.title, new.body, new.tags);
END;

-- Vector index (sqlite-vec). 384 = multilingual-e5-small dimension.
CREATE VIRTUAL TABLE memory_vectors USING vec0(
  memory_rowid INTEGER PRIMARY KEY,
  embedding    FLOAT[384]
);
```

**Tokenizer note.** `unicode61` handles Latin word boundaries but does not segment Chinese (no spaces). For v1 this is acceptable because the **vector** path carries Chinese recall; FTS primarily serves exact-token/ID/Latin matches. If Chinese keyword precision becomes a need, swap in a CJK-aware FTS5 tokenizer (e.g. ICU/`simple` with n-gram) — a localized change behind `SqliteVecStore`.

**Dimension is fixed per store.** `memory_vectors` is declared with the embedder's dimension. Switching to an embedder of a different dimension requires a re-index migration (drop + rebuild `memory_vectors`, re-embed all rows). `embedding_model` per row makes a stale-vector audit cheap.

---

## 5. Embeddings

### 5.1 Interface

```ts
type Embedder = {
  readonly id: string          // e.g. 'multilingual-e5-small'
  readonly dim: number         // 384
  embed(texts: string[], kind: 'query' | 'passage'): Promise<Float32Array[]>
}
```

`kind` exists because the E5 family expects asymmetric prefixes: query text is embedded as `"query: <text>"`, stored memory text as `"passage: <text>"`. The interface bakes this in so callers never deal with prefixes.

### 5.2 Default: local

- `LocalEmbedder` runs `Xenova/multilingual-e5-small` (384-d) through transformers.js on `onnxruntime-node`, inside the Memory Service.
- Model files cache to `models/` on first run (download once) or are bundled in the app resources for an offline first launch (packaging decision — bundling is preferred for the notarized .dmg so first run needs no network).
- Multilingual is **required**: the user works in Chinese and English, and recall must cross languages (a Chinese query matching an English memory and vice-versa).

### 5.3 Optional: cloud (off by default)

A `CloudEmbedder` (OpenAI `text-embedding-3-small`, or Voyage) implements the same interface for users who opt in via Settings for higher quality. It is **off by default** to honor the local-only/privacy goal: enabling it sends memory text to a third party. Because cloud models have a different dimension, switching embedders triggers the re-index migration of §4.2.

---

## 6. Write path

Both write entry points converge on `MemoryWriter`, the single choke point that enforces privilege, deduplicates, embeds, and persists in one transaction.

### 6.1 `MemoryWriter.write`

```
write(input, agentIdentity):
  1. resolve scope (default: private/self). If input.scope is team/org →
     assert canWrite(agentIdentity, scope), else reject with PrivilegeError.
  2. dedup: embed(input.title + '\n' + input.body, 'passage');
     KNN within the SAME scope for nearest neighbor.
       - if cosine ≥ MERGE_THRESHOLD (0.92):
           merge — update existing body if longer/newer, bump salience,
           set existing.supersedes_id = null (it stays canonical),
           return existing.id  (no new row)
       - elif cosine ≥ LINK_THRESHOLD (0.82):
           insert new row; add bidirectional `related` link to the neighbor
       - else: insert new row
  3. persist: INSERT memories (+ FTS via trigger) and INSERT memory_vectors
     in one transaction. Stamp embedding_model.
```

Dedup is what keeps auto-reflection from bloating the store with restatements — the canonical failure mode of automatic extraction.

### 6.2 Explicit `remember` tool

The agent calls it deliberately mid-task. See §8 for the tool surface. Defaults `scope` to private; team/org writes are privilege-checked.

### 6.3 Auto-reflection (`ReflectionJob`)

On `task.complete` (and on `task.error` with `gave_up` — failures are valuable episodic memory), Main notifies the Memory Service with the finished task's identity + transcript reference. The job:

1. Loads the task transcript (`sessions/<taskId>/events.jsonl` digest: goal, key tool calls, result/error).
2. Calls a **cheap** model (default Haiku) with an extraction prompt → strict JSON array of candidate memories: `{ type, title, body, tags, salience }`.
3. Routes each candidate through `MemoryWriter` at **private** scope for the embodying agent.

Bounds: **≤ 5 candidates per task**, **salience ≥ 0.3** to be kept, total reflection cost is one small LLM call per finished task. The extraction prompt is a code constant (consistent with the design's "prompts are code, not user-editable" stance). Reflection runs off the task's critical path (after completion is reported to the user), so it never adds task latency.

---

## 7. Retrieval

### 7.1 `Retriever.recall`

```
recall(query, agentIdentity, opts):
  scopes = visibleScopes(agentIdentity)              // {private:self, team, org}
  qv = embed(query, 'query')

  vec  = memory_vectors KNN(qv) → top 50, filtered to scopes, archived=0,
         expires_at IS NULL OR expires_at > now
  kw   = memories_fts MATCH(query) → top 50 by BM25, same filters

  fused = RRF(vec, kw, k=60)                          // §7.2
  for each item: score *= boost(item)                 // §7.3
  ranked = sort desc(score)
  out = take while token budget remains (default ≤ 1500 tokens, ≤ 12 items)

  bump last_used_at = now, use_count += 1 for every item in `out`
  return out
```

### 7.2 Fusion — Reciprocal Rank Fusion

For an item appearing at rank `r_v` in the vector list and `r_k` in the keyword list:

```
rrf(item) = 1/(k + r_v)  +  1/(k + r_k)     // k = 60; absent rank → term omitted
```

RRF needs no score normalization and no hand-tuned weights between the two retrievers — robust and standard. Vectors recover same-meaning/cross-lingual hits; FTS recovers exact names, IDs, and tokens that vectors smear.

### 7.3 Ranking boost

```
boost(item) = 1
            + W_SAL * item.salience
            + W_REC * recencyDecay(now - item.lastUsedAt)   // exp decay, ~30d half-life
            + W_USE * log(1 + item.useCount)
            + W_SCOPE[item.scope.kind]                        // private > team > org tiebreak
```

Because recall bumps `lastUsedAt`/`useCount` on returned items, memories that repeatedly prove useful climb the ranking over time — a lightweight relevance feedback loop. Weights are code constants in v1.

### 7.4 Reranker seam (not in v1)

A cross-encoder rerank of the top ~20 fused candidates (e.g. local `bge-reranker-base`) would sharpen precision. It is intentionally deferred; `Retriever` exposes a `rerank?: Reranker` hook so it can be added without changing callers.

### 7.5 Injection into the agent loop

Two complementary delivery paths:

1. **Automatic context injection.** When Main dispatches a task, it calls `recall(task.goal + promptContext)` for the embodying agent and injects the top items as a `## Relevant memories` block in the worker's initial context. Memory works even if the agent never thinks to query it.
2. **On-demand tools.** The agent can call `recall_memory` for a targeted lookup mid-task (§8).

The orchestrator consults org/team memory when planning. The existing **world state** object becomes a task-scoped working cache layered on top of persistent memory — not a competing store.

---

## 8. Agent-facing tools

Exposed to workers as runtime-intercepted pseudo-tools (the `task.complete` pattern): the worker calls them like tools, the worker runtime forwards them to Main, Main stamps the authenticated agent identity and proxies to the Memory Service. They do **not** flow through the MCP Registry (identity must not be worker-supplied).

| Tool | Signature | Notes |
|------|-----------|-------|
| `recall_memory` | `(query: string, limit?: number) → MemoryItem[]` | Hybrid recall across the agent's visible scopes. |
| `remember` | `({ type, title, body, tags?, scope?, salience?, expiresAt? }) → { id }` | `scope` default private; team/org privilege-checked. |
| `update_memory` | `(id, patch) → { id }` | Only on items the agent may write (own private, or team/org with privilege). |
| `forget_memory` | `(id) → { ok }` | Soft-delete (`archived=1`) within the agent's write rights. |

All tool calls are recorded as `TaskEvent`s for replayability.

---

## 9. Forgetting, decay, consolidation

A continuously-appending store (auto-reflection) must also forget, or recall degrades and the DB grows unbounded.

- **TTL.** `expires_at` is a hard filter on read and a hard delete during consolidation. Use for known-temporary facts (*"Acme is in read-only maintenance until 2026-07-01"*).
- **Decay.** For `episodic` items with low `salience`, never reused (`use_count = 0`), older than a window (default 60 days): set `archived = 1`. `semantic`/`procedural` and high-salience items persist. Decay only affects ranking until an item crosses the archive threshold.
- **Consolidation pass (`Consolidator`).** Triggered by a per-scope count threshold (default > 2000 live items) or invoked manually:
  - cluster near-duplicates (vector neighbors above `MERGE_THRESHOLD`) and merge into a canonical item (longest/newest body, max salience, unioned tags, `supersedesId` set on the losers);
  - hard-delete expired and long-archived items;
  - flag contradictory pairs for precedence resolution (§3.2).

  This mirrors the existing `consolidate-memory` reflective pass, applied per scope.

---

## 10. IPC contract (Main ↔ Memory Service)

The Memory Service speaks a small request/response protocol over its `MessagePort`. Every request carries the **Main-stamped** identity; the worker never sets it.

```ts
type AgentIdentity = { id: string; team: string | null; teamRole: string | null }

type MemoryRequest =
  | { type: 'recall';      reqId: string; identity: AgentIdentity; query: string; limit?: number }
  | { type: 'remember';    reqId: string; identity: AgentIdentity; input: RememberInput }
  | { type: 'update';      reqId: string; identity: AgentIdentity; id: string; patch: MemoryPatch }
  | { type: 'forget';      reqId: string; identity: AgentIdentity; id: string }
  | { type: 'reflect';     reqId: string; identity: AgentIdentity; taskId: string }
  | { type: 'consolidate'; reqId: string; scope?: MemoryScope }
  | { type: 'stats';       reqId: string }

type MemoryResponse =
  | { type: 'ok';    reqId: string; payload: unknown }
  | { type: 'error'; reqId: string; error: ErrorRecord }
```

Failures use the existing three-tier `ErrorRecord` model (§14). A Memory Service crash is handled like any other supervised process: Main restarts it with backoff; in-flight `recall`s fail soft (the task proceeds with no injected memory rather than blocking).

---

## 11. Persistence & migration

- `memory.sqlite` is created and migrated on Memory Service boot. A `schema_version` pragma gates forward migrations.
- A model/dimension change (§4.2, §5.3) is a dedicated migration: rebuild `memory_vectors` at the new dimension and re-embed all live rows in batches; `embedding_model` per row identifies stale vectors to re-embed.
- Memory is **not** part of task crash-recovery: it is durable, append-mostly state independent of any single task's lifecycle.

---

## 12. Open seam: external / multi-device backend

The `MemoryStore` interface is the swap point. If SwarmAgents ever grows a cloud or multi-device mode, a `QdrantStore` (or a Mem0/Zep adapter) implements the same interface and is selected by config — **no change to `MemoryWriter`, `Retriever`, the IPC contract, or the agent tools.** This is the explicit reason v1 stays embedded: starting local costs nothing later, while starting on Docker would impose external infrastructure on a single-user desktop app today, contradicting the local-only/privacy goal for no recall-quality gain at this scale.

---

## 13. Error handling

Reuses the design's three-tier model:

| Tier | Examples | Policy |
|------|----------|--------|
| Transient | embed model warm-up, transient SQLite busy | retry with backoff; `recall` fails soft (empty result) so the task is never blocked |
| Recoverable | privilege denied on a team/org write; malformed reflection JSON | return structured error to the agent / drop the bad candidate; log |
| Fatal | DB corruption, model load failure | Memory Service reports fatal; Main restarts it; the app runs **degraded** (no memory) rather than crashing |

No error path swallows silently; all are logged via the existing `pino` logger with `component: 'memory'`.

---

## 14. Testing strategy

- **Unit**
  - `MemoryWriter` dedup/merge/link thresholds (with a **fake deterministic `Embedder`** — no model download).
  - RRF fusion and `boost` ranking math.
  - `visibleScopes` / `canWrite` privilege matrix across CEO / head / member / cross-team.
  - decay/TTL/archive transitions.
- **Integration** — `SqliteVecStore` against a real in-memory SQLite (with `sqlite-vec` + FTS5 loaded): write → recall round-trip; layered visibility (member sees private+team+org, not other agents' private); privilege enforcement on team/org writes.
- **Embedder contract test** — `LocalEmbedder` produces stable 384-d vectors and crosses languages (a CN query ranks a known EN passage above an unrelated one). Gated/optional in CI (requires the model); the fake embedder covers the rest.
- **Reflection** — LLM record/replay fixtures (consistent with the design's existing record/replay strategy): a canned transcript yields the expected candidate memories; cap and salience-threshold enforced.

Coverage target: every branch of privilege resolution, the dedup decision tree, and the recall fusion/boost path.

---

## 15. Build order (informs the implementation plan)

1. `MemoryStore` interface + `SqliteVecStore` (schema, FTS5, `vec0`, CRUD, KNN, BM25) against in-memory SQLite.
2. `Embedder` interface + fake embedder; then `LocalEmbedder`.
3. `MemoryWriter` (privilege + dedup + persist).
4. `Retriever` (hybrid + RRF + boost + usage feedback).
5. Memory Service process + IPC contract; Main-side proxy with identity stamping.
6. Agent tools (`recall_memory`/`remember`/`update_memory`/`forget_memory`) + automatic context injection at dispatch.
7. `ReflectionJob` on task completion.
8. `Consolidator` + decay/TTL.

Each step is independently testable and lands behind the one before it.

---

## 16. Glossary

- **Memory item** — a durable unit of agent knowledge (semantic / episodic / procedural).
- **Scope** — the visibility layer of a memory: private (agent), team, or org.
- **Embodiment** — the act of an ephemeral worker assuming a persistent agent identity for one task; the worker loads that agent's memory.
- **Reflection** — the post-task extraction of durable memories from a finished task's transcript.
- **Consolidation** — the periodic merge/prune/decay pass that keeps the store sharp and bounded.
- **RRF** — Reciprocal Rank Fusion; the weightless method for combining vector and keyword result lists.
