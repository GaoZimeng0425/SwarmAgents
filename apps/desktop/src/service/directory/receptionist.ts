import type { AgentDefinition, Peer, PeerQuery } from '@swarm/protocol'
import { compact, sumBy } from 'es-toolkit'

export type AgentDirectory = {
  /** Agent defs matching `q`, ranked best-first. */
  find(q: PeerQuery): Peer[]
}

const tokens = (s: string): string[] => compact(s.toLowerCase().split(/\s+/))

/**
 * The agent "receptionist": a pure projection over the on-disk agent-def
 * catalog. No actor/session state (the actors table is gone in W3) — every
 * def is discoverable regardless of whether it is currently running, so
 * `status` is always 'active'.
 */
export function createAgentDirectory(deps: { listAgentDefs(): AgentDefinition[] }): AgentDirectory {
  const toPeer = (def: AgentDefinition): Peer => ({
    name: def.name,
    address: def.id,
    role: def.role ?? def.id,
    capabilities: def.capabilities ?? [],
    description: def.description,
    status: 'active',
    team: def.team,
    teamRole: def.teamRole,
  })

  const scoreOf = (p: Peer, query: string | undefined): number => {
    if (!query) return 0
    const q = tokens(query)
    if (q.length === 0) return 0
    const hay = new Set(tokens(`${p.role} ${p.name ?? ''} ${p.capabilities.join(' ')} ${p.description}`))
    let score = sumBy(q, (t) => (hay.has(t) ? 1 : 0))
    // A query that names a role exactly outranks an agent that merely mentions
    // the word in prose ("find a reviewer" → the reviewer, not a code agent
    // whose description says "review").
    if (q.includes(p.role.toLowerCase())) score += 10
    return score
  }

  return {
    find(q) {
      let peers = deps.listAgentDefs().map(toPeer)
      if (q.role) peers = peers.filter((p) => p.role === q.role)
      if (q.capability) peers = peers.filter((p) => p.capabilities.includes(q.capability as string))
      if (q.team) peers = peers.filter((p) => p.team === q.team)
      if (q.teamRole) peers = peers.filter((p) => p.teamRole === q.teamRole)
      return peers
        .map((p) => ({ p, score: scoreOf(p, q.query) }))
        .sort((a, b) => {
          if (b.score !== a.score) return b.score - a.score
          return (a.p.name ?? '').localeCompare(b.p.name ?? '')
        })
        .map((s) => s.p)
    },
  }
}
