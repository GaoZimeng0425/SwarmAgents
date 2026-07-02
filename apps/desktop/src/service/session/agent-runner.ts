import type { AgentEvent, AgentMessage, AgentTool } from '@earendil-works/pi-agent-core'
import { Agent, DEFAULT_COMPACTION_SETTINGS, shouldCompact } from '@earendil-works/pi-agent-core'
import type { Api, ImageContent, KnownProvider, Model, Usage } from '@earendil-works/pi-ai'
import { clampThinkingLevel } from '@earendil-works/pi-ai'
import { getBuiltinModel as getModel, getBuiltinModels as getModels } from '@earendil-works/pi-ai/providers/all'
import { createLogger } from '@shared/logger'
import type {
  ActorMessage,
  AgentDefinition,
  ModelPricing,
  Peer,
  PeerQuery,
  ProviderInjection,
  Skill,
  SkillMutationResult,
} from '@swarm/protocol'
import {
  type AcceptanceCriterion,
  ANTHROPIC_MODEL_SUGGESTIONS,
  type ApiStyle,
  type Attachment,
  type BudgetConfig,
  type ConsumedResources,
  DEFAULT_CONTEXT_WINDOW,
  type DelegationItem,
  emptyUsed,
  OPENAI_MODEL_SUGGESTIONS,
  type PermissionMode,
  type SpawnChildOptions,
  type Task,
  type TaskEvent,
  type TaskResult,
  type VerificationRound,
} from '@swarm/protocol'
import { reasoningOverridesFor } from '@swarm/shared'

import { IdleTimeoutError, type Mailbox } from '../actor/mailbox'
import { encodeActorState } from '../actor/state'
import type { AgentMutationResult } from '../agents/store'
import type { ToolRegistry, ToolRisk, ToolRunContext } from '../tools/registry'
import type { PermissionRegistry } from './permission-registry'
import { type Judge, parseVerdict, type Verdict, verifyTask } from './verify'

const log = createLogger({
  process: 'service',
  workerId: 'service',
}).child({ component: 'agent-runner' })

// `getModel`'s generics demand a literal model-id key per provider. Our
// `ProviderInjection.model` is a runtime-validated string (Zod-checked at the
// IPC boundary), so we erase the literal constraint via a looser local
// alias. This avoids `as any` and keeps callers strict.
const getModelLoose = getModel as unknown as (provider: KnownProvider, modelId: string) => Model<Api> | undefined

const FALLBACK_MODEL_ID: Record<ApiStyle, string> = {
  anthropic: ANTHROPIC_MODEL_SUGGESTIONS[0],
  openai: OPENAI_MODEL_SUGGESTIONS[0],
}

const API_FOR_STYLE: Record<ApiStyle, Api> = {
  openai: 'openai-completions',
  anthropic: 'anthropic-messages',
}

// Transient-failure retry policy for the model request. A failed provider/
// transport request is retried up to MAX_PROMPT_RETRIES extra times (so up to
// MAX_PROMPT_RETRIES + 1 attempts total), pausing RETRY_DELAY_MS between tries.
// Only genuine request errors retry — deliberate stops (cancel/budget/context)
// never do.
const MAX_PROMPT_RETRIES = 10
const RETRY_DELAY_MS = 5_000

