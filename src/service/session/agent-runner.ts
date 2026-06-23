import type { AgentEvent, AgentMessage, AgentTool } from '@earendil-works/pi-agent-core'
import { Agent, DEFAULT_COMPACTION_SETTINGS, shouldCompact } from '@earendil-works/pi-agent-core'
import type { Api, ImageContent, KnownProvider, Model, Usage } from '@earendil-works/pi-ai'
import { clampThinkingLevel, getModel, getModels } from '@earendil-works/pi-ai'
import { createLogger } from '@shared/logger'
import type { ActorMessage } from '@shared/types/actor'
import type { AgentDefinition } from '@shared/types/agent'
import type { Peer, PeerQuery } from '@shared/types/agent'
import type { ProviderInjection } from '@shared/types/provider'
import {
  ANTHROPIC_MODEL_SUGGESTIONS,
  type ApiStyle,
  DEFAULT_CONTEXT_WINDOW,
  OPENAI_MODEL_SUGGESTIONS,
} from '@shared/types/provider'
import { type ConsumedResources, emptyUsed, type Task, type TaskEvent, type TaskResult } from '@shared/types/task'

import { IdleTimeoutError, type Mailbox } from '../actor/mailbox'
import { encodeActorState } from '../actor/state'
import type { ToolRegistry, ToolRisk, ToolRunContext } from '../tools/registry'
import type { PermissionRegistry } from './permission-registry'

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

function cloneTemplate(
  template: Model<Api>,
  p: ProviderInjection,
  style: ApiStyle,
  contextWindow?: number
): Model<Api> {
  const { compat: _drop, ...rest } = template
  return {
    ...rest,
    id: p.model,
    baseUrl: p.baseUrl ?? template.baseUrl,
    api: API_FOR_STYLE[style],
    ...(contextWindow != null ? { contextWindow } : {}),
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
  task: Task
  provider: ProviderInjection
  agentDefinition: AgentDefinition
  sessionId: string
  emit: EmitFn
  permissionRegistry: PermissionRegistry
  toolRegistry: ToolRegistry
  initialMessages: AgentMessage[]
  /** Aborts the run when fired. The manager wires this to cancelTask. */
  signal?: AbortSignal
  /** Persist the conversation + usage at each turn boundary so they survive an interrupt. */
  saveSnapshot?(messages: AgentMessage[], used: ConsumedResources, contextWindow?: number): void
  spawnChild(
    parentTaskId: string,
    newGoal: string,
    suggestedTools?: string[],
    providerKey?: string,
    agentType?: string
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
    spawnChild: (goal, suggestedTools, providerKey, agentType) =>
      deps.spawnChild(deps.task.id, goal, suggestedTools, providerKey, agentType),
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
} {
  let textBuffer = ''
  let thinkingBuffer = ''
  let assembledSummary = ''
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
          // A failed run must surface the provider error, not a fake completion.
          emit('task.error', {
            taskId,
            error: { code: 'agent_request_failed', message: errorMessage, tier: 'fatal' },
            ts: Date.now(),
          })
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

  return { handle, getFinalSummary, getError, resetError }
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
  const { task, provider, agentDefinition, sessionId, emit, permissionRegistry, initialMessages, toolRegistry } = deps
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
  let stopCause: 'cancelled' | 'budget' | 'context' | null = null
  let budgetDim = ''

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
  try {
    const runCtx = buildToolContext(deps)
    const resolved = toolRegistry.resolve(task.toolAllowlist, runCtx)
    tools = resolved.tools
    riskOf = resolved.riskOf
    if (tools.length === 0) {
      taskLog.warn({ msg: 'no tools resolved for task', toolAllowlist: task.toolAllowlist })
    }
    model = resolveModel(provider)
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
    permissionMode: task.permissionMode ?? 'ask',
    executionMode: task.executionMode ?? 'goal',
    resolvedModel: {
      id: model.id,
      provider: model.provider,
      api: model.api,
      baseUrl: model.baseUrl,
      contextWindow: model.contextWindow,
    },
  })

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
      // calls auto-run and medium/high escalate to the user.
      if (risk === 'low' || task.permissionMode === 'full') return undefined

      const decision = await permissionRegistry.request({
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
    // Each turn starts clean for cancel/budget/context detection, while
    // `used` and the wall-clock baseline keep accumulating across the
    // residency (one budget envelope per residency).
    stopCause = null
    translator.resetError()

    taskLog.info({ msg: 'agent.prompt starting', sessionId })
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

    if (promptError) {
      taskLog.error({
        msg: 'agent.prompt threw',
        durationMs: Date.now() - t0,
        err:
          promptError instanceof Error
            ? { name: promptError.name, message: promptError.message, stack: promptError.stack }
            : String(promptError),
      })
      emit('task.error', {
        taskId: task.id,
        error: {
          code: 'agent_exception',
          message: promptError instanceof Error ? promptError.message : String(promptError),
          tier: 'fatal',
        },
        ts: Date.now(),
      })
      return { status: 'failed', summary: '' }
    }

    // pi reports a failed model/transport request by routing a stopReason
    // 'error' assistant message through the event stream (not by throwing or by
    // a return value). The translator captured it and already emitted task.error
    // on agent_end; here we just log it and report 'failed' so the empty turn is
    // never misread as a successful completion. Without this the user sees no
    // reply and the error never reaches the log.
    const requestError = translator.getError()
    if (requestError) {
      taskLog.error({
        msg: 'agent.prompt resolved with error',
        errorMessage: requestError,
        durationMs: Date.now() - t0,
      })
      return { status: 'failed', summary: translator.getFinalSummary() }
    }

    return { status: 'completed', summary: translator.getFinalSummary() }
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

export function createAgentRunner(deps: AgentRunnerDeps): AgentRunner {
  return {
    async run() {
      const session = buildAgentSession(deps)
      const images: ImageContent[] = deps.task.attachments.map((a) => ({
        type: 'image',
        data: a.data,
        mimeType: a.mimeType,
      }))
      const r = await session.promptOnce(deps.task.goal, images.length > 0 ? images : undefined)
      return {
        status: r.status,
        summary: r.summary,
        messages: session.agent.state.messages,
        used: session.getUsed(),
      }
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
      // Compaction (off-the-shelf pi): keep persisted state bounded across
      // many activations. Failure is non-fatal — persist uncompacted; keeping
      // memory beats losing it.
      try {
        if (shouldCompact(session.getContextTokens(), session.contextWindow, DEFAULT_COMPACTION_SETTINGS)) {
          const { tokensBefore } = await session.agent.compact()
          residentLog.info({ msg: 'compact', address: deps.selfAddress, tokensBefore, component: 'actor-state' })
        }
      } catch (err) {
        residentLog.error({
          msg: 'compact-failed',
          address: deps.selfAddress,
          err: err instanceof Error ? err.message : String(err),
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
