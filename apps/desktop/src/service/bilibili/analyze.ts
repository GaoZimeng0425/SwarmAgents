// One-shot analysis of a Bilibili video transcript. This is the one flow NOT yet
// on the shared analysis-run factory: bilibili's pipeline is async (Main awaits
// the summary to persist it alongside the transcript text), which conflicts with
// the factory's sync-ack model. It will be migrated to the factory when the
// frontend is unified (the renderer must stop reading the IPC return value and
// switch to the streamed bilibili.analysisComplete event first).
//
// Mirrors the factory skeleton: a PRIVATE LaunchPorts binding (silent seq, no-op
// slot/abort ports), a broadcast adapter translating message.* wire into
// bilibili.analysis* events keyed by bvid. The agent streams markdown (shown
// live) and emits structured fields via render_ui({type:'analysis', props:{gist,
// points, experience, pitfalls, steps}}), captured with readAnalysisCard.
import { createLogger } from '@shared/logger'
import type { AnalyzeBilibiliRequest, AnalyzeBilibiliResult, BiliSummary, BudgetConfig } from '@swarm/protocol'
import { applyAgentModel, defaultAgents } from '@swarm/shared'
import { ulid } from 'ulid'

import type { AgentStore } from '../agents/store'
import type { Broadcaster } from '../ipc/broadcaster'
import type { MessageEmitPorts } from '../message-engine/emit'
import { type LaunchPorts, launchMessage, type MessageSpec } from '../message-engine/launch'
import { createPermissionRegistry } from '../session/permission-registry'
import type { ToolRegistry } from '../tools/registry'
import { readAnalysisCard } from '../tools/render-ui'

const log = createLogger({ process: 'service' }).child({ component: 'bilibili-analyze' })

const BILIBILI_ANALYST_ID = 'bilibili-analyst'

export type AnalyzeBilibiliDeps = {
  broadcaster: Broadcaster
  agentStore: Pick<AgentStore, 'get'>
  toolRegistry: ToolRegistry
  getBudgetConfig(): BudgetConfig
  /** Injectable so tests can drive the emit adapter without a real provider/engine. */
  launch?: typeof launchMessage
}

// Validate the render_ui analysis card props into a BiliSummary. Returns null when
// the shape doesn't match (agent emitted no/invalid card).
export function toBiliSummary(props: Record<string, unknown>): BiliSummary | null {
  if (
    typeof props.gist === 'string' &&
    Array.isArray(props.points) &&
    Array.isArray(props.experience) &&
    Array.isArray(props.pitfalls) &&
    Array.isArray(props.steps)
  ) {
    return {
      gist: props.gist,
      points: props.points as string[],
      experience: props.experience as string[],
      pitfalls: props.pitfalls as string[],
      steps: props.steps as string[],
    }
  }
  return null
}

export function createAnalyzeBilibili(
  deps: AnalyzeBilibiliDeps
): (req: AnalyzeBilibiliRequest) => Promise<AnalyzeBilibiliResult> {
  const run = deps.launch ?? launchMessage
  return async (req) => {
    if (!req.provider) {
      return { ok: false, code: 'no_provider', message: '请先在 设置 → 模型 配置提供商。' }
    }
    const def = deps.agentStore.get(BILIBILI_ANALYST_ID) ?? defaultAgents.find((a) => a.id === BILIBILI_ANALYST_ID)
    if (!def) {
      return { ok: false, code: 'no_agent', message: 'bilibili-analyst agent 不可用。' }
    }

    let card: BiliSummary | null = null
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
            deps.broadcaster.broadcast('bilibili.analysisDelta', {
              bvid: req.bvid,
              text: ev.content,
              ts: Date.now(),
            })
            return
          }
          const props = readAnalysisCard(evt)
          if (props) card = toBiliSummary(props)
        } else if (evt.kind === 'message.complete') {
          if (card) {
            deps.broadcaster.broadcast('bilibili.analysisComplete', {
              bvid: req.bvid,
              summary: card,
              ts: Date.now(),
            })
          } else {
            log.warn({ msg: 'bilibili analysis produced no valid analysis card', bvid: req.bvid })
            deps.broadcaster.broadcast('bilibili.analysisError', {
              bvid: req.bvid,
              error: '分析结果解析失败',
              ts: Date.now(),
            })
          }
        } else if (evt.kind === 'message.error') {
          runError = evt.error?.message ?? 'analysis failed'
          deps.broadcaster.broadcast('bilibili.analysisError', {
            bvid: req.bvid,
            error: runError,
            ts: Date.now(),
          })
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

    const analyzePrompt = `分析下面这个视频的字幕。\n\nTitle: ${req.title}\nAuthor: ${req.author}\n\n${req.text}`
    const spec: MessageSpec = {
      kind: 'work',
      sessionId: `analyze-bilibili:${ulid()}`,
      agent: def,
      provider: applyAgentModel(req.provider, def),
      prompt: analyzePrompt,
      budget: deps.getBudgetConfig().sub,
      tools: ['ui.render_ui'],
      maxIterationsOverride: def.maxIterations,
    }

    const t0 = Date.now()
    log.info({ msg: 'bilibili analyze started', bvid: req.bvid, contentLen: req.text.length })
    // Await the run so Main can persist the summary alongside the transcript text.
    const r = await run(spec, ports)
    log.info({ msg: 'bilibili analyze complete', bvid: req.bvid, status: r.status, durationMs: Date.now() - t0 })

    if (runError) return { ok: false, code: 'llm_failed', message: runError }
    if (!card) return { ok: false, code: 'no_card', message: '分析结果解析失败' }
    return { ok: true, summary: card }
  }
}
