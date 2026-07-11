// apps/desktop/src/renderer/src/components/palette/preview/task-run.tsx
// Live preview of a running/pending task: goal + a progress bar derived from
// the plan (completed / total) + a 实时日志 tail of the last 20 tool.call /
// llm.message events from the session, rendered as monospace lines.
import { useQuery } from '@tanstack/react-query'

import { swarmApi } from '../../../lib/api'
import type { PreviewData } from '../../../lib/palette/types'

export type TaskRunPreviewData = Extract<PreviewData, { type: 'taskRun' }>

export function TaskRunPreview({ data }: { data: TaskRunPreviewData }): React.JSX.Element {
  const { run, sessionId } = data
  const plan = run.plan ?? []
  const done = plan.filter((p) => p.status === 'completed').length
  const total = plan.length
  const pct = total > 0 ? Math.round((done / total) * 100) : 0

  const q = useQuery({
    queryKey: ['session-preview', sessionId],
    queryFn: () => swarmApi.getRunEvents(sessionId),
    enabled: !!sessionId,
    staleTime: 5_000,
  })

  // Tail of the live log: run.progress events whose nested TaskEvent is either
  // a tool.call or an llm.message, newest 20.
  const log = (q.data ?? [])
    .filter(
      (r) =>
        r.event.kind === 'run.progress' &&
        ((r.event as any).event?.kind === 'tool.call' || (r.event as any).event?.kind === 'llm.message')
    )
    .slice(-20)

  return (
    <div className="p-4">
      <h4 className="font-semibold text-sm">{run.prompt}</h4>
      {run.summary && <p className="mt-1 text-muted-foreground text-xs">{run.summary}</p>}

      {/* Progress bar: only meaningful when the plan has steps. */}
      <div className="mt-3">
        <div className="flex justify-between text-muted-foreground text-xs">
          <span>进度</span>
          <span>{total > 0 ? `${done}/${total}` : run.status}</span>
        </div>
        <div className="mt-1 h-1.5 w-full overflow-hidden rounded-full bg-muted">
          <div className="h-full rounded-full bg-primary transition-all" style={{ width: `${pct}%` }} />
        </div>
      </div>

      <div className="mt-3 text-muted-foreground text-xs">实时日志</div>
      {q.isLoading ? (
        <div className="mt-1 text-muted-foreground text-xs">加载中…</div>
      ) : log.length === 0 ? (
        <div className="mt-1 font-mono text-muted-foreground text-xs">暂无日志</div>
      ) : (
        <div className="cmdscroll mt-1 max-h-48 overflow-y-auto rounded-md bg-muted/50 p-2 font-mono text-[11px] leading-relaxed">
          {log.map((l, i) => {
            const ev = (l.event as any).event
            if (ev.kind === 'tool.call') {
              return (
                <div className="truncate" key={i}>
                  <span className="text-muted-foreground">→ {String(ev.tool)}</span>{' '}
                  <span className="text-foreground/70">{stringifyShort(ev.args)}</span>
                </div>
              )
            }
            const role = ev.role === 'user' ? '你' : ev.role === 'assistant' ? 'Agent' : '工具'
            return (
              <div className="truncate" key={i}>
                <span className="font-medium">{role}:</span>{' '}
                <span className="text-foreground/70">{String(ev.content ?? '').slice(0, 120)}</span>
              </div>
            )
          })}
        </div>
      )}
    </div>
  )
}

/** Compact stringification for tool args in the log tail. */
function stringifyShort(value: unknown): string {
  if (value == null) return ''
  if (typeof value === 'string') return value.slice(0, 120)
  try {
    return JSON.stringify(value).slice(0, 120)
  } catch {
    return String(value).slice(0, 120)
  }
}
