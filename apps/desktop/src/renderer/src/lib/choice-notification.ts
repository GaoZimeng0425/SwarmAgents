import type { UIEvent } from '@swarm/protocol'

import { coerceProps } from '@/components/ui-renderers'

/**
 * If the event is a `render_ui` choice card (single- or multi-select), return
 * its question text for a system notification; otherwise null. Reads the tool
 * args the same way the transcript does — `props` may arrive as a JSON string.
 */
export function parseChoiceCard(e: UIEvent): { question: string } | null {
  if (e.kind !== 'run.progress') return null
  const inner = e.event
  if (inner.kind !== 'tool.call' || inner.tool !== 'render_ui') return null
  const args = (inner.args ?? {}) as { type?: unknown; props?: unknown }
  if (args.type !== 'choice') return null
  const props = (coerceProps(args.props) ?? {}) as { question?: unknown }
  const question = typeof props.question === 'string' && props.question.trim() ? props.question.trim() : '需要你的选择'
  return { question }
}
