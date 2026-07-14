// One-shot Agent research of a trending GitHub repo. Mirrors gmail/analyze-thread.ts:
// a PRIVATE LaunchPorts binding (silent seq, no store append, no-op slot/abort
// ports) and a broadcast adapter translating run.* into trending.research*
// events keyed by repoName. The agent streams a natural-language markdown
// briefing (shown live AND kept on completion) and emits its structured fields
// via a render_ui({type:'analysis', props:{...}}) tool call, captured with
// readAnalysisCard. The streamed markdown IS the summary; the card carries the
// structured sections. On message.complete a valid card caches the research
// (with summary) back to the research store (re-viewable); no valid card
// degrades to researchError.
//
// ponytail: the researcher reasons from repo metadata + model knowledge (no live
// README/commit fetch). Upgrade path if freshness on brand-new repos matters:
// grant it a web-fetch tool + agent-reach skill and expand the prompt to read
// the README and recent commits before emitting the card.
import { createLogger } from '@shared/logger'
import type { BudgetConfig, RepoResearch, ResearchRepoRequest, ResearchRepoResult } from '@swarm/protocol'
import { TRENDING_PERIOD_LABELS, type TrendingPeriod } from '@swarm/protocol'
import { applyAgentModel, defaultAgents } from '@swarm/shared'
import { ulid } from 'ulid'

import type { AgentStore } from '../agents/store'
import type { Broadcaster } from '../ipc/broadcaster'
import type { MessageEmitPorts } from '../message-engine/emit'
import { type LaunchPorts, launchMessage, type MessageSpec } from '../message-engine/launch'
import { createPermissionRegistry } from '../session/permission-registry'
import type { ToolRegistry } from '../tools/registry'
import { readAnalysisCard } from '../tools/render-ui'
import type { RepoResearchStore } from './research-store'

const log = createLogger({ process: 'service' }).child({ component: 'repo-research' })

const REPO_RESEARCHER_ID = 'repo-researcher'

const VERDICT_TONES = new Set(['recommend', 'adopt', 'caution', 'watch'])

export type ResearchDeps = {
  broadcaster: Broadcaster
  agentStore: Pick<AgentStore, 'get'>
  store: RepoResearchStore
  toolRegistry: ToolRegistry
  getBudgetConfig(): BudgetConfig
  /** Injectable so tests can drive the emit adapter without a real provider/engine. */
  launch?: typeof launchMessage
}

// Validate the render_ui analysis card props into a RepoResearch. Returns null
// when the shape doesn't match (agent emitted no/invalid card).
export function toRepoResearch(props: Record<string, unknown>): RepoResearch | null {
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
      verdictTone: props.verdictTone as RepoResearch['verdictTone'],
    }
  }
  return null
}

function buildResearchPrompt(repo: ResearchRepoRequest['repo'], period: TrendingPeriod): string {
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
  const run = deps.launch ?? launchMessage
  return (req) => {
    if (!req.provider) {
      return { ok: false, code: 'no_provider', message: '请先在 设置 → 模型 配置提供商。' }
    }
    const def = deps.agentStore.get(REPO_RESEARCHER_ID) ?? defaultAgents.find((a) => a.id === REPO_RESEARCHER_ID)
    if (!def) {
      return { ok: false, code: 'no_agent', message: 'repo-researcher agent 不可用。' }
    }
    const repoName = req.repo.repoName

    // PRIVATE emit ports: a silent seq (no session/store), no persistence, no
    // terminal registry — the research lives entirely in the broadcast stream.
    // The broadcast port translates the run.* wire into trending.research*
    // events: message.progress llm.message → researchDelta (+ accumulate summary),
    // run.progress tool.call (analysis card) → capture RepoResearch,
    // message.complete → save→researchComplete (with summary), message.error →
    // researchError.
    let accumulated = ''
    let card: RepoResearch | null = null

    let seq = 0
    const emitPorts: MessageEmitPorts = {
      nextSeq: () => seq++,
      appendEvent: () => undefined,
      markTerminal: () => undefined,
      broadcast: (evt) => {
        if (evt.kind === 'message.progress') {
          const ev = evt.event
          if (ev?.kind === 'llm.message' && ev.role === 'assistant' && typeof ev.content === 'string') {
            accumulated += ev.content
            deps.broadcaster.broadcast('trending.researchDelta', {
              repoName,
              text: ev.content,
              ts: Date.now(),
            })
            return
          }
          const props = readAnalysisCard(evt)
          const parsed = props ? toRepoResearch(props) : null
          if (parsed) card = { ...parsed, summary: accumulated }
        } else if (evt.kind === 'message.complete') {
          if (card) {
            const cardWithSummary: RepoResearch = { ...card, summary: accumulated }
            deps.store.save(repoName, cardWithSummary)
            deps.broadcaster.broadcast('trending.researchComplete', {
              repoName,
              research: cardWithSummary,
              summary: accumulated,
              ts: Date.now(),
            })
          } else {
            log.warn({ msg: 'repo research produced no valid analysis card', repoName })
            deps.broadcaster.broadcast('trending.researchError', {
              repoName,
              error: '调研结果解析失败',
              ts: Date.now(),
            })
          }
        } else if (evt.kind === 'message.error') {
          deps.broadcaster.broadcast('trending.researchError', {
            repoName,
            error: evt.error?.message ?? 'research failed',
            ts: Date.now(),
          })
        }
      },
    }

    // No-op slot/abort ports and a no-op permission gate: a self-contained run
    // (only the low-risk render_ui structured-output tool) that competes for
    // nothing and prompts for nothing.
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
      sessionId: `research-repo:${ulid()}`,
      agent: def,
      provider: applyAgentModel(req.provider, def),
      prompt: buildResearchPrompt(req.repo, req.period),
      budget: deps.getBudgetConfig().sub,
      tools: ['ui.render_ui'],
      maxIterationsOverride: def.maxIterations,
    }

    const t0 = Date.now()
    log.info({ msg: 'repo research started', repoName, period: req.period })
    // launchMessage never rejects: every failure path emits message.error, which the
    // broadcast port already forwards as researchError. The catch is purely
    // defensive (log-only, no double broadcast).
    void run(spec, ports)
      .then((r) => log.info({ msg: 'repo research complete', repoName, status: r.status, durationMs: Date.now() - t0 }))
      .catch((err) => {
        log.error({ msg: 'repo research run failed', repoName, err: err instanceof Error ? err.message : String(err) })
      })

    return { ok: true }
  }
}
