# Gmail Redesign (Phase 6c) Design

**Date:** 2026-07-06
**Scope:** Phase 6c of the desktop UI redesign — upgrade the Gmail inbox from a
flat thread list with per-message manual analysis into a **smart-grouped inbox
with a thread-level Agent assistant**. Adds one new backend capability
(`analyzeThread`, modeled on the existing `analyzeEmail`) that streams a
structured `{summary, todos, suggest}` per thread; adds a front-end-derived
smart grouping (待回复 / 重要 / 可归档 / 资讯 / 全部); adds a draft area for the
suggested reply (the app stays Gmail-readonly — no send scope).
**Branch:** `feat/gmail-redesign` (off `develop` @ `e5ad295`).
**Depends on:** Phase 1 (rail/shell). The Gmail inbox view, daemon, cache, and
the existing per-message `analyzeEmail` all exist; this phase restructures the
inbox UI and adds the thread-level analysis path alongside them.
**Out of scope:** sending email (stays `gmail.readonly`); writing todos into any
task system (display-only); background batch analysis of all threads (only the
selected thread is analyzed); removing the existing `analyzeEmail` path (kept for
backward compatibility, just no longer mounted in the inbox UI).

---

## 1. Goal & Scope

Turn the Gmail inbox into an Agent-forward surface:

- **Smart grouping (front-end rules):** five chips — 全部 / 待回复 / 重要 / 可归档 / 资讯 —
  with live counts, derived from each thread's `labelIds` / `unread` / `fromAddr` /
  `lastDateMs` by a pure `classifyThread` function. Zero LLM cost; covers every
  thread.
- **Thread Agent assistant (new backend `analyzeThread`):** selecting a thread
  auto-triggers an LLM run (cached threads are instant) that streams a markdown
  summary and, on completion, returns structured `todos[]` and a `suggest`ed
  reply. Modeled on the existing per-message `analyzeEmail`, lifted to thread
  level.
- **Suggested-reply draft area:** "采用并回复" fills an editable textarea; a
  copy button hands the text to the clipboard for the user to send via Gmail's
  web/mobile client. The app never sends mail.

### Non-goals (explicitly deferred)

- **Send/mailbox mutation.** The app keeps `gmail.readonly`. No `gmail.send`
  scope, no OAuth re-grant, no send IPC.
- **Todo ingestion into the task system.** Extracted todos are display-only
  inside the assistant card. No `submitGoal` / `createLocal` wiring.
- **Background batch analysis.** Only the thread the user selects is analyzed
  (on-demand, cached). No queue, no pre-warming the whole inbox.
- **Pure-LLM grouping.** Grouping is rule-based; the LLM only produces
  summary/todos/suggest. An LLM-classifier version is a follow-up.
- **Removing `analyzeEmail`.** The per-message path stays in the codebase for
  backward compatibility; it is simply no longer mounted in the inbox UI
  (replaced by the thread assistant).
- **Gmail native-label UI.** The grouping does not surface raw Gmail labels to
  the user; it only consumes them as classification signal.

### Confirmed deviations from the design draft

1. **Grouping is front-end rules** (draft implies an LLM classifier) — cost
   control; LLM is reserved for summary/todos/suggest.
2. **"采用并回复" fills a draft area, does not send** (draft is ambiguous) —
   respects the readonly scope.
3. **Todos are display-only** (draft implies task creation) — no cross-subsystem
   coupling this phase.

### Success criteria

- Five smart-group chips render in the inbox header with correct live counts;
  clicking a chip filters the thread list; `classifyThread` is unit-tested for
  news/archive/important/reply/all + boundaries.
- Selecting an un-cached thread auto-triggers `analyzeThread`; the summary
  streams in; on completion, todos + suggest populate. Selecting a cached thread
  shows the result instantly. Switching threads cancels the in-flight
  subscription.
- "采用并回复" opens a textarea prefilled with `suggest`; a copy-to-clipboard
  button works; a hint explains the readonly constraint.
- Missing provider / analysis failure shows a friendly prompt with retry (not a
  hung spinner).
- Per-message `<MessageAnalysis>` is no longer mounted in the inbox;
  `gmail-inbox-view.test.tsx` is updated and green.
- The `analyzeThread` backend is unit-tested for prompt construction, tail-JSON
  parsing (normal / missing-block / malformed → graceful degradation), and
  threadId-keyed broadcasting.
