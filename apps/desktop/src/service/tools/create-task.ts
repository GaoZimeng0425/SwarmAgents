import type { AgentTool } from '@earendil-works/pi-agent-core'
import { Type } from '@earendil-works/pi-ai'

import type { ToolRunContext, ToolSpec } from './registry'

const CreateTaskParams = Type.Object({
  goal: Type.String({ description: 'The concrete goal of the run.' }),
  asTopLevel: Type.Optional(
    Type.Boolean({
      description:
        'true = a top-level task you own and do yourself (appears as a prominent top-level card). false (default) = delegate to a sub-agent (a child run nested under the current one).',
    })
  ),
  agentType: Type.Optional(
    Type.String({ description: 'Sub-agent type (see the list in your prompt). Defaults to "default".' })
  ),
  suggestedTools: Type.Optional(
    Type.Array(Type.String(), { description: "Override the agent type's default tools (spawn path only)." })
  ),
  providerKey: Type.Optional(
    Type.String({ description: 'Key of a configured provider for this run (spawn path only).' })
  ),
})

export function createTaskSpec(): ToolSpec {
  return {
    group: 'agent',
    name: 'create_task',
    risk: 'medium',
    source: 'builtin',
    build: (ctx: ToolRunContext): AgentTool => ({
      name: 'create_task',
      label: 'Create task',
      description:
        'Create a run. Use asTopLevel: true for substantial work you will do yourself (tracked as a top-level task); omit it (or asTopLevel: false) to delegate a focused sub-task to a sub-agent (optionally a specialized agentType). Runs single-shot; review the result yourself before reporting done.',
      parameters: CreateTaskParams,
      execute: async (_toolCallId: string, params: unknown) => {
        const p = params as {
          goal: string
          asTopLevel?: boolean
          agentType?: string
          suggestedTools?: string[]
          providerKey?: string
        }
        if (p.asTopLevel) {
          if (!ctx.createTask) {
            return {
              content: [{ type: 'text' as const, text: 'create_task is not available in this context.' }],
              details: { error: 'not_wired' },
            }
          }
          const { taskId, result } = await ctx.createTask(p.goal, p.agentType)
          return {
            content: [{ type: 'text' as const, text: result.summary }],
            details: { taskId, summary: result.summary },
          }
        }
        if (!ctx.spawnChild) {
          return {
            content: [{ type: 'text' as const, text: 'spawn is not available in this context.' }],
            details: { error: 'not_wired' },
          }
        }
        const { childTaskId, result } = await ctx.spawnChild(p.goal, p.suggestedTools, p.providerKey, p.agentType)
        return {
          content: [{ type: 'text' as const, text: result.summary }],
          details: { childTaskId, summary: result.summary },
        }
      },
    }),
  }
}
