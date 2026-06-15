import { useEffect } from 'react'

import { ChatInput } from '@/components/chat-input'
import { ConversationThread } from '@/components/conversation-thread'
import { PermissionDrawer } from '@/components/permission-drawer'
import { PlanPanel } from '@/components/plan-panel'
import { useProviders } from '@/hooks/use-providers'
import { useCancelTask, useDecidePermission, useLoadSessions, useSubmitGoal, useTasks } from '@/hooks/use-tasks'
import { usePermissionStore } from '@/stores/permission'
import { useSessionsStore } from '@/stores/sessions'

export function TasksView(): React.JSX.Element {
  const tasks = useTasks()
  const queue = usePermissionStore((s) => s.queue)
  const selectedSessionId = useSessionsStore((s) => s.selectedSessionId)
  const submitGoal = useSubmitGoal()
  const cancelTask = useCancelTask()
  const decide = useDecidePermission()
  const loadSessions = useLoadSessions()
  const { ready } = useProviders()

  // Load the session list once on mount.
  // biome-ignore lint/correctness/useExhaustiveDependencies: mount-only; loadSessions is a stable React Query mutation
  useEffect(() => {
    loadSessions.mutate()
  }, [])

  const sessionTasks = tasks.filter((t) => t.sessionId === selectedSessionId)
  // Runs are sequential per session, so at most one task is in flight; the
  // event reducer prepends newest-first, so find() yields the active run.
  const activeTask = sessionTasks.find((t) => t.status === 'running' || t.status === 'pending')
  const currentPrompt = queue.find((p) => p.sessionId === selectedSessionId) ?? null
  // Most recent plan in the session (the agent replaces it wholesale).
  const activePlan = [...sessionTasks]
    .sort((a, b) => b.startedAt - a.startedAt)
    .find((t) => t.plan && t.plan.length > 0)?.plan

  return (
    <div className="flex h-full">
      <div className="flex min-w-0 flex-1 flex-col">
        <ConversationThread tasks={sessionTasks} />
        <PermissionDrawer
          onDecide={(actionId, decision) => {
            if (!currentPrompt) return
            decide.mutate({ sessionId: currentPrompt.sessionId, actionId, decision })
          }}
          prompt={currentPrompt}
        />
        <ChatInput
          disabled={!ready}
          onStop={() => {
            if (activeTask) cancelTask.mutate({ sessionId: activeTask.sessionId, taskId: activeTask.id })
          }}
          onSubmit={async (g) => {
            if (!ready) return
            await submitGoal.mutateAsync(g)
          }}
          running={!!activeTask}
        />
      </div>
      {activePlan && <PlanPanel todos={activePlan} />}
    </div>
  )
}
