// Shows the user's Bilibili favorites folders and watch-later list. A top tab
// switches between the two; in favorites mode a dropdown filters to a single
// folder. Clicking a video opens a read-only detail panel (no external nav).
// Prompts for login when logged out.
import { useMemo, useState } from 'react'
import type { BiliListResult, BiliVideo } from '@swarm/protocol'
import {
  Button,
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
  Tabs,
  TabsList,
  TabsTrigger,
} from '@swarm/ui'
import { useQuery, useQueryClient } from '@tanstack/react-query'
import { Loader2, Sparkles } from 'lucide-react'

import { ScrollArea } from '@/components/ui/scroll-area'
import { swarmApi } from '@/lib/api'
import { cn } from '@/lib/utils'
import { BilibiliDetailPanel } from './bilibili-detail-panel'
import { BilibiliVideoMenu } from './bilibili-video-menu'

// Min card width for the responsive CSS grid (repeat(auto-fill, minmax(...))).
// The browser derives the column count from the container width — no JS measure.
const MIN_CARD_PX = 180

// Deterministic author-avatar color (no face in BiliVideo — the design uses a
// solid color dot too). Decorative brand-ish hex, so inline not tokens.
const AUTHOR_COLORS = ['#3478f6', '#1f9d43', '#ff9f0a', '#d0842b', '#c96442', '#5e5ce6', '#a259ff', '#5b5bd6']
function authorColor(name: string): string {
  let h = 0
  for (let i = 0; i < name.length; i++) h = (h * 31 + name.charCodeAt(i)) >>> 0
  return AUTHOR_COLORS[h % AUTHOR_COLORS.length]
}

// Which list the currently focused video came from — drives the action menu's
// labels (un-fav vs clear watch-later) and whether a B站 delete is needed.
export type VideoListContext = 'favorites' | 'watch-later' | 'archive'

// Top-level view: the favorites folders, the watch-later list, or the local
// archive (videos soft-deleted from Bilibili but kept as local cards).
type Tab = 'favorites' | 'watch-later' | 'archive'
// Favorites filter: a specific folder id, or every folder.
type FolderFilter = number | 'all'

// A section of the list: an optional folder heading plus its video cards. Each
// section renders as one native CSS grid, so the browser handles column count
// and wrapping — no chunking, no width measurement.
type GridRow = { kind: 'header'; key: string; title: string } | { kind: 'grid'; key: string; videos: BiliVideo[] }

export function formatDuration(sec: number): string {
  const m = Math.floor(sec / 60)
  const s = Math.floor(sec % 60)
  return `${m}:${s.toString().padStart(2, '0')}`
}

// Pure list builder so the tab/folder selection logic is unit-testable without
// a DOM. In 'watch-later'/'archive' the folder filter is ignored and no headers
// render (the tab already names the section); in 'favorites' a numeric folderId
// limits the output to that one folder. Pinned bvids are filtered out of the
// favorites/watch-later lists — they live in the dedicated top bar — but stay
// visible inside the archive tab.
export function buildRows(
  data: BiliListResult,
  tab: Tab,
  folderId: FolderFilter,
  archive: BiliVideo[] = [],
  pinnedSet: Set<string> = new Set()
): GridRow[] {
  const rows: GridRow[] = []
  const notPinned = (v: BiliVideo): boolean => !pinnedSet.has(v.bvid)
  if (tab === 'watch-later') {
    const videos = data.watchLater.filter(notPinned)
    // Leave rows empty when the list is — the caller shows an empty-state message.
    if (videos.length > 0) rows.push({ kind: 'grid', key: 'grid:watch-later', videos })
    return rows
  }
  if (tab === 'archive') {
    if (archive.length > 0) rows.push({ kind: 'grid', key: 'grid:archive', videos: archive })
    return rows
  }
  const folders = folderId === 'all' ? data.folders : data.folders.filter((f) => f.folder.id === folderId)
  for (const { folder, videos } of folders) {
    const visible = videos.filter(notPinned)
    if (visible.length === 0) continue
    rows.push({ kind: 'header', key: `header:${folder.id}`, title: folder.title })
    rows.push({ kind: 'grid', key: `grid:${folder.id}`, videos: visible })
  }
  return rows
}

