import { useState } from 'react'
import type { PlanTodo } from '@shared/types/task'
import { Check, Circle, ListChecks, Loader2, PanelRightClose, PanelRightOpen } from 'lucide-react'

import { Button } from '@/components/ui/button'
import { ScrollArea } from '@/components/ui/scroll-area'
import { cn } from '@/lib/utils'

type Props = { todos: PlanTodo[] }

/** Codex-style working plan: a collapsible right-hand checklist the agent updates as it works. */
export function PlanPanel({ todos }: Props): React.JSX.Element | null {
  const [collapsed, setCollapsed] = useState(false)
  if (todos.length === 0) return null
  const done = todos.filter((t) => t.status === 'completed').length

  if (collapsed) {
    return (
      <div className="flex h-full w-10 shrink-0 flex-col items-center gap-1 border-l bg-card/30 py-2">
        <Button
          aria-label="Expand plan"
          className="size-7"
          onClick={() => setCollapsed(false)}
          size="icon"
          variant="ghost"
        >
          <PanelRightOpen className="size-4" />
        </Button>
        <ListChecks className="mt-1 size-4 text-muted-foreground" />
        <span className="text-[10px] text-muted-foreground tabular-nums">
          {done}/{todos.length}
        </span>
      </div>
    )
  }

  return (
    <div className="flex h-full w-72 shrink-0 flex-col border-l bg-card/30">
      <div className="flex items-center justify-between px-3 py-2.5 text-muted-foreground text-xs">
        <span className="font-medium">Plan</span>
        <div className="flex items-center gap-1.5">
          <span className="tabular-nums">
            {done}/{todos.length}
          </span>
          <Button
            aria-label="Collapse plan"
            className="size-6"
            onClick={() => setCollapsed(true)}
            size="icon"
            variant="ghost"
          >
            <PanelRightClose className="size-4" />
          </Button>
        </div>
      </div>
      <ScrollArea className="min-h-0 flex-1">
        <ul className="flex flex-col gap-1 px-3 pb-3 text-sm">
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
      </ScrollArea>
    </div>
  )
}