// Sleep that resolves early if `signal` aborts, so a queued retry never delays
// a user cancellation. Returns once the delay elapses OR the signal fires.
function abortableDelay(ms: number, signal?: AbortSignal): Promise<void> {
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

// Failures where retrying the SAME model is pointless — advance to the next
// model in the chain (or give up) immediately instead of burning the transient-
// retry budget on a dead key, a missing model, or an exhausted quota. Anything
// not matched here (timeouts, 5xx, rate limits, transport resets) is treated as
// transient and retried in place.
export function isPermanentModelFailure(message: string): boolean {
  return /\b(401|403|404)\b|invalid[\s_-]?api[\s_-]?key|unauthor|authentication|permission denied|model not found|no such model|does not exist|insufficient[\s_-]?quota|billing/i.test(
    message
  )
}

// Whether an injection's resolved model accepts image input — used to pick a
// vision model from the provider chain for the analyze_image tool. Unresolvable
// models are treated as not image-capable.
export function injectionSupportsImages(p: ProviderInjection): boolean {
  try {
    return resolveModel(p).input?.includes('image') ?? false
  } catch {
    return false
  }
}

// System prompt for the one-shot vision/OCR sub-call. Kept terse: the sub-call
// has no tools and runs a single answering turn.
const VISION_SYSTEM_PROMPT =
  'You are a vision and OCR assistant. Look at the provided image and answer the request precisely. For OCR, return only the extracted text, preserving line breaks. Do not add commentary.'

// Maps OpenRouter-derived pricing (USD/1M tokens) to pi-ai's Model.cost shape
// (also USD/1M). Absent cache prices default to 0. Exported for unit testing.
export function pricingToCost(pricing: ModelPricing): Model<Api>['cost'] {
  return {
    input: pricing.inputPerM,
    output: pricing.outputPerM,
    cacheRead: pricing.cacheReadPerM ?? 0,
    cacheWrite: pricing.cacheWritePerM ?? 0,
  }
}

function cloneTemplate(
  template: Model<Api>,
  p: ProviderInjection,
  style: ApiStyle,
  contextWindow?: number
): Model<Api> {
  const { compat: _drop, ...rest } = template
  // Re-attach reasoning wire metadata for known custom families (GLM/DeepSeek/
  // MiMo). Without this graft a custom endpoint inherits the fallback template's
  // reasoning fields, so pi-ai can't emit the provider's own thinking params.
  const reasoning = reasoningOverridesFor(p.model)
  return {
    ...rest,
    id: p.model,
    baseUrl: p.baseUrl ?? template.baseUrl,
    api: API_FOR_STYLE[style],
    ...(contextWindow != null ? { contextWindow } : {}),
    // Custom-model pricing (from OpenRouter) overrides the fallback template's
    // cost so pi-ai's calculateCost() produces real per-turn cost for usdCents.
    ...(p.pricing ? { cost: pricingToCost(p.pricing) } : {}),
    ...(reasoning ?? {}),
  }
}

function resolveModel(p: ProviderInjection): Model<Api> {
  // `registry` is the single discriminator: absent ⇒ a custom endpoint pi-ai
  // doesn't know, looked up by its wire style (apiStyle); present ⇒ a valid
  // pi-ai provider key with a real model catalog. Nothing branches on the id.
  if (!p.registry) {
    const style = p.apiStyle
    const matched = getModelLoose(style, p.model)
    const template =
      matched ?? getModelLoose(style, FALLBACK_MODEL_ID[style]) ?? (getModels(style)[0] as Model<Api> | undefined)
    if (!template) throw new Error(`pi-ai has no registered models for style "${style}"`)
    // A custom endpoint's model is often unknown to pi-ai, so its window would
    // otherwise inherit the fallback template's (gpt-4o = 128k) — wrong for the
    // real model. Honor the user's override, else the matched model's real
    // window, else a sane 200k default.
    const contextWindow = p.contextWindow ?? matched?.contextWindow ?? DEFAULT_CONTEXT_WINDOW
    return cloneTemplate(template, p, style, contextWindow)
  }

  const exact = getModelLoose(p.registry, p.model)
  if (exact && !p.baseUrl) return exact

  const template =
    exact ??
    getModelLoose(p.registry, FALLBACK_MODEL_ID[p.registry]) ??
    (getModels(p.registry)[0] as Model<Api> | undefined)
  if (!template) throw new Error(`pi-ai has no registered models for provider "${p.registry}"`)

  return cloneTemplate(template, p, p.registry)
}

type EmitFn = (event: string, data: unknown) => void

export type AgentRunnerDeps = {
  /** @deprecated being removed — pass the explicit fields below instead. */
  task?: Task
  /** Opaque run id: emitted as `taskId` on every event, used as the spawnChild
   *  parent id. Replaces task.id. The runner does NOT interpret it. */
  correlationId?: string
  /** Working directory. Replaces task.cwd. */
  cwd?: string
  /** Objective text — seeds the first user turn and the verify/criteria prompts.
   *  Replaces task.goal. (Phase-3 folds this into initialMessages.) */
  goal?: string
  /** Replaces task.executionMode. */
  executionMode?: 'goal' | 'plan'
  /** Replaces task.budget. */
  budget?: BudgetConfig
  /** Per-invocation tool override. Replaces task.toolAllowlist. */
  toolAllowlist?: string[]
  /** Replaces task.attachments. */
  attachments?: Attachment[]
  /** Fallback when getPermissionMode is absent. Replaces task.permissionMode. */
  permissionMode?: PermissionMode
  /** Replaces task.acceptanceCriteria. */
  acceptanceCriteria?: AcceptanceCriterion[]
  provider: ProviderInjection
  agentDefinition: AgentDefinition
  sessionId: string
  emit: EmitFn
  permissionRegistry: PermissionRegistry
  toolRegistry: ToolRegistry
  initialMessages: AgentMessage[]
  /**
   * Resolve the permission gate live, at each tool call. Lets the composer's
   * permission toggle take effect mid-run regardless of when it was flipped —
   * the gate is never frozen to the task's submit-time snapshot. Falls back to
   * the task snapshot (then 'ask') when not supplied.
   */
  getPermissionMode?: () => PermissionMode
  /** Aborts the run when fired. The manager wires this to cancelTask. */
  signal?: AbortSignal
  /** Persist the conversation + usage at each turn boundary so they survive an interrupt. */
  saveSnapshot?(messages: AgentMessage[], used: ConsumedResources, contextWindow?: number): void
  spawnChild(
    parentTaskId: string,
    newGoal: string,
    suggestedTools?: string[],
    providerKey?: string,
    agentType?: string,
    options?: SpawnChildOptions
  ): Promise<{ childTaskId: string; result: TaskResult }>
  /** This run's actor address, when run as a resident actor. */
  selfAddress?: string
  /** Deliver a message to another actor. rpc awaits a reply; send is fire-and-forget. */
  sendMessage?(
    from: string | null,
    to: string,
    payload: string,
    kind: 'send' | 'rpc'
  ): Promise<{ reply: string } | { delivered: true }>
  /** Discover peer agents in this session. */
  findPeers?(q: PeerQuery): Peer[]
  /** Author/overwrite an agent definition on disk (training team only). */
  writeAgent?(def: AgentDefinition): AgentMutationResult
  /** Author/overwrite a skill on disk (training team only). */
  writeSkill?(skill: Skill): SkillMutationResult
  /**
   * Transient model-request retry overrides. Defaults: 10 retries, 5s apart.
   * Tests inject smaller values to exercise the loop without real waits.
   */
  retry?: { maxRetries?: number; delayMs?: number }
  /**
   * Ordered fallback providers tried after `provider` when a request fails: the
   * effective model chain is `[provider, ...fallbackProviders]`. A model advances
   * to the next on exhausting its transient retries, or immediately on a
   * permanent failure (bad key / missing model / quota). Empty ⇒ unchanged
   * single-model behavior. Defaults to `provider.fallbackProviders` (resolved in
   * Main from the provider's fallbackProviderIds); set explicitly to override.
   */
  fallbackProviders?: ProviderInjection[]
  /** Capture the agent's derived acceptance criteria (Phase A). Wired by createAgentRunner.run. */
  onAcceptanceCriteria?(criteria: AcceptanceCriterion[]): void
  /** Capture the Leader's delegation DAG (set_delegation_plan tool). */
  onDelegationPlan?(plan: DelegationItem[]): void
  /**
   * Independently verify a completed turn. Default = hard checks + an LLM judge
   * sub-run; tests inject a stub. `judgeUsed` (when present) is folded into the
   * run's reported `used`.
   */
  verifyCompletion?(input: {
    criteria: AcceptanceCriterion[]
    summary: string
    cwd?: string
  }): Promise<Verdict & { judgeUsed?: ConsumedResources }>
  /**
   * Max execute→verify→rework rounds for a 'goal' task. Default 3. `0` disables
   * the verify loop entirely (legacy single-shot) — used by the verifier sub-run
   * to avoid recursion.
   */
  maxVerifyRounds?: number
  /**
   * Global override for the agent loop's per-run iteration cap. When set (> 0)
   * it replaces `agentDefinition.maxIterations` for the main turn loop. Does NOT
   * affect the internal 2-turn helper sub-runs (criteria/verify). Wired by the
   * manager from the user's BudgetConfig.
   */
  maxIterationsOverride?: number
}

export type AgentRunner = {
  run(): Promise<{
    status: 'completed' | 'failed' | 'cancelled'
    summary: string
    messages: AgentMessage[]
    used: ConsumedResources
  }>
}

/**
 * A long-lived agent session: ONE Task + ONE pi `Agent` per residency. The
 * `task`/`emit`/`budget` bindings stay fixed for the whole session, so
 * `used`/`contextTokens`/`startedAt` are session-level accumulators that
 * persist across `promptOnce` calls (one budget envelope per residency).
 *
 * Task 3 only ever issues a single `promptOnce` (the one-shot path); the
 * resident loop (Task 4) reuses `promptOnce` across turns.
 */
export type AgentSession = {
  promptOnce(
    goal: string,
    images?: ImageContent[]
  ): Promise<{ status: 'completed' | 'failed' | 'cancelled'; summary: string }>
  readonly agent: Agent
  getUsed(): ConsumedResources
  abort(): void
  // Latest turn's context occupancy + the model window — drives the resident
  // loop's compaction check (reuses the snapshot refreshed at each turn_end).
  readonly contextWindow: number
  getContextTokens(): number
}

/**
 * Assemble a ToolRunContext from AgentRunnerDeps.
 * Exported for unit testing; callers should use createAgentRunner for production use.
 */
export function buildToolContext(deps: AgentRunnerDeps): ToolRunContext {
  return {
    sessionId: deps.sessionId,
    taskId: deps.task?.id,
    cwd: deps.task?.cwd,
    spawnChild: (goal, suggestedTools, providerKey, agentType, options) =>
      deps.spawnChild(deps.task.id, goal, suggestedTools, providerKey, agentType, options),
    send: () => undefined,
    // Tools must NOT self-gate: permission is enforced centrally in beforeToolCall.
    // This stub satisfies the ToolRunContext type without creating a second gate.
    requestPermission: () => Promise.resolve('grant' as const),
    selfAddress: deps.selfAddress,
    sendMessage: async (to, payload) => {
      await deps.sendMessage?.(deps.selfAddress ?? null, to, payload, 'send')
    },
    sendAndWait: async (to, payload) => {
      const res = await deps.sendMessage?.(deps.selfAddress ?? null, to, payload, 'rpc')
      return res && 'reply' in res ? res.reply : ''
    },
    findPeers: (q) => deps.findPeers?.(q) ?? [],
    analyzeImage: buildAnalyzeImage(deps),
    writeAgent: deps.writeAgent,
    writeSkill: deps.writeSkill,
    setAcceptanceCriteria: deps.onAcceptanceCriteria,
    setDelegationPlan: deps.onDelegationPlan,
  }
}

/**
 * Resolve the vision capability for a task's tool context: pick the first
 * image-capable model in the chain (provider, then fallbacks) and return a
 * one-shot completion fn bound to it. Returns undefined when no image-capable
 * model is configured, so the analyze_image tool reports a clear setup error
 * instead of silently failing.
 */
function buildAnalyzeImage(
  deps: AgentRunnerDeps
): ((prompt: string, image: { data: string; mimeType: string }) => Promise<string>) | undefined {
  const chain = [deps.provider, ...(deps.fallbackProviders ?? deps.provider?.fallbackProviders ?? [])].filter(
    (p): p is ProviderInjection => !!p
  )
  const vision = chain.find(injectionSupportsImages)
  if (!vision) return undefined
  return async (prompt, image) => {
    const visionTask: Task = {
      ...deps.task,
      id: `${deps.task.id}:vision`,
      goal: prompt,
      attachments: [{ data: image.data, mimeType: image.mimeType }],
      toolAllowlist: [],
      executionMode: 'goal',
    }
    // A silent, tool-less one-shot on the vision model. emit is a no-op so the
    // sub-call's tokens/events don't pollute the parent task's transcript; the
    // visible analyze_image tool.call/result already represents it.
    const runner = createAgentRunner({
      task: visionTask,
      provider: vision,
      agentDefinition: {
        id: 'vision',
        name: 'Vision',
        description: 'One-shot vision/OCR sub-call.',
        systemPrompt: VISION_SYSTEM_PROMPT,
        toolScope: 'all',
        maxIterations: 2,
      },
      sessionId: deps.sessionId,
      emit: () => undefined,
      permissionRegistry: deps.permissionRegistry,
      toolRegistry: deps.toolRegistry,
      initialMessages: [],
      spawnChild: deps.spawnChild,
      signal: deps.signal,
    })
    const r = await runner.run()
    return r.summary
  }
}

/**
 * Inline event translator — adapts pi AgentEvents to service emit(event, data) calls.
 *
 * pi event → SSE event mapping:
 *   message_update(text_delta) → task.progress (buffered, flushed at sentence boundaries or 200 chars)
 *   tool_execution_start       → task.progress (tool.call)
 *   tool_execution_end         → task.progress (tool.result)
 *   agent_end                  → task.complete
 */
function createEventTranslator(
  taskId: string,
  emit: EmitFn
): {
  handle: (e: AgentEvent) => void
  getFinalSummary: () => string
  getError: () => string | null
  resetError: () => void
  setSuppressError: (suppress: boolean) => void
} {
  let textBuffer = ''
  let thinkingBuffer = ''
  let assembledSummary = ''
  // While a retry is still pending the run isn't done failing, so the per-turn
  // failure must NOT surface to the UI as task.error yet. The retry loop sets
  // this true for every attempt that has a retry left and false for the last
  // one, so the final failure emits exactly as it did before retries existed.
  let suppressErrorEmit = false
  // pi does NOT throw on a failed model/transport request, and prompt() resolves
  // with `void` — the failure is delivered ONLY as an assistant message with
  // stopReason 'error' carried on message_end / turn_end / agent_end events.
  // Capture it here so the run reports the real error instead of a silent,
  // empty "completed" turn.
  let errorMessage: string | null = null

  const flushText = (): void => {
    if (!textBuffer) return
    assembledSummary += textBuffer
    const event: TaskEvent = {
      kind: 'llm.message',
      role: 'assistant',
      content: textBuffer,
      ts: Date.now(),
    }
    emit('task.progress', { taskId, event, ts: Date.now() })
    textBuffer = ''
  }

  const flushThinking = (): void => {
    if (!thinkingBuffer) return
    const event: TaskEvent = { kind: 'reasoning', content: thinkingBuffer, ts: Date.now() }
    emit('task.progress', { taskId, event, ts: Date.now() })
    thinkingBuffer = ''
  }

  const captureFailure = (m: { stopReason?: string; errorMessage?: string } | undefined): void => {
    if (m?.stopReason === 'error') {
      errorMessage = m.errorMessage ?? 'The model request failed without a message.'
    }
  }

  const handle = (e: AgentEvent): void => {
    // message_end / turn_end carry the failure message; capture it before the
    // switch so a stopReason 'error' is never lost to the `default` branch.
    if ('message' in e) captureFailure((e as { message?: { stopReason?: string; errorMessage?: string } }).message)

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
          // Correlates start/end so results emitted in completion order (parallel
          // tool execution) pair with the right call instead of the wrong one.
          callId: e.toolCallId,
        }
        emit('task.progress', { taskId, event, ts: Date.now() })
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
        // The update_plan tool returns its checklist as structured `details.todos`.
        // Surface it as a dedicated task.plan event so the UI can render a panel
        // instead of a raw text blob.
        if (e.toolName === 'update_plan' && Array.isArray(result?.details?.todos)) {
          emit('task.plan', { taskId, todos: result.details.todos, ts: Date.now() })
        }
        // Image-producing tools (e.g. see_screen) save a file and report its path
        // in details. Carry it so the UI can preview/open the image.
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
        emit('task.progress', { taskId, event, ts: Date.now() })
        return
      }
      case 'agent_end': {
        flushThinking()
        flushText()
        // agent_end is pi's last event even on a failed run; its messages also
        // carry the failure, so re-check in case message_end was never seen.
        for (const m of e.messages ?? []) captureFailure(m as { stopReason?: string; errorMessage?: string })
        if (errorMessage) {
          // A failed run must surface the provider error, not a fake completion —
          // unless a retry is still pending, in which case the retry loop owns
          // the final emit so transient failures stay invisible.
          if (!suppressErrorEmit) {
            emit('task.error', {
              taskId,
              error: { code: 'agent_request_failed', message: errorMessage, tier: 'fatal' },
              ts: Date.now(),
            })
          }
          return
        }
        const summary = assembledSummary.trim() || `Completed task ${taskId}.`
        emit('task.complete', { taskId, result: { summary, artifacts: [] }, ts: Date.now() })
        return
      }
      default:
        return
    }
  }

  const getFinalSummary = (): string => assembledSummary
  const getError = (): string | null => errorMessage
  // Error state is per-turn: one residency runs many prompts, so a failure in
  // an earlier turn must not condemn a later successful one.
  const resetError = (): void => {
    errorMessage = null
  }

  const setSuppressError = (suppress: boolean): void => {
    suppressErrorEmit = suppress
  }

  return { handle, getFinalSummary, getError, resetError, setSuppressError }
}

