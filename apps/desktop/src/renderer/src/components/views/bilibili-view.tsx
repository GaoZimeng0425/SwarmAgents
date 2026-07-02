// Shows the user's Bilibili favorites folders and watch-later list. A top tab
// switches between the two; in favorites mode a dropdown filters to a single
// folder. Clicking a video opens a read-only detail panel (no external nav).
// Prompts for login when logged out.
import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import type { BiliListResult, BiliSummary, BiliVideo } from '@swarm/protocol'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { chunk, compact } from 'es-toolkit'

import { Button } from '@swarm/ui'
import { ScrollArea } from '@/components/ui/scroll-area'
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@swarm/ui'
import { Sheet, SheetContent, SheetDescription, SheetHeader, SheetTitle } from '@swarm/ui'
import { Tabs, TabsList, TabsTrigger } from '@swarm/ui'
import { swarmApi } from '@/lib/api'
import { TranscribeProgress } from './transcribe-progress'

// Grid metrics — kept in sync with the inline grid template below. MIN_CARD is
// the 11rem min column width the layout used before virtualization; GAP is the
// gap-3 (0.75rem) gutter.
const MIN_CARD_PX = 176
const GAP_PX = 12

// Top-level view: the favorites folders, or the watch-later list.
type Tab = 'favorites' | 'watch-later'
type DetailTab = 'analysis' | 'text'
// Favorites filter: a specific folder id, or every folder.
type FolderFilter = number | 'all'

// A flattened row in the virtualized list: either a section heading or one row
// of video cards. Chunking videos into fixed-width rows lets a single vertical
// virtualizer drive the whole grid, so off-screen cards (and their <img>s) stay
// unmounted regardless of how large a favorites folder is.
type GridRow = { kind: 'header'; key: string; title: string } | { kind: 'grid'; key: string; videos: BiliVideo[] }

function columnsForWidth(width: number): number {
  if (width <= 0) return 1
  return Math.max(1, Math.floor((width + GAP_PX) / (MIN_CARD_PX + GAP_PX)))
}

function formatDuration(sec: number): string {
  const m = Math.floor(sec / 60)
  const s = Math.floor(sec % 60)
  return `${m}:${s.toString().padStart(2, '0')}`
}

function splitTextBlocks(text: string): string[] {
  return compact(text.split(/\n{2,}/).map((block) => block.trim()))
}

// Pure list builder so the tab/folder selection logic is unit-testable without
// a DOM. In 'watch-later' the folder filter is ignored and no headers render
// (the tab already names the section); in 'favorites' a numeric folderId limits
// the output to that one folder.
export function buildRows(data: BiliListResult, tab: Tab, folderId: FolderFilter, columns: number): GridRow[] {
  const rows: GridRow[] = []
  if (tab === 'watch-later') {
    chunk(data.watchLater, columns).forEach((group, i) => {
      rows.push({ kind: 'grid', key: `grid:watch-later:${i}`, videos: group })
    })
    return rows
  }
  const folders = folderId === 'all' ? data.folders : data.folders.filter((f) => f.folder.id === folderId)
  for (const { folder, videos } of folders) {
    rows.push({ kind: 'header', key: `header:${folder.id}`, title: folder.title })
    chunk(videos, columns).forEach((group, i) => {
      rows.push({ kind: 'grid', key: `grid:${folder.id}:${i}`, videos: group })
    })
  }
  return rows
}

function VideoCard({
  video,
  selected,
  analyzed,
  onClick,
}: {
  video: BiliVideo
  selected: boolean
  analyzed: boolean
  onClick: (v: BiliVideo) => void
}): React.JSX.Element {
  return (
    <button
      className={`flex flex-col gap-1 rounded-md border p-2 text-left transition-colors hover:bg-sidebar-accent ${
        selected ? 'border-ring ring-2 ring-ring/50' : 'border-sidebar-border'
      }`}
      onClick={() => onClick(video)}
      type="button"
    >
      <div className="relative w-full">
        {video.cover ? (
          <img
            alt=""
            className="aspect-video w-full rounded object-cover"
            referrerPolicy="no-referrer"
            src={video.cover}
          />
        ) : null}
        {analyzed ? (
          <span className="absolute top-1 right-1 rounded bg-primary px-1.5 py-0.5 font-medium text-[10px] text-primary-foreground">
            AI
          </span>
        ) : null}
      </div>
      <div className="truncate font-medium text-foreground text-sm">{video.title}</div>
      <div className="truncate text-muted-foreground text-xs">{video.author}</div>
    </button>
  )
}

