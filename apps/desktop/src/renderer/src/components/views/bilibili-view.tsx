// Shows the user's Bilibili favorites folders and watch-later list. A top tab
// switches between the two; in favorites mode a dropdown filters to a single
// folder. Clicking a video opens a read-only detail panel (no external nav).
// Prompts for login when logged out.
import { useCallback, useMemo, useRef, useState } from 'react'
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
import { chunk } from 'es-toolkit'
import { Sparkles } from 'lucide-react'

import { ScrollArea } from '@/components/ui/scroll-area'
import { swarmApi } from '@/lib/api'
import { BilibiliDetailPanel } from './bilibili-detail-panel'
import { BilibiliVideoMenu } from './bilibili-video-menu'

// Grid metrics — kept in sync with the inline grid template below. MIN_CARD is
// the 11rem min column width the layout used before virtualization; GAP is the
// gap-3 (0.75rem) gutter.
const MIN_CARD_PX = 176
const GAP_PX = 12

// Which list the currently focused video came from — drives the action menu's
// labels (un-fav vs clear watch-later) and whether a B站 delete is needed.
export type VideoListContext = 'favorites' | 'watch-later' | 'archive'

// Top-level view: the favorites folders, the watch-later list, or the local
// archive (videos soft-deleted from Bilibili but kept as local cards).
type Tab = 'favorites' | 'watch-later' | 'archive'
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
  columns: number,
  archive: BiliVideo[] = [],
  pinnedSet: Set<string> = new Set()
): GridRow[] {
  const rows: GridRow[] = []
  const notPinned = (v: BiliVideo): boolean => !pinnedSet.has(v.bvid)
  if (tab === 'watch-later') {
    chunk(data.watchLater.filter(notPinned), columns).forEach((group, i) => {
      rows.push({ kind: 'grid', key: `grid:watch-later:${i}`, videos: group })
    })
    return rows
  }
  if (tab === 'archive') {
    chunk(archive, columns).forEach((group, i) => {
      rows.push({ kind: 'grid', key: `grid:archive:${i}`, videos: group })
    })
    return rows
  }
  const folders = folderId === 'all' ? data.folders : data.folders.filter((f) => f.folder.id === folderId)
  for (const { folder, videos } of folders) {
    const visible = videos.filter(notPinned)
    if (visible.length === 0) continue
    rows.push({ kind: 'header', key: `header:${folder.id}`, title: folder.title })
    chunk(visible, columns).forEach((group, i) => {
      rows.push({ kind: 'grid', key: `grid:${folder.id}:${i}`, videos: group })
    })
  }
  return rows
}

function VideoCard({
  video,
  selected,
  analyzed,
  pinned,
  context,
  onClick,
  onChanged,
  onError,
}: {
  video: BiliVideo
  selected: boolean
  analyzed: boolean
  pinned: boolean
  context: VideoListContext
  onClick: (v: BiliVideo) => void
  onChanged: () => void
  onError: (message: string) => void
}): React.JSX.Element {
  return (
    // The card is a div (not a button) so the "..." menu trigger can sit inside
    // it without nesting interactive elements. Click anywhere selects the video.
    <div
      className={`group relative flex cursor-pointer flex-col gap-1 rounded-md border p-2 text-left transition-colors hover:bg-sidebar-accent ${
        selected ? 'border-ring ring-2 ring-ring/50' : 'border-sidebar-border'
      }`}
      data-bvid={video.bvid}
      onClick={() => onClick(video)}
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
        {pinned ? (
          <span className="absolute top-1 left-1 rounded bg-amber-500 px-1.5 py-0.5 font-medium text-[10px] text-white">
            置顶
          </span>
        ) : null}
      </div>
      {/* Hover "..." overlay: anchored bottom-right so it doesn't cover the AI badge. */}
      <div className="absolute right-1 bottom-1 opacity-0 transition-opacity group-hover:opacity-100">
        <BilibiliVideoMenu
          context={context}
          onChanged={onChanged}
          onError={onError}
          pinned={pinned}
          trigger="dot"
          video={video}
        />
      </div>
      <div className="truncate font-medium text-foreground text-sm">{video.title}</div>
      <div className="truncate text-muted-foreground text-xs">{video.author}</div>
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
  return (
    <div className="group relative flex w-44 shrink-0 cursor-pointer flex-col gap-1 rounded-md border border-amber-500/30 bg-amber-500/5 p-1.5 hover:bg-amber-500/10">
      <div className="relative w-full" onClick={() => onSelect(video)}>
        {video.cover ? (
          <img
            alt=""
            className="aspect-video w-full rounded object-cover"
            referrerPolicy="no-referrer"
            src={video.cover}
          />
        ) : null}
      </div>
      <div className="truncate text-foreground text-xs" onClick={() => onSelect(video)}>
        {video.title}
      </div>
      <div className="absolute right-0.5 bottom-0.5 opacity-0 transition-opacity group-hover:opacity-100">
        <BilibiliVideoMenu
          context="archive"
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
    // Archive tab has no B站 list dependency; render from the local archive alone.
    if (tab === 'archive') {
      return buildRows({ folders: [], watchLater: [] }, 'archive', 'all', columns, archiveQuery.data ?? [], pinsSet)
    }
    if (!listQuery.data) return []
    return buildRows(listQuery.data, tab, folderId, columns, archiveQuery.data ?? [], pinsSet)
  }, [listQuery.data, archiveQuery.data, tab, folderId, columns, pinsSet])

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
            <TabsTrigger value="archive">本地存档</TabsTrigger>
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

        {totalCount > 0 ? (
          <span className="ml-auto inline-flex items-center gap-1.5 rounded-full border border-violet-500/20 bg-linear-to-br from-violet-500/10 to-primary/10 px-3 py-1 text-xs">
            <Sparkles className="size-3 text-violet-500" />
            <span className="font-semibold text-violet-700 dark:text-violet-300">
              AI 已解析 <span className="tabular-nums">{analyzedCount}</span> /{' '}
              <span className="tabular-nums">{totalCount}</span>
            </span>
          </span>
        ) : null}
        <span className="text-muted-foreground text-sm">{statusQuery.data?.uname ?? ''}</span>
      </div>

      {/* Pinned videos: a horizontal strip above the grid, shown only when non-empty. */}
      {(pinsQuery.data?.length ?? 0) > 0 ? (
        <div className="flex items-stretch gap-2 overflow-x-auto pb-1">
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
      {cardError ? <p className="text-destructive text-xs">{cardError}</p> : null}

      <div className="flex min-h-0 flex-1 gap-0">
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
          // measureRef tracks the available content width to derive the column count.
          <div className="min-h-0 flex-1" ref={measureRef}>
            <ScrollArea className="h-full">
              <div className="flex flex-col gap-3">
                {rows.length === 0 ? (
                  <p className="py-12 text-center text-muted-foreground">
                    {tab === 'archive' ? '本地存档为空' : '暂无视频'}
                  </p>
                ) : null}
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
            </ScrollArea>
          </div>
        )}
        <BilibiliDetailPanel
          context={tab}
          onClose={() => setSelected(null)}
          pinned={selected ? pinsSet.has(selected.bvid) : false}
          video={selected}
        />
      </div>
    </div>
  )
}
