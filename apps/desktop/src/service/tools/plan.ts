import type { AgentTool } from '@earendil-works/pi-agent-core'
import { Type } from '@earendil-works/pi-ai'

import type { ToolRunContext, ToolSpec } from './registry'

type Result = { content: [{ type: 'text'; text: string }]; details: Record<string, unknown> }
const ok = (text: string, details: Record<string, unknown> = {}): Result => ({
  content: [{ type: 'text', text }],
  details,
})
const err = (message: string): Result => ok(`error: ${message}`, { error: message })

const STATUSES = ['pending', 'in_progress', 'completed'] as const
type Status = (typeof STATUSES)[number]
type Todo = { content: string; status: Status }

function marker(status: Status): string {
  switch (status) {
    case 'pending':
      return '[ ]'
    case 'in_progress':
      return '[→]'
    case 'completed':
      return '[x]'
  }
}

function renderPlan(todos: Todo[]): string {
  const lines = todos.map((t) => `- ${marker(t.status)} ${t.content}`)
  return `Plan (${todos.length} step${todos.length === 1 ? '' : 's'}):\n${lines.join('\n')}`
}

const PlanParams = Type.Object({
  todos: Type.Array(
    Type.Object({
      content: Type.String({ description: 'A single step, phrased as an imperative.' }),
      status: Type.String({ description: "One of 'pending', 'in_progress', 'completed'." }),
    }),
    { description: 'The full plan. Replaces the previous plan in its entirety on every call.' }
  ),
})

// Maintains the agent's working plan for a multi-step task. The tool is
// stateless: the model owns the list and re-sends it whole each call; the
// rendered result keeps the current plan in recent context so the agent stays
// coherent over long tool sequences. (Persisting the plan + injecting it every
// turn is a deliberate later layer — see project_agent_env_blueprint.)
export function updatePlanSpec(): ToolSpec {
  return {
    group: 'agent',
    name: 'update_plan',
    risk: 'low',
    source: 'builtin',
    build: (_ctx: ToolRunContext): AgentTool => ({
      name: 'update_plan',
      label: 'Update plan',
      description:
        'Record or update your step-by-step plan for a multi-step task. Pass the full list each ' +
        'call (it replaces the previous one). Mark exactly one step in_progress as you work, flip ' +
        'it to completed when done. Use this to stay on track across many tool calls.',
      parameters: PlanParams,
      execute: async (_id: string, params: unknown) => {
        const raw = (params as { todos?: unknown }).todos
        if (!Array.isArray(raw) || raw.length === 0) {
          return err('todos must be a non-empty array')
        }
        const todos: Todo[] = []
        for (const item of raw) {
          const content = (item as { content?: unknown }).content
          const status = (item as { status?: unknown }).status
          if (typeof content !== 'string' || content.trim().length === 0) {
            return err('each todo needs a non-empty content string')
          }
          if (typeof status !== 'string' || !STATUSES.includes(status as Status)) {
            return err(`each todo status must be one of: ${STATUSES.join(', ')}`)
          }
          todos.push({ content: content.trim(), status: status as Status })
        }
        return ok(renderPlan(todos), { todos })
      },
    }),
  }
}
