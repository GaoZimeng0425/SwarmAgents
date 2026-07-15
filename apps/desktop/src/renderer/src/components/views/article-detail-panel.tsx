// Persistent right-hand detail column for the article view. Owns the AI
// analysis lifecycle (analyze IPC + streaming analysis-delta/complete/error
// subscription) and renders the structured summary or the raw markdown body.
// Single-column layout matching the design doc: cover header + collapse chevron,
// horizontal action row, segmented tabs, gradient gist card, and iconed
// 核心要点 / 可带走洞察 sections.
import { useEffect, useState } from 'react'
import type { ArticleSummary, CollectedArticleWithAnalysis } from '@swarm/protocol'
import { Button } from '@swarm/ui'
import { ArrowRight, ChevronRight, ExternalLink, ListChecks, Loader2, Sparkles, Trash2 } from 'lucide-react'
import { Streamdown } from 'streamdown'

import { ScrollArea } from '@/components/ui/scroll-area'
import { useAnalysisStream } from '@/hooks/use-analysis-stream'
import { swarmApi } from '@/lib/api'
import { cn } from '@/lib/utils'
import { AnalysisContent } from './analysis-primitives'
import { colorForSite } from './article-colors'

type DetailTab = 'analysis' | 'text'

function hostnameOf(url: string): string {
  try {
    return new URL(url).hostname
  } catch {
    return url
  }
}

// Rough Chinese reading time: ~400 chars/min, floored at 1 minute.
function readMinutes(markdown: string): number {
  return Math.max(1, Math.round(markdown.length / 400))
}

// Renders a structured ArticleSummary: header line + gradient gist card +
// 核心要点 list + 可带走洞察 list, matching the design doc.
function SummaryView({ summary, readMin }: { summary: ArticleSummary; readMin: number }): React.JSX.Element {
  return (
    <div className="flex flex-col gap-3.5">
      <div className="flex items-center gap-2 text-[11.5px] text-muted-foreground">
        <span className="flex items-center gap-1 font-semibold text-violet-600 dark:text-violet-300">
          <Sparkles className="size-3" /> AI 结构化摘要
        </span>
        <span className="h-px flex-1 bg-border" />
        <span>{readMin} 分钟读完</span>
      </div>

      <div className="rounded-xl border border-violet-500/15 bg-linear-to-br from-violet-500/10 to-primary/5 p-3.5">
        <p className="mb-1.5 font-semibold text-[10.5px] text-violet-500/80 uppercase tracking-wide">一句话结论</p>
        <p className="text-[14px] text-foreground/85 leading-relaxed">{summary.gist}</p>
      </div>

      {summary.points.length > 0 ? (
        <section className="rounded-xl border border-border bg-secondary/40 p-3.5 shadow-sm">
          <div className="mb-2.5 flex items-center gap-1.5">
            <span className="flex size-5 items-center justify-center rounded-md bg-sky-500/12">
              <ListChecks className="size-3 text-sky-600" />
            </span>
            <span className="font-semibold text-[13px] text-foreground">核心要点</span>
          </div>
          <ul className="flex flex-col gap-2">
            {summary.points.map((p, i) => (
              // biome-ignore lint/suspicious/noArrayIndexKey: plain string list, no stable id
              <li className="flex gap-2 text-[12.5px] text-foreground/85 leading-relaxed" key={`point-${i}`}>
                <span className="mt-1.5 size-1.5 shrink-0 rounded-full bg-sky-500" />
                <span>{p}</span>
              </li>
            ))}
          </ul>
        </section>
      ) : null}

      {summary.takeaways.length > 0 ? (
        <section className="rounded-xl border border-border bg-secondary/40 p-3.5 shadow-sm">
          <div className="mb-2.5 flex items-center gap-1.5">
            <span className="flex size-5 items-center justify-center rounded-md bg-emerald-500/14">
              <ArrowRight className="size-3 text-emerald-600" />
            </span>
            <span className="font-semibold text-[13px] text-foreground">可带走洞察</span>
          </div>
          <ul className="flex flex-col gap-2">
            {summary.takeaways.map((p, i) => (
              // biome-ignore lint/suspicious/noArrayIndexKey: plain string list, no stable id
              <li className="flex gap-2 text-[12.5px] text-foreground/85 leading-relaxed" key={`takeaway-${i}`}>
                <span className="mt-1.5 size-1.5 shrink-0 rounded-full bg-emerald-500" />
                <span>{p}</span>
              </li>
            ))}
          </ul>
        </section>
      ) : null}
    </div>
  )
}

