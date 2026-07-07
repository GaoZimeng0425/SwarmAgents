// One-shot, tool-less analysis of a collected article. Mirrors service/gmail/analyze.ts:
// a PRIVATE LaunchPorts binding (silent seq, no store append, no-op slot/abort ports),
// a broadcast adapter translating run.* into article.analysis* events keyed by articleId.
// On run.complete the agent's JSON output is parsed into ArticleSummary; success caches
// the summary back to the article store (re-viewable, like bili's analysis cache).
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

// Parse the agent's JSON output into ArticleSummary. Tolerates accidental
// markdown code fences by stripping them before JSON.parse.
function parseSummary(raw: string): ArticleSummary | null {
  const cleaned = raw.replace(/^```(?:json)?\s*|\s*```$/g, '').trim()
  try {
    const obj = JSON.parse(cleaned) as unknown
    const summary = obj as { gist?: unknown; points?: unknown; takeaways?: unknown }
    if (typeof summary?.gist === 'string' && Array.isArray(summary?.points) && Array.isArray(summary?.takeaways)) {
      return { gist: summary.gist, points: summary.points as string[], takeaways: summary.takeaways as string[] }
    }
    return null
  } catch {
    return null
  }
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
    // run.progress llm.message → analysisDelta, run.complete → parse→saveAnalysis→
    // analysisComplete (or analysisError on parse failure), run.error → analysisError.
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
          }
        } else if (evt.kind === 'run.complete') {
          const summary = parseSummary(evt.summary)
          if (summary) {
            deps.store.saveAnalysis(req.articleId, summary)
            deps.broadcaster.broadcast('article.analysisComplete', {
              articleId: req.articleId,
              summary,
              ts: Date.now(),
            })
          } else {
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

    // No-op slot/abort ports and a no-op permission gate: a self-contained,
    // tool-less run that competes for nothing and prompts for nothing.
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
      tools: [],
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
