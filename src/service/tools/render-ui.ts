import type { AgentTool } from '@earendil-works/pi-agent-core'
import { Type } from '@earendil-works/pi-ai'
import { createLogger } from '@shared/logger'

import type { ToolRunContext, ToolSpec } from './registry'

const log = createLogger({ process: 'service' }).child({ component: 'render-ui' })

const RenderUiParams = Type.Object({
  type: Type.String({ description: "UI card type, e.g. 'weather' | 'choice'. Frontend renders by this key." }),
  props: Type.Optional(Type.Any({ description: 'Arbitrary data the chosen renderer consumes.' })),
})

// Card types that wait on a user decision. After rendering one of these the
// agent has nothing more to do this turn — its tool result carries
// `terminate: true` so pi's loop ends the turn instead of issuing another LLM
// call. Without this the model spins on "let me wait for the user" reasoning,
// since there is no other signal that the turn is over.
const INTERACTIVE_CARD_TYPES = new Set(['choice'])

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
        ' Use type "choice" with an options array (no question — ask that in your message text) ' +
        'when you need the user to make a decision; their click is returned to you as a new user message.',
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
        const interactive = INTERACTIVE_CARD_TYPES.has(type)
        toolLog.info({ msg: 'render_ui card emitted', type, interactive })
        return {
          content: [
            {
              type: 'text',
              text: interactive
                ? `Rendered ${type} card. End your turn now — do not call more tools or keep reasoning. The user's choice arrives later as a new message.`
                : `rendered ui card: ${type}`,
            },
          ],
          details: { type, props: p.props },
          // Interactive cards end the turn structurally: pi reads this hint and
          // stops after the batch instead of prompting the model again.
          ...(interactive ? { terminate: true } : {}),
        }
      },
    }),
  }
}
