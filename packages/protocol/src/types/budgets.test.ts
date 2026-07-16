import { describe, expect, it } from 'vitest'

import { BudgetConfigSchema, defaultBudgetConfig, emptyBudget, emptyUsed } from './budgets'

describe('resource shapes', () => {
  it('emptyBudget returns zeroed limit counters', () => {
    expect(emptyBudget()).toEqual({ calls: 0, wallMs: 0, usdCents: 0 })
  })
  it('emptyUsed returns zeroed usage counters incl. cache fields', () => {
    expect(emptyUsed()).toEqual({ tokens: 0, calls: 0, wallMs: 0, usdCents: 0, cacheRead: 0, cacheWrite: 0 })
  })
})

describe('BudgetConfigSchema', () => {
  it('accepts the default config', () => {
    expect(BudgetConfigSchema.safeParse(defaultBudgetConfig()).success).toBe(true)
  })

  it('rejects a config missing the sub budget', () => {
    expect(BudgetConfigSchema.safeParse({ main: defaultBudgetConfig().main }).success).toBe(false)
  })

  it('rejects negative or non-integer budget values', () => {
    const bad = { main: { calls: -1, wallMs: 1, usdCents: 1 }, sub: defaultBudgetConfig().sub }
    expect(BudgetConfigSchema.safeParse(bad).success).toBe(false)
    const frac = { main: { calls: 1.5, wallMs: 1, usdCents: 1 }, sub: defaultBudgetConfig().sub }
    expect(BudgetConfigSchema.safeParse(frac).success).toBe(false)
  })

  it('tolerates a legacy on-disk config that still carries the retired tokens knob', () => {
    // Older builds persisted `tokens` on each budget; zod's default object
    // parsing strips unrecognized keys, so legacy files keep loading cleanly
    // with `tokens` silently dropped instead of failing validation.
    const legacy = {
      main: { tokens: 100_000, calls: 50, wallMs: 600_000, usdCents: 200 },
      sub: { tokens: 50_000, calls: 25, wallMs: 300_000, usdCents: 100 },
    }
    const parsed = BudgetConfigSchema.safeParse(legacy)
    expect(parsed.success).toBe(true)
    expect(parsed.success && parsed.data.main).toEqual({ calls: 50, wallMs: 600_000, usdCents: 200 })
    expect(parsed.success && (parsed.data.main as Record<string, unknown>).tokens).toBeUndefined()
  })
})
