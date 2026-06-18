import type { AgentTool } from '@earendil-works/pi-agent-core'
import { Type } from '@earendil-works/pi-ai'
import { createLogger } from '@shared/logger'

import type { ToolRunContext, ToolSpec } from './registry'

const log = createLogger({ process: 'service' }).child({ component: 'render-ui' })

const RenderUiParams = Type.Object({
  type: Type.String({ description: "UI card type, e.g. 'weather' | 'choice'. Frontend renders by this key." }),
  props: Type.Optional(Type.Any({ description: 'Arbitrary data the chosen renderer consumes.' })),
})

// Renders a typed UI card into the conversation. Non-blocking: the tool returns
// immediately and the card rides the persisted tool-call event. Interactive
// cards (e.g. 'choice') surface the user's click as a brand-new user message,
// so there is no awaited promise here.
export function renderUiSpec(): ToolSpec {
  return {
    group: 'ui',
    name: 'render_ui',
    risk: 'low',
    source: 'builtin',
    build: (ctx: ToolRunContext): AgentTool => ({
      name: 'render_ui',
      label: 'Render a UI card',
      description:
        'Render a typed UI card in the conversation (e.g. a weather card, a choice prompt). ' +
        "Non-blocking: returns immediately. If the card is interactive, the user's click arrives " +
        'later as a new user message — do not wait on this call for an answer.' +
        ' Use type "choice" with a question and options when you need the user to make a decision; their click is returned to you as a new user message.',
      parameters: RenderUiParams,
      execute: async (_id: string, params: unknown) => {
        const p = params as { type?: unknown; props?: unknown }
        const type = typeof p.type === 'string' ? p.type.trim() : ''
        const toolLog = log.child({ sessionId: ctx.sessionId, taskId: ctx.taskId })
        if (!type) {
          const msg = 'render_ui needs a non-empty "type"'
          toolLog.warn({ msg: 'render_ui invalid input' })
          return { content: [{ type: 'text', text: `error: ${msg}` }], details: { error: msg } }
        }
        toolLog.info({ msg: 'render_ui card emitted', type })
        return {
          content: [{ type: 'text', text: `rendered ui card: ${type}` }],
          details: { type, props: p.props },
        }
      },
    }),
  }
}
