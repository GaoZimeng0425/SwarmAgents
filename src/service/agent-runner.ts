import type { AgentEvent, AgentMessage, AgentTool } from '@earendil-works/pi-agent-core'
import { Agent } from '@earendil-works/pi-agent-core'
import type { Api, ImageContent, KnownProvider, Model, Usage } from '@earendil-works/pi-ai'
import { clampThinkingLevel, getModel, getModels } from '@earendil-works/pi-ai'
import { createLogger } from '@shared/logger'
import type { AgentDefinition } from '@shared/types/agent'
import type { ProviderInjection } from '@shared/types/provider'
import {
  ANTHROPIC_MODEL_SUGGESTIONS,
  type ApiStyle,
  DEFAULT_CONTEXT_WINDOW,
  OPENAI_MODEL_SUGGESTIONS,
} from '@shared/types/provider'
import { emptyBudget, type ResourceBudget, type Task, type TaskEvent, type TaskResult } from '@shared/types/task'

import type { AskRegistry } from './ask-registry'
import type { McpRequestRegistry } from './mcp-request-registry'
import type { PermissionRegistry } from './permission-registry'
import type { ToolRegistry, ToolRisk, ToolRunContext } from './tools/registry'

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
  if (p.id === 'custom') {
    const style: ApiStyle = p.apiStyle ?? 'openai'
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

  const exact = getModelLoose(p.id, p.model)
  if (exact && !p.baseUrl) return exact

  const template =
    exact ?? getModelLoose(p.id, FALLBACK_MODEL_ID[p.id]) ?? (getModels(p.id)[0] as Model<Api> | undefined)
  if (!template) throw new Error(`pi-ai has no registered models for provider "${p.id}"`)

  return cloneTemplate(template, p, p.id)
}

type EmitFn = (event: string, data: unknown) => void

export type AgentRunnerDeps = {
  task: Task
  provider: ProviderInjection
  agentDefinition: AgentDefinition
  sessionId: string
  emit: EmitFn
  permissionRegistry: PermissionRegistry
  askRegistry: AskRegistry
  mcpRequests: McpRequestRegistry
  toolRegistry: ToolRegistry
  initialMessages: AgentMessage[]
  /** Aborts the run when fired. The manager wires this to cancelTask. */
  signal?: AbortSignal
  /** Persist the conversation + usage at each turn boundary so they survive an interrupt. */
  saveSnapshot?(messages: AgentMessage[], used: ResourceBudget): void
  spawnChild(
    parentTaskId: string,
    newGoal: string,
    suggestedTools?: string[],
    providerKey?: string
  ): Promise<{ childTaskId: string; result: TaskResult }>
}

export type AgentRunner = {
  run(): Promise<{
    status: 'completed' | 'failed' | 'cancelled'
    summary: string
    messages: AgentMessage[]
    used: ResourceBudget
  }>
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
} {
  let textBuffer = ''
  let thinkingBuffer = ''
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
    emit('task.progress', { taskId, event, ts: Date.now() })
    textBuffer = ''
  }

  const flushThinking = (): void => {
    if (!thinkingBuffer) return
    const event: TaskEvent = { kind: 'reasoning', content: thinkingBuffer, ts: Date.now() }
    emit('task.progress', { taskId, event, ts: Date.now() })
    thinkingBuffer = ''
  }

  const handle = (e: AgentEvent): void => {
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
        }
        emit('task.progress', { taskId, event, ts: Date.now() })
        return
      }
      case 'agent_end': {
        flushThinking()
        flushText()
        const summary = assembledSummary.trim() || `Completed task ${taskId}.`
        emit('task.complete', { taskId, result: { summary, artifacts: [] }, ts: Date.now() })
        return
      }
      default:
        return
    }
  }

  const getFinalSummary = (): string => assembledSummary

  return { handle, getFinalSummary }
}

