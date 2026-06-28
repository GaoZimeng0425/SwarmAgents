import type { AgentTool } from '@earendil-works/pi-agent-core'
import { Type } from '@earendil-works/pi-ai'
import { type AcceptanceCriterion, ExecutableCheckSchema } from '@shared/types/task'

import type { ToolRunContext, ToolSpec } from './registry'

type Result = { content: [{ type: 'text'; text: string }]; details: Record<string, unknown> }
const ok = (text: string, details: Record<string, unknown> = {}): Result => ({
  content: [{ type: 'text', text }],
  details,
})
const err = (message: string): Result => ok(`error: ${message}`, { error: message })

const Params = Type.Object({
  criteria: Type.Array(
    Type.Object({
      description: Type.String({ description: 'A single, checkable done-condition for the task.' }),
      check: Type.Optional(
        Type.Object({
          kind: Type.String({ description: "'command' or 'file_exists'." }),
          command: Type.Optional(
            Type.String({ description: "Shell command (kind='command'); passes on expectExitCode (default 0)." })
          ),
          cwd: Type.Optional(Type.String({ description: 'Working directory for the command.' })),
          expectExitCode: Type.Optional(Type.Number({ description: 'Expected exit code (default 0).' })),
          expectStdout: Type.Optional(Type.String({ description: 'Substring that must appear in stdout.' })),
          path: Type.Optional(Type.String({ description: "File path that must exist (kind='file_exists')." })),
        })
      ),
    }),
    {
      description:
        'Acceptance criteria for this task. Each is a checkable done-condition. Attach a `check` ' +
        '(command or file_exists) when a command or file can verify it deterministically; leave it off ' +
        'when only judgment applies.',
    }
  ),
})

// Records the task's acceptance criteria (Phase A of the goal-verify loop). The
// model owns the list; ids are assigned here (c1..cn) so later verify rounds can
// reference each criterion stably. Routed to the runner via ctx.setAcceptanceCriteria.
export function acceptanceCriteriaSpec(): ToolSpec {
  return {
    group: 'agent',
    name: 'set_acceptance_criteria',
    risk: 'low',
    source: 'builtin',
    build: (ctx: ToolRunContext): AgentTool => ({
      name: 'set_acceptance_criteria',
      label: 'Set acceptance criteria',
      description:
        'Define how this task will be judged complete: a list of checkable done-conditions. ' +
        'Attach a `check` to any criterion a command or file can verify; the rest are judged against your summary. ' +
        'Call this once, before doing the task.',
      parameters: Params,
      execute: async (_id: string, params: unknown) => {
        const raw = (params as { criteria?: unknown }).criteria
        if (!Array.isArray(raw) || raw.length === 0) return err('criteria must be a non-empty array')
        const criteria: AcceptanceCriterion[] = []
        for (let i = 0; i < raw.length; i++) {
          const item = raw[i] as { description?: unknown; check?: unknown }
          if (typeof item.description !== 'string' || item.description.trim().length === 0) {
            return err(`criterion ${i + 1} needs a non-empty description`)
          }
          let check: AcceptanceCriterion['check']
          if (item.check && typeof item.check === 'object') {
            const parsed = ExecutableCheckSchema.safeParse(item.check)
            if (!parsed.success) {
              return err(`criterion ${i + 1} has an invalid check: ${parsed.error.issues[0]?.message ?? 'invalid'}`)
            }
            check = parsed.data
          }
          criteria.push({ id: `c${i + 1}`, description: item.description.trim(), ...(check ? { check } : {}) })
        }
        if (!ctx.setAcceptanceCriteria) return err('acceptance criteria are not accepted in this context')
        ctx.setAcceptanceCriteria(criteria)
        const lines = criteria.map((c) => `- ${c.description}${c.check ? ` [${c.check.kind}]` : ''}`)
        return ok(`Acceptance criteria recorded (${criteria.length}):\n${lines.join('\n')}`, { criteria })
      },
    }),
  }
}
