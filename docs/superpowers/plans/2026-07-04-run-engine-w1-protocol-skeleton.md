# Run-Engine W1 — Protocol v2 + Engine Skeleton Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Land the `run.*` wire-v2 protocol types and the first three run-engine units (`emit.ts`, `retry.ts`, `translator.ts`) with unit tests — new code, unused by the app until W4's switchover.

**Architecture:** Per spec `docs/superpowers/specs/2026-07-04-run-engine-rewrite-design.md` §3/§5. The protocol package gains `types/run.ts` (the `RunWireEvent` union + the single `terminalStatusForRunEvent` rule, bug ledger #9). `apps/desktop/src/service/run-engine/` gains three side-effect-free units: a single-mode emit factory that stamps identity/seq/ts exactly once and never mutates its caller (ledger #13), a pure retry/fallback policy, and a pi→`run.*` translator that emits progress only — terminals are owned by the engine (W2), which kills the double-terminal class (ledger #1) structurally. `engine.ts`/`launch.ts` and all app wiring are W2/W3 — nothing in this plan may be imported from existing app code.

**Tech Stack:** TypeScript, zod-free plain types (matching `ui.ts` style), vitest via Electron-node.

**Spec note:** the spec's W1 bullet mentions "RunRecord keys" — `RunRecord` lives in the renderer (`apply-event.ts`) and renaming it would touch live app code, contradicting W1's new-code-only constraint. Its `runId`/`parentRunId` keys are defined here on `RunWireEvent`; the record rename ships with the W4 renderer pass.

## Global Constraints

- Work in a dedicated worktree on branch `worktree-run-engine-w1`, cut from `develop` (superpowers:using-git-worktrees; verify `git log -1` matches develop's HEAD). Independent of W0 — either merge order works. Integrate via `git rebase develop` + ff-only merge.
- Run tests as `cd apps/desktop && npm test -- <path-filter>` (Electron-node vitest — protocol tests are included via the `../../packages/*/src/**/*.test.ts` glob in `apps/desktop/vitest.config.ts`). NEVER `npx vitest` directly; NEVER `pnpm rebuild better-sqlite3`. Full gate: `npm test` at repo root.
- Format touched files only: `npx biome check --write <file>`. `git add` exact paths; never `git add -A`. Delete stray `**/*.tsbuildinfo` before typechecking if turbo typecheck misbehaves.
- Code comments and commit messages in English. No new dependencies.
- W1 code must have ZERO imports from `apps/desktop/src/service/session/`, `.../conversation/`, or any app module (only `@swarm/protocol`, `@earendil-works/pi-agent-core` types, and sibling run-engine files). The old runner keeps its own copies of the retry constants/helpers until W2 ports `promptOnce` — transitional duplication is deliberate.
- Structured pino logging for the run business path arrives with `engine.ts`/`launch.ts` in W2; W1 units are pure and stay log-free.

---

### Task 1: Protocol v2 — `types/run.ts` (`RunWireEvent` + `terminalStatusForRunEvent`)

**Files:**
- Create: `packages/protocol/src/types/run.ts`
- Create: `packages/protocol/src/types/run.test.ts`
- Modify: `packages/protocol/src/index.ts` (add one export line)

**Interfaces:**
- Consumes: `Risk` from `./ipc`; `Attachment`, `ConsumedResources`, `DelegationItem`, `PlanTodo`, `TaskEvent` from `./task`.
- Produces (used by Tasks 2 and 4, and by W2-W4): `TerminalStatus = 'completed' | 'failed' | 'cancelled'`, `RunErrorInfo`, `RunEventBase`, `RunWireEvent` (11-member union), `terminalStatusForRunEvent(e: { kind: string; error?: unknown }): TerminalStatus | undefined`.

- [ ] **Step 1: Check for export collisions**

Run: `grep -rn "TerminalStatus\|RunWireEvent\|RunErrorInfo" packages/protocol/src/`
Expected: no hits (the desktop's `terminal-registry.ts` has a local `TerminalStatus`, which is fine — different module; W3 unifies them).

- [ ] **Step 2: Write the failing test**

Create `packages/protocol/src/types/run.test.ts`:

```ts
import { describe, expect, it } from 'vitest'

import { terminalStatusForRunEvent } from './run'

describe('terminalStatusForRunEvent — the single event→terminal rule', () => {
  it('maps run.complete to completed', () => {
    expect(terminalStatusForRunEvent({ kind: 'run.complete' })).toBe('completed')
  })

  it('maps run.error with code cancelled to cancelled', () => {
    expect(terminalStatusForRunEvent({ kind: 'run.error', error: { code: 'cancelled' } })).toBe('cancelled')
  })

  it('maps run.error with any other code to failed', () => {
    expect(terminalStatusForRunEvent({ kind: 'run.error', error: { code: 'budget_exhausted' } })).toBe('failed')
  })

  it('maps run.error without a structured error to failed', () => {
    expect(terminalStatusForRunEvent({ kind: 'run.error' })).toBe('failed')
    expect(terminalStatusForRunEvent({ kind: 'run.error', error: 'boom' })).toBe('failed')
  })

  it('returns undefined for every non-terminal kind', () => {
    for (const kind of ['run.created', 'run.dispatched', 'run.progress', 'run.usage', 'run.plan', 'run.spawned']) {
      expect(terminalStatusForRunEvent({ kind })).toBeUndefined()
    }
  })
})
```

- [ ] **Step 3: Run test to verify it fails**

Run: `cd apps/desktop && npm test -- packages/protocol/src/types/run.test.ts`
Expected: FAIL — `Cannot find module './run'` (or equivalent resolve error).

- [ ] **Step 4: Write the implementation**

Create `packages/protocol/src/types/run.ts`:

```ts
import type { Risk } from './ipc'
import type { Attachment, ConsumedResources, DelegationItem, PlanTodo, TaskEvent } from './task'

/**
 * Wire protocol v2: run.* events (run-engine rewrite spec §5).
 *
 * Unused by the app until the W4 switchover — the run-engine emits these
 * natively. session.* / gmail.* events stay on the UIEvent union; at
 * switchover, UIEvent's task.* members are replaced by this union and the
 * persisted task.* rows are migrated by SQL.
 */

export type TerminalStatus = 'completed' | 'failed' | 'cancelled'

export type RunErrorInfo = {
  code: string
  message: string
  tier: 'transient' | 'recoverable' | 'fatal' | 'gave_up'
}

/** Identity + ordering fields, stamped exactly once by the engine's emit factory. */
export type RunEventBase = {
  sessionId: string
  runId: string
  /** Set on child runs; links to the parent for grouped rendering. */
  parentRunId?: string
  /** Session-scoped monotonic order (the replay sort key). */
  seq: number
  ts: number
}

export type RunWireEvent =
  | (RunEventBase & {
      kind: 'run.created'
      goal: string
      attachments?: Attachment[]
      /** Agent definition id (e.g. 'researcher'), labels child-run blocks. */
      agentDefId?: string
    })
  | (RunEventBase & { kind: 'run.dispatched' })
  | (RunEventBase & { kind: 'run.progress'; event: TaskEvent })
  | (RunEventBase & { kind: 'run.tool_call'; tool: string; args: unknown })
  | (RunEventBase & {
      kind: 'run.permission_request'
      actionId: string
      risk: Risk
      summary: string
      payload: unknown
    })
  | (RunEventBase & { kind: 'run.complete'; summary: string })
  | (RunEventBase & { kind: 'run.error'; error: RunErrorInfo })
  | (RunEventBase & {
      kind: 'run.usage'
      used: ConsumedResources
      contextTokens?: number
      contextWindow?: number
      /** Resolved run model id, for per-model usage attribution. */
      model?: string
    })
  | (RunEventBase & { kind: 'run.plan'; todos: PlanTodo[] })
  | (RunEventBase & { kind: 'run.delegation_plan'; plan: DelegationItem[] })
  | (RunEventBase & { kind: 'run.spawned'; childRunId: string })

/**
 * The single source of truth for event→terminal-status (bug ledger #9: three
 * hand-synced copies of this rule drifted once already). The store's boot-scan
 * SQL CASE and the renderer reducer are asserted equivalent to this function
 * by tests when they adopt run.* (W3/W4).
 */
export function terminalStatusForRunEvent(e: { kind: string; error?: unknown }): TerminalStatus | undefined {
  if (e.kind === 'run.complete') return 'completed'
  if (e.kind === 'run.error') {
    const code =
      typeof e.error === 'object' && e.error !== null && 'code' in e.error
        ? (e.error as { code?: unknown }).code
        : undefined
    return code === 'cancelled' ? 'cancelled' : 'failed'
  }
  return undefined
}
```

In `packages/protocol/src/index.ts`, add (keeping alphabetical order, after `export * from './types/provider'`):

```ts
export * from './types/run'
```

- [ ] **Step 5: Run test to verify it passes**

Run: `cd apps/desktop && npm test -- packages/protocol/src/types/run.test.ts`
Expected: PASS (5 tests).

- [ ] **Step 6: Format and commit**

```bash
npx biome check --write packages/protocol/src/types/run.ts packages/protocol/src/types/run.test.ts packages/protocol/src/index.ts
git add packages/protocol/src/types/run.ts packages/protocol/src/types/run.test.ts packages/protocol/src/index.ts
git commit -m "feat(protocol): run.* wire v2 types + terminalStatusForRunEvent

RunWireEvent union per the run-engine rewrite spec §5: runId/parentRunId
keys, no workerId, flat run.complete summary, run.spawned replacing
task.handoff.spawned. terminalStatusForRunEvent is the single
event→terminal rule (ledger #9). Unused by the app until W4."
```

---

### Task 2: `run-engine/emit.ts` — single-mode emit factory

**Files:**
- Create: `apps/desktop/src/service/run-engine/emit.ts`
- Create: `apps/desktop/src/service/run-engine/emit.test.ts`

**Interfaces:**
- Consumes: `RunWireEvent`, `TerminalStatus`, `terminalStatusForRunEvent` from `@swarm/protocol` (Task 1).
- Produces (used by Task 4's translator and by W2's engine/launch):
  - `RunEmitInput` — a `RunWireEvent` minus `sessionId | runId | parentRunId | seq | ts` (distributive over the union).
  - `RunEmit = (input: RunEmitInput) => void`
  - `RunEmitPorts = { nextSeq(sessionId): number; appendEvent(evt: RunWireEvent): void; markTerminal(runId, status: TerminalStatus): void; broadcast(evt: RunWireEvent): void }`
  - `RunIdentity = { sessionId: string; runId: string; parentRunId?: string }`
  - `createRunEmit(ports: RunEmitPorts, ids: RunIdentity): RunEmit`

- [ ] **Step 1: Write the failing test**

Create `apps/desktop/src/service/run-engine/emit.test.ts`:

```ts
import { describe, expect, it, vi } from 'vitest'

import { createRunEmit, type RunEmitPorts } from './emit'

const makePorts = (): { [K in keyof RunEmitPorts]: ReturnType<typeof vi.fn> } => ({
  nextSeq: vi.fn().mockReturnValueOnce(7).mockReturnValue(8),
  appendEvent: vi.fn(),
  markTerminal: vi.fn(),
  broadcast: vi.fn(),
})

describe('createRunEmit', () => {
  it('stamps sessionId/runId/seq/ts exactly once and hands the SAME object to append and broadcast', () => {
    const ports = makePorts()
    const emit = createRunEmit(ports, { sessionId: 's1', runId: 'r1' })

    emit({ kind: 'run.dispatched' })

    expect(ports.nextSeq).toHaveBeenCalledTimes(1)
    expect(ports.nextSeq).toHaveBeenCalledWith('s1')
    const appended = ports.appendEvent.mock.calls[0][0]
    expect(appended).toMatchObject({ kind: 'run.dispatched', sessionId: 's1', runId: 'r1', seq: 7 })
    expect(typeof appended.ts).toBe('number')
    expect(ports.broadcast.mock.calls[0][0]).toBe(appended)
  })

  it('never mutates the caller input (ledger #13 regression)', () => {
    const ports = makePorts()
    const emit = createRunEmit(ports, { sessionId: 's1', runId: 'r1' })
    const innerEvent = { kind: 'llm.message' as const, role: 'assistant' as const, content: 'hi', ts: 1 }
    const input = { kind: 'run.progress' as const, event: innerEvent }
    Object.freeze(input)
    Object.freeze(innerEvent)

    expect(() => emit(input)).not.toThrow() // a mutation of a frozen object throws in strict mode
    expect(input).toEqual({ kind: 'run.progress', event: { kind: 'llm.message', role: 'assistant', content: 'hi', ts: 1 } })
  })

  it('stamps seq onto a CLONE of the inner progress event so replay ordering travels with it', () => {
    const ports = makePorts()
    const emit = createRunEmit(ports, { sessionId: 's1', runId: 'r1' })
    const innerEvent = { kind: 'llm.message' as const, role: 'assistant' as const, content: 'hi', ts: 1 }

    emit({ kind: 'run.progress', event: innerEvent })

    const appended = ports.appendEvent.mock.calls[0][0]
    expect(appended.event).not.toBe(innerEvent)
    expect(appended.event.seq).toBe(7)
    expect(innerEvent).not.toHaveProperty('seq')
  })

  it('marks the terminal registry for run.complete and run.error only, with the mapped status', () => {
    const ports = makePorts()
    const emit = createRunEmit(ports, { sessionId: 's1', runId: 'r1' })

    emit({ kind: 'run.progress', event: { kind: 'reasoning', content: 'x', ts: 1 } })
    expect(ports.markTerminal).not.toHaveBeenCalled()

    emit({ kind: 'run.complete', summary: 'done' })
    expect(ports.markTerminal).toHaveBeenCalledWith('r1', 'completed')

    emit({ kind: 'run.error', error: { code: 'cancelled', message: 'Stopped by user.', tier: 'gave_up' } })
    expect(ports.markTerminal).toHaveBeenCalledWith('r1', 'cancelled')
  })

  it('includes parentRunId on every event when the identity carries one, and omits it otherwise', () => {
    const ports = makePorts()
    createRunEmit(ports, { sessionId: 's1', runId: 'child', parentRunId: 'parent' })({ kind: 'run.dispatched' })
    expect(ports.appendEvent.mock.calls[0][0].parentRunId).toBe('parent')

    const ports2 = makePorts()
    createRunEmit(ports2, { sessionId: 's1', runId: 'top' })({ kind: 'run.dispatched' })
    expect('parentRunId' in ports2.appendEvent.mock.calls[0][0]).toBe(false)
  })
})
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd apps/desktop && npm test -- src/service/run-engine/emit.test.ts`
Expected: FAIL — cannot resolve `./emit`.

- [ ] **Step 3: Write the implementation**

Create `apps/desktop/src/service/run-engine/emit.ts`:

```ts
import { type RunWireEvent, type TerminalStatus, terminalStatusForRunEvent } from '@swarm/protocol'

// Omit that distributes over a union (plain Omit collapses union members).
type DistributiveOmit<T, K extends PropertyKey> = T extends unknown ? Omit<T, K> : never

/** A run.* event as authored at a call site — identity/ordering fields are
 *  stamped here, exactly once. */
export type RunEmitInput = DistributiveOmit<RunWireEvent, 'sessionId' | 'runId' | 'parentRunId' | 'seq' | 'ts'>

export type RunEmit = (input: RunEmitInput) => void

/** Ports bound by the launch layer (W3: seq-counter, run_events store,
 *  terminal registry, broadcaster) or by out-of-session callers like
 *  gmail-analyze with their own sinks. */
export type RunEmitPorts = {
  nextSeq(sessionId: string): number
  appendEvent(evt: RunWireEvent): void
  markTerminal(runId: string, status: TerminalStatus): void
  broadcast(evt: RunWireEvent): void
}

export type RunIdentity = { sessionId: string; runId: string; parentRunId?: string }

/**
 * The ONE emit path for a run (spec §3): stamps identity + seq + ts, persists,
 * marks the first-wins terminal registry, broadcasts. Unlike the v1 factory it
 * has a single identity mode (no payload sniffing) and never mutates caller
 * objects (ledger #13) — the inner progress event is cloned to carry its seq.
 */
export function createRunEmit(ports: RunEmitPorts, ids: RunIdentity): RunEmit {
  return (input) => {
    const seq = ports.nextSeq(ids.sessionId)
    const ts = Date.now()
    const inner =
      'event' in input && input.event && typeof input.event === 'object' ? { event: { ...input.event, seq } } : undefined
    const evt = {
      ...input,
      ...(inner ?? {}),
      sessionId: ids.sessionId,
      runId: ids.runId,
      ...(ids.parentRunId !== undefined ? { parentRunId: ids.parentRunId } : {}),
      seq,
      ts,
    } as RunWireEvent
    ports.appendEvent(evt)
    const term = terminalStatusForRunEvent(evt)
    if (term) ports.markTerminal(ids.runId, term)
    ports.broadcast(evt)
  }
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `cd apps/desktop && npm test -- src/service/run-engine/emit.test.ts`
Expected: PASS (5 tests).

- [ ] **Step 5: Format and commit**

```bash
npx biome check --write apps/desktop/src/service/run-engine/emit.ts apps/desktop/src/service/run-engine/emit.test.ts
git add apps/desktop/src/service/run-engine/emit.ts apps/desktop/src/service/run-engine/emit.test.ts
git commit -m "feat(run-engine): createRunEmit — single-mode emit factory

Stamps identity/seq/ts exactly once, persists, marks the first-wins
terminal registry via terminalStatusForRunEvent, broadcasts. No payload
sniffing and no caller mutation (ledger #13). Ports are injected; W3
binds seq-counter/store/registry/broadcaster."
```

---

### Task 3: `run-engine/retry.ts` — pure retry/fallback policy

**Files:**
- Create: `apps/desktop/src/service/run-engine/retry.ts`
- Create: `apps/desktop/src/service/run-engine/retry.test.ts`

**Interfaces:**
- Consumes: nothing project-internal (pure module).
- Produces (used by W2's engine): `MAX_PROMPT_RETRIES = 10`, `RETRY_DELAY_MS = 5000`, `isPermanentModelFailure(message: string): boolean`, `abortableDelay(ms: number, signal?: AbortSignal): Promise<void>`, `RetryDecision = 'retry-same-model' | 'advance-model' | 'give-up'`, `AttemptContext = { attempt: number; maxRetries: number; modelIdx: number; chainLength: number; permanent: boolean }`, `decideNextAttempt(c: AttemptContext): RetryDecision`.
- Note: `agent-runner.ts` keeps its own private copies until W2 ports `promptOnce`; do NOT modify the old runner in this task.

- [ ] **Step 1: Write the failing test**

Create `apps/desktop/src/service/run-engine/retry.test.ts`:

```ts
import { describe, expect, it } from 'vitest'

import { abortableDelay, decideNextAttempt, isPermanentModelFailure } from './retry'

describe('decideNextAttempt — mirrors the v1 promptOnce loop semantics', () => {
  const base = { attempt: 0, maxRetries: 2, modelIdx: 0, chainLength: 2, permanent: false }

  it('retries the same model while transient attempts remain', () => {
    expect(decideNextAttempt({ ...base })).toBe('retry-same-model')
    expect(decideNextAttempt({ ...base, attempt: 1 })).toBe('retry-same-model')
  })

  it('advances to the next model when retries are exhausted', () => {
    expect(decideNextAttempt({ ...base, attempt: 2 })).toBe('advance-model')
  })

  it('advances immediately on a permanent failure, without burning retries', () => {
    expect(decideNextAttempt({ ...base, permanent: true })).toBe('advance-model')
  })

  it('gives up when the last model exhausts its retries', () => {
    expect(decideNextAttempt({ ...base, attempt: 2, modelIdx: 1 })).toBe('give-up')
  })

  it('gives up on a permanent failure on the last model', () => {
    expect(decideNextAttempt({ ...base, permanent: true, modelIdx: 1 })).toBe('give-up')
  })

  it('single-model chain: retry then give-up, never advance', () => {
    expect(decideNextAttempt({ ...base, chainLength: 1 })).toBe('retry-same-model')
    expect(decideNextAttempt({ ...base, chainLength: 1, attempt: 2 })).toBe('give-up')
    expect(decideNextAttempt({ ...base, chainLength: 1, permanent: true })).toBe('give-up')
  })
})

describe('isPermanentModelFailure', () => {
  it.each(['401 Unauthorized', 'invalid api key', 'invalid_api_key provided', 'model not found', 'No such model: x', 'insufficient_quota', 'billing hard limit', 'permission denied', '404'])(
    'treats %s as permanent',
    (msg) => expect(isPermanentModelFailure(msg)).toBe(true)
  )

  it.each(['503 Service Unavailable', 'connection reset', 'timeout awaiting response', 'rate limited, retry soon', 'overloaded_error'])(
    'treats %s as transient',
    (msg) => expect(isPermanentModelFailure(msg)).toBe(false)
  )
})

describe('abortableDelay', () => {
  it('resolves immediately when the signal is already aborted', async () => {
    const ac = new AbortController()
    ac.abort()
    const t0 = Date.now()
    await abortableDelay(60_000, ac.signal)
    expect(Date.now() - t0).toBeLessThan(1_000)
  })

  it('resolves early when the signal fires during the wait', async () => {
    const ac = new AbortController()
    const t0 = Date.now()
    const p = abortableDelay(60_000, ac.signal)
    setTimeout(() => ac.abort(), 10)
    await p
    expect(Date.now() - t0).toBeLessThan(5_000)
  })
})
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd apps/desktop && npm test -- src/service/run-engine/retry.test.ts`
Expected: FAIL — cannot resolve `./retry`.

- [ ] **Step 3: Write the implementation**

Create `apps/desktop/src/service/run-engine/retry.ts` (the helpers are ports of the v1 runner's, verbatim semantics; the loop decision is extracted as a pure function so W2's engine owns only the loop mechanics):

```ts
// Transient-failure retry + model-chain fallback policy for the run engine.
// Pure decisions live here; the engine (W2) owns the loop, the delays, and the
// transcript restore between attempts.

/** A failed request is retried up to this many EXTRA times per model. */
export const MAX_PROMPT_RETRIES = 10
export const RETRY_DELAY_MS = 5_000

/**
 * Failures where retrying the SAME model is pointless — advance the chain (or
 * give up) immediately instead of burning retries on a dead key, a missing
 * model, or an exhausted quota. Anything not matched (timeouts, 5xx, rate
 * limits, transport resets) is transient and retried in place.
 */
export function isPermanentModelFailure(message: string): boolean {
  return /\b(401|403|404)\b|invalid[\s_-]?api[\s_-]?key|unauthor|authentication|permission denied|model not found|no such model|does not exist|insufficient[\s_-]?quota|billing/i.test(
    message
  )
}

/** Sleep that resolves early if `signal` aborts, so a queued retry never
 *  delays a user cancellation. */
export function abortableDelay(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve) => {
    if (signal?.aborted) {
      resolve()
      return
    }
    const onAbort = (): void => {
      clearTimeout(timer)
      resolve()
    }
    const timer = setTimeout(() => {
      signal?.removeEventListener('abort', onAbort)
      resolve()
    }, ms)
    timer.unref?.()
    signal?.addEventListener('abort', onAbort, { once: true })
  })
}

export type RetryDecision = 'retry-same-model' | 'advance-model' | 'give-up'

export type AttemptContext = {
  /** 0-based attempt index on the current model. */
  attempt: number
  /** Extra attempts allowed per model (total attempts = maxRetries + 1). */
  maxRetries: number
  /** 0-based index of the current model in the fallback chain. */
  modelIdx: number
  chainLength: number
  /** Permanent failures skip the remaining retries on this model. */
  permanent: boolean
}

/** What to do after a FAILED attempt. Deliberate stops (cancel/budget/context/
 *  iterations) never reach this — they terminate the run outright. */
export function decideNextAttempt(c: AttemptContext): RetryDecision {
  const lastAttempt = c.attempt >= c.maxRetries
  const lastModel = c.modelIdx >= c.chainLength - 1
  if (!lastAttempt && !c.permanent) return 'retry-same-model'
  if (!lastModel) return 'advance-model'
  return 'give-up'
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `cd apps/desktop && npm test -- src/service/run-engine/retry.test.ts`
Expected: PASS.

- [ ] **Step 5: Format and commit**

```bash
npx biome check --write apps/desktop/src/service/run-engine/retry.ts apps/desktop/src/service/run-engine/retry.test.ts
git add apps/desktop/src/service/run-engine/retry.ts apps/desktop/src/service/run-engine/retry.test.ts
git commit -m "feat(run-engine): retry policy module

Pure decideNextAttempt (retry / advance-model / give-up) mirroring the
v1 promptOnce loop semantics, plus ports of isPermanentModelFailure and
abortableDelay. The old runner keeps its private copies until W2."
```

---

### Task 4: `run-engine/translator.ts` — pi → `run.*` translator (progress-only, terminal-free)

**Files:**
- Create: `apps/desktop/src/service/run-engine/translator.ts`
- Create: `apps/desktop/src/service/run-engine/translator.test.ts`

**Interfaces:**
- Consumes: `RunEmit`/`RunEmitInput` (Task 2), `createRunEmit` (in tests), `TaskEvent` from `@swarm/protocol`, `AgentEvent` type from `@earendil-works/pi-agent-core`.
- Produces (used by W2's engine):
  - `TranslatorOutcome = { summary: string; errorMessage: string | null; sawAborted: boolean }`
  - `RunTranslator = { handle(e: AgentEvent): void; outcome(): TranslatorOutcome; resetTurn(): void }`
  - `createRunTranslator(emit: RunEmit): RunTranslator`
- Contract: the translator NEVER emits `run.complete`/`run.error`/`run.usage` — W2's engine reads `outcome()` after `prompt()` resolves and emits the run's SINGLE terminal (kills ledger #1 structurally; usage stays with the engine's `turn_end` subscription). Unlike the v1 translator, `resetTurn()` also clears `summary`, so each attempt's outcome is self-contained (v1 accumulated partial text across retries).

- [ ] **Step 1: Write the failing test**

Create `apps/desktop/src/service/run-engine/translator.test.ts`:

```ts
import { describe, expect, it } from 'vitest'

import type { RunEmitInput } from './emit'
import { createRunTranslator } from './translator'

const collect = (): { out: RunEmitInput[]; emit: (i: RunEmitInput) => void } => {
  const out: RunEmitInput[] = []
  return { out, emit: (i) => out.push(i) }
}

const textDelta = (delta: string) => ({ type: 'message_update', assistantMessageEvent: { type: 'text_delta', delta } })
const thinkingDelta = (delta: string) => ({
  type: 'message_update',
  assistantMessageEvent: { type: 'thinking_delta', delta },
})

describe('createRunTranslator', () => {
  it('buffers text deltas and flushes at a sentence boundary as run.progress llm.message', () => {
    const { out, emit } = collect()
    const t = createRunTranslator(emit)

    t.handle(textDelta('Hello ') as never)
    expect(out).toHaveLength(0) // no boundary yet
    t.handle(textDelta('world.') as never)

    expect(out).toHaveLength(1)
    expect(out[0]).toMatchObject({ kind: 'run.progress', event: { kind: 'llm.message', content: 'Hello world.' } })
    expect(t.outcome().summary).toBe('Hello world.')
  })

  it('flushes thinking before text so reasoning precedes the answer', () => {
    const { out, emit } = collect()
    const t = createRunTranslator(emit)

    t.handle(thinkingDelta('pondering...') as never)
    t.handle(textDelta('Answer.') as never)

    expect(out.map((e) => (e as { event: { kind: string } }).event.kind)).toEqual(['reasoning', 'llm.message'])
  })

  it('emits tool.call / tool.result progress with callId correlation', () => {
    const { out, emit } = collect()
    const t = createRunTranslator(emit)

    t.handle({ type: 'tool_execution_start', toolName: 'read_file', args: { p: 1 }, toolCallId: 'c1' } as never)
    t.handle({
      type: 'tool_execution_end',
      toolName: 'read_file',
      toolCallId: 'c1',
      isError: false,
      result: { content: [{ type: 'text', text: 'ok' }] },
    } as never)

    expect(out[0]).toMatchObject({ kind: 'run.progress', event: { kind: 'tool.call', tool: 'read_file', callId: 'c1' } })
    expect(out[1]).toMatchObject({
      kind: 'run.progress',
      event: { kind: 'tool.result', ok: true, callId: 'c1', payload: { kind: 'text', text: 'ok' } },
    })
  })

  it('surfaces update_plan structured todos as run.plan', () => {
    const { out, emit } = collect()
    const t = createRunTranslator(emit)
    const todos = [{ content: 'a', status: 'pending' }]

    t.handle({
      type: 'tool_execution_end',
      toolName: 'update_plan',
      isError: false,
      result: { content: [{ type: 'text', text: 'Plan' }], details: { todos } },
    } as never)

    expect(out.some((e) => e.kind === 'run.plan' && (e as { todos: unknown }).todos === todos)).toBe(true)
  })

  it('NEVER emits a terminal: a clean agent_end yields progress only + a clean outcome', () => {
    const { out, emit } = collect()
    const t = createRunTranslator(emit)

    t.handle(textDelta('done.') as never)
    t.handle({ type: 'agent_end', messages: [{ role: 'assistant', stopReason: 'end_turn' }] } as never)

    expect(out.every((e) => e.kind === 'run.progress' || e.kind === 'run.plan')).toBe(true)
    expect(t.outcome()).toEqual({ summary: 'done.', errorMessage: null, sawAborted: false })
  })

  it('captures a request failure (stopReason error) into the outcome without emitting run.error', () => {
    const { out, emit } = collect()
    const t = createRunTranslator(emit)

    t.handle({ type: 'message_end', message: { stopReason: 'error', errorMessage: 'boom 503' } } as never)
    t.handle({ type: 'agent_end', messages: [{ role: 'assistant', stopReason: 'error', errorMessage: 'boom 503' }] } as never)

    expect(t.outcome().errorMessage).toBe('boom 503')
    expect(out.filter((e) => e.kind !== 'run.progress' && e.kind !== 'run.plan')).toHaveLength(0)
  })

  it('records an aborted turn into the outcome and stays silent', () => {
    const { out, emit } = collect()
    const t = createRunTranslator(emit)

    t.handle({ type: 'agent_end', messages: [{ role: 'assistant', stopReason: 'aborted' }] } as never)

    expect(t.outcome().sawAborted).toBe(true)
    expect(out).toHaveLength(0)
  })

  it('resetTurn clears summary, error, and aborted for the next attempt', () => {
    const { emit } = collect()
    const t = createRunTranslator(emit)

    t.handle(textDelta('partial.') as never)
    t.handle({ type: 'agent_end', messages: [{ role: 'assistant', stopReason: 'error', errorMessage: 'x' }] } as never)
    t.resetTurn()

    expect(t.outcome()).toEqual({ summary: '', errorMessage: null, sawAborted: false })
  })
})
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd apps/desktop && npm test -- src/service/run-engine/translator.test.ts`
Expected: FAIL — cannot resolve `./translator`.

- [ ] **Step 3: Write the implementation**

Create `apps/desktop/src/service/run-engine/translator.ts` (a port of the v1 `createEventTranslator` with terminals removed — the buffering/flush thresholds and payload shapes are kept verbatim so W2's behavior parity tests can reuse v1 fixtures):

```ts
import type { AgentEvent } from '@earendil-works/pi-agent-core'
import type { PlanTodo, TaskEvent } from '@swarm/protocol'

import type { RunEmit } from './emit'

/** Per-attempt outcome collected from pi's event stream. The engine — not the
 *  translator — turns this into the run's SINGLE terminal event. */
export type TranslatorOutcome = {
  /** Assembled assistant text for this attempt (the summary candidate). */
  summary: string
  /** pi delivered a request failure (an assistant message with stopReason 'error'). */
  errorMessage: string | null
  /** pi ended an aborted turn (stopReason 'aborted'): cancel/budget/context/iterations. */
  sawAborted: boolean
}

export type RunTranslator = {
  handle(e: AgentEvent): void
  outcome(): TranslatorOutcome
  /** Reset per-attempt state before a retry or a new resident-style turn. */
  resetTurn(): void
}

/**
 * Adapts pi AgentEvents to run.* progress emits:
 *   message_update(text_delta)     → run.progress llm.message (buffered; flushed
 *                                    at sentence boundaries or 200 chars)
 *   message_update(thinking_delta) → run.progress reasoning (same buffering)
 *   tool_execution_start/end       → run.progress tool.call / tool.result
 *   update_plan tool result        → run.plan
 *
 * It emits NO terminal and NO usage: pi does not throw on request failure —
 * the failure rides the event stream as stopReason 'error'/'aborted', which is
 * captured into outcome() for the engine's terminal decision.
 */
export function createRunTranslator(emit: RunEmit): RunTranslator {
  let textBuffer = ''
  let thinkingBuffer = ''
  let assembledSummary = ''
  let errorMessage: string | null = null
  let sawAborted = false

  const flushText = (): void => {
    if (!textBuffer) return
    assembledSummary += textBuffer
    const event: TaskEvent = { kind: 'llm.message', role: 'assistant', content: textBuffer, ts: Date.now() }
    emit({ kind: 'run.progress', event })
    textBuffer = ''
  }

  const flushThinking = (): void => {
    if (!thinkingBuffer) return
    const event: TaskEvent = { kind: 'reasoning', content: thinkingBuffer, ts: Date.now() }
    emit({ kind: 'run.progress', event })
    thinkingBuffer = ''
  }

  const captureStop = (m: { stopReason?: string; errorMessage?: string } | undefined): void => {
    if (m?.stopReason === 'error') {
      errorMessage = m.errorMessage ?? 'The model request failed without a message.'
    } else if (m?.stopReason === 'aborted') {
      sawAborted = true
    }
  }

  const handle = (e: AgentEvent): void => {
    if ('message' in e) captureStop((e as { message?: { stopReason?: string; errorMessage?: string } }).message)

    switch (e.type) {
      case 'message_update': {
        const inner = e.assistantMessageEvent
        if (inner && inner.type === 'thinking_delta' && typeof inner.delta === 'string') {
          thinkingBuffer += inner.delta
          if (/[.!?\n]\s*$/.test(thinkingBuffer) || thinkingBuffer.length > 200) flushThinking()
        } else if (inner && inner.type === 'text_delta' && typeof inner.delta === 'string') {
          // Reasoning always precedes the answer; flush it so the panel settles first.
          flushThinking()
          textBuffer += inner.delta
          if (/[.!?\n]\s*$/.test(textBuffer) || textBuffer.length > 200) flushText()
        }
        return
      }
      case 'tool_execution_start': {
        flushThinking()
        flushText()
        const event: TaskEvent = {
          kind: 'tool.call',
          server: 'agent',
          tool: e.toolName ?? 'unknown',
          args: e.args ?? {},
          ts: Date.now(),
          // Correlates start/end so parallel tool results pair with the right call.
          callId: e.toolCallId,
        }
        emit({ kind: 'run.progress', event })
        return
      }
      case 'tool_execution_end': {
        flushText()
        const ok = !e.isError
        const result = e.result as
          | {
              content?: Array<{ type: string; text?: string }>
              details?: { todos?: unknown; screenshotPath?: unknown }
            }
          | undefined
        if (e.toolName === 'update_plan' && Array.isArray(result?.details?.todos)) {
          emit({ kind: 'run.plan', todos: result.details.todos as PlanTodo[] })
        }
        const imagePath =
          typeof result?.details?.screenshotPath === 'string' ? result.details.screenshotPath : undefined
        const payloadText = result?.content?.map((c) => (c.type === 'text' ? (c.text ?? '') : '')).join('') ?? ''
        const event: TaskEvent = {
          kind: 'tool.result',
          ok,
          payload: { kind: 'text', text: payloadText.slice(0, 4000), ...(imagePath ? { imagePath } : {}) },
          ts: Date.now(),
          callId: e.toolCallId,
        }
        emit({ kind: 'run.progress', event })
        return
      }
      case 'agent_end': {
        flushThinking()
        flushText()
        // agent_end is pi's last event even on a failed/aborted run; its
        // messages re-carry the stop, in case message_end was never seen.
        for (const m of e.messages ?? []) captureStop(m as { stopReason?: string; errorMessage?: string })
        return
      }
      default:
        return
    }
  }

  return {
    handle,
    outcome: () => ({ summary: assembledSummary.trim(), errorMessage, sawAborted }),
    resetTurn: () => {
      textBuffer = ''
      thinkingBuffer = ''
      assembledSummary = ''
      errorMessage = null
      sawAborted = false
    },
  }
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `cd apps/desktop && npm test -- src/service/run-engine/translator.test.ts`
Expected: PASS (8 tests).

- [ ] **Step 5: Format and commit**

```bash
npx biome check --write apps/desktop/src/service/run-engine/translator.ts apps/desktop/src/service/run-engine/translator.test.ts
git add apps/desktop/src/service/run-engine/translator.ts apps/desktop/src/service/run-engine/translator.test.ts
git commit -m "feat(run-engine): pi→run.* translator — progress-only, terminal-free

Port of the v1 event translator with terminal emission removed: the
engine reads outcome() (summary / errorMessage / sawAborted) and emits
the run's single terminal, killing the double-terminal class (ledger #1)
by construction. resetTurn clears summary too, so each attempt's outcome
is self-contained."
```

---

### Task 5: Full gate and integration

**Files:** none (verification + merge).

**Interfaces:**
- Consumes: the four commits above.
- Produces: `worktree-run-engine-w1` merged into `develop` (ff-only); W2 (engine.ts + launch.ts port) builds on these exports.

- [ ] **Step 1: Full test gate**

Run at the repo root: `npm test`
Expected: all packages green — including the untouched old-runner suites (this plan added files only; the sole modified file is `packages/protocol/src/index.ts`).

- [ ] **Step 2: Confirm the no-app-imports constraint**

Run: `grep -rn "run-engine" apps/desktop/src --include="*.ts" -l | grep -v "src/service/run-engine/"`
Expected: no output (nothing outside the module imports it yet).

- [ ] **Step 3: Integrate (superpowers:finishing-a-development-branch)**

```bash
git -C <main-checkout> status   # must be clean (house rule)
git rebase develop
git checkout develop && git merge --ff-only worktree-run-engine-w1
```

Remove the worktree; if `pnpm install` ran inside it, repair main's symlinks: `CI=true pnpm --dir <main-checkout> install --frozen-lockfile`.

---

## Forward pointer

W2 (next plan, written after W1 lands): `engine.ts` (pi Agent construction + gates ported from `buildAgentSession`, consuming `retry.ts` + `translator.ts`, emitting the single terminal + `run.usage`) and `launch.ts` (RunSpec table, abort-before-slot, slot release during delegate). W2's behavior-parity tests port the v1 suites (`agent-runner.test.ts`, `.retry/.fallback/.prompt-error/.context/.session`).
