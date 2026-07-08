// One-shot analysis of a collected article. Mirrors service/gmail/analyze-thread.ts:
// a PRIVATE LaunchPorts binding (silent seq, no store append, no-op slot/abort ports),
// a broadcast adapter translating run.* into article.analysis* events keyed by articleId.
// The agent streams a natural-language markdown summary (shown live) and emits its
// structured fields via a render_ui({type:'analysis', props:{gist, points, takeaways}})
// tool call, captured with readAnalysisCard. On run.complete a valid card caches the
// summary back to the article store (re-viewable, like bili's analysis cache); no valid
// card degrades to analysisError.
import { createLogger } from '@shared/logger'
import type { AnalyzeArticleRequest, AnalyzeArticleResult, ArticleSummary, BudgetConfig } from '@swarm/protocol'
import { applyAgentModel, defaultAgents } from '@swarm/shared'
import { ulid } from 'ulid'

import type { AgentStore } from '../agents/store'
import type { Broadcaster } from '../ipc/broadcaster'
import type { RunEmitPorts } from '../run-engine/emit'
import { type LaunchPorts, launchRun, type RunSpec } from '../run-engine/launch'
import { createPermissionRegistry } from '../session/permission-registry'
import type { ToolRegistry } from '../tools/registry'
import { readAnalysisCard } from '../tools/render-ui'
import type { ArticleStore } from './store'

const log = createLogger({ process: 'service' }).child({ component: 'article-analyze' })

const ARTICLE_ANALYST_ID = 'article-analyst'

export type AnalyzeDeps = {
  broadcaster: Broadcaster
  agentStore: Pick<AgentStore, 'get'>
  store: ArticleStore
  toolRegistry: ToolRegistry
  getBudgetConfig(): BudgetConfig
  /** Injectable so tests can drive the emit adapter without a real provider/engine. */
  launch?: typeof launchRun
}

// Validate the render_ui analysis card props into an ArticleSummary. Returns
// null when the shape doesn't match (agent emitted no/invalid card).
export function toArticleSummary(props: Record<string, unknown>): ArticleSummary | null {
  if (typeof props.gist === 'string' && Array.isArray(props.points) && Array.isArray(props.takeaways)) {
    return { gist: props.gist, points: props.points as string[], takeaways: props.takeaways as string[] }
  }
  return null
}

export function createAnalyzeArticle(deps: AnalyzeDeps): (req: AnalyzeArticleRequest) => AnalyzeArticleResult {
  const run = deps.launch ?? launchRun
  return (req) => {
    if (!req.provider) {
      return { ok: false, code: 'no_provider', message: '请先在 设置 → 模型 配置提供商。' }
    }
    const def = deps.agentStore.get(ARTICLE_ANALYST_ID) ?? defaultAgents.find((a) => a.id === ARTICLE_ANALYST_ID)
    if (!def) {
      return { ok: false, code: 'no_agent', message: 'article-analyst agent 不可用。' }
    }
    const article = deps.store.get(req.articleId)
    if (!article) {
      return { ok: false, code: 'no_article', message: '文章不存在。' }
    }

    // PRIVATE emit ports: a silent seq (no session/store), no persistence, no
    // terminal registry — the analysis lives entirely in the broadcast stream.
    // The broadcast port translates the run.* wire into article.analysis* events:
    // run.progress llm.message → analysisDelta (streamed prose),
    // run.progress tool.call (analysis card) → capture {gist, points, takeaways},
    // run.complete → saveAnalysis→analysisComplete (or analysisError if no valid
    // card), run.error → analysisError.
    let card: ArticleSummary | null = null

    let seq = 0
    const emitPorts: RunEmitPorts = {
      nextSeq: () => seq++,
      appendEvent: () => undefined,
      markTerminal: () => undefined,
      broadcast: (evt) => {
        if (evt.kind === 'run.progress') {
          const ev = evt.event
          if (ev?.kind === 'llm.message' && typeof ev.content === 'string') {
            deps.broadcaster.broadcast('article.analysisDelta', {
              articleId: req.articleId,
              text: ev.content,
              ts: Date.now(),
            })
            return
          }
          const props = readAnalysisCard(evt)
          if (props) card = toArticleSummary(props)
        } else if (evt.kind === 'run.complete') {
          if (card) {
            deps.store.saveAnalysis(req.articleId, card)
            deps.broadcaster.broadcast('article.analysisComplete', {
              articleId: req.articleId,
              summary: card,
              ts: Date.now(),
            })
          } else {
            log.warn({ msg: 'article analysis produced no valid analysis card', articleId: req.articleId })
            deps.broadcaster.broadcast('article.analysisError', {
              articleId: req.articleId,
              error: '分析结果解析失败',
              ts: Date.now(),
            })
          }
        } else if (evt.kind === 'run.error') {
          deps.broadcaster.broadcast('article.analysisError', {
            articleId: req.articleId,
            error: evt.error?.message ?? 'analysis failed',
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

    const analyzePrompt = `分析下面这篇文章。\n\nTitle: ${article.title}\nSource: ${article.url}\n\n${article.contentMarkdown}`
    const spec: RunSpec = {
      kind: 'work',
      sessionId: `analyze-article:${ulid()}`,
      agent: def,
      provider: applyAgentModel(req.provider, def),
      prompt: analyzePrompt,
      budget: deps.getBudgetConfig().sub,
      tools: ['ui.render_ui'],
      maxIterationsOverride: def.maxIterations,
    }

    const t0 = Date.now()
    log.info({ msg: 'article analyze started', articleId: req.articleId, contentLen: article.contentMarkdown.length })
    // launchRun never rejects: every failure path emits run.error, which the
    // broadcast port already forwards as analysisError. The catch is purely
    // defensive (log-only, no double broadcast).
    void run(spec, ports)
      .then((r) =>
        log.info({
          msg: 'article analyze complete',
          articleId: req.articleId,
          status: r.status,
          durationMs: Date.now() - t0,
        })
      )
      .catch((err) => {
        log.error({
          msg: 'article analyze run failed',
          articleId: req.articleId,
          err: err instanceof Error ? err.message : String(err),
        })
      })

    return { ok: true }
  }
}
