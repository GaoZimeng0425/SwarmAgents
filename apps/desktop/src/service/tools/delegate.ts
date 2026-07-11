import type { AgentTool } from '@earendil-works/pi-agent-core'
import { Type } from '@earendil-works/pi-ai'
import type { DelegateResult } from '@swarm/protocol'

import type { ToolRunContext, ToolSpec } from './registry'

const DelegateParams = Type.Object({
  prompt: Type.String({ description: 'The prompt for the run — the concrete task it must accomplish.' }),
  topLevel: Type.Optional(
    Type.Boolean({
      description:
        'true = a prominent top-level run you own and do yourself (main budget, shown as a top-level card). false (default) = a child run nested under you, delegated to a sub-agent.',
    })
  ),
  agentType: Type.Optional(
    Type.String({ description: 'Sub-agent type (see the list in your prompt). Defaults to "default".' })
  ),
  suggestedTools: Type.Optional(
    Type.Array(Type.String(), { description: "Override the agent type's default tools (child run only)." })
  ),
  providerKey: Type.Optional(
    Type.String({ description: 'Key of a configured provider for this run (child run only).' })
  ),
})

// A non-completed message surfaces its disposition to the parent as a prefix, so the
// model does not read a failed/cancelled child's partial summary as success.
function delegateResult(messageId: string, status: DelegateResult['status'], summary: string) {
  const prefix = status && status !== 'completed' ? `[${status}] ` : ''
  return {
    content: [{ type: 'text' as const, text: `${prefix}${summary}` }],
    details: { messageId, status, summary },
  }
}

export function delegateSpec(): ToolSpec {
  return {
    group: 'agent',
    name: 'delegate',
    risk: 'medium',
    source: 'builtin',
    build: (ctx: ToolRunContext): AgentTool => ({
      name: 'delegate',
      label: 'Delegate',
      description:
        'Run a prompt as a separate single-shot run. Default: a child run nested under you, delegated to a focused sub-agent (optionally a specialized agentType). topLevel: true = a prominent top-level run you own and do yourself (main budget). Review the returned summary yourself before reporting done.',
      parameters: DelegateParams,
      execute: async (_toolCallId: string, params: unknown) => {
        const p = params as {
          prompt: string
          topLevel?: boolean
          agentType?: string
          suggestedTools?: string[]
          providerKey?: string
        }
        if (p.topLevel) {
          if (!ctx.createTask) {
            return {
              content: [{ type: 'text' as const, text: 'delegate topLevel is not available in this context.' }],
              details: { error: 'not_wired' },
            }
          }
          const { messageId, status, summary } = await ctx.createTask(p.prompt, p.agentType)
          return delegateResult(messageId, status, summary)
        }
        if (!ctx.spawnChild) {
          return {
            content: [{ type: 'text' as const, text: 'delegate is not available in this context.' }],
            details: { error: 'not_wired' },
          }
        }
        const { messageId, status, summary } = await ctx.spawnChild(p.prompt, {
          suggestedTools: p.suggestedTools,
          providerKey: p.providerKey,
          agentType: p.agentType,
        })
        return delegateResult(messageId, status, summary)
      },
    }),
  }
}
