# SwarmAgents — Multi-Agent Cluster for Mac Automation

Design spec — 2026-05-23

## 1. Overview

SwarmAgents is an Electron app that runs a cluster of LLM-powered agents capable of autonomously operating the local Mac — clicking, typing, browsing, and manipulating files — to complete user-issued tasks. The system is built around an **orchestrator + workers** pattern: a planning agent decomposes user goals into subtasks and dispatches them to a pool of isolated worker agents that execute via Peekaboo (desktop), Playwright MCP (web), and a filesystem MCP (files).

### 1.1 Goals (v1)

- End-to-end execution of hybrid tasks spanning browser + desktop GUI + local files
- Multi-agent orchestration with parallel worker execution and inter-task handoff
- Default-autonomous execution with confirmation gates on classifiable high-risk actions
- Multi-provider LLM support (Anthropic + OpenAI, with seam for local)
- Native-feel macOS UI (per the in-repo `native-feel` skill)
- Local-only persistence; full task replayability from event log

### 1.2 Non-goals (v1)

- Cross-platform (macOS only; architecture portable, Peekaboo is not)
- Remote operation, cloud sync, multi-user, teams
- Plugin SDK beyond "add an MCP server in settings"
- Prompt-template editor (orchestrator/worker prompts are code constants)
- Mobile or web client

### 1.3 Top-level decisions

| Decision | Choice | Rationale |
|----------|--------|-----------|
| Cluster shape | Orchestrator + Workers | User-selected. Maps cleanly to processes, supports handoff. |
| Peekaboo integration | MCP server (`@steipete/peekaboo`) | Designed for agent use; persistent session amortizes startup. |
| Autonomy level | Default-autonomous + risk-classified gates | Balances throughput with safety. |
| LLM layer | Vercel AI SDK (multi-provider) | Unified tool-calling API across Anthropic / OpenAI / local. |
| Process topology | Multi-process (`utilityProcess` per worker) | Real isolation; worker crash does not kill the app. |
| MVP scope | Hybrid (browser + desktop + files) | User-selected. Requires 3 MCP servers from day one. |

---

## 2. Architecture

### 2.1 Process topology

```
┌─────────────────────────────────────────────────────────────────────┐
│ Renderer  (React + Tailwind)                                        │
└────────────▲─────────────────────────────────────▲──────────────────┘
             │ contextBridge (typed RPC + streams) │
┌────────────┴──────────────────────────────────────┴─────────────────┐
│ Main process                                                        │
│   Orchestrator · Permission Gate · Worker Supervisor · MCP Registry │
└─────────────┬──────────────────────────────────────┬────────────────┘
              │ MessagePort × N                      │ stdio × M
              ▼                                      ▼
   Workers #1..#N (utilityProcess)         MCP servers (Peekaboo,
   · Agent loop                             Playwright, FS)
   · Vercel AI SDK
   · MCP client proxy → Main
```

### 2.2 Key invariants

- **MCP servers are owned by Main, never by workers.** Workers receive a proxy `mcp.call()` whose requests round-trip through Main. This makes worker crashes / restarts non-destructive to MCP-side state (Peekaboo screen sessions, Playwright browser instances).
- **Each worker has exactly one `MessagePort`** to Main, created via `MessageChannelMain`. All messages are JSON.
- **Renderer has no Node access.** `preload` exposes only typed RPC and stream subscriptions. State authority lives in Main.
- **Worker process == one logical agent.** Workers don't multiplex tasks; if a worker is idle, Supervisor can hand it a new task without restart.

### 2.3 IPC protocol (Main ↔ Worker)

```ts
// Main → Worker
type Inbound =
  | { type: 'task.assign'; task: Task; promptContext: string }
  | { type: 'task.cancel'; taskId: string }
  | { type: 'tool.result'; callId: string; result: ToolResult }
  | { type: 'permission.decision'; actionId: string; decision: 'grant' | 'deny' | 'skip' }
  | { type: 'shutdown' }

// Worker → Main
type Outbound =
  | { type: 'tool.call'; callId: string; server: string; tool: string; args: unknown }
  | { type: 'permission.request'; actionId: string; risk: Risk; summary: string; payload: unknown }
  | { type: 'progress'; event: TaskEvent }
  | { type: 'task.complete'; taskId: string; result: TaskResult }
  | { type: 'task.handoff'; parentTaskId: string; newGoal: string; suggestedTools?: string[] }
  | { type: 'task.error'; taskId: string; error: ErrorRecord }
  | { type: 'heartbeat'; ts: number }
```

