import { useState } from 'react'

import { type OrgNode, buildOrgForest } from '@shared/agents/org-tree'
import type { AgentDefinition } from '@shared/types/agent'
import { cn } from '@/lib/utils'
import { AgentDetail } from './agent-detail'

const MAX_CAPS = 3

/** One agent card: name, role/id, team + scope badges, capped capabilities. */
function AgentNodeCard({
  agent,
  isActive,
  onClick,
}: {
  agent: AgentDefinition
  isActive: boolean
  onClick: () => void
}): React.JSX.Element {
  const caps = agent.capabilities ?? []
  const shown = caps.slice(0, MAX_CAPS)
  const extra = caps.length - shown.length
  return (
    <button
      type="button"
      onClick={onClick}
      className={cn(
        'w-full rounded-lg border bg-card p-2.5 text-left transition-colors hover:bg-accent',
        isActive && 'border-primary ring-1 ring-primary'
      )}
    >
      <div className="flex items-center gap-2">
        <span className="truncate font-medium text-sm">{agent.name}</span>
        <span className="truncate font-mono text-muted-foreground text-xs">{agent.role ?? agent.id}</span>
      </div>
      <div className="mt-1 flex flex-wrap items-center gap-1.5">
        {agent.team && (
          <span className="rounded bg-primary/10 px-1.5 py-0.5 font-medium text-primary text-xs">{agent.team}</span>
        )}
        <span className="text-muted-foreground text-xs">scope: {agent.toolScope}</span>
        {shown.map((c) => (
          <span key={c} className="rounded bg-secondary px-1 py-0.5 text-secondary-foreground text-[10px]">
            {c}
          </span>
        ))}
        {extra > 0 && <span className="text-muted-foreground text-[10px]">+{extra} more</span>}
      </div>
    </button>
  )
}

/** Recursive node: a card plus an indented, guide-lined list of children. */
function OrgTreeNode({
  node,
  expanded,
  onToggle,
}: {
  node: OrgNode
  expanded: string | null
  onToggle: (id: string) => void
}): React.JSX.Element {
  return (
    <li>
      <AgentNodeCard
        agent={node.agent}
        isActive={expanded === node.agent.id}
        onClick={() => onToggle(node.agent.id)}
      />
      {node.children.length > 0 && (
        <ul className="mt-1 ml-4 flex flex-col gap-1 border-l pl-3">
          {node.children.map((child) => (
            <OrgTreeNode key={child.agent.id} node={child} expanded={expanded} onToggle={onToggle} />
          ))}
        </ul>
      )}
    </li>
  )
}

/** Indented org tree from buildOrgForest. Hierarchy trees first, then a
 *  flat "Independent Agents" group for team-less, childless, non-CEO roots. */
export function OrgTree({
  agents,
  expanded,
  onToggle,
}: {
  agents: AgentDefinition[]
  expanded: string | null
  onToggle: (id: string) => void
}): React.JSX.Element {
  const forest = buildOrgForest(agents)
  const isIndependent = (n: OrgNode): boolean =>
    n.children.length === 0 && n.agent.role !== 'ceo' && !n.agent.team
  const hierarchy = forest.filter((n) => !isIndependent(n))
  const independents = forest.filter(isIndependent)
  return (
    <div className="flex flex-col gap-4 overflow-x-auto">
      <ul className="flex flex-col gap-1">
        {hierarchy.map((node) => (
          <OrgTreeNode key={node.agent.id} node={node} expanded={expanded} onToggle={onToggle} />
        ))}
      </ul>
      {independents.length > 0 && (
        <div className="flex flex-col gap-1">
          <span className="font-medium text-muted-foreground text-xs uppercase tracking-wide">
            Independent Agents
          </span>
          <ul className="flex flex-col gap-1">
            {independents.map((node) => (
              <OrgTreeNode key={node.agent.id} node={node} expanded={expanded} onToggle={onToggle} />
            ))}
          </ul>
        </div>
      )}
    </div>
  )
}

/** Stateful wrapper: single-select org tree with a detail panel below. */
export function OrgTreeView({ agents }: { agents: AgentDefinition[] }): React.JSX.Element {
  const [expanded, setExpanded] = useState<string | null>(null)
  const toggle = (id: string): void => setExpanded((prev) => (prev === id ? null : id))
  const selected = expanded ? agents.find((agent) => agent.id === expanded) : undefined
  return (
    <div>
      <OrgTree agents={agents} expanded={expanded} onToggle={toggle} />
      {selected && <AgentDetail agent={selected} />}
    </div>
  )
}
