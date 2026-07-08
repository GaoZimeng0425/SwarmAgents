// Persistent right-hand detail column for the article view. Owns the AI
// analysis lifecycle (analyze IPC + streaming analysis-delta/complete/error
// subscription) and renders the structured summary or the raw markdown body.
// Always mounted as a sibling of the article grid; shows an empty-state prompt
// when no article is selected.
import { useEffect, useState } from 'react'
import type { ArticleSummary, CollectedArticleWithAnalysis, UIEvent } from '@swarm/protocol'
import { Button } from '@swarm/ui'
import { useQueryClient } from '@tanstack/react-query'
import { ExternalLink, Loader2, Sparkles, Trash2, X } from 'lucide-react'
import { Streamdown } from 'streamdown'

import { ScrollArea } from '@/components/ui/scroll-area'
import { swarmApi } from '@/lib/api'

type DetailTab = 'analysis' | 'text'
type Phase = 'idle' | 'streaming' | 'done' | 'error'

// Renders a structured ArticleSummary: gist card + 核心要点 list + 可带走洞察 list.
function SummaryView({ summary }: { summary: ArticleSummary }): React.JSX.Element {
  const sections: { label: string; items: string[] }[] = [
    { label: '核心要点', items: summary.points },
    { label: '可带走洞察', items: summary.takeaways },
  ]
  return (
    <div className="flex flex-col gap-5">
      <div className="rounded-md border border-border bg-muted/30 p-4">
        <p className="mb-2 font-medium text-muted-foreground text-xs tracking-wide">一句话结论</p>
        <p className="text-[15px] text-foreground leading-7">{summary.gist}</p>
      </div>
      {sections
        .filter(({ items }) => items.length > 0)
        .map(({ label, items }) => (
          <section className="rounded-md border border-border p-4" key={label}>
            <p className="mb-3 font-medium text-foreground text-sm">{label}</p>
            <ul className="flex list-disc flex-col gap-2 pl-4 text-[13px] text-foreground/85 leading-6">
              {items.map((item, i) => (
                <li key={`${label}-${i}`}>{item}</li>
              ))}
            </ul>
          </section>
        ))}
    </div>
  )
}

// Reading-area placeholder while an analysis is in flight but no text has
// streamed yet: pulsing skeletons so the panel reads as "working".
function AnalyzingPlaceholder(): React.JSX.Element {
  return (
    <div className="flex flex-col gap-4">
      <div className="flex items-center gap-1.5 font-semibold text-[13px] text-violet-600 dark:text-violet-300">
        <Loader2 className="size-3.5 animate-spin" /> AI 分析中…
      </div>
      <div className="h-16 animate-pulse rounded-md bg-muted" />
      <div className="h-24 animate-pulse rounded-md bg-muted" />
      <div className="h-24 animate-pulse rounded-md bg-muted" />
    </div>
  )
}

