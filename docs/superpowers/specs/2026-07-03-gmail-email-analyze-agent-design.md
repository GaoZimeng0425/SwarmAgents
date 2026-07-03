# Gmail Email Analyze Agent + Per-Message Analyze Button

**Date:** 2026-07-03
**Scope:** `packages/protocol/src/types/{gmail,service-ipc,ui}.ts`; `apps/desktop/src/service/agents/` (new builtin `gmail-analyst`); `apps/desktop/src/service/` (new `analyzeEmail` method + runner wiring + dispatch); `apps/desktop/src/main/gmail/{cache,ipc,bridge}.ts`; `apps/desktop/src/preload/index.ts`; `apps/desktop/src/renderer/src/components/views/gmail-inbox-view.tsx` (new `MessageAnalysis` component).

## Problem

The Gmail inbox view (`gmail-inbox-view.tsx`) renders cached threads/messages but offers no AI assistance per message. Users read a long email and have to mentally extract the gist, action items, and urgency themselves. The app already has a Gmail sidecar (cache + tools) and a full agent runner, but nothing connects "this one email" to "run an agent on it and show the result next to it."

## Goal

Add a **builtin `gmail-analyst` agent** (visible and editable in Settings → Agents, like other builtins) and an **「分析」(Analyze) button on every email message card**. Clicking it runs the agent one-shot on that email's content and **streams a structured Chinese Markdown analysis inline beneath the email body** (摘要 / 关键要点 / 待办事项 / 优先级与分类). The result is **cached per message** in the Gmail sqlite cache, so reopening a thread shows the analysis without re-running.

User-confirmed choices: (1) `gmail-analyst` is a **visible builtin, editable in Settings**; (2) output is **Markdown with a fixed section structure** (not structured JSON cards); (3) results are **streamed incrementally** (not spinner-then-final).

## Non-Goals (deliberately excluded)

- **No custom prompt / preset picker.** The analysis is the fixed comprehensive shape. (User picked "综合分析".)
- **No batch / "analyze all" / per-thread analysis.** One button per message; one message per analysis.
- **No delegation / tool use during analysis.** The email content is provided directly; `gmail-analyst` runs tool-less and one-shot. It does not call `gmail.*` tools or spawn children.
- **No main-chat transcript integration.** The analysis is an inline, per-message affordance — it does not create a session/task in the chat transcript.
- **No re-streaming on cache hit.** Cached analyses render immediately from the stored Markdown; only a fresh/re-run analysis streams.

## Design

### 1. `gmail-analyst` builtin agent

A builtin **AGENT.md** (YAML frontmatter + system-prompt body), authored in the same location and reconciled to disk on boot by `restoreDefaultAgents` exactly like the existing builtins (CEO, leaders). Visible and editable in Settings → Agents.

Frontmatter:
- `id`: `gmail-analyst`
- `name`: `Gmail 邮件分析`
- `description`: one-line "分析单封邮件，输出结构化中文摘要。"
- `toolScope`: `peekaboo` (minimum privilege; the run is tool-less, content is provided)
- `maxIterations`: `2`
- `capabilities`: `['gmail-analyze']`

System prompt (body) instructs the model to:
- Ignore the email's original language and **always answer in Chinese**.
- Output a fixed Markdown structure: `## 摘要` (2–3 sentences) → `## 关键要点` (bulleted) → `## 待办事项` (checkbox bullets, only if the email implies action; "无" otherwise) → `## 优先级与分类` (one line: e.g. "高 · 需回复" / "低 · 订阅通知", with a one-line reason).
- Be terse; never invent facts not in the email.

### 2. Streaming one-shot analyze path (service)

New service method on the same channel as `submitGoal`:

```ts
analyzeEmail(input: {
  messageId: string        // correlation key for streaming events + cache
  subject: string
  from: string
  content: string          // the email bodyText (plain text; best for the LLM)
}): Promise<{ ok: true } | { ok: false; code: 'no_provider' | 'no_agent'; message: string }>
```

The call **returns an ack immediately** after starting the run. The run's output is delivered as events (below). `code: 'no_provider'` / `'no_agent'` are sync failures returned in the ack; runtime failures during the run come via `gmail.analysisError`.

Implementation:
- Resolve the agent: `agentStore.get('gmail-analyst')`; if missing (user deleted it), fall back to an in-code `AgentDefinition` literal with the same prompt so the button still works. Log a `warn` when the fallback is used.
- Resolve the **active provider** via the same path `submitGoal` uses. If none configured → return `{ok:false, code:'no_provider'}`.
- Build a one-shot runner with `createAgentRunner`, mirroring the `buildAnalyzeImage` precedent (`agent-runner.ts`): `toolAllowlist: []`, `maxIterations: 2`, budget = the `sub` tier from `BudgetConfig` (one-shot, cheap), `initialMessages: []`, **non-silent `emit`** (see event adapter below), and stubs for `spawnChild`/`permissionRegistry`/`toolRegistry` (unused — tool-less). `correlationId = messageId`.
- `runner.run()` is awaited internally (fire-and-forget relative to the IPC ack).

**Event adapter** — the runner's `emit` translates its events to Gmail-analysis events on the existing service→renderer event bus (same pipe `task.progress` uses):
- `task.progress { event: { kind: 'llm.message', content } }` → emit `gmail.analysisDelta { messageId, text: content }`
- `task.complete { result: { summary } }` → emit `gmail.analysisComplete { messageId, markdown: summary }`
- `task.error { error }` → emit `gmail.analysisError { messageId, error: error.message }`
- all other events (`reasoning`, `tool.*` — none expected since tool-less) are dropped.

