import { z } from 'zod'

import { ResourceBudgetSchema } from './task'

// User-configurable per-task budgets, applied at task creation. `main` caps a
// top-level (submitGoal) task; `sub` caps each spawned sub-agent task. No secrets,
// so a single shape is used on disk, over IPC, and in the service.
export const BudgetConfigSchema = z.object({
  main: ResourceBudgetSchema,
  sub: ResourceBudgetSchema,
})
export type BudgetConfig = z.infer<typeof BudgetConfigSchema>

// Defaults equal the values previously hardcoded in session-manager, so behavior
// is unchanged until a user edits them.
export const defaultBudgetConfig = (): BudgetConfig => ({
  main: { tokens: 100_000, calls: 50, wallMs: 600_000, usdCents: 200 },
  sub: { tokens: 50_000, calls: 25, wallMs: 300_000, usdCents: 100 },
})
