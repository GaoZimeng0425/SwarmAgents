// Budget config state machine. Single source of truth for the per-task budgets.
// Wraps the Store with validation and a state-change broadcast for the IPC layer.
// A failed persist does NOT advance the in-memory state.
import { createLogger } from '@shared/logger'
import { type BudgetConfig, BudgetConfigSchema } from '@swarm/protocol'

import type { Store } from './store'

const log = createLogger({ process: 'main' }).child({ component: 'budgets-service' })

export type SetResult = { ok: true } | { ok: false; code: 'invalid' | 'persist_failed'; message: string }

export type Service = {
  get(): BudgetConfig
  set(config: BudgetConfig): Promise<SetResult>
  onStateChanged(cb: (c: BudgetConfig) => void): () => void
}

export async function createService(opts: { store: Store }): Promise<Service> {
  let state = await opts.store.load()
  const listeners = new Set<(c: BudgetConfig) => void>()

  return {
    get: () => state,
    async set(config) {
      const parsed = BudgetConfigSchema.safeParse(config)
      if (!parsed.success) return { ok: false, code: 'invalid', message: parsed.error.issues[0]?.message ?? 'invalid' }
      try {
        await opts.store.save(parsed.data)
      } catch (e) {
        log.error({ msg: 'failed to persist budget config', err: e instanceof Error ? e.message : String(e) })
        return { ok: false, code: 'persist_failed', message: e instanceof Error ? e.message : String(e) }
      }
      state = parsed.data
      for (const cb of listeners) cb(state)
      return { ok: true }
    },
    onStateChanged(cb) {
      listeners.add(cb)
      return () => listeners.delete(cb)
    },
  }
}
