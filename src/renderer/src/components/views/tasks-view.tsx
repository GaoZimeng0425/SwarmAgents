import { useEffect } from 'react'

import { ChatInput } from '@/components/chat-input'
import { ConversationThread } from '@/components/conversation-thread'
import { PermissionDrawer } from '@/components/permission-drawer'
import { useProviders } from '@/hooks/use-providers'
import { useDecidePermission, useLoadSessions, useSubmitGoal, useTasks } from '@/hooks/use-tasks'
import { usePermissionStore } from '@/stores/permission'
import { useSessionsStore } from '@/stores/sessions'

export function TasksView(): React.JSX.Element {
  const tasks = useTasks()
  const queue = usePermissionStore((s) => s.queue)
  const selectedSessionId = useSessionsStore((s) => s.selectedSessionId)
  const submitGoal = useSubmitGoal()
  const decide = useDecidePermission()
  const loadSessions = useLoadSessions()
  const { ready } = useProviders()

  // Load the session list once on mount.
  useEffect(() => {
    loadSessions.mutate()
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  const sessionTasks = tasks.filter((t) => t.sessionId === selectedSessionId)
  const currentPrompt = queue.find((p) => p.sessionId === selectedSessionId) ?? null

  return (
    <div className="flex h-full flex-col">
      <ConversationThread tasks={sessionTasks} />
      <PermissionDrawer
        onDecide={(actionId, decision) => {
          if (!currentPrompt) return
          decide.mutate({ sessionId: currentPrompt.sessionId, actionId, decision })
        }}
        prompt={currentPrompt}
      />
      <ChatInput
        disabled={submitGoal.isPending || !ready}
        onSubmit={async (g) => {
          if (!ready) return
          await submitGoal.mutateAsync(g)
        }}
      />
    </div>
  )
}
