import type { PermissionDecision, PlanTodo } from '@swarm/protocol'
import { Button } from '@swarm/ui'
import { XIcon, ZapIcon } from 'lucide-react'

import { PermissionCard } from '@/components/permission-card'
import { PlanStatusBar } from '@/components/plan-status-bar'
import { useCommandBindings } from '@/hooks/use-command-bindings'
import type { PermissionPrompt } from '@/stores/permission'

type QueuedItem = { id: string; sessionId: string; prompt: string }

type Props = {
  prompts: PermissionPrompt[]
  onDecide: (actionId: string, decision: PermissionDecision) => void
  todos: PlanTodo[]
  running: boolean
  queued?: QueuedItem[]
  onCancelQueued?: (messageId: string) => void
  onInterrupt?: (messageId: string) => void
}

/**
 * Pinned items for the composer, in two zones:
 *
 * - Floating zone (plan progress bar, queued turns): in-flow cards above the
 *   composer box, never covering it. Pure status/information.
 * - Cover zone (pending permissions): an absolute-positioned layer that
 *   overlays the composer box with a dimming backdrop, so while a permission
 *   decision is pending the input is visually and interactionally blocked.
 *   Anchored by `relative` on `composerRef` in ChatInput.
 *
 * Renders nothing when there is nothing to pin. Owned by ChatInput via its
 * `overlay` prop.
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

  // One Escape command for the whole stack: skip the top-most prompt. The
  // binding lives in lib/commands/bindings.ts (`permission.skipTop`) with
  // preventDefault:false / stopPropagation:false so nested Escape handlers
  // still react, as the previous window listener did. When nothing is pinned
  // (`top` is undefined) the handler is a no-op rather than unregistering.
  useCommandBindings({
    'permission.skipTop': () => {
      if (top) onDecide(top.actionId, 'skip')
    },
  })

  // Nothing to pin unless there's a prompt, a queued turn, or a live plan with
  // still-unfinished steps (a fully-completed plan hides — see PlanStatusBar).
  const planVisible = running && todos.some((t) => t.status !== 'completed')
  if (prompts.length === 0 && queued.length === 0 && !planVisible) return null

  return (
    <>
      {/* Floating zone — informational (plan progress, queued turns). Stays
          in-flow above the composer; never covers the input. Renders nothing
          when empty so it takes no vertical space. */}
      {(planVisible || queued.length > 0) && (
        <div className="floating-zone mb-2 flex flex-col gap-2">
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
                <span className="truncate">{q.prompt}</span>
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
        </div>
      )}

      {/* Cover zone — pending permissions only. Absolute inset-0 over the
          composer box (anchored by `relative` on composerRef in ChatInput),
          with a dimming backdrop so the disabled input reads as locked. */}
      {prompts.length > 0 && (
        <div className="cover-zone absolute inset-0 z-10 flex flex-col gap-2 overflow-hidden rounded-xl bg-background/80 p-2 backdrop-blur-sm">
          {prompts.map((p, i) => (
            <PermissionCard autoFocusDeny={i === 0} key={p.actionId} onDecide={onDecide} prompt={p} />
          ))}
        </div>
      )}
    </>
  )
}
