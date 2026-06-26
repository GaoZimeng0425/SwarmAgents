import type { DelegationEdge } from '@shared/agents/delegation'
import type { AgentDefinition } from '@shared/types/agent'

type DelegationLinksProps = {
  agentId: string
  edges: DelegationEdge[]
  agents: AgentDefinition[]
  onSelect: (id: string) => void
}

/** Delegation chips for the selected agent: outgoing ("Delegates to") and
 *  incoming ("Called by"), parsed from prompts. Each chip selects that agent. */
export function DelegationLinks({ agentId, edges, agents, onSelect }: DelegationLinksProps): React.JSX.Element | null {
  const nameOf = (id: string): string => agents.find((a) => a.id === id)?.name ?? id
  const delegatesTo = edges.filter((e) => e.from === agentId).map((e) => e.to)
  const calledBy = edges.filter((e) => e.to === agentId).map((e) => e.from)
  if (delegatesTo.length === 0 && calledBy.length === 0) return null

  const row = (label: string, ids: string[]): React.JSX.Element | null =>
    ids.length === 0 ? null : (
      <div className="flex flex-wrap items-center gap-1.5">
        <span className="text-muted-foreground text-xs">{label}</span>
        {ids.map((id) => (
          <button
            className="rounded bg-secondary px-1.5 py-0.5 text-secondary-foreground text-xs hover:bg-accent"
            key={id}
            onClick={() => onSelect(id)}
            type="button"
          >
            {nameOf(id)}
          </button>
        ))}
      </div>
    )

  return (
    <div className="mt-3 space-y-1.5 border-t pt-3">
      <p className="text-muted-foreground text-[11px] italic">
        Delegation intent parsed from prompts — not runtime calls.
      </p>
      {row('Delegates to', delegatesTo)}
      {row('Called by', calledBy)}
    </div>
  )
}
