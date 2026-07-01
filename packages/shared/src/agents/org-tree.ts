import type { AgentDefinition } from '@swarm/protocol'

/** A node in the agent org forest. Minimal by design: enough for recursive
 *  rendering (Spec 2) and for overlaying delegation edges (Spec 4). */
export type OrgNode = { agent: AgentDefinition; children: OrgNode[] }

/**
 * Build an org forest from a flat agent list.
 *
 * Edge resolution per agent, parentId-first with fallback inference:
 *  1. valid `parentId` (resolves to another agent) -> child of that agent.
 *  2. no parentId -> inferred:
 *     - role 'ceo' with no team        -> root
 *     - teamRole 'head'                -> child of the CEO if one exists, else root
 *     - team member (team, not head)   -> child of that team's head if one exists, else root
 *     - otherwise (independent)        -> root
 *
 * Cycle-safe: an agent whose parent chain would revisit itself is promoted to
 * a root, so the result is always a forest and never loops.
 */
export function buildOrgForest(agents: AgentDefinition[]): OrgNode[] {
  const byId = new Map(agents.map((agent) => [agent.id, agent]))
  const ceo = agents.find((agent) => agent.role === 'ceo' && !agent.team)
  const headByTeam = new Map<string, AgentDefinition>()
  for (const agent of agents) {
    if (agent.team && agent.teamRole === 'head') headByTeam.set(agent.team, agent)
  }

  // Resolve each agent's parent id (or undefined for a root).
  const parentOf = (agent: AgentDefinition): string | undefined => {
    if (agent.parentId && byId.has(agent.parentId) && agent.parentId !== agent.id) return agent.parentId
    if (agent.parentId) return undefined // self-ref or dangling -> root
    if (agent.role === 'ceo' && !agent.team) return undefined
    if (agent.teamRole === 'head') return ceo && ceo.id !== agent.id ? ceo.id : undefined
    if (agent.team) {
      const head = headByTeam.get(agent.team)
      return head && head.id !== agent.id ? head.id : undefined
    }
    return undefined
  }

  // Detect agents in a parent cycle; promote them to roots.
  const inCycle = (agent: AgentDefinition): boolean => {
    const visited = new Set<string>()
    let cursor: string | undefined = agent.id
    while (cursor) {
      if (visited.has(cursor)) return true
      visited.add(cursor)
      const next = byId.get(cursor)
      cursor = next ? parentOf(next) : undefined
    }
    return false
  }

  const nodes = new Map<string, OrgNode>(agents.map((agent) => [agent.id, { agent, children: [] }]))
  const roots: OrgNode[] = []
  for (const agent of agents) {
    const parentId = inCycle(agent) ? undefined : parentOf(agent)
    const node = nodes.get(agent.id)!
    const parent = parentId ? nodes.get(parentId) : undefined
    if (parent) parent.children.push(node)
    else roots.push(node)
  }
  return roots
}
