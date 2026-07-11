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
  executionMode?: 'direct' | 'plan'
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
      runLog.warn({
        msg: 'skipping unresolvable fallback provider',
        model: fp.model,
        err: e instanceof Error ? e.message : String(e),
      })
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
    // HTTP-level tracing (carry-over from v1's agent-runner). Payload at debug
    // (per-request noise), the response line at info so a failing provider call
    // is locatable from the log alone.
    onPayload: (payload, m) => {
      const p = payload as Record<string, unknown> | undefined
      runLog.debug({
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
      runLog.info({
        msg: 'http response',
        status: response.status,
        contentType: response.headers['content-type'],
      })
    },
    initialState: {
      systemPrompt: composeSystemPrompt(deps.agentDefinition.systemPrompt, {
        cwd: deps.cwd,
        executionMode: deps.executionMode,
      }),
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
          return terminal('failed', {
            code: 'budget_exhausted',
            message: `Budget exhausted (${budgetDim}).`,
            tier: 'gave_up',
          })
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