- Full suite green (the known `host.test.ts` EADDRINUSE flake excepted);
  typecheck clean; `check-boundaries` passes.

---

## 2. Design Decisions (locked from brainstorm)

| Decision | Choice | Rationale |
|---|---|---|
| Grouping source | Pure front-end rules on `labelIds`/`unread`/`fromAddr`/`age` | Zero LLM cost; covers all threads; `CATEGORY_*`/`IMPORTANT` labels are strong signal. LLM reserved for summary. |
| `analyzeThread` trigger | Auto on thread select; cached threads instant; switch cancels in-flight | On-demand cost control; mirrors how users expect a detail panel. |
| `analyzeThread` engine | Run-engine (Pattern A), cloned from `analyzeEmail` | Streaming + reuse of agent/budget/provider-injection machinery. Direct-fetch (Pattern B) can't stream. |
| Output format | Markdown summary (streamed) + tail JSON block for todos/suggest | Streams naturally for summary; structured parse only at completion. Parse failure degrades to empty todos/suggest, never blocks summary. |
| Agent | New `gmail-thread-analyst` builtin (separate from `gmail-analyst`) | Different output contract (structured tail JSON vs pure markdown). Keeps `gmail-analyst` untouched for backward compat. |
| Reply action | "采用并回复" → editable textarea + copy button | App stays `gmail.readonly`; no new OAuth scope; user sends via Gmail client. |
| Todos | Display-only in the assistant card | No cross-subsystem coupling this phase; task/calendar ingestion is a follow-up. |
| Implementation slicing | Single branch, 7 sequential tasks, backend first | Matches Phase 5/6a rhythm; backend contract stabilizes before frontend builds against it. |

---

## 3. Specification (from design `Service Views.dc.html` §gmail)

### 3.1 Smart grouping — `classifyThread` (pure)

- **`classifyThread(thread: GmailThread): GmailGroupKey`** — pure function in
  `lib/gmail/classify-thread.ts`. Zero React, zero IO, unit-testable (mirrors
  `lib/calendar/build-insights.ts` from Phase 6a).
  ```ts
  type GmailGroupKey = 'reply' | 'important' | 'archive' | 'news' | 'all'
  ```
  Rules, **first match wins**, evaluated top-down:
  1. **news**: `labelIds` intersects
     `{CATEGORY_PROMOTIONS, CATEGORY_UPDATES, CATEGORY_SOCIAL}`; OR `fromAddr`
     matches automation patterns (`noreply@`, `notifications@`, `@github.com`,
     domain contains `newsletter`); OR `snippet` contains `退订`/`unsubscribe`.
  2. **archive**: `unread === false` AND `lastDateMs` older than 7 days AND not
     news. (Read + stale.)
  3. **important**: `labelIds` contains `IMPORTANT` or `STARRED`.
  4. **reply**: `unread === true` AND not news AND `snippet` contains a question
     marker (`?`/`？` or any of `如何|是否|能否|能不能|请确认|请问|帮忙|何时|什么时候`).
  5. **all**: fallback.
  - **`classifyThread` signature injects `now: number`** (default `Date.now()`)
    so the function stays pure and tests are deterministic:
    `classifyThread(thread, now = Date.now())`. The 7-day archive threshold
    compares `now - thread.lastDateMs`.
  - **`classifyAll(threads, now?): Record<GmailGroupKey, number>`** aggregates
    counts (threads `now` through to `classifyThread`).
  - **Boundaries:** empty `labelIds`, missing `snippet`, future-dated threads →
    fall through to `all`.
- **`<GmailGroupBar>` component** (`gmail-group-bar.tsx`): five chips with
  counts. The four smart groups carry a `Sparkles` icon; 全部 does not. Active
  chip = solid dark background + white text (per draft); inactive = white bg,
  muted border. Props: `{ groups: Record<GmailGroupKey,number>, active, onPick }`.

### 3.2 Thread Agent assistant — backend `analyzeThread`

Modeled on `apps/desktop/src/service/gmail/analyze.ts` (`createAnalyzeEmail`).