// Prepend task-scoped context to the agent's base system prompt so the model
// honors the composer's choices: the working directory (relative paths/commands
// land there) and, in plan mode, the read-only "produce a plan first" constraint.
function composeSystemPrompt(base: string, task: Task): string {
  const prefix: string[] = []
  if (task.cwd) {
    prefix.push(
      `Working directory: ${task.cwd}. Treat it as the base for relative paths and run commands there unless told otherwise.`
    )
  }
  if (task.executionMode === 'plan') {
    prefix.push(
      'You are in PLAN mode. Investigate using read-only tools and produce a step-by-step plan with update_plan. Do NOT modify files or run mutating commands — you have no write tools.'
    )
  }
  return prefix.length ? `${prefix.join('\n\n')}\n\n${base}` : base
}

// The subset of the legacy Task the runner body reads. Resolved once per entry
// point from the explicit deps (preferred) with a temporary fallback to the
// deprecated `task` field. Task 7 removes the fallback and makes the fields
// required. Keeping the resolved local named `task` means the body's ~73
// `task.id` / `task.goal` / `task.budget` references need no edits.
type RunContext = {
  id: string
  cwd?: string
  goal: string
  executionMode?: 'goal' | 'plan'
  budget: BudgetConfig
  toolAllowlist?: string[]
  attachments?: Attachment[]
  permissionMode?: PermissionMode
  acceptanceCriteria?: AcceptanceCriterion[]
}

