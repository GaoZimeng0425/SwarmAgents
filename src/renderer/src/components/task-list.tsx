import { ScrollArea } from '@/components/ui/scroll-area'
import type { TaskRecord } from '@/lib/apply-event'
import { useUiStore } from '@/stores/ui'

import { TaskListItem } from './task-list-item'

type Props = { tasks: TaskRecord[] }

export function TaskList({ tasks }: Props): React.JSX.Element {
  const selected = useUiStore((s) => s.selectedTaskId)
  const setSelected = useUiStore((s) => s.setSelected)

  if (tasks.length === 0) {
    return (
      <div className="flex h-full items-center justify-center text-sm text-muted-foreground">
        No tasks yet.
      </div>
    )
  }

  return (
    <ScrollArea className="h-full">
      <div className="flex flex-col gap-2 p-3">
        {tasks.map((t) => (
          <TaskListItem
            key={t.id}
            task={t}
            selected={selected === t.id}
            onSelect={setSelected}
          />
        ))}
      </div>
    </ScrollArea>
  )
}