- **`createAnalyzeThread`** factory in `service/gmail/analyze-thread.ts`:
  - Input: `{ threadId, subject, messages: {from, dateMs, bodyText}[] }` +
    `provider` (injected by main, same as `analyzeEmail`).
  - Guards: missing provider → `{ok:false, code:'no_provider'}`; missing agent →
    `{ok:false, code:'no_agent'}`.
  - Agent: resolves `gmail-thread-analyst` from the agent store (or
    `defaultAgents` fallback).
  - Prompt: concatenates the thread's messages and asks for **markdown summary
    followed by a tail JSON block**:
    ```
    你是邮件助手。通读以下邮件线程,输出:
    1. 先用自然语言 markdown 写摘要 + 要点
    2. 结尾用一行 <!--ANALYSIS:{...}--> 给出结构化结果,JSON 含:
       - summary: string (与上文摘要一致的一句话版)
       - todos: [{t: string, due?: bool, dueLabel?: string}]
       - suggest: string (建议的中文回复草稿)
    
    Subject: ...
    [messages concatenated with From/Date headers]
    ```
  - Builds a `RunSpec` (`kind:'work'`, ephemeral `sessionId: analyze-thread:<ulid>`,
    `tools: []`, `budget: sub`, `maxIterationsOverride: 1`) and `void run(spec, ports)`.
  - **Custom emit ports** (cloned from `analyze.ts`): session-less, silent except
    a `broadcast` adapter that translates run-engine wire into Gmail events keyed
    by `threadId`:
    - `run.progress` + `llm.message` with string content →
      `gmail.threadAnalysisDelta { threadId, text, ts }`.
    - `run.complete` → **parse tail JSON block** from the accumulated summary:
      - Success → `gmail.threadAnalysisComplete { threadId, summary, todos, suggest, ts }`.
      - Parse failure → same event with `todos: []`, `suggest: ''` (degraded, summary intact).
    - `run.error` → `gmail.threadAnalysisError { threadId, error, ts }`.
  - Returns `{ok:true}` immediately (fire-and-forget; output flows via broadcast).

- **`gmail-thread-analyst` agent** (new builtin in
  `packages/shared/src/constants/agents.ts`):
  - `id: 'gmail-thread-analyst'`, `maxIterations: 1`,
    `capabilities: ['gmail-thread-analyze']`, no `parentId` (independent, like
    `gmail-analyst`).
  - `systemPrompt`: the contract described above (summary + structured tail).
  - Added to `defaultAgents` alongside `gmail-analyst`. Verify `buildOrgForest`
    places it as an independent agent (no team); delegation edges unaffected.

### 3.3 Thread assistant card — `<GmailAssistantCard>`

- Layout (per draft §gmail "Agent 助手" card):
  - Header: gradient violet→blue band, Sparkles icon, "Agent 助手" title,
    trailing "已读取全部 N 条消息".
  - Summary: streaming markdown via `<Streamdown>` (spinner while streaming).
  - Todos (when non-empty): checkbox-styled list; items with `due` get a red
    `dueLabel` chip.
  - Suggest (when non-empty): the suggested reply text + a row of buttons:
    "采用并回复" (primary) and "重新生成" (ghost).
  - Draft area (revealed on "采用并回复"): `<textarea>` prefilled with `suggest`,
    editable; a "复制到剪贴板" button (writes clipboard, shows a transient
    "已复制" toast) and a hint "复制后到 Gmail 网页/客户端发送".
  - Error state: red prompt + "重试" button.
- Props: `{ threadId, subject, messageCount, analysis: ThreadAnalysisState, onRegenerate }`.

### 3.4 `useThreadAnalysis(threadId)` hook

```ts
type ThreadAnalysisState =
  | { phase: 'idle' }
  | { phase: 'streaming'; summaryText: string }
  | { phase: 'done'; summary: string; todos: Todo[]; suggest: string }
  | { phase: 'error'; error: string }
```
- `threadId` non-null: `useQuery(['gmail','threadAnalysis',threadId])` → cache.
  Cache hit → `done`. Cache miss → call `swarmApi.analyzeThread({threadId,...})`
  and subscribe to events.
- Event subscription (cleaned up on `threadId` change):
  - `gmail.threadAnalysisDelta` (matching threadId) → append to `summaryText`,
    `streaming`.
  - `gmail.threadAnalysisComplete` → parse, `saveThreadAnalysis` to cache, `done`.
  - `gmail.threadAnalysisError` → `error`.
- `threadId === null` (no selection) → `idle`, no subscription.

### 3.5 Inbox restructure

