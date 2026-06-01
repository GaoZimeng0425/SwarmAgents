import type { AgentTool } from '@earendil-works/pi-agent-core'
import type { Outbound } from '@shared/types/ipc'
import type { TaskResult } from '@shared/types/task'
import type { PermissionDecision } from '@shared/types/ui'

export type ToolRisk = 'low' | 'medium' | 'high'
export type ToolSource = 'builtin' | 'mcp'

export interface ToolRunContext {
  taskId: string
  // parentTaskId is bound externally when constructing the context (see agent-runner runCtx).
  spawnChild(
    goal: string,
    suggestedTools?: string[],
    providerKey?: string
  ): Promise<{ childTaskId: string; result: TaskResult }>
  send: (msg: Outbound) => void
  requestPermission: (args: {
    toolName: string
    risk: ToolRisk
    summary: string
    payload: unknown
  }) => Promise<PermissionDecision>
}

export interface ToolSpec {
  /** Group / namespace: 'peekaboo' | 'agent' | 'fs' | 'web' | 'memory' | 'skill' | <mcp-server>. */
  group: string
  /** Bare, model-facing tool name, e.g. 'see_screen'. */
  name: string
  risk: ToolRisk
  source: ToolSource
  /** Factory that produces the concrete pi AgentTool with run context injected. */
  build(ctx: ToolRunContext): AgentTool
}

export interface ToolRegistry {
  register(spec: ToolSpec): void
  list(): ToolSpec[]
  resolve(allowlist: string[], ctx: ToolRunContext): { tools: AgentTool[]; riskOf: (name: string) => ToolRisk }
}

// Patterns that don't conform (e.g. 'group.' with no star) simply match nothing.
function specMatches(spec: ToolSpec, allowlist: string[]): boolean {
  return allowlist.some((pattern) => {
    if (pattern === '*' || pattern === 'all') return true
    if (pattern.endsWith('.*')) return spec.group === pattern.slice(0, -2)
    return pattern === `${spec.group}.${spec.name}`
  })
}

export function createToolRegistry(): ToolRegistry {
  const specs: ToolSpec[] = []
  return {
    register(spec) {
      specs.push(spec)
    },
    list() {
      return [...specs]
    },
    resolve(allowlist, ctx) {
      const selected = specs.filter((s) => specMatches(s, allowlist))
      const tools = selected.map((s) => s.build(ctx))
      const riskByName = new Map(selected.map((s) => [s.name, s.risk]))
      // last-registered wins on a cross-group name collision (none in P0); unknown -> medium (fail safe)
      return { tools, riskOf: (name) => riskByName.get(name) ?? 'medium' }
    },
  }
}
