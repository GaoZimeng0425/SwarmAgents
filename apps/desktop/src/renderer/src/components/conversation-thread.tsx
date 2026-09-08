import { useMemo } from 'react'
import type { Segment } from '@swarm/shared'
import { Button, Spinner } from '@swarm/ui'
import { ArrowDown, MessagesSquare } from 'lucide-react'
import { toast } from 'sonner'

import { buildThreadItems, type TimelineItem, useTimelineRenderer } from '@/components/task-transcript'
import { useVirtualList, VirtualList } from '@/components/viewers/virtual-list'

type Props = {
  /** Flattened render segments for the active session (buildSegments output). */
  segments: Segment[]
  /** Whether the session's run is in flight (drives the tail spinner). */
  busy: boolean
  /** Start a new user turn with the given text (used by interactive UI cards). */
  onSend?: (text: string) => void
}

// Self-drawn "scroll to latest" — replaces the library's ConversationScrollButton.
function ScrollToLatest() {
  const { isAtBottom, scrollToBottom } = useVirtualList()
  if (isAtBottom) return null
  return (
    <Button
      className="absolute bottom-4 left-1/2 -translate-x-1/2 rounded-full bg-popover/90 shadow-sm ring-1 ring-border/60 backdrop-blur hover:bg-muted dark:bg-popover/85 dark:hover:bg-muted"
      onClick={() => scrollToBottom()}
      size="icon"
      variant="outline"
    >
      <ArrowDown className="size-4" />
    </Button>
  )
}

export function ConversationThread({ segments, busy, onSend }: Props): React.JSX.Element {
  const onCopy = (text: string): void => {
    void navigator.clipboard.writeText(text)
    toast.success('Message copied to clipboard')
  }
  const { renderSegment, sheet } = useTimelineRenderer({ busy, onCopy, onSend })

  const items = useMemo(() => {
    const thread = buildThreadItems(segments, renderSegment, { showDayDividers: true })
    // While a turn is in flight, a thinking spinner rides the tail so
    // stick-to-bottom keeps it pinned (order = MAX sorts it last).
    const footer = busy ? (
      <div className="flex animate-pulse items-center gap-3 px-1 text-muted-foreground text-sm">
        <Spinner className="size-4 text-primary" />
        <span className="font-medium">正在思考…</span>
      </div>
    ) : null
    return footer
      ? [...thread, { key: '__footer', node: footer, order: Number.MAX_SAFE_INTEGER, ts: Date.now() }]
      : thread
  }, [segments, renderSegment, busy])

  if (segments.length === 0) {
    return (
      <div className="flex size-full flex-col items-center justify-center gap-3 p-8 text-center">
        <div className="text-muted-foreground">
          <MessagesSquare aria-hidden="true" className="size-6 opacity-60" />
        </div>
        <div className="space-y-1">
          <h3 className="font-medium text-sm">还没有消息</h3>
          <p className="text-muted-foreground text-sm">发送一条消息,开始这段对话。</p>
        </div>
      </div>
    )
  }

  return (
    <VirtualList
      className="min-h-0 flex-1"
      getKey={(it: TimelineItem) => it.key}
      items={items}
      renderItem={(it: TimelineItem) => (
        // user-content re-enables text selection (globals.css disables it on chrome).
        // px-4 + pb-5 sets the inter-turn spacing as measured bottom padding.
        <div className="user-content mx-auto max-w-3xl px-4 pb-5">{it.node}</div>
      )}
    >
      <ScrollToLatest />
      {sheet}
    </VirtualList>
  )
}