// Renders a structured BiliSummary: gist + non-empty labelled sections.
function SummaryView({ summary }: { summary: BiliSummary }): React.JSX.Element {
  const sections: { label: string; items: string[] }[] = [
    { label: '核心要点', items: summary.points },
    { label: '可复用经验', items: summary.experience },
    { label: '踩坑注意', items: summary.pitfalls },
    { label: '可执行步骤', items: summary.steps },
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

function FullTextView({ label, text }: { label: string; text: string }): React.JSX.Element {
  const blocks = splitTextBlocks(text)
  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <div className="mb-4 flex items-center justify-between">
        <p className="font-medium text-foreground text-sm">{label}</p>
        <span className="text-muted-foreground text-xs">{text.length.toLocaleString()} 字符</span>
      </div>
      <div className="mx-auto flex max-w-3xl flex-col gap-4 pb-6 text-[15px] text-foreground/85 leading-7">
        {blocks.length > 0 ? (
          blocks.map((block, i) => (
            <p className="whitespace-pre-wrap" key={i}>
              {block}
            </p>
          ))
        ) : (
          <p className="whitespace-pre-wrap">{text}</p>
        )}
      </div>
    </div>
  )
}

function VideoDetailSheet({ video, onClose }: { video: BiliVideo | null; onClose: () => void }): React.JSX.Element {
  const queryClient = useQueryClient()
  const invalidateAnalysis = (): void => {
    void queryClient.invalidateQueries({ queryKey: ['bilibili', 'analyzedBvids'] })
    if (video) void queryClient.invalidateQueries({ queryKey: ['bilibili', 'analysis', video.bvid] })
  }
  const mutation = useMutation({
    mutationFn: (bvid: string) => swarmApi.bilibiliProcess(bvid),
    onSuccess: invalidateAnalysis,
  })
  const transcribeMutation = useMutation({
    mutationFn: (bvid: string) => swarmApi.bilibiliTranscribe(bvid),
    onSuccess: invalidateAnalysis,
  })
  const saveMutation = useMutation({
    mutationFn: (args: { video: BiliVideo; summary: BiliSummary }) => swarmApi.bilibiliSave(args.video, args.summary),
  })
  const [stage, setStage] = useState<string | null>(null)
  const [detailTab, setDetailTab] = useState<DetailTab>('analysis')

  // Cached analysis for this video, if it has been analyzed before.
  const analysisQuery = useQuery({
    queryKey: ['bilibili', 'analysis', video?.bvid],
    queryFn: () => (video ? swarmApi.bilibiliGetAnalysis(video.bvid) : Promise.resolve(null)),
    enabled: video !== null,
  })

  // Reset mutations, stage, and the text toggle when the user switches video cards.
  useEffect(() => {
    mutation.reset()
    transcribeMutation.reset()
    saveMutation.reset()
    setStage(null)
    setDetailTab('analysis')
    // We intentionally omit the mutation objects from deps — we only want to reset on bvid change.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [video?.bvid])

  // Subscribe to transcription progress only while this sheet is mounted; show the
  // current stage on the in-flight button.
  useEffect(() => {
    const off = swarmApi.bilibiliOnTranscribeProgress((p) => {
      if (p.bvid === video?.bvid) setStage(p.stage)
    })
    return off
  }, [video?.bvid])

  // Summary/full-text can come from a fresh subtitle run, a fresh transcription, or
  // the cached analysis loaded on open.
  const cached = analysisQuery.data ?? null
  const summary = mutation.data?.ok
    ? mutation.data.summary
    : transcribeMutation.data?.ok
      ? transcribeMutation.data.summary
      : (cached?.summary ?? null)
  const fullText = mutation.data?.ok
    ? { text: mutation.data.text, source: mutation.data.source }
    : transcribeMutation.data?.ok
      ? { text: transcribeMutation.data.text, source: transcribeMutation.data.source }
      : cached
        ? { text: cached.text, source: cached.source }
        : null

  useEffect(() => {
    if (!summary && fullText) setDetailTab('text')
  }, [fullText, summary])

  const textLabel = fullText?.source === 'subtitle' ? '字幕原文' : '转写全文'

  return (
    <Sheet onOpenChange={(open) => !open && onClose()} open={video !== null}>
      <SheetContent className="w-full gap-0 data-[side=right]:sm:max-w-5xl">
        {video ? (
          <div className="flex h-full flex-col">
            <SheetHeader>
              <SheetTitle className="pr-8">{video.title}</SheetTitle>
              <SheetDescription>
                {video.author} · {formatDuration(video.durationSec)}
              </SheetDescription>
            </SheetHeader>
            <div className="flex min-h-0 flex-1 flex-col md:flex-row">
              {/* Left column: video metadata + actions. */}
              <aside className="flex shrink-0 flex-col gap-3 overflow-y-auto border-border p-4 pb-6 md:w-80 md:border-r">
                {video.cover ? (
                  <img
                    alt=""
                    className="aspect-video w-full rounded-md border border-border object-cover"
                    referrerPolicy="no-referrer"
                    src={video.cover}
                  />
                ) : null}
                {video.intro ? (
                  <p className="whitespace-pre-wrap text-[13px] text-foreground/80 leading-6">{video.intro}</p>
                ) : (
                  <p className="text-muted-foreground text-sm">无简介</p>
                )}
                <div className="text-muted-foreground text-xs">来源：{video.source}</div>
                <div className="flex flex-col gap-2 pt-1">
                  <Button disabled={mutation.isPending} onClick={() => mutation.mutate(video.bvid)}>
                    {mutation.isPending ? '分析中…' : cached ? '重新分析' : 'AI 分析'}
                  </Button>
                  {/* Opens the video in the local Bilibili app (bilipc:), falling back to the browser. */}
                  <Button onClick={() => void swarmApi.bilibiliOpen(video.bvid)} variant="outline">
                    观看
                  </Button>
                </div>
                {/* No subtitle: offer local transcription instead of a dead-end error. */}
                {!summary && mutation.data && !mutation.data.ok && mutation.data.code === 'no_subtitle' ? (
                  <div className="flex flex-col gap-2 border-border border-t pt-3">
                    <Button
                      className="w-fit"
                      disabled={transcribeMutation.isPending}
                      onClick={() => video && transcribeMutation.mutate(video.bvid)}
                      variant="outline"
                    >
                      {transcribeMutation.isPending ? '转写中…' : '本地转写'}
                    </Button>
                    {transcribeMutation.isPending ? <TranscribeProgress stage={stage} /> : null}
                    <span className="text-muted-foreground text-xs">
                      该视频没有字幕，可下载音轨本地转写（需在设置中配置 ffmpeg 与模型）。
                    </span>
                    {transcribeMutation.data && !transcribeMutation.data.ok ? (
                      <span className="text-destructive text-xs">{transcribeMutation.data.message}</span>
                    ) : null}
                  </div>
                ) : null}
                {!summary && mutation.data && !mutation.data.ok && mutation.data.code !== 'no_subtitle' ? (
                  <p className="text-destructive text-sm">{mutation.data.message}</p>
                ) : null}
                {summary ? (
                  <div className="mt-auto flex flex-col gap-1 border-border border-t pt-3">
                    <Button
                      className="w-fit"
                      disabled={saveMutation.isPending}
                      onClick={() => video && saveMutation.mutate({ video, summary })}
                      variant="outline"
                    >
                      {saveMutation.isPending ? '保存中…' : '保存到 Obsidian'}
                    </Button>
                    {saveMutation.data?.ok ? (
                      <span className="text-muted-foreground text-xs">已保存到 {saveMutation.data.path}</span>
                    ) : null}
                    {saveMutation.data && !saveMutation.data.ok ? (
                      <span className="text-destructive text-xs">{saveMutation.data.message}</span>
                    ) : null}
                  </div>
                ) : null}
              </aside>
              {/* Right column: switchable reading area for the analysis and the raw text. */}
              <div className="flex min-h-0 min-w-0 flex-1 flex-col">
                {summary || fullText ? (
                  <div className="flex items-center gap-1 border-border border-b p-2">
                    {summary ? (
                      <Button
                        data-active={detailTab === 'analysis' || undefined}
                        onClick={() => setDetailTab('analysis')}
                        size="sm"
                        variant={detailTab === 'analysis' ? 'secondary' : 'ghost'}
                      >
                        AI 解析
                      </Button>
                    ) : null}
                    {fullText ? (
                      <Button
                        data-active={detailTab === 'text' || undefined}
                        onClick={() => setDetailTab('text')}
                        size="sm"
                        variant={detailTab === 'text' ? 'secondary' : 'ghost'}
                      >
                        {textLabel}
                      </Button>
                    ) : null}
                  </div>
                ) : null}
                <div className="min-h-0 flex-1 overflow-y-auto p-4">
                  {/* Only one view is mounted at a time so each gets the full reading height. */}
                  {detailTab === 'analysis' && summary ? (
                    <SummaryView summary={summary} />
                  ) : detailTab === 'text' && fullText ? (
                    <FullTextView label={textLabel} text={fullText.text} />
                  ) : (
                    <p className="text-center text-muted-foreground text-sm">点击「AI 分析」生成结构化摘要。</p>
                  )}
                </div>
              </div>
            </div>
          </div>
        ) : null}
      </SheetContent>
    </Sheet>
  )
}

export function BilibiliView(): React.JSX.Element {
  const queryClient = useQueryClient()
  const statusQuery = useQuery({
    queryKey: ['bilibili', 'status'],
    queryFn: () => swarmApi.getBilibiliStatus(),
  })
  const loggedIn = statusQuery.data?.loggedIn ?? false
  const listQuery = useQuery({
    queryKey: ['bilibili', 'list'],
    queryFn: () => swarmApi.getBilibiliList(),
    enabled: loggedIn,
  })
  const analyzedQuery = useQuery({
    queryKey: ['bilibili', 'analyzedBvids'],
    queryFn: () => swarmApi.bilibiliAnalyzedBvids(),
  })
  const analyzedSet = useMemo(() => new Set(analyzedQuery.data ?? []), [analyzedQuery.data])

  const [tab, setTab] = useState<Tab>('favorites')
  const [folderId, setFolderId] = useState<FolderFilter>('all')
  const [selected, setSelected] = useState<BiliVideo | null>(null)

  // Track the content width so the grid can be chunked into fixed-column rows
  // that match a responsive `auto-fill` layout. A callback ref (not an effect)
  // wires the observer: the measured node only mounts once data loads, after a
  // mount-time effect would already have run against a null ref and left the
  // column count stuck at 1 (rendering the grid as a single column).
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

  const rows = useMemo(() => {
    if (!listQuery.data) return []
    return buildRows(listQuery.data, tab, folderId, columns)
  }, [listQuery.data, tab, folderId, columns])

  async function handleLogin(): Promise<void> {
    await swarmApi.bilibiliLogin()
    await queryClient.invalidateQueries({ queryKey: ['bilibili'] })
  }

  if (statusQuery.isPending) {
    return <div className="py-12 text-center text-muted-foreground">加载中…</div>
  }

  if (!loggedIn) {
    return (
      <div className="mx-auto flex h-full w-full flex-col items-center justify-center gap-4 p-4">
        <p className="text-muted-foreground">未登录 Bilibili</p>
        <Button onClick={() => void handleLogin()}>登录 Bilibili</Button>
      </div>
    )
  }

  const folders = listQuery.data?.folders ?? []

  return (
    <div className="mx-auto flex h-full w-full flex-col gap-4 p-4">
      <div className="flex flex-wrap items-center gap-3">
        <Tabs onValueChange={(v) => setTab(v as Tab)} value={tab}>
          <TabsList>
            <TabsTrigger value="favorites">收藏夹</TabsTrigger>
            <TabsTrigger value="watch-later">稍后再看</TabsTrigger>
          </TabsList>
        </Tabs>

        {tab === 'favorites' ? (
          <Select
            onValueChange={(v) => setFolderId(v === 'all' ? 'all' : Number(v))}
            value={folderId === 'all' ? 'all' : String(folderId)}
          >
            <SelectTrigger className="w-48">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="all">全部收藏夹</SelectItem>
              {folders.map(({ folder }) => (
                <SelectItem key={folder.id} value={String(folder.id)}>
                  {folder.title} ({folder.count})
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        ) : null}

        <span className="ml-auto text-muted-foreground text-sm">{statusQuery.data?.uname ?? ''}</span>
      </div>

      {listQuery.isError ? (
        <div className="flex flex-col items-center gap-3 py-12 text-muted-foreground">
          <p>加载失败</p>
          <Button onClick={() => void listQuery.refetch()} variant="outline">
            重试
          </Button>
        </div>
      ) : listQuery.isPending ? (
        <div className="py-12 text-center text-muted-foreground">加载中…</div>
      ) : (
        // measureRef tracks the available content width to derive the column count.
        <div className="min-h-0 flex-1" ref={measureRef}>
          <ScrollArea className="h-full">
            <div className="flex flex-col gap-3">
              {rows.map((row) =>
                row.kind === 'header' ? (
                  <h2 className="pt-2 font-medium text-foreground/80 text-sm" key={row.key}>
                    {row.title}
                  </h2>
                ) : (
                  <div
                    className="grid gap-3"
                    key={row.key}
                    style={{ gridTemplateColumns: `repeat(${columns}, minmax(0, 1fr))` }}
                  >
                    {row.videos.map((v) => (
                      <VideoCard
                        analyzed={analyzedSet.has(v.bvid)}
                        key={v.bvid}
                        onClick={setSelected}
                        selected={selected?.bvid === v.bvid}
                        video={v}
                      />
                    ))}
                  </div>
                )
              )}
            </div>
          </ScrollArea>
        </div>
      )}

      <VideoDetailSheet onClose={() => setSelected(null)} video={selected} />
    </div>
  )
}
