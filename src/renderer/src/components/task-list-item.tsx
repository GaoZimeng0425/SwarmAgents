import { formatDistanceToNow } from 'date-fns'

import { Badge } from '@/components/ui/badge'
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card'
import type { TaskRecord, TaskStatus } from '@/lib/apply-event'
import { formatUsage } from '@/lib/format-usage'

const STATUS_VARIANT: Record<TaskStatus, 'default' | 'secondary' | 'destructive' | 'outline'> = {
  pending: 'outline',
  running: 'default',
  completed: 'secondary',
  failed: 'destructive',
  // biome-ignore lint/style/useNamingConvention: domain TaskStatus literal
  awaiting_user: 'destructive',
}

type Props = {
  task: TaskRecord
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
        {task.workerId ? `worker ${task.workerId} · ` : ''}
        started {formatDistanceToNow(task.startedAt, { addSuffix: true })}
        {task.used ? ` · ${formatUsage(task.used)}` : ''}
      </CardContent>
    </Card>
  )
}
