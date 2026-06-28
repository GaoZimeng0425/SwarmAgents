// Shows the user's Bilibili favorites folders and watch-later list. Prompts for
// login when logged out. Clicking a video is a no-op until milestone C wires the
// summarize -> Obsidian pipeline.
import type { BiliVideo } from '@shared/types/bilibili'
import { useQuery, useQueryClient } from '@tanstack/react-query'

import { Button } from '@/components/ui/button'
import { swarmApi } from '@/lib/api'

function VideoCard({ video, onClick }: { video: BiliVideo; onClick: (v: BiliVideo) => void }): React.JSX.Element {
  return (
    <button
      className="flex flex-col gap-1 rounded-md border border-sidebar-border p-2 text-left transition-colors hover:bg-sidebar-accent"
      onClick={() => onClick(video)}
      type="button"
    >
      {video.cover ? <img alt="" className="aspect-video w-full rounded object-cover" src={video.cover} /> : null}
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
      <div className="mx-auto flex h-full w-full max-w-3xl flex-col items-center justify-center gap-4 p-4">
        <p className="text-muted-foreground">未登录 Bilibili</p>
        <Button onClick={() => void handleLogin()}>登录 Bilibili</Button>
      </div>
    )
  }

  return (
    <div className="mx-auto flex h-full w-full max-w-3xl flex-col gap-4 overflow-auto p-4">
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
        <>
          {listQuery.data.folders.map(({ folder, videos }) => (
            <section className="flex flex-col gap-2" key={folder.id}>
              <h2 className="font-medium text-foreground/80 text-sm">{folder.title}</h2>
              <div className="grid grid-cols-2 gap-2">
                {videos.map((v) => (
                  <VideoCard key={v.bvid} onClick={handleClickVideo} video={v} />
                ))}
              </div>
            </section>
          ))}
          {listQuery.data.watchLater.length > 0 ? (
            <section className="flex flex-col gap-2">
              <h2 className="font-medium text-foreground/80 text-sm">稍后再看</h2>
              <div className="grid grid-cols-2 gap-2">
                {listQuery.data.watchLater.map((v) => (
                  <VideoCard key={v.bvid} onClick={handleClickVideo} video={v} />
                ))}
              </div>
            </section>
          ) : null}
        </>
      )}
    </div>
  )
}
