// Shows the collected articles as a responsive card grid. Clicking a card opens
// the always-mounted detail panel (AI analysis + raw markdown). A top stat pill
// reports how many articles already have an AI summary.
import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import type { CollectedArticleWithAnalysis, UIEvent } from '@swarm/protocol'
import { useQuery, useQueryClient } from '@tanstack/react-query'
import { ChevronLeft, Loader2, Sparkles } from 'lucide-react'

import { ScrollArea } from '@/components/ui/scroll-area'
import { swarmApi } from '@/lib/api'
import { formatRelativeTime } from '@/lib/format-time'
import { colorForSite } from './article-colors'
import { ArticleDetailPanel } from './article-detail-panel'

// Grid metrics — kept in sync with the inline grid template below. Same min
// width / gap as the Bilibili grid so the two views share column cadence.
const MIN_CARD_PX = 176
const GAP_PX = 12

function columnsForWidth(width: number): number {
  if (width <= 0) return 1
  return Math.max(1, Math.floor((width + GAP_PX) / (MIN_CARD_PX + GAP_PX)))
}

function ArticleCard({
  article,
  selected,
  analyzing,
  onClick,
}: {
  article: CollectedArticleWithAnalysis
  selected: boolean
  analyzing: boolean
  onClick: (a: CollectedArticleWithAnalysis) => void
}): React.JSX.Element {
  const site = article.siteName ?? hostnameOf(article.url)
  const favicon = `https://www.google.com/s2/favicons?domain=${encodeURIComponent(hostnameOf(article.url))}&sz=64`
  return (
    <div
      className={`group relative flex flex-col gap-1 rounded-md border p-2 transition-colors hover:bg-sidebar-accent ${
        selected ? 'border-ring ring-2 ring-ring/50' : 'border-sidebar-border'
      }`}
      onClick={() => onClick(article)}
    >
      <div className="relative w-full">
        {/* 16:9 site-color block with the site initial as a placeholder cover. */}
        <div
          className={`flex aspect-video w-full items-center justify-center rounded font-semibold text-2xl ${colorForSite(article.siteName)}`}
        >
          {(article.siteName ?? hostnameOf(article.url)).slice(0, 1).toUpperCase()}
        </div>
        {/* Favicon overlay bottom-left so the AI badge stays clear top-right. */}
        <img
          alt=""
          className="absolute bottom-1 left-1 size-4 rounded-sm bg-background/80 object-contain"
          referrerPolicy="no-referrer"
          src={favicon}
        />
        {analyzing ? (
          <span className="absolute top-1 right-1 flex items-center gap-1 rounded bg-violet-600/90 px-1.5 py-0.5 font-semibold text-[10px] text-white">
            <Loader2 className="size-2.5 animate-spin" /> 分析中
          </span>
        ) : article.summary ? (
          <span className="absolute top-1 right-1 rounded bg-primary px-1.5 py-0.5 font-medium text-[10px] text-primary-foreground">
            AI
          </span>
        ) : null}
      </div>
      <div className="line-clamp-2 font-medium text-foreground text-sm leading-snug">{article.title}</div>
      <div className="truncate text-muted-foreground text-xs">
        {site} · {formatRelativeTime(Date.parse(article.collectedAt), Date.now())}
      </div>
    </div>
  )
}

function hostnameOf(url: string): string {
  try {
    return new URL(url).hostname
  } catch {
    return url
  }
}

