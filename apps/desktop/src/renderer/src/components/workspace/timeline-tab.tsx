// apps/desktop/src/renderer/src/components/workspace/timeline-tab.tsx
// Timeline tab — flat event log over the session's runs.

import { CheckCircle2, PlayCircle, Rocket, ShieldAlert, Wrench, XCircle } from 'lucide-react'

import type { TimelineKind, TimelineRow } from '@/lib/workspace/build-timeline'

type Props = { rows: TimelineRow[] }

const ICONS: Record<TimelineKind, { Icon: typeof Rocket; className: string }> = {
  start: { Icon: Rocket, className: 'text-primary' },
  dispatch: { Icon: PlayCircle, className: 'text-muted-foreground' },
  tool: { Icon: Wrench, className: 'text-muted-foreground' },
  permission: { Icon: ShieldAlert, className: 'text-amber-600' },
  complete: { Icon: CheckCircle2, className: 'text-emerald-600' },
  error: { Icon: XCircle, className: 'text-destructive' },
}

function hhmm(ts: number): string {
  const d = new Date(ts)
  return `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`
}

export function TimelineTab({ rows }: Props): React.JSX.Element {
  if (rows.length === 0) {
    return <div className="p-4 text-muted-foreground text-sm">还没有事件</div>
  }
  return (
    <ul className="cmdscroll flex-1 space-y-1 overflow-y-auto p-3">
      {rows.map((r) => {
        const { Icon, className } = ICONS[r.kind]
        return (
          <li className="flex items-center gap-2 text-xs" key={r.id}>
            <span className="font-mono text-muted-foreground tabular-nums">{hhmm(r.ts)}</span>
            <Icon className={`${className} size-3.5 shrink-0`} />
            <span className="truncate" title={r.label}>
              {r.label}
            </span>
          </li>
        )
      })}
    </ul>
  )
}
