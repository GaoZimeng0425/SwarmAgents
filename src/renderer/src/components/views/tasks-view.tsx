import { useState } from 'react'
import { providerViewById } from '@shared/types/provider'
import type { ExecutionMode, PermissionMode } from '@shared/types/task'

import { ChatInput } from '@/components/chat-input'
import { ComposerOverlay } from '@/components/composer-overlay'
import { ConversationThread } from '@/components/conversation-thread'
import { RightPanel } from '@/components/right-panel'
import { useProviders } from '@/hooks/use-providers'
import { useCancelTask, useDecidePermission, useSubmitGoal, useTasks } from '@/hooks/use-tasks'
import { usePermissionStore } from '@/stores/permission'
import { useSessionsStore } from '@/stores/sessions'

export function TasksView({ focusTaskId }: { focusTaskId?: string } = {}): React.JSX.Element {
  const tasks = useTasks()
  const queue = usePermissionStore((s) => s.queue)
  const selectedSessionId = useSessionsStore((s) => s.selectedSessionId)
  const submitGoal = useSubmitGoal()
  const cancelTask = useCancelTask()
  const decide = useDecidePermission()
  const { ready, state } = useProviders()

  // Composer execution controls. Held here (not in ChatInput) so every turn in
  // the session — including follow-ups sent from the thread — inherits the same
  // working directory and modes; each turn is a fresh task that needs them.
  const [cwd, setCwd] = useState<string | undefined>(undefined)
  const [permissionMode, setPermissionMode] = useState<PermissionMode>('ask')
  const [executionMode, setExecutionMode] = useState<ExecutionMode>('goal')
  const taskOptions = { cwd, permissionMode, executionMode }

  const sessionTasks = tasks.filter((t) => t.sessionId === selectedSessionId)
  // Runs are sequential per session, so at most one task is in flight; the
  // event reducer prepends newest-first, so find() yields the active run.
  // 'awaiting_user' counts as in-flight: the run is blocked on a permission
  // prompt but still cancellable, and no event resets it back to 'running'.
  const activeTask = sessionTasks.find(
    (t) => t.status === 'running' || t.status === 'pending' || t.status === 'awaiting_user'
  )
  const sessionPrompts = queue.filter((p) => p.sessionId === selectedSessionId)
  const byRecent = [...sessionTasks].sort((a, b) => b.startedAt - a.startedAt)
  // Most recent plan in the session (the agent replaces it wholesale).
  const activePlan = byRecent.find((t) => t.plan && t.plan.length > 0)?.plan
  // Context-window fill for the composer ring follows the most recent task.
  const latestTask = byRecent[0]

  return (
    <div className="flex h-full min-w-0 overflow-hidden">
      <div className="flex min-w-0 flex-1 flex-col">
        <ConversationThread
          // Remount on session switch so StickToBottom's initial="instant" fires:
          // jump straight to the bottom without the smooth-scroll animation.
          key={selectedSessionId}
          focusTaskId={focusTaskId}
          onSend={(text) => {
            if (!ready) return
            void submitGoal.mutateAsync({ goal: text, options: taskOptions })
          }}
          tasks={sessionTasks}
        />
        <ComposerOverlay
          onDecide={(actionId, decision) => {
            const p = sessionPrompts.find((x) => x.actionId === actionId)
            if (!p) return
            decide.mutate({ sessionId: p.sessionId, actionId, decision })
          }}
          prompts={sessionPrompts}
          running={!!activeTask}
          todos={activePlan ?? []}
        />
        <ChatInput
          cacheReadTokens={latestTask?.used?.cacheRead}
          contextTokens={latestTask?.contextTokens}
          contextWindow={latestTask?.contextWindow}
          cwd={cwd}
          disabled={!ready}
          executionMode={executionMode}
          onCwdChange={setCwd}
          onExecutionModeChange={setExecutionMode}
          onPermissionModeChange={setPermissionMode}
          onStop={() => {
            if (activeTask) cancelTask.mutate({ sessionId: activeTask.sessionId, taskId: activeTask.id })
          }}
          onSubmit={async (g, attachments) => {
            if (!ready) return
            await submitGoal.mutateAsync({ goal: g, attachments, options: taskOptions })
          }}
          permissionMode={permissionMode}
          status={activeTask ? (activeTask.status === 'pending' ? 'submitted' : 'streaming') : 'ready'}
          supportsImages={!!providerViewById(state, state.active)?.supportsImages}
          usdCents={latestTask?.used?.usdCents}
        />
      </div>
      <RightPanel plan={activePlan ?? []} />
    </div>
  )
}
