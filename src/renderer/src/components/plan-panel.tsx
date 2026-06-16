import type { PlanTodo } from '@shared/types/task'
import { Check, Circle, ListChecks, Loader2 } from 'lucide-react'

import { ScrollArea } from '@/components/ui/scroll-area'
import { cn } from '@/lib/utils'

type Props = { todos: PlanTodo[] }

/** Codex-style working plan checklist. Rendered inside RightPanel's Plan tab. */
export function PlanPanel({ todos }: Props): React.JSX.Element {
  return (
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
  )
}
