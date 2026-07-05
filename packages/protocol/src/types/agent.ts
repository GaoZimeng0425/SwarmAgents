import { z } from 'zod'

import { ModelThinkingLevel } from './provider'

/** Legacy coarse scope; ignored except 'authoring' back-compat (see `authoring`). */
export const ToolScopeSchema = z.enum(['peekaboo', 'web', 'fs', 'memory', 'authoring', 'coordinate', 'all'])
export type ToolScope = z.infer<typeof ToolScopeSchema>

export const AgentDefinitionSchema = z.object({
  // id is also the on-disk folder name, so it follows the skill name convention:
  // lowercase a-z/0-9 with single hyphens, ≤64 chars.
  id: z
    .string()
    .min(1)
    .max(64)
    .regex(
      /^[a-z0-9]+(?:-[a-z0-9]+)*$/,
      'Lowercase a-z, 0-9 and single hyphens only; no leading, trailing or doubled hyphens.'
    ),
  name: z.string(),
  /**
   * One-line purpose shown to the parent agent in its sub-agent catalog and used
   * to decide when to delegate. Authoring convention: write it trigger-first
   * ("Use when …"), not feature-first, so the model matches on when to delegate.
   */
  description: z.string().min(1).max(1024),
  systemPrompt: z.string(),
  toolScope: ToolScopeSchema.optional(),
  /** Grants the privileged authoring tool group (write_agent/write_skill); see `allowlistForAgent`. */
  authoring: z.boolean().optional(),
  /** Discoverable role handle: a human-readable display name for the definition. When unset, the directory treats `id` as the role. */
  role: z.string().optional(),
  /** Capability tags for finer discovery queries. */
  capabilities: z.array(z.string()).optional(),
  /** Team grouping tag for org-chart discovery; absent = not a team member (e.g. CEO, generic builtins). */
  team: z.string().optional(),
  /** Marks the team's entry-point agent (the "head"); absent = an individual contributor. */
  teamRole: z.enum(['head']).optional(),
  /**
   * Optional structural edge to a parent agent's id, used to render the org
   * hierarchy. The org-tree builder prefers this edge and falls back to
   * team/teamRole inference when it is absent. Structural only: NOT a
   * permission boundary and NOT used by deriveAllowlist or the directory.
   */
  parentId: z
    .string()
    .min(1)
    .max(64)
    .regex(/^[a-z0-9]+(?:-[a-z0-9]+)*$/, 'parentId must be a valid agent id')
    .optional(),
  maxIterations: z.number().int().positive().default(25),
  /** Override the provider's default model for this agent type. */
  model: z.string().optional(),
  /**
   * Override the reasoning depth for this agent type — the model-tier control. A
   * planner sets 'xhigh' for deep decomposition; a fast worker sets 'off' to skip
   * thinking on cheap, mechanical sub-tasks. Clamped to what the model supports.
   */
  thinkingLevel: ModelThinkingLevel.optional(),
  /**
   * Optional skills (by name) that this agent should load via use_skill when it
   * starts a task. Each agent gets tailored skills — e.g. the engineer gets
   * 'run-desktop' for build verification, the product-analyst gets 'agent-reach'
   * for web research. Absent or empty = no skills pre-loaded.
   */
  skills: z.array(z.string()).optional(),
})
export type AgentDefinition = z.infer<typeof AgentDefinitionSchema>

/** Result of a create/update/delete on the agent store. */
export type AgentMutationResult = { ok: true; agents: AgentDefinition[] } | { ok: false; code: string; message: string }

/** An agent as listed for the UI. (All agents are real on-disk files.) */
export type AgentListItem = AgentDefinition

/** A discovery query against the session's live agents. All fields optional; empty → match all. */
export type PeerQuery = { role?: string; capability?: string; query?: string; team?: string; teamRole?: 'head' }

/** A discovered peer agent, returned by the directory and surfaced by the find_agents tool. */
export type Peer = {
  name: string | null
  address: string
  role: string
  capabilities: string[]
  description: string
  status: 'active' | 'dormant'
  team?: string
  teamRole?: 'head'
}

/**
 * Legacy resolver from an agent's coarse `toolScope` alone. Superseded by the
 * `authoring` field (see `allowlistForAgent`, which no longer calls this);
 * kept for direct callers and back-compat coverage of the old scope values.
 *
 * Every scope resolves to the full standard tool set (`'*'`) — toolScope no
 * longer restricts capabilities. A coordinator/researcher/etc. can use shell,
 * fs, web, UI cards, and screen capture directly instead of only delegating.
 * The lone exception is `authoring`, which adds its privileged group
 * (write_agent/write_skill) on top — those tools are excluded from `*` (see
 * tools/registry PRIVILEGED_GROUPS) and stay exclusive to the training team.
 * `claude-code.*` is granted separately by `allowlistForAgent` for code-capable
 * agents.
 */
export function deriveAllowlist(scope: ToolScope): string[] {
  switch (scope) {
    case 'authoring':
      return ['*', 'authoring.*']
    case 'all':
    case 'peekaboo':
    case 'web':
    case 'fs':
    case 'memory':
    case 'coordinate':
      return ['*']
  }
}

/** Capability tag that marks an agent as a developer (writes code). */
export const CODE_CAPABILITY = 'code'

/**
 * Seed allowlist for a specific agent: the full standard tool set, plus the
 * privileged authoring group when `authoring` is set — or, for back-compat,
 * when a legacy on-disk agent still carries `toolScope: 'authoring'` — plus
 * any capability-restricted grants. `claude-code` is a privileged group
 * (excluded from `*`), reserved for developer agents — those advertising the
 * `code` capability (the built-in engineer, plus runtime-authored
 * frontend/backend engineers). Only they may operate a Claude Code session
 * via the cc_* tools.
 */
export function allowlistForAgent(def: Pick<AgentDefinition, 'toolScope' | 'authoring' | 'capabilities'>): string[] {
  const isAuthoring = def.authoring === true || def.toolScope === 'authoring'
  const allow = isAuthoring ? ['*', 'authoring.*'] : ['*']
  if (def.capabilities?.includes(CODE_CAPABILITY)) allow.push('claude-code.*')
  return allow
}
