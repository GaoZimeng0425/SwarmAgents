import { useEffect } from 'react'
import type { PlanTodo } from '@shared/types/task'
import type { PermissionDecision } from '@shared/types/ui'
import { SquareIcon, XIcon, ZapIcon } from 'lucide-react'

import { PermissionCard } from '@/components/permission-card'
import { PlanStatusBar } from '@/components/plan-status-bar'
import { Button } from '@/components/ui/button'
import type { PermissionPrompt } from '@/stores/permission'

type QueuedItem = { id: string; sessionId: string; goal: string }

type Props = {
  prompts: PermissionPrompt[]
  onDecide: (actionId: string, decision: PermissionDecision) => void
  todos: PlanTodo[]
  running: boolean
  onStopRunning?: () => void
  queued?: QueuedItem[]
  onCancelQueued?: (taskId: string) => void
  onInterrupt?: (taskId: string) => void
}

/**
 * Unified stack of pinned items above the composer. Top-to-bottom: the running
 * status/stop bar, the plan progress bar, queued-message cards (each cancellable
 * or interrupt-to-front), then any pending permission requests closest to the
 * input. Renders nothing when fully idle and empty. Width mirrors ChatInput
 * (px-4 outer + mx-auto max-w-3xl inner) so cards never exceed the input width.
 */
export function ComposerOverlay({
  prompts,
  onDecide,
  todos,
  running,
  onStopRunning,
  queued = [],
  onCancelQueued,
  onInterrupt,
}: Props): React.JSX.Element | null {
  const top = prompts[0]

  // One Escape listener for the whole stack: skip the top-most prompt.
  useEffect(() => {
    if (!top) return
    const onKey = (e: KeyboardEvent): void => {
      if (e.key === 'Escape') onDecide(top.actionId, 'skip')
    }
    window.addEventListener('keydown', onKey)
    return () => {
      window.removeEventListener('keydown', onKey)
    }
  }, [top, onDecide])

  if (!running && prompts.length === 0 && queued.length === 0) return null

  return (
    <div className="shrink-0 px-4 pb-1">
      <div className="mx-auto flex max-w-3xl flex-col gap-2">
        {running && (
          <div className="flex items-center justify-between rounded-md border bg-muted/40 px-3 py-1.5 text-sm text-muted-foreground">
            <span className="flex items-center gap-2">
              <span className="size-2 animate-pulse rounded-full bg-green-500" aria-hidden />
              执行中…
            </span>
            <Button aria-label="停止" onClick={onStopRunning} size="icon-sm" variant="ghost">
              <SquareIcon className="size-4" />
            </Button>
          </div>
        )}
        <PlanStatusBar running={running} todos={todos} />
        {queued.map((q) => (
          <div
            key={q.id}
            className="flex items-center justify-between gap-2 rounded-md border bg-muted/20 px-3 py-1.5 text-sm"
          >
            <span className="flex min-w-0 items-center gap-2">
              <span className="text-muted-foreground" aria-hidden>
                ⏳
              </span>
              <span className="truncate">{q.goal}</span>
            </span>
            <span className="flex shrink-0 items-center gap-1">
              <Button aria-label="打断" onClick={() => onInterrupt?.(q.id)} size="icon-sm" variant="ghost">
                <ZapIcon className="size-4" />
              </Button>
              <Button aria-label="取消排队" onClick={() => onCancelQueued?.(q.id)} size="icon-sm" variant="ghost">
                <XIcon className="size-4" />
              </Button>
            </span>
          </div>
        ))}
        {prompts.map((p, i) => (
          <PermissionCard autoFocusDeny={i === 0} key={p.actionId} onDecide={onDecide} prompt={p} />
        ))}
      </div>
    </div>
  )
}
