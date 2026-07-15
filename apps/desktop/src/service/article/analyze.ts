// One-shot analysis of a collected article. Thin config over the shared
// analysis-run factory (service/analysis/run.ts). The agent streams a
// natural-language markdown summary (shown live) and emits its structured fields
// via a render_ui({type:'analysis', props:{gist, points, takeaways}}) tool call.
// On message.complete a valid card persists to the article store (re-viewable);
// no valid card degrades to analysisError.
import type { AnalyzeArticleRequest, AnalyzeArticleResult, ArticleSummary, BudgetConfig } from '@swarm/protocol'

import type { AgentStore } from '../agents/store'
import { type AnalysisConfig, type AnalysisDeps, createAnalysisRun } from '../analysis/run'
import type { Broadcaster } from '../ipc/broadcaster'
import type { launchMessage } from '../message-engine/launch'
import type { ToolRegistry } from '../tools/registry'
import type { ArticleStore } from './store'

const ARTICLE_CONFIG: AnalysisConfig<ArticleSummary> = {
  agentId: 'article-analyst',
  events: { delta: 'article.analysisDelta', complete: 'article.analysisComplete', error: 'article.analysisError' },
  idKey: 'articleId',
  validateCard: toArticleSummary,
  buildCompletePayload: (card) => (card ? { summary: card } : {}),
  accumulateSummary: false,
  noCardBehavior: 'error',
}

export type AnalyzeDeps = {
  broadcaster: Broadcaster
  agentStore: Pick<AgentStore, 'get'>
  store: ArticleStore
  toolRegistry: ToolRegistry
  getBudgetConfig(): BudgetConfig
  /** Injectable so tests can drive the emit adapter without a real provider/engine. */
  launch?: typeof launchMessage
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
  const analysisDeps: AnalysisDeps = {
    broadcaster: deps.broadcaster,
    agentStore: deps.agentStore,
    toolRegistry: deps.toolRegistry,
    getBudgetConfig: deps.getBudgetConfig,
    launch: deps.launch,
    onComplete: (id, summary) => {
      deps.store.saveAnalysis(id, summary as ArticleSummary)
    },
  }
  const run = createAnalysisRun(analysisDeps, ARTICLE_CONFIG)
  return (req) => {
    // Article-specific pre-check: the article must exist in the store (the
    // prompt needs its content). The factory handles provider/agent checks.
    const article = deps.store.get(req.articleId)
    if (!article) {
      return { ok: false, code: 'no_article', message: '文章不存在。' }
    }
    const prompt = `分析下面这篇文章。\n\nTitle: ${article.title}\nSource: ${article.url}\n\n${article.contentMarkdown}`
    const result = run({ provider: req.provider, id: req.articleId, prompt })
    if (!result.ok) return result
    return { ok: true }
  }
}
