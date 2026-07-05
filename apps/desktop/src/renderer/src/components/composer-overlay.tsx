import type { PermissionDecision, PlanTodo } from '@swarm/protocol'
import { Button } from '@swarm/ui'
import { useHotkey } from '@tanstack/react-hotkeys'
import { XIcon, ZapIcon } from 'lucide-react'

import { PermissionCard } from '@/components/permission-card'
import { PlanStatusBar } from '@/components/plan-status-bar'
import type { PermissionPrompt } from '@/stores/permission'

type QueuedItem = { id: string; sessionId: string; goal: string }

type Props = {
  prompts: PermissionPrompt[]
  onDecide: (actionId: string, decision: PermissionDecision) => void
  todos: PlanTodo[]
  running: boolean
  queued?: QueuedItem[]
  onCancelQueued?: (runId: string) => void
  onInterrupt?: (runId: string) => void
}

/**
 * Pinned items rendered as distinct rounded cards floating above the composer
 * box: pending permissions, the plan progress bar, and queued turns. Each block
 * is its own card (own rounded corners + border) on a solid popover surface, so
 * it layers above the translucent input field — cards feel elevated, the input
 * feels recessed. Top-to-bottom: plan progress, queued messages, then permission
 * requests closest to the input. Renders nothing when there is nothing to pin.
 * Owned by ChatInput via its `overlay` prop.
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

  // One Escape hotkey for the whole stack: skip the top-most prompt. Kept
  // registered but disabled when nothing is pinned (still visible in devtools).
  // Don't prevent/stop the event so any nested Escape handlers still react, as
  // the previous window listener did.
  useHotkey('Escape', () => top && onDecide(top.actionId, 'skip'), {
    enabled: Boolean(top),
    preventDefault: false,
    stopPropagation: false,
  })

  // Nothing to pin unless there's a prompt, a queued turn, or a live plan with
  // still-unfinished steps (a fully-completed plan hides — see PlanStatusBar).
  const planVisible = running && todos.some((t) => t.status !== 'completed')
  if (prompts.length === 0 && queued.length === 0 && !planVisible) return null

  return (
    <div className="mb-2 flex flex-col gap-2">
      <PlanStatusBar running={running} todos={todos} />
      {queued.map((q) => (
        <div
          className="flex items-center justify-between gap-2 rounded-xl border border-border bg-popover px-3 py-1.5 text-sm shadow-sm"
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
  )
}
