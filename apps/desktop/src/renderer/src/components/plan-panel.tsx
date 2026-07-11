import { useEffect, useRef, useState } from 'react'
import type { PlanTodo, TaskStatus } from '@swarm/protocol'
import { Check, ChevronRight, Circle, ListChecks, Loader2 } from 'lucide-react'

import { ScrollArea } from '@/components/ui/scroll-area'
import { cn } from '@/lib/utils'

/** One turn's plan, grouped under its goal for the session execution history. */
export type PlanGroup = {
  messageId: string
  prompt: string
  plan: PlanTodo[]
  status: TaskStatus
  createdAt: number
}

type Props = { groups: PlanGroup[] }

/** Single todo row (shared by every group block). */
function TodoRow({ todo }: { todo: PlanTodo }): React.JSX.Element {
  return (
    <li className="group flex items-start gap-3">
      <div className="mt-0.5 flex size-5 shrink-0 items-center justify-center rounded-full">
        {todo.status === 'completed' ? (
          <div className="flex size-5 items-center justify-center rounded-full bg-emerald-500/10">
            <Check className="size-3 stroke-[3px] text-emerald-600" />
          </div>
        ) : todo.status === 'in_progress' ? (
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
          todo.status === 'completed' && 'text-muted-foreground/60 line-through',
          todo.status === 'in_progress' && 'font-semibold text-foreground',
          todo.status === 'pending' && 'text-muted-foreground/80'
        )}
      >
        {todo.content}
      </span>
    </li>
  )
}

// Collapsible block for one turn's plan. Open while the turn runs (progress
// visible), auto-collapses once it settles — matching the SubagentBlock /
// ReasoningBlock idiom. The user can still toggle via the chevron.
function PlanGroupBlock({ group }: { group: PlanGroup }): React.JSX.Element {
  const running = group.status === 'running' || group.status === 'pending' || group.status === 'awaiting_user'
  const [open, setOpen] = useState(running)
  const wasRunning = useRef(running)
  useEffect(() => {
    if (wasRunning.current && !running) setOpen(false)
    wasRunning.current = running
  }, [running])

  const done = group.plan.filter((t) => t.status === 'completed').length

  return (
    <div className="rounded-xl border border-border/50 bg-muted/10">
      <button
        className="flex w-full items-center gap-2 px-3 py-2.5 text-left text-muted-foreground/80 hover:text-muted-foreground"
        onClick={() => setOpen((v) => !v)}
        type="button"
      >
        {running ? (
          <Loader2 className="size-3.5 shrink-0 animate-spin text-primary" />
        ) : (
          <Check className="size-3.5 shrink-0 text-emerald-600" />
        )}
        <span className="min-w-0 flex-1 truncate text-[13px] text-foreground/90">{group.prompt}</span>
        <span className="shrink-0 font-medium text-[11px] text-muted-foreground/70 tabular-nums">
          {done}/{group.plan.length}
        </span>
        <ChevronRight className={cn('size-3.5 shrink-0 transition-transform', open && 'rotate-90')} />
      </button>
      {open && (
        <ul className="flex flex-col gap-2 border-border/40 border-t px-4 py-3">
          {group.plan.map((t) => (
            <TodoRow key={t.content} todo={t} />
          ))}
        </ul>
      )}
    </div>
  )
}

/**
 * Codex-style working plan, grouped by turn so the whole session's execution
 * history stays visible (each group expandable/collapsible). Rendered inside
 * WorkspacePanel's 计划 tab.
 */
export function PlanPanel({ groups }: Props): React.JSX.Element {
  return (
    <ScrollArea className="min-h-0 flex-1">
      {groups.length === 0 ? (
        <div className="flex flex-col items-center justify-center gap-2 px-4 py-16 text-center text-muted-foreground/60">
          <ListChecks className="size-6 opacity-40" />
          <span className="text-[13px]">暂无任务</span>
        </div>
      ) : (
        <div className="flex flex-col gap-2 px-3 py-4">
          {groups.map((g) => (
            <PlanGroupBlock group={g} key={g.messageId} />
          ))}
        </div>
      )}
    </ScrollArea>
  )
}
