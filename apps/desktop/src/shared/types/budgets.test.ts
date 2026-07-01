import { describe, expect, it } from 'vitest'

import { BudgetConfigSchema, defaultBudgetConfig } from './budgets'

describe('BudgetConfigSchema', () => {
  it('accepts the default config', () => {
    expect(BudgetConfigSchema.safeParse(defaultBudgetConfig()).success).toBe(true)
  })

  it('rejects a config missing the sub budget', () => {
    expect(BudgetConfigSchema.safeParse({ main: defaultBudgetConfig().main }).success).toBe(false)
  })

  it('rejects negative or non-integer budget values', () => {
    const bad = { main: { tokens: -1, calls: 1, wallMs: 1, usdCents: 1 }, sub: defaultBudgetConfig().sub }
    expect(BudgetConfigSchema.safeParse(bad).success).toBe(false)
    const frac = { main: { tokens: 1.5, calls: 1, wallMs: 1, usdCents: 1 }, sub: defaultBudgetConfig().sub }
    expect(BudgetConfigSchema.safeParse(frac).success).toBe(false)
  })
})
