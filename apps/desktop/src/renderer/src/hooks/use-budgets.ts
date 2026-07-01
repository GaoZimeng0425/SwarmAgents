import { useEffect, useState } from 'react'
import { type BudgetConfig, defaultBudgetConfig } from '@shared/types/budgets'

/** Read the persisted per-task budget config, kept in sync with main. */
export function useBudgets(): BudgetConfig {
  const [config, setConfig] = useState<BudgetConfig>(defaultBudgetConfig)

  useEffect(() => {
    let cancelled = false
    void window.swarm.budgets.get().then((c) => {
      if (!cancelled) setConfig(c)
    })
    const off = window.swarm.budgets.onStateChanged((c) => setConfig(c))
    return () => {
      cancelled = true
      off()
    }
  }, [])

  return config
}
