import type { AgentTool } from '@earendil-works/pi-agent-core'
import { Type } from '@earendil-works/pi-ai'
import type { PeerQuery } from '@swarm/protocol'

import type { ToolRunContext, ToolSpec } from './registry'

const FindParams = Type.Object({
  role: Type.Optional(
    Type.String({ description: 'Filter to agents whose role exactly equals this, e.g. "engineer".' })
  ),
  capability: Type.Optional(Type.String({ description: 'Filter to agents advertising this capability tag.' })),
  query: Type.Optional(
    Type.String({
      description: 'Free text to rank matches by (matched against role, name, capabilities, description).',
    })
  ),
  team: Type.Optional(Type.String({ description: 'Filter to agents on this team, e.g. "dev" or "training".' })),
  teamRole: Type.Optional(
    Type.String({ description: 'Filter to a team role; use "head" to find each team\'s coordinating Lead.' })
  ),
})

export function findAgentsSpec(): ToolSpec {
  return {
    group: 'agent',
    name: 'find_agents',
    risk: 'low',
    source: 'builtin',
    build: (ctx: ToolRunContext): AgentTool => ({
      name: 'find_agents',
      label: 'Find agents',
      description:
        "Discover the agent types available for delegation, filtered by role, team, or free-text query. Each result's id is the agentType to pass to create_task. Call with no arguments to list everyone.",
      parameters: FindParams,
      execute: async (_id: string, params: unknown) => {
        const peers = ctx.findPeers((params ?? {}) as PeerQuery)
        if (peers.length === 0) {
          return { content: [{ type: 'text', text: 'No matching agents in this session.' }], details: {} }
        }
        const lines = peers.map((p) => {
          const caps = p.capabilities.length ? ` · caps: ${p.capabilities.join(', ')}` : ''
          const team = p.team ? ` · team ${p.team}${p.teamRole === 'head' ? ' (head)' : ''}` : ''
          return `- ${p.address} — ${p.name ?? p.address} (role ${p.role})${team} · ${p.description}${caps}`
        })
        return { content: [{ type: 'text', text: lines.join('\n') }], details: { count: peers.length } }
      },
    }),
  }
}
