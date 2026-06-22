import type { AgentTool } from '@earendil-works/pi-agent-core'
import { Type } from '@earendil-works/pi-ai'

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
        return { content: [{ type: 'text', text: `Message delivered to ${p.to}.` }] }
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
      }),
    }),
  }
}
