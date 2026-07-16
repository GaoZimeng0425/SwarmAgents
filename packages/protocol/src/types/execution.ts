import { z } from 'zod'

// Per-task execution controls chosen in the composer. `permissionMode` 'full'
// bypasses every permission prompt; 'ask' keeps the default risk gate.
// `executionMode` 'plan' restricts the agent to read-only tools and asks it to
// produce a plan first; 'direct' executes autonomously.
export const PermissionModeSchema = z.enum(['ask', 'full'])
export type PermissionMode = z.infer<typeof PermissionModeSchema>
export const ExecutionModeSchema = z.enum(['direct', 'plan'])
export type ExecutionMode = z.infer<typeof ExecutionModeSchema>

// Composer-supplied options threaded from the renderer to the session service.
export const SubmitOptionsSchema = z.object({
  cwd: z.string().optional(),
  permissionMode: PermissionModeSchema.optional(),
  executionMode: ExecutionModeSchema.optional(),
  // Agent type id (from the agent store) to use for this top-level run.
  // Resolved in the session service; unknown ids fall back to DEFAULT_AGENT_DEF.
  agentType: z.string().optional(),
})
export type SubmitOptions = z.infer<typeof SubmitOptionsSchema>
