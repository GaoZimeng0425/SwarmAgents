// Shared "..." action menu for a Bilibili video card / detail panel. Renders
// the three local-bookmark actions — pin/unpin, soft-delete (un-fav or clear
// watch-later, keeping a local card), and hard delete (remove everywhere) — and
// fires `onChanged` after any mutation so the parent can refetch.
//
// The trigger is rendered by the caller via the `trigger` prop so the same menu
// can anchor to either an icon button (detail header) or a compact overlay dot
// (card hover). base-ui Trigger composes via `render`, not `asChild`.
import { useEffect } from 'react'
import type { BiliVideo } from '@swarm/protocol'
import { Button } from '@swarm/ui'
import { useMutation, useQueryClient } from '@tanstack/react-query'
import { MoreVertical, Pin, PinOff, Play, Trash2 } from 'lucide-react'

import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuTrigger } from '@/components/ui/dropdown-menu'
import { swarmApi } from '@/lib/api'
import type { VideoListContext } from './bilibili-view'

export function BilibiliVideoMenu({
  video,
  context,
  pinned,
  onChanged,
  onError,
  trigger = 'icon',
  onBusyChange,
}: {
  video: BiliVideo
  context: VideoListContext
  pinned: boolean
  onChanged: () => void
  onError: (message: string) => void
  /** 'icon' = a MoreVertical icon button (header); 'dot' = a compact overlay dot (card hover). */
  trigger?: 'icon' | 'dot'
  /** Report in-flight mutation state so the caller can badge the card while a
   *  delete/pin is running (the menu is closed and its disabled trigger is
   *  otherwise invisible). */
  onBusyChange?: (busy: boolean) => void
}): React.JSX.Element {
  const queryClient = useQueryClient()

  const invalidate = (): void => {
    void queryClient.invalidateQueries({ queryKey: ['bilibili'] })
  }

  const pinMutation = useMutation({
    mutationFn: () => (pinned ? swarmApi.bilibiliPinsRemove(video.bvid) : swarmApi.bilibiliPinsPut(video)),
    onSuccess: () => {
      invalidate()
      onChanged()
    },
  })

  // Soft delete: remove from Bilibili but keep a local card. Watch-later needs
  // only bvid; a fav-folder video needs its fav* ids.
  const softDeleteMutation = useMutation({
    mutationFn: async () => {
      const del =
        context === 'watch-later' ? swarmApi.bilibiliDeleteWatchLater(video.bvid) : swarmApi.bilibiliDeleteFav(video)
      const res = await del
      if (!res.ok) throw new Error(res.message)
      await swarmApi.bilibiliArchivePut(video)
    },
    onSuccess: () => {
      invalidate()
      onChanged()
    },
    onError: (err: Error) => onError(err.message),
  })

  // Hard delete: remove from Bilibili (if still there) AND wipe the local
  // archive + pin so no trace remains. A B站 delete failure (e.g. the video was
  // already removed, or it was a pinned card no longer on B站) must NOT block
  // the local cleanup, so the network call is best-effort.
  const hardDeleteMutation = useMutation({
    mutationFn: async () => {
      try {
        if (context === 'watch-later') {
          await swarmApi.bilibiliDeleteWatchLater(video.bvid)
        } else if (context === 'favorites') {
          await swarmApi.bilibiliDeleteFav(video)
        }
      } catch {
        // Swallow: the local cleanup below is the point of a hard delete.
      }
      await swarmApi.bilibiliArchiveRemove(video.bvid)
      await swarmApi.bilibiliPinsRemove(video.bvid)
    },
    onSuccess: () => {
      invalidate()
      onChanged()
    },
    onError: (err: Error) => onError(err.message),
  })

  const busy = pinMutation.isPending || softDeleteMutation.isPending || hardDeleteMutation.isPending
  // Surface the busy state to the caller so the card can show an in-flight
  // overlay — the menu trigger itself is hidden (hover) or disabled-but-closed,
  // giving zero feedback otherwise.
  useEffect(() => {
    onBusyChange?.(busy)
  }, [busy, onBusyChange])
  const softLabel = context === 'watch-later' ? '移除稍后再看' : '取消收藏'
  const hardLabel = context === 'archive' ? '删除存档' : '彻底删除'

  return (
    <DropdownMenu>
      <DropdownMenuTrigger
        render={
          trigger === 'icon' ? (
            <Button aria-label="更多操作" disabled={busy} size="icon-sm" variant="ghost">
              <MoreVertical className="size-4" />
            </Button>
          ) : (
            <button
              aria-label="更多操作"
              className="flex size-7 items-center justify-center rounded-full bg-background/90 text-foreground shadow-sm ring-1 ring-border hover:bg-muted disabled:opacity-50"
              disabled={busy}
              type="button"
            >
              <MoreVertical className="size-3.5" />
            </button>
          )
        }
      />
      <DropdownMenuContent align="end" className="w-44">
        <DropdownMenuItem onClick={() => void swarmApi.bilibiliOpen(video.bvid)}>
          <Play className="size-4" />
          观看
        </DropdownMenuItem>
        <DropdownMenuItem disabled={busy} onClick={() => pinMutation.mutate()}>
          {pinned ? <PinOff className="size-4" /> : <Pin className="size-4" />}
          {pinned ? '取消置顶' : '置顶'}
        </DropdownMenuItem>
        {context === 'favorites' || context === 'watch-later' ? (
          <DropdownMenuItem disabled={busy} onClick={() => softDeleteMutation.mutate()}>
            <Trash2 className="size-4" />
            {softLabel}
            <span className="ml-auto text-[10px] text-muted-foreground">存档</span>
          </DropdownMenuItem>
        ) : null}
        <DropdownMenuItem disabled={busy} onClick={() => hardDeleteMutation.mutate()}>
          <Trash2 className="size-4 text-destructive" />
          <span className="text-destructive">{hardLabel}</span>
        </DropdownMenuItem>
      </DropdownMenuContent>
    </DropdownMenu>
  )
}
