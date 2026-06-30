import type { AgentTool } from '@earendil-works/pi-agent-core'
import { Type } from '@earendil-works/pi-ai'

import type { AcceptanceCriterion, SpawnChildOptions } from '@shared/types/task'

import { DEFAULT_MAX_VERIFY_ROUNDS } from '../session/agent-runner'
import type { ToolRunContext, ToolSpec } from './registry'

const SpawnParams = Type.Object({
  goal: Type.String({ description: 'The goal for the sub-agent to accomplish.' }),
  agentType: Type.Optional(
    Type.String({
      description:
        'Which sub-agent type to use; see the available types in your prompt. Defaults to "default" (full tool access).',
    })
  ),
  suggestedTools: Type.Optional(
    Type.Array(Type.String(), {
      description: 'Override the agent type\'s default tools with these scopes (e.g. ["peekaboo"]).',
    })
  ),
  providerKey: Type.Optional(
    Type.String({
      description: 'Key of a configured provider to use for this sub-agent. Defaults to current session provider.',
    })
  ),
  acceptanceCriteria: Type.Optional(
    Type.Array(
      Type.Object({
        description: Type.String({ description: "A checkable done-condition passed down as this sub-agent's contract." }),
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
  verify: Type.Optional(
    Type.Boolean({
      description:
        'true = this sub-agent runs its own verify loop (use for Leaders that must self-verify); false/omit = single-shot leaf verified by the caller.',
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
        'Delegate a focused sub-task to a sub-agent. Delegate when a sub-task is independent, benefits from its own focused context, or should run under a narrower capability boundary; do trivial single-step work yourself. Pick an agentType from the list in your prompt. The sub-agent runs independently and returns its result. Pass acceptanceCriteria to set its done-conditions, and verify=true when the sub-agent (e.g. a team Leader) must self-verify its own output.',
      parameters: SpawnParams,
      execute: async (_toolCallId: string, params: unknown) => {
        const p = params as {
          goal: string
          agentType?: string
          suggestedTools?: string[]
          providerKey?: string
          acceptanceCriteria?: AcceptanceCriterion[]
          verify?: boolean
        }
        const options: SpawnChildOptions | undefined =
          p.acceptanceCriteria || p.verify
            ? {
                ...(p.acceptanceCriteria ? { acceptanceCriteria: p.acceptanceCriteria } : {}),
                ...(p.verify ? { maxVerifyRounds: DEFAULT_MAX_VERIFY_ROUNDS } : {}),
              }
            : undefined
        const { childTaskId, result } = await ctx.spawnChild(p.goal, p.suggestedTools, p.providerKey, p.agentType, options)
        return {
          content: [{ type: 'text', text: result.summary }],
          details: { childTaskId, summary: result.summary },
        }
      },
    }),
  }
}
