import type { AgentEvent, AgentMessage, AgentTool } from '@earendil-works/pi-agent-core'
import { Agent } from '@earendil-works/pi-agent-core'
import type { Api, ImageContent, KnownProvider, Model, Usage } from '@earendil-works/pi-ai'
import { getModel, getModels } from '@earendil-works/pi-ai'
import { createLogger } from '@shared/logger'
import type { AgentDefinition } from '@shared/types/agent'
import type { ProviderInjection } from '@shared/types/provider'
import { ANTHROPIC_MODEL_SUGGESTIONS, type ApiStyle, OPENAI_MODEL_SUGGESTIONS } from '@shared/types/provider'
import { emptyBudget, type ResourceBudget, type Task, type TaskEvent, type TaskResult } from '@shared/types/task'

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

function cloneTemplate(template: Model<Api>, p: ProviderInjection, style: ApiStyle): Model<Api> {
  const { compat: _drop, ...rest } = template
  return {
    ...rest,
    id: p.model,
    baseUrl: p.baseUrl ?? template.baseUrl,
    api: API_FOR_STYLE[style],
  }
}

function resolveModel(p: ProviderInjection): Model<Api> {
  if (p.id === 'custom') {
    const style: ApiStyle = p.apiStyle ?? 'openai'
    const template =
      getModelLoose(style, p.model) ??
      getModelLoose(style, FALLBACK_MODEL_ID[style]) ??
      (getModels(style)[0] as Model<Api> | undefined)
    if (!template) throw new Error(`pi-ai has no registered models for style "${style}"`)
    return cloneTemplate(template, p, style)
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
  toolRegistry: ToolRegistry
  initialMessages: AgentMessage[]
  /** Aborts the run when fired. The manager wires this to cancelTask. */
  signal?: AbortSignal
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

  const handle = (e: AgentEvent): void => {
    switch (e.type) {
      case 'message_update': {
        const inner = e.assistantMessageEvent
        if (inner && inner.type === 'text_delta' && typeof inner.delta === 'string') {
          textBuffer += inner.delta
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
        emit('task.progress', { taskId, event, ts: Date.now() })
        return
      }
      case 'tool_execution_end': {
        flushText()
        const ok = !e.isError
        const result = e.result as
          | { content?: Array<{ type: string; text?: string }>; details?: { todos?: unknown } }
          | undefined
        // The update_plan tool returns its checklist as structured `details.todos`.
        // Surface it as a dedicated task.plan event so the UI can render a panel
        // instead of a raw text blob.
        if (e.toolName === 'update_plan' && Array.isArray(result?.details?.todos)) {
          emit('task.plan', { taskId, todos: result.details.todos, ts: Date.now() })
        }
        const payloadText = result?.content?.map((c) => (c.type === 'text' ? (c.text ?? '') : '')).join('') ?? ''
        const event: TaskEvent = {
          kind: 'tool.result',
          ok,
          payload: { kind: 'text', text: payloadText.slice(0, 4000) },
          ts: Date.now(),
        }
        emit('task.progress', { taskId, event, ts: Date.now() })
        return
      }
      case 'agent_end': {
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
          taskId: task.id,
          spawnChild: (goal, suggestedTools, providerKey) => spawnChild(task.id, goal, suggestedTools, providerKey),
          send: () => undefined,
          // Tools must NOT self-gate: permission is enforced centrally in beforeToolCall.
          // This stub satisfies the ToolRunContext type without creating a second gate.
          requestPermission: () => Promise.resolve('grant' as const),
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
        },
      })

      const budget = task.budget
      const startedAt = Date.now()
      const used = { calls: 0, tokens: 0, usdCents: 0 }
      // Why a run is ending early. Both causes call agent.abort(); we record
      // which one so the terminal handler reports the right outcome.
      let stopCause: 'cancelled' | 'budget' | null = null
      let budgetDim = ''

      const overBudget = (): string | null => {
        if (used.calls > budget.calls) return 'calls'
        if (Date.now() - startedAt > budget.wallMs) return 'wallMs'
        if (used.tokens > budget.tokens) return 'tokens'
        if (used.usdCents > budget.usdCents) return 'usdCents'
        return null
      }

      const snapshotUsed = (): ResourceBudget => ({
        tokens: used.tokens,
        calls: used.calls,
        wallMs: Date.now() - startedAt,
        usdCents: used.usdCents,
      })

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
            used.tokens += usage.totalTokens
            used.usdCents += Math.round(usage.cost.total * 100)
          }
          emit('task.usage', { taskId: task.id, used: snapshotUsed(), ts: Date.now() })
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