`task.complete`, `task.handoff`, and `task.error` originate from worker-side pseudo-tools that the worker runtime intercepts (see §3.3); they are routed as IPC messages rather than through the MCP Registry, since they terminate or fork the task.

### 2.4 Worker Supervisor

- Maintains a fixed pool. Default size: `min(os.cpus().length, 4)`. Configurable in settings.
- States per worker: `idle | busy | paused | dead`.
- Health: heartbeat every 5 s; absence > 30 s → `dead` → kill + restart with exponential backoff (1s → 2s → 4s → 8s, cap 60s).
- On crash, the in-flight task is marked `interrupted`; orchestrator decides whether to resume on a new worker (resume reads the task's `events.jsonl` to rebuild context) or fail.

### 2.5 MCP Registry

- Reads `~/Library/Application Support/SwarmAgents/mcp.json` on boot. Defaults: Peekaboo, Playwright MCP, filesystem MCP.
- Spawns each as a child process, performs MCP `initialize` + `tools/list`, indexes tools as `<server>.<tool>` (e.g. `peekaboo.click`, `web.navigate`).
- Health-checks every 10 s; on 3 consecutive failures, restarts with backoff.
- New MCP servers can be added at runtime via settings without a code change; tool catalog is rebuilt on registry events.
- Large payloads (screenshots) are written to the session directory; the in-band `ToolResult` carries only `{ kind, path, w, h, sha }`.

---

## 3. Orchestration model

### 3.1 Task — the unit of work

```ts
type TaskStatus =
  | 'pending'        // created, not yet assigned
  | 'planning'       // orchestrator is producing or revising a plan for this task
  | 'dispatched'     // assigned to a worker, worker has not yet acknowledged
  | 'running'        // worker is actively executing
  | 'awaiting_user'  // gated on user input (permission timeout, or explicit ask)
  | 'paused'         // user-initiated pause (Adopt mode or manual pause)
  | 'completed' | 'failed' | 'cancelled'
  | 'interrupted'    // was running when app died; surfaced on next boot for resume

type Task = {
  id: string                       // ulid
  parentId: string | null
  goal: string
  status: TaskStatus
  assignedWorkerId: string | null
  toolAllowlist: string[]          // e.g. ['peekaboo.*', 'web.read', 'fs.read']
  budget: ResourceBudget
  used: ResourceBudget
  history: TaskEvent[]             // append-only
  result: TaskResult | null
  createdAt: number
  startedAt: number | null
  endedAt: number | null
}

type ResourceBudget = { tokens: number; calls: number; wallMs: number; usdCents: number }

type TaskEvent =
  | { kind: 'llm.message'; role: 'assistant' | 'user' | 'tool'; content: unknown; ts: number }
  | { kind: 'tool.call'; server: string; tool: string; args: unknown; ts: number }
  | { kind: 'tool.result'; ok: boolean; payload: unknown; ts: number }
  | { kind: 'permission'; actionId: string; decision: 'grant' | 'deny' | 'skip'; ts: number }
  | { kind: 'handoff'; childTaskId: string; ts: number }
  | { kind: 'error'; error: ErrorRecord; ts: number }
```

### 3.2 Orchestrator (planning agent)

- Runs in the Main process (LLM-only; no MCP tool access).
- Default model: Claude Sonnet 4.6. Configurable; lighter models (Haiku) acceptable for simpler workflows.
- Inputs each turn: user goal + current task tree state + worker availability + accumulated world-state facts.
- Outputs one of:
  - `Plan { subtasks: TaskSpec[] }`
  - `Reassign { taskId, newWorker }`
  - `ApproveHandoff { childTaskId } | RejectHandoff`
  - `Finalize { rootResult }`
- Triggered when: new root goal arrives, a subtask completes / fails, a worker requests handoff, or budget pressure changes.

### 3.3 Worker (execution agent)

- Runs in `utilityProcess`. Standard agent loop using Vercel AI SDK `generateText` with tools.
- Sees only its own task's history. Never sees sibling tasks' raw messages.
- Three explicit exits, surfaced to the LLM as pseudo-tools but intercepted by the worker runtime and forwarded to Main as dedicated IPC messages (they do **not** flow through the MCP Registry):
  - `task.complete({ summary, artifacts })` — done, emits IPC `task.complete`
  - `task.handoff({ newGoal })` — emits IPC `task.handoff`; orchestrator approves or rejects (see §3.4)
  - `task.giveUp({ reason })` — emits IPC `task.error` with `kind: 'gave_up'`, equivalent to a worker-initiated `failed`
- Implicit exits: budget exceeded, runtime error, cancellation, hard cap on consecutive same-error loops (`thrash = 5`).

### 3.4 Handoff with orchestrator veto

- Worker emits `task.handoff` → Main holds the request.
- Orchestrator is invoked with the handoff context; it returns `ApproveHandoff` or `RejectHandoff`.
- On approve: a new sibling task is created and dispatched (possibly on a different worker); parent task waits for child result or continues, depending on orchestrator's plan.
- On reject: worker receives a tool result instructing it to continue locally or to `giveUp`.
- This veto prevents runaway recursive sub-task spawning.

### 3.5 Context isolation

- Worker prompts inherit *only* an orchestrator-written summary of relevant parent context. Not the raw parent history.
- A "world state" object (fact list + open questions) is maintained by the orchestrator and rewritten as subtasks complete. World state is injected into each subsequent plan / dispatch.

### 3.6 Budget enforcement

- Per-task default: `tokens=100k, calls=50, wallMs=600_000, usdCents=200`. Configurable in settings.
- Pre-flight check on every LLM call and every tool call. If insufficient, throw `BudgetExceededError`, worker reports current progress to orchestrator; orchestrator decides: extend budget, split task, or fail.
- Wall clock guarded by `setTimeout` per task on the worker side.

---

## 4. Tool layer

### 4.1 Default MCP server set

| ID | Source | Purpose |
|----|--------|---------|
| `peekaboo` | `@steipete/peekaboo` | Mac GUI automation (capture, click, type, drag, window, app, menu, dock) |
| `web` | Playwright MCP | Browser automation (navigate, read, fill, click, submit) |
| `fs` | filesystem MCP | Local file read/write within user-confirmed roots |

Users may add additional MCP servers (GitHub, Slack, Calendar, etc.) via settings.

### 4.2 Risk classification

Default static table (overridable per-server in `mcp.json`):

| Tool / pattern | Risk | Gate behavior |
|----------------|------|---------------|
| `peekaboo.see` / `peekaboo.image` / `peekaboo.list` | low | none |
| `peekaboo.click` / `peekaboo.type` / `peekaboo.scroll` / `peekaboo.hotkey` | medium | confirm-once-per-task by tool category |
| `peekaboo.drag` / `peekaboo.dialog` / `peekaboo.menu` | medium | same |
| `peekaboo.app.quit` / `peekaboo.space.*` | high | confirm every call |
| `fs.read` | low | none |
| `fs.write` inside user-declared workspaces | medium | confirm-once-per-task |
| `fs.write` outside workspaces | high | confirm every call |
| `web.navigate` / `web.read` | low | none |
| `web.fill` / `web.click` on form elements | medium | confirm-once-per-task |
| `web.submit` | high | confirm every call |

"Confirm-once-per-task" scope is the current `Task` only; it does not cross sibling/child tasks and does not persist beyond the task's lifetime.

### 4.3 Multi-provider LLM via Vercel AI SDK

```ts
import { anthropic } from '@ai-sdk/anthropic'
import { openai } from '@ai-sdk/openai'

export type ProviderId = 'anthropic' | 'openai' | 'ollama'
export function getModel(id: ProviderId, modelName: string): LanguageModelV2 { /* … */ }
```

Worker uses `generateText({ model, tools, messages, maxSteps })`. Vision (image parts in messages), tool-loop, and prompt caching are handled by the SDK. Initial supported providers: Anthropic, OpenAI. Local (Ollama) is a future plug-in via the same interface.

### 4.4 Secrets

- API keys stored in macOS Keychain via `keytar`. One entry per provider.
- Renderer never sees raw keys. Settings UI talks to a typed Main-side service.
- Workers receive the key needed for a task via IPC at dispatch time; not via environment variables.

### 4.5 Screenshot pipeline

- Peekaboo returns PNG. Main downscales to ≤ 1568 px long edge before persisting (LLM-friendly size).
- Stored at `sessions/<taskId>/screenshots/<sha256>.png`. Identical screenshots (same SHA) are deduplicated on disk.
- `ToolResult` carries `{ kind: 'image', path, w, h, sha }`. The worker inlines the image bytes as a message part on the next `generateText` call. Provider-side prompt caching (Anthropic `cache_control: ephemeral`, OpenAI prompt-cache equivalents) is enabled so that repeated image content within a worker's conversation is billed and transferred efficiently on subsequent turns.

---

## 5. UX / UI

The renderer reuses the `native-feel` skill that already lives in `docs/`: `hiddenInset` titleBar, sidebar vibrancy, system accent color, sheets over web-style modals, dark-first theme.

### 5.1 Three primary surfaces

1. **Cluster Overview (default)** — list of active tasks with status indicators, plus a compact worker-pool strip showing which workers are busy / paused / idle.
2. **Task Timeline** — top half shows the orchestrator plan tree; bottom half shows a chronological event stream per worker, with screenshot thumbnails, LLM thinking summaries, tool calls, and permission decisions.
3. **Settings** — three pages: Providers (keys + model selection), MCP servers (enable/disable, add/remove, override risk map), Budgets & Risk defaults.

### 5.2 Permission sheet

- Rendered as a native macOS sheet sliding down from the task window.
- Displays: tool identifier, human-language summary (written by the worker LLM), key arguments, optional screenshot thumbnail.
- Three actions: **Skip** (signal "decline, continue"), **Deny** (signal "stop, this path is wrong"), **Allow once**.
- Checkbox: "Allow same tool category for this task" (scoped to current task only).
- **30-second timeout → auto-deny + task → `awaiting_user`**. The user can resume from the Cluster Overview, which re-opens the same permission sheet.
- After 5 consecutive grants in a task for the same tool category, the UI offers a one-click "trust this category for this task" affordance to reduce fatigue.

### 5.3 Adopt — manual takeover

A core escape hatch. From the Task Timeline, the user can press `⌥` (or click an "Adopt" button) to set the task status to `paused` and:

- Stop the worker(s) on that task at the next safe step boundary (no in-flight tool call is interrupted; it completes, then the worker holds).
- Manually inject instructions into the worker's next turn ("now click here", "skip this step", "abandon this approach"). Injected text is appended to the worker's history as a `user` message.
- Or fully abandon the agent and close the task as `cancelled`.

A **Release** button returns control to the agent: status transitions back to `running`, the worker resumes its loop with any injected instructions visible in context. Adopt → Release can be invoked any number of times. Adopt is non-destructive: the task history remains intact across takeovers.

### 5.4 Notifications

- macOS native notification on task completion (click → open task).
- Notification + dock badge + menubar icon color change when a permission is pending and the app is not focused.
- Optional menubar item (off by default) showing "N tasks running" with a mini cluster overview popover.

### 5.5 First-run flow

A required onboarding wizard:

1. Grant Screen Recording permission (with "Open System Settings" button).
2. Grant Accessibility permission.
3. Enter at least one provider API key (Anthropic or OpenAI).

Tasks cannot be created until all three are complete. Re-runs of the wizard are accessible from Settings.

---

## 6. Persistence & recovery

### 6.1 Layout

```
~/Library/Application Support/SwarmAgents/
├── db.sqlite           # better-sqlite3, WAL mode
├── mcp.json
├── settings.json
└── sessions/<taskId>/
    ├── events.jsonl    # mirror of in-memory event stream, append-only
    ├── screenshots/
    ├── artifacts/
    └── transcript.md   # generated on task completion
```

### 6.2 Schema highlights

- `tasks` — full Task record minus `history`, plus denormalized status/timing/cost columns for fast filtering.
- `task_events` — one row per event (also mirrored to `events.jsonl` for replayability).
- `workers` — current pool state.
- `permissions_decided` — audit trail of every gated action.
- `provider_usage` — per-call tokens / cost / latency / model, used by the cost dashboard.

### 6.3 Crash recovery

- On boot, any task in `running` / `dispatched` is rewritten to `interrupted`.
- The Cluster Overview surfaces these with a "Resume?" affordance.
- Resume = orchestrator reads the task tree + `events.jsonl` and continues from the last consistent point.
- Worker-only crashes during a session are handled by the Supervisor; the user does not see them unless the worker fails repeatedly.

---

## 7. Error handling

Three-tier classification, no silent swallowing:

| Tier | Examples | Policy |
|------|----------|--------|
| Transient | MCP timeout, LLM HTTP 429, network jitter | Exponential backoff retry, default 3 attempts |
| Recoverable | Tool returns a domain error; plan step fails | Append to task.history; LLM handles next turn. Thrash check: 5 same-error rounds → escalate to orchestrator |
| Fatal | Worker process crash, OOM, configuration error | Supervisor restarts worker once; on second fatal, task → `failed`, surfaced in UI |

All error paths produce a structured `ErrorRecord` written to `task.history` and `permissions_decided`/`provider_usage` as appropriate. No try-catch is allowed to swallow without logging.

---

## 8. Observability

- Structured logs via `pino`, rotating files in `~/Library/Logs/SwarmAgents/`.
- Cost dashboard inside the app: aggregates `provider_usage` by task / day / provider.
- OpenTelemetry seam present but disabled by default. Local-only metrics. No cloud upload in v1.

---

## 9. Testing strategy

- **Unit (Vitest, `packages/core`)** — task state machine, budget calculator, risk classifier, IPC protocol serializer.
- **Integration** — a fake MCP server fixture (returns canned screenshots and tool responses) exercises the full Main + Worker + Registry stack. No mocks at the IPC boundary.
- **LLM record/replay** — first run hits the real provider; subsequent CI runs replay JSON fixtures. Avoids per-CI token cost.
- **UI** — Playwright + Electron driver, covering: create task, view timeline, grant/deny permission, cancel, adopt, settings round-trip.
- Coverage target: every control-flow branch in the orchestrator state machine, plus the permission gate. Not 100% line coverage.

---

## 10. Packaging & distribution

- `pnpm build:mac` → signed, notarized `.dmg`. Signing + notarization are **required** (Accessibility and Screen Recording permissions are unreachable without them).
- CI: GitHub Actions, `electron-builder` with `afterSign` notarization hook. Requires Apple Developer ID stored in repo secrets.
- Auto-update via `electron-updater` (already wired). Publishing target configurable: GitHub Releases or self-hosted endpoint.
- Versioning: SemVer, channel = stable / beta in settings.

---

## 11. Open seams (planned, not in v1)

- Migration of `packages/core` to a standalone library that can power a headless CLI or be exposed as its own MCP server.
- Additional providers (Ollama, OpenRouter, Google) — interface is already provider-agnostic.
- Cross-platform (Windows / Linux) once a Peekaboo-equivalent MCP server exists.
- Custom prompt templates per agent role (orchestrator / worker variants).

---

## 12. Glossary

- **Task** — the unit of work executed by a worker; can have parent/child relationships forming a tree.
- **Orchestrator** — the planning agent running in Main; decomposes goals and arbitrates handoffs.
- **Worker** — an execution agent running in a `utilityProcess`; executes one task at a time.
- **MCP** — Model Context Protocol; the IPC standard used to talk to tool servers.
- **Adopt** — temporary manual takeover of a running task by the user.
- **Handoff** — a worker's request to spawn a sibling/child task, subject to orchestrator approval.
