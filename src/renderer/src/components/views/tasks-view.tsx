import { PermissionSheet } from '@/components/permission-sheet'
import { TaskInput } from '@/components/task-input'
import { TaskList } from '@/components/task-list'
import { TaskTimeline } from '@/components/task-timeline'
import {
  ResizableHandle,
  ResizablePanel,
  ResizablePanelGroup,
} from '@/components/ui/resizable'
import { useDecidePermission, useSubmitGoal, useTasks } from '@/hooks/use-tasks'
import { usePermissionStore } from '@/stores/permission'
import { useUiStore } from '@/stores/ui'

export function TasksView(): React.JSX.Element {
  const tasks = useTasks()
  const queue = usePermissionStore((s) => s.queue)
  const selectedTaskId = useUiStore((s) => s.selectedTaskId)
  const selected = tasks.find((t) => t.id === selectedTaskId) ?? tasks[0]
  const submitGoal = useSubmitGoal()
  const decide = useDecidePermission()

  return (
    <div className="flex h-full flex-col">
      <TaskInput
        disabled={submitGoal.isPending}
        onSubmit={async (g) => {
          await submitGoal.mutateAsync(g)
        }}
      />
      <ResizablePanelGroup orientation="horizontal" className="flex-1">
        <ResizablePanel defaultSize={40} minSize={25}>
          <TaskList tasks={tasks} />
        </ResizablePanel>
        <ResizableHandle />
        <ResizablePanel minSize={30}>
          <TaskTimeline task={selected} />
        </ResizablePanel>
      </ResizablePanelGroup>
      <PermissionSheet
        prompt={queue[0] ?? null}
        onDecide={(actionId, decision) => decide.mutate({ actionId, decision })}
      />
    </div>
  )
}
