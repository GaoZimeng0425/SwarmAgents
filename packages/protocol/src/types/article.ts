import { z } from 'zod'

import { ProviderInjection } from './provider'

// Cleaned article body extracted by the extension's content script. Author /
// siteName / publishedTime are nullable because readability does not guarantee
// them; url / title / contentMarkdown are required.
export const ArticleSource = z.object({
  url: z.string().url().max(4096),
  title: z.string().min(1).max(500),
  author: z.string().max(200).nullable().default(null),
  siteName: z.string().max(200).nullable().default(null),
  publishedTime: z.string().datetime().nullable().default(null),
  contentMarkdown: z.string().min(1).max(200_000),
})
export type ArticleSource = z.infer<typeof ArticleSource>

// A persisted collected article (one record in collected-articles.json).
export const CollectedArticle = ArticleSource.extend({
  id: z.string(),
  collectedAt: z.string().datetime(),
  excerpt: z.string().max(300),
})
export type CollectedArticle = z.infer<typeof CollectedArticle>

// Structured output of the article-analyst agent.
export const ArticleSummary = z.object({
  gist: z.string(),
  points: z.array(z.string()),
  takeaways: z.array(z.string()),
})
export type ArticleSummary = z.infer<typeof ArticleSummary>

// A collected article with its analysis cache (returned by listArticles).
export const CollectedArticleWithAnalysis = CollectedArticle.extend({
  summary: ArticleSummary.nullable().default(null),
  analyzedAt: z.string().datetime().nullable().default(null),
})
export type CollectedArticleWithAnalysis = z.infer<typeof CollectedArticleWithAnalysis>

// collectArticle: WS-reachable (extension), no provider needed.
export const CollectArticleRequest = ArticleSource
export type CollectArticleRequest = z.infer<typeof CollectArticleRequest>
export const CollectArticleResult = z.discriminatedUnion('ok', [
  z.object({ ok: z.literal(true), articleId: z.string() }),
  z.object({ ok: z.literal(false), code: z.literal('invalid'), message: z.string() }),
])
export type CollectArticleResult = z.infer<typeof CollectArticleResult>

// analyzeArticle: renderer→main→service (main injects provider).
export const AnalyzeArticleRequest = z.object({
  articleId: z.string(),
  provider: ProviderInjection,
})
export type AnalyzeArticleRequest = z.infer<typeof AnalyzeArticleRequest>
export const AnalyzeArticleResult = z.discriminatedUnion('ok', [
  z.object({ ok: z.literal(true) }),
  z.object({
    ok: z.literal(false),
    code: z.enum(['no_provider', 'no_agent', 'no_article']),
    message: z.string(),
  }),
])
export type AnalyzeArticleResult = z.infer<typeof AnalyzeArticleResult>

// Broadcast events (mirror gmail.analysisDelta pattern).
export const ArticleAnalysisDeltaEvent = z.object({
  kind: z.literal('article.analysisDelta'),
  articleId: z.string(),
  text: z.string(),
  ts: z.number(),
})
export type ArticleAnalysisDeltaEvent = z.infer<typeof ArticleAnalysisDeltaEvent>
export const ArticleAnalysisCompleteEvent = z.object({
  kind: z.literal('article.analysisComplete'),
  articleId: z.string(),
  summary: ArticleSummary,
  ts: z.number(),
})
export type ArticleAnalysisCompleteEvent = z.infer<typeof ArticleAnalysisCompleteEvent>
export const ArticleAnalysisErrorEvent = z.object({
  kind: z.literal('article.analysisError'),
  articleId: z.string(),
  error: z.string(),
  ts: z.number(),
})
export type ArticleAnalysisErrorEvent = z.infer<typeof ArticleAnalysisErrorEvent>
