import { useState } from 'react'
import type { PlanTodo } from '@shared/types/task'
import { Check, Circle, ListChecks, Loader2, PanelRightClose, PanelRightOpen } from 'lucide-react'

import { Button } from '@/components/ui/button'
import { ScrollArea } from '@/components/ui/scroll-area'
import { cn } from '@/lib/utils'

type Props = { todos: PlanTodo[] }

/** Codex-style working plan: a collapsible right-hand checklist the agent updates as it works. */
export function PlanPanel({ todos }: Props): React.JSX.Element {
  // Always present; collapsed by default so it stays out of the way until needed.
  const [collapsed, setCollapsed] = useState(true)
  const done = todos.filter((t) => t.status === 'completed').length

  if (collapsed) {
    return (
      <div className="flex h-full w-12 shrink-0 flex-col items-center gap-3 border-l bg-sidebar/50 py-4 backdrop-blur-sm">
        <Button
          aria-label="Expand plan"
          className="size-8 rounded-lg transition-colors hover:bg-primary/10 hover:text-primary"
          onClick={() => setCollapsed(false)}
          size="icon"
          variant="ghost"
        >
          <PanelRightOpen className="size-5" />
        </Button>
        <div className="flex flex-col items-center gap-1">
          <ListChecks className="size-5 text-primary/60" />
          {todos.length > 0 && (
            <span className="font-bold text-[10px] text-primary/80 tabular-nums">
              {done}/{todos.length}
            </span>
          )}
        </div>
      </div>
    )
  }

  return (
    <div className="flex h-full w-80 shrink-0 flex-col border-l bg-sidebar/50 backdrop-blur-sm">
      <div className="flex h-11 items-center justify-between border-border/40 border-b px-4">
        <div className="flex items-center gap-2">
          <ListChecks className="size-4 text-primary" />
          <span className="font-bold text-[11px] text-foreground/80 uppercase tracking-wider">Working Plan</span>
        </div>
        <div className="flex items-center gap-2">
          <div className="rounded-full bg-primary/10 px-2 py-0.5 font-bold text-[10px] text-primary tabular-nums">
            {done} / {todos.length}
          </div>
          <Button
            aria-label="Collapse plan"
            className="size-7 rounded-lg text-muted-foreground transition-colors hover:bg-muted/50 hover:text-foreground"
            onClick={() => setCollapsed(true)}
            size="icon"
            variant="ghost"
          >
            <PanelRightClose className="size-4" />
          </Button>
        </div>
      </div>
      <ScrollArea className="min-h-0 flex-1">
        {todos.length === 0 ? (
          <div className="flex flex-col items-center justify-center gap-2 px-4 py-16 text-center text-muted-foreground/60">
            <ListChecks className="size-6 opacity-40" />
            <span className="text-[13px]">No tasks yet</span>
          </div>
        ) : (
          <ul className="flex flex-col gap-2 px-4 py-6">
            {todos.map((t) => (
              <li className="group flex items-start gap-3" key={t.content}>
                <div className="mt-0.5 flex size-5 shrink-0 items-center justify-center rounded-full">
                  {t.status === 'completed' ? (
                    <div className="flex size-5 items-center justify-center rounded-full bg-emerald-500/10">
                      <Check className="size-3 stroke-[3px] text-emerald-600" />
                    </div>
                  ) : t.status === 'in_progress' ? (
                    <div className="flex size-5 items-center justify-center rounded-full bg-primary/10">
                      <Loader2 className="size-3 animate-spin text-primary" />
                    </div>
                  ) : (
                    <div className="flex size-5 items-center justify-center rounded-full bg-muted/40">
                      <Circle className="size-2 fill-muted-foreground/10 text-muted-foreground/30" />
                    </div>
                  )}
                </div>
                <span
                  className={cn(
                    'text-[13px] leading-relaxed transition-colors',
                    t.status === 'completed' && 'text-muted-foreground/60 line-through',
                    t.status === 'in_progress' && 'font-semibold text-foreground',
                    t.status === 'pending' && 'text-muted-foreground/80'
                  )}
                >
                  {t.content}
                </span>
              </li>
            ))}
          </ul>
        )}
      </ScrollArea>
    </div>
  )
}