function VideoCard({
  video,
  selected,
  analyzed,
  analyzing,
  pinned,
  context,
  onClick,
  onChanged,
  onError,
}: {
  video: BiliVideo
  selected: boolean
  analyzed: boolean
  analyzing: boolean
  pinned: boolean
  context: VideoListContext
  onClick: (v: BiliVideo) => void
  onChanged: () => void
  onError: (message: string) => void
}): React.JSX.Element {
  // In-flight mutation state reported by the "..." menu (delete/pin). The menu
  // trigger is hover-only and gets disabled-but-closed, so without this overlay
  // a "彻底删除" click shows zero feedback until the list refetches.
  const [busy, setBusy] = useState(false)

  return (
    // The card is a div (not a button) so the "..." menu trigger can sit inside
    // it without nesting interactive elements. Click anywhere selects the video.
    <div
      className={cn(
        'group relative flex flex-col gap-2 rounded-xl border p-2 text-left transition-all',
        selected
          ? 'border-blue-500 bg-secondary ring-2 ring-blue-500/25'
          : 'border-border bg-secondary hover:border-foreground/20'
      )}
      data-bvid={video.bvid}
      onClick={() => onClick(video)}
    >
      <div className="relative aspect-video w-full overflow-hidden rounded-lg bg-muted">
        {video.cover ? (
          <img alt="" className="size-full object-cover" referrerPolicy="no-referrer" src={video.cover} />
        ) : null}
        {analyzing ? (
          <span className="absolute top-1.5 left-1.5 flex items-center gap-1 rounded-md bg-violet-600/90 px-1.5 py-0.5 font-bold text-[9.5px] text-white">
            <Loader2 className="size-2.5 animate-spin" /> 分析中
          </span>
        ) : analyzed ? (
          <span className="absolute top-1.5 left-1.5 flex items-center gap-1 rounded-md bg-violet-600/90 px-1.5 py-0.5 font-bold text-[9.5px] text-white">
            <Sparkles className="size-2.5" /> AI
          </span>
        ) : null}
        {pinned ? (
          <span className="absolute bottom-1.5 left-1.5 rounded-md bg-amber-500 px-1.5 py-0.5 font-semibold text-[9.5px] text-white">
            置顶
          </span>
        ) : null}
        <span className="absolute right-1.5 bottom-1.5 rounded bg-black/60 px-1.5 py-0.5 font-mono font-semibold text-[10px] text-white tabular-nums">
          {formatDuration(video.durationSec)}
        </span>
        {busy ? (
          <span className="absolute inset-0 flex items-center justify-center bg-background/55 backdrop-blur-[1px]">
            <Loader2 className="size-5 animate-spin text-muted-foreground" />
          </span>
        ) : null}
      </div>
      {/* Hover "..." overlay: top-right over the cover (AI badge is top-left).
          stopPropagation so opening the menu doesn't also select the card. */}
      <div
        className="absolute top-2.5 right-2.5 opacity-0 transition-opacity group-hover:opacity-100"
        onClick={(e) => e.stopPropagation()}
      >
        <BilibiliVideoMenu
          context={context}
          onBusyChange={setBusy}
          onChanged={onChanged}
          onError={onError}
          pinned={pinned}
          trigger="dot"
          video={video}
        />
      </div>
      <div className="line-clamp-2 min-h-[35px] font-semibold text-[13px] text-foreground leading-snug">
        {video.title}
      </div>
      <div className="flex items-center gap-1.5">
        <span className="size-4 shrink-0 rounded-full" style={{ backgroundColor: authorColor(video.author) }} />
        <span className="truncate text-[11.5px] text-muted-foreground">{video.author}</span>
      </div>
    </div>
  )
}

