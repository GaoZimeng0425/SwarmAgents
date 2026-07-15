// One-shot analysis of a Bilibili video transcript. Thin config over the shared
// analysis-run factory (service/analysis/run.ts). The agent streams markdown
// (shown live) and emits structured fields via render_ui({type:'analysis',
// props:{gist, points, experience, pitfalls, steps}}). On message.complete the
// result persists back to Main's analysisStore via the bilibili.save_analysis RPC.
import type {
  AnalyzeBilibiliRequest,
  AnalyzeBilibiliResult,
  BiliAnalysisSource,
  BiliSummary,
  BudgetConfig,
  MainMethod,
} from '@swarm/protocol'

import type { AgentStore } from '../agents/store'
import { type AnalysisConfig, type AnalysisDeps, createAnalysisRun } from '../analysis/run'
import type { Broadcaster } from '../ipc/broadcaster'
import type { launchMessage } from '../message-engine/launch'
import type { ToolRegistry } from '../tools/registry'

type CallMain = (method: MainMethod, args: unknown[]) => Promise<unknown>

const BILIBILI_CONFIG: AnalysisConfig<BiliSummary> = {
  agentId: 'bilibili-analyst',
  events: { delta: 'bilibili.analysisDelta', complete: 'bilibili.analysisComplete', error: 'bilibili.analysisError' },
  idKey: 'bvid',
  validateCard: toBiliSummary,
  buildCompletePayload: (card) => (card ? { summary: card } : {}),
  accumulateSummary: false,
  noCardBehavior: 'error',
}

export type AnalyzeBilibiliDeps = {
  broadcaster: Broadcaster
  agentStore: Pick<AgentStore, 'get'>
  toolRegistry: ToolRegistry
  getBudgetConfig(): BudgetConfig
  /** Cross-process RPC to Main (for persisting the analysis result). */
  callMain: CallMain
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

// Per-request extra data carried through the factory to onComplete.
type BiliExtra = { text: string; source: BiliAnalysisSource }

export function createAnalyzeBilibili(
  deps: AnalyzeBilibiliDeps
): (req: AnalyzeBilibiliRequest) => AnalyzeBilibiliResult {
  const analysisDeps: AnalysisDeps = {
    broadcaster: deps.broadcaster,
    agentStore: deps.agentStore,
    toolRegistry: deps.toolRegistry,
    getBudgetConfig: deps.getBudgetConfig,
    launch: deps.launch,
    onComplete: (bvid, summary, _accumulated, extra) => {
      const { text, source } = extra as BiliExtra
      void deps.callMain('bilibili.save_analysis', [
        bvid,
        { bvid, summary, text, source, analyzedAt: new Date().toISOString() },
      ])
    },
  }
  const run = createAnalysisRun(analysisDeps, BILIBILI_CONFIG)
  return (req) => {
    const prompt = `分析下面这个视频的字幕。\n\nTitle: ${req.title}\nAuthor: ${req.author}\n\n${req.text}`
    const result = run({ provider: req.provider, id: req.bvid, prompt, extra: { text: req.text, source: req.source } })
    if (!result.ok) return result
    return { ok: true }
  }
}
