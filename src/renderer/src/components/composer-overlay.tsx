import { useEffect } from 'react'
import type { PlanTodo } from '@shared/types/task'
import type { PermissionDecision } from '@shared/types/ui'
import { XIcon, ZapIcon } from 'lucide-react'

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
  queued?: QueuedItem[]
  onCancelQueued?: (taskId: string) => void
  onInterrupt?: (taskId: string) => void
}

/**
 * Unified stack of pinned items above the composer. Top-to-bottom: the plan
 * progress bar, queued-message cards (each cancellable or interrupt-to-front),
 * then any pending permission requests closest to the input. Stopping a run is
 * the composer submit button's job (it flips to a stop control while running),
 * so this stack carries no run/stop bar. Renders nothing when there is nothing
 * to pin. Width mirrors ChatInput (px-4 outer + mx-auto max-w-3xl inner) so
 * cards never exceed the input width.
 */
export function ComposerOverlay({
  prompts,
  onDecide,
  todos,
  running,
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

  // Nothing to pin unless there's a prompt, a queued turn, or a live plan with
  // still-unfinished steps (a fully-completed plan hides — see PlanStatusBar).
  const planVisible = running && todos.some((t) => t.status !== 'completed')
  if (prompts.length === 0 && queued.length === 0 && !planVisible) return null

  return (
    <div className="shrink-0 px-4 pb-1">
      <div className="mx-auto flex max-w-3xl flex-col gap-2">
        <PlanStatusBar running={running} todos={todos} />
        {queued.map((q) => (
          <div
            className="flex items-center justify-between gap-2 rounded-md border bg-muted/20 px-3 py-1.5 text-sm"
            key={q.id}
          >
            <span className="flex min-w-0 items-center gap-2">
              <span aria-hidden={true} className="text-muted-foreground">
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
