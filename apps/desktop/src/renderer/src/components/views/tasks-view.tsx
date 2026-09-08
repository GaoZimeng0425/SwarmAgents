import type { ExecutionMode, PermissionMode, PlanTodo, SessionSettings } from '@swarm/protocol'
import { providerViewById } from '@swarm/protocol'
import type { SessionView } from '@swarm/shared'

import { ChatInput } from '@/components/chat-input'
import { ComposerOverlay } from '@/components/composer-overlay'
import { ConversationThread } from '@/components/conversation-thread'
import type { PlanGroup } from '@/components/plan-panel'
import { SessionHeader } from '@/components/session-header'
import { ScheduledResultsView } from '@/components/views/scheduled-results-view'
import { WorkspacePanel } from '@/components/workspace/workspace-panel'
import { useTeamOptions } from '@/hooks/use-agents'
import { useCancelRun, useDecidePermission, useSubmitPrompt } from '@/hooks/use-messages'
import { useProviders } from '@/hooks/use-providers'
import { useSessionView } from '@/hooks/use-session-view'
import { swarmApi } from '@/lib/api'
import { sessionDisplayUsage } from '@/lib/session-usage'
import { useForkLineage } from '@/stores/fork-lineage'
import { usePermissionStore } from '@/stores/permission'
import { useSessionsStore } from '@/stores/sessions'

// The latest custom 'plan' entry in the view becomes the single working plan
// group (per-turn plan history returns with steering in a later phase).
function latestPlanGroup(view: SessionView): PlanGroup | null {
  for (let i = view.entries.length - 1; i >= 0; i--) {
    const { entry } = view.entries[i]
    if (entry.type !== 'custom' || entry.customType !== 'plan') continue
    const data = entry.data as { todos?: PlanTodo[] } | undefined
    const todos = Array.isArray(data?.todos) ? data.todos : []
    if (todos.length === 0) return null
    return {
      messageId: entry.id,
      prompt: '当前计划',
      plan: todos,
      status: view.running ? 'running' : 'completed',
      createdAt: Date.parse(entry.timestamp) || 0,
    }
  }
  return null
}

export function TasksView({ focusTaskId: _focusTaskId }: { focusTaskId?: string } = {}): React.JSX.Element {
  const selectedSessionId = useSessionsStore((s) => s.selectedSessionId)
  const sessions = useSessionsStore((s) => s.sessions)
  const forkedFrom = useForkLineage((s) => s.forkedFrom)
  const setSessionSettings = useSessionsStore((s) => s.setSettings)
  const queue = usePermissionStore((s) => s.queue)
  const submitPrompt = useSubmitPrompt()
  const decide = useDecidePermission()
  const cancelRun = useCancelRun()
  const { ready, state } = useProviders()

  const { view, segments } = useSessionView(selectedSessionId)
  const running = view.running

  const sessionPrompts = queue.filter((p) => p.sessionId === selectedSessionId)

  // Working plan: the latest plan entry drives both the composer todo strip and
  // the workspace 计划 tab.
  const planGroup = latestPlanGroup(view)
  const planGroups = planGroup ? [planGroup] : []
  const activePlan = planGroup?.plan

  const sessionUsage = sessionDisplayUsage(view)

  const session = sessions.find((s) => s.id === selectedSessionId)
  // Context tokens/window are session-level (SessionSummary); live updates flow
  // through use-events-subscription's turn_end handler.
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
  // still "your move"); otherwise idle.
  const headerStatus = sessionPrompts.length > 0 ? 'awaiting' : running ? 'running' : 'idle'
  const contextPct =
    contextTokens != null && contextWindow != null ? Math.round((contextTokens / contextWindow) * 100) : undefined
  const forkSourceId = selectedSessionId ? forkedFrom[selectedSessionId] : undefined

  // The system session ("定时任务") only surfaces scheduled-run RESULTS — read-only.
  if (session?.isSystem) {
    return (
      <div className="flex h-full min-w-0 overflow-hidden">
        <div className="flex min-w-0 flex-1 flex-col">
          <ScheduledResultsView />
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
        <ConversationThread
          busy={running}
          // Remount on session switch so StickToBottom's initial="instant" fires.
          key={selectedSessionId}
          onSend={(text) => {
            if (!ready) return
            void submitPrompt.mutateAsync({ prompt: text, options: taskOptions })
          }}
          segments={segments}
        />
        <ChatInput
          agentType={agentType}
          cacheReadTokens={view.usage?.used.cacheRead}
          contextTokens={contextTokens}
          contextWindow={contextWindow}
          cwd={cwd}
          disabled={!ready || sessionPrompts.length > 0}
          executionMode={executionMode}
          onAgentTypeChange={setAgentType}
          onCwdChange={setCwd}
          onExecutionModeChange={setExecutionMode}
          onPermissionModeChange={setPermissionMode}
          onStop={() => {
            if (running && selectedSessionId) cancelRun.mutate(selectedSessionId)
          }}
          onSubmit={async (g, attachments) => {
            if (!ready) return
            await submitPrompt.mutateAsync({ prompt: g, attachments, options: taskOptions })
          }}
          overlay={
            <ComposerOverlay
              onDecide={(actionId, decision) => {
                const p = sessionPrompts.find((x) => x.actionId === actionId)
                if (!p) return
                decide.mutate({ sessionId: p.sessionId, actionId, decision })
              }}
              prompts={sessionPrompts}
              queued={[]}
              running={running}
              todos={activePlan ?? []}
            />
          }
          permissionMode={permissionMode}
          running={running}
          supportsImages={!!providerViewById(state, state.active)?.supportsImages}
          teamOptions={teamOptions}
          usdCents={sessionUsage?.usdCents}
        />
      </div>
      <WorkspacePanel
        messages={[]}
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
