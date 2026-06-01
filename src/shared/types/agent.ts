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