export function createAgentRunner(deps: AgentRunnerDeps): AgentRunner {
  return {
    async run(): Promise<{ status: 'completed' | 'failed'; summary: string; messages: AgentMessage[] }> {
      const {
        task,
        provider,
        agentDefinition,
        sessionId,
        emit,
        permissionRegistry,
        spawnChild,
        initialMessages,
        toolRegistry,
      } = deps
      const taskLog = log.child({ taskId: task.id })
      taskLog.info({
        msg: 'createAgentRunner.run entered',
        goalLen: task.goal.length,
        injection: {
          id: provider.id,
          apiStyle: provider.apiStyle ?? null,
          baseUrlSet: !!provider.baseUrl,
          modelRequested: provider.model,
        },
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
        return { status: 'failed', summary: '', messages: initialMessages, used: emptyBudget() }
      }

      let tools: AgentTool[]
      let riskOf: (name: string, args?: unknown) => ToolRisk
      let model: Model<Api>
      try {
        const runCtx: ToolRunContext = {
          sessionId,
          taskId: task.id,
          spawnChild: (goal, suggestedTools, providerKey) => spawnChild(task.id, goal, suggestedTools, providerKey),
          send: () => undefined,
          // Tools must NOT self-gate: permission is enforced centrally in beforeToolCall.
          // This stub satisfies the ToolRunContext type without creating a second gate.
          requestPermission: () => Promise.resolve('grant' as const),
          askUser: (args) => deps.askRegistry.request({ taskId: task.id, ...args }),
          addMcpServer: (config) => deps.mcpRequests.add(config),
        }
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
        return { status: 'failed', summary: '', messages: initialMessages, used: emptyBudget() }
      }

      taskLog.info({
        msg: 'task starting',
        toolCount: tools.length,
        resolvedModel: {
          id: model.id,
          provider: model.provider,
          api: model.api,
          baseUrl: model.baseUrl,
          contextWindow: model.contextWindow,
        },
      })

      const budget = task.budget
      const startedAt = Date.now()
      const used = { calls: 0, tokens: 0, usdCents: 0 }
      // Latest turn's context occupancy (a snapshot, refreshed each turn_end).
      // This — not cumulative token spend — decides when the conversation no
      // longer fits the model window. `budget.tokens` is intentionally NOT
      // gated: cumulative spend never affected the LLM, only the live snapshot
      // vs the window does.
      let contextTokens = 0
      // Why a run is ending early. All causes call agent.abort(); we record
      // which one so the terminal handler reports the right outcome.
      let stopCause: 'cancelled' | 'budget' | 'context' | null = null
      let budgetDim = ''

      // Runaway guards only (calls/time/cost). Token spend is deliberately
      // absent — context fitness is judged separately, by snapshot vs window.
      const overBudget = (): string | null => {
        if (used.calls > budget.calls) return 'calls'
        if (Date.now() - startedAt > budget.wallMs) return 'wallMs'
        if (used.usdCents > budget.usdCents) return 'usdCents'
        return null
      }

      const snapshotUsed = (): ResourceBudget => ({
        tokens: used.tokens,
        calls: used.calls,
        wallMs: Date.now() - startedAt,
        usdCents: used.usdCents,
      })

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
          systemPrompt: agentDefinition.systemPrompt,
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

          if (risk === 'low') return undefined

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
          deps.saveSnapshot?.(agent.state.messages, snapshotUsed())
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

      taskLog.info({ msg: 'agent.prompt starting', sessionId })
      const t0 = Date.now()
      let promptError: unknown = null
      try {
        const images: ImageContent[] = task.attachments.map((a) => ({
          type: 'image',
          data: a.data,
          mimeType: a.mimeType,
        }))
        await agent.prompt(task.goal, images.length > 0 ? images : undefined)
        taskLog.info({ msg: 'agent.prompt resolved', durationMs: Date.now() - t0 })
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
        return {
          status: 'cancelled',
          summary: translator.getFinalSummary(),
          messages: agent.state.messages,
          used: snapshotUsed(),
        }
      }

      if (stopCause === 'budget') {
        taskLog.warn({ msg: 'task budget exhausted', dim: budgetDim, used, durationMs: Date.now() - t0 })
        emit('task.error', {
          taskId: task.id,
          error: { code: 'budget_exhausted', message: `Budget exhausted (${budgetDim}).`, tier: 'gave_up' },
          ts: Date.now(),
        })
        return {
          status: 'failed',
          summary: translator.getFinalSummary(),
          messages: agent.state.messages,
          used: snapshotUsed(),
        }
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
        return {
          status: 'failed',
          summary: translator.getFinalSummary(),
          messages: agent.state.messages,
          used: snapshotUsed(),
        }
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
        return { status: 'failed', summary: '', messages: agent.state.messages, used: snapshotUsed() }
      }

      return {
        status: 'completed',
        summary: translator.getFinalSummary(),
        messages: agent.state.messages,
        used: snapshotUsed(),
      }
    },
  }
}
