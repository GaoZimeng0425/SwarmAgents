import { useEffect, useMemo } from 'react'
import type { RunRecord } from '@shared/lib/apply-event'
import { Button, Spinner } from '@swarm/ui'
import { useQueryClient } from '@tanstack/react-query'
import { sortBy } from 'es-toolkit'
import { ArrowDown, MessagesSquare } from 'lucide-react'
import { toast } from 'sonner'

import { ConversationMinimap } from '@/components/conversation-minimap'
import { buildThreadItems, useTimelineRenderer } from '@/components/task-transcript'
import { StickToBottomList, useStickToBottomList } from '@/components/viewers/stick-to-bottom-list'
import { RUNS_KEY } from '@/hooks/use-runs'
import type { TimelineItem } from '@/lib/build-timeline-items'

type Props = {
  tasks: RunRecord[]
  /** Start a new user turn with the given text (used by interactive UI cards). */
  onSend?: (text: string) => void
  /** Deep-link target: scroll to and briefly highlight this task's turn (e.g. a scheduled run). */
  focusTaskId?: string
}

// Self-drawn "scroll to latest" — replaces the library's ConversationScrollButton.
function ScrollToLatest() {
  const { isAtBottom, scrollToBottom } = useStickToBottomList()
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

// Deep-link probe — must live inside <StickToBottomList> to read its context.
// scrollToKey brings the target task's goal bubble into the virtual window (even
// when unmounted), then a short delay later we center it and flash a ring.
function FocusProbe({ focusTaskId }: { focusTaskId?: string }) {
  const { scrollToKey } = useStickToBottomList()
  useEffect(() => {
    if (!focusTaskId) return
    scrollToKey(`${focusTaskId}-goal`)
    const id = window.setTimeout(() => {
      const el = document.querySelector<HTMLElement>(`[data-task-id="${focusTaskId}"]`)
      if (!el) return
      el.scrollIntoView({ block: 'center', behavior: 'smooth' })
      el.classList.add('ring-2', 'ring-primary', 'ring-offset-2', 'ring-offset-background', 'rounded-lg')
      window.setTimeout(
        () => el.classList.remove('ring-2', 'ring-primary', 'ring-offset-2', 'ring-offset-background', 'rounded-lg'),
        2200
      )
    }, 120)
    return () => window.clearTimeout(id)
  }, [focusTaskId, scrollToKey])
  return null
}

export function ConversationThread({ tasks, onSend, focusTaskId }: Props): React.JSX.Element {
  const qc = useQueryClient()
  const onCopy = (text: string): void => {
    void navigator.clipboard.writeText(text)
    toast.success('Message copied to clipboard')
  }
  const onDelete = (runId: string): void => {
    qc.setQueryData<RunRecord[]>(RUNS_KEY, (prev = []) => prev.filter((t) => t.id !== runId))
    toast.info('Message removed from view')
  }

  const ordered = sortBy(tasks, ['startedAt'])
  const last = ordered[ordered.length - 1]
  // Optional-chain: hooks (useTimelineRenderer/useMemo) run before the empty-state
  // early return, so `busy` must tolerate tasks=[] (last undefined → busy false).
  const busy = last?.status === 'running' || last?.status === 'pending'
  const { renderSegment, sheet } = useTimelineRenderer({ busy, onCopy, onDelete, onSend, tasks })

  const items = useMemo(() => {
    const thread = buildThreadItems(tasks, renderSegment, { busy, showDayDividers: true })
    // While a turn is in flight, a thinking/queued spinner rides the tail so
    // stick-to-bottom keeps it pinned (seq = MAX sorts it last). Token/cost
    // detail lives in the composer's context ring, not a footer here.
    const footer = busy ? (
      <div className="flex animate-pulse items-center gap-3 px-1 text-muted-foreground text-sm">
        <Spinner className="size-4 text-primary" />
        <span className="font-medium">{last.status === 'pending' ? '排队中…' : '正在思考…'}</span>
      </div>
    ) : null
    return footer
      ? [...thread, { key: '__footer', node: footer, seq: Number.MAX_SAFE_INTEGER, ts: Date.now() }]
      : thread
  }, [tasks, renderSegment, busy, last])

  if (tasks.length === 0) {
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
    <StickToBottomList
      className="min-h-0 flex-1"
      getKey={(it: TimelineItem) => it.key}
      items={items}
      renderItem={(it: TimelineItem) => (
        // user-content re-enables text selection (globals.css disables it on chrome).
        // px-4 + pb-5 sets the inter-turn spacing as bottom padding (not a flex
        // `gap`), so it lives INSIDE measureElement's box — react-virtual's `gap`
        // option interacted badly with dynamic re-measurement (overlapping rows,
        // expand not reflowing). Padding is measured, so the virtualizer accounts
        // for it correctly.
        <div className="user-content mx-auto max-w-3xl px-4 pb-5">{it.node}</div>
      )}
    >
      <FocusProbe focusTaskId={focusTaskId} />
      <ConversationMinimap tasks={tasks} />
      <ScrollToLatest />
      {sheet}
    </StickToBottomList>
  )
}
