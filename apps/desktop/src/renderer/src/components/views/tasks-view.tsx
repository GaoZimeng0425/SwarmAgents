import type { ExecutionMode, PermissionMode, SessionSettings } from '@swarm/protocol'
import { providerViewById } from '@swarm/protocol'
import { sortBy } from 'es-toolkit'

import { ChatInput } from '@/components/chat-input'
import { ComposerOverlay } from '@/components/composer-overlay'
import { ConversationThread } from '@/components/conversation-thread'
import { OrchestrationGraph } from '@/components/orchestration/OrchestrationGraph'
import { SessionHeader } from '@/components/session-header'
import { ScheduledResultsView } from '@/components/views/scheduled-results-view'
import { WorkspacePanel } from '@/components/workspace/workspace-panel'
import { useTeamOptions } from '@/hooks/use-agents'
import { useDelegationPlan } from '@/hooks/use-delegation-plan'
import {
  useCancelMessage,
  useDecidePermission,
  useMessages,
  usePromoteQueuedMessage,
  useSubmitPrompt,
} from '@/hooks/use-messages'
import { useProviders } from '@/hooks/use-providers'
import { swarmApi } from '@/lib/api'
import { classifyComposerTurns } from '@/lib/composer-turns'
import { latestTopLevelTask, sessionDisplayUsage } from '@/lib/session-usage'
import { usePermissionStore } from '@/stores/permission'
import { useSessionsStore } from '@/stores/sessions'