export function ArticleDetailPanel({
  article,
  onClose,
  onChanged,
  onAnalyzingChange,
}: {
  article: CollectedArticleWithAnalysis | null
  onClose: () => void
  onChanged: () => void
  /** Report the id currently being analyzed (null when idle) so the grid can
   *  badge that card. */
  onAnalyzingChange?: (id: string | null) => void
}): React.JSX.Element {
  const queryClient = useQueryClient()
  const [phase, setPhase] = useState<Phase>('idle')
  const [streamText, setStreamText] = useState('')
  const [error, setError] = useState<string | null>(null)
  // Summary surfaced in the reading area: the cached summary from the article
  // object until a fresh analysis completes, then the freshly streamed summary.
  const [liveSummary, setLiveSummary] = useState<ArticleSummary | null>(null)
  const [detailTab, setDetailTab] = useState<DetailTab>('analysis')

  // Reset all in-flight/streamed state when the user switches article cards.
  useEffect(() => {
    setPhase('idle')
    setStreamText('')
    setError(null)
    setLiveSummary(null)
    setDetailTab('analysis')
  }, [article?.id])

  // Subscribe to analysis stream events once per article; events for other ids are ignored.
  useEffect(() => {
    return window.swarm.subscribeEvents((e: UIEvent) => {
      if (!article) return
      if (e.kind === 'article.analysisDelta' && e.articleId === article.id) {
        setStreamText((prev) => prev + e.text)
        setPhase('streaming')
      } else if (e.kind === 'article.analysisComplete' && e.articleId === article.id) {
        setLiveSummary(e.summary)
        setStreamText('')
        setPhase('done')
        void queryClient.invalidateQueries({ queryKey: ['articles', 'list'] })
      } else if (e.kind === 'article.analysisError' && e.articleId === article.id) {
        setError(e.error)
        setPhase('error')
      }
    })
  }, [article?.id, queryClient])

  // Surface the in-flight id to the grid so it can badge the matching card;
  // clear it when idle or when the panel unmounts.
  useEffect(() => {
    onAnalyzingChange?.(phase === 'streaming' && article ? article.id : null)
    return () => onAnalyzingChange?.(null)
  }, [phase, article?.id, onAnalyzingChange])

  const cachedSummary = article?.summary ?? null
  const summary = liveSummary ?? cachedSummary

  async function handleAnalyze(): Promise<void> {
    if (!article) return
    setError(null)
    setStreamText('')
    setLiveSummary(null)
    setPhase('streaming')
    setDetailTab('analysis')
    const res = await swarmApi.articleAnalyze(article.id)
    if (!res.ok) {
      setError(res.message)
      setPhase('error')
    }
  }

  async function handleDelete(): Promise<void> {
    if (!article) return
    await swarmApi.articleDelete(article.id)
    onChanged()
  }

  return (
    <aside className="flex w-[472px] shrink-0 flex-col border-border/60 border-l bg-background">
      {article ? (
        <div className="flex h-full flex-col">
          <div className="flex items-start justify-between gap-2 border-border/60 border-b p-4">
            <div className="min-w-0">
              <h2 className="truncate font-semibold text-foreground">{article.title}</h2>
              <p className="truncate text-muted-foreground text-xs">
                {article.siteName ?? new URL(article.url).hostname}
              </p>
              {error ? <p className="mt-1 text-destructive text-xs">{error}</p> : null}
            </div>
            <Button aria-label="关闭详情" onClick={onClose} size="icon-sm" variant="ghost">
              <X className="size-4" />
            </Button>
          </div>
          <div className="flex min-h-0 flex-1 flex-col md:flex-row">
            {/* Left column: metadata + actions. */}
            <aside className="flex shrink-0 flex-col gap-3 overflow-y-auto border-border p-4 pb-6 md:w-80 md:border-r">
              <p className="whitespace-pre-wrap text-[13px] text-foreground/80 leading-6">
                {article.excerpt || '无摘要'}
              </p>
              <div className="flex flex-col gap-2 pt-1">
                <Button disabled={phase === 'streaming'} onClick={() => void handleAnalyze()}>
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
                <Button onClick={() => void handleDelete()} variant="destructive">
                  <Trash2 /> 删除
                </Button>
              </div>
            </aside>
            {/* Right column: switchable reading area for the analysis and the raw text. */}
            <div className="flex min-h-0 min-w-0 flex-1 flex-col">
              <div className="flex items-center gap-1 border-border border-b p-2">
                <Button
                  data-active={detailTab === 'analysis' || undefined}
                  onClick={() => setDetailTab('analysis')}
                  size="sm"
                  variant={detailTab === 'analysis' ? 'secondary' : 'ghost'}
                >
                  AI 解析
                </Button>
                <Button
                  data-active={detailTab === 'text' || undefined}
                  onClick={() => setDetailTab('text')}
                  size="sm"
                  variant={detailTab === 'text' ? 'secondary' : 'ghost'}
                >
                  原文
                </Button>
              </div>
              <ScrollArea className="min-h-0 flex-1">
                <div className="p-4">
                  {detailTab === 'analysis' ? (
                    phase === 'streaming' ? (
                      streamText ? (
                        <div className="mx-auto max-w-3xl text-[15px] text-foreground/85 leading-7">
                          <Streamdown>{streamText}</Streamdown>
                        </div>
                      ) : (
                        <AnalyzingPlaceholder />
                      )
                    ) : summary ? (
                      <SummaryView summary={summary} />
                    ) : phase === 'error' ? (
                      <p className="text-destructive text-sm">{error}</p>
                    ) : (
                      <p className="text-center text-muted-foreground text-sm">点击「AI 分析」生成结构化摘要。</p>
                    )
                  ) : (
                    <Streamdown>{article.contentMarkdown}</Streamdown>
                  )}
                </div>
              </ScrollArea>
            </div>
          </div>
        </div>
      ) : (
        <div className="flex h-full flex-col items-center justify-center gap-2 p-8 text-center">
          <Sparkles className="size-7 text-muted-foreground/40" />
          <p className="text-muted-foreground text-sm">选择一篇文章查看 AI 解析</p>
        </div>
      )}
    </aside>
  )
}