`gmail-inbox-view.tsx`:
- Header: keep account email + search + sync; **add `<GmailGroupBar>`** below the
  search row, driven by `classifyAll(threads)` and a local `activeGroup` state.
- Thread list: filtered by `activeGroup` (全部 = no filter).
- Right detail: thread subject + `<GmailAssistantCard>` (new, on top) + the
  existing `messages.map(MessageCard)` (original message rendering, **minus the
  per-message `<MessageAnalysis>` mount**).
- Remove the `MessageAnalysis` import usage here; the component itself is kept
  (backward compat) but not rendered.

### 3.6 Data layer & IPC (additive)

- `swarmApi.analyzeThread(input)` + `swarmApi.gmailGetThreadAnalysis(threadId)` —
  flat names, matching Phase 6a's calendar fold style.
- Preload: `swarm.analyzeThread` (IPC `swarm:analyzeThread`) +
  `gmail.getThreadAnalysis` (`gmail:getThreadAnalysis`). `saveThreadAnalysis` is
  called by the renderer on `Complete` (mirrors `saveAnalysis`).
- Main IPC: `swarm:analyzeThread` handler in `swarm-ipc.ts` (inject provider);
  `gmail:getThreadAnalysis`/`gmail:saveThreadAnalysis` in the gmail IPC module.
- Storage: new `thread_analyses` table in `main/gmail/cache.ts`
  (`threadId TEXT PRIMARY KEY, analysis TEXT, updatedAt INTEGER`,
  `CREATE TABLE IF NOT EXISTS`). `getThreadAnalysis(threadId)` →
  `GmailThreadAnalysis | null`; `saveThreadAnalysis(threadId, json)` upserts.

---

## 4. Architecture

### 4.1 File structure

**New (backend):**
- `apps/desktop/src/service/gmail/analyze-thread.ts` — `createAnalyzeThread`.
- `apps/desktop/src/service/gmail/analyze-thread.test.ts` — prompt build, tail-JSON
  parse (3 cases), threadId broadcast.

**New (agent definition):**
- `packages/shared/src/constants/agents.ts` — `gmail-thread-analyst` entry (no new
  file).

**New (frontend):**
- `apps/desktop/src/renderer/src/lib/gmail/classify-thread.ts` + `.test.ts`.
- `apps/desktop/src/renderer/src/hooks/use-thread-analysis.ts` (+ `.test.tsx`).
- `apps/desktop/src/renderer/src/components/views/gmail-assistant-card.tsx`.
- `apps/desktop/src/renderer/src/components/views/gmail-group-bar.tsx`.

**Modified (backend/IPC/protocol):**
- `packages/protocol/src/types/ui.ts` — `GmailThreadAnalysis`,
  `AnalyzeThreadInput`/`Result`, `gmail.threadAnalysis*` `UIEvent` variants.
- `packages/protocol/src/service-client.ts` — `analyzeThread` signature.
- `apps/desktop/src/service/index.ts` + `service/ipc/dispatcher.ts` — wire
  `analyzeThread`.
- `apps/desktop/src/main/ipc/swarm-ipc.ts` — `analyzeThread` handler.
- `apps/desktop/src/main/gmail/cache.ts` — `thread_analyses` table + accessors.
- `apps/desktop/src/main/ipc/gmail-ipc.ts` (or equivalent) — `get/saveThreadAnalysis`.
- `apps/desktop/src/preload/index.ts` — bridge entries.

**Modified (frontend):**
- `apps/desktop/src/renderer/src/lib/api.ts` — `swarmApi.analyzeThread`,
  `swarmApi.gmailGetThreadAnalysis`.
- `apps/desktop/src/renderer/src/components/views/gmail-inbox-view.tsx` — group bar,
  assistant card, drop per-message analysis mount.
- `apps/desktop/src/renderer/src/components/views/gmail-inbox-view.test.tsx` — update.

**Kept (backward compat, untouched):**
- `service/gmail/analyze.ts` (`createAnalyzeEmail`) + the `gmail-analyst` agent.
- `components/views/gmail-inbox-view.tsx`'s `MessageAnalysis` component (defined
  there today; kept, unmounted).

### 4.2 Data flow (after)

