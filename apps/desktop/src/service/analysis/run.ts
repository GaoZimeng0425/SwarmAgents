// The ONE factory behind all four card-based analysis flows (article / trending
// / bilibili / gmail-thread). Owns the shared skeleton: agent/provider lookup,
// the private LaunchPorts (silent seq, no-op append/markTerminal/slot/abort),
// the broadcast adapter translating message.* wire into domain *.analysis* events,
// and the fire-and-forget launchMessage run. Per-flow differences live in the
// AnalysisConfig: validateCard, buildCompletePayload, accumulateSummary, and
// noCardBehavior.
//
// Returns a sync ack ({ ok: true } | { ok: false, code, message }); the actual
// result streams back via broadcast events, same as before. The optional
// onComplete dep fires on message.complete with the valid card so the flow can
// persist it (service store, Main RPC, etc.) — this unifies persistence into
// the service layer.
import { createLogger } from '@shared/logger'
import type { ProviderInjection } from '@swarm/protocol'
import { applyAgentModel, defaultAgents } from '@swarm/shared'
import { ulid } from 'ulid'

import type { MessageEmitPorts } from '../message-engine/emit'
import { type LaunchPorts, launchMessage, type MessageSpec } from '../message-engine/launch'
import { createPermissionRegistry } from '../session/permission-registry'
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
  const run = deps.launch ?? launchMessage
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
    let runError: string | null = null

    let seq = 0
    const emitPorts: MessageEmitPorts = {
      nextSeq: () => seq++,
      appendEvent: () => undefined,
      markTerminal: () => undefined,
      broadcast: (evt) => {
        if (evt.kind === 'message.progress') {
          const ev = evt.event
          if (ev?.kind === 'llm.message' && ev.role === 'assistant' && typeof ev.content === 'string') {
            if (accumulateSummary) accumulated += ev.content
            deps.broadcaster.broadcast(events.delta, { [idKey]: req.id, text: ev.content, ts: Date.now() })
            return
          }
          const props = readAnalysisCard(evt)
          if (props) card = validateCard(props)
        } else if (evt.kind === 'message.complete') {
          if (card) {
            const payload = { [idKey]: req.id, ...buildCompletePayload(card, accumulated), ts: Date.now() }
            deps.broadcaster.broadcast(events.complete, payload)
            // Persist in the service layer (unified persistence). Errors are
            // logged but never block the broadcast — the result is already shown.
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
          } else if (noCardBehavior === 'error') {
            log.warn({ msg: 'analysis produced no valid card', agentId, id: req.id })
            deps.broadcaster.broadcast(events.error, { [idKey]: req.id, error: '分析结果解析失败', ts: Date.now() })
          }
          // 'tolerate': no card → the caller handles empty defaults (gmail-thread).
        } else if (evt.kind === 'message.error') {
          runError = evt.error?.message ?? 'analysis failed'
          deps.broadcaster.broadcast(events.error, { [idKey]: req.id, error: runError, ts: Date.now() })
        }
      },
    }

    const ports: LaunchPorts = {
      emit: emitPorts,
      toolRegistry: deps.toolRegistry,
      permissionRegistry: createPermissionRegistry(() => undefined),
      acquireSlot: async () => () => undefined,
      registerAbort: () => undefined,
      unregisterAbort: () => undefined,
    }

    const spec: MessageSpec = {
      kind: 'work',
      sessionId: `analyze-${agentId}:${ulid()}`,
      agent: def,
      provider: applyAgentModel(req.provider, def),
      prompt: req.prompt,
      budget: deps.getBudgetConfig().sub,
      tools: ['ui.render_ui'],
      maxIterationsOverride: def.maxIterations,
    }

    const t0 = Date.now()
    log.info({ msg: 'analysis started', agentId, id: req.id, promptLen: req.prompt.length })
    void run(spec, ports)
      .then((r) =>
        log.info({ msg: 'analysis complete', agentId, id: req.id, status: r.status, durationMs: Date.now() - t0 })
      )
      .catch((err) =>
        log.error({
          msg: 'analysis run failed',
          agentId,
          id: req.id,
          err: err instanceof Error ? err.message : String(err),
        })
      )

    return { ok: true }
  }
}
