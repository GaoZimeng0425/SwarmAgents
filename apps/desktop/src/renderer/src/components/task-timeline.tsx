import type { UIEvent } from '@swarm/protocol'
import { formatDistanceToNow } from 'date-fns'

import { Badge } from '@/components/ui/badge'
import { ScrollArea } from '@/components/ui/scroll-area'
import { Separator } from '@/components/ui/separator'
import type { TaskRecord } from '@shared/lib/apply-event'

function eventLabel(e: UIEvent): string {
  switch (e.kind) {
    case 'task.created':
      return `Created: ${e.goal}`
    case 'task.dispatched':
      return `Dispatched to ${e.workerId}`
    case 'task.progress':
      return `Progress: ${e.event.kind}`
    case 'task.tool_call':
      return `tool.call → ${e.tool}`
    case 'task.permission_request':
      return `Permission requested (${e.risk}): ${e.summary}`
    case 'task.complete':
      return `Completed: ${e.summary}`
    case 'task.error':
      return `Error: ${typeof e.error === 'object' && e.error !== null && 'message' in e.error ? String((e.error as { message: unknown }).message) : 'unknown error'}`
    default:
      return (e as { kind: string }).kind
  }
}

type Props = { task: TaskRecord | undefined }

export function TaskTimeline({ task }: Props): React.JSX.Element {
  if (!task) {
    return (
      <div className="flex h-full items-center justify-center text-muted-foreground text-sm">
        Select a task to see its timeline.
      </div>
    )
  }

  return (
    <ScrollArea className="h-full">
      <div className="space-y-3 p-3">
        <div className="flex items-center justify-between">
          <h2 className="font-semibold text-sm">{task.goal}</h2>
          <Badge variant="outline">{task.status}</Badge>
        </div>
        <Separator />
        <ul className="space-y-2">
          {task.events.map((e, i) => (
            // biome-ignore lint/suspicious/noArrayIndexKey: events are append-only
            <li className="text-xs leading-relaxed" key={`${task.id}-${i}`}>
              <span className="mr-2 font-mono text-muted-foreground">
                {formatDistanceToNow(e.ts, { addSuffix: true })}
              </span>
              <span>{eventLabel(e)}</span>
            </li>
          ))}
        </ul>
      </div>
    </ScrollArea>
  )
}
