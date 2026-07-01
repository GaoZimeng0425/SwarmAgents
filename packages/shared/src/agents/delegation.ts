import type { AgentDefinition } from '@swarm/protocol'

/** A directed delegation-intent edge: `from` delegates to `to`. Derived from
 *  find_agents({...}) calls in the source agent's prompt — DESIGN INTENT, not
 *  runtime-observed calls and not an enforced capability boundary. */
export type DelegationEdge = { from: string; to: string }

/** The resolvable fields of a find_agents query. `query` (free text) is
 *  intentionally excluded — it cannot be resolved to specific agents. */
type ParsedQuery = { role?: string; team?: string; teamRole?: string; capability?: string }

const FIND_AGENTS_RE = /find_agents\(\s*\{([^}]*)\}\s*\)/g

const stringField = (body: string, key: string): string | undefined => {
  const m = new RegExp(`\\b${key}\\s*:\\s*['"]([^'"]+)['"]`).exec(body)
  return m ? m[1] : undefined
}

/** Extract the resolvable queries from a prompt. Calls with no resolvable
 *  field (no object, or query-only) are skipped. */
function parseQueries(prompt: string): ParsedQuery[] {
  const out: ParsedQuery[] = []
  for (const m of prompt.matchAll(FIND_AGENTS_RE)) {
    const body = m[1]
    const q: ParsedQuery = {
      role: stringField(body, 'role'),
      team: stringField(body, 'team'),
      teamRole: stringField(body, 'teamRole'),
      capability: stringField(body, 'capability'),
    }
    if (q.role || q.team || q.teamRole || q.capability) out.push(q)
  }
  return out
}

/** Intersection match, mirroring the directory receptionist's filter. */
function matches(agent: AgentDefinition, q: ParsedQuery): boolean {
  if (q.role && agent.role !== q.role) return false
  if (q.team && agent.team !== q.team) return false
  if (q.teamRole && agent.teamRole !== q.teamRole) return false
  if (q.capability && !(agent.capabilities ?? []).includes(q.capability)) return false
  return true
}

export function buildDelegationEdges(agents: AgentDefinition[]): DelegationEdge[] {
  const seen = new Set<string>()
  const edges: DelegationEdge[] = []
  for (const from of agents) {
    for (const q of parseQueries(from.systemPrompt)) {
      for (const to of agents) {
        if (to.id === from.id || !matches(to, q)) continue
        const key = `${from.id}→${to.id}`
        if (seen.has(key)) continue
        seen.add(key)
        edges.push({ from: from.id, to: to.id })
      }
    }
  }
  return edges.sort((x, y) => x.from.localeCompare(y.from) || x.to.localeCompare(y.to))
}
