import type { AgentTool } from '@earendil-works/pi-agent-core'
import { Type } from '@earendil-works/pi-ai'
import type { Artifact } from '@swarm/protocol'

import type { ToolRunContext, ToolSpec } from './registry'

const Params = Type.Object({
  artifacts: Type.Array(
    Type.Object({
      kind: Type.Enum({ file: 'file', note: 'note', image: 'image' }),
      path: Type.Optional(Type.String()),
      text: Type.Optional(Type.String()),
      meta: Type.Optional(Type.Record(Type.String(), Type.Unknown())),
    }),
    { description: 'Structured results from this run — files produced, notes, images, etc.' }
  ),
})

export function reportResultSpec(): ToolSpec {
  return {
    group: 'agent',
    name: 'report_result',
    risk: 'low',
    source: 'builtin',
    build: (ctx: ToolRunContext): AgentTool => ({
      name: 'report_result',
      label: 'Report Result',
      description:
        'Submit structured results (artifacts) from this run to the parent. Call this when the task is done, in addition to writing a summary. Artifacts complement your text summary with machine-readable outputs.',
      parameters: Params,
      execute: async (_toolCallId: string, params: unknown) => {
        const p = params as { artifacts: Artifact[] }
        if (!ctx.reportResult) {
          return {
            content: [{ type: 'text' as const, text: 'report_result is not available in this context.' }],
            details: { error: 'not_wired' },
          }
        }
        ctx.reportResult(p.artifacts)
        return {
          content: [{ type: 'text' as const, text: `Reported ${p.artifacts.length} artifact(s).` }],
          details: { artifacts: p.artifacts },
        }
      },
    }),
  }
}
