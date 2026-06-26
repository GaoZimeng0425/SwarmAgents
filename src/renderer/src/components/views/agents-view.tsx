import { useEffect } from 'react'
import { useQuery, useQueryClient } from '@tanstack/react-query'

import { swarmApi } from '@/lib/api'
import { SettingsHeader } from './settings-primitives'
import { OrgTreeView } from './org-tree-view'

export function AgentsView(): React.JSX.Element {
  const queryClient = useQueryClient()
  const { data: agents, isLoading } = useQuery({
    queryKey: ['agents', 'settings'],
    queryFn: () => swarmApi.listAgents(),
    staleTime: 60_000,
  })

  // Hot-reload: invalidate the query when agent files change on disk
  // (the agents store watches its directory and broadcasts `agents.changed`).
  useEffect(
    () =>
      swarmApi.subscribeEvents((e) => {
        if (e.kind === 'agents.changed') {
          void queryClient.invalidateQueries({ queryKey: ['agents', 'settings'] })
        }
      }),
    [queryClient]
  )

  return (
    <div className="space-y-4">
      <SettingsHeader
        title="Agents"
        description="Specialised sub-agents the main agent can delegate to. The tree shows the org hierarchy; click an agent to view its full system prompt."
      />

      {isLoading ? (
        <p className="text-muted-foreground text-sm">Loading agents…</p>
      ) : !agents || agents.length === 0 ? (
        <p className="text-muted-foreground text-sm">No agents available.</p>
      ) : (
        <OrgTreeView agents={agents} />
      )}
    </div>
  )
}
