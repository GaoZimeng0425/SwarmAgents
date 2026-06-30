import type { AgentTool } from '@earendil-works/pi-agent-core'
import { Type } from '@earendil-works/pi-ai'

import type { DelegationItem } from '@shared/types/task'
import { AcceptanceCriterionSchema } from '@shared/types/task'

import type { ToolRunContext, ToolSpec } from './registry'

type Result = { content: [{ type: 'text'; text: string }]; details: Record<string, unknown> }
const ok = (text: string, details: Record<string, unknown> = {}): Result => ({ content: [{ type: 'text', text }], details })
const err = (message: string): Result => ok(`error: ${message}`, { error: message })

const Params = Type.Object({
  items: Type.Array(
    Type.Object({
      goal: Type.String({ description: 'The sub-goal this delegation item accomplishes.' }),
      ownerAgentType: Type.Optional(
        Type.String({ description: 'Sub-agent type to spawn for this item (from your prompt). Omit for default.' })
      ),
      dependsOn: Type.Optional(
        Type.Array(Type.String(), {
          description: 'Sibling item ids that must finish first. Omit/empty for a first-wave (parallelizable) item.',
        })
      ),
      acceptanceCriteria: Type.Optional(
        Type.Array(
          Type.Object({
            description: Type.String({ description: 'A checkable done-condition for this item.' }),
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
    }),
    {
      description:
        "The delegation DAG. Dispatch items in dependency waves: items whose dependsOn are all done go in one parallel wave; the next wave starts when the previous completes. Attach acceptanceCriteria to pass down as each sub-agent's contract.",
    }
  ),
})

// Records the Leader's delegation DAG. The model owns the list; ids are assigned
// here (d1..dn) so dependsOn can reference items stably. dependsOn is validated
// against earlier item ids (forward references are rejected). Routed to the runner
// via ctx.setDelegationPlan. Dispatch itself is prompt-driven (the Leader calls
// spawn_sub_agent per item); this tool only records the plan for audit + UI.
export function delegationPlanSpec(): ToolSpec {
  return {
    group: 'agent',
    name: 'set_delegation_plan',
    risk: 'low',
    source: 'builtin',
    build: (ctx: ToolRunContext): AgentTool => ({
      name: 'set_delegation_plan',
      label: 'Set delegation plan',
      description:
        'Declare how you will delegate this task to sub-agents: a DAG of items, each with a sub-goal, an owner agent type, optional dependsOn (sibling ids), and optional per-item acceptance criteria. Dispatch items in dependency waves — all items whose dependencies are met, spawned in parallel this turn; the next wave when they return. Call this before dispatching.',
      parameters: Params,
      execute: async (_id: string, params: unknown) => {
        const raw = (params as { items?: unknown }).items
        if (!Array.isArray(raw) || raw.length === 0) return err('items must be a non-empty array')
        const knownIds = new Set<string>()
        const items: DelegationItem[] = []
        for (let i = 0; i < raw.length; i++) {
          const item = raw[i] as {
            goal?: unknown
            ownerAgentType?: unknown
            dependsOn?: unknown
            acceptanceCriteria?: unknown
          }
          if (typeof item.goal !== 'string' || item.goal.trim().length === 0) {
            return err(`item ${i + 1} needs a non-empty goal`)
          }
          const id = `d${i + 1}`
          let deps: string[] = []
          if (Array.isArray(item.dependsOn)) {
            deps = item.dependsOn.filter((d): d is string => typeof d === 'string' && d.trim().length > 0)
            for (const d of deps) {
              if (!knownIds.has(d)) return err(`item ${i + 1} dependsOn unknown id "${d}" (must reference an earlier item)`)
            }
          }
          let criteria: DelegationItem['acceptanceCriteria']
          if (Array.isArray(item.acceptanceCriteria)) {
            const parsed: NonNullable<DelegationItem['acceptanceCriteria']> = []
            for (let j = 0; j < item.acceptanceCriteria.length; j++) {
              const c = item.acceptanceCriteria[j]
              const p = AcceptanceCriterionSchema.safeParse({ ...(c as object), id: `c${j + 1}` })
              if (!p.success) return err(`item ${i + 1} criterion ${j + 1} invalid: ${p.error.issues[0]?.message ?? 'invalid'}`)
              parsed.push(p.data)
            }
            if (parsed.length > 0) criteria = parsed
          }
          const entry: DelegationItem = {
            id,
            goal: item.goal.trim(),
            dependsOn: deps,
            ...(item.ownerAgentType ? { ownerAgentType: String(item.ownerAgentType) } : {}),
            ...(criteria ? { acceptanceCriteria: criteria } : {}),
          }
          items.push(entry)
          knownIds.add(id)
        }
        if (!ctx.setDelegationPlan) return err('delegation plans are not accepted in this context')
        ctx.setDelegationPlan(items)
        const lines = items.map(
          (it) =>
            `- ${it.id}: ${it.goal}${it.ownerAgentType ? ` [${it.ownerAgentType}]` : ''}${it.dependsOn.length ? ` (after ${it.dependsOn.join(',')})` : ''}`
        )
        return ok(`Delegation plan recorded (${items.length}):\n${lines.join('\n')}`, { plan: items })
      },
    }),
  }
}
