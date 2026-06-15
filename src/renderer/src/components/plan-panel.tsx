import type { PlanTodo } from '@shared/types/task'
import { Check, Circle, Loader2 } from 'lucide-react'

import { cn } from '@/lib/utils'

type Props = { todos: PlanTodo[] }

/** Codex-style working plan: a compact checklist the agent updates as it works. */
export function PlanPanel({ todos }: Props): React.JSX.Element | null {
  if (todos.length === 0) return null
  const done = todos.filter((t) => t.status === 'completed').length

  return (
    <div className="rounded-lg border bg-card/60 px-3 py-2 text-sm">
      <div className="mb-1.5 flex items-center justify-between text-muted-foreground text-xs">
        <span className="font-medium">Plan</span>
        <span>
          {done}/{todos.length}
        </span>
      </div>
      <ul className="flex flex-col gap-1">
        {todos.map((t) => (
          <li className="flex items-start gap-2" key={t.content}>
            <span className="mt-0.5 shrink-0">
              {t.status === 'completed' ? (
                <Check className="size-3.5 text-muted-foreground" />
              ) : t.status === 'in_progress' ? (
                <Loader2 className="size-3.5 animate-spin" />
              ) : (
                <Circle className="size-3.5 text-muted-foreground/50" />
              )}
            </span>
            <span
              className={cn(
                t.status === 'completed' && 'text-muted-foreground line-through',
                t.status === 'in_progress' && 'font-medium',
                t.status === 'pending' && 'text-muted-foreground'
              )}
            >
              {t.content}
            </span>
          </li>
        ))}
      </ul>
    </div>
  )
}
