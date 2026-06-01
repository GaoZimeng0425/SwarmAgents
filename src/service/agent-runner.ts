import type { AgentEvent, AgentMessage, AgentTool } from '@earendil-works/pi-agent-core'
import { Agent } from '@earendil-works/pi-agent-core'
import type { Api, KnownProvider, Model } from '@earendil-works/pi-ai'
import { getModel, getModels } from '@earendil-works/pi-ai'
import { createLogger } from '@shared/logger'
import type { AgentDefinition } from '@shared/types/agent'
import type { ProviderInjection } from '@shared/types/provider'
import { ANTHROPIC_MODEL_SUGGESTIONS, type ApiStyle, OPENAI_MODEL_SUGGESTIONS } from '@shared/types/provider'
import type { Task, TaskEvent, TaskResult } from '@shared/types/task'

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
  spawnChild(
    parentTaskId: string,
    newGoal: string,
    suggestedTools?: string[],
    providerKey?: string
  ): Promise<{ childTaskId: string; result: TaskResult }>
}

export type AgentRunner = {
  run(): Promise<{ status: 'completed' | 'failed'; summary: string; messages: AgentMessage[] }>
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
        const result = e.result as { content?: Array<{ type: string; text?: string }> } | undefined
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
        return { status: 'failed', summary: '', messages: initialMessages }
      }

      let tools: AgentTool[]
      let riskOf: (name: string) => ToolRisk
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
        return { status: 'failed', summary: '', messages: initialMessages }
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
          const risk = riskOf(toolCall.name)

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

      const translator = createEventTranslator(task.id, emit)
      agent.subscribe((e) => {
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
      try {
        await agent.prompt(task.goal)
        taskLog.info({ msg: 'agent.prompt resolved', durationMs: Date.now() - t0 })
        return { status: 'completed', summary: translator.getFinalSummary(), messages: agent.state.messages }
      } catch (err) {
        taskLog.error({
          msg: 'agent.prompt threw',
          durationMs: Date.now() - t0,
          err: err instanceof Error ? { name: err.name, message: err.message, stack: err.stack } : String(err),
        })
        emit('task.error', {
          taskId: task.id,
          error: {
            code: 'agent_exception',
            message: err instanceof Error ? err.message : String(err),
            tier: 'fatal',
          },
          ts: Date.now(),
        })
        return { status: 'failed', summary: '', messages: agent.state.messages }
      }
    },
  }
}