```
GmailInboxView
  ├─ useQuery(['gmail','list',query]) → threads
  ├─ classifyAll(threads) → group counts
  ├─ state: activeGroup, selectedId
  ├─ <GmailGroupBar groups active onPick />              ← filters list
  ├─ filtered thread list (left)
  └─ selected thread detail (right):
       ├─ <GmailAssistantCard threadId subject msgCount
       │    analysis={useThreadAnalysis(threadId)} />
       │    ├─ useQuery(['gmail','threadAnalysis',id]) → cache
       │    ├─ cache miss → swarmApi.analyzeThread + subscribe
       │    └─ <Streamdown>{summary}</Streamdown> + todos + suggest + draft
       └─ messages.map(MessageCard)  ← original bodies, no per-message analysis
```

---

## 5. Risks & Verification

| Risk | Mitigation |
|---|---|
| Streaming JSON incomplete during `streaming` phase. | Summary is markdown (no parse needed mid-stream); todos/suggest parsed only on `Complete`. |
| `classifyThread` rule mis-classification. | Heuristic by design; unit tests with realistic samples per bucket; `all` fallback never drops mail; user can switch groups manually. |
| Cost runaway from rapid thread switching. | Hook cancels the in-flight subscription on `threadId` change (mirrors `MessageAnalysis` cleanup); cached threads never re-analyze; "重新生成" is the only re-trigger. |
| Agent ignores the tail-JSON convention (hallucination/format drift). | Prompt gives an explicit example + sentinel `<!--ANALYSIS:{}-->`; tolerant regex parse; failure degrades to empty todos/suggest, summary still shown. Unit-test normal / missing-block / malformed. |
| `thread_analyses` table on old user DBs. | `CREATE TABLE IF NOT EXISTS` (matches existing `analyses` pattern); first access auto-creates. |
| `gmail-thread-analyst` registration disturbs formations/delegation. | Added to `defaultAgents` as independent (no `parentId`); `buildOrgForest` lists it; delegation edges unaffected. Verify in agents/org-tree tests. |
| Draft area with no send confuses users. | Explicit hint + copy button + toast; readonly rationale in a tooltip. |
| Removing `MessageAnalysis` mount breaks `gmail-inbox-view.test.tsx`. | Grep the test for analysis assertions; rewrite for the assistant card; keep the `MessageAnalysis` component file for backward compat. |
| Parallel-session worktree pollution (3× in Phase 6a). | Every commit `git add <paths>`; `git status` before commit; baseline `develop @ e5ad295`. |
| Provider unconfigured. | Reuse `analyzeEmail`'s `no_provider` guard → `{ok:false, code:'no_provider'}`; assistant card shows "需配置模型供应商" instead of a hung spinner. |

### Success criteria — restated, verifiable

See §1.

### Manual smoke (after implementation)

1. Connect Gmail → inbox shows 5 group chips with counts.
2. Click 待回复 → list filters; click 全部 → restores.
3. Select an un-analyzed thread → assistant card streams summary → todos/suggest appear.
4. Switch threads → old cancels, new begins; switch back → instant from cache.
5. "采用并回复" → draft area expands, prefilled, editable; copy button works.
6. Dark mode: group bar, assistant card, draft area all legible.
7. No provider configured → assistant card shows the prompt, not a dead spinner.

---

## 6. Phases After This One (context only)

- **Phase 7:** settings routing.
- **Follow-ups (this spec's non-goals):** LLM-based grouping refinement; todo
  ingestion into task台/calendar; background batch thread analysis; send-mail
  capability (would require `gmail.send` scope).

---

## Implementation order

1. **Spec → plan → branch `feat/gmail-redesign` → implement → review → merge.**
   (Write `docs/superpowers/plans/2026-07-06-gmail-redesign.md` next, via the
   writing-plans skill.)

Task breakdown (7 tasks, single branch, sequential, backend first):

```
T1: protocol types (GmailThreadAnalysis, AnalyzeThread I/O, gmail.threadAnalysis* UIEvents)
T2: gmail-thread-analyst agent (structured tail-JSON system prompt)
T3: backend analyzeThread (factory + IPC + thread_analyses cache table + preload)
T4: swarmApi + useThreadAnalysis hook (+ tests)
T5: classifyThread pure fn + <GmailGroupBar> + inbox filtering
T6: <GmailAssistantCard> + inbox integration (drop per-message analysis mount)
T7: full verify + final review + progress ledger
```

Dependencies: T1 first; T2+T3 before T4; T4 before T6; T5 independent of T6 but
kept linear for review cadence.
