import { z } from 'zod'

export const ToolScopeSchema = z.enum(['peekaboo', 'web', 'fs', 'all'])
export type ToolScope = z.infer<typeof ToolScopeSchema>

export const ModelHintSchema = z.enum(['inherit', 'fast', 'reasoning', 'coding'])
export type ModelHint = z.infer<typeof ModelHintSchema>

export const AgentDefinitionSchema = z.object({
  id: z.string(),
  name: z.string(),
  systemPrompt: z.string(),
  toolScope: ToolScopeSchema,
  maxIterations: z.number().int().positive().default(25),
  /** Override the provider's default model for this agent type. */
  model: z.string().optional(),
  /** Routing hint — determines which provider/model to use for this agent type. */
  modelHint: ModelHintSchema.optional(),
})
export type AgentDefinition = z.infer<typeof AgentDefinitionSchema>

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
      return ['peekaboo.*']
    case 'web':
      return ['web.*', 'agent.*']
    case 'fs':
      return ['fs.*', 'agent.*']
  }
}
