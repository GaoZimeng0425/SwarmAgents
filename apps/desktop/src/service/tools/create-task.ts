import type { AgentTool } from '@earendil-works/pi-agent-core'
import { Type } from '@earendil-works/pi-ai'
import type { AcceptanceCriterion } from '@swarm/protocol'

import type { ToolRunContext, ToolSpec } from './registry'

const CreateTaskParams = Type.Object({
  goal: Type.String({ description: 'The concrete goal of the work task.' }),
  acceptanceCriteria: Type.Optional(
    Type.Array(
      Type.Object({
        description: Type.String({ description: 'A checkable done-condition for the task.' }),
        check: Type.Optional(
          Type.Object({
            kind: Type.String({ description: "'command' or 'file_exists'." }),
            command: Type.Optional(Type.String()),
            expectExitCode: Type.Optional(Type.Number()),
            expectStdout: Type.Optional(Type.String()),
            path: Type.Optional(Type.String()),
          })
        ),
      })
    )
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
        "Create a real work task that runs the verify loop and appears in the task panel. Use this when the user's request is substantial work needing its own task tracking — NOT for trivial questions you can answer directly in the conversation. Returns the task's result.",
      parameters: CreateTaskParams,
      execute: async (_toolCallId: string, params: unknown) => {
        const p = params as { goal: string; acceptanceCriteria?: AcceptanceCriterion[] }
        if (!ctx.createTask) {
          return {
            content: [{ type: 'text' as const, text: 'create_task is not available in this context.' }],
            details: { error: 'not_wired' },
          }
        }
        const { taskId, result } = await ctx.createTask(p.goal, p.acceptanceCriteria)
        return {
          content: [{ type: 'text' as const, text: result.summary }],
          details: { taskId, summary: result.summary },
        }
      },
    }),
  }
}
