import { z } from 'zod'

import { ResourceBudgetSchema } from './task'

// User-configurable per-task budgets, applied at task creation. `main` caps a
// top-level (submitPrompt) task; `sub` caps each spawned sub-agent task. No secrets,
// so a single shape is used on disk, over IPC, and in the service.
export const BudgetConfigSchema = z.object({
  main: ResourceBudgetSchema,
  sub: ResourceBudgetSchema,
  /**
   * Global override for every agent's per-run iteration cap (the agent loop's
   * `maxTurns` safety valve). When set (> 0) it replaces each agent definition's
   * own `maxIterations`, regardless of main vs sub. Undefined = each agent keeps
   * its own configured value. Lets the operator raise the ceiling app-wide
   * without editing every agent.
   */
  maxIterations: z.number().int().positive().optional(),
})
export type BudgetConfig = z.infer<typeof BudgetConfigSchema>

// Defaults equal the values previously hardcoded in session-manager, so behavior
// is unchanged until a user edits them.
export const defaultBudgetConfig = (): BudgetConfig => ({
  main: { calls: 50, wallMs: 600_000, usdCents: 200 },
  sub: { calls: 25, wallMs: 300_000, usdCents: 100 },
})
