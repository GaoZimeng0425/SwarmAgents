import { providerViewById } from '@shared/types/provider'

import { ChatInput } from '@/components/chat-input'
import { ConversationThread } from '@/components/conversation-thread'
import { PermissionDrawer } from '@/components/permission-drawer'
import { RightPanel } from '@/components/right-panel'
import { useProviders } from '@/hooks/use-providers'
import { useCancelTask, useDecidePermission, useSubmitGoal, useTasks } from '@/hooks/use-tasks'
import { usePermissionStore } from '@/stores/permission'
import { useSessionsStore } from '@/stores/sessions'

export function TasksView(): React.JSX.Element {
  const tasks = useTasks()
  const queue = usePermissionStore((s) => s.queue)
  const selectedSessionId = useSessionsStore((s) => s.selectedSessionId)
  const submitGoal = useSubmitGoal()
  const cancelTask = useCancelTask()
  const decide = useDecidePermission()
  const { ready, state } = useProviders()

  const sessionTasks = tasks.filter((t) => t.sessionId === selectedSessionId)
  // Runs are sequential per session, so at most one task is in flight; the
  // event reducer prepends newest-first, so find() yields the active run.
  // 'awaiting_user' counts as in-flight: the run is blocked on a permission
  // prompt but still cancellable, and no event resets it back to 'running'.
  const activeTask = sessionTasks.find(
    (t) => t.status === 'running' || t.status === 'pending' || t.status === 'awaiting_user'
  )
  const currentPrompt = queue.find((p) => p.sessionId === selectedSessionId) ?? null
  const byRecent = [...sessionTasks].sort((a, b) => b.startedAt - a.startedAt)
  // Most recent plan in the session (the agent replaces it wholesale).
  const activePlan = byRecent.find((t) => t.plan && t.plan.length > 0)?.plan
  // Context-window fill for the composer ring follows the most recent task.
  const latestTask = byRecent[0]

  return (
    <div className="flex h-full min-w-0 overflow-hidden">
      <div className="flex min-w-0 flex-1 flex-col">
        <ConversationThread
          onSend={(text) => {
            if (!ready) return
            void submitGoal.mutateAsync({ goal: text })
          }}
          tasks={sessionTasks}
        />
        <PermissionDrawer
          onDecide={(actionId, decision) => {
            if (!currentPrompt) return
            decide.mutate({ sessionId: currentPrompt.sessionId, actionId, decision })
          }}
          prompt={currentPrompt}
        />
        <ChatInput
          cacheReadTokens={latestTask?.used?.cacheRead}
          contextTokens={latestTask?.contextTokens}
          contextWindow={latestTask?.contextWindow}
          disabled={!ready}
          onStop={() => {
            if (activeTask) cancelTask.mutate({ sessionId: activeTask.sessionId, taskId: activeTask.id })
          }}
          onSubmit={async (g, attachments) => {
            if (!ready) return
            await submitGoal.mutateAsync({ goal: g, attachments })
          }}
          status={activeTask ? (activeTask.status === 'pending' ? 'submitted' : 'streaming') : 'ready'}
          supportsImages={!!providerViewById(state, state.active)?.supportsImages}
          usdCents={latestTask?.used?.usdCents}
        />
      </div>
      <RightPanel plan={activePlan ?? []} />
    </div>
  )
}
