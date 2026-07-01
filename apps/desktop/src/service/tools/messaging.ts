import type { AgentTool } from '@earendil-works/pi-agent-core'
import { Type } from '@earendil-works/pi-ai'
import type { PeerQuery } from '@swarm/protocol'

import type { ToolRunContext, ToolSpec } from './registry'

const SendParams = Type.Object({
  to: Type.String({ description: 'Target actor address (ULID) or its session-scoped readable name.' }),
  payload: Type.String({ description: 'The message / instruction for the target actor.' }),
})

export function sendMessageSpec(): ToolSpec {
  return {
    group: 'agent',
    name: 'send_message',
    risk: 'medium',
    source: 'builtin',
    build: (ctx: ToolRunContext): AgentTool => ({
      name: 'send_message',
      label: 'Send message',
      description:
        'Fire-and-forget: deliver a message to another agent by address or name and continue immediately without waiting for a reply. Use for notifications or async hand-offs.',
      parameters: SendParams,
      execute: async (_id: string, params: unknown) => {
        const p = params as { to: string; payload: string }
        await ctx.sendMessage(p.to, p.payload)
        return { content: [{ type: 'text', text: `Message delivered to ${p.to}.` }], details: {} }
      },
    }),
  }
}

export function sendAndWaitSpec(): ToolSpec {
  return {
    group: 'agent',
    name: 'send_and_wait',
    risk: 'medium',
    source: 'builtin',
    build: (ctx: ToolRunContext): AgentTool => ({
      name: 'send_and_wait',
      label: 'Send and wait for reply',
      description:
        'RPC: deliver a message to another agent by address or name and wait for its reply. Use when you need the other agent to do something and return a result to you (e.g. ask a reviewer to critique a draft).',
      parameters: SendParams,
      execute: async (_id: string, params: unknown) => {
        const p = params as { to: string; payload: string }
        const reply = await ctx.sendAndWait(p.to, p.payload)
        return { content: [{ type: 'text', text: reply }], details: { to: p.to } }
      },
    }),
  }
}

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
    Type.String({ description: 'Filter to a team role; use "head" to find each team\'s entry-point agent.' })
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
        'Discover other agents in this session by role, capability, or free-text query. Returns their names and addresses so you can reach them with send_message / send_and_wait. Call with no arguments to list everyone available.',
      parameters: FindParams,
      execute: async (_id: string, params: unknown) => {
        const peers = ctx.findPeers((params ?? {}) as PeerQuery)
        if (peers.length === 0) {
          return { content: [{ type: 'text', text: 'No matching agents in this session.' }], details: {} }
        }
        const lines = peers.map((p) => {
          const caps = p.capabilities.length ? ` · caps: ${p.capabilities.join(', ')}` : ''
          const team = p.team ? ` · team ${p.team}${p.teamRole === 'head' ? ' (head)' : ''}` : ''
          return `- ${p.name ?? '(unnamed)'} (role ${p.role}) · ${p.address} · ${p.status}${team} · ${p.description}${caps}`
        })
        return { content: [{ type: 'text', text: lines.join('\n') }], details: { count: peers.length } }
      },
    }),
  }
}

export function whoamiSpec(): ToolSpec {
  return {
    group: 'agent',
    name: 'whoami',
    risk: 'low',
    source: 'builtin',
    build: (ctx: ToolRunContext): AgentTool => ({
      name: 'whoami',
      label: 'Get my address',
      description: 'Return your own actor address so you can share it with peers who should message you back.',
      parameters: Type.Object({}),
      execute: async () => ({
        content: [
          {
            type: 'text',
            text: ctx.selfAddress ?? '(no address: this agent is not addressable)',
          },
        ],
        details: {},
      }),
    }),
  }
}
