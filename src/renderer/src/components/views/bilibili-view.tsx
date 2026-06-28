// Shows the user's Bilibili favorites folders and watch-later list. A top tab
// switches between the two; in favorites mode a dropdown filters to a single
// folder. Clicking a video opens a read-only detail panel (no external nav).
// Prompts for login when logged out.
import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import type { BiliListResult, BiliSummary, BiliVideo } from '@shared/types/bilibili'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'

import { Button } from '@/components/ui/button'
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select'
import { Sheet, SheetContent, SheetDescription, SheetHeader, SheetTitle } from '@/components/ui/sheet'
import { Tabs, TabsList, TabsTrigger } from '@/components/ui/tabs'
import { VirtualList } from '@/components/ui/virtual-list'
import { swarmApi } from '@/lib/api'

// Grid metrics — kept in sync with the inline grid template below. MIN_CARD is
// the 11rem min column width the layout used before virtualization; GAP is the
// gap-3 (0.75rem) gutter.
const MIN_CARD_PX = 176
const GAP_PX = 12

// Top-level view: the favorites folders, or the watch-later list.
type Tab = 'favorites' | 'watch-later'
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

function chunk<T>(items: T[], size: number): T[][] {
  const rows: T[][] = []
  for (let i = 0; i < items.length; i += size) rows.push(items.slice(i, i + size))
  return rows
}

function formatDuration(sec: number): string {
  const m = Math.floor(sec / 60)
  const s = Math.floor(sec % 60)
  return `${m}:${s.toString().padStart(2, '0')}`
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
  onClick,
}: {
  video: BiliVideo
  selected: boolean
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
      {video.cover ? (
        <img
          alt=""
          className="aspect-video w-full rounded object-cover"
          referrerPolicy="no-referrer"
          src={video.cover}
        />
      ) : null}
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
    <div className="flex flex-col gap-3 text-sm">
      <p className="text-foreground/90">{summary.gist}</p>
      {sections
        .filter(({ items }) => items.length > 0)
        .map(({ label, items }) => (
          <div key={label}>
            <p className="mb-1 font-medium text-foreground/70 text-xs">{label}</p>
            <ul className="list-disc pl-4 text-foreground/80">
              {items.map((item, i) => (
                <li key={`${label}-${i}`}>{item}</li>
              ))}
            </ul>
          </div>
        ))}
    </div>
  )
}

function VideoDetailSheet({ video, onClose }: { video: BiliVideo | null; onClose: () => void }): React.JSX.Element {
  const mutation = useMutation({ mutationFn: (bvid: string) => swarmApi.bilibiliProcess(bvid) })
  const transcribeMutation = useMutation({ mutationFn: (bvid: string) => swarmApi.bilibiliTranscribe(bvid) })
  const saveMutation = useMutation({
    mutationFn: (args: { video: BiliVideo; summary: BiliSummary }) => swarmApi.bilibiliSave(args.video, args.summary),
  })
  const [stage, setStage] = useState<string | null>(null)

  // Reset mutations and stage when the user switches to a different video card.
  useEffect(() => {
    mutation.reset()
    transcribeMutation.reset()
    saveMutation.reset()
    setStage(null)
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

  // Summary can come from the subtitle path or the local-transcription path.
  const summary = mutation.data?.ok
    ? mutation.data.summary
    : transcribeMutation.data?.ok
      ? transcribeMutation.data.summary
      : null

  return (
    <Sheet onOpenChange={(open) => !open && onClose()} open={video !== null}>
      <SheetContent className="w-full gap-0 sm:max-w-md">
        {video ? (
          <>
            <SheetHeader>
              <SheetTitle>{video.title}</SheetTitle>
              <SheetDescription>
                {video.author} · {formatDuration(video.durationSec)}
              </SheetDescription>
            </SheetHeader>
            <div className="flex flex-col gap-4 overflow-y-auto px-4 pb-4">
              {video.cover ? (
                <img
                  alt=""
                  className="aspect-video w-full rounded object-cover"
                  referrerPolicy="no-referrer"
                  src={video.cover}
                />
              ) : null}
              {video.intro ? (
                <p className="whitespace-pre-wrap text-foreground/80 text-sm">{video.intro}</p>
              ) : (
                <p className="text-muted-foreground text-sm">无简介</p>
              )}
              <div className="text-muted-foreground text-xs">来源：{video.source}</div>
              <div className="flex gap-2">
                <Button disabled={mutation.isPending} onClick={() => mutation.mutate(video.bvid)}>
                  {mutation.isPending ? '分析中…' : 'AI 分析'}
                </Button>
                {/* Opens the video in the local Bilibili app (bilipc:), falling back to the browser. */}
                <Button onClick={() => void swarmApi.bilibiliOpen(video.bvid)} variant="outline">
                  观看
                </Button>
              </div>
              {summary ? (
                <>
                  <SummaryView summary={summary} />
                  <div className="flex flex-col gap-1">
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
                </>
              ) : null}
              {/* No subtitle: offer local transcription instead of a dead-end error. */}
              {!summary && mutation.data && !mutation.data.ok && mutation.data.code === 'no_subtitle' ? (
                <div className="flex flex-col gap-1">
                  <Button
                    className="w-fit"
                    disabled={transcribeMutation.isPending}
                    onClick={() => video && transcribeMutation.mutate(video.bvid)}
                    variant="outline"
                  >
                    {transcribeMutation.isPending ? `转写中…${stage ? ` (${stage})` : ''}` : '本地转写'}
                  </Button>
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
            </div>
          </>
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
          <VirtualList
            className="h-full"
            estimateSize={170}
            gap={12}
            getKey={(row) => row.key}
            items={rows}
            renderItem={(row) =>
              row.kind === 'header' ? (
                <h2 className="pt-2 font-medium text-foreground/80 text-sm">{row.title}</h2>
              ) : (
                <div className="grid gap-3" style={{ gridTemplateColumns: `repeat(${columns}, minmax(0, 1fr))` }}>
                  {row.videos.map((v) => (
                    <VideoCard key={v.bvid} onClick={setSelected} selected={selected?.bvid === v.bvid} video={v} />
                  ))}
                </div>
              )
            }
          />
        </div>
      )}

      <VideoDetailSheet onClose={() => setSelected(null)} video={selected} />
    </div>
  )
}
