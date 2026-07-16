import { z } from 'zod'

// The budget *limits* config. `tokens` was never enforced (only usage-tracked,
// see ConsumedResources below) and has been retired as a dead knob.
export const ResourceBudgetSchema = z.object({
  calls: z.number().int().nonnegative(),
  wallMs: z.number().int().nonnegative(),
  usdCents: z.number().int().nonnegative(),
})
export type ResourceBudget = z.infer<typeof ResourceBudgetSchema>

export const emptyBudget = (): ResourceBudget => ({ calls: 0, wallMs: 0, usdCents: 0 })

// Consumed resources: a standalone tracking shape (NOT derived from
// ResourceBudget — usage tracking and budget limits are independent concerns).
// `tokens` here is a usage counter, not a knob. cacheRead is the cache-hit
// (read) token count, cacheWrite the cache-creation token count. Both are
// latest-turn snapshots, mirroring `tokens`. Defaults keep legacy persisted
// rows (without the cache fields) parseable.
export const ConsumedResourcesSchema = z.object({
  tokens: z.number().int().nonnegative(),
  calls: z.number().int().nonnegative(),
  wallMs: z.number().int().nonnegative(),
  usdCents: z.number().int().nonnegative(),
  cacheRead: z.number().int().nonnegative().default(0),
  cacheWrite: z.number().int().nonnegative().default(0),
})
export type ConsumedResources = z.infer<typeof ConsumedResourcesSchema>

export const emptyUsed = (): ConsumedResources => ({
  tokens: 0,
  calls: 0,
  wallMs: 0,
  usdCents: 0,
  cacheRead: 0,
  cacheWrite: 0,
})

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