function resolveRunContext(deps: AgentRunnerDeps): RunContext {
  const t = deps.task
  return {
    id: (deps.correlationId ?? t?.id) as string,
    cwd: deps.cwd ?? t?.cwd,
    goal: (deps.goal ?? t?.goal) as string,
    executionMode: deps.executionMode ?? t?.executionMode,
    budget: (deps.budget ?? t?.budget) as BudgetConfig,
    toolAllowlist: deps.toolAllowlist ?? t?.toolAllowlist,
    attachments: deps.attachments ?? t?.attachments,
    permissionMode: deps.permissionMode ?? t?.permissionMode,
    acceptanceCriteria: deps.acceptanceCriteria ?? t?.acceptanceCriteria,
  }
}

/**
 * Build a long-lived agent session from deps. Performs all one-time setup
 * (tool/model resolution, `Agent` construction, signal wiring, subscriptions)
 * eagerly, then exposes `promptOnce` to drive one turn at a time against the
 * SAME agent. The `run()` one-shot path is a thin wrapper that builds a
 * session, prompts once, and reads `agent.state.messages` + `getUsed()`.
 *
 * Behavior preservation: this is a pure extraction of the former
 * `createAgentRunner().run()` body — the one-shot external contract is
 * unchanged.
 */
export function buildAgentSession(deps: AgentRunnerDeps): AgentSession {
  const { provider, agentDefinition, sessionId, emit, permissionRegistry, initialMessages, toolRegistry } = deps
  const task = resolveRunContext(deps)
  const maxRetries = deps.retry?.maxRetries ?? MAX_PROMPT_RETRIES
  const retryDelayMs = deps.retry?.delayMs ?? RETRY_DELAY_MS
  const taskLog = log.child({ taskId: task.id })
  taskLog.info({
    msg: 'buildAgentSession entered',
    goalLen: task.goal.length,
    injection: {
      id: provider.id,
      registry: provider.registry ?? null,
      apiStyle: provider.apiStyle,
      baseUrlSet: !!provider.baseUrl,
      modelRequested: provider.model,
    },
  })

  // Session-level accumulators — fixed for the whole residency (one budget
  // envelope), persisting across `promptOnce` calls.
  const budget = task.budget
  // wallMs baseline is set ONCE at residency construction, so the wall-clock
  // budget is cumulative across every `promptOnce` turn (consistent with
  // `used` calls/cost, which also accumulate over the residency).
  const startedAt = Date.now()
  const used = { calls: 0, tokens: 0, usdCents: 0, cacheRead: 0, cacheWrite: 0 }
  // Latest turn's context occupancy (a snapshot, refreshed each turn_end).
  // This — not cumulative token spend — decides when the conversation no
  // longer fits the model window. `budget.tokens` is intentionally NOT
  // gated: cumulative spend never affected the LLM, only the live snapshot
  // vs the window does.
  let contextTokens = 0
  // Why a run is ending early. All causes call agent.abort(); we record
  // which one so the terminal handler reports the right outcome. Reset at the
  // start of each `promptOnce` so a later turn starts clean.
  let stopCause: 'cancelled' | 'budget' | 'context' | 'iterations' | null = null
  let budgetDim = ''
  // Per-prompt turn counter for the maxIterations safety valve. The budget/
  // context/cancel guards all live in beforeToolCall, which only fires on tool
  // calls — a model stuck emitting reasoning-only turns never trips them. This
  // counter, checked in prepareNextTurn (fires every turn), is the backstop.
  let turns = 0
  const maxTurns = deps.maxIterationsOverride ?? agentDefinition.maxIterations ?? 25

  const snapshotUsed = (): ConsumedResources => ({
    tokens: used.tokens,
    calls: used.calls,
    wallMs: Date.now() - startedAt,
    usdCents: used.usdCents,
    cacheRead: used.cacheRead,
    cacheWrite: used.cacheWrite,
  })

  // Setup failure (missing key or resolution throw) must still yield a usable
  // session: `promptOnce` returns failed, `agent.state.messages` falls back to
  // the initial messages, and `getUsed()` reports nothing consumed.
  const failedSession = (): AgentSession => ({
    promptOnce: async () => ({ status: 'failed', summary: '' }),
    agent: { state: { messages: initialMessages } } as unknown as Agent,
    getUsed: () => emptyUsed(),
    abort: () => undefined,
    contextWindow: DEFAULT_CONTEXT_WINDOW,
    getContextTokens: () => 0,
  })

  if (!provider.apiKey) {
    emit('task.error', {
      taskId: task.id,
      error: {
        code: 'agent_setup_failed',
        message: 'Provider API key is missing or empty',
        tier: 'fatal',
      },
      ts: Date.now(),
    })
    return failedSession()
  }

  let tools: AgentTool[]
  let riskOf: (name: string, args?: unknown) => ToolRisk
  let model: Model<Api>
  const fallbackModels: Model<Api>[] = []
  try {
    const runCtx = buildToolContext(deps)
    // Fold spend from delegated runtimes (e.g. a Claude Code session driven via
    // cc_* tools) into this task's cost budget, so the usdCents guard and the
    // live usage UI account for it. costUsd is already the incremental amount.
    runCtx.reportExternalUsage = (usage) => {
      if (!usage.costUsd || usage.costUsd <= 0) return
      used.usdCents += Math.round(usage.costUsd * 100)
      taskLog.info({ msg: 'external usage charged', costUsd: usage.costUsd, usdCents: used.usdCents })
      emit('task.usage', { taskId: task.id, used: snapshotUsed(), contextWindow: model.contextWindow, ts: Date.now() })
    }
    const resolved = toolRegistry.resolve(task.toolAllowlist, runCtx)
    tools = resolved.tools
    riskOf = resolved.riskOf
    if (tools.length === 0) {
      taskLog.warn({ msg: 'no tools resolved for task', toolAllowlist: task.toolAllowlist })
    }
    model = resolveModel(provider)
    // The fallback chain rides on the injection (resolved in Main from the
    // provider's fallbackProviderIds); an explicit deps.fallbackProviders wins
    // (tests / programmatic override). Resolve defensively: a single
    // unresolvable fallback must not abort the session — it is dropped.
    for (const fp of deps.fallbackProviders ?? provider.fallbackProviders ?? []) {
      try {
        fallbackModels.push(resolveModel(fp))
      } catch (e) {
        taskLog.warn({
          msg: 'skipping unresolvable fallback provider',
          model: fp.model,
          err: e instanceof Error ? e.message : String(e),
        })
      }
    }
  } catch (err) {
    taskLog.error({
      msg: 'setup threw before agent could start',
      err: err instanceof Error ? { name: err.name, message: err.message, stack: err.stack } : String(err),
    })
    emit('task.error', {
      taskId: task.id,
      error: {
        code: 'agent_setup_failed',
        message: err instanceof Error ? err.message : String(err),
        tier: 'fatal',
      },
      ts: Date.now(),
    })
    return failedSession()
  }

  taskLog.info({
    msg: 'task starting',
    toolCount: tools.length,
    cwd: task.cwd ?? null,
    permissionMode: deps.getPermissionMode?.() ?? task.permissionMode ?? 'ask',
    executionMode: task.executionMode ?? 'goal',
    resolvedModel: {
      id: model.id,
      provider: model.provider,
      api: model.api,
      baseUrl: model.baseUrl,
      contextWindow: model.contextWindow,
    },
  })

  // The ordered model chain: primary first, then any resolvable fallbacks.
  // `promptOnce` advances through it on failure; with no fallbacks this is a
  // single-element list and the loop behaves exactly as the original.
  const modelChain: Model<Api>[] = [model, ...fallbackModels]

  // Runaway guards only (calls/time/cost). Token spend is deliberately
  // absent — context fitness is judged separately, by snapshot vs window.
  const overBudget = (): string | null => {
    if (used.calls > budget.calls) return 'calls'
    if (Date.now() - startedAt > budget.wallMs) return 'wallMs'
    if (used.usdCents > budget.usdCents) return 'usdCents'
    return null
  }

  // The human-readable cause of an early stop, mirroring the task-level
  // error. pi-agent-core stamps the interrupted tool call with a generic
  // "Operation aborted"; we use this to rewrite it to the real reason.
  const stopReason = (): string | null => {
    if (stopCause === 'cancelled') return 'Stopped by user.'
    if (stopCause === 'budget') return `Budget exhausted (${budgetDim}).`
    if (stopCause === 'iterations') return `Stopped after ${maxTurns} turns (max iterations reached).`
    if (stopCause === 'context') return `Context window full (${contextTokens} > ${model.contextWindow} tokens).`
    return null
  }

  const agent = new Agent({
    getApiKey: () => provider.apiKey,
    onPayload: (payload, m) => {
      const p = payload as Record<string, unknown> | undefined
      taskLog.debug({
        msg: 'http request payload',
        url: m.baseUrl,
        model: m.id,
        payloadKeys: p ? Object.keys(p) : [],
        hasMaxTokens: p ? 'max_tokens' in p : false,
        hasMaxCompletionTokens: p ? 'max_completion_tokens' in p : false,
        toolCount:
          p && Array.isArray((p as { tools?: unknown[] }).tools) ? (p as { tools: unknown[] }).tools.length : 0,
      })
      return undefined
    },
    onResponse: (response) => {
      taskLog.info({
        msg: 'http response',
        status: response.status,
        contentType: response.headers['content-type'],
      })
    },
    initialState: {
      systemPrompt: composeSystemPrompt(agentDefinition.systemPrompt, task),
      model,
      tools,
      messages: initialMessages,
      // Stream reasoning for models that support it; the UI shows it in a
      // collapsible "Thinking" block. The user's chosen depth is clamped to
      // what this model supports (defaulting to 'high'); non-reasoning
      // models clamp to 'off'.
      thinkingLevel: clampThinkingLevel(model, provider.thinkingLevel ?? 'high'),
    },
    // Fires after every turn (unlike beforeToolCall, which only fires on tool
    // calls). Caps the per-prompt turn count so a runaway loop — including one
    // that only emits reasoning and never calls a tool — is aborted instead of
    // spinning until the user hits stop.
    prepareNextTurn: () => {
      turns += 1
      if (turns >= maxTurns) {
        stopCause = 'iterations'
        taskLog.warn({ msg: 'max iterations reached, aborting', turns, maxTurns })
        agent.abort()
      }
      return undefined
    },
    beforeToolCall: async ({ toolCall, args }) => {
      if (deps.signal?.aborted) {
        stopCause = 'cancelled'
        return { block: true, reason: 'Cancelled by user.' }
      }

      used.calls += 1
      const dim = overBudget()
      if (dim) {
        stopCause = 'budget'
        budgetDim = dim
        agent.abort()
        return { block: true, reason: `Budget exhausted (${dim}).` }
      }

      // Stop before the next turn would overflow the model's window. The
      // snapshot already exceeding the window means the next prompt (≈ this
      // size) won't fit. Interim hard stop; compaction will replace it with
      // graceful trimming later.
      if (model.contextWindow && contextTokens > model.contextWindow) {
        stopCause = 'context'
        agent.abort()
        return { block: true, reason: `Context window full (${contextTokens} > ${model.contextWindow} tokens).` }
      }

      const risk = riskOf(toolCall.name, args)

      // 'full' permission mode bypasses every prompt; otherwise low-risk
      // calls auto-run and medium/high escalate to the user. The mode is read
      // live (not the task's submit-time snapshot) so toggling the gate mid-run
      // takes effect on the very next tool call.
      if (risk === 'low') return undefined
      const permissionMode = deps.getPermissionMode?.() ?? task.permissionMode ?? 'ask'
      if (permissionMode === 'full') return undefined

      const decision = await permissionRegistry.request(
        {
          taskId: task.id,
          toolName: toolCall.name,
          risk,
          summary: `Run tool: ${toolCall.name}`,
          payload: args,
        },
        deps.signal
      )

      // The request resolves on abort too (fail-safe deny), so re-check the
      // signal first — a cancelled task must report cancellation, not a
      // misleading "user denied".
      if (deps.signal?.aborted) {
        stopCause = 'cancelled'
        taskLog.info({ msg: 'tool call cancelled awaiting approval', toolName: toolCall.name })
        return { block: true, reason: 'Cancelled by user.' }
      }

      if (decision === 'grant') {
        taskLog.info({ msg: 'tool call approved', toolName: toolCall.name, risk })
        return undefined
      }
      taskLog.warn({ msg: 'tool call blocked by user', toolName: toolCall.name, risk, decision })
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

  const translator = createEventTranslator(task.id, emit)
  agent.subscribe((e) => {
    if (e.type === 'turn_end') {
      const usage = (e as { message?: { usage?: Usage } }).message?.usage
      if (usage) {
        // Snapshot, not a running total: each turn re-sends the whole
        // conversation, so totalTokens is already the full current size —
        // summing across turns would double-count.
        used.tokens = usage.totalTokens
        used.usdCents += Math.round(usage.cost.total * 100)
        // Cache-hit/creation tokens for this turn. Snapshots (like tokens),
        // not running totals: they describe the latest turn's context.
        used.cacheRead = usage.cacheRead
        used.cacheWrite = usage.cacheWrite
        // Latest turn's prompt+completion ≈ how full the context window is
        // now. This snapshot is what gates the run (see beforeToolCall).
        contextTokens = usage.input + usage.cacheRead + usage.cacheWrite + usage.output
      }
      emit('task.usage', {
        taskId: task.id,
        used: snapshotUsed(),
        contextTokens: usage ? contextTokens : undefined,
        contextWindow: model.contextWindow,
        ts: Date.now(),
      })
      deps.saveSnapshot?.(agent.state.messages, snapshotUsed(), model.contextWindow)
    }
    // When we abort for budget/context/cancel, pi-agent-core records the
    // interrupted tool call with a generic "Operation aborted". Rewrite it
    // to the real cause so the transcript matches the task-level error.
    if (e.type === 'tool_execution_end' && (e as { isError?: boolean }).isError) {
      const reason = stopReason()
      if (reason) {
        const r = (e as { result?: { content?: Array<{ type: string; text?: string }> } }).result
        const txt = r?.content?.find((c) => c.type === 'text')
        if (txt?.text === 'Operation aborted') txt.text = reason
      }
    }
    const summary: Record<string, unknown> = { type: e.type }
    if ('toolName' in e) summary.toolName = (e as { toolName?: string }).toolName
    if ('isError' in e) summary.isError = (e as { isError?: boolean }).isError
    if ('assistantMessageEvent' in e) {
      const inner = (e as { assistantMessageEvent?: { type?: string } }).assistantMessageEvent
      if (inner?.type) summary.innerType = inner.type
    }
    taskLog.debug({ msg: 'agent event', ...summary })
    translator.handle(e)
  })

  const promptOnce = async (
    goal: string,
    images?: ImageContent[]
  ): Promise<{ status: 'completed' | 'failed' | 'cancelled'; summary: string }> => {
    // A failed attempt appends the user goal + a stopReason 'error' assistant
    // message to the transcript. Snapshot the pre-prompt transcript so a retry
    // can restore it, discarding that failed turn instead of re-prompting on
    // top of duplicated user/error messages.
    const baselineMessages = agent.state.messages.slice()

    // The user-cancel that surfaces during the retry wait. Emits the same
    // cancellation outcome as an in-prompt cancel so a queued retry never
    // overrides a stop request.
    const reportCancelled = (): { status: 'cancelled'; summary: string } => {
      taskLog.info({ msg: 'task cancelled during retry wait' })
      emit('task.error', {
        taskId: task.id,
        error: { code: 'cancelled', message: 'Stopped by user.', tier: 'gave_up' },
        ts: Date.now(),
      })
      return { status: 'cancelled', summary: translator.getFinalSummary() }
    }

    // Surface a retried failure in the transcript without ending the task. A
    // 'transient'-tier error renders as a visible notice (the UI does not mark
    // the task failed — only the terminal task.error does that on give-up).
    const emitRetryNotice = (attempt: number, message: string): void => {
      const event: TaskEvent = {
        kind: 'error',
        error: {
          code: 'agent_request_retry',
          message: `Provider request failed (attempt ${attempt + 1}/${maxRetries + 1}); retrying in ${Math.round(
            retryDelayMs / 1000
          )}s. ${message}`,
          tier: 'transient',
        },
        ts: Date.now(),
      }
      emit('task.progress', { taskId: task.id, event, ts: Date.now() })
    }

    // Announce a switch to the next model in the chain. Rendered like a retry
    // notice (transient tier) so the UI shows it without marking the task failed.
    const emitModelSwitch = (toModelId: string, reason: string): void => {
      const event: TaskEvent = {
        kind: 'error',
        error: {
          code: 'agent_model_fallback',
          message: `Switching to fallback model "${toModelId}" after ${reason}.`,
          tier: 'transient',
        },
        ts: Date.now(),
      }
      emit('task.progress', { taskId: task.id, event, ts: Date.now() })
    }

    // Outer loop: walk the model chain. Inner loop: transient retries on the
    // current model. A model is abandoned when its retries are exhausted or it
    // hits a permanent failure; the run then advances to the next model (if any)
    // with a fresh retry budget. With no fallbacks this is a single iteration and
    // the behavior is identical to the prior single-model retry loop.
    for (let modelIdx = 0; modelIdx < modelChain.length; modelIdx++) {
      const isLastModel = modelIdx === modelChain.length - 1
      if (modelIdx > 0) {
        // Swap the live model so the context-window guard, usage emits, and the
        // next prompt all use the fallback. `model` is read by reference in the
        // agent's closures, so reassigning it here propagates everywhere.
        model = modelChain[modelIdx]
        agent.state.model = model
        taskLog.info({ msg: 'falling back to next model', modelId: model.id, modelIdx })
      }

      for (let attempt = 0; attempt <= maxRetries; attempt++) {
        const isLastAttempt = attempt === maxRetries
        // Each attempt starts clean for cancel/budget/context detection, while
        // `used` and the wall-clock baseline keep accumulating across the
        // residency (one budget envelope per residency).
        stopCause = null
        turns = 0
        translator.resetError()
        // Hold the TERMINAL task.error back until the final attempt of the LAST
        // model: an intermediate failure (a retry pending, or another model still
        // to try) must not flip the task to 'failed'. It is still made visible —
        // as a transient retry/fallback notice below.
        translator.setSuppressError(!(isLastAttempt && isLastModel))
        // Discard the prior failed turn (an earlier attempt on this model, or the
        // previous model's failure) before re-issuing the prompt.
        if (attempt > 0 || modelIdx > 0) agent.state.messages = baselineMessages.slice()

        taskLog.info({ msg: 'agent.prompt starting', sessionId, attempt, maxRetries, modelId: model.id })
        const t0 = Date.now()
        let promptError: unknown = null
        // pi's prompt() resolves with `void`. A failed model/transport request is
        // NOT thrown here either — pi routes a stopReason 'error' assistant message
        // through the event stream, which the translator captures (getError). So a
        // failure is detected via the translator, never the return value.
        try {
          await agent.prompt(goal, images && images.length > 0 ? images : undefined)
          taskLog.info({ msg: 'agent.prompt resolved', durationMs: Date.now() - t0, error: translator.getError() })
        } catch (err) {
          // An abort (cancel/budget) may surface here; stopCause disambiguates it
          // from a genuine failure below.
          promptError = err
        }

        // Deliberate stops are never transient and never fall back — they end
        // the whole run (a budget is shared across models, a cancel is final).
        if (stopCause === 'cancelled') {
          taskLog.info({ msg: 'task cancelled', durationMs: Date.now() - t0 })
          emit('task.error', {
            taskId: task.id,
            error: { code: 'cancelled', message: 'Stopped by user.', tier: 'gave_up' },
            ts: Date.now(),
          })
          return { status: 'cancelled', summary: translator.getFinalSummary() }
        }

        if (stopCause === 'budget') {
          taskLog.warn({ msg: 'task budget exhausted', dim: budgetDim, used, durationMs: Date.now() - t0 })
          emit('task.error', {
            taskId: task.id,
            error: { code: 'budget_exhausted', message: `Budget exhausted (${budgetDim}).`, tier: 'gave_up' },
            ts: Date.now(),
          })
          return { status: 'failed', summary: translator.getFinalSummary() }
        }

        if (stopCause === 'iterations') {
          taskLog.warn({ msg: 'task hit max iterations', turns, maxTurns, durationMs: Date.now() - t0 })
          emit('task.error', {
            taskId: task.id,
            error: {
              code: 'max_iterations',
              message: `Stopped after ${maxTurns} turns (max iterations reached).`,
              tier: 'gave_up',
            },
            ts: Date.now(),
          })
          return { status: 'failed', summary: translator.getFinalSummary() }
        }

        if (stopCause === 'context') {
          taskLog.warn({
            msg: 'context window full',
            contextTokens,
            contextWindow: model.contextWindow,
            durationMs: Date.now() - t0,
          })
          emit('task.error', {
            taskId: task.id,
            error: {
              code: 'context_window_full',
              message: `Context window full (${contextTokens} > ${model.contextWindow} tokens).`,
              tier: 'gave_up',
            },
            ts: Date.now(),
          })
          return { status: 'failed', summary: translator.getFinalSummary() }
        }

        // A failed request: either a thrown transport error (promptError) or pi's
        // stopReason 'error' captured by the translator. Both are handled the same
        // way — retry the current model, then advance to the next, then give up.
        const requestError = translator.getError()
        const failure = promptError
          ? { message: promptError instanceof Error ? promptError.message : String(promptError), thrown: true }
          : requestError
            ? { message: requestError, thrown: false }
            : null

        if (failure) {
          taskLog.error({
            msg: failure.thrown ? 'agent.prompt threw' : 'agent.prompt resolved with error',
            attempt,
            modelId: model.id,
            errorMessage: failure.message,
            durationMs: Date.now() - t0,
          })
          const permanent = isPermanentModelFailure(failure.message)
          // Transient failure with attempts left → retry the SAME model.
          if (!isLastAttempt && !permanent) {
            taskLog.warn({ msg: 'retrying same model', attempt, delayMs: retryDelayMs })
            emitRetryNotice(attempt, failure.message)
            await abortableDelay(retryDelayMs, deps.signal)
            if (deps.signal?.aborted) return reportCancelled()
            continue
          }
          // This model is done (retries exhausted, or a permanent failure).
          // Advance to the next model in the chain if there is one.
          if (!isLastModel) {
            emitModelSwitch(modelChain[modelIdx + 1].id, permanent ? 'a permanent error' : 'exhausting retries')
            break
          }
          // Last model gave up. A thrown error needs an explicit terminal emit; a
          // stopReason-'error' failure was already emitted by the (unsuppressed)
          // translator on agent_end.
          if (failure.thrown) {
            emit('task.error', {
              taskId: task.id,
              error: { code: 'agent_exception', message: failure.message, tier: 'fatal' },
              ts: Date.now(),
            })
            return { status: 'failed', summary: '' }
          }
          return { status: 'failed', summary: translator.getFinalSummary() }
        }

        return { status: 'completed', summary: translator.getFinalSummary() }
      }
    }

    // Unreachable: every terminal branch returns, and the last model's last
    // attempt always returns. Satisfies the non-void return type.
    throw new Error('promptOnce model/retry loops exited without a result')
  }

  return {
    promptOnce,
    agent,
    getUsed: snapshotUsed,
    abort: () => agent.abort(),
    contextWindow: model.contextWindow,
    getContextTokens: () => contextTokens,
  }
}

export const DEFAULT_MAX_VERIFY_ROUNDS = 3

const VERIFIER_SYSTEM_PROMPT =
  'You are an independent verifier. You are given a task goal, its acceptance criteria, and the ' +
  "executor's final summary. Judge ONLY whether the criteria are met by the summary. Be strict and " +
  'skeptical; do not assume work that is not evidenced. Respond with ONLY a JSON object: ' +
  '{"pass": boolean, "gaps": [string]}. "gaps" lists concrete unmet items (empty when pass is true).'

const deriveCriteriaPrompt = (goal: string): string =>
  'Before doing the task, define how it will be judged complete. Call set_acceptance_criteria with a ' +
  'concise list of checkable done-conditions. Attach a `check` (command or file_exists) to any ' +
  'criterion a command can verify deterministically (e.g. tests pass, a file exists); leave the rest ' +
  `for judgment. Do NOT start the task yet.\n\nGoal: ${goal}`

const reworkPrompt = (gaps: string[]): string =>
  'Your work did not yet meet all acceptance criteria. Address these gaps, then stop:\n' +
  gaps.map((g) => `- ${g}`).join('\n')

const buildJudgePrompt = (goal: string, soft: AcceptanceCriterion[], summary: string): string =>
  `Goal:\n${goal}\n\nAcceptance criteria to judge:\n${
    soft.length ? soft.map((c) => `- ${c.description}`).join('\n') : '(none — judge overall goal completion)'
  }\n\nExecutor summary:\n${summary}`

const addUsed = (a: ConsumedResources, b: ConsumedResources): ConsumedResources => ({
  tokens: a.tokens + b.tokens,
  calls: a.calls + b.calls,
  wallMs: a.wallMs + b.wallMs,
  usdCents: a.usdCents + b.usdCents,
  cacheRead: a.cacheRead + b.cacheRead,
  cacheWrite: a.cacheWrite + b.cacheWrite,
})

// Order-insensitive equality of two gap lists, so a re-ordered but identical set
// still counts as "no progress". Used by the stall guard in runGoalVerifyLoop.
const sameGaps = (a: string[], b: string[]): boolean => {
  if (a.length !== b.length) return false
  const seen = new Set(a)
  return b.every((g) => seen.has(g))
}

// Default verification: deterministic hard checks plus an independent LLM judge
// sub-run on the same provider. The sub-run sets maxVerifyRounds: 0 so it never
// recurses into another verify loop.
function defaultVerifyCompletion(deps: AgentRunnerDeps): NonNullable<AgentRunnerDeps['verifyCompletion']> {
  return async ({ criteria, summary, cwd }) => {
    let judgeUsed: ConsumedResources | undefined
    const judge: Judge = async (soft, sum) => {
      const verifierTask: Task = {
        ...deps.task,
        id: `${deps.task.id}:verify`,
        goal: buildJudgePrompt(deps.task.goal, soft, sum),
        attachments: [],
        toolAllowlist: [],
        acceptanceCriteria: undefined,
        verifications: undefined,
        executionMode: 'goal',
      }
      const runner = createAgentRunner({
        task: verifierTask,
        provider: deps.provider,
        agentDefinition: {
          id: 'verifier',
          name: 'Verifier',
          description: 'Independent completion verifier.',
          systemPrompt: VERIFIER_SYSTEM_PROMPT,
          toolScope: 'all',
          maxIterations: 2,
        },
        sessionId: deps.sessionId,
        emit: () => undefined,
        permissionRegistry: deps.permissionRegistry,
        toolRegistry: deps.toolRegistry,
        initialMessages: [],
        spawnChild: deps.spawnChild,
        signal: deps.signal,
        fallbackProviders: deps.fallbackProviders,
        maxVerifyRounds: 0, // never recurse
      })
      const r = await runner.run()
      judgeUsed = r.used
      const parsed = parseVerdict(r.summary)
      if (!parsed) {
        log.warn({ msg: 'verifier output unparseable; treating as fail', taskId: deps.task.id })
        return { pass: false, gaps: ['verifier produced no parseable verdict'] }
      }
      return parsed
    }
    // Model-authored command checks bypass the shell permission gate, so only
    // run them as hard checks when the session is in 'full' permission mode;
    // otherwise verifyTask demotes them to the LLM judge.
    const allowCommands = (deps.getPermissionMode?.() ?? deps.task.permissionMode ?? 'ask') === 'full'
    const verdict = await verifyTask({ criteria, summary, cwd, judge, allowCommands })
    return { ...verdict, judgeUsed }
  }
}

// The execute→verify→rework loop for a 'goal' task. Exported for unit testing
// with a fake session and an injected verify; createAgentRunner.run wires the
// real session + verify.
export async function runGoalVerifyLoop(args: {
  session: AgentSession
  goal: string
  images?: ImageContent[]
  criteriaRef: { current: AcceptanceCriterion[] }
  verify: NonNullable<AgentRunnerDeps['verifyCompletion']>
  maxRounds: number
  cwd?: string
  emit: EmitFn
  taskId: string
}): Promise<{
  status: 'completed' | 'failed' | 'cancelled'
  summary: string
  messages: AgentMessage[]
  used: ConsumedResources
}> {
  const { session, goal, images, criteriaRef, verify, maxRounds, cwd, emit, taskId } = args
  const taskLog = log.child({ taskId })
  let extraUsed: ConsumedResources = emptyUsed()
  let lastGaps: string[] = []

  for (let round = 0; round <= maxRounds; round++) {
    const r =
      round === 0
        ? await session.promptOnce(goal, images && images.length > 0 ? images : undefined)
        : await session.promptOnce(reworkPrompt(lastGaps))
    if (r.status !== 'completed') {
      return {
        status: r.status,
        summary: r.summary,
        messages: session.agent.state.messages,
        used: addUsed(session.getUsed(), extraUsed),
      }
    }
    taskLog.info({ msg: 'verify round start', round, criteria: criteriaRef.current.length })
    const verdict = await verify({ criteria: criteriaRef.current, summary: r.summary, cwd })
    if (verdict.judgeUsed) extraUsed = addUsed(extraUsed, verdict.judgeUsed)
    const vr: VerificationRound = {
      round,
      verdict: verdict.verdict,
      results: verdict.results,
      gaps: verdict.gaps,
      ts: Date.now(),
    }
    emit('task.verification', { taskId, round: vr, ts: Date.now() })
    taskLog.info({ msg: 'verify verdict', round, verdict: verdict.verdict, gaps: verdict.gaps.length })

    if (verdict.verdict === 'pass') {
      return {
        status: 'completed',
        summary: r.summary,
        messages: session.agent.state.messages,
        used: addUsed(session.getUsed(), extraUsed),
      }
    }
    const stalled = round > 0 && sameGaps(verdict.gaps, lastGaps)
    lastGaps = verdict.gaps
    if (round === maxRounds) {
      taskLog.warn({ msg: 'verification exhausted rounds; marking failed', rounds: maxRounds })
      const summary = `${r.summary}\n\nUnmet acceptance criteria after ${maxRounds + 1} verify round(s):\n${verdict.gaps
        .map((g) => `- ${g}`)
        .join('\n')}`
      return {
        status: 'failed',
        summary,
        messages: session.agent.state.messages,
        used: addUsed(session.getUsed(), extraUsed),
      }
    }
    if (stalled) {
      taskLog.warn({ msg: 'verify gaps not progressing since last round; marking failed', round })
      const summary = `${r.summary}\n\nStopped: acceptance criteria not progressing (same gaps repeated):\n${verdict.gaps
        .map((g) => `- ${g}`)
        .join('\n')}`
      return {
        status: 'failed',
        summary,
        messages: session.agent.state.messages,
        used: addUsed(session.getUsed(), extraUsed),
      }
    }
  }
  // Unreachable — the loop always returns within the bounded rounds.
  return {
    status: 'failed',
    summary: '',
    messages: session.agent.state.messages,
    used: addUsed(session.getUsed(), extraUsed),
  }
}

export function createAgentRunner(deps: AgentRunnerDeps): AgentRunner {
  return {
    async run() {
      const images: ImageContent[] = deps.task.attachments.map((a) => ({
        type: 'image',
        data: a.data,
        mimeType: a.mimeType,
      }))
      const maxRounds = deps.maxVerifyRounds ?? DEFAULT_MAX_VERIFY_ROUNDS
      const taskLog = log.child({ taskId: deps.task.id })

      // Legacy single-shot: plan mode, or verification disabled (e.g. the
      // verifier sub-run). No criteria derivation, no verify gate.
      if (deps.task.executionMode === 'plan' || maxRounds === 0) {
        const session = buildAgentSession(deps)
        const r = await session.promptOnce(deps.task.goal, images.length > 0 ? images : undefined)
        return { status: r.status, summary: r.summary, messages: session.agent.state.messages, used: session.getUsed() }
      }

      // Goal mode: define → execute → verify → rework.
      const criteriaRef: { current: AcceptanceCriterion[] } = { current: deps.task.acceptanceCriteria ?? [] }
      const wrappedDeps: AgentRunnerDeps = {
        ...deps,
        onAcceptanceCriteria: (c) => {
          criteriaRef.current = c
          deps.emit('task.criteria', { taskId: deps.task.id, criteria: c, ts: Date.now() })
          deps.onAcceptanceCriteria?.(c)
        },
        onDelegationPlan: (plan) => {
          deps.emit('task.delegation_plan', { taskId: deps.task.id, plan, ts: Date.now() })
          deps.onDelegationPlan?.(plan)
        },
      }
      const session = buildAgentSession(wrappedDeps)
      const verify = deps.verifyCompletion ?? defaultVerifyCompletion(deps)

      // Phase A — derive criteria unless the caller supplied them.
      if (criteriaRef.current.length === 0) {
        taskLog.info({ msg: 'deriving acceptance criteria' })
        await session.promptOnce(deriveCriteriaPrompt(deps.task.goal))
        if (criteriaRef.current.length === 0) {
          taskLog.warn({ msg: 'agent derived no criteria; using goal as a single soft criterion' })
          criteriaRef.current = [{ id: 'c1', description: deps.task.goal }]
        }
      }

      // Phase B + C.
      return runGoalVerifyLoop({
        session,
        goal: deps.task.goal,
        images,
        criteriaRef,
        verify,
        maxRounds,
        cwd: deps.task.cwd,
        emit: deps.emit,
        taskId: deps.task.id,
      })
    },
  }
}

export type ResidentHooks = {
  acquireTurnSlot(): Promise<void>
  releaseTurnSlot(): void
  // Atomic: mark the message consumed AND persist the actor's conversation
  // state (cross-dormancy memory). The loop serializes agent.state.messages
  // after an optional compaction and hands the blob here.
  onConsumed(msgId: string, state: string): void
  onReply(correlationId: string, summary: string): void
  /** A single turn failed: record retry/deadletter. The loop continues. */
  onError(msgId: string): void
}

/**
 * A resident virtual actor: build the agent session once (so its conversation
 * accumulates across messages), then drain the mailbox one message per turn.
 * Returns when the mailbox idles out (sleep) or `deps.signal` aborts.
 *
 * Payload convention: the message `payload` is the raw goal text — passed
 * straight to `promptOnce` (Task 6 enqueues the goal string as-is).
 */
export async function runResident(
  deps: AgentRunnerDeps,
  mailbox: Mailbox,
  hooks: ResidentHooks,
  idleMs: number
): Promise<void> {
  const residentLog = log.child({ component: 'actor-runtime' })
  const session = buildAgentSession(deps)
  residentLog.info({ msg: 'resident-start', address: deps.selfAddress, taskId: deps.task.id })
  for (;;) {
    if (deps.signal?.aborted) {
      residentLog.info({ msg: 'resident aborted', address: deps.selfAddress })
      return
    }
    let msg: ActorMessage
    try {
      msg = await mailbox.receive({ idleMs })
    } catch (err) {
      if (err instanceof IdleTimeoutError) {
        residentLog.info({ msg: 'idle-sleep', address: deps.selfAddress })
        return
      }
      throw err
    }
    await hooks.acquireTurnSlot()
    try {
      residentLog.info({ msg: 'turn-start', address: deps.selfAddress, msgId: msg.id, kind: msg.kind })
      const { summary } = await session.promptOnce(msg.payload)
      // TODO: resident-actor context compaction is not wired. pi exposes
      // compaction as a standalone compact(preparation, models, model) — there is
      // no Agent.compact() method — which requires exposing model resolution on
      // AgentSession (see buildAgentSession). Until then, surface the
      // unbounded-growth risk with a warn when the threshold is crossed.
      if (shouldCompact(session.getContextTokens(), session.contextWindow, DEFAULT_COMPACTION_SETTINGS)) {
        residentLog.warn({
          msg: 'compact-skipped-not-wired',
          address: deps.selfAddress,
          contextTokens: session.getContextTokens(),
          contextWindow: session.contextWindow,
          component: 'actor-state',
        })
      }
      const state = encodeActorState(session.agent.state.messages)
      residentLog.info({ msg: 'persist', address: deps.selfAddress, msgId: msg.id, component: 'actor-state' })
      hooks.onConsumed(msg.id, state)
      if (msg.kind === 'rpc' && msg.correlationId) hooks.onReply(msg.correlationId, summary)
      residentLog.info({ msg: 'turn-end', address: deps.selfAddress, msgId: msg.id })
    } catch (err) {
      residentLog.error({
        msg: 'resident turn failed',
        address: deps.selfAddress,
        msgId: msg.id,
        err: err instanceof Error ? err.message : String(err),
      })
      // A single bad message must not kill the resident loop. Record the
      // failure (retry/deadletter decided by the session-manager) and continue
      // draining. The message is NOT marked consumed, so it stays pending for a
      // future re-drain unless the session-manager dead-letters it.
      hooks.onError(msg.id)
    } finally {
      hooks.releaseTurnSlot()
    }
  }
}