export function ArticleView(): React.JSX.Element {
  const queryClient = useQueryClient()
  const listQuery = useQuery({
    queryKey: ['articles', 'list'],
    queryFn: () => swarmApi.articleList(),
  })
  const articles = listQuery.data ?? []

  // Articles arrive from an EXTERNAL source (the browser extension pushes over
  // WS), so the list query has no way to know it went stale. The service
  // broadcasts `articles.changed` on every store mutation (add/saveAnalysis/
  // delete); subscribe here and refetch. Mirrors formations-view's
  // agents.changed → invalidate pattern.
  useEffect(() => {
    return window.swarm.subscribeEvents((e: UIEvent) => {
      if (e.kind === 'articles.changed') void queryClient.invalidateQueries({ queryKey: ['articles', 'list'] })
    })
  }, [queryClient])
  const analyzedCount = useMemo(() => articles.filter((a) => a.summary != null).length, [articles])
  const totalCount = articles.length

  const [selected, setSelected] = useState<CollectedArticleWithAnalysis | null>(null)
  // Collapsed detail: keep `selected` (card stays highlighted) but swap the panel
  // for a thin re-expand strip. Mirrors the design doc's art-closed state.
  const [collapsed, setCollapsed] = useState(false)
  // The id of the article the detail panel is currently analyzing, so its grid
  // card can show a loading badge. Reported up by ArticleDetailPanel.
  const [analyzingId, setAnalyzingId] = useState<string | null>(null)

  const handleSelect = useCallback((a: CollectedArticleWithAnalysis) => {
    setSelected(a)
    setCollapsed(false)
  }, [])

  // Track the content width so the grid can reflow columns responsively. A
  // callback ref (not an effect) wires the observer: the measured node only
  // mounts once data loads, after a mount-time effect would already have run
  // against a null ref and left the column count stuck at 1.
  const observerRef = useRef<ResizeObserver | null>(null)
  const [columns, setColumns] = useState(1)
  const measureRef = useCallback((node: HTMLDivElement | null) => {
    observerRef.current?.disconnect()
    if (!node) return
    const update = (): void => setColumns(columnsForWidth(node.clientWidth))
    update()
    observerRef.current = new ResizeObserver(update)
    observerRef.current.observe(node)
  }, [])

  return (
    <div className="flex h-full w-full flex-col">
      {/* Toolbar — full-bleed with a bottom divider (matches Bilibili). */}
      <div className="flex flex-none flex-wrap items-center gap-3 border-border/70 border-b px-5 py-3">
        <h1 className="font-semibold text-foreground">文章收集</h1>
        {totalCount > 0 ? (
          <span className="ml-auto inline-flex items-center gap-1.5 rounded-full border border-violet-500/20 bg-linear-to-br from-violet-500/10 to-primary/10 px-3 py-1 text-xs">
            <Sparkles className="size-3 text-violet-500" />
            <span className="font-semibold text-violet-700 dark:text-violet-300">
              AI 已解析 <span className="tabular-nums">{analyzedCount}</span> /{' '}
              <span className="tabular-nums">{totalCount}</span>
            </span>
          </span>
        ) : null}
      </div>

      {/* Body: grid + (only when an article is picked) the detail panel. Mounting
          the panel on-demand lets it collapse and gives the grid full width. */}
      <div className="flex min-h-0 flex-1">
        <div className="flex min-h-0 flex-1 flex-col">
          {listQuery.isError ? (
            <div className="flex flex-col items-center gap-3 py-12 text-muted-foreground">
              <p>加载失败</p>
              <button className="text-primary text-sm underline" onClick={() => void listQuery.refetch()} type="button">
                重试
              </button>
            </div>
          ) : listQuery.isPending ? (
            <div className="py-12 text-center text-muted-foreground">加载中…</div>
          ) : totalCount === 0 ? (
            <div className="mx-auto flex flex-col items-center justify-center gap-2 py-12 text-center text-muted-foreground">
              <span className="text-4xl">📰</span>
              <p className="text-sm">还没有收集的文章</p>
              <p className="text-xs">安装浏览器插件，开始收集你读到的文章</p>
            </div>
          ) : (
            <ScrollArea className="h-full">
              {/* measureRef tracks the padded grid width to derive the column count. */}
              <div className="p-5" ref={measureRef}>
                <div className="grid gap-3" style={{ gridTemplateColumns: `repeat(${columns}, minmax(0, 1fr))` }}>
                  {articles.map((a) => (
                    <ArticleCard
                      analyzing={analyzingId === a.id}
                      article={a}
                      key={a.id}
                      onClick={handleSelect}
                      selected={selected?.id === a.id}
                    />
                  ))}
                </div>
              </div>
            </ScrollArea>
          )}
        </div>
        {selected && !collapsed ? (
          <ArticleDetailPanel
            article={selected}
            onAnalyzingChange={setAnalyzingId}
            onChanged={() => setSelected(null)}
            onClose={() => setCollapsed(true)}
          />
        ) : selected && collapsed ? (
          <button
            aria-label="展开 AI 解析"
            className="flex w-10 shrink-0 flex-col items-center gap-3 border-border/60 border-l bg-background pt-4 text-muted-foreground hover:text-foreground"
            onClick={() => setCollapsed(false)}
            type="button"
          >
            <ChevronLeft className="size-4" />
            <span className="font-semibold text-[11px] tracking-wide [writing-mode:vertical-rl]">AI 解析</span>
          </button>
        ) : null}
      </div>
    </div>
  )
}
