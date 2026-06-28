import { providerViewById } from '@shared/types/provider'
import type { ExecutionMode, PermissionMode } from '@shared/types/task'
import type { SessionSettings } from '@shared/types/ui'

import { ChatInput } from '@/components/chat-input'
import { ComposerOverlay } from '@/components/composer-overlay'
import { ConversationThread } from '@/components/conversation-thread'
import { RightPanel } from '@/components/right-panel'
import { ScheduledResultsView } from '@/components/views/scheduled-results-view'
import { useTeamOptions } from '@/hooks/use-agents'
import { useProviders } from '@/hooks/use-providers'
import { useCancelTask, useDecidePermission, useInterruptWith, useSubmitGoal, useTasks } from '@/hooks/use-tasks'
import { swarmApi } from '@/lib/api'
import { classifyComposerTurns } from '@/lib/composer-turns'
import { latestTopLevelTask, sessionDisplayUsage } from '@/lib/session-usage'
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
  const cancelTask = useCancelTask()
  const interruptWith = useInterruptWith()
  const { ready, state } = useProviders()

  const sessionTasks = tasks.filter((t) => t.sessionId === selectedSessionId)
  // Runs are sequential per session, so at most one turn is in flight. A turn is
  // 'pending' from task.created until task.dispatched flips it to 'running', and
  // the DB keeps a running turn 'pending' until it ends — so the active turn is
  // briefly 'pending' too. classifyComposerTurns promotes the earliest pending
  // turn to active when nothing is running (instead of flashing it as a staging
  // card) and queues the rest FIFO; sub-agent children are excluded.
  const { activeTask: runningTask, queuedTasks, transcriptTasks } = classifyComposerTurns(sessionTasks)
  const sessionPrompts = queue.filter((p) => p.sessionId === selectedSessionId)
  // Session execution history: each top-level turn that produced a plan becomes
  // a group, ordered oldest-first so the panel reads top-to-bottom as the run
  // order. The agent replaces its plan per turn, but every turn persists its own
  // copy, so grouping by task preserves the whole history.
  const planGroups = sessionTasks
    .filter((t) => !t.parentTaskId && t.plan && t.plan.length > 0)
    .sort((a, b) => a.startedAt - b.startedAt)
    .map((t) => ({ taskId: t.id, goal: t.goal, plan: t.plan ?? [], status: t.status, startedAt: t.startedAt }))
  // Per top-level task that defined acceptance criteria: its criteria + the
  // latest verify verdict, oldest-first to match the plan history order.
  const verifyGroups = sessionTasks
    .filter((t) => !t.parentTaskId && t.acceptanceCriteria && t.acceptanceCriteria.length > 0)
    .sort((a, b) => a.startedAt - b.startedAt)
    .map((t) => ({
      taskId: t.id,
      goal: t.goal,
      criteria: t.acceptanceCriteria ?? [],
      latest: t.verifications && t.verifications.length > 0 ? t.verifications[t.verifications.length - 1] : null,
      status: t.status,
      startedAt: t.startedAt,
    }))
  // The composer's inline todo strip shows only the in-flight turn's plan
  // (the latest group) — a live "what's happening now" strip, not history.
  const activePlan = planGroups[planGroups.length - 1]?.plan
  // Context-window fill for the composer ring follows the most recent top-level
  // turn (a "current context size" gauge). Sub-agent children sort newer but
  // carry no usage once rehydrated from disk, so they must be excluded or the
  // ring blanks on restart.
  const latestTask = latestTopLevelTask(sessionTasks)
  // Cost shown on the ring is the cumulative session total (matches the session
  // list), not just the latest turn — see sessionDisplayUsage.
  const sessionUsage = sessionDisplayUsage(sessionTasks)

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

  // The system session ("定时任务") only surfaces scheduled-run RESULTS — it is
  // read-only: no composer, no send/queue overlay, no right panel. Everything
  // else (a normal chat) renders the full composer below.
  if (session?.isSystem) {
    return (
      <div className="flex h-full min-w-0 overflow-hidden">
        <div className="flex min-w-0 flex-1 flex-col">
          <ScheduledResultsView focusTaskId={focusTaskId} tasks={sessionTasks} />
        </div>
      </div>
    )
  }

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
          tasks={transcriptTasks}
        />
        <ComposerOverlay
          onCancelQueued={(taskId) => {
            if (selectedSessionId) cancelTask.mutate({ sessionId: selectedSessionId, taskId })
          }}
          onDecide={(actionId, decision) => {
            const p = sessionPrompts.find((x) => x.actionId === actionId)
            if (!p) return
            decide.mutate({ sessionId: p.sessionId, actionId, decision })
          }}
          onInterrupt={(taskId) => {
            if (selectedSessionId) interruptWith.mutate({ sessionId: selectedSessionId, taskId })
          }}
          prompts={sessionPrompts}
          queued={queuedTasks.map((t) => ({ id: t.id, sessionId: t.sessionId, goal: t.goal }))}
          running={!!runningTask}
          todos={activePlan ?? []}
        />
        <ChatInput
          agentType={agentType}
          cacheReadTokens={latestTask?.used?.cacheRead}
          contextTokens={latestTask?.contextTokens}
          contextWindow={latestTask?.contextWindow}
          cwd={cwd}
          disabled={!ready}
          executionMode={executionMode}
          onAgentTypeChange={setAgentType}
          onCwdChange={setCwd}
          onExecutionModeChange={setExecutionMode}
          onPermissionModeChange={setPermissionMode}
          onStop={() => {
            if (runningTask) cancelTask.mutate({ sessionId: runningTask.sessionId, taskId: runningTask.id })
          }}
          onSubmit={async (g, attachments) => {
            if (!ready) return
            await submitGoal.mutateAsync({ goal: g, attachments, options: taskOptions })
          }}
          permissionMode={permissionMode}
          running={!!runningTask}
          supportsImages={!!providerViewById(state, state.active)?.supportsImages}
          teamOptions={teamOptions}
          usdCents={sessionUsage?.usdCents}
        />
      </div>
      <RightPanel planGroups={planGroups} verifyGroups={verifyGroups} />
    </div>
  )
}
