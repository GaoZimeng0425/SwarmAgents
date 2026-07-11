import { useEffect } from 'react'
import { providerViewById } from '@swarm/protocol'
import { createFileRoute, useNavigate } from '@tanstack/react-router'

import { ChatInput } from '@/components/chat-input'
import { useTeamOptions } from '@/hooks/use-agents'
import { useProviders } from '@/hooks/use-providers'
import { useSubmitPrompt } from '@/hooks/use-runs'
import { useComposerDefaults } from '@/stores/composer-defaults'
import { useSessionsStore } from '@/stores/sessions'

export const Route = createFileRoute('/session/')({ component: SessionIndexView })

// Landing for the 对话 rail item: a centered hero composer beside the session
// list (the list lives in the /session layout route). Submitting the first
// message creates a session (useSubmitPrompt) and navigates to its detail,
// mirroring HomeDashboard's hero composer on `/`.
function SessionIndexView(): React.JSX.Element {
  const navigate = useNavigate()
  const submitPrompt = useSubmitPrompt()
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
    // Empty conversation state: the same hero composer as the 任务台 home so
    // starting a chat here looks identical to starting one on the dashboard,
    // just centered in the conversation scene (session list stays on the left).
    <div className="mx-auto flex h-full w-full max-w-[820px] flex-col justify-center gap-4 px-6 py-8">
      <h2 className="font-semibold text-[26px] text-foreground tracking-tight">今天想让 swarm 做点什么?</h2>
      <ChatInput
        agentType={agentType}
        cwd={cwd}
        disabled={!ready}
        executionMode={executionMode}
        onAgentTypeChange={setAgentType}
        onCwdChange={setCwd}
        onExecutionModeChange={setExecutionMode}
        onPermissionModeChange={setPermissionMode}
        onSubmit={async (prompt, attachments) => {
          if (!ready) return
          const { sessionId } = await submitPrompt.mutateAsync({
            prompt,
            attachments,
            options: { cwd, permissionMode, executionMode, agentType },
          })
          void navigate({ to: '/session/$sessionId', params: { sessionId } })
        }}
        permissionMode={permissionMode}
        placeholder="描述一个目标,或按 ⌘⏎ 从剪贴板开始…"
        supportsImages={!!providerViewById(state, state.active)?.supportsImages}
        teamOptions={teamOptions}
        variant="hero"
      />
    </div>
  )
}
