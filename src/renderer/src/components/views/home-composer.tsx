import { useState } from 'react'
import { providerViewById } from '@shared/types/provider'
import type { ExecutionMode, PermissionMode } from '@shared/types/task'
import { useNavigate } from '@tanstack/react-router'

import { ChatInput } from '@/components/chat-input'
import { useTeamOptions } from '@/hooks/use-agents'
import { useProviders } from '@/hooks/use-providers'
import { useSubmitGoal } from '@/hooks/use-tasks'

/**
 * The `/` landing screen: a centered composer. Sending the first message
 * creates a session lazily (via useSubmitGoal) and navigates to it, so no
 * empty session is left behind by simply clicking "New chat".
 */
export function HomeComposer(): React.JSX.Element {
  const navigate = useNavigate()
  const submitGoal = useSubmitGoal()
  const { ready, state } = useProviders()

  // Composer controls held locally; the first turn inherits them, and the
  // session route owns them from then on.
  const [cwd, setCwd] = useState<string | undefined>(undefined)
  const [permissionMode, setPermissionMode] = useState<PermissionMode>('ask')
  const [executionMode, setExecutionMode] = useState<ExecutionMode>('goal')
  const [agentType, setAgentType] = useState<string>('ceo')
  const teamOptions = useTeamOptions()

  return (
    <div className="flex h-full flex-col items-center justify-center px-4">
      <div className="w-full max-w-3xl">
        <h1 className="mb-6 text-center font-semibold text-2xl text-foreground/90">今天想让 swarm 做点什么？</h1>
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
          supportsImages={!!providerViewById(state, state.active)?.supportsImages}
          teamOptions={teamOptions}
        />
      </div>
    </div>
  )
}
