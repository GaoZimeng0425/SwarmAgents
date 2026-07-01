import { useState } from 'react'
import type { PlanTodo } from '@swarm/protocol'
import { Check, ChevronDown, Circle, ListChecks, Loader2 } from 'lucide-react'

import { ScrollArea } from '@/components/ui/scroll-area'
import { cn } from '@/lib/utils'

type Props = { todos: PlanTodo[]; running: boolean }

// Current step: 1-based position of the in-progress todo; with none in progress,
// the completed count (so a finished plan reads M/M).
function stepNumber(todos: PlanTodo[]): number {
  const idx = todos.findIndex((t) => t.status === 'in_progress')
  if (idx >= 0) return idx + 1
  return todos.filter((t) => t.status === 'completed').length
}

/**
 * Collapsible plan progress bar pinned above the composer while a task runs.
 * Collapsed: one line (step N/M + current step title). Expanded: the full
 * checklist. Renders nothing when idle, planless, or once every step is done —
 * a finished plan carries no progress worth pinning above the input.
 */
export function PlanStatusBar({ todos, running }: Props): React.JSX.Element | null {
  const [open, setOpen] = useState(false)
  const allDone = todos.length > 0 && todos.every((t) => t.status === 'completed')
  if (!running || todos.length === 0 || allDone) return null

  const current = todos.find((t) => t.status === 'in_progress') ?? todos.find((t) => t.status === 'pending')
  const n = stepNumber(todos)
  const m = todos.length

  return (
    <section
      aria-label="Plan progress"
      className="flex flex-col overflow-hidden rounded-xl border border-border bg-popover shadow-sm"
    >
      <button
        aria-expanded={open}
        className="flex w-full items-center gap-2.5 px-3.5 py-2.5 text-left transition-colors hover:bg-accent/40"
        onClick={() => setOpen((v) => !v)}
        type="button"
      >
        <span className="flex shrink-0 items-center gap-1.5 rounded-full bg-muted px-2.5 py-0.5 font-medium text-muted-foreground text-xs tabular-nums">
          <ListChecks className="size-3.5" />
          {`第 ${n}/${m} 步`}
        </span>
        <span className="min-w-0 flex-1 truncate text-foreground/90 text-sm">{current?.content ?? '已完成'}</span>
        <ChevronDown
          className={cn('size-4 shrink-0 text-muted-foreground transition-transform', open && 'rotate-180')}
        />
      </button>
      {open && (
        <ScrollArea className="max-h-[40vh] border-border/60 border-t">
          <ul className="flex flex-col gap-2 px-4 py-3">
            {todos.map((t) => (
              <li className="flex items-start gap-3" key={t.content}>
                <span className="mt-0.5 flex size-5 shrink-0 items-center justify-center">
                  {t.status === 'completed' ? (
                    <span className="flex size-5 items-center justify-center rounded-full bg-emerald-500/10">
                      <Check className="size-3 stroke-[3px] text-emerald-600" />
                    </span>
                  ) : t.status === 'in_progress' ? (
                    <span className="flex size-5 items-center justify-center rounded-full bg-primary/10">
                      <Loader2 className="size-3 animate-spin text-primary" />
                    </span>
                  ) : (
                    <span className="flex size-5 items-center justify-center rounded-full bg-muted/40">
                      <Circle className="size-2 fill-muted-foreground/10 text-muted-foreground/30" />
                    </span>
                  )}
                </span>
                <span
                  className={cn(
                    'text-[13px] leading-relaxed',
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
        </ScrollArea>
      )}
    </section>
  )
}
