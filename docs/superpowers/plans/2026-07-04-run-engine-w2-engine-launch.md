# Run-Engine W2 — Engine + Launch Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Land `run-engine/models.ts`, `engine.ts`, and `launch.ts` — the executable core of the new run engine — with behavior-parity tests. New code, still unused by the app (W3 binds SessionService; W4 switches over).

**Architecture:** Per spec `docs/superpowers/specs/2026-07-04-run-engine-rewrite-design.md` §3/§4 and its §7 footnotes (W2 carry-overs). `engine.ts` is the port of v1 `buildAgentSession`/`promptOnce` (apps/desktop/src/service/session/agent-runner.ts:617-1199) rebuilt on the W1 units: the terminal-free translator streams progress, `retry.ts` decides attempt outcomes, and the engine emits THE single terminal per run (ledger #1 killed structurally). `launch.ts` is the ONE way any run starts (spec §3): mint → `run.created` → abort registration BEFORE any wait (ledger #4) → turn ticket → slot → `run.dispatched` → uniform tool-context assembly (ledger #11/#12 fixed: messaging throws instead of faking success; `setDelegationPlan` wired for every run) → engine → cleanup. The parent's slot is released while a delegate call blocks (ledger #5). Setup failures THROW (`EngineSetupError`) and launch emits the terminal — the v1 `failedSession` fake-`Agent` double cast dies. `models.ts` extracts model resolution so `engine.ts` stays under control.

**Tech Stack:** TypeScript, pi-agent-core (mocked in engine/launch tests exactly like the v1 suites), real pi-ai catalog in models tests, vitest via Electron-node, pino logging (`component: 'run-engine'`).

## Global Constraints

- Work in a dedicated worktree on branch `worktree-run-engine-w2`, cut from `develop` (superpowers:using-git-worktrees; verify `git log -1` matches develop's HEAD). Integrate via `git rebase develop` + ff-only merge.
- Run tests as `cd apps/desktop && npm test -- <path-filter>` (Electron-node vitest). NEVER `npx vitest`, NEVER `pnpm rebuild better-sqlite3`, and NEVER invoke pnpm/turbo at the worktree root (`npm test` at root shells out to pnpm and corrupts main's node_modules through the symlinks — verified 2026-07-04). Full gate = full desktop suite via npm inside `apps/desktop`.
- Format touched files only: `npx biome check --write <file>`. `git add` exact paths; never `git add -A`.
- Code comments and commit messages in English. No new dependencies (`ulid` is already a dependency).
- Import rules for run-engine (relaxed from W1, per spec §3 ports): `@swarm/protocol`, `@earendil-works/pi-agent-core`, `@earendil-works/pi-ai`, `@swarm/shared`, `@shared/logger`, `ulid`, sibling `./` files, PLUS **type-only** imports from `../tools/registry` (`ToolRegistry`, `ToolRunContext`, `ToolRisk`) and `../session/permission-registry` (`PermissionRegistry`) — these are the injected ports' type surfaces. NO runtime imports from any app module, and nothing else from `../session/` or `../conversation/`.
- Do NOT modify `agent-runner.ts`, `manager.ts`, or any existing app file. The old runner keeps running the app until W4.
- Logging is required (CLAUDE.md §5): engine/launch are business paths — entry/outcome at `info` with `runId`/`sessionId`, every catch at `error`, gates/fallbacks at `warn`, per-event noise at `debug`. Match `agent-runner.ts` call-site shapes.
- Interfaces consumed from W1 (verbatim, already on develop): `createRunEmit(ports: RunEmitPorts, ids: RunIdentity): RunEmit` and `RunEmitInput` from `./emit`; `createRunTranslator(emit: RunEmit): RunTranslator` with `outcome(): { summary; errorMessage; sawAborted }` and `resetTurn()` from `./translator`; `MAX_PROMPT_RETRIES`, `RETRY_DELAY_MS`, `isPermanentModelFailure`, `abortableDelay`, `decideNextAttempt` from `./retry`; `RunWireEvent` kinds from `@swarm/protocol`.

---

### Task 1: `run-engine/models.ts` — model resolution + system-prompt composition

**Files:**
- Create: `apps/desktop/src/service/run-engine/models.ts`
- Create: `apps/desktop/src/service/run-engine/models.test.ts`

**Interfaces:**
- Consumes: `@earendil-works/pi-ai` (`Api`, `Model`, `KnownProvider`, catalog via `@earendil-works/pi-ai/providers/all`), `@swarm/protocol` (`ANTHROPIC_MODEL_SUGGESTIONS`, `OPENAI_MODEL_SUGGESTIONS`, `ApiStyle`, `DEFAULT_CONTEXT_WINDOW`, `ModelPricing`, `ProviderInjection`), `reasoningOverridesFor` from `@swarm/shared`.
- Produces (used by Tasks 2-3): `resolveModel(p: ProviderInjection): Model<Api>` (THROWS on an unresolvable style/provider), `injectionSupportsImages(p: ProviderInjection): boolean`, `pricingToCost(pricing: ModelPricing): Model<Api>['cost']`, `composeSystemPrompt(base: string, ctx: { cwd?: string; executionMode?: 'goal' | 'plan' }): string`. No other exports.
- This is a VERBATIM port of `agent-runner.ts:44-179` (getModelLoose/FALLBACK_MODEL_ID/API_FOR_STYLE/pricingToCost/cloneTemplate/resolveModel/injectionSupportsImages) and `agent-runner.ts:551-564` (composeSystemPrompt), comments included. The old runner keeps its private copies until W4 — deliberate transitional duplication; do not touch it.

- [ ] **Step 1: Write the failing test**

Create `apps/desktop/src/service/run-engine/models.test.ts` (uses the REAL pi-ai catalog, like `agent-runner.retry.test.ts` does — no mocks):

```ts
import { ANTHROPIC_MODEL_SUGGESTIONS, DEFAULT_CONTEXT_WINDOW } from '@swarm/protocol'
import { describe, expect, it } from 'vitest'

import { composeSystemPrompt, injectionSupportsImages, pricingToCost, resolveModel } from './models'

const custom = (over: Record<string, unknown> = {}) =>
  ({ id: 'c1', model: 'mystery-model', apiKey: 'k', apiStyle: 'openai', ...over }) as never

describe('resolveModel', () => {
  it('resolves a custom provider by apiStyle with the 200k default window', () => {
    const m = resolveModel(custom())
    expect(m.id).toBe('mystery-model')
    expect(m.api).toBe('openai-completions')
    expect(m.contextWindow).toBe(DEFAULT_CONTEXT_WINDOW)
  })

  it('honors an explicit custom contextWindow override', () => {
    expect(resolveModel(custom({ contextWindow: 1_000_000 })).contextWindow).toBe(1_000_000)
  })

  it('looks a UUID-id custom provider up by apiStyle, never by id', () => {
    // Regression port (v1 agent-runner.test.ts 't-uuid'): resolveModel must not
    // treat the provider id as a pi-ai registry key.
    const m = resolveModel(custom({ id: '1ec9df3a-02f0-4d29-b83b-c21bc8644801', model: 'glm-4' }))
    expect(m.id).toBe('glm-4')
  })

  it('keeps the requested model id on the registry path too', () => {
    const m = resolveModel({
      id: 'anthropic',
      registry: 'anthropic',
      apiStyle: 'anthropic',
      model: ANTHROPIC_MODEL_SUGGESTIONS[0],
      apiKey: 'k',
    } as never)
    expect(m.id).toBe(ANTHROPIC_MODEL_SUGGESTIONS[0])
  })

  it('applies custom pricing as the model cost', () => {
    const m = resolveModel(custom({ pricing: { inputPerM: 3, outputPerM: 15 } }))
    expect(m.cost).toEqual({ input: 3, output: 15, cacheRead: 0, cacheWrite: 0 })
  })
})

describe('pricingToCost', () => {
  it('maps full pricing to the Model.cost shape', () => {
    expect(pricingToCost({ inputPerM: 3, outputPerM: 15, cacheReadPerM: 0.3, cacheWritePerM: 1 })).toEqual({
      input: 3,
      output: 15,
      cacheRead: 0.3,
      cacheWrite: 1,
    })
  })

  it('defaults absent cache fields to 0', () => {
    expect(pricingToCost({ inputPerM: 3, outputPerM: 15 })).toEqual({ input: 3, output: 15, cacheRead: 0, cacheWrite: 0 })
  })
})

describe('injectionSupportsImages', () => {
  it('is true for an anthropic registry model (image-capable catalog entry)', () => {
    expect(
      injectionSupportsImages({
        id: 'anthropic',
        registry: 'anthropic',
        apiStyle: 'anthropic',
        model: ANTHROPIC_MODEL_SUGGESTIONS[0],
        apiKey: 'k',
      } as never)
    ).toBe(true)
  })
})

describe('composeSystemPrompt', () => {
  it('returns the base untouched with no context', () => {
    expect(composeSystemPrompt('base', {})).toBe('base')
  })

  it('prefixes the working directory', () => {
    expect(composeSystemPrompt('base', { cwd: '/w' })).toContain('Working directory: /w.')
  })

  it('prefixes the plan-mode constraint', () => {
    expect(composeSystemPrompt('base', { executionMode: 'plan' })).toContain('PLAN mode')
  })

  it('stacks cwd then plan mode before the base', () => {
    const s = composeSystemPrompt('base', { cwd: '/w', executionMode: 'plan' })
    expect(s.indexOf('Working directory')).toBeLessThan(s.indexOf('PLAN mode'))
    expect(s.endsWith('base')).toBe(true)
  })
})
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd apps/desktop && npm test -- src/service/run-engine/models.test.ts`
Expected: FAIL — cannot resolve `./models`.

- [ ] **Step 3: Write the implementation**

Create `apps/desktop/src/service/run-engine/models.ts` by porting the following regions of `apps/desktop/src/service/session/agent-runner.ts` VERBATIM (same code, same comments), assembling them in this order with these imports:

```ts
import type { Api, KnownProvider, Model } from '@earendil-works/pi-ai'
import { getBuiltinModel as getModel, getBuiltinModels as getModels } from '@earendil-works/pi-ai/providers/all'
import {
  ANTHROPIC_MODEL_SUGGESTIONS,
  type ApiStyle,
  DEFAULT_CONTEXT_WINDOW,
  type ModelPricing,
  OPENAI_MODEL_SUGGESTIONS,
  type ProviderInjection,
} from '@swarm/protocol'
import { reasoningOverridesFor } from '@swarm/shared'
```

Then port, in order (change nothing but adding `export` where the Interfaces block requires it):
1. `getModelLoose` alias + its comment (agent-runner.ts:44-48) — NOT exported.
2. `FALLBACK_MODEL_ID` (:50-53) and `API_FOR_STYLE` (:55-58) — NOT exported.
3. `export function pricingToCost` + comment (:116-125).
4. `cloneTemplate` + comment (:127-149) — NOT exported.
5. `export function resolveModel` + comments (:151-179).
6. `export function injectionSupportsImages` + comment (:100-109) — note it calls `resolveModel`, so it must appear after it (or rely on hoisting; keep source order resolveModel-first for readability).
7. `export function composeSystemPrompt` + comment (:548-564).

- [ ] **Step 4: Run test to verify it passes**

Run: `cd apps/desktop && npm test -- src/service/run-engine/models.test.ts`
Expected: PASS (11 tests).

- [ ] **Step 5: Format and commit**

```bash
npx biome check --write apps/desktop/src/service/run-engine/models.ts apps/desktop/src/service/run-engine/models.test.ts
git add apps/desktop/src/service/run-engine/models.ts apps/desktop/src/service/run-engine/models.test.ts
git commit -m "feat(run-engine): models.ts — verbatim port of model resolution

resolveModel/cloneTemplate/pricingToCost/injectionSupportsImages +
composeSystemPrompt extracted from agent-runner so engine.ts stays
focused. Old runner keeps private copies until W4."
```

---

### Task 2: `run-engine/engine.ts` — the run engine (gates + attempts loop + single terminal)

**Files:**
- Create: `apps/desktop/src/service/run-engine/engine.ts`
- Create: `apps/desktop/src/service/run-engine/engine.test.ts`

**Interfaces:**
- Consumes: Task 1's `models.ts`; W1's `./translator`, `./retry`, `./emit` (types); type-only `PermissionRegistry` from `../session/permission-registry` and `ToolRisk` from `../tools/registry`.
- Produces (used by Task 3):

```ts
export class EngineSetupError extends Error {}   // missing key / unresolvable model — launch emits the terminal

export type EngineDeps = {
  runId: string
  sessionId: string
  agentDefinition: AgentDefinition
  provider: ProviderInjection
  /** Effective chain = [provider, ...fallbackProviders]; defaults to provider.fallbackProviders. */
  fallbackProviders?: ProviderInjection[]
  /** Prior context ONLY — never contains the prompt (spec D4). */
  history: AgentMessage[]
  budget: ResourceBudget
  cwd?: string
  executionMode?: 'goal' | 'plan'
  permissionMode?: PermissionMode
  getPermissionMode?: () => PermissionMode
  tools: AgentTool[]
  riskOf: (name: string, args?: unknown) => ToolRisk
  emit: RunEmit
  permissionRegistry: PermissionRegistry
  signal?: AbortSignal
  saveSnapshot?: (messages: AgentMessage[], used: ConsumedResources, contextWindow?: number) => void
  maxIterationsOverride?: number
  retry?: { maxRetries?: number; delayMs?: number }
}

export type EngineRunResult = {
  status: 'completed' | 'failed' | 'cancelled'
  summary: string
  messages: AgentMessage[]
  used: ConsumedResources
}

export type Engine = {
  /** Drive ONE prompt to its single terminal event. Never rejects after construction. */
  run(prompt: string, images?: ImageContent[]): Promise<EngineRunResult>
  abort(): void
  getUsed(): ConsumedResources
  /** Fold externally-incurred spend (cc_* sessions) into the run budget + emit run.usage. */
  chargeExternalUsd(costUsd: number): void
}

export function createEngine(deps: EngineDeps): Engine   // THROWS EngineSetupError on setup failure
```

- Behavior contract (the spec's terminal-precedence rule, §7 carry-over b): after `agent.prompt()` settles, the terminal decision order is (1) `stopCause` — cancelled/budget/iterations/context, each its v1 error code; (2) failure — a thrown prompt error (`agent_exception`) or `outcome().errorMessage` (`agent_request_failed`), routed through `decideNextAttempt` for retry/fallback first; (3) `outcome().sawAborted` with no recorded cause → cancelled; (4) completed. Exactly ONE `run.complete`/`run.error` is emitted per `run()`, always by the engine. Summary rule (carry-over a): `run.complete` carries `outcome().summary || 'Completed run <runId>.'`; failed/cancelled results return the partial `outcome().summary` (the event carries the error, not the summary). The v1 "Operation aborted" transcript rewrite is ported into the subscription (carry-over c). `contextWindow`/model id in `run.usage` always read the CURRENT chain entry (ledger #8).

- [ ] **Step 1: Write the failing test**

Create `apps/desktop/src/service/run-engine/engine.test.ts`. It combines the two established pi-mock styles: `installAgent()` (hook capture + held prompt, from `agent-runner.test.ts:266-302`) for gate tests, and a programmable auto-completing mock (from `agent-runner.retry.test.ts`) for retry/summary tests.

```ts
import { beforeEach, describe, expect, it, vi } from 'vitest'

const MockAgent = vi.hoisted(() => vi.fn())

vi.mock('@earendil-works/pi-agent-core', () => ({ Agent: MockAgent }))

import type { RunEmitInput } from './emit'
import { createEngine, type EngineDeps, EngineSetupError } from './engine'

type Emitted = RunEmitInput[]

const collect = (): { out: Emitted; emit: (i: RunEmitInput) => void } => {
  const out: Emitted = []
  return { out, emit: (i) => out.push(i) }
}

const terminals = (out: Emitted) => out.filter((e) => e.kind === 'run.complete' || e.kind === 'run.error')

const baseDeps = (emit: (i: RunEmitInput) => void, over: Partial<EngineDeps> = {}): EngineDeps =>
  ({
    runId: 'r1',
    sessionId: 's1',
    agentDefinition: { id: 'default', name: 'd', description: 'd', systemPrompt: '', toolScope: 'all', maxIterations: 25 },
    provider: { id: 'c1', model: 'test-model', apiStyle: 'anthropic', apiKey: 'k' },
    history: [],
    budget: { tokens: 1e9, calls: 100, wallMs: 600_000, usdCents: 100_000 },
    permissionMode: 'full',
    tools: [],
    riskOf: () => 'low',
    emit,
    permissionRegistry: { request: vi.fn(async () => 'grant'), resolve: vi.fn() },
    retry: { maxRetries: 2, delayMs: 0 },
    ...over,
  }) as never

// --- Style A: hook-capturing mock with a held prompt (gate tests) ---
type BeforeToolCall = (ctx: { toolCall: { name: string }; args: unknown }) => Promise<{ block?: boolean } | undefined>
function installAgent(): {
  abortSpy: ReturnType<typeof vi.fn>
  getBeforeToolCall: () => BeforeToolCall
  getPrepareNextTurn: () => () => unknown
  emitEvent: (e: unknown) => void
  resolvePrompt: () => void
} {
  const abortSpy = vi.fn()
  let beforeToolCall: BeforeToolCall = async () => undefined
  let prepareNextTurn: () => unknown = () => undefined
  let listener: (e: unknown) => void = () => undefined
  let resolvePrompt: () => void = () => undefined
  MockAgent.mockImplementation(function (
    this: Record<string, unknown>,
    opts: { beforeToolCall: BeforeToolCall; prepareNextTurn: () => unknown; initialState?: { messages?: unknown[] } }
  ) {
    beforeToolCall = opts.beforeToolCall
    prepareNextTurn = opts.prepareNextTurn
    this.subscribe = (l: (e: unknown) => void) => {
      listener = l
      return () => undefined
    }
    this.abort = abortSpy
    this.prompt = () =>
      new Promise<void>((r) => {
        resolvePrompt = r
      })
    this.state = { messages: [...((opts.initialState?.messages as unknown[]) ?? [])], model: undefined }
  })
  return {
    abortSpy,
    getBeforeToolCall: () => beforeToolCall,
    getPrepareNextTurn: () => prepareNextTurn,
    emitEvent: (e) => listener(e),
    resolvePrompt: () => resolvePrompt(),
  }
}

// --- Style B: programmable auto-completing mock (retry/summary tests) ---
let failTimes = 0
let promptCalls = 0
function installAutoAgent(reply = 'done.') {
  MockAgent.mockImplementation(function (this: Record<string, unknown>, opts: { initialState?: { messages?: unknown[] } }) {
    let sub: ((e: unknown) => void) | null = null
    this.state = { messages: [...((opts.initialState?.messages as unknown[]) ?? [])], model: undefined }
    this.subscribe = (fn: (e: unknown) => void) => {
      sub = fn
    }
    this.abort = () => undefined
    this.prompt = async (goal: string) => {
      promptCalls++
      const msgs = this.state as { messages: Array<Record<string, unknown>> }
      msgs.messages.push({ role: 'user', content: goal })
      if (promptCalls <= failTimes) {
        const failure = { role: 'assistant', content: [], stopReason: 'error', errorMessage: 'transient 503' }
        msgs.messages.push(failure)
        sub?.({ type: 'message_end', message: failure })
        sub?.({ type: 'agent_end', messages: [failure] })
        return
      }
      const ok = { role: 'assistant', content: [{ type: 'text', text: reply }], stopReason: 'end_turn' }
      msgs.messages.push(ok)
      if (reply) sub?.({ type: 'message_update', assistantMessageEvent: { type: 'text_delta', delta: reply } })
      sub?.({ type: 'agent_end', messages: [ok] })
    }
  })
}

beforeEach(() => {
  MockAgent.mockReset()
  failTimes = 0
  promptCalls = 0
})

describe('createEngine — setup', () => {
  it('throws EngineSetupError when the API key is empty, emitting nothing', () => {
    const { out, emit } = collect()
    expect(() => createEngine(baseDeps(emit, { provider: { id: 'c1', model: 'm', apiStyle: 'anthropic', apiKey: '' } as never }))).toThrow(
      EngineSetupError
    )
    expect(out).toHaveLength(0)
  })
})

describe('engine gates — each aborted run emits exactly ONE terminal', () => {
  it('blocks over-budget tool calls and terminates with budget_exhausted', async () => {
    const h = installAgent()
    const { out, emit } = collect()
    const engine = createEngine(baseDeps(emit, { budget: { tokens: 1e9, calls: 2, wallMs: 600_000, usdCents: 100_000 } as never }))
    const p = engine.run('go')
    const call = () => h.getBeforeToolCall()({ toolCall: { name: 'tool' }, args: {} })
    expect(await call()).toBeUndefined()
    expect(await call()).toBeUndefined()
    expect(await call()).toMatchObject({ block: true })
    expect(h.abortSpy).toHaveBeenCalled()
    h.emitEvent({ type: 'agent_end', messages: [{ role: 'assistant', content: [], stopReason: 'aborted' }] })
    h.resolvePrompt()
    const r = await p
    expect(r.status).toBe('failed')
    const t = terminals(out)
    expect(t).toHaveLength(1)
    expect(t[0]).toMatchObject({ kind: 'run.error', error: { code: 'budget_exhausted' } })
  })

  it('terminates with context_window_full when the snapshot exceeds the window', async () => {
    const h = installAgent()
    const { out, emit } = collect()
    const engine = createEngine(
      baseDeps(emit, { provider: { id: 'c1', model: 'm', apiStyle: 'openai', apiKey: 'k', contextWindow: 1000 } as never })
    )
    const p = engine.run('go')
    h.emitEvent({
      type: 'turn_end',
      message: {
        role: 'assistant',
        usage: { input: 2000, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 2000, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } },
      },
      toolResults: [],
    })
    expect(await h.getBeforeToolCall()({ toolCall: { name: 'tool' }, args: {} })).toMatchObject({ block: true })
    h.emitEvent({ type: 'agent_end', messages: [{ role: 'assistant', content: [], stopReason: 'aborted' }] })
    h.resolvePrompt()
    const r = await p
    expect(r.status).toBe('failed')
    expect(terminals(out)).toHaveLength(1)
    expect(terminals(out)[0]).toMatchObject({ kind: 'run.error', error: { code: 'context_window_full' } })
  })

  it('terminates with max_iterations when the turn cap trips — even on a natural-finish turn without an aborted stamp', async () => {
    // Spec §7 residual: v1 double-terminated when pi ended naturally after the
    // iterations abort. The engine owns the terminal, so no agent_end shape can
    // produce a second one — pin BOTH shapes.
    for (const endMessages of [
      [{ role: 'assistant', content: [], stopReason: 'aborted' }],
      [{ role: 'assistant', content: [{ type: 'text', text: 'done anyway.' }], stopReason: 'end_turn' }],
    ]) {
      MockAgent.mockReset()
      const h = installAgent()
      const { out, emit } = collect()
      const engine = createEngine(
        baseDeps(emit, {
          agentDefinition: { id: 'default', name: 'd', description: 'd', systemPrompt: '', toolScope: 'all', maxIterations: 2 } as never,
        })
      )
      const p = engine.run('go')
      h.getPrepareNextTurn()()
      h.getPrepareNextTurn()()
      expect(h.abortSpy).toHaveBeenCalled()
      h.emitEvent({ type: 'agent_end', messages: endMessages })
      h.resolvePrompt()
      const r = await p
      expect(r.status).toBe('failed')
      const t = terminals(out)
      expect(t).toHaveLength(1)
      expect(t[0]).toMatchObject({ kind: 'run.error', error: { code: 'max_iterations' } })
    }
  })

  it('terminates cancelled exactly once when the signal fires (aborted stamp included)', async () => {
    const h = installAgent()
    const { out, emit } = collect()
    const ac = new AbortController()
    const engine = createEngine(baseDeps(emit, { signal: ac.signal }))
    const p = engine.run('go')
    await Promise.resolve()
    ac.abort()
    expect(h.abortSpy).toHaveBeenCalled()
    h.emitEvent({ type: 'agent_end', messages: [{ role: 'assistant', content: [], stopReason: 'aborted' }] })
    h.resolvePrompt()
    const r = await p
    expect(r.status).toBe('cancelled')
    const t = terminals(out)
    expect(t).toHaveLength(1)
    expect(t[0]).toMatchObject({ kind: 'run.error', error: { code: 'cancelled' } })
  })

  it('treats an externally aborted run with no recorded cause as cancelled (precedence rule 3)', async () => {
    const h = installAgent()
    const { out, emit } = collect()
    const engine = createEngine(baseDeps(emit))
    const p = engine.run('go')
    engine.abort() // direct abort — no stopCause, no signal
    h.emitEvent({ type: 'agent_end', messages: [{ role: 'assistant', content: [], stopReason: 'aborted' }] })
    h.resolvePrompt()
    const r = await p
    expect(r.status).toBe('cancelled')
    expect(terminals(out)).toHaveLength(1)
  })

  it('escalates medium-risk tools to the permission registry under ask, and bypasses under full', async () => {
    for (const [mode, expectedCalls] of [
      ['ask', 1],
      ['full', 0],
    ] as const) {
      MockAgent.mockReset()
      const h = installAgent()
      const { emit } = collect()
      const request = vi.fn(async () => 'grant' as const)
      const engine = createEngine(
        baseDeps(emit, { permissionMode: mode, riskOf: () => 'medium', permissionRegistry: { request, resolve: vi.fn() } as never })
      )
      const p = engine.run('go')
      const result = await h.getBeforeToolCall()({ toolCall: { name: 'mutate' }, args: {} })
      expect(result).toBeUndefined()
      expect(request).toHaveBeenCalledTimes(expectedCalls)
      h.emitEvent({ type: 'agent_end', messages: [{ role: 'assistant', content: [], stopReason: 'end_turn' }] })
      h.resolvePrompt()
      await p
    }
  })

  it('reads getPermissionMode live so a mid-run switch to full takes effect', async () => {
    const h = installAgent()
    const { emit } = collect()
    const request = vi.fn(async () => 'grant' as const)
    let mode: 'ask' | 'full' = 'ask'
    const engine = createEngine(
      baseDeps(emit, {
        permissionMode: 'ask',
        getPermissionMode: () => mode,
        riskOf: () => 'medium',
        permissionRegistry: { request, resolve: vi.fn() } as never,
      })
    )
    const p = engine.run('go')
    await h.getBeforeToolCall()({ toolCall: { name: 'mutate' }, args: {} })
    expect(request).toHaveBeenCalledTimes(1)
    mode = 'full'
    await h.getBeforeToolCall()({ toolCall: { name: 'mutate' }, args: {} })
    expect(request).toHaveBeenCalledTimes(1)
    h.emitEvent({ type: 'agent_end', messages: [{ role: 'assistant', content: [], stopReason: 'end_turn' }] })
    h.resolvePrompt()
    await p
  })

  it('emits run.usage on turn_end with the live model id and calls saveSnapshot', async () => {
    const h = installAgent()
    const { out, emit } = collect()
    const saveSnapshot = vi.fn()
    const engine = createEngine(baseDeps(emit, { saveSnapshot }))
    const p = engine.run('go')
    h.emitEvent({
      type: 'turn_end',
      message: {
        role: 'assistant',
        usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 1500, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0.05 } },
      },
      toolResults: [],
    })
    const usage = out.find((e) => e.kind === 'run.usage') as { used: { tokens: number; usdCents: number }; model?: string } | undefined
    expect(usage).toBeDefined()
    expect(usage!.used.tokens).toBe(1500)
    expect(usage!.used.usdCents).toBe(5)
    expect(usage!.model).toBe('test-model')
    expect(saveSnapshot).toHaveBeenCalled()
    h.emitEvent({ type: 'agent_end', messages: [{ role: 'assistant', content: [], stopReason: 'end_turn' }] })
    h.resolvePrompt()
    await p
  })

  it('chargeExternalUsd folds spend into usdCents and emits run.usage', async () => {
    installAutoAgent()
    const { out, emit } = collect()
    const engine = createEngine(baseDeps(emit))
    engine.chargeExternalUsd(0.5)
    expect(engine.getUsed().usdCents).toBe(50)
    expect(out.some((e) => e.kind === 'run.usage')).toBe(true)
  })

  it('rewrites the generic "Operation aborted" tool result to the real stop cause (carry-over c)', async () => {
    const h = installAgent()
    const { emit } = collect()
    const ac = new AbortController()
    const engine = createEngine(baseDeps(emit, { signal: ac.signal }))
    const p = engine.run('go')
    await Promise.resolve()
    ac.abort()
    const evt = {
      type: 'tool_execution_end',
      toolName: 'shell',
      isError: true,
      result: { content: [{ type: 'text', text: 'Operation aborted' }] },
    }
    h.emitEvent(evt)
    expect(evt.result.content[0].text).toBe('Stopped by user.')
    h.emitEvent({ type: 'agent_end', messages: [{ role: 'assistant', content: [], stopReason: 'aborted' }] })
    h.resolvePrompt()
    await p
  })
})

describe('engine retry/fallback', () => {
  it('retries transient failures with visible transient notices, then completes — one terminal total', async () => {
    installAutoAgent()
    failTimes = 2
    const { out, emit } = collect()
    const engine = createEngine(baseDeps(emit))
    const r = await engine.run('go')
    expect(r.status).toBe('completed')
    expect(promptCalls).toBe(3)
    const notices = out.filter(
      (e) => e.kind === 'run.progress' && (e as { event: { kind: string; error?: { tier?: string } } }).event.kind === 'error'
    )
    expect(notices).toHaveLength(2)
    expect(terminals(out)).toHaveLength(1)
    expect(terminals(out)[0].kind).toBe('run.complete')
  })

  it('gives up after retries exhaust with a single agent_request_failed terminal', async () => {
    installAutoAgent()
    failTimes = 999
    const { out, emit } = collect()
    const engine = createEngine(baseDeps(emit))
    const r = await engine.run('go')
    expect(r.status).toBe('failed')
    expect(promptCalls).toBe(3) // 1 + maxRetries(2)
    const t = terminals(out)
    expect(t).toHaveLength(1)
    expect(t[0]).toMatchObject({ kind: 'run.error', error: { code: 'agent_request_failed', message: 'transient 503' } })
  })

  it('advances to the fallback model after exhausting the primary, announcing the switch', async () => {
    installAutoAgent()
    failTimes = 3 // primary: 1 + 2 retries all fail; fallback's first attempt (call 4) succeeds
    const { out, emit } = collect()
    const engine = createEngine(
      baseDeps(emit, { fallbackProviders: [{ id: 'fb', model: 'fallback-model', apiStyle: 'openai', apiKey: 'k' }] as never })
    )
    const r = await engine.run('go')
    expect(r.status).toBe('completed')
    expect(promptCalls).toBe(4)
    expect(
      out.some(
        (e) =>
          e.kind === 'run.progress' &&
          (e as { event: { error?: { code?: string } } }).event.error?.code === 'agent_model_fallback'
      )
    ).toBe(true)
    expect(terminals(out)).toHaveLength(1)
  })

  it('restores the transcript before each retry so failed turns are discarded', async () => {
    installAutoAgent()
    failTimes = 2
    const { emit } = collect()
    const engine = createEngine(baseDeps(emit))
    const r = await engine.run('go')
    expect(r.messages).toHaveLength(2) // final user goal + success reply only
    expect(r.messages.some((m) => (m as { stopReason?: string }).stopReason === 'error')).toBe(false)
  })
})

describe('engine summary (carry-over a)', () => {
  it('completes with the trimmed assembled summary', async () => {
    installAutoAgent('done.')
    const { out, emit } = collect()
    const r = await createEngine(baseDeps(emit)).run('go')
    expect(r.summary).toBe('done.')
    expect(terminals(out)[0]).toMatchObject({ kind: 'run.complete', summary: 'done.' })
  })

  it('falls back to "Completed run <id>." when the model produced no text', async () => {
    installAutoAgent('')
    const { out, emit } = collect()
    const r = await createEngine(baseDeps(emit)).run('go')
    expect(r.status).toBe('completed')
    expect(terminals(out)[0]).toMatchObject({ kind: 'run.complete', summary: 'Completed run r1.' })
    expect(r.summary).toBe('Completed run r1.')
  })
})
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd apps/desktop && npm test -- src/service/run-engine/engine.test.ts`
Expected: FAIL — cannot resolve `./engine`.

- [ ] **Step 3: Write the implementation**

Create `apps/desktop/src/service/run-engine/engine.ts`. This is a port of `buildAgentSession` (agent-runner.ts:617-1199) restructured onto the W1 units — the numbered notes call out every deliberate difference from v1:

```ts
import type { AgentMessage, AgentTool } from '@earendil-works/pi-agent-core'
import { Agent } from '@earendil-works/pi-agent-core'
import type { Api, ImageContent, Model, Usage } from '@earendil-works/pi-ai'
import { clampThinkingLevel } from '@earendil-works/pi-ai'
import { createLogger } from '@shared/logger'
import type {
  AgentDefinition,
  ConsumedResources,
  PermissionMode,
  ProviderInjection,
  ResourceBudget,
  TaskEvent,
} from '@swarm/protocol'
import type { PermissionRegistry } from '../session/permission-registry'
import type { ToolRisk } from '../tools/registry'
import type { RunEmit } from './emit'
import { composeSystemPrompt, resolveModel } from './models'
import { abortableDelay, decideNextAttempt, isPermanentModelFailure, MAX_PROMPT_RETRIES, RETRY_DELAY_MS } from './retry'
import { createRunTranslator } from './translator'

const log = createLogger({ process: 'service' }).child({ component: 'run-engine' })

/** Setup failure (missing key, unresolvable model). The engine THROWS this from
 *  createEngine instead of fabricating a fake session (v1's failedSession cast
 *  lie); launch owns the run.error terminal for it. */
export class EngineSetupError extends Error {}

export type EngineDeps = {
  runId: string
  sessionId: string
  agentDefinition: AgentDefinition
  provider: ProviderInjection
  /** Effective chain = [provider, ...fallbackProviders]; defaults to provider.fallbackProviders. */
  fallbackProviders?: ProviderInjection[]
  /** Prior context ONLY — never contains the prompt (spec D4). */
  history: AgentMessage[]
  budget: ResourceBudget
  cwd?: string
  executionMode?: 'goal' | 'plan'
  permissionMode?: PermissionMode
  getPermissionMode?: () => PermissionMode
  tools: AgentTool[]
  riskOf: (name: string, args?: unknown) => ToolRisk
  emit: RunEmit
  permissionRegistry: PermissionRegistry
  signal?: AbortSignal
  saveSnapshot?: (messages: AgentMessage[], used: ConsumedResources, contextWindow?: number) => void
  maxIterationsOverride?: number
  retry?: { maxRetries?: number; delayMs?: number }
}

export type EngineRunResult = {
  status: 'completed' | 'failed' | 'cancelled'
  summary: string
  messages: AgentMessage[]
  used: ConsumedResources
}

export type Engine = {
  run(prompt: string, images?: ImageContent[]): Promise<EngineRunResult>
  abort(): void
  getUsed(): ConsumedResources
  chargeExternalUsd(costUsd: number): void
}

type RunErrorShape = { code: string; message: string; tier: 'transient' | 'recoverable' | 'fatal' | 'gave_up' }

export function createEngine(deps: EngineDeps): Engine {
  const runLog = log.child({ runId: deps.runId, sessionId: deps.sessionId })
  const maxRetries = deps.retry?.maxRetries ?? MAX_PROMPT_RETRIES
  const retryDelayMs = deps.retry?.delayMs ?? RETRY_DELAY_MS

  // [1] v1 emitted task.error + returned a fake session on setup failure;
  //     the engine throws and launch emits the terminal.
  if (!deps.provider.apiKey) throw new EngineSetupError('Provider API key is missing or empty')

  let model: Model<Api>
  const fallbackModels: Model<Api>[] = []
  try {
    model = resolveModel(deps.provider)
  } catch (err) {
    throw new EngineSetupError(err instanceof Error ? err.message : String(err))
  }
  // Resolve fallbacks defensively: a single unresolvable fallback is dropped,
  // never fatal (v1 parity).
  for (const fp of deps.fallbackProviders ?? deps.provider.fallbackProviders ?? []) {
    try {
      fallbackModels.push(resolveModel(fp))
    } catch (e) {
      runLog.warn({ msg: 'skipping unresolvable fallback provider', model: fp.model, err: e instanceof Error ? e.message : String(e) })
    }
  }
  const modelChain: Model<Api>[] = [model, ...fallbackModels]

  // Session-level accumulators — one budget envelope per engine (v1 parity).
  const budget = deps.budget
  const startedAt = Date.now()
  const used = { calls: 0, tokens: 0, usdCents: 0, cacheRead: 0, cacheWrite: 0 }
  // Latest turn's context occupancy (snapshot, refreshed each turn_end). This —
  // not cumulative spend — decides window fitness; budget.tokens is NOT gated.
  let contextTokens = 0
  let stopCause: 'cancelled' | 'budget' | 'context' | 'iterations' | null = null
  let budgetDim = ''
  let turns = 0
  const maxTurns = deps.maxIterationsOverride ?? deps.agentDefinition.maxIterations ?? 25

  const snapshotUsed = (): ConsumedResources => ({
    tokens: used.tokens,
    calls: used.calls,
    wallMs: Date.now() - startedAt,
    usdCents: used.usdCents,
    cacheRead: used.cacheRead,
    cacheWrite: used.cacheWrite,
  })

  const emitUsage = (withContext: boolean): void => {
    deps.emit({
      kind: 'run.usage',
      used: snapshotUsed(),
      contextTokens: withContext ? contextTokens : undefined,
      // [2] Always the CURRENT chain entry — v1 froze AgentSession.contextWindow
      //     at construction (ledger #8).
      contextWindow: model.contextWindow,
      model: model.id,
    })
  }

  // Runaway guards only (calls/time/cost); token spend deliberately absent.
  const overBudget = (): string | null => {
    if (used.calls > budget.calls) return 'calls'
    if (Date.now() - startedAt > budget.wallMs) return 'wallMs'
    if (used.usdCents > budget.usdCents) return 'usdCents'
    return null
  }

  const stopReason = (): string | null => {
    if (stopCause === 'cancelled') return 'Stopped by user.'
    if (stopCause === 'budget') return `Budget exhausted (${budgetDim}).`
    if (stopCause === 'iterations') return `Stopped after ${maxTurns} turns (max iterations reached).`
    if (stopCause === 'context') return `Context window full (${contextTokens} > ${model.contextWindow} tokens).`
    return null
  }

  const agent = new Agent({
    getApiKey: () => deps.provider.apiKey,
    initialState: {
      systemPrompt: composeSystemPrompt(deps.agentDefinition.systemPrompt, { cwd: deps.cwd, executionMode: deps.executionMode }),
      model,
      tools: deps.tools,
      // [3] Seed is the prior history ONLY; run(prompt) appends the user turn
      //     via pi's prompt(). No extraction, no slicing (spec D4).
      messages: deps.history,
      thinkingLevel: clampThinkingLevel(model, deps.provider.thinkingLevel ?? 'high'),
    },
    // Fires every turn (tool call or not) — the backstop for reasoning-only loops.
    prepareNextTurn: () => {
      turns += 1
      if (turns >= maxTurns) {
        stopCause = 'iterations'
        runLog.warn({ msg: 'max iterations reached, aborting', turns, maxTurns })
        agent.abort()
      }
      return undefined
    },
    beforeToolCall: async ({ toolCall, args }) => {
      if (deps.signal?.aborted) {
        stopCause = 'cancelled'
        return { block: true, reason: 'Stopped by user.' }
      }
      used.calls += 1
      const dim = overBudget()
      if (dim) {
        stopCause = 'budget'
        budgetDim = dim
        agent.abort()
        return { block: true, reason: `Budget exhausted (${dim}).` }
      }
      if (model.contextWindow && contextTokens > model.contextWindow) {
        stopCause = 'context'
        agent.abort()
        return { block: true, reason: `Context window full (${contextTokens} > ${model.contextWindow} tokens).` }
      }
      const risk = deps.riskOf(toolCall.name, args)
      if (risk === 'low') return undefined
      const permissionMode = deps.getPermissionMode?.() ?? deps.permissionMode ?? 'ask'
      if (permissionMode === 'full') return undefined
      const decision = await deps.permissionRegistry.request(
        { taskId: deps.runId, toolName: toolCall.name, risk, summary: `Run tool: ${toolCall.name}`, payload: args },
        deps.signal
      )
      if (deps.signal?.aborted) {
        stopCause = 'cancelled'
        runLog.info({ msg: 'tool call cancelled awaiting approval', toolName: toolCall.name })
        return { block: true, reason: 'Stopped by user.' }
      }
      if (decision === 'grant') {
        runLog.info({ msg: 'tool call approved', toolName: toolCall.name, risk })
        return undefined
      }
      runLog.warn({ msg: 'tool call blocked by user', toolName: toolCall.name, risk, decision })
      return { block: true, reason: `User ${decision} the action.` }
    },
  })

  if (deps.signal) {
    if (deps.signal.aborted) {
      stopCause = 'cancelled'
      agent.abort()
    } else {
      deps.signal.addEventListener(
        'abort',
        () => {
          if (!stopCause) stopCause = 'cancelled'
          agent.abort()
        },
        { once: true }
      )
    }
  }

  const translator = createRunTranslator(deps.emit)
  agent.subscribe((e) => {
    if (e.type === 'turn_end') {
      const usage = (e as { message?: { usage?: Usage } }).message?.usage
      if (usage) {
        // Snapshots, not running totals (each turn re-sends the whole conversation).
        used.tokens = usage.totalTokens
        used.usdCents += Math.round(usage.cost.total * 100)
        used.cacheRead = usage.cacheRead
        used.cacheWrite = usage.cacheWrite
        contextTokens = usage.input + usage.cacheRead + usage.cacheWrite + usage.output
      }
      emitUsage(!!usage)
      deps.saveSnapshot?.(agent.state.messages, snapshotUsed(), model.contextWindow)
    }
    // [4] Carry-over (c): rewrite pi's generic "Operation aborted" tool result
    //     to the real stop cause so the transcript matches the terminal.
    if (e.type === 'tool_execution_end' && (e as { isError?: boolean }).isError) {
      const reason = stopReason()
      if (reason) {
        const r = (e as { result?: { content?: Array<{ type: string; text?: string }> } }).result
        const txt = r?.content?.find((c) => c.type === 'text')
        if (txt?.text === 'Operation aborted') txt.text = reason
      }
    }
    translator.handle(e)
  })

  const emitTransientNotice = (code: string, message: string): void => {
    const event: TaskEvent = { kind: 'error', error: { code, message, tier: 'transient' }, ts: Date.now() }
    deps.emit({ kind: 'run.progress', event })
  }

  // The run's SINGLE terminal is emitted here and nowhere else.
  const terminal = (status: EngineRunResult['status'], error: RunErrorShape | null): EngineRunResult => {
    const oc = translator.outcome()
    // [5] Carry-over (a): trimmed summary; empty completions fall back.
    const summary = status === 'completed' ? oc.summary || `Completed run ${deps.runId}.` : oc.summary
    if (status === 'completed') deps.emit({ kind: 'run.complete', summary })
    else deps.emit({ kind: 'run.error', error: error as RunErrorShape })
    runLog.info({ msg: 'run terminal', status, code: error?.code, durationMs: Date.now() - startedAt })
    return { status, summary, messages: agent.state.messages, used: snapshotUsed() }
  }

  const cancelledError: RunErrorShape = { code: 'cancelled', message: 'Stopped by user.', tier: 'gave_up' }

  const run = async (prompt: string, images?: ImageContent[]): Promise<EngineRunResult> => {
    runLog.info({ msg: 'engine run starting', promptLen: prompt.length, modelId: model.id, maxTurns })
    const baselineMessages = agent.state.messages.slice()
    for (let modelIdx = 0; modelIdx < modelChain.length; modelIdx++) {
      if (modelIdx > 0) {
        // `model` is read by reference in the agent's closures, so reassigning
        // propagates to the window guard and usage emits (ledger #8).
        model = modelChain[modelIdx]
        agent.state.model = model
        runLog.info({ msg: 'falling back to next model', modelId: model.id, modelIdx })
      }
      for (let attempt = 0; attempt <= maxRetries; attempt++) {
        stopCause = null
        turns = 0
        translator.resetTurn()
        if (attempt > 0 || modelIdx > 0) agent.state.messages = baselineMessages.slice()

        let promptError: unknown = null
        const t0 = Date.now()
        try {
          // pi's prompt() resolves void; request failures ride the event stream
          // as stopReason 'error'/'aborted', captured into the outcome.
          await agent.prompt(prompt, images && images.length > 0 ? images : undefined)
        } catch (err) {
          promptError = err
        }

        // (1) Deliberate stops end the whole run — never retried, never fall back.
        if (stopCause === 'cancelled') {
          runLog.info({ msg: 'run cancelled', durationMs: Date.now() - t0 })
          return terminal('cancelled', cancelledError)
        }
        if (stopCause === 'budget') {
          runLog.warn({ msg: 'run budget exhausted', dim: budgetDim, durationMs: Date.now() - t0 })
          return terminal('failed', { code: 'budget_exhausted', message: `Budget exhausted (${budgetDim}).`, tier: 'gave_up' })
        }
        if (stopCause === 'iterations') {
          runLog.warn({ msg: 'run hit max iterations', turns, maxTurns, durationMs: Date.now() - t0 })
          return terminal('failed', {
            code: 'max_iterations',
            message: `Stopped after ${maxTurns} turns (max iterations reached).`,
            tier: 'gave_up',
          })
        }
        if (stopCause === 'context') {
          runLog.warn({ msg: 'context window full', contextTokens, contextWindow: model.contextWindow })
          return terminal('failed', {
            code: 'context_window_full',
            message: `Context window full (${contextTokens} > ${model.contextWindow} tokens).`,
            tier: 'gave_up',
          })
        }

        // (2) Failures: thrown transport errors and stopReason-'error' captures,
        //     both routed through the pure retry policy.
        const oc = translator.outcome()
        const failure = promptError
          ? { message: promptError instanceof Error ? promptError.message : String(promptError), thrown: true }
          : oc.errorMessage
            ? { message: oc.errorMessage, thrown: false }
            : null

        if (!failure) {
          // (3) Aborted with no recorded cause (a direct engine.abort() caller):
          //     a cancellation, not a completion. errorMessage wins above —
          //     carry-over (b)'s precedence is (1) stopCause, (2) failure, (3) this.
          if (oc.sawAborted) {
            runLog.info({ msg: 'run aborted without recorded cause; reporting cancelled' })
            return terminal('cancelled', cancelledError)
          }
          return terminal('completed', null)
        }

        const permanent = isPermanentModelFailure(failure.message)
        const decision = decideNextAttempt({ attempt, maxRetries, modelIdx, chainLength: modelChain.length, permanent })
        runLog.error({
          msg: failure.thrown ? 'agent.prompt threw' : 'agent.prompt resolved with error',
          attempt,
          modelId: model.id,
          errorMessage: failure.message,
          decision,
        })
        if (decision === 'retry-same-model') {
          emitTransientNotice(
            'agent_request_retry',
            `Provider request failed (attempt ${attempt + 1}/${maxRetries + 1}); retrying in ${Math.round(retryDelayMs / 1000)}s. ${failure.message}`
          )
          await abortableDelay(retryDelayMs, deps.signal)
          if (deps.signal?.aborted) {
            runLog.info({ msg: 'run cancelled during retry wait' })
            return terminal('cancelled', cancelledError)
          }
          continue
        }
        if (decision === 'advance-model') {
          emitTransientNotice(
            'agent_model_fallback',
            `Switching to fallback model "${modelChain[modelIdx + 1].id}" after ${permanent ? 'a permanent error' : 'exhausting retries'}.`
          )
          break
        }
        return terminal('failed', {
          code: failure.thrown ? 'agent_exception' : 'agent_request_failed',
          message: failure.message,
          tier: 'fatal',
        })
      }
    }
    // Unreachable: every branch above returns or breaks to a next model.
    throw new Error('engine attempts loop exited without a result')
  }

  return {
    run,
    abort: () => agent.abort(),
    getUsed: snapshotUsed,
    chargeExternalUsd: (costUsd: number) => {
      if (!costUsd || costUsd <= 0) return
      used.usdCents += Math.round(costUsd * 100)
      runLog.info({ msg: 'external usage charged', costUsd, usdCents: used.usdCents })
      emitUsage(false)
    },
  }
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `cd apps/desktop && npm test -- src/service/run-engine/engine.test.ts`
Expected: PASS (17 tests). Then run the whole module + old-runner suites to prove no cross-contamination: `npm test -- src/service/run-engine src/service/session`
Expected: PASS.

- [ ] **Step 5: Format and commit**

```bash
npx biome check --write apps/desktop/src/service/run-engine/engine.ts apps/desktop/src/service/run-engine/engine.test.ts
git add apps/desktop/src/service/run-engine/engine.ts apps/desktop/src/service/run-engine/engine.test.ts
git commit -m "feat(run-engine): engine.ts — gates + attempts loop + the single terminal

Port of buildAgentSession/promptOnce onto the W1 units: terminal-free
translator, pure retry policy, run.* emit. The engine owns the run's one
terminal (ledger #1 structural, incl. the iterations-on-natural-finish
residual), reads contextWindow live (ledger #8), pins the summary
trim/fallback and errorMessage>sawAborted precedence (spec §7
carry-overs), and throws EngineSetupError instead of faking a session."
```

---

### Task 3: `run-engine/launch.ts` — the one way any run starts

**Files:**
- Create: `apps/desktop/src/service/run-engine/launch.ts`
- Create: `apps/desktop/src/service/run-engine/launch.test.ts`

**Interfaces:**
- Consumes: Task 2's `createEngine`/`EngineSetupError`/`EngineRunResult`; W1 `createRunEmit`/`RunEmitPorts`; Task 1 `injectionSupportsImages`; type-only `ToolRegistry`, `ToolRunContext` from `../tools/registry` and `PermissionRegistry` from `../session/permission-registry`; `ulid`.
- Produces (bound by W3's SessionService):

```ts
export type RunKind = 'turn' | 'work' | 'child'
export type DelegateResult = { runId: string; status: 'completed' | 'failed' | 'cancelled'; summary: string }
export type RunSpec = {
  kind: RunKind
  runId?: string                       // minted when absent
  sessionId: string
  agent: AgentDefinition
  provider: ProviderInjection
  fallbackProviders?: ProviderInjection[]
  prompt: string
  history?: AgentMessage[]
  attachments?: Attachment[]
  budget: ResourceBudget
  parentRunId?: string                 // child only
  tools?: string[]                     // allowlist; defaults []
  cwd?: string
  executionMode?: 'goal' | 'plan'
  permissionMode?: PermissionMode
  getPermissionMode?: () => PermissionMode
  saveSnapshot?: (messages: AgentMessage[], used: ConsumedResources, contextWindow?: number) => void
  maxIterationsOverride?: number
  retry?: { maxRetries?: number; delayMs?: number }
  onDelegationPlan?: (plan: DelegationItem[]) => void
}
export type LaunchPorts = {
  emit: RunEmitPorts
  toolRegistry: ToolRegistry
  permissionRegistry: PermissionRegistry
  /** Per-session FIFO ticket for 'turn' runs; resolves when the run may execute. */
  waitTurn?: (sessionId: string, runId: string, signal: AbortSignal) => Promise<void>
  /** Global concurrency pool; resolves with the release fn. */
  acquireSlot: (signal: AbortSignal) => Promise<() => void>
  registerAbort: (runId: string, abort: () => void) => void
  unregisterAbort: (runId: string) => void
  /** Recursive child launch, bound by SessionService in W3. Absent → the delegate tool errors loudly. */
  delegate?: (
    parentRunId: string,
    goal: string,
    opts: { suggestedTools?: string[]; providerKey?: string; agentType?: string }
  ) => Promise<DelegateResult>
  writeAgent?: ToolRunContext['writeAgent']
  writeSkill?: ToolRunContext['writeSkill']
  findAgents?: ToolRunContext['findPeers']
}
export function launchRun(spec: RunSpec, ports: LaunchPorts): Promise<EngineRunResult & { runId: string }>
```

- Behavior contract: `run.created` is emitted immediately (queued turns render as pending); the AbortController is registered BEFORE the turn ticket and slot waits (ledger #4 — a cancel during any wait terminates with a single cancelled `run.error` and the engine is never constructed); `run.dispatched` fires after the slot is held; the parent's slot is released while `ctx.spawnChild` awaits `ports.delegate` and reacquired after (depth-counted for parallel tool calls; ledger #5); `ctx.setDelegationPlan` is wired for EVERY run (ledger #12) emitting `run.delegation_plan` and then `spec.onDelegationPlan`; `ctx.sendMessage`/`sendAndWait` REJECT with `'messaging is not available in this run'` (no silent fake success — ledger #11's temporary hardening until W3 deletes the tools); `EngineSetupError` and any unexpected throw produce the synthetic `run.error` terminal (`agent_setup_failed` / `agent_exception`); the slot is released and the abort handle unregistered in `finally`; `launchRun` never rejects.

- [ ] **Step 1: Write the failing test**

Create `apps/desktop/src/service/run-engine/launch.test.ts`:

```ts
import { beforeEach, describe, expect, it, vi } from 'vitest'

const MockAgent = vi.hoisted(() => vi.fn())
vi.mock('@earendil-works/pi-agent-core', () => ({ Agent: MockAgent }))

import type { ToolRunContext } from '../tools/registry'
import type { RunWireEvent } from '@swarm/protocol'
import { launchRun, type LaunchPorts, type RunSpec } from './launch'

// Auto-completing pi mock (engine runs to a clean completion unless held).
let holdPrompt = false
let resolveHeldPrompt: () => void = () => undefined
function installAgent(reply = 'done.') {
  MockAgent.mockImplementation(function (this: Record<string, unknown>, opts: { initialState?: { messages?: unknown[] } }) {
    let sub: ((e: unknown) => void) | null = null
    this.state = { messages: [...((opts.initialState?.messages as unknown[]) ?? [])], model: undefined }
    this.subscribe = (fn: (e: unknown) => void) => {
      sub = fn
    }
    this.abort = () => undefined
    this.prompt = async (goal: string) => {
      ;(this.state as { messages: unknown[] }).messages.push({ role: 'user', content: goal })
      if (holdPrompt) await new Promise<void>((r) => (resolveHeldPrompt = r))
      const ok = { role: 'assistant', content: [{ type: 'text', text: reply }], stopReason: 'end_turn' }
      ;(this.state as { messages: unknown[] }).messages.push(ok)
      if (reply) sub?.({ type: 'message_update', assistantMessageEvent: { type: 'text_delta', delta: reply } })
      sub?.({ type: 'agent_end', messages: [ok] })
    }
  })
}

type Sink = { events: RunWireEvent[]; ports: LaunchPorts['emit'] }
const sink = (): Sink => {
  const events: RunWireEvent[] = []
  let seq = 0
  return {
    events,
    ports: {
      nextSeq: () => ++seq,
      appendEvent: (e) => events.push(e),
      markTerminal: vi.fn(),
      broadcast: vi.fn(),
    },
  }
}

const kinds = (s: Sink) => s.events.map((e) => e.kind)
const terminals = (s: Sink) => s.events.filter((e) => e.kind === 'run.complete' || e.kind === 'run.error')

// Fake ports: single-slot pool that records acquire/release, capturing the tool ctx.
function makePorts(s: Sink, over: Partial<LaunchPorts> = {}): { ports: LaunchPorts; slotLog: string[]; getCtx: () => ToolRunContext } {
  const slotLog: string[] = []
  let ctx: ToolRunContext | undefined
  const ports: LaunchPorts = {
    emit: s.ports,
    toolRegistry: {
      resolve: (_allow: string[], c: ToolRunContext) => {
        ctx = c
        return { tools: [], riskOf: () => 'low' as const }
      },
    } as never,
    permissionRegistry: { request: vi.fn(async () => 'grant'), resolve: vi.fn() } as never,
    acquireSlot: async () => {
      slotLog.push('acquire')
      return () => slotLog.push('release')
    },
    registerAbort: vi.fn(),
    unregisterAbort: vi.fn(),
    ...over,
  }
  return { ports, slotLog, getCtx: () => ctx as ToolRunContext }
}

const spec = (over: Partial<RunSpec> = {}): RunSpec => ({
  kind: 'work',
  sessionId: 's1',
  agent: { id: 'default', name: 'd', description: 'd', systemPrompt: '', toolScope: 'all', maxIterations: 25 } as never,
  provider: { id: 'c1', model: 'test-model', apiStyle: 'anthropic', apiKey: 'k' } as never,
  prompt: 'go',
  budget: { tokens: 1e9, calls: 100, wallMs: 600_000, usdCents: 100_000 } as never,
  retry: { maxRetries: 0, delayMs: 0 },
  ...over,
})

beforeEach(() => {
  MockAgent.mockReset()
  holdPrompt = false
})

describe('launchRun', () => {
  it('emits created → dispatched → complete in order, stamping identity', async () => {
    installAgent()
    const s = sink()
    const { ports } = makePorts(s)
    const r = await launchRun(spec(), ports)
    expect(r.status).toBe('completed')
    expect(kinds(s)).toEqual(['run.created', 'run.dispatched', 'run.progress', 'run.complete'])
    expect(s.events[0]).toMatchObject({ kind: 'run.created', goal: 'go', sessionId: 's1', runId: r.runId })
    expect('parentRunId' in s.events[0]).toBe(false)
  })

  it('stamps parentRunId + agentDefId for child runs and honors a provided runId', async () => {
    installAgent()
    const s = sink()
    const { ports } = makePorts(s)
    const r = await launchRun(spec({ kind: 'child', runId: 'child-1', parentRunId: 'parent-1' }), ports)
    expect(r.runId).toBe('child-1')
    expect(s.events[0]).toMatchObject({ runId: 'child-1', parentRunId: 'parent-1', agentDefId: 'default' })
  })

  it('registers the abort handle BEFORE waiting, and a cancel during the turn wait terminates without starting the engine', async () => {
    installAgent()
    const s = sink()
    let registeredAbort: (() => void) | null = null
    let sawRegisterBeforeWait = false
    const resolveCapture: { ctxResolved: boolean } = { ctxResolved: false }
    const { ports } = makePorts(s, {
      registerAbort: (_id, abort) => {
        registeredAbort = abort
      },
      waitTurn: async () => {
        sawRegisterBeforeWait = registeredAbort !== null
        registeredAbort?.()
        // never resolves normally; the launch must bail on the abort signal
      },
      toolRegistry: {
        resolve: () => {
          resolveCapture.ctxResolved = true
          return { tools: [], riskOf: () => 'low' as const }
        },
      } as never,
    })
    const r = await launchRun(spec({ kind: 'turn' }), ports)
    expect(sawRegisterBeforeWait).toBe(true)
    expect(r.status).toBe('cancelled')
    expect(resolveCapture.ctxResolved).toBe(false) // engine/tools never built
    const t = terminals(s)
    expect(t).toHaveLength(1)
    expect(t[0]).toMatchObject({ kind: 'run.error', error: { code: 'cancelled' } })
  })

  it('emits agent_setup_failed when the engine cannot be constructed, releasing the slot', async () => {
    installAgent()
    const s = sink()
    const { ports, slotLog } = makePorts(s)
    const r = await launchRun(spec({ provider: { id: 'c1', model: 'm', apiStyle: 'anthropic', apiKey: '' } as never }), ports)
    expect(r.status).toBe('failed')
    const t = terminals(s)
    expect(t).toHaveLength(1)
    expect(t[0]).toMatchObject({ kind: 'run.error', error: { code: 'agent_setup_failed' } })
    expect(slotLog).toEqual(['acquire', 'release'])
    expect(ports.unregisterAbort).toHaveBeenCalled()
  })

  it("releases the parent's slot while a delegate call blocks and reacquires after (ledger #5)", async () => {
    installAgent()
    holdPrompt = true
    const s = sink()
    let finishDelegate: (r: { runId: string; status: 'completed'; summary: string }) => void = () => undefined
    const { ports, slotLog, getCtx } = makePorts(s, {
      delegate: () => new Promise((res) => (finishDelegate = res as never)),
    })
    const p = launchRun(spec(), ports)
    await vi.waitFor(() => expect(getCtx()).toBeDefined())
    const childP = getCtx().spawnChild('child goal')
    await vi.waitFor(() => expect(slotLog).toEqual(['acquire', 'release']))
    finishDelegate({ runId: 'c1', status: 'completed', summary: 'child done' })
    const child = await childP
    expect(child.result.summary).toBe('child done')
    await vi.waitFor(() => expect(slotLog).toEqual(['acquire', 'release', 'acquire']))
    resolveHeldPrompt()
    await p
    expect(slotLog).toEqual(['acquire', 'release', 'acquire', 'release'])
  })

  it('wires setDelegationPlan for every run: emits run.delegation_plan then the spec callback (ledger #12)', async () => {
    installAgent()
    holdPrompt = true
    const s = sink()
    const onDelegationPlan = vi.fn()
    const { ports, getCtx } = makePorts(s)
    const p = launchRun(spec({ onDelegationPlan }), ports)
    await vi.waitFor(() => expect(getCtx()).toBeDefined())
    const plan = [{ id: 'a', goal: 'g', dependsOn: [] }]
    getCtx().setDelegationPlan?.(plan as never)
    expect(s.events.some((e) => e.kind === 'run.delegation_plan')).toBe(true)
    expect(onDelegationPlan).toHaveBeenCalledWith(plan)
    resolveHeldPrompt()
    await p
  })

  it('messaging context REJECTS instead of faking success (ledger #11 hardening)', async () => {
    installAgent()
    holdPrompt = true
    const s = sink()
    const { ports, getCtx } = makePorts(s)
    const p = launchRun(spec(), ports)
    await vi.waitFor(() => expect(getCtx()).toBeDefined())
    await expect(getCtx().sendMessage('peer', 'hi')).rejects.toThrow('messaging is not available')
    await expect(getCtx().sendAndWait('peer', 'hi')).rejects.toThrow('messaging is not available')
    resolveHeldPrompt()
    await p
  })

  it('spawnChild rejects loudly when no delegate port is bound', async () => {
    installAgent()
    holdPrompt = true
    const s = sink()
    const { ports, getCtx } = makePorts(s)
    const p = launchRun(spec(), ports)
    await vi.waitFor(() => expect(getCtx()).toBeDefined())
    await expect(getCtx().spawnChild('g')).rejects.toThrow('delegate is not available')
    resolveHeldPrompt()
    await p
  })

  it('provides analyzeImage backed by a SILENT nested run for an image-capable provider', async () => {
    installAgent('ocr text')
    const s = sink()
    const { ports, getCtx } = makePorts(s)
    holdPrompt = true
    const p = launchRun(
      spec({
        provider: {
          id: 'anthropic',
          registry: 'anthropic',
          apiStyle: 'anthropic',
          model: (await import('@swarm/protocol')).ANTHROPIC_MODEL_SUGGESTIONS[0],
          apiKey: 'k',
        } as never,
      }),
      ports
    )
    await vi.waitFor(() => expect(getCtx()).toBeDefined())
    // Release the hold for NEW prompts: the outer run's prompt is already
    // parked on its own promise (unaffected), but the nested vision run must
    // complete — a module-level hold would park it too AND clobber the outer
    // run's resolver, deadlocking the test.
    holdPrompt = false
    expect(getCtx().analyzeImage).toBeDefined()
    const before = s.events.length
    const text = await getCtx().analyzeImage!('what is this', { data: 'AA==', mimeType: 'image/png' })
    expect(text).toBe('ocr text')
    expect(s.events.length).toBe(before) // the nested run emitted NOTHING to the parent sink
    resolveHeldPrompt()
    await p
  })
})
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd apps/desktop && npm test -- src/service/run-engine/launch.test.ts`
Expected: FAIL — cannot resolve `./launch`.

- [ ] **Step 3: Write the implementation**

Create `apps/desktop/src/service/run-engine/launch.ts`:

```ts
import type { AgentMessage } from '@earendil-works/pi-agent-core'
import { createLogger } from '@shared/logger'
import type {
  AgentDefinition,
  Attachment,
  ConsumedResources,
  DelegationItem,
  PermissionMode,
  ProviderInjection,
  ResourceBudget,
} from '@swarm/protocol'
import { emptyUsed } from '@swarm/protocol'
import { ulid } from 'ulid'

import type { PermissionRegistry } from '../session/permission-registry'
import type { ToolRegistry, ToolRunContext } from '../tools/registry'
import { createRunEmit, type RunEmit, type RunEmitPorts } from './emit'
import { createEngine, type EngineRunResult, EngineSetupError } from './engine'
import { injectionSupportsImages } from './models'

const log = createLogger({ process: 'service' }).child({ component: 'run-launch' })

export type RunKind = 'turn' | 'work' | 'child'

export type DelegateResult = { runId: string; status: 'completed' | 'failed' | 'cancelled'; summary: string }

export type RunSpec = {
  kind: RunKind
  /** Minted when absent. */
  runId?: string
  sessionId: string
  agent: AgentDefinition
  provider: ProviderInjection
  fallbackProviders?: ProviderInjection[]
  /** The user-facing goal; also the run.created goal. */
  prompt: string
  /** Prior context ONLY — never contains the prompt (spec D4). */
  history?: AgentMessage[]
  attachments?: Attachment[]
  budget: ResourceBudget
  parentRunId?: string
  /** Tool allowlist; empty resolves the agent's defaults per registry semantics. */
  tools?: string[]
  cwd?: string
  executionMode?: 'goal' | 'plan'
  permissionMode?: PermissionMode
  getPermissionMode?: () => PermissionMode
  saveSnapshot?: (messages: AgentMessage[], used: ConsumedResources, contextWindow?: number) => void
  maxIterationsOverride?: number
  retry?: { maxRetries?: number; delayMs?: number }
  onDelegationPlan?: (plan: DelegationItem[]) => void
}

export type LaunchPorts = {
  emit: RunEmitPorts
  toolRegistry: ToolRegistry
  permissionRegistry: PermissionRegistry
  /** Per-session FIFO ticket for 'turn' runs; resolves when the run may execute. */
  waitTurn?: (sessionId: string, runId: string, signal: AbortSignal) => Promise<void>
  /** Global concurrency pool; resolves with the release fn. */
  acquireSlot: (signal: AbortSignal) => Promise<() => void>
  registerAbort: (runId: string, abort: () => void) => void
  unregisterAbort: (runId: string) => void
  /** Recursive child launch (SessionService binds this in W3 to a nested launchRun). */
  delegate?: (
    parentRunId: string,
    goal: string,
    opts: { suggestedTools?: string[]; providerKey?: string; agentType?: string }
  ) => Promise<DelegateResult>
  writeAgent?: ToolRunContext['writeAgent']
  writeSkill?: ToolRunContext['writeSkill']
  findAgents?: ToolRunContext['findPeers']
}

/** System prompt for the one-shot vision/OCR sub-run (v1 parity). */
const VISION_SYSTEM_PROMPT =
  'You are a vision and OCR assistant. Look at the provided image and answer the request precisely. For OCR, return only the extracted text, preserving line breaks. Do not add commentary.'

const SILENT_EMIT_PORTS: RunEmitPorts = {
  nextSeq: () => 0,
  appendEvent: () => undefined,
  markTerminal: () => undefined,
  broadcast: () => undefined,
}

const cancelledResult = (runId: string, history: AgentMessage[]): EngineRunResult & { runId: string } => ({
  runId,
  status: 'cancelled',
  summary: '',
  messages: history,
  used: emptyUsed(),
})

/**
 * The ONE way any run starts (spec §3). Owns: id mint, run.created/dispatched,
 * abort-before-waits (ledger #4), slot acquisition + delegate slot-yield
 * (ledger #5), uniform tool-context assembly (ledger #11/#12), engine
 * invocation, setup-failure terminals, cleanup. Never rejects.
 */
export async function launchRun(spec: RunSpec, ports: LaunchPorts): Promise<EngineRunResult & { runId: string }> {
  const runId = spec.runId ?? ulid()
  const emit: RunEmit = createRunEmit(ports.emit, {
    sessionId: spec.sessionId,
    runId,
    ...(spec.parentRunId !== undefined ? { parentRunId: spec.parentRunId } : {}),
  })
  const runLog = log.child({ runId, sessionId: spec.sessionId })
  const ac = new AbortController()
  // Register BEFORE any wait: a cancel issued while queued must find the handle
  // (v1's spawnChild registered after the slot — the exact race, ledger #4).
  ports.registerAbort(runId, () => ac.abort())
  emit({
    kind: 'run.created',
    goal: spec.prompt,
    ...(spec.attachments?.length ? { attachments: spec.attachments } : {}),
    ...(spec.kind === 'child' ? { agentDefId: spec.agent.id } : {}),
  })
  runLog.info({ msg: 'run created', kind: spec.kind, agentId: spec.agent.id, promptLen: spec.prompt.length })

  let release: (() => void) | null = null
  // Depth-counted so parallel delegate tool calls don't double-release/acquire.
  let yieldDepth = 0
  const withSlotReleased = async <T>(fn: () => Promise<T>): Promise<T> => {
    yieldDepth++
    if (yieldDepth === 1 && release) {
      release()
      release = null
    }
    try {
      return await fn()
    } finally {
      yieldDepth--
      if (yieldDepth === 0 && !ac.signal.aborted) release = await ports.acquireSlot(ac.signal)
    }
  }

  const emitCancelled = (): void => {
    emit({ kind: 'run.error', error: { code: 'cancelled', message: 'Stopped by user.', tier: 'gave_up' } })
    runLog.info({ msg: 'run cancelled before dispatch' })
  }

  try {
    if (spec.kind === 'turn' && ports.waitTurn) {
      await Promise.race([
        ports.waitTurn(spec.sessionId, runId, ac.signal),
        new Promise<void>((resolve) => {
          if (ac.signal.aborted) resolve()
          else ac.signal.addEventListener('abort', () => resolve(), { once: true })
        }),
      ])
    }
    if (ac.signal.aborted) {
      emitCancelled()
      return cancelledResult(runId, spec.history ?? [])
    }
    release = await ports.acquireSlot(ac.signal)
    if (ac.signal.aborted) {
      emitCancelled()
      return cancelledResult(runId, spec.history ?? [])
    }
    emit({ kind: 'run.dispatched' })
    runLog.info({ msg: 'run dispatched', kind: spec.kind })

    // Uniform tool context — identical for every kind (ledger #11/#12).
    const usageSink = { charge: (_costUsd: number): void => undefined }
    const ctx: ToolRunContext = {
      sessionId: spec.sessionId,
      taskId: runId,
      cwd: spec.cwd,
      spawnChild: (goal, suggestedTools, providerKey, agentType) => {
        if (!ports.delegate) return Promise.reject(new Error('delegate is not available in this run'))
        return withSlotReleased(() => ports.delegate!(runId, goal, { suggestedTools, providerKey, agentType })).then((r) => ({
          childTaskId: r.runId,
          result: { summary: r.summary, artifacts: [] },
        }))
      },
      send: () => undefined,
      // Tools must NOT self-gate: permission is enforced centrally in the engine.
      requestPermission: () => Promise.resolve('grant' as const),
      // No silent fake success (v1 optional-chained to a no-op and reported
      // delivery — ledger #11). The messaging tools are deleted in W3; until
      // then a call fails loudly.
      sendMessage: () => Promise.reject(new Error('messaging is not available in this run')),
      sendAndWait: () => Promise.reject(new Error('messaging is not available in this run')),
      findPeers: (q) => ports.findAgents?.(q) ?? [],
      writeAgent: ports.writeAgent,
      writeSkill: ports.writeSkill,
      setDelegationPlan: (plan) => {
        emit({ kind: 'run.delegation_plan', plan })
        spec.onDelegationPlan?.(plan)
      },
      reportExternalUsage: (usage) => {
        if (usage.costUsd && usage.costUsd > 0) usageSink.charge(usage.costUsd)
      },
      analyzeImage: buildAnalyzeImage(spec, ports, runId, ac.signal),
    }
    const { tools, riskOf } = ports.toolRegistry.resolve(spec.tools ?? [], ctx)
    if (tools.length === 0) runLog.warn({ msg: 'no tools resolved for run', toolAllowlist: spec.tools ?? [] })

    const engine = createEngine({
      runId,
      sessionId: spec.sessionId,
      agentDefinition: spec.agent,
      provider: spec.provider,
      fallbackProviders: spec.fallbackProviders,
      history: spec.history ?? [],
      budget: spec.budget,
      cwd: spec.cwd,
      executionMode: spec.executionMode,
      permissionMode: spec.permissionMode,
      getPermissionMode: spec.getPermissionMode,
      tools,
      riskOf,
      emit,
      permissionRegistry: ports.permissionRegistry,
      signal: ac.signal,
      saveSnapshot: spec.saveSnapshot,
      maxIterationsOverride: spec.maxIterationsOverride,
      retry: spec.retry,
    })
    usageSink.charge = (costUsd) => engine.chargeExternalUsd(costUsd)

    const images = (spec.attachments ?? []).map((a) => ({ type: 'image' as const, data: a.data, mimeType: a.mimeType }))
    const r = await engine.run(spec.prompt, images.length > 0 ? images : undefined)
    runLog.info({ msg: 'run finished', status: r.status, summaryLen: r.summary.length })
    return { runId, ...r }
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err)
    const code = err instanceof EngineSetupError ? 'agent_setup_failed' : 'agent_exception'
    runLog.error({ msg: 'run launch failed', code, err: message })
    emit({ kind: 'run.error', error: { code, message, tier: 'fatal' } })
    return { runId, status: 'failed', summary: '', messages: spec.history ?? [], used: emptyUsed() }
  } finally {
    release?.()
    ports.unregisterAbort(runId)
  }
}

/**
 * Vision capability for the tool context: first image-capable model in the
 * chain, driven through a SILENT nested launch (no events reach the parent's
 * sink; the visible analyze_image tool.call/result already represents it).
 * The nested run shares the parent's cancellation and rides the parent's slot.
 */
function buildAnalyzeImage(
  spec: RunSpec,
  ports: LaunchPorts,
  parentRunId: string,
  parentSignal: AbortSignal
): ToolRunContext['analyzeImage'] {
  const chain = [spec.provider, ...(spec.fallbackProviders ?? spec.provider.fallbackProviders ?? [])].filter(
    (p): p is ProviderInjection => !!p
  )
  const vision = chain.find(injectionSupportsImages)
  if (!vision) return undefined
  return async (prompt, image) => {
    const r = await launchRun(
      {
        kind: 'work',
        runId: `${parentRunId}:vision:${ulid()}`,
        sessionId: spec.sessionId,
        agent: {
          id: 'vision',
          name: 'Vision',
          description: 'One-shot vision/OCR sub-run.',
          systemPrompt: VISION_SYSTEM_PROMPT,
          toolScope: 'all',
          maxIterations: 2,
        } as AgentDefinition,
        provider: vision,
        prompt,
        attachments: [{ data: image.data, mimeType: image.mimeType }],
        budget: spec.budget,
        tools: [],
        permissionMode: spec.permissionMode,
        maxIterationsOverride: 2,
      },
      {
        ...ports,
        emit: SILENT_EMIT_PORTS,
        waitTurn: undefined,
        delegate: undefined,
        // Rides the parent's slot: the nested run must not compete for the pool
        // while its parent already holds a slot (that's the ledger-#5 shape).
        acquireSlot: async () => () => undefined,
        registerAbort: (_id, abort) => {
          if (parentSignal.aborted) abort()
          else parentSignal.addEventListener('abort', abort, { once: true })
        },
        unregisterAbort: () => undefined,
      }
    )
    return r.summary
  }
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `cd apps/desktop && npm test -- src/service/run-engine/launch.test.ts`
Expected: PASS (9 tests). Then the whole module: `npm test -- src/service/run-engine`
Expected: PASS.

- [ ] **Step 5: Format and commit**

```bash
npx biome check --write apps/desktop/src/service/run-engine/launch.ts apps/desktop/src/service/run-engine/launch.test.ts
git add apps/desktop/src/service/run-engine/launch.ts apps/desktop/src/service/run-engine/launch.test.ts
git commit -m "feat(run-engine): launch.ts — the one way any run starts

Mint → run.created → abort-before-waits (ledger #4) → turn ticket → slot
→ run.dispatched → uniform tool context (messaging rejects loudly #11,
setDelegationPlan everywhere #12, delegate yields the parent slot #5,
silent nested vision run) → engine → synthetic terminals for setup
failures → cleanup. launchRun never rejects."
```

---

### Task 4: Full gate + import guard + integration

**Files:** none (verification + merge).

**Interfaces:**
- Consumes: the three commits above.
- Produces: `worktree-run-engine-w2` merged into `develop` (ff-only); W3 binds SessionService to `launchRun`.

- [ ] **Step 1: Import guard**

Run from the worktree root:
```bash
grep -rn "run-engine" apps/desktop/src --include="*.ts" -l | grep -v "src/service/run-engine/"
```
Expected: no output (nothing outside the module imports it).

```bash
grep -rn "from '\.\./" apps/desktop/src/service/run-engine --include="*.ts" | grep -v "'../tools/registry'" | grep -v "'../session/permission-registry'"
```
Expected: no output (the only parent-directory imports are the two sanctioned type surfaces). Then confirm both are type-only:
```bash
grep -rn "import.*'\.\./\(tools/registry\|session/permission-registry\)'" apps/desktop/src/service/run-engine --include="*.ts" | grep -v "import type"
```
Expected: no output.

- [ ] **Step 2: Full desktop suite**

Run: `cd apps/desktop && npm test > /tmp/w2-gate.log 2>&1; echo "EXIT:$?"; tail -4 /tmp/w2-gate.log`
Expected: `EXIT:0`, all test files passing (develop's gate is fully green since 4c294f7 — any failure is a W2 regression; do NOT run pnpm/turbo at the worktree root).

- [ ] **Step 3: Integrate (superpowers:finishing-a-development-branch)**

```bash
git -C <main-checkout> status   # must be clean
git rebase develop
git checkout develop && git merge --ff-only worktree-run-engine-w2
```
Worktree teardown safety (2026-07-04 lesson): delete the manual node_modules symlinks BEFORE `git worktree remove`, and verify main's links don't point into the worktree:
```bash
find <worktree> -maxdepth 3 -name node_modules -type l -delete
readlink <main-checkout>/apps/desktop/node_modules/cross-env   # must NOT contain ".claude/worktrees"
git worktree remove <worktree> && git worktree prune
```

---

## Forward pointer

W3 (next plan, written after W2 lands): SessionService rewrite on `launchRun` (binds emit ports to seq-counter/store/terminal-registry/broadcaster, the FIFO pump as `waitTurn`, the slot pool, `delegate` as a nested `launchRun` with sub budget), actor-half deletion (runResident/mailbox/messaging tools/tables/prompts/task-waiters), `delegate`/`find_agents` tool rework (`DelegateResult.status` reaches the tool result), dispatcher/index rewiring. W4: wire rename + DB migration + switchover.
