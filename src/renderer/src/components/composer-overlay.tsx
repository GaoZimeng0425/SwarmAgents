import { useEffect } from 'react'
import type { PlanTodo } from '@shared/types/task'
import type { PermissionDecision } from '@shared/types/ui'

import { PermissionCard } from '@/components/permission-card'
import { PlanStatusBar } from '@/components/plan-status-bar'
import type { PermissionPrompt } from '@/stores/permission'

type Props = {
  prompts: PermissionPrompt[]
  onDecide: (actionId: string, decision: PermissionDecision) => void
  todos: PlanTodo[]
  running: boolean
}

/**
 * Unified stack of pinned items above the composer: the running plan progress
 * bar plus any pending permission requests. Renders nothing when empty; when
 * several items are active they stack vertically (plan on top, permission cards
 * closest to the input). The wrapper mirrors ChatInput's width model
 * (px-4 outer + mx-auto max-w-3xl inner) so the cards never exceed the input
 * width and appear to float up from it.
 */
export function ComposerOverlay({ prompts, onDecide, todos, running }: Props): React.JSX.Element | null {
  const showPlan = running && todos.length > 0
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

  if (!showPlan && prompts.length === 0) return null

  return (
    <div className="shrink-0 px-4 pb-1">
      <div className="mx-auto flex max-w-3xl flex-col gap-2">
        <PlanStatusBar running={running} todos={todos} />
        {prompts.map((p, i) => (
          <PermissionCard autoFocusDeny={i === 0} key={p.actionId} onDecide={onDecide} prompt={p} />
        ))}
      </div>
    </div>
  )
}