### 3. Persistence (main Gmail cache)

`cache.ts` gains an `analyses` table, idempotently migrated (same `PRAGMA table_info` + `CREATE TABLE IF NOT EXISTS` pattern as the existing `htmlBody` column migration):

```sql
CREATE TABLE IF NOT EXISTS analyses (
  messageId TEXT PRIMARY KEY, analysis TEXT, updatedAt INTEGER
);
```

New `Cache` methods:
- `saveAnalysis(messageId: string, analysis: string): void` — `INSERT … ON CONFLICT DO UPDATE`.
- `getAnalyses(threadId: string): Record<string, { analysis: string; updatedAt: number }>` — join `messages.threadId` to collect analyses for every message in the thread.

`GmailBridge` (renderer↔main) exposes:
- `gmail.saveAnalysis(messageId, analysis): Promise<void>`
- `gmail.getAnalyses(threadId): Promise<Record<string, { analysis: string; updatedAt: number }>>`

### 4. Frontend (`gmail-inbox-view.tsx`)

New component `MessageAnalysis`, rendered inside `MessageCard` beneath the body, with a four-state machine:

| state | trigger | UI |
|---|---|---|
| `idle` | no cached analysis, not running | 「✨ 分析」button (disabled when `bodyText` is empty) |
| `streaming` | after click, while `analysisDelta` events arrive | spinner + the accumulated Markdown rendered live via **Streamdown** (same renderer as chat) |
| `result` | `analysisComplete` OR cached analysis on open | rendered Markdown + 「↻ 重新分析」 |
| `error` | `analysisError` | error text + 「重试」 |

Wiring:
- `GmailInboxView`'s detail query is extended to **also fetch `gmail.getAnalyses(selectedId)` in parallel** with `getThread`. The map is passed down to each `MessageCard`/`MessageAnalysis` so cached analyses render immediately on open.
- On click (subscribe-then-call to avoid missing the first delta): set `streaming`, then call `analyzeEmail({ messageId: m.id, subject: m.subject, from: m.fromAddr, content: m.bodyText })` on the service client (same channel as `submitGoal`). Subscribe to the renderer's existing service-event listener (the one that surfaces `task.progress`) for `gmail.analysis{Delta,Complete,Error}`, filtered by `m.id`; accumulate deltas into local state.
- On `analysisComplete`: finalize render from the complete Markdown (authoritative — supersedes the accumulated buffer in case a delta was dropped) and call `gmail.saveAnalysis(m.id, markdown)`.
- On `analysisError`: `error` state; 「重试」re-runs.

Rendering uses **Streamdown** (the chat's Markdown renderer) so headings/checkboxes/code render consistently with the rest of the app.

### 5. End-to-end data flow

```
[open thread]  getThread ──────────────┐
               getAnalyses ────────────┤── MessageCard × N (cached analysis shows immediately)
                                     │
[click 分析]   subscribe(gmail.analysis*) ──► MessageAnalysis(streaming)
               service.analyzeEmail({messageId,subject,from,content}) ──► ack
                                     │
   (service)  gmail-analyst one-shot runner ──► emit gmail.analysisDelta{messageId,text} × N
                                     │           └─► gmail.analysisComplete{messageId,markdown}
                                     │
[renderer]    accumulate deltas → Streamdown live; on complete → saveAnalysis(messageId, markdown)
[reopen]      getAnalyses returns it → render without re-running
```

### 6. Error handling & logging (CLAUDE.md §5)

- A `gmail-analyze` child logger. `info` at entry `{ messageId, subjectLen, contentLen, model }`; `info` at outcome `{ messageId, durationMs, used: {tokens, usdCents} }`. `warn` on fallback-agent-used and on empty/short content. Every `catch` logs `error` with `{ messageId, err }` before emitting `gmail.analysisError` — the log file alone must explain any failure.
- Provider-missing and agent-missing are sync `{ok:false, code}` returns (no event); the UI shows a targeted hint ("请先在 设置 → 模型 配置提供商" / "gmail-analyst agent 不可用").
- The runner's own retry/fallback chain applies (transient provider failures retried; permanent ones fall through to `analysisError`).

### 7. Testing

- **`analyzeEmail` service unit test**: inject a fake provider + `createAgentRunner` (pattern from `manager.test.ts`); assert it emits `gmail.analysisDelta` then `gmail.analysisComplete` with the assembled Markdown, and returns `{ok:false, code:'no_provider'}` when no provider. Assert the ack resolves before the run completes.
- **`cache.test.ts`**: `saveAnalysis` round-trip; `getAnalyses(threadId)` returns only that thread's messages' analyses (use `:memory:` db).
- **`MessageAnalysis.test.tsx`**: covers `idle`/`streaming`/`result`/`error`; assert a cached analysis renders without calling `analyzeEmail`; assert `analyzeEmail` is called on click and deltas accumulate; assert `saveAnalysis` fires on complete.

## Open follow-ups (out of scope here)

- Streaming is renderer-local; if two windows are open, both receive the events (only the matching `messageId` reacts). Fine for v1.
- "重新分析" overwrites the cached Markdown (no history of prior analyses).
- No cost ceiling beyond the `sub` budget tier; a long email could use more tokens. Acceptable for v1.