export function ArticleDetailPanel({
  article,
  onClose,
  onChanged,
  onAnalyzingChange,
}: {
  article: CollectedArticleWithAnalysis
  onClose: () => void
  onChanged: () => void
  /** Report the id currently being analyzed (null when idle) so the grid can
   *  badge that card. */
  onAnalyzingChange?: (id: string | null) => void
}): React.JSX.Element {
  const [detailTab, setDetailTab] = useState<DetailTab>('analysis')

  const { state, analyze } = useAnalysisStream<ArticleSummary>({
    id: article.id,
    events: { delta: 'article.analysisDelta', complete: 'article.analysisComplete', error: 'article.analysisError' },
    idField: 'articleId',
    parseComplete: (e) => (e as { summary: ArticleSummary }).summary,
    trigger: () => swarmApi.articleAnalyze(article.id),
    cachedResult: article.summary ?? null,
    invalidateOnComplete: [['articles', 'list']],
  })

  // Surface the in-flight id to the grid so it can badge the matching card;
  // clear it when idle or when the panel unmounts.
  const phase = state.phase
  useEffect(() => {
    onAnalyzingChange?.(phase === 'streaming' ? article.id : null)
    return () => onAnalyzingChange?.(null)
  }, [phase, article.id, onAnalyzingChange])

  const streamText = state.phase === 'streaming' || state.phase === 'done' ? state.streamText : ''
  const error = state.phase === 'error' ? state.error : null
  const liveSummary = state.phase === 'done' ? state.result : null
  const summary = liveSummary ?? article.summary
  const site = article.siteName ?? hostnameOf(article.url)
  const initial = site.slice(0, 1).toUpperCase()
  const readMin = readMinutes(article.contentMarkdown)

  function handleAnalyze(): void {
    setDetailTab('analysis')
    analyze()
  }

  async function handleDelete(): Promise<void> {
    await swarmApi.articleDelete(article.id)
    onChanged()
  }

  return (
    <aside className="flex w-[472px] shrink-0 flex-col border-border/60 border-l bg-background">
      <ScrollArea className="min-h-0 flex-1" edgeFade>
        <div className="flex flex-col gap-3.5 p-5">
          {/* Header: cover thumbnail + title/site + collapse chevron. */}
          <div className="flex items-start gap-3">
            <div
              className={cn(
                'flex size-11 shrink-0 items-center justify-center rounded-lg font-bold text-lg',
                colorForSite(article.siteName)
              )}
            >
              {initial}
            </div>
            <div className="min-w-0 flex-1">
              <h2 className="line-clamp-2 font-semibold text-[15px] text-foreground leading-snug">{article.title}</h2>
              <p className="mt-1 truncate text-muted-foreground text-xs">
                {site} · 收集于 {article.collectedAt.slice(0, 10)}
              </p>
            </div>
            <Button aria-label="收起详情" onClick={onClose} size="icon-sm" variant="ghost">
              <ChevronRight className="size-4" />
            </Button>
          </div>

          {/* Action row. */}
          <div className="flex gap-2">
            <Button className="flex-1" disabled={phase === 'streaming'} onClick={() => void handleAnalyze()}>
              {phase === 'streaming' ? (
                <>
                  <Loader2 className="animate-spin" /> 解析中…
                </>
              ) : summary ? (
                '重新分析'
              ) : (
                'AI 分析'
              )}
            </Button>
            <Button onClick={() => window.open(article.url, '_blank')} variant="outline">
              <ExternalLink /> 打开原文
            </Button>
            <Button aria-label="删除" onClick={() => void handleDelete()} size="icon" variant="outline">
              <Trash2 className="text-destructive" />
            </Button>
          </div>

          {/* Segmented tabs. */}
          <div className="flex gap-0.5 rounded-lg bg-muted/60 p-0.5">
            {(['analysis', 'text'] as const).map((tab) => (
              <button
                className={cn(
                  'flex-1 rounded-md py-1.5 font-semibold text-[12.5px] transition-colors',
                  detailTab === tab
                    ? 'bg-background text-foreground shadow-sm'
                    : 'text-muted-foreground hover:text-foreground'
                )}
                key={tab}
                onClick={() => setDetailTab(tab)}
                type="button"
              >
                {tab === 'analysis' ? 'AI 解析' : '原文'}
              </button>
            ))}
          </div>

          {/* Content. */}
          {detailTab === 'analysis' ? (
            <AnalysisContent
              emptyPrompt="点击「AI 分析」生成结构化摘要"
              error={error}
              phase={phase}
              resultCard={summary ? <SummaryView readMin={readMin} summary={summary} /> : undefined}
              streamText={streamText}
            />
          ) : (
            <div className="text-[13px] text-foreground/85 leading-relaxed">
              <Streamdown>{article.contentMarkdown}</Streamdown>
            </div>
          )}
        </div>
      </ScrollArea>
    </aside>
  )
}
