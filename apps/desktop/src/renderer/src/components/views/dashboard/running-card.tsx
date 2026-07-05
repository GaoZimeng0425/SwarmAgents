// One card in the dashboard's 进行中 wall. Two visual modes:
//   - running/pending → blue dot + elapsed wall time
//   - awaiting_user   → amber border/ring + inline 允许/拒绝 buttons
// Clicking the card opens its session; the approve/reject buttons stop
// propagation so they resolve inline without navigating.

import { useNavigate } from '@tanstack/react-router'
import { Check, X } from 'lucide-react'

import { useDecidePermission } from '@/hooks/use-runs'
import type { DashboardRun } from '@/lib/dashboard-runs'
import { formatDuration } from '@/lib/scheduled-rows'
import { cn } from '@/lib/utils'
import { usePermissionStore } from '@/stores/permission'

type Props = { run: DashboardRun }

export function RunningCard({ run }: Props): React.JSX.Element {
  const navigate = useNavigate()
  const decidePermission = useDecidePermission()
  const awaiting = run.status === 'awaiting_user'
  // The pending permission action id for this run's session, if any. The
  // permission store keeps prompts in `queue` (an array of PermissionPrompt),
  // keyed by actionId; we find the one matching this run's session.
  const actionId = usePermissionStore((s) => s.queue.find((p) => p.sessionId === run.sessionId)?.actionId ?? null)

  const open = (): void => {
    void navigate({ to: '/session/$sessionId', params: { sessionId: run.sessionId } })
  }

  const decide = (decision: 'grant' | 'deny') => {
    if (actionId) decidePermission.mutate({ sessionId: run.sessionId, actionId, decision })
  }

  return (
    // Outer card is a div (not a button) so the inner 允许/拒绝 can be real
    // <button>s — valid HTML (no nested buttons). Keyboard users activate
    // navigation via Enter/Space on this div.
    // biome-ignore lint/a11y/useSemanticElements: a real <button> here would force the inner 允许/拒绝 into nested buttons (invalid HTML); the div+role compromise keeps both accessible and valid.
    <div
      className={cn(
        'flex w-full cursor-pointer flex-col gap-2.5 rounded-2xl border bg-card p-4 text-left transition-colors hover:bg-accent/30',
        awaiting ? 'border-amber-400 shadow-[0_0_0_3px_rgba(226,176,107,0.14)]' : 'border-border'
      )}
      onClick={open}
      onKeyDown={(e) => {
        if (e.key === 'Enter' || e.key === ' ') {
          e.preventDefault()
          open()
        }
      }}
      role="button"
      tabIndex={0}
    >
      <div className="flex items-center gap-1.5">
        <span
          className={cn(
            'size-[7px] rounded-full',
            awaiting ? 'bg-amber-500' : 'bg-primary shadow-[0_0_0_3px_rgba(52,120,246,0.18)]'
          )}
        />
        <span className={cn('font-medium text-[11.5px]', awaiting ? 'text-amber-600' : 'text-primary')}>
          {awaiting ? '等待审批' : `运行中 · ${formatDuration(run.wallMs)}`}
        </span>
      </div>

      <h3 className="line-clamp-1 font-semibold text-[14px] text-foreground">{run.goal}</h3>

      {run.steps && (
        <div className="mt-auto flex items-center justify-between text-[11.5px] text-muted-foreground">
          <span className="truncate">{run.cwd ?? run.agentLabel ?? '—'}</span>
          <span className="ml-2 shrink-0 tabular-nums">{run.steps}</span>
        </div>
      )}

      {awaiting && (
        // Real buttons (not nested in a <button>) — onClick stopPropagation so
        // they resolve inline without triggering the card's navigation.
        <div className="flex gap-2">
          <button
            className="flex-1 rounded-lg bg-foreground py-1.5 text-center font-semibold text-[12px] text-background transition-opacity hover:opacity-90"
            onClick={(e) => {
              e.stopPropagation()
              decide('grant')
            }}
            type="button"
          >
            <Check className="mr-1 inline size-3" />
            允许
          </button>
          <button
            className="flex-1 rounded-lg border border-border py-1.5 text-center font-medium text-[12px] text-muted-foreground transition-colors hover:bg-accent/40"
            onClick={(e) => {
              e.stopPropagation()
              decide('deny')
            }}
            type="button"
          >
            <X className="mr-1 inline size-3" />
            拒绝
          </button>
        </div>
      )}
    </div>
  )
}
