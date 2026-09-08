// The ONE factory behind all four card-based analysis flows (article / trending
// / bilibili / gmail-thread). Owns the shared skeleton: agent/provider lookup,
// a one-shot pi Agent run (session-agent/one-shot.ts — no persistence), an
// adapter translating that run's pi AgentEvents into domain *.analysis* events,
// and the fire-and-forget dispatch. Per-flow differences live in the
// AnalysisConfig: validateCard, buildCompletePayload, accumulateSummary, and
// noCardBehavior.
//
// Returns a sync ack ({ ok: true } | { ok: false, code, message }); the actual
// result streams back via broadcast events. The optional onComplete dep fires on
// a completed run with the valid card so the flow can persist it (service store,
// Main RPC, etc.) — this unifies persistence into the service layer.
import type { AgentEvent, AgentMessage } from '@earendil-works/pi-agent-core'
import { clampThinkingLevel } from '@earendil-works/pi-ai'
import { createLogger } from '@shared/logger'
import type { ProviderInjection } from '@swarm/protocol'
import { applyAgentModel, defaultAgents } from '@swarm/shared'
import { ulid } from 'ulid'

import { resolveModel } from '../session-agent/models'
import { assistantText, runOneShot } from '../session-agent/one-shot'
import type { ToolRunContext } from '../tools/registry'
import { readAnalysisCard } from '../tools/render-ui'
import type { AnalysisConfig, AnalysisDeps } from './types'

// Re-export so callers can import everything from one module.
export type { AnalysisConfig, AnalysisDeps } from './types'

export type AnalysisRunRequest = {
  provider: ProviderInjection | null
  /** The analysis-target id (articleId / repoName / bvid / threadId). */
  id: string
  /** The fully-assembled user prompt. */
  prompt: string
  /**
   * Extra per-request data forwarded to onComplete (e.g. bilibili's source field).
   * The flow's onComplete interprets this; the factory passes it through opaquely.
   */
  extra?: unknown
}

const log = createLogger({ process: 'service' }).child({ component: 'analysis-run' })

export type AnalysisRunResult = { ok: true } | { ok: false; code: 'no_provider' | 'no_agent'; message: string }

/**
 * Build a one-shot analysis runner from shared deps + per-flow config. The
 * returned function is what each flow exposes as its service entry point.
 */
export function createAnalysisRun<TSummary>(
  deps: AnalysisDeps,
  config: AnalysisConfig<TSummary>
): (req: AnalysisRunRequest) => AnalysisRunResult {
  const run = deps.runOneShot ?? runOneShot
  const { agentId, events, idKey, validateCard, buildCompletePayload, accumulateSummary, noCardBehavior } = config

  return (req) => {
    if (!req.provider) {
      return { ok: false, code: 'no_provider', message: '请先在 设置 → 模型 配置提供商。' }
    }
    const def = deps.agentStore.get(agentId) ?? defaultAgents.find((a) => a.id === agentId)
    if (!def) {
      return { ok: false, code: 'no_agent', message: `${agentId} agent 不可用。` }
    }

    let card: TSummary | null = null
    let accumulated = ''
    // Assistant text arrives via pi message_update as a growing partial; we emit
    // only the new suffix as a delta (the renderer bridge appends deltas). sentLen
    // is per assistant message — reset on message_start so a second turn's text
    // isn't sliced against the first turn's length.
    let sentLen = 0

    const isAssistant = (m: unknown): boolean => (m as { role?: string })?.role === 'assistant'

    const emitDelta = (message: AgentMessage): void => {
      const full = assistantText(message)
      if (full.length <= sentLen) return
      const delta = full.slice(sentLen)
      sentLen = full.length
      if (accumulateSummary) accumulated += delta
      deps.broadcaster.broadcast(events.delta, { [idKey]: req.id, text: delta, ts: Date.now() })
    }

    const onEvent = (e: AgentEvent): void => {
      switch (e.type) {
        case 'message_start':
          if (isAssistant(e.message)) sentLen = 0
          return
        case 'message_update':
        case 'message_end':
          if (isAssistant(e.message)) emitDelta(e.message)
          return
        case 'tool_execution_start': {
          const props = readAnalysisCard(e.toolName, e.args)
          if (props) card = validateCard(props)
          return
        }
        default:
          return
      }
    }

    const t0 = Date.now()
    log.info({ msg: 'analysis started', agentId, id: req.id, promptLen: req.prompt.length })
    // Heavy work (model resolution, tool assembly, the run) is async so a bad
    // provider config broadcasts an analysisError instead of throwing the sync ack.
    void (async () => {
      const provider = applyAgentModel(req.provider!, def)
      const model = resolveModel(provider)
      // Minimal tool context: the analysis agent only ever calls render_ui, which
      // needs sessionId/taskId. The rest are inert stubs (no delegation/permission
      // in a one-shot analysis run).
      const ctx: ToolRunContext = {
        sessionId: `analyze-${agentId}:${ulid()}`,
        taskId: req.id,
        spawnChild: () => Promise.reject(new Error('spawnChild is not available in an analysis run')),
        requestPermission: () => Promise.resolve('grant' as const),
        findPeers: () => [],
      }
      const { tools } = deps.toolRegistry.resolve(['ui.render_ui'], ctx)
      const r = await run(
        {
          label: ctx.sessionId,
          systemPrompt: def.systemPrompt,
          model,
          apiKey: provider.apiKey,
          thinkingLevel: clampThinkingLevel(model, provider.thinkingLevel ?? 'high'),
          tools,
          maxTurns: def.maxIterations ?? 25,
          prompt: req.prompt,
          onEvent,
        },
        { acquireSlot: deps.acquireSlot }
      )
      log.info({ msg: 'analysis complete', agentId, id: req.id, status: r.status, durationMs: Date.now() - t0 })
      if (r.status === 'failed') {
        deps.broadcaster.broadcast(events.error, {
          [idKey]: req.id,
          error: r.summary || 'analysis failed',
          ts: Date.now(),
        })
        return
      }
      if (r.status === 'cancelled') return
      // Completed. When noCardBehavior is 'tolerate' and card is null (agent
      // emitted no card), buildCompletePayload receives null and decides what to
      // put in the payload (e.g. gmail-thread keeps the streamed summary).
      if (card || noCardBehavior === 'tolerate') {
        deps.broadcaster.broadcast(events.complete, {
          [idKey]: req.id,
          ...buildCompletePayload(card, accumulated),
          ts: Date.now(),
        })
        if (deps.onComplete) {
          void Promise.resolve(deps.onComplete(req.id, card, accumulated, req.extra, log)).catch((err) => {
            log.warn({
              msg: 'analysis onComplete persistence failed',
              agentId,
              id: req.id,
              err: err instanceof Error ? err.message : String(err),
            })
          })
        }
      } else {
        log.warn({ msg: 'analysis produced no valid card', agentId, id: req.id })
        deps.broadcaster.broadcast(events.error, { [idKey]: req.id, error: '分析结果解析失败', ts: Date.now() })
      }
    })().catch((err) => {
      log.error({
        msg: 'analysis run failed',
        agentId,
        id: req.id,
        err: err instanceof Error ? err.message : String(err),
      })
      deps.broadcaster.broadcast(events.error, {
        [idKey]: req.id,
        error: err instanceof Error ? err.message : String(err),
        ts: Date.now(),
      })
    })

    return { ok: true }
  }
}
