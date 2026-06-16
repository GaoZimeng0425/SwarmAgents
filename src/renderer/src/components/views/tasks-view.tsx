import { useEffect } from 'react'

import { AskPanel } from '@/components/ask-panel'
import { ChatInput } from '@/components/chat-input'
import { ConversationThread } from '@/components/conversation-thread'
import { PermissionDrawer } from '@/components/permission-drawer'
import { PlanPanel } from '@/components/plan-panel'
import { useProviders } from '@/hooks/use-providers'
import { useCancelTask, useDecidePermission, useLoadSessions, useSubmitGoal, useTasks } from '@/hooks/use-tasks'
import { swarmApi } from '@/lib/api'
import { type AskPrompt, useAskStore } from '@/stores/ask'
import { usePermissionStore } from '@/stores/permission'
import { useSessionsStore } from '@/stores/sessions'

export function TasksView(): React.JSX.Element {
  const tasks = useTasks()
  const queue = usePermissionStore((s) => s.queue)
  const askQueue = useAskStore((s) => s.queue)
  const removeAsk = useAskStore((s) => s.remove)
  const setPendingChat = useAskStore((s) => s.setPendingChat)
  const clearPendingChat = useAskStore((s) => s.clearPendingChat)
  const pendingChat = useAskStore((s) => s.pendingChat)
  const selectedSessionId = useSessionsStore((s) => s.selectedSessionId)
  const submitGoal = useSubmitGoal()
  const cancelTask = useCancelTask()
  const decide = useDecidePermission()
  const loadSessions = useLoadSessions()
  const { ready, state } = useProviders()

  // Load the session list once on mount.
  // biome-ignore lint/correctness/useExhaustiveDependencies: mount-only; loadSessions is a stable React Query mutation
  useEffect(() => {
    loadSessions.mutate()
  }, [])

  const sessionTasks = tasks.filter((t) => t.sessionId === selectedSessionId)
  // Runs are sequential per session, so at most one task is in flight; the
  // event reducer prepends newest-first, so find() yields the active run.
  // 'awaiting_user' counts as in-flight: the run is blocked on a permission
  // prompt but still cancellable, and no event resets it back to 'running'.
  const activeTask = sessionTasks.find(
    (t) => t.status === 'running' || t.status === 'pending' || t.status === 'awaiting_user'
  )
  const currentPrompt = queue.find((p) => p.sessionId === selectedSessionId) ?? null
  const askPrompt = askQueue.find((p) => p.sessionId === selectedSessionId) ?? null
  const pendingChatAskId = selectedSessionId ? pendingChat[selectedSessionId] : undefined

  const answerAsk = (prompt: AskPrompt, answer: string): void => {
    void swarmApi.respondAsk(prompt.sessionId, prompt.askId, answer)
    removeAsk(prompt.askId)
  }
  const chatAboutAsk = (prompt: AskPrompt): void => {
    setPendingChat(prompt.sessionId, prompt.askId)
    removeAsk(prompt.askId)
  }
  const byRecent = [...sessionTasks].sort((a, b) => b.startedAt - a.startedAt)
  // Most recent plan in the session (the agent replaces it wholesale).
  const activePlan = byRecent.find((t) => t.plan && t.plan.length > 0)?.plan
  // Context-window fill for the composer ring follows the most recent task.
  const latestTask = byRecent[0]

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
        <AskPanel key={askPrompt?.askId ?? 'none'} onAnswer={answerAsk} onChat={chatAboutAsk} prompt={askPrompt} />
        <ChatInput
          contextTokens={latestTask?.contextTokens}
          contextWindow={latestTask?.contextWindow}
          disabled={!ready}
          onStop={() => {
            if (activeTask) cancelTask.mutate({ sessionId: activeTask.sessionId, taskId: activeTask.id })
          }}
          onSubmit={async (g, attachments) => {
            if (!ready) return
            // When the user picked "Chat about this", their next message answers the agent's question.
            if (selectedSessionId && pendingChatAskId) {
              await swarmApi.respondAsk(selectedSessionId, pendingChatAskId, g)
              clearPendingChat(selectedSessionId)
              return
            }
            await submitGoal.mutateAsync({ goal: g, attachments })
          }}
          placeholder={pendingChatAskId ? 'Reply to the agent…' : undefined}
          status={activeTask ? (activeTask.status === 'pending' ? 'submitted' : 'streaming') : 'ready'}
          supportsImages={!!(state.active && state.providers[state.active]?.supportsImages)}
          usdCents={latestTask?.used?.usdCents}
        />
      </div>
      <PlanPanel todos={activePlan ?? []} />
    </div>
  )
}
