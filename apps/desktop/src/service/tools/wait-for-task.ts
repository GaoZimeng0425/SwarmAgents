import type { AgentTool } from '@earendil-works/pi-agent-core'
import { Type } from '@earendil-works/pi-ai'

import type { TaskWaiterService } from '../loop/task-waiters'
import type { ToolRunContext, ToolSpec } from './registry'

type Result = { content: [{ type: 'text'; text: string }]; details: Record<string, unknown> }
const ok = (text: string, details: Record<string, unknown> = {}): Result => ({
  content: [{ type: 'text', text }],
  details,
})
const err = (message: string): Result => ok(`error: ${message}`, { error: message })

const WaitParams = Type.Object({
  taskId: Type.String({ description: 'Id of the task to wait for (e.g. a child task you spawned, or a peer\'s task).' }),
  goal: Type.Optional(
    Type.String({
      description:
        'Optional goal to run when the awaited task finishes. Omit to receive a default "continue your work" wake.',
    })
  ),
})

function waitForTaskTool(service: TaskWaiterService, ctx: ToolRunContext): AgentTool {
  return {
    name: 'wait_for_task',
    label: 'Wait for task',
    description:
      'Pause until another task reaches a terminal state, then wake yourself to continue. Your current turn ends after calling this; you will be re-activated when the awaited task finishes (or immediately if it has already finished). Use this to wait on a child task or a peer agent before continuing your loop.',
    parameters: WaitParams,
    execute: async (_id: string, params: unknown) => {
      const p = params as { taskId?: string; goal?: string }
      if (!p.taskId) return err('taskId is required')
      if (!ctx.selfAddress)
        return err('this agent is not addressable, so it cannot be woken later; wait_for_task is unavailable')
      const { firedImmediately } = service.register({
        sessionId: ctx.sessionId,
        waiterAddress: ctx.selfAddress,
        taskId: p.taskId,
        goal: p.goal ?? null,
      })
      return ok(
        firedImmediately
          ? `task ${p.taskId} has already finished; you will be woken immediately`
          : `waiting for task ${p.taskId}; you will be woken when it finishes`,
        { taskId: p.taskId, firedImmediately }
      )
    },
  }
}

// wait_for_task arms an autonomous continuation (a future self-wake), so it is
// medium risk like schedule_task / send_message.
export function waitForTaskSpecs(service: TaskWaiterService): ToolSpec[] {
  return [
    {
      group: 'loop',
      name: 'wait_for_task',
      risk: 'medium' as const,
      source: 'builtin' as const,
      build: (ctx) => waitForTaskTool(service, ctx),
    },
  ]
}
