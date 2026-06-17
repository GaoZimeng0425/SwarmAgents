# Plan D — Migrate Agent Runtime from Vercel AI SDK to pi

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace `src/worker/agent.ts` (currently uses `ai` + `@ai-sdk/anthropic`) with a runtime built on `@earendil-works/pi-agent-core` + `@earendil-works/pi-ai`, so SwarmAgents inherits pi's `beforeToolCall` hook (permission integration), structured event stream, cross-provider handoff, and broader provider matrix (Bedrock, Vertex, GitHub Copilot OAuth, OpenCode, Cerebras, etc.) — without touching the Plan 1 substrate (Supervisor, IPC, Permission Gate, UI).

**Architecture:** The multi-process topology, IPC schema, UIEvent shape, and Permission Sheet UI all stay. Inside the worker, the AI SDK `streamText` loop is replaced by a pi `Agent` instance whose event stream is translated into our existing `Outbound` IPC messages. Tools migrate from Zod to TypeBox. A new IPC request/response helper lets the worker's `beforeToolCall` hook synchronously await a decision from Main's PermissionGate. AI SDK packages are removed at the end.

**Tech Stack:** `@earendil-works/pi-agent-core` (Agent class, event streaming, tool hooks), `@earendil-works/pi-ai` (multi-provider model resolution), TypeBox (replaces Zod for tool schemas), existing Electron + utilityProcess + supervisor.

**Branch strategy:** Start from `feat/plan-1-foundation` (current tip), create `feat/plan-D-pi-migration`. Plan 1's substrate stays untouched.

**Spec reference:** [`docs/superpowers/specs/2026-05-23-swarm-agents-design.md`](../specs/2026-05-23-swarm-agents-design.md). pi-agent-core covers §3 (Orchestration model — worker side), §4.3 (Multi-provider LLM abstraction), §4.5 (image-aware messaging via pi `message_update` with image parts in later iterations).

---

## File Map

**Created:**
- `src/worker/pi-agent/index.ts` — public entry: `runPiAgent(task, send, options)` replaces `runAgent`
- `src/worker/pi-agent/events.ts` — translates pi `AgentEvent` → our `Outbound` IPC
- `src/worker/pi-agent/permission-bridge.ts` — beforeToolCall hook that IPC-round-trips permission requests
- `src/worker/pi-agent/tools/peekaboo.ts` — pi `AgentTool` definitions (TypeBox)
- `src/worker/pi-agent/tools/note.ts` — pi `AgentTool` for `note_finding`
- `src/worker/permission-client.ts` — worker-side helper: `requestPermission(args): Promise<decision>` (Outbound + awaited Inbound roundtrip)
- `src/shared/types/permission.ts` — shared types for the worker-side bridge

**Modified:**
- `package.json` — add `@earendil-works/pi-agent-core`, `@earendil-works/pi-ai`; remove `ai`, `@ai-sdk/anthropic`
- `src/worker/handler.ts` — route `task.assign` to `runPiAgent` instead of `runAgent`; route `permission.decision` Inbound into the permission-client awaiter
- `src/worker/index.ts` — feed Inbound messages to both `handleInbound` AND the permission-client (or fold into one handler)

**Deleted:**
- `src/worker/agent.ts` — superseded by `src/worker/pi-agent/index.ts`
- `src/worker/tools/peekaboo.ts` (the AI-SDK-era runPeekaboo) → replaced by the pi tool module that also embeds the CLI subprocess invocation

---

### Task D1: Add pi packages, remove AI SDK packages

**Files:**
- Modify: `package.json`

- [ ] **Step 1: Install pi packages**

```bash
pnpm add @earendil-works/pi-agent-core @earendil-works/pi-ai
```

- [ ] **Step 2: Verify TypeBox is exposed**

pi-ai re-exports TypeBox helpers (`Type`, `Static`, `TSchema`, `StringEnum`) from its main entry. Confirm by:

```bash
node -e "console.log(Object.keys(require('@earendil-works/pi-ai')).filter(k => k === 'Type' || k === 'StringEnum'))"
```

Expected: prints `[ 'Type', 'StringEnum' ]`. If empty, you may need `import { Type } from '@sinclair/typebox'` instead — install `typebox` only if pi-ai doesn't re-export.

- [ ] **Step 3: Run tests with new deps installed**

