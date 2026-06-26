import { useEffect, useState } from 'react'
import { useQuery, useQueryClient } from '@tanstack/react-query'

import { swarmApi } from '@/lib/api'
import { cn } from '@/lib/utils'
import { SettingsHeader } from './settings-primitives'

export function AgentsView(): React.JSX.Element {
  const queryClient = useQueryClient()
  const { data: agents, isLoading } = useQuery({
    queryKey: ['agents', 'settings'],
    queryFn: () => swarmApi.listAgents(),
    staleTime: 60_000,
  })
  const [expanded, setExpanded] = useState<string | null>(null)

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
        description="Specialised sub-agents the main agent can delegate to. Each card shows the agent's role and capabilities; click to view its full system prompt."
      />

      {isLoading ? (
        <p className="text-muted-foreground text-sm">Loading agents…</p>
      ) : !agents || agents.length === 0 ? (
        <p className="text-muted-foreground text-sm">No agents available.</p>
      ) : (
        <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
          {agents.map((a) => {
            const isOpen = expanded === a.id
            return (
              <div
                className={cn('rounded-xl border bg-card p-4', isOpen && 'sm:col-span-2 lg:col-span-3')}
                key={a.id}
              >
                <div className="flex items-start gap-3">
                  <button
                    className="min-w-0 flex-1 text-left"
                    onClick={() => setExpanded(isOpen ? null : a.id)}
                    type="button"
                  >
                    <p className="truncate font-medium text-sm">{a.name}</p>
                    <p className="truncate font-mono text-muted-foreground text-xs">{a.id}</p>
                    <p className={cn('text-muted-foreground text-sm', !isOpen && 'line-clamp-2')}>
                      {a.description}
                    </p>
                  </button>
                </div>

                <div className="mt-2 flex flex-wrap items-center gap-1.5">
                  {a.team && (
                    <span className="rounded bg-primary/10 px-1.5 py-0.5 font-medium text-primary text-xs">
                      {a.team}
                    </span>
                  )}
                  {a.role && (
                    <span className="rounded bg-secondary px-1.5 py-0.5 font-medium text-secondary-foreground text-xs">
                      {a.role}
                    </span>
                  )}
                  {a.toolScope && (
                    <span className="text-muted-foreground text-xs">scope: {a.toolScope}</span>
                  )}
                </div>

                {isOpen && (
                  <div className="mt-3 flex flex-col gap-3 border-t pt-3">
                    {a.systemPrompt && (
                      <pre className="overflow-x-auto whitespace-pre-wrap rounded bg-muted p-3 font-mono text-xs">
                        {a.systemPrompt}
                      </pre>
                    )}
                  </div>
                )}
              </div>
            )
          })}
        </div>
      )}
    </div>
  )
}
