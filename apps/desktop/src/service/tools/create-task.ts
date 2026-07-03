import type { AgentTool } from '@earendil-works/pi-agent-core'
import { Type } from '@earendil-works/pi-ai'

import type { ToolRunContext, ToolSpec } from './registry'

const CreateTaskParams = Type.Object({
  goal: Type.String({ description: 'The concrete goal of the work task.' }),
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
        "Create a real work task that you will do yourself, appearing in the task panel. Use this when the user's request is substantial work worth its own tracked task — NOT for trivial questions you can answer directly. You own verifying your own work before reporting done. Returns the task's result.",
      parameters: CreateTaskParams,
      execute: async (_toolCallId: string, params: unknown) => {
        const p = params as { goal: string }
        if (!ctx.createTask) {
          return {
            content: [{ type: 'text' as const, text: 'create_task is not available in this context.' }],
            details: { error: 'not_wired' },
          }
        }
        const { taskId, result } = await ctx.createTask(p.goal)
        return {
          content: [{ type: 'text' as const, text: result.summary }],
          details: { taskId, summary: result.summary },
        }
      },
    }),
  }
}