export function TasksView({ focusTaskId }: { focusTaskId?: string } = {}): React.JSX.Element {
  const tasks = useMessages()
  const queue = usePermissionStore((s) => s.queue)
  const selectedSessionId = useSessionsStore((s) => s.selectedSessionId)
  const sessions = useSessionsStore((s) => s.sessions)
  const forkedFrom = useSessionsStore((s) => s.forkedFrom)
  const setSessionSettings = useSessionsStore((s) => s.setSettings)
  const submitPrompt = useSubmitPrompt()
  const decide = useDecidePermission()
  const cancelMessage = useCancelMessage()
  const promoteQueuedMessage = usePromoteQueuedMessage()
  const { ready, state } = useProviders()

  const sessionTasks = tasks.filter((t) => t.sessionId === selectedSessionId)
  // Runs are sequential per session, so at most one turn is in flight. A turn is
  // 'pending' from task.created until task.dispatched flips it to 'running', and
  // the DB keeps a running turn 'pending' until it ends — so the active turn is
  // briefly 'pending' too. classifyComposerTurns promotes the earliest pending
  // turn to active when nothing is running (instead of flashing it as a staging
  // card) and queues the rest FIFO; sub-agent children are excluded.
  // A non-active (interrupted/ended) session can't run any queued turn, so pass
  // its status to classifyComposerTurns to avoid painting zombie pending turns
  // as staging cards. Default to 'active' until the session list has loaded.
  const sessionStatus = sessions.find((s) => s.id === selectedSessionId)?.status ?? 'active'
  const { activeTask: runningTask, queuedTasks, transcriptTasks } = classifyComposerTurns(sessionTasks, sessionStatus)
  const sessionPrompts = queue.filter((p) => p.sessionId === selectedSessionId)
  // Session execution history: each top-level turn that produced a plan becomes
  // a group, ordered oldest-first so the panel reads top-to-bottom as the run
  // order. The agent replaces its plan per turn, but every turn persists its own
  // copy, so grouping by task preserves the whole history.
  const planGroups = sortBy(
    sessionTasks.filter((t) => !t.parentMessageId && t.plan && t.plan.length > 0),
    ['createdAt']
  ).map((t) => ({ messageId: t.id, prompt: t.prompt, plan: t.plan ?? [], status: t.status, createdAt: t.createdAt }))
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
  // Delegation plan state: when present, the orchestration graph panel renders
  // above the conversation thread (only for sessions that emit a plan).
  const planState = useDelegationPlan(selectedSessionId)

  // Each session remembers its own composer controls (working directory,
  // permission gate, execution mode). They're persisted on the session row, so
  // the store entry is the source of truth: switching sessions shows that
  // session's saved values, and editing one writes straight back (persisted even
  // without sending a turn).
  const session = sessions.find((s) => s.id === selectedSessionId)
  // Context tokens/window are session-level (read from SessionSummary, not the
  // message record). The session list SQL extracts the latest top-level message's
  // values; live updates flow through use-events-subscription.
  const contextTokens = session?.contextTokens
  const contextWindow = session?.contextWindow
  const cwd = session?.cwd
  const permissionMode = session?.permissionMode ?? 'ask'
  const executionMode = session?.executionMode ?? 'direct'
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

  // Header status pill: awaiting approval outranks running (a paused turn is
  // still "your move"); otherwise idle. Context readout follows the same latest
  // top-level turn as the composer ring.
  const headerStatus = sessionPrompts.length > 0 ? 'awaiting' : runningTask ? 'running' : 'idle'
  const contextPct =
    contextTokens != null && contextWindow != null ? Math.round((contextTokens / contextWindow) * 100) : undefined
  // Fork lineage for the current session, if any. Client-side only — see the
  // forkedFrom map in the sessions store.
  const forkSourceId = selectedSessionId ? forkedFrom[selectedSessionId] : undefined

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
    <div className="relative flex h-full min-w-0 overflow-hidden">
      <div className="flex min-w-0 flex-1 flex-col bg-(--surface-chat)">
        <SessionHeader
          contextPct={contextPct}
          forkedFrom={forkSourceId}
          status={headerStatus}
          title={session?.title ?? '对话'}
        />
        {planState && planState.size > 0 && (
          <div className="border-b p-3">
            <div className="mb-2 font-medium text-gray-500 text-xs">Orchestration</div>
            <OrchestrationGraph />
          </div>
        )}
        <ConversationThread
          focusTaskId={focusTaskId}
          // Remount on session switch so StickToBottom's initial="instant" fires:
          // jump straight to the bottom without the smooth-scroll animation.
          key={selectedSessionId}
          onSend={(text) => {
            if (!ready) return
            void submitPrompt.mutateAsync({ prompt: text, options: taskOptions })
          }}
          tasks={transcriptTasks}
        />
        <ChatInput
          agentType={agentType}
          cacheReadTokens={latestTask?.used?.cacheRead}
          contextTokens={contextTokens}
          contextWindow={contextWindow}
          cwd={cwd}
          disabled={!ready}
          executionMode={executionMode}
          onAgentTypeChange={setAgentType}
          onCwdChange={setCwd}
          onExecutionModeChange={setExecutionMode}
          onPermissionModeChange={setPermissionMode}
          onStop={() => {
            if (runningTask) cancelMessage.mutate({ sessionId: runningTask.sessionId, messageId: runningTask.id })
          }}
          onSubmit={async (g, attachments) => {
            if (!ready) return
            await submitPrompt.mutateAsync({ prompt: g, attachments, options: taskOptions })
          }}
          overlay={
            <ComposerOverlay
              onCancelQueued={(messageId) => {
                if (selectedSessionId) cancelMessage.mutate({ sessionId: selectedSessionId, messageId })
              }}
              onDecide={(actionId, decision) => {
                const p = sessionPrompts.find((x) => x.actionId === actionId)
                if (!p) return
                decide.mutate({ sessionId: p.sessionId, actionId, decision })
              }}
              onInterrupt={(messageId) => {
                if (selectedSessionId) promoteQueuedMessage.mutate({ sessionId: selectedSessionId, messageId })
              }}
              prompts={sessionPrompts}
              queued={queuedTasks.map((t) => ({ id: t.id, sessionId: t.sessionId, prompt: t.prompt }))}
              running={!!runningTask}
              todos={activePlan ?? []}
            />
          }
          permissionMode={permissionMode}
          running={!!runningTask}
          supportsImages={!!providerViewById(state, state.active)?.supportsImages}
          teamOptions={teamOptions}
          usdCents={sessionUsage?.usdCents}
        />
      </div>
      <WorkspacePanel
        messages={sessionTasks}
        onDecide={(actionId, decision) => {
          const p = sessionPrompts.find((x) => x.actionId === actionId)
          if (!p) return
          decide.mutate({ sessionId: p.sessionId, actionId, decision })
        }}
        planGroups={planGroups}
        session={session}
      />
    </div>
  )
}
