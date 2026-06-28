import { useEffect, useRef, useState } from 'react'
import type { AcceptanceCriterion, TaskStatus, VerificationRound } from '@shared/types/task'
import { Check, ChevronRight, Circle, ShieldCheck, TriangleAlert, X } from 'lucide-react'

import { ScrollArea } from '@/components/ui/scroll-area'
import { cn } from '@/lib/utils'

/** One top-level task's verify state, surfaced in the Verify tab. */
export type VerifyGroup = {
  taskId: string
  goal: string
  criteria: AcceptanceCriterion[]
  latest: VerificationRound | null
  status: TaskStatus
  startedAt: number
}

type Props = { groups: VerifyGroup[] }

/** Single criterion row. */
function CriterionRow({
  criterion,
  result,
}: {
  criterion: AcceptanceCriterion
  result: { pass: boolean; detail: string } | undefined
}): React.JSX.Element {
  const pass = result?.pass
  return (
    <li className="group flex items-start gap-3">
      <div className="mt-0.5 flex size-5 shrink-0 items-center justify-center rounded-full">
        {pass === true ? (
          <div className="flex size-5 items-center justify-center rounded-full bg-emerald-500/10">
            <Check className="size-3 stroke-[3px] text-emerald-600" />
          </div>
        ) : pass === false ? (
          <div className="flex size-5 items-center justify-center rounded-full bg-red-500/10">
            <X className="size-3 stroke-[3px] text-red-500" />
          </div>
        ) : (
          <div className="flex size-5 items-center justify-center rounded-full bg-muted/40">
            <Circle className="size-2 fill-muted-foreground/10 text-muted-foreground/30" />
          </div>
        )}
      </div>
      <span
        className={cn(
          'min-w-0 flex-1 text-[13px] leading-relaxed transition-colors',
          pass === true && 'text-muted-foreground/60 line-through',
          pass === false && 'text-foreground',
          pass === undefined && 'text-muted-foreground/80'
        )}
      >
        {criterion.description}
        {criterion.check && (
          <span className="ml-1.5 font-mono text-[11px] text-muted-foreground/50">[{criterion.check.kind}]</span>
        )}
      </span>
    </li>
  )
}

// Collapsible block for one task's verify state. Mirrors PlanGroupBlock: open
// while the task runs, auto-collapses once settled. User can toggle via chevron.
function VerifyGroupBlock({ group }: { group: VerifyGroup }): React.JSX.Element {
  const running = group.status === 'running' || group.status === 'pending' || group.status === 'awaiting_user'
  const [open, setOpen] = useState(running)
  const wasRunning = useRef(running)
  useEffect(() => {
    if (wasRunning.current && !running) setOpen(false)
    wasRunning.current = running
  }, [running])

  const { latest } = group
  const verdict = latest?.verdict ?? null

  const verdictIndicator =
    verdict === 'pass' ? (
      <div className="flex size-5 items-center justify-center rounded-full bg-emerald-500/10">
        <Check className="size-3 stroke-[3px] text-emerald-600" />
      </div>
    ) : verdict === 'fail' ? (
      <div className="flex size-5 items-center justify-center rounded-full bg-amber-500/10">
        <TriangleAlert className="size-3 text-amber-500" />
      </div>
    ) : (
      <div className="flex size-5 items-center justify-center rounded-full bg-muted/40">
        <Circle className="size-2 fill-muted-foreground/10 text-muted-foreground/30" />
      </div>
    )

  const chipText =
    verdict === 'pass'
      ? `已验收 · 第 ${(latest?.round ?? 0) + 1} 轮`
      : verdict === 'fail'
        ? `未通过 · 第 ${(latest?.round ?? 0) + 1} 轮`
        : '待验收'

  const chipClass =
    verdict === 'pass'
      ? 'text-emerald-600 bg-emerald-500/10'
      : verdict === 'fail'
        ? 'text-amber-600 bg-amber-500/10'
        : 'text-muted-foreground/60 bg-muted/40'

  return (
    <div className="rounded-xl border border-border/50 bg-muted/10">
      <button
        className="flex w-full items-center gap-2 px-3 py-2.5 text-left text-muted-foreground/80 hover:text-muted-foreground"
        onClick={() => setOpen((v) => !v)}
        type="button"
      >
        {verdictIndicator}
        <span className="min-w-0 flex-1 truncate text-[13px] text-foreground/90">{group.goal}</span>
        <span className={cn('shrink-0 rounded-md px-1.5 py-0.5 font-medium text-[11px]', chipClass)}>{chipText}</span>
        <ChevronRight className={cn('size-3.5 shrink-0 transition-transform', open && 'rotate-90')} />
      </button>
      {open && (
        <div className="border-border/40 border-t px-4 py-3">
          {group.criteria.length === 0 ? (
            <p className="text-[12px] text-muted-foreground/50">No criteria defined.</p>
          ) : (
            <ul className="flex flex-col gap-2">
              {group.criteria.map((c) => {
                const result = latest?.results.find((r) => r.criterionId === c.id)
                return <CriterionRow criterion={c} key={c.id} result={result} />
              })}
            </ul>
          )}
          {verdict === 'fail' && latest && latest.gaps.length > 0 && (
            <div className="mt-3 space-y-1">
              <p className="font-medium text-[11px] text-muted-foreground/60 uppercase tracking-wide">未达成</p>
              <ul className="flex flex-col gap-1">
                {latest.gaps.map((gap, i) => (
                  // biome-ignore lint/suspicious/noArrayIndexKey: gap list has no stable id
                  <li className="text-[12px] text-muted-foreground/70" key={i}>
                    · {gap}
                  </li>
                ))}
              </ul>
            </div>
          )}
        </div>
      )}
    </div>
  )
}

/**
 * Acceptance-criteria checklist + verification verdicts, grouped by top-level
 * task. Rendered inside RightPanel's Verify tab.
 */
export function VerifyPanel({ groups }: Props): React.JSX.Element {
  return (
    <ScrollArea className="min-h-0 flex-1">
      {groups.length === 0 ? (
        <div className="flex flex-col items-center justify-center gap-2 px-4 py-16 text-center text-muted-foreground/60">
          <ShieldCheck className="size-6 opacity-40" />
          <span className="text-[13px]">No verifications yet</span>
        </div>
      ) : (
        <div className="flex flex-col gap-2 px-3 py-4">
          {groups.map((g) => (
            <VerifyGroupBlock group={g} key={g.taskId} />
          ))}
        </div>
      )}
    </ScrollArea>
  )
}
