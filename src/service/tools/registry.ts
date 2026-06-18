import type { AgentTool } from '@earendil-works/pi-agent-core'
import { createLogger } from '@shared/logger'
import type { Outbound } from '@shared/types/ipc'
import type { TaskResult } from '@shared/types/task'
import type { PermissionDecision } from '@shared/types/ui'

const log = createLogger({ process: 'service' }).child({ component: 'tools' })

export type ToolRisk = 'low' | 'medium' | 'high'
export type ToolSource = 'builtin' | 'mcp'

export interface ToolRunContext {
  /** The session this task runs in. Tools that create session-scoped state (e.g. cron) bind to it. */
  sessionId: string
  taskId: string
  // parentTaskId is bound externally when constructing the context (see agent-runner runCtx).
  spawnChild(
    goal: string,
    suggestedTools?: string[],
    providerKey?: string,
    agentType?: string
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
  /** Optional per-call risk override based on the tool's arguments. Invoked only when args are provided; otherwise falls back to `risk`. */
  riskFor?: (args: unknown) => ToolRisk
  source: ToolSource
  /** Factory that produces the concrete pi AgentTool with run context injected. */
  build(ctx: ToolRunContext): AgentTool
}

export interface ToolRegistry {
  register(spec: ToolSpec): void
  /** Remove every spec in a group. Used to swap a server's dynamic (MCP) tool set. */
  unregister(group: string): void
  list(): ToolSpec[]
  resolve(
    allowlist: string[],
    ctx: ToolRunContext
  ): { tools: AgentTool[]; riskOf: (name: string, args?: unknown) => ToolRisk }
}

// Single instrumentation point for every tool call (builtin + MCP): logs start,
// outcome and duration so any tool failure is locatable from the log file. Tool
// args are intentionally omitted — they can carry file contents / secrets.
function withLogging(spec: ToolSpec, tool: AgentTool, ctx: ToolRunContext): AgentTool {
  const toolLog = log.child({ sessionId: ctx.sessionId, taskId: ctx.taskId })
  const name = `${spec.group}.${spec.name}`
  const inner = tool.execute
  return {
    ...tool,
    execute: async (id: string, params: unknown) => {
      const t0 = Date.now()
      toolLog.debug({ msg: 'tool start', tool: name })
      try {
        const result = await inner(id, params)
        const error = (result as { details?: { error?: unknown } })?.details?.error
        if (error) {
          toolLog.warn({ msg: 'tool error', tool: name, durationMs: Date.now() - t0, err: String(error) })
        } else {
          toolLog.debug({ msg: 'tool ok', tool: name, durationMs: Date.now() - t0 })
        }
        return result
      } catch (err) {
        toolLog.error({
          msg: 'tool threw',
          tool: name,
          durationMs: Date.now() - t0,
          err: err instanceof Error ? err.message : String(err),
        })
        throw err
      }
    },
  }
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
    unregister(group) {
      for (let i = specs.length - 1; i >= 0; i--) {
        if (specs[i].group === group) specs.splice(i, 1)
      }
    },
    list() {
      return [...specs]
    },
    resolve(allowlist, ctx) {
      const selected = specs.filter((s) => specMatches(s, allowlist))
      const tools = selected.map((s) => withLogging(s, s.build(ctx), ctx))
      const specByName = new Map(selected.map((s) => [s.name, s] as const))
      // unknown -> medium (fail safe); riskFor overrides static risk per call.
      const riskOf = (name: string, args?: unknown): ToolRisk => {
        const spec = specByName.get(name)
        if (!spec) return 'medium'
        return spec.riskFor && args !== undefined ? spec.riskFor(args) : spec.risk
      }
      return { tools, riskOf }
    },
  }
}
