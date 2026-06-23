import type { Actor } from '@shared/types/actor'
import type { AgentDefinition, Peer, PeerQuery } from '@shared/types/agent'

export type AgentDirectory = {
  /** Live peers in `sessionId` matching `q`, ranked best-first, excluding `selfAddress`. */
  find(sessionId: string, q: PeerQuery, selfAddress?: string): Peer[]
}

const tokens = (s: string): string[] => s.toLowerCase().split(/\s+/).filter(Boolean)

/**
 * The actor "receptionist": a pure projection over existing state (actors table,
 * live-handle set, agent store). No registration, no second source of truth.
 */
export function createAgentDirectory(deps: {
  listActors(sessionId: string): Actor[]
  isLive(address: string): boolean
  getAgentDef(agentDefId: string): AgentDefinition | undefined
}): AgentDirectory {
  const toPeer = (a: Actor): Peer => {
    const def = deps.getAgentDef(a.agentDefId)
    return {
      name: a.name,
      address: a.address,
      role: def?.role ?? a.agentDefId,
      capabilities: def?.capabilities ?? [],
      description: def?.description ?? '',
      status: deps.isLive(a.address) ? 'active' : 'dormant',
    }
  }

  const scoreOf = (p: Peer, query: string | undefined): number => {
    if (!query) return 0
    const q = tokens(query)
    if (q.length === 0) return 0
    const hay = new Set(tokens(`${p.role} ${p.name ?? ''} ${p.capabilities.join(' ')} ${p.description}`))
    let score = q.reduce((n, t) => n + (hay.has(t) ? 1 : 0), 0)
    // A query that names a role exactly outranks an agent that merely mentions
    // the word in prose ("find a reviewer" → the reviewer, not a code agent
    // whose description says "review").
    if (q.includes(p.role.toLowerCase())) score += 10
    return score
  }

  return {
    find(sessionId, q, selfAddress) {
      let peers = deps.listActors(sessionId).map(toPeer)
      if (selfAddress) peers = peers.filter((p) => p.address !== selfAddress)
      if (q.role) peers = peers.filter((p) => p.role === q.role)
      if (q.capability) peers = peers.filter((p) => p.capabilities.includes(q.capability as string))
      return peers
        .map((p) => ({ p, score: scoreOf(p, q.query) }))
        .sort((a, b) => {
          const liveDiff = (a.p.status === 'active' ? 0 : 1) - (b.p.status === 'active' ? 0 : 1)
          if (liveDiff !== 0) return liveDiff
          if (b.score !== a.score) return b.score - a.score
          return (a.p.name ?? '').localeCompare(b.p.name ?? '')
        })
        .map((s) => s.p)
    },
  }
}
