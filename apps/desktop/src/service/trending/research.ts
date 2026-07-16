// One-shot Agent research of a trending GitHub repo. Thin config over the shared
// analysis-run factory (service/analysis/run.ts). The agent streams a natural-language
// markdown briefing (shown live AND kept on completion) and emits its structured fields
// via a render_ui({type:'analysis', props:{...}}) tool call, captured with readAnalysisCard.
// The streamed markdown IS the summary; the card carries the structured sections.
// On message.complete a valid card + accumulated summary persists to the research store.
//
// ponytail: the researcher reasons from repo metadata + model knowledge (no live
// README/commit fetch). Upgrade path if freshness on brand-new repos matters:
// grant it a web-fetch tool + agent-reach skill and expand the prompt to read
// the README and recent commits before emitting the card.
import type { RepoResearch, RepoVerdictTone, ResearchRepoRequest, ResearchRepoResult } from '@swarm/protocol'
import { TRENDING_PERIOD_LABELS, type TrendingPeriod } from '@swarm/protocol'

import type { AgentStore } from '../agents/store'
import { type AnalysisConfig, type AnalysisDeps, createAnalysisRun } from '../analysis/run'
import type { Broadcaster } from '../ipc/broadcaster'
import type { OneShotRunner } from '../session-agent/one-shot'
import type { ToolRegistry } from '../tools/registry'
import type { RepoResearchStore } from './research-store'

const VERDICT_TONES = new Set(['recommend', 'adopt', 'caution', 'watch'])

// The card fields without summary — summary is the accumulated streamed markdown,
// merged in buildCompletePayload / onComplete at message.complete time.
type RepoCard = Omit<RepoResearch, 'summary'>

const TRENDING_CONFIG: AnalysisConfig<RepoCard> = {
  agentId: 'repo-researcher',
  events: { delta: 'trending.researchDelta', complete: 'trending.researchComplete', error: 'trending.researchError' },
  idKey: 'repoName',
  validateCard: toRepoCard,
  buildCompletePayload: (card, accumulated) => {
    if (!card) return { summary: accumulated }
    const research: RepoResearch = { ...card, summary: accumulated }
    return { research, summary: accumulated }
  },
  accumulateSummary: true,
  noCardBehavior: 'error',
}

export type ResearchDeps = {
  broadcaster: Broadcaster
  agentStore: Pick<AgentStore, 'get'>
  store: RepoResearchStore
  toolRegistry: ToolRegistry
  /** Global concurrency pool shared with the session runs. */
  acquireSlot: (signal: AbortSignal) => Promise<() => void>
  /** Injectable so tests can drive the adapter without a real provider/agent. */
  runOneShot?: OneShotRunner
}

// Validate the render_ui analysis card props into a RepoCard (no summary — that's
// the accumulated streamed markdown, merged later). Returns null on mismatch.
export function toRepoCard(props: Record<string, unknown>): RepoCard | null {
  if (
    typeof props.gist === 'string' &&
    typeof props.why === 'string' &&
    Array.isArray(props.highlights) &&
    typeof props.forWhom === 'string' &&
    typeof props.verdict === 'string' &&
    typeof props.verdictTag === 'string' &&
    typeof props.verdictTone === 'string' &&
    VERDICT_TONES.has(props.verdictTone)
  ) {
    return {
      gist: props.gist,
      why: props.why,
      highlights: props.highlights as string[],
      forWhom: props.forWhom,
      verdict: props.verdict,
      verdictTag: props.verdictTag,
      verdictTone: props.verdictTone as RepoVerdictTone,
    }
  }
  return null
}

export function buildResearchPrompt(repo: ResearchRepoRequest['repo'], period: TrendingPeriod): string {
  const label = TRENDING_PERIOD_LABELS[period]
  return [
    '调研下面这个 GitHub 趋势仓库。',
    '',
    `仓库: ${repo.repoName} (https://github.com/${repo.repoName})`,
    `语言: ${repo.language || '未知'}`,
    `描述: ${repo.description || '(无描述)'}`,
    `${label}内新增: ${repo.stars} ⭐ / ${repo.forks} forks / ${repo.pullRequests} PR`,
    repo.contributorLogins ? `主要贡献者: ${repo.contributorLogins}` : '',
  ]
    .filter(Boolean)
    .join('\n')
}

export function createResearchRepo(deps: ResearchDeps): (req: ResearchRepoRequest) => ResearchRepoResult {
  const analysisDeps: AnalysisDeps = {
    broadcaster: deps.broadcaster,
    agentStore: deps.agentStore,
    toolRegistry: deps.toolRegistry,
    acquireSlot: deps.acquireSlot,
    runOneShot: deps.runOneShot,
    onComplete: (repoName, card, accumulated) => {
      const research: RepoResearch = { ...(card as RepoCard), summary: accumulated }
      deps.store.save(repoName, research)
    },
  }
  const run = createAnalysisRun(analysisDeps, TRENDING_CONFIG)
  return (req) => {
    const prompt = buildResearchPrompt(req.repo, req.period)
    const result = run({ provider: req.provider, id: req.repo.repoName, prompt })
    if (!result.ok) return result
    return { ok: true }
  }
}
