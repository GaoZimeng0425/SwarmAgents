import { z } from 'zod'

export const ToolScopeSchema = z.enum(['peekaboo', 'web', 'fs', 'memory', 'authoring', 'all'])
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
  toolScope: ToolScopeSchema,
  /** Discoverable role handle (distinct from the per-instance actor name). When unset, the directory treats `id` as the role. */
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
})
export type AgentDefinition = z.infer<typeof AgentDefinitionSchema>

/** Result of a create/update/delete on the agent store. */
export type AgentMutationResult =
  | { ok: true; agents: AgentDefinition[] }
  | { ok: false; code: string; message: string }

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
 * Default tool allowlist generated from an agent's coarse `toolScope`.
 * Used when a task is created without an explicit allowlist. `toolAllowlist`
 * remains the authoritative runtime filter; this only seeds its default.
 */
export function deriveAllowlist(scope: ToolScope): string[] {
  switch (scope) {
    case 'all':
      return ['*']
    case 'peekaboo':
      // Observation only — interaction tools (click/type/scroll/hotkey) live in
      // the same group but must not leak into read-only agents. The allowlist,
      // not the system prompt, is the capability boundary.
      return ['peekaboo.see_screen', 'peekaboo.list_apps']
    case 'web':
      return ['web.*', 'agent.*']
    case 'fs':
      return ['fs.*', 'agent.*']
    case 'memory':
      return ['memory.*', 'agent.*']
    case 'authoring':
      // Privileged: authoring.* is excluded from '*' (see tools/registry PRIVILEGED_GROUPS),
      // so only this scope can reach write_agent/write_skill. Plus the coordination
      // tools a team head needs to delegate and read.
      return ['authoring.*', 'agent.*', 'fs.*', 'web.*', 'shell.*']
  }
}

/** Capability tag that marks an agent as a developer (writes code). */
export const CODE_CAPABILITY = 'code'

/**
 * Seed allowlist for a specific agent: its scope's default plus any
 * capability-restricted grants. `claude-code` is a privileged group (excluded
 * from `*`), reserved for developer agents — those advertising the `code`
 * capability (the built-in engineer, plus runtime-authored frontend/backend
 * engineers). Only they may operate a Claude Code session via the cc_* tools.
 */
export function allowlistForAgent(def: Pick<AgentDefinition, 'toolScope' | 'capabilities'>): string[] {
  const allow = deriveAllowlist(def.toolScope)
  if (def.capabilities?.includes(CODE_CAPABILITY)) allow.push('claude-code.*')
  return allow
}
