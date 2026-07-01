import type { AgentDefinition, AgentMutationResult } from '@swarm/protocol'
import { useQueryClient } from '@tanstack/react-query'

import { swarmApi } from '@/lib/api'

/** Create/update + delete agents, refreshing the Agents query on success. */
export function useAgentMutations(): {
  save: (def: AgentDefinition) => Promise<AgentMutationResult>
  remove: (id: string) => Promise<AgentMutationResult>
  restoreDefaults: () => Promise<AgentMutationResult>
} {
  const queryClient = useQueryClient()
  const refresh = (): void => void queryClient.invalidateQueries({ queryKey: ['agents', 'settings'] })
  return {
    save: async (def) => {
      const r = await swarmApi.saveAgent(def)
      if (r.ok) refresh()
      return r
    },
    remove: async (id) => {
      const r = await swarmApi.removeAgent(id)
      if (r.ok) refresh()
      return r
    },
    restoreDefaults: async () => {
      const r = await swarmApi.restoreDefaultAgents()
      if (r.ok) refresh()
      return r
    },
  }
}
