import { providerViewById } from '@shared/types/provider'
import type { ExecutionMode, PermissionMode } from '@shared/types/task'
import type { SessionSettings } from '@shared/types/ui'

import { ChatInput } from '@/components/chat-input'
import { ComposerOverlay } from '@/components/composer-overlay'
import { ConversationThread } from '@/components/conversation-thread'
import { RightPanel } from '@/components/right-panel'
import { useTeamOptions } from '@/hooks/use-agents'
import { useProviders } from '@/hooks/use-providers'
import { useDecidePermission, useSubmitGoal, useTasks } from '@/hooks/use-tasks'
import { swarmApi } from '@/lib/api'
import { usePermissionStore } from '@/stores/permission'
import { useSessionsStore } from '@/stores/sessions'

export function TasksView({ focusTaskId }: { focusTaskId?: string } = {}): React.JSX.Element {
  const tasks = useTasks()
  const queue = usePermissionStore((s) => s.queue)
  const selectedSessionId = useSessionsStore((s) => s.selectedSessionId)
  const sessions = useSessionsStore((s) => s.sessions)
  const setSessionSettings = useSessionsStore((s) => s.setSettings)
  const submitGoal = useSubmitGoal()
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
  const sessionPrompts = queue.filter((p) => p.sessionId === selectedSessionId)
  const byRecent = [...sessionTasks].sort((a, b) => b.startedAt - a.startedAt)
  // Most recent plan in the session (the agent replaces it wholesale).
  const activePlan = byRecent.find((t) => t.plan && t.plan.length > 0)?.plan
  // Context-window fill for the composer ring follows the most recent task.
  const latestTask = byRecent[0]

  // Each session remembers its own composer controls (working directory,
  // permission gate, execution mode). They're persisted on the session row, so
  // the store entry is the source of truth: switching sessions shows that
  // session's saved values, and editing one writes straight back (persisted even
  // without sending a turn).
  const session = sessions.find((s) => s.id === selectedSessionId)
  const cwd = session?.cwd
  const permissionMode = session?.permissionMode ?? 'ask'
  const executionMode = session?.executionMode ?? 'goal'
  const agentType = session?.agentType ?? 'ceo'
  const teamOptions = useTeamOptions()
  const persistSettings = (patch: Partial<SessionSettings>): void => {
    if (!selectedSessionId) return
    const next: SessionSettings = { cwd, permissionMode, executionMode, agentType, ...patch }
    setSessionSettings(selectedSessionId, next)
    void swarmApi.updateSessionSettings(selectedSessionId, next)
  }
  const setCwd = (next: string | undefined): void => persistSettings({ cwd: next })
  const setPermissionMode = (next: PermissionMode): void => persistSettings({ permissionMode: next })
  const setExecutionMode = (next: ExecutionMode): void => persistSettings({ executionMode: next })
  const setAgentType = (id: string): void => persistSettings({ agentType: id })
  const taskOptions = { cwd, permissionMode, executionMode, agentType }

  return (
    <div className="flex h-full min-w-0 overflow-hidden">
      <div className="flex min-w-0 flex-1 flex-col">
        <ConversationThread
          focusTaskId={focusTaskId}
          // Remount on session switch so StickToBottom's initial="instant" fires:
          // jump straight to the bottom without the smooth-scroll animation.
          key={selectedSessionId}
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
          agentType={agentType}
          cwd={cwd}
          disabled={!ready}
          teamOptions={teamOptions}
          executionMode={executionMode}
          onAgentTypeChange={setAgentType}
          onCwdChange={setCwd}
          onExecutionModeChange={setExecutionMode}
          onPermissionModeChange={setPermissionMode}
          onSubmit={async (g, attachments) => {
            if (!ready) return
            await submitGoal.mutateAsync({ goal: g, attachments, options: taskOptions })
          }}
          permissionMode={permissionMode}
          supportsImages={!!providerViewById(state, state.active)?.supportsImages}
          usdCents={latestTask?.used?.usdCents}
        />
      </div>
      <RightPanel plan={activePlan ?? []} />
    </div>
  )
}
