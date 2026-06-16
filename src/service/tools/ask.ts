import type { AgentTool } from '@earendil-works/pi-agent-core'
import { Type } from '@earendil-works/pi-ai'

import type { ToolRunContext, ToolSpec } from './registry'

const AskParams = Type.Object({
  question: Type.String({ description: 'The question or decision to put to the user.' }),
  options: Type.Array(
    Type.Object({
      label: Type.String({ description: 'Button text shown to the user.' }),
      value: Type.Optional(Type.String({ description: 'Value returned when chosen. Defaults to the label.' })),
    }),
    { description: 'The choices to offer as buttons. Must be non-empty.' }
  ),
  mode: Type.Optional(Type.String({ description: "'single' (pick one) or 'multi' (pick several). Default 'single'." })),
})

// Pauses the run to ask a human for a decision, surfacing the options as
// clickable buttons in the UI. Use when a judgment call genuinely needs a
// person — not for things you can decide yourself.
export function askUserSpec(): ToolSpec {
  return {
    group: 'agent',
    name: 'ask_user',
    risk: 'low',
    source: 'builtin',
    build: (ctx: ToolRunContext): AgentTool => ({
      name: 'ask_user',
      label: 'Ask the user',
      description:
        'Ask the human to make a choice and wait for their answer. Present 2+ options; they ' +
        "click one (mode 'single') or several (mode 'multi'). Use only when a decision genuinely " +
        'needs human judgment. The chosen answer is returned to you as the tool result.',
      parameters: AskParams,
      execute: async (_id: string, params: unknown) => {
        const p = params as { question?: string; options?: { label: string; value?: string }[]; mode?: string }
        const question = typeof p.question === 'string' ? p.question.trim() : ''
        const options = (p.options ?? []).filter((o) => typeof o?.label === 'string' && o.label.trim().length > 0)
        if (!question || options.length === 0) {
          const msg = 'ask_user needs a question and a non-empty options array'
          return { content: [{ type: 'text', text: `error: ${msg}` }], details: { error: msg } }
        }
        const mode = p.mode === 'multi' ? 'multi' : 'single'
        const answer = await ctx.askUser({ question, options, mode })
        return { content: [{ type: 'text', text: answer }], details: { answer } }
      },
    }),
  }
}
