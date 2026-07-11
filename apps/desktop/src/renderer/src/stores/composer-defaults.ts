import type { ExecutionMode, PermissionMode } from '@swarm/protocol'
import { create } from 'zustand'
import { persist } from 'zustand/middleware'

// The home composer's controls that should survive a reload: the last-chosen
// working directory, permission gate, execution mode and agent type. The home
// screen initialises from here so a relaunch starts where the user left off,
// while each session route still owns its own live copy once a run begins.
// Model and thinking level are NOT mirrored here — they live in the providers
// state machine, which already persists the active provider/model/thinking
// level across launches.
type ComposerDefaultsStore = {
  cwd: string | undefined
  permissionMode: PermissionMode
  executionMode: ExecutionMode
  agentType: string
  setCwd: (cwd: string | undefined) => void
  setPermissionMode: (mode: PermissionMode) => void
  setExecutionMode: (mode: ExecutionMode) => void
  setAgentType: (agentType: string) => void
}

export const useComposerDefaults = create<ComposerDefaultsStore>()(
  persist(
    (set) => ({
      cwd: undefined,
      permissionMode: 'ask',
      executionMode: 'direct',
      agentType: 'ceo',
      setCwd: (cwd) => set({ cwd }),
      setPermissionMode: (permissionMode) => set({ permissionMode }),
      setExecutionMode: (executionMode) => set({ executionMode }),
      setAgentType: (agentType) => set({ agentType }),
    }),
    {
      name: 'swarm:composer-defaults',
      // v1: the execution mode value 'goal' was renamed to 'direct'; rewrite
      // the persisted copy so old localStorage keeps rehydrating cleanly.
      version: 1,
      migrate: (persisted) => {
        const s = persisted as { executionMode?: string } | undefined
        if (s && (s.executionMode as string) === 'goal') s.executionMode = 'direct'
        return persisted as ComposerDefaultsStore
      },
    }
  )
)
