import type { AgentTool } from '@earendil-works/pi-agent-core'
import { Type } from '@earendil-works/pi-ai'

import type { ToolRunContext, ToolSpec } from './registry'

const SpawnParams = Type.Object({
  goal: Type.String({ description: 'The goal for the sub-agent to accomplish.' }),
  suggestedTools: Type.Optional(
    Type.Array(Type.String(), { description: 'Tool scopes to make available (e.g. ["peekaboo"]).' })
  ),
  providerKey: Type.Optional(
    Type.String({
      description: 'Key of a configured provider to use for this sub-agent. Defaults to current session provider.',
    })
  ),
})

export function spawnAgentSpec(): ToolSpec {
  return {
    group: 'agent',
    name: 'spawn_sub_agent',
    risk: 'medium',
    source: 'builtin',
    build: (ctx: ToolRunContext): AgentTool => ({
      name: 'spawn_sub_agent',
      label: 'Spawn sub-agent',
      description:
        'Delegate a sub-task to a specialized agent. Use for research, analysis, or actions that benefit from a focused context. The sub-agent runs independently and returns its result.',
      parameters: SpawnParams,
      execute: async (_toolCallId: string, params: unknown) => {
        const p = params as { goal: string; suggestedTools?: string[]; providerKey?: string }
        const { childTaskId, result } = await ctx.spawnChild(p.goal, p.suggestedTools, p.providerKey)
        return {
          content: [{ type: 'text', text: result.summary }],
          details: { childTaskId, summary: result.summary },
        }
      },
    }),
  }
}