// Compact card for the pinned strip: small cover + title, click to open detail,
// hover "..." for unpin/delete. context is 'archive' because a pin's lifecycle
// (unpin/remove) mirrors an archived card and it never needs a B站 un-fav action.
function PinnedCard({
  video,
  onSelect,
  onChanged,
  onError,
}: {
  video: BiliVideo
  onSelect: (v: BiliVideo) => void
  onChanged: () => void
  onError: (message: string) => void
}): React.JSX.Element {
  const [busy, setBusy] = useState(false)

  return (
    <div className="group relative flex w-44 shrink-0 flex-col gap-1 rounded-md border border-amber-500/30 bg-amber-500/5 p-1.5 hover:bg-amber-500/10">
      <div className="relative w-full" onClick={() => onSelect(video)}>
        {video.cover ? (
          <img
            alt=""
            className="aspect-video w-full rounded object-cover"
            referrerPolicy="no-referrer"
            src={video.cover}
          />
        ) : null}
        {busy ? (
          <span className="absolute inset-0 flex items-center justify-center rounded bg-background/55 backdrop-blur-[1px]">
            <Loader2 className="size-5 animate-spin text-muted-foreground" />
          </span>
        ) : null}
      </div>
      <div className="truncate text-foreground text-xs" onClick={() => onSelect(video)}>
        {video.title}
      </div>
      <div className="absolute right-0.5 bottom-0.5 opacity-0 transition-opacity group-hover:opacity-100">
        <BilibiliVideoMenu
          context="archive"
          onBusyChange={setBusy}
          onChanged={onChanged}
          onError={onError}
          pinned
          trigger="dot"
          video={video}
        />
      </div>
    </div>
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
  // Local archive + pins are always available (no login required to read them),
  // so they load independently of the B站 list.
  const archiveQuery = useQuery({
    queryKey: ['bilibili', 'archive'],
    queryFn: () => swarmApi.bilibiliArchiveList(),
  })
  const pinsQuery = useQuery({
    queryKey: ['bilibili', 'pins'],
    queryFn: () => swarmApi.bilibiliPinsList(),
  })
  const pinsSet = useMemo(() => new Set((pinsQuery.data ?? []).map((v) => v.bvid)), [pinsQuery.data])
  const totalCount = useMemo(() => {
    const favs = listQuery.data?.folders ?? []
    const inFolders = favs.reduce((n, f) => n + f.videos.length, 0)
    return inFolders + (listQuery.data?.watchLater.length ?? 0)
  }, [listQuery.data])
  const analyzedCount = analyzedSet.size

  const [tab, setTab] = useState<Tab>('favorites')
  const [folderId, setFolderId] = useState<FolderFilter>('all')
  const [selected, setSelected] = useState<BiliVideo | null>(null)
  const [cardError, setCardError] = useState<string | null>(null)
  // The bvid the detail panel is currently analyzing/transcribing, so its grid
  // card can show a loading badge. Reported up by BilibiliDetailPanel.
  const [analyzingBvid, setAnalyzingBvid] = useState<string | null>(null)

  const rows = useMemo(() => {
    // Archive tab has no B站 list dependency; render from the local archive alone.
    if (tab === 'archive') {
      return buildRows({ folders: [], watchLater: [] }, 'archive', 'all', archiveQuery.data ?? [], pinsSet)
    }
    if (!listQuery.data) return []
    return buildRows(listQuery.data, tab, folderId, archiveQuery.data ?? [], pinsSet)
  }, [listQuery.data, archiveQuery.data, tab, folderId, pinsSet])

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

  // A background refetch (e.g. after a delete invalidates the list) shows a
  // floating bar instead of the full-screen "加载中…" placeholder, which would
  // reset scroll position. isPending stays false here (cache present).
  const refetching =
    tab === 'archive'
      ? archiveQuery.isFetching && !archiveQuery.isPending
      : listQuery.isFetching && !listQuery.isPending
  const folders = listQuery.data?.folders ?? []

  return (
    <div className="flex h-full w-full flex-col">
      {/* Toolbar — full-bleed with a bottom divider (Hi-fi). */}
      <div className="flex flex-none flex-wrap items-center gap-3 border-border/70 border-b px-5 py-3">
        <Tabs onValueChange={(v) => setTab(v as Tab)} value={tab}>
          <TabsList>
            <TabsTrigger value="favorites">收藏夹</TabsTrigger>
            <TabsTrigger value="watch-later">稍后再看</TabsTrigger>
            <TabsTrigger value="archive">本地存档</TabsTrigger>
          </TabsList>
        </Tabs>

        {tab === 'favorites' ? (
          <Select
            onValueChange={(v) => setFolderId(v === 'all' ? 'all' : Number(v))}
            value={folderId === 'all' ? 'all' : String(folderId)}
          >
            <SelectTrigger className="w-48">
              <SelectValue placeholder="全部收藏夹" />
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

        {totalCount > 0 ? (
          <span className="ml-auto inline-flex items-center gap-1.5 rounded-full border border-violet-500/20 bg-linear-to-br from-violet-500/10 to-primary/10 px-3 py-1 text-xs">
            <Sparkles className="size-3 text-violet-500" />
            <span className="font-semibold text-violet-700 dark:text-violet-300">
              AI 已解析 <span className="tabular-nums">{analyzedCount}</span> /{' '}
              <span className="tabular-nums">{totalCount}</span>
            </span>
          </span>
        ) : null}
        {statusQuery.data?.uname ? (
          <div className="flex items-center gap-2">
            <span
              className="flex size-6 items-center justify-center rounded-full font-semibold text-[11px] text-white"
              style={{ backgroundColor: authorColor(statusQuery.data.uname) }}
            >
              {statusQuery.data.uname[0]}
            </span>
            <span className="text-[12.5px] text-muted-foreground">{statusQuery.data.uname}</span>
          </div>
        ) : null}
      </div>

      {/* Body: grid + (only when a video is picked) the detail panel. Mounting
          the panel on-demand lets it collapse — and gives the grid the full
          width while browsing, so small windows still show multiple columns. */}
      <div className="flex min-h-0 flex-1">
        <div className="relative flex min-h-0 flex-1 flex-col">
          {tab !== 'archive' && listQuery.isError ? (
            <div className="flex flex-col items-center gap-3 py-12 text-muted-foreground">
              <p>加载失败</p>
              <Button onClick={() => void listQuery.refetch()} variant="outline">
                重试
              </Button>
            </div>
          ) : tab !== 'archive' && listQuery.isPending ? (
            <div className="py-12 text-center text-muted-foreground">加载中…</div>
          ) : (
            <ScrollArea className="h-full">
              <div className="p-5">
                {/* Pinned videos: a horizontal strip above the grid. */}
                {(pinsQuery.data?.length ?? 0) > 0 ? (
                  <div className="mb-4 flex items-stretch gap-2 overflow-x-auto pb-1">
                    {(pinsQuery.data ?? []).map((v) => (
                      <PinnedCard
                        key={v.bvid}
                        onChanged={() => setSelected(null)}
                        onError={setCardError}
                        onSelect={setSelected}
                        video={v}
                      />
                    ))}
                  </div>
                ) : null}
                {cardError ? <p className="mb-3 text-destructive text-xs">{cardError}</p> : null}

                <div className="flex flex-col gap-3.5">
                  {rows.length === 0 ? (
                    <p className="py-12 text-center text-muted-foreground">
                      {tab === 'archive' ? '本地存档为空' : '暂无视频'}
                    </p>
                  ) : null}
                  {rows.map((row) =>
                    row.kind === 'header' ? (
                      <h2 className="pt-3 font-semibold text-[13.5px] text-foreground first:pt-0" key={row.key}>
                        {row.title}
                      </h2>
                    ) : (
                      <div
                        className="grid gap-3.5"
                        key={row.key}
                        style={{ gridTemplateColumns: `repeat(auto-fill, minmax(${MIN_CARD_PX}px, 1fr))` }}
                      >
                        {row.videos.map((v) => (
                          <VideoCard
                            analyzed={analyzedSet.has(v.bvid)}
                            analyzing={analyzingBvid === v.bvid}
                            context={tab}
                            key={v.bvid}
                            onChanged={() => setSelected(null)}
                            onClick={setSelected}
                            onError={setCardError}
                            pinned={pinsSet.has(v.bvid)}
                            selected={selected?.bvid === v.bvid}
                            video={v}
                          />
                        ))}
                      </div>
                    )
                  )}
                </div>
              </div>
            </ScrollArea>
          )}
          {refetching ? (
            <div className="pointer-events-none absolute top-3 left-1/2 z-10 flex -translate-x-1/2 items-center gap-2 rounded-full border border-border/60 bg-background/90 px-3.5 py-1.5 text-xs shadow-sm backdrop-blur-sm">
              <Loader2 className="size-3.5 animate-spin text-muted-foreground" />
              <span className="text-muted-foreground">刷新中…</span>
            </div>
          ) : null}
        </div>
        {selected ? (
          <BilibiliDetailPanel
            context={tab}
            onAnalyzingChange={setAnalyzingBvid}
            onClose={() => setSelected(null)}
            pinned={pinsSet.has(selected.bvid)}
            video={selected}
          />
        ) : null}
      </div>
    </div>
  )
}
