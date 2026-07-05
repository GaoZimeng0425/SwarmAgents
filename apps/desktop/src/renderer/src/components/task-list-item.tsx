import type { RunRecord, RunStatus } from '@shared/lib/apply-event'
import { Badge, Card, CardContent, CardHeader, CardTitle } from '@swarm/ui'
import { formatDistanceToNow } from 'date-fns'

import { formatUsage, usageTooltip } from '@/lib/format-usage'

const STATUS_VARIANT: Record<RunStatus, 'default' | 'secondary' | 'destructive' | 'outline'> = {
  pending: 'outline',
  running: 'default',
  completed: 'secondary',
  failed: 'destructive',
  cancelled: 'outline',
  // biome-ignore lint/style/useNamingConvention: domain RunStatus literal
  awaiting_user: 'destructive',
}

type Props = {
  task: RunRecord
  selected: boolean
  onSelect: (id: string) => void
}

export function TaskListItem({ task, selected, onSelect }: Props): React.JSX.Element {
  return (
    <Card
      className="data-[selected=true]:ring-2 data-[selected=true]:ring-primary"
      data-selected={selected}
      onClick={() => onSelect(task.id)}
    >
      <CardHeader className="pb-2">
        <CardTitle className="flex items-center justify-between gap-2 text-sm">
          <span className="truncate">{task.goal}</span>
          <Badge variant={STATUS_VARIANT[task.status]}>{task.status}</Badge>
        </CardTitle>
      </CardHeader>
      <CardContent className="text-muted-foreground text-xs">
        started {formatDistanceToNow(task.startedAt, { addSuffix: true })}
        {task.used ? <span title={usageTooltip(task.used)}> · {formatUsage(task.used)}</span> : ''}
      </CardContent>
    </Card>
  )
}
