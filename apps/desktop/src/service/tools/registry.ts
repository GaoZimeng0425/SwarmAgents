import type { AgentTool } from '@earendil-works/pi-agent-core'
import { createLogger } from '@shared/logger'
import type {
  AgentDefinition,
  Artifact,
  DelegateResult,
  DelegationItem,
  DelegationItemStatus,
  Peer,
  PeerQuery,
  PermissionDecision,
  Skill,
  SkillMutationResult,
} from '@swarm/protocol'

import type { AgentMutationResult } from '../agents/store'

const log = createLogger({ process: 'service' }).child({ component: 'tools' })

export type ToolRisk = 'low' | 'medium' | 'high'
export type ToolSource = 'builtin' | 'mcp'

export interface ToolRunContext {
  /** The session this task runs in. Tools that create session-scoped state (e.g. cron) bind to it. */
  sessionId: string
  taskId?: string
  /**
   * Composer-chosen working directory for this task. Filesystem tools resolve
   * relative paths against it and shell runs there; absent → the user's home.
   */
  cwd?: string
  // parentMessageId is bound externally when constructing the context (see launch runCtx).
  // Delegate a focused child message to a sub-agent; the child's terminal `status`
  // (spec §4, ledger #6) rides on the result so the delegate tool can surface a
  // failed/cancelled child instead of reading its partial summary as success.
  spawnChild(
    prompt: string,
    opts?: { suggestedTools?: string[]; providerKey?: string; agentType?: string }
  ): Promise<DelegateResult & { messageId: string }>
  /** Agent-authored work: run a top-level work message (single-shot) and return its result. Absent outside conversation turns. */
  createTask?(prompt: string, agentType?: string): Promise<DelegateResult & { messageId: string }>
  requestPermission: (args: {
    toolName: string
    risk: ToolRisk
    summary: string
    payload: unknown
  }) => Promise<PermissionDecision>
  /** Discover peer agents in this session by role/capability/free-text. Empty query → all live peers. */
  findPeers(q: PeerQuery): Peer[]
  /**
   * Run a one-shot vision/OCR completion on an image, returning the model's text.
   * Resolves an image-capable model from the task's provider chain so a cheap,
   * text-only main model can still handle images. Absent when no image-capable
   * model is configured (or in standalone tool tests).
   */
  analyzeImage?(prompt: string, image: { data: string; mimeType: string }): Promise<string>
  /** Author/overwrite an agent definition on disk (training team only; absent for other agents). */
  writeAgent?(def: AgentDefinition): AgentMutationResult
  /** Author/overwrite a skill on disk (training team only; absent for other agents). */
  writeSkill?(skill: Skill): SkillMutationResult
  /**
   * Charge externally-incurred spend (e.g. a delegated Claude Code session) to
   * this task's budget. `costUsd` is the incremental cost since the last report.
   * Wired in agent-runner to fold into `used.usdCents`; absent in standalone
   * tool tests.
   */
  reportExternalUsage?(usage: { costUsd?: number; inputTokens?: number; outputTokens?: number }): void
  /**
   * Record the task's delegation DAG (set_delegation_plan tool). Wired in
   * agent-runner; absent in standalone tool tests and non-delegating contexts.
   */
  setDelegationPlan?(plan: DelegationItem[]): void
  /** Per-run sink: child agent submits structured results (artifacts). Collected by launch. */
  reportResult?: (artifacts: Artifact[]) => void
  /** Merge a delegation item's result into session-level planState. */
  mergeDelegationResult?: (itemId: string, delta: { status: DelegationItemStatus; artifacts: Artifact[] }) => void
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
  /**
   * App-wide off switch for whole built-in tool groups (MCP groups are toggled
   * via their server config instead). Disabled groups are dropped from every
   * `resolve`, regardless of an agent's allowlist.
   */
  setDisabledGroups(groups: string[]): void
  /** Distinct built-in groups with their bare tool names, for the toggle UI. */
  builtinGroups(): { group: string; toolNames: string[] }[]
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

// Privileged groups are NOT granted by the `*`/`all` wildcard — they must be
// listed explicitly (e.g. `authoring.*`). This is how a capability stays
// exclusive to specific agents even though most agents run with toolScope 'all'.
const PRIVILEGED_GROUPS = new Set(['authoring', 'claude-code'])

// Patterns that don't conform (e.g. 'group.' with no star) simply match nothing.
function specMatches(spec: ToolSpec, allowlist: string[]): boolean {
  return allowlist.some((pattern) => {
    if (pattern === '*' || pattern === 'all') return !PRIVILEGED_GROUPS.has(spec.group)
    if (pattern.endsWith('.*')) return spec.group === pattern.slice(0, -2)
    return pattern === `${spec.group}.${spec.name}`
  })
}

export function createToolRegistry(): ToolRegistry {
  const specs: ToolSpec[] = []
  let disabledGroups = new Set<string>()
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
    setDisabledGroups(groups) {
      disabledGroups = new Set(groups)
      log.info({ msg: 'disabled tool groups updated', groups })
    },
    builtinGroups() {
      const byGroup = new Map<string, string[]>()
      for (const s of specs) {
        if (s.source !== 'builtin') continue
        const names = byGroup.get(s.group) ?? []
        names.push(s.name)
        byGroup.set(s.group, names)
      }
      return [...byGroup.entries()]
        .sort(([a], [b]) => a.localeCompare(b))
        .map(([group, toolNames]) => ({ group, toolNames }))
    },
    resolve(allowlist, ctx) {
      const selected = specs.filter(
        (s) => specMatches(s, allowlist) && !(s.source === 'builtin' && disabledGroups.has(s.group))
      )
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
