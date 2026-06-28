// Shows the user's Bilibili favorites folders and watch-later list. Prompts for
// login when logged out. Clicking a video is a no-op until milestone C wires the
// summarize -> Obsidian pipeline.
import { useCallback, useMemo, useRef, useState } from 'react'
import type { BiliVideo } from '@shared/types/bilibili'
import { useQuery, useQueryClient } from '@tanstack/react-query'

import { Button } from '@/components/ui/button'
import { VirtualList } from '@/components/ui/virtual-list'
import { swarmApi } from '@/lib/api'

// Grid metrics — kept in sync with the inline grid template below. MIN_CARD is
// the 11rem min column width the layout used before virtualization; GAP is the
// gap-3 (0.75rem) gutter.
const MIN_CARD_PX = 176
const GAP_PX = 12

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

function buildRows(
  folders: { folder: { id: number; title: string }; videos: BiliVideo[] }[],
  watchLater: BiliVideo[],
  columns: number
): GridRow[] {
  const rows: GridRow[] = []
  for (const { folder, videos } of folders) {
    rows.push({ kind: 'header', key: `header:${folder.id}`, title: folder.title })
    chunk(videos, columns).forEach((group, i) => {
      rows.push({ kind: 'grid', key: `grid:${folder.id}:${i}`, videos: group })
    })
  }
  if (watchLater.length > 0) {
    rows.push({ kind: 'header', key: 'header:watch-later', title: '稍后再看' })
    chunk(watchLater, columns).forEach((group, i) => {
      rows.push({ kind: 'grid', key: `grid:watch-later:${i}`, videos: group })
    })
  }
  return rows
}

function VideoCard({ video, onClick }: { video: BiliVideo; onClick: (v: BiliVideo) => void }): React.JSX.Element {
  return (
    <button
      className="flex flex-col gap-1 rounded-md border border-sidebar-border p-2 text-left transition-colors hover:bg-sidebar-accent"
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
    return buildRows(listQuery.data.folders, listQuery.data.watchLater, columns)
  }, [listQuery.data, columns])

  async function handleLogin(): Promise<void> {
    await swarmApi.bilibiliLogin()
    await queryClient.invalidateQueries({ queryKey: ['bilibili'] })
  }

  function handleClickVideo(v: BiliVideo): void {
    // Milestone C wires the summarize -> Obsidian pipeline here.
    console.debug('bilibili video clicked', v.bvid)
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

  return (
    <div className="mx-auto flex h-full w-full flex-col gap-4 p-4">
      <div className="flex items-center gap-2">
        <h1 className="mr-auto font-semibold text-foreground/90 text-lg">Bilibili 收藏</h1>
        <span className="text-muted-foreground text-sm">{statusQuery.data?.uname ?? ''}</span>
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
                    <VideoCard key={v.bvid} onClick={handleClickVideo} video={v} />
                  ))}
                </div>
              )
            }
          />
        </div>
      )}
    </div>
  )
}
