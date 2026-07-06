import { useEffect } from 'react'
import { providerViewById } from '@swarm/protocol'
import { createFileRoute, useNavigate } from '@tanstack/react-router'

import { ChatInput } from '@/components/chat-input'
import { useTeamOptions } from '@/hooks/use-agents'
import { useProviders } from '@/hooks/use-providers'
import { useSubmitGoal } from '@/hooks/use-runs'
import { useComposerDefaults } from '@/stores/composer-defaults'
import { useSessionsStore } from '@/stores/sessions'

export const Route = createFileRoute('/session/')({ component: SessionIndexView })

// Landing for the 对话 rail item: shows the SessionPanel list (gated by
// isConversationScene in __root) beside a centered composer. Submitting the
// first message creates a session (useSubmitGoal) and navigates to its detail,
// mirroring HomeDashboard's hero composer on `/`.
function SessionIndexView(): React.JSX.Element {
  const navigate = useNavigate()
  const submitGoal = useSubmitGoal()
  const { ready, state } = useProviders()

  const cwd = useComposerDefaults((s) => s.cwd)
  const setCwd = useComposerDefaults((s) => s.setCwd)
  const permissionMode = useComposerDefaults((s) => s.permissionMode)
  const setPermissionMode = useComposerDefaults((s) => s.setPermissionMode)
  const executionMode = useComposerDefaults((s) => s.executionMode)
  const setExecutionMode = useComposerDefaults((s) => s.setExecutionMode)
  const agentType = useComposerDefaults((s) => s.agentType)
  const setAgentType = useComposerDefaults((s) => s.setAgentType)
  const teamOptions = useTeamOptions()

  // Landing on `/session` means no active session — clear stale selection so
  // session-scoped consumers don't match an old id. Mirrors routes/index.tsx.
  const select = useSessionsStore((s) => s.select)
  useEffect(() => {
    select(null)
  }, [select])

  return (
    <div className="mx-auto flex w-full max-w-[860px] flex-1 flex-col items-center justify-center gap-6 px-6 py-8">
      <div className="w-full space-y-3 text-center">
        <h2 className="font-semibold text-foreground text-xl tracking-tight">开始一段新对话</h2>
        <p className="text-muted-foreground text-sm">从左侧选择一个会话,或在下方直接发起。</p>
      </div>
      <div className="w-full rounded-2xl border border-border bg-card p-4 shadow-sm">
        <ChatInput
          agentType={agentType}
          cwd={cwd}
          disabled={!ready}
          executionMode={executionMode}
          onAgentTypeChange={setAgentType}
          onCwdChange={setCwd}
          onExecutionModeChange={setExecutionMode}
          onPermissionModeChange={setPermissionMode}
          onSubmit={async (goal, attachments) => {
            if (!ready) return
            const { sessionId } = await submitGoal.mutateAsync({
              goal,
              attachments,
              options: { cwd, permissionMode, executionMode, agentType },
            })
            void navigate({ to: '/session/$sessionId', params: { sessionId } })
          }}
          permissionMode={permissionMode}
          placeholder="描述一个目标,或按 ⌘⏎ 从剪贴板开始…"
          supportsImages={!!providerViewById(state, state.active)?.supportsImages}
          teamOptions={teamOptions}
        />
      </div>
    </div>
  )
}
