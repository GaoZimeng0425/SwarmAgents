import { useEffect, useState } from 'react'
import { useQuery, useQueryClient } from '@tanstack/react-query'

import { Button } from '@swarm/ui'
import { useAgentMutations } from '@/hooks/use-agent-mutations'
import { swarmApi } from '@/lib/api'
import { OrgTreeView } from './org-tree-view'
import { SettingsHeader } from './settings-primitives'

export function AgentsView(): React.JSX.Element {
  const queryClient = useQueryClient()
  const { restoreDefaults } = useAgentMutations()
  const [restoring, setRestoring] = useState(false)
  const { data: agents, isLoading } = useQuery({
    queryKey: ['agents', 'settings'],
    queryFn: () => swarmApi.listAgents(),
    staleTime: 60_000,
  })

  const onRestoreDefaults = async (): Promise<void> => {
    setRestoring(true)
    try {
      await restoreDefaults()
    } finally {
      setRestoring(false)
    }
  }

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
        action={
          <Button disabled={restoring} onClick={onRestoreDefaults} size="sm" variant="outline">
            {restoring ? 'Restoring…' : 'Restore defaults'}
          </Button>
        }
        description="Specialised sub-agents the main agent can delegate to. The tree shows the org hierarchy; click an agent to view its full system prompt."
        title="Agents"
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