Run: `pnpm verify`
Expected: still passes (we haven't touched any source yet).

- [ ] **Step 4: Commit (don't remove AI SDK yet — that comes in Task D7 after the migration works)**

```bash
git add package.json pnpm-lock.yaml
git commit -m "build: add pi-agent-core and pi-ai deps"
```

---

### Task D2: Add shared permission-bridge types

**Files:**
- Create: `src/shared/types/permission.ts`

- [ ] **Step 1: Define the request/response payload**

```ts
import { z } from 'zod'

import { RiskSchema } from './ipc'

/**
 * Worker → Main "I need a decision" payload. Sent inside an Outbound
 * `permission.request`. Main resolves it and replies with an Inbound
 * `permission.decision` carrying the same `actionId`.
 */
export const PermissionRequestPayloadSchema = z.object({
  actionId: z.string(),
  taskId: z.string(),
  toolName: z.string(),
  risk: RiskSchema,
  summary: z.string(),
  /** Arbitrary structured args (tool args, file paths, URLs, etc.) */
  payload: z.unknown(),
})
export type PermissionRequestPayload = z.infer<typeof PermissionRequestPayloadSchema>
```

- [ ] **Step 2: Typecheck**

Run: `pnpm typecheck`
Expected: PASS.

- [ ] **Step 3: Commit**

```bash
git add src/shared/types/permission.ts
git commit -m "feat(shared): add permission-bridge payload types"
```

---

### Task D3: Implement worker-side permission-client (IPC roundtrip helper)

**Files:**
- Create: `src/worker/permission-client.ts`
- Create: `src/worker/permission-client.test.ts`

- [ ] **Step 1: Write failing test**

```ts
import { describe, expect, it } from 'vitest'
import { createPermissionClient } from './permission-client'
import type { Outbound } from '@shared/types/ipc'

describe('PermissionClient', () => {
  it('round-trips a request through send + resolve', async () => {
    const sent: Outbound[] = []
    const client = createPermissionClient((m) => sent.push(m))

    const pending = client.request({
      taskId: 't1',
      toolName: 'peekaboo.click',
      risk: 'medium',
      summary: 'click element',
      payload: { id: 'B12' },
    })

    expect(sent).toHaveLength(1)
    expect(sent[0].type).toBe('permission.request')
    if (sent[0].type !== 'permission.request') throw new Error('unreachable')
    const actionId = sent[0].actionId

    client.resolve(actionId, 'grant')
    await expect(pending).resolves.toBe('grant')
  })

  it('rejects unknown actionId resolves silently', () => {
    const client = createPermissionClient(() => {})
    // No throw expected:
    client.resolve('bogus-id', 'grant')
  })

  it('emits a unique actionId per request', () => {
    const sent: Outbound[] = []
    const client = createPermissionClient((m) => sent.push(m))
    client.request({
      taskId: 't1', toolName: 'a', risk: 'low', summary: 's', payload: {},
    })
    client.request({
      taskId: 't1', toolName: 'b', risk: 'low', summary: 's', payload: {},
    })
    const ids = sent
      .filter((m): m is Outbound & { type: 'permission.request' } => m.type === 'permission.request')
      .map((m) => m.actionId)
    expect(new Set(ids).size).toBe(2)
  })
})
```

- [ ] **Step 2: Run test — expect failure**

Run: `pnpm test src/worker/permission-client.test.ts`
Expected: FAIL — module not found.

- [ ] **Step 3: Implement `src/worker/permission-client.ts`**

```ts
import { ulid } from 'ulid'

import type { Outbound } from '@shared/types/ipc'
import type { PermissionDecision } from '@shared/types/ui'
import type { PermissionRequestPayload } from '@shared/types/permission'

export type PermissionClient = {
  /** Send a permission.request Outbound and await the matching decision. */
  request: (req: Omit<PermissionRequestPayload, 'actionId'>) => Promise<PermissionDecision>
  /** Called by the worker entry when a permission.decision Inbound arrives. */
  resolve: (actionId: string, decision: PermissionDecision) => void
}

export function createPermissionClient(send: (msg: Outbound) => void): PermissionClient {
  const pending = new Map<string, (d: PermissionDecision) => void>()

  return {
    request(req) {
      const actionId = ulid()
      return new Promise<PermissionDecision>((resolve) => {
        pending.set(actionId, resolve)
        send({
          type: 'permission.request',
          actionId,
          risk: req.risk,
          summary: req.summary,
          payload: { taskId: req.taskId, toolName: req.toolName, args: req.payload },
        })
      })
    },
    resolve(actionId, decision) {
      const resolver = pending.get(actionId)
      if (!resolver) return
      pending.delete(actionId)
      resolver(decision)
    },
  }
}
```

- [ ] **Step 4: Run test — expect pass**

Run: `pnpm test src/worker/permission-client.test.ts`
Expected: PASS (3 tests).

- [ ] **Step 5: Commit**

```bash
git add src/worker/permission-client.ts src/worker/permission-client.test.ts
git commit -m "feat(worker): permission-client IPC roundtrip helper"
```

---

### Task D4: Wire worker entry to feed permission.decision into the client

**Files:**
- Modify: `src/worker/index.ts`
- Modify: `src/worker/handler.ts`

The current worker entry runs `handleInbound(msg, send)`. We need a second route: when an Inbound `permission.decision` arrives, also call `permissionClient.resolve(actionId, decision)`. Two ways:

1. Inject the permission client into `handleInbound` and have it branch.
2. Add a side-channel handler in `src/worker/index.ts` that runs in parallel.

Pick option 1 — keeps Inbound dispatch in one place.

- [ ] **Step 1: Refactor handler to accept a permission client**

In `src/worker/handler.ts`:

```ts
import type { Inbound, Outbound } from '@shared/types/ipc'

import { createPermissionClient, type PermissionClient } from './permission-client'

export type SendFn = (msg: Outbound) => void

let permissionClient: PermissionClient | null = null

/** Lazily creates a singleton permission client bound to the worker's send. */
function getPermissionClient(send: SendFn): PermissionClient {
  if (!permissionClient) permissionClient = createPermissionClient(send)
  return permissionClient
}

export function handleInbound(msg: Inbound, send: SendFn): void {
  switch (msg.type) {
    case 'task.assign':
      // Implemented in Task D6 — runPiAgent(msg.task, send, { permissionClient: getPermissionClient(send) })
      // For Task D4, leave a stub that falls through to the existing simulator/agent paths.
      return
    case 'permission.decision':
      getPermissionClient(send).resolve(msg.actionId, msg.decision)
      return
    case 'task.cancel':
    case 'tool.result':
    case 'shutdown':
      return
  }
}
```

**Critical:** This leaves `task.assign` unwired until Task D6. Existing tests in `src/worker/handler.test.ts` will break — they expect `task.assign` to kick off the simulator. That's fine because the next task replaces them entirely. Keep the stub in place for now.

- [ ] **Step 2: Disable the old handler test temporarily**

Rename `src/worker/handler.test.ts` → `src/worker/handler.test.ts.disabled` (the test runner's `include` pattern is `**/*.test.ts`, so this is excluded). The pi-agent tests in Task D6 will provide replacement coverage.

```bash
mv src/worker/handler.test.ts src/worker/handler.test.ts.disabled
```

- [ ] **Step 3: Typecheck and run remaining tests**

```bash
pnpm typecheck && pnpm test
```

Expected: PASS. 22 tests instead of 23 (we removed the handler ones).

- [ ] **Step 4: Commit**

```bash
git add src/worker/handler.ts src/worker/handler.test.ts.disabled
git commit -m "feat(worker): route permission.decision through permission-client; stub task.assign"
```

---

### Task D5: Translate Peekaboo tools to pi `AgentTool` (TypeBox)

**Files:**
- Create: `src/worker/pi-agent/tools/peekaboo.ts`
- Create: `src/worker/pi-agent/tools/peekaboo.test.ts`

- [ ] **Step 1: Write failing test**

```ts
import { describe, expect, it } from 'vitest'

import { buildPeekabooTools } from './peekaboo'

describe('peekaboo tools (pi)', () => {
  it('exposes see_screen and list_apps with TypeBox schemas', () => {
    const noopSend = (): void => {}
    const tools = buildPeekabooTools({
      send: noopSend,
      requestPermission: async () => 'grant',
    })

    const names = tools.map((t) => t.name).sort()
    expect(names).toEqual(['list_apps', 'see_screen'])

    const see = tools.find((t) => t.name === 'see_screen')
    expect(see?.label).toBeDefined()
    expect(see?.description).toMatch(/screen|UI/i)
    expect(see?.parameters).toBeDefined()
    // TypeBox schemas expose `properties` on objects
    expect((see?.parameters as { properties?: unknown }).properties).toBeDefined()
  })
})
```

- [ ] **Step 2: Run — expect failure**

```bash
pnpm test src/worker/pi-agent/tools/peekaboo.test.ts
```

- [ ] **Step 3: Implement `src/worker/pi-agent/tools/peekaboo.ts`**

```ts
import { spawn } from 'node:child_process'

import { Type } from '@earendil-works/pi-ai'
import type { AgentTool } from '@earendil-works/pi-agent-core'

import type { Outbound } from '@shared/types/ipc'
import type { PermissionDecision } from '@shared/types/ui'

const PEEKABOO_BIN = process.env.PEEKABOO_BIN ?? 'peekaboo'

type Deps = {
  send: (msg: Outbound) => void
  requestPermission: (args: {
    toolName: string
    risk: 'low' | 'medium' | 'high'
    summary: string
    payload: unknown
  }) => Promise<PermissionDecision>
}

function runCli(args: string[], timeoutMs = 20_000): Promise<{ ok: boolean; stdout: string; stderr: string; code: number | null }> {
  return new Promise((resolve) => {
    const proc = spawn(PEEKABOO_BIN, args, { stdio: ['ignore', 'pipe', 'pipe'] })
    let stdout = ''
    let stderr = ''
    const timer = setTimeout(() => {
      proc.kill('SIGKILL')
      resolve({ ok: false, stdout, stderr: stderr + `\n[timed out after ${timeoutMs}ms]`, code: null })
    }, timeoutMs)
    proc.stdout.on('data', (b: Buffer) => { stdout += b.toString('utf8') })
    proc.stderr.on('data', (b: Buffer) => { stderr += b.toString('utf8') })
    proc.on('error', (err) => {
      clearTimeout(timer)
      resolve({ ok: false, stdout, stderr: stderr + `\nspawn error: ${err.message}`, code: null })
    })
    proc.on('exit', (code) => {
      clearTimeout(timer)
      resolve({ ok: code === 0, stdout, stderr, code })
    })
  })
}

function summariseSeeOutput(stdout: string): string {
  try {
    const parsed = JSON.parse(stdout) as {
      success?: boolean
      error?: { message?: string }
      data?: { screenshot_path?: string; ui_elements?: Array<{ id?: string; role?: string; title?: string; value?: string }> }
    }
    if (parsed.success === false) return `peekaboo see failed: ${parsed.error?.message ?? 'unknown'}`
    const ui = parsed.data?.ui_elements ?? []
    const path = parsed.data?.screenshot_path ?? '(no path)'
    if (ui.length === 0) return `Screenshot at ${path}. No UI elements detected.`
    const top = ui.slice(0, 25).map((el) => {
      const title = el.title ?? el.value ?? ''
      return `  ${el.id ?? '?'} ${el.role ?? '?'}${title ? ': ' + title : ''}`
    })
    return `Screenshot at ${path}. ${ui.length} elements (showing first ${top.length}):\n${top.join('\n')}`
  } catch {
    return stdout.slice(0, 4000)
  }
}

export function buildPeekabooTools(deps: Deps): AgentTool[] {
  const seeScreen: AgentTool = {
    name: 'see_screen',
    label: 'See Screen',
    description:
      'Capture the current screen and return a textual list of UI elements with their Peekaboo IDs. ' +
      'Use this before any interaction that depends on what is on screen.',
    parameters: Type.Object({
      mode: Type.Optional(
        Type.Union(
          [Type.Literal('screen'), Type.Literal('frontmost'), Type.Literal('window')],
          { description: 'Capture target. Default frontmost.' },
        ),
      ),
    }),
    execute: async (_toolCallId, params) => {
      const mode = params.mode ?? 'frontmost'
      const result = await runCli(['see', '--mode', mode, '--json'])
      if (!result.ok) {
        return { content: [{ type: 'text', text: `Error: ${result.stderr || 'peekaboo see failed'}` }], isError: true }
      }
      return { content: [{ type: 'text', text: summariseSeeOutput(result.stdout) }] }
    },
  }

  const listApps: AgentTool = {
    name: 'list_apps',
    label: 'List Running Apps',
    description: 'Enumerate currently running applications and their windows.',
    parameters: Type.Object({}),
    execute: async () => {
      const result = await runCli(['list', 'apps', '--json'])
      if (!result.ok) {
        return { content: [{ type: 'text', text: `Error: ${result.stderr || 'peekaboo list failed'}` }], isError: true }
      }
      return { content: [{ type: 'text', text: result.stdout.slice(0, 4000) }] }
    },
  }

  return [seeScreen, listApps]
}

// `deps` parameter exists so a future high-risk tool (click/type) can call
// deps.requestPermission(...) before executing. Phase D1 keeps only read-only
// tools, so requestPermission is unused yet — keeping it in the signature now
// avoids a breaking change when click/type tools land.
```

- [ ] **Step 4: Run test — expect pass**

```bash
pnpm test src/worker/pi-agent/tools/peekaboo.test.ts
```

Expected: PASS (1 test).

- [ ] **Step 5: Commit**

```bash
git add src/worker/pi-agent/tools/peekaboo.ts src/worker/pi-agent/tools/peekaboo.test.ts
git commit -m "feat(worker/pi-agent): peekaboo AgentTool definitions (TypeBox)"
```

---

### Task D6: Implement event translator + runPiAgent

**Files:**
- Create: `src/worker/pi-agent/events.ts`
- Create: `src/worker/pi-agent/index.ts`
- Create: `src/worker/pi-agent/index.test.ts`

The event translator converts pi `AgentEvent` instances into our `Outbound` IPC messages so the rest of SwarmAgents doesn't have to change.

- [ ] **Step 1: Implement `src/worker/pi-agent/events.ts`**

```ts
import type { AgentEvent } from '@earendil-works/pi-agent-core'

import type { Outbound } from '@shared/types/ipc'
import type { TaskEvent } from '@shared/types/task'

type EmitFn = (out: Outbound) => void

/**
 * Translate one pi AgentEvent into zero or more SwarmAgents Outbound messages.
 *
 * pi event → Outbound mapping:
 *   message_update(text_delta) → progress(llm.message)
 *   tool_execution_start       → progress(tool.call)
 *   tool_execution_end         → progress(tool.result)
 *   agent_end                  → task.complete (with concatenated assistant text)
 *
 * Lifecycle events (agent_start, turn_start, turn_end, message_start, message_end)
 * are intentionally dropped — they're internal to the agent loop and don't add
 * UI value beyond what tool.call/tool.result + llm.message already convey.
 */
export function createEventTranslator(taskId: string, emit: EmitFn): {
  handle: (e: AgentEvent) => void
  getFinalSummary: () => string
} {
  let textBuffer = ''
  let assembledSummary = ''

  const flushText = (): void => {
    if (!textBuffer) return
    assembledSummary += textBuffer
    const event: TaskEvent = {
      kind: 'llm.message',
      role: 'assistant',
      content: textBuffer,
      ts: Date.now(),
    }
    emit({ type: 'progress', event })
    textBuffer = ''
  }

  const handle = (e: AgentEvent): void => {
    switch (e.type) {
      case 'message_update': {
        const msgEvent = e.assistantMessageEvent
        if (msgEvent && msgEvent.type === 'text_delta' && typeof msgEvent.delta === 'string') {
          textBuffer += msgEvent.delta
          if (/[.!?\n]\s*$/.test(textBuffer) || textBuffer.length > 200) flushText()
        }
        return
      }
      case 'tool_execution_start': {
        flushText()
        const event: TaskEvent = {
          kind: 'tool.call',
          server: 'agent',
          tool: e.toolName ?? 'unknown',
          args: e.args ?? {},
          ts: Date.now(),
        }
        emit({ type: 'progress', event })
        return
      }
      case 'tool_execution_end': {
        flushText()
        const ok = !(e.result && (e.result.isError ?? false))
        const payloadText = e.result?.content
          ?.map((c: { type: string; text?: string }) => (c.type === 'text' ? c.text ?? '' : ''))
          .join('') ?? ''
        const event: TaskEvent = {
          kind: 'tool.result',
          ok,
          payload: { kind: 'text', text: payloadText.slice(0, 4000) },
          ts: Date.now(),
        }
        emit({ type: 'progress', event })
        return
      }
      case 'agent_end': {
        flushText()
        const summary = assembledSummary.trim() || `Completed task ${taskId}.`
        emit({
          type: 'task.complete',
          taskId,
          result: { summary, artifacts: [] },
        })
        return
      }
      default:
        // agent_start, turn_start, turn_end, message_start, message_end — drop
        return
    }
  }

  const getFinalSummary = (): string => assembledSummary

  return { handle, getFinalSummary }
}
```

- [ ] **Step 2: Implement `src/worker/pi-agent/index.ts`**

```ts
import { Agent } from '@earendil-works/pi-agent-core'
import { getModel } from '@earendil-works/pi-ai'

import type { Outbound } from '@shared/types/ipc'
import type { Task } from '@shared/types/task'

import type { PermissionClient } from '../permission-client'
import { createEventTranslator } from './events'
import { buildPeekabooTools } from './tools/peekaboo'

type Deps = {
  send: (m: Outbound) => void
  permissionClient: PermissionClient
}

const SYSTEM_PROMPT = `You are SwarmAgents, an autonomous worker agent operating a user's Mac.

You have these tools:
  - see_screen({mode}): capture the screen and get a list of UI elements with Peekaboo IDs.
  - list_apps(): enumerate running apps and their windows.

Workflow:
  1. Read the goal carefully.
  2. If the goal needs visual context, call see_screen first.
  3. If purely informational ("what apps?"), use the matching tool.
  4. Think out loud briefly between tool calls.
  5. Write a one-paragraph summary at the end. Do not loop indefinitely.
  6. If a tool returns an error (e.g. permission denied), explain it in the summary instead of retrying blindly.`

export async function runPiAgent(task: Task, deps: Deps): Promise<void> {
  const apiKey = process.env.ANTHROPIC_API_KEY
  if (!apiKey) {
    deps.send({
      type: 'task.error',
      taskId: task.id,
      error: {
        code: 'missing_api_key',
        message: 'ANTHROPIC_API_KEY env var not set. Set it and restart, or export SWARM_USE_SIMULATOR=1.',
        tier: 'fatal',
      },
    })
    return
  }

  const tools = buildPeekabooTools({
    send: deps.send,
    requestPermission: (args) =>
      deps.permissionClient.request({
        taskId: task.id,
        toolName: args.toolName,
        risk: args.risk,
        summary: args.summary,
        payload: args.payload,
      }),
  })

  const agent = new Agent({
    initialState: {
      systemPrompt: SYSTEM_PROMPT,
      model: getModel('anthropic', 'claude-sonnet-4-5'),
      tools,
      messages: [],
    },
    beforeToolCall: async ({ toolCall, args }) => {
      // Phase D1 has only low-risk read-only tools; deny path stays open for future
      // high-risk tools wired via this hook in Plan E.
      const risk: 'low' | 'medium' | 'high' =
        toolCall.name === 'see_screen' || toolCall.name === 'list_apps' ? 'low' : 'medium'

      if (risk === 'low') return undefined // allow

      const decision = await deps.permissionClient.request({
        taskId: task.id,
        toolName: toolCall.name,
        risk,
        summary: `Run tool: ${toolCall.name}`,
        payload: args,
      })

      if (decision === 'grant') return undefined
      return { block: true, reason: `User ${decision} the action.` }
    },
  })

  const translator = createEventTranslator(task.id, deps.send)
  agent.subscribe((e) => translator.handle(e))

  try {
    await agent.prompt(task.goal)
  } catch (err) {
    deps.send({
      type: 'task.error',
      taskId: task.id,
      error: {
        code: 'agent_exception',
        message: err instanceof Error ? err.message : String(err),
        tier: 'fatal',
      },
    })
  }
}
```

- [ ] **Step 3: Write integration-ish test (no real LLM)**

`src/worker/pi-agent/index.test.ts`:

```ts
import { describe, expect, it } from 'vitest'

import type { Outbound } from '@shared/types/ipc'
import type { Task } from '@shared/types/task'

import { runPiAgent } from './index'

const mkTask = (goal: string): Task => ({
  id: '01HX00000000000000000PIAGT',
  parentId: null,
  goal,
  status: 'dispatched',
  assignedWorkerId: null,
  toolAllowlist: [],
  budget: { tokens: 0, calls: 0, wallMs: 0, usdCents: 0 },
  used: { tokens: 0, calls: 0, wallMs: 0, usdCents: 0 },
  history: [],
  result: null,
  createdAt: 1,
  startedAt: null,
  endedAt: null,
})

describe('runPiAgent', () => {
  it('emits task.error when ANTHROPIC_API_KEY is missing', async () => {
    const original = process.env.ANTHROPIC_API_KEY
    delete process.env.ANTHROPIC_API_KEY
    try {
      const sent: Outbound[] = []
      const send = (m: Outbound): void => {
        sent.push(m)
      }
      await runPiAgent(mkTask('test'), {
        send,
        permissionClient: { request: async () => 'grant', resolve: () => {} },
      })
      const errs = sent.filter((m) => m.type === 'task.error')
      expect(errs).toHaveLength(1)
    } finally {
      if (original !== undefined) process.env.ANTHROPIC_API_KEY = original
    }
  })
})
```

This test covers the no-key path. The real-LLM happy path is not unit-tested here — it requires a network call (use the dev app for manual verification). A future iteration can add a recorded-replay test.

- [ ] **Step 4: Run tests**

```bash
pnpm test src/worker/pi-agent
```

Expected: 2 test files (peekaboo + index), all pass.

- [ ] **Step 5: Commit**

```bash
git add src/worker/pi-agent/events.ts src/worker/pi-agent/index.ts src/worker/pi-agent/index.test.ts
git commit -m "feat(worker/pi-agent): event translator + runPiAgent entry"
```

---

### Task D7: Switch worker handler to runPiAgent

**Files:**
- Modify: `src/worker/handler.ts`

- [ ] **Step 1: Replace the stub task.assign branch**

In `src/worker/handler.ts`, change `task.assign` to:

```ts
case 'task.assign': {
  if (useSimulator) {
    void simulateThinking(msg.task, send)
    return
  }
  void runPiAgent(msg.task, {
    send,
    permissionClient: getPermissionClient(send),
  })
  return
}
```

Add the import:

```ts
import { runPiAgent } from './pi-agent'
```

Keep the `useSimulator` constant and `simulateThinking` import; we keep the simulator fallback for the no-API-key path.

- [ ] **Step 2: Typecheck**

```bash
pnpm typecheck
```

- [ ] **Step 3: Add handler-level test back**

Re-enable the handler tests with updated expectations: `task.assign` now routes to `runPiAgent` when key is set, simulator when not. Reuse the simulator-focused tests from before:

```bash
mv src/worker/handler.test.ts.disabled src/worker/handler.test.ts
```

Edit `src/worker/handler.test.ts`. Remove any assertions that depend on `runAgent` (the old name). Make sure the existing simulator path test still works (it should — `simulateThinking` is unchanged).

If the test file still asserts behavior that no longer exists, simplify to:

```ts
import { describe, expect, it, vi } from 'vitest'

import type { Inbound, Outbound } from '@shared/types/ipc'

import { handleInbound } from './handler'
import { simulateThinking } from './simulator'

type TaskAssign = Extract<Inbound, { type: 'task.assign' }>

const sampleTaskAssign = (goal = 'do a thing'): TaskAssign => ({
  type: 'task.assign',
  task: {
    id: '01HX0000000000000000000000', parentId: null, goal,
    status: 'dispatched', assignedWorkerId: 'w1', toolAllowlist: [],
    budget: { tokens: 0, calls: 0, wallMs: 0, usdCents: 0 },
    used: { tokens: 0, calls: 0, wallMs: 0, usdCents: 0 },
    history: [], result: null, createdAt: 1, startedAt: null, endedAt: null,
  },
  promptContext: '',
})

describe('worker handler', () => {
  it('responds to shutdown by sending no outbound', () => {
    const send = vi.fn()
    handleInbound({ type: 'shutdown' }, send)
    expect(send).not.toHaveBeenCalled()
  })

  it('simulator emits the documented event sequence', async () => {
    const sent: Outbound[] = []
    await simulateThinking(sampleTaskAssign('plan ahead').task, (m) => sent.push(m), {
      stepMs: 0,
    })
    const progressKinds = sent
      .filter((m): m is Outbound & { type: 'progress' } => m.type === 'progress')
      .map((m) => m.event.kind)
    expect(progressKinds).toEqual([
      'llm.message', 'llm.message', 'tool.call', 'tool.result', 'llm.message',
    ])
    expect(sent[sent.length - 1].type).toBe('task.complete')
  })
})
```

- [ ] **Step 4: Run tests**

```bash
pnpm verify
```

Expected: all tests pass.

- [ ] **Step 5: Commit**

```bash
git add src/worker/handler.ts src/worker/handler.test.ts
git commit -m "feat(worker): route task.assign to runPiAgent (simulator fallback unchanged)"
```

---

### Task D8: Remove the old AI-SDK agent files and packages

**Files:**
- Delete: `src/worker/agent.ts`
- Delete: `src/worker/tools/peekaboo.ts` (only if no remaining importers — verify with grep first)
- Modify: `package.json`

- [ ] **Step 1: Confirm nothing references the old agent.ts**

```bash
grep -rn "from './agent'\|from '@worker/agent'\|from './tools/peekaboo'" src/
```

Expected: matches only inside the files we're about to delete. If anything else still imports them, fix that import first.

- [ ] **Step 2: Delete the old files**

```bash
rm src/worker/agent.ts
rm src/worker/tools/peekaboo.ts
rmdir src/worker/tools 2>/dev/null || true
```

- [ ] **Step 3: Remove AI SDK deps**

```bash
pnpm remove ai @ai-sdk/anthropic
```

- [ ] **Step 4: Verify**

```bash
pnpm verify
```

Expected: typecheck + lint + tests all pass.

- [ ] **Step 5: Confirm bundle no longer contains ai-sdk**

```bash
rm -rf out && pnpm build
grep -c "@ai-sdk\|ai-sdk" out/main/index.js out/main/worker.js out/main/chunks/*.js 2>&1
```

Expected: each file reports `0` (or grep exits 1 with "no matches").

- [ ] **Step 6: Commit**

```bash
git add -A
git commit -m "chore: remove ai-sdk packages and pre-pi agent code"
```

---

### Task D9: End-to-end smoke verification

**Files:**
- No source changes.

- [ ] **Step 1: Launch dev**

With a real Anthropic key:

```bash
export ANTHROPIC_API_KEY=sk-ant-...
pnpm dev
```

- [ ] **Step 2: Submit three test goals via the UI**

In the input box:
  1. `"What apps are running?"` → agent should call `list_apps`, summarise.
  2. `"Tell me what's on my screen"` → agent should call `see_screen` (grant Screen Recording permission when prompted by macOS).
  3. `"What's 2+2?"` → no tool call; just a one-paragraph summary.

For each: verify the UI timeline shows pi-translated events (llm.message text, tool.call, tool.result, completion).

- [ ] **Step 3: Without a key — fallback to simulator**

```bash
unset ANTHROPIC_API_KEY
pnpm dev
```

Submit any goal. The UI should show the simulator's deterministic 5-event sequence.

- [ ] **Step 4: Manual concerns to note in the commit / PR**

Document any drift between Plan 1 verification checklist and current state:
- Plan 1 verification checklist still passes? (`pnpm verify` exits 0)
- Bundle sizes (out/main/index.js, worker.js) compared to before
- Any new permission prompts visible at first launch

- [ ] **Step 5: Final commit only if any cleanup is needed**

If no source changes are required after the smoke test, no commit is needed. Otherwise commit fixes with a clear `fix:` message.

---

## Plan D — Verification Checklist

- [ ] `pnpm verify` exits zero
- [ ] `pnpm dev` opens the existing window; with `ANTHROPIC_API_KEY` set, submitting a goal triggers a pi-driven LLM call whose progress events appear in the UI
- [ ] `pnpm build` succeeds; `out/main/index.js` and `out/main/worker.js` no longer reference `@ai-sdk/*` or `ai`
- [ ] `pnpm-lock.yaml` no longer contains `ai-sdk` resolutions
- [ ] All test files for pi modules exist: `permission-client.test.ts`, `pi-agent/tools/peekaboo.test.ts`, `pi-agent/index.test.ts`
- [ ] Worker handler routes `task.assign` to `runPiAgent` (real-LLM path) or `simulateThinking` (no-key fallback)
- [ ] `beforeToolCall` hook is in place in `pi-agent/index.ts` even though Phase D1 only has low-risk tools (the gate path is exercised by the existing PermissionSheet UI for any future medium/high-risk tool)
- [ ] No `// TODO` / `// TBD` / placeholder strings in committed source

If anything fails, fix before declaring the plan complete.

---

## Out of scope for Plan D (deferred to Plan E)

- **Multi-provider UI** — Plan D hardcodes `getModel('anthropic', 'claude-sonnet-4-5')`. Plan E adds settings storage + UI for picking provider/model + key entry. (Brainstorm already approved multi-provider abstraction; pi-ai supports it natively, only the UI is missing.)
- **High-risk Peekaboo tools** (`click_element`, `type_text`, `scroll`, `hotkey`) — the `beforeToolCall` gate is wired now, but the tools that need it aren't built yet. Plan E adds them.
- **Skill loading** (`.swarm/skills/<name>/SKILL.md`) — pi-coding-agent has this built in; SwarmAgents would implement its own loader in Plan E.
- **Cross-provider mid-session handoff** — pi-ai supports it; we don't yet exercise it.
- **Replacing the Peekaboo CLI subprocess with a Peekaboo MCP server** — still Plan 2 territory in the master plan.
- **Recorded-replay LLM tests** — Plan D ships with only the missing-key error path covered. Recorded-replay is a future testing infra task.
- **Removing the simulator** — kept as a no-key fallback. Plan E may move it behind a feature flag rather than the env-var check.
