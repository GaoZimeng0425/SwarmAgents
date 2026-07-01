// Plaintext on-disk store for the user's per-task budget config. No secrets, so
// it is a plain `budgets.json` under userData. `load()` is forgiving (missing or
// corrupt file → defaults); `save()` is atomic (tmp → rename).
import { existsSync, promises as fs } from 'node:fs'
import { createLogger } from '@shared/logger'
import { type BudgetConfig, BudgetConfigSchema, defaultBudgetConfig } from '@swarm/protocol'

const log = createLogger({ process: 'main' }).child({ component: 'budgets-store' })

export type Store = {
  /** Read + validate; never throws (bad/missing file → defaults). */
  load(): Promise<BudgetConfig>
  save(config: BudgetConfig): Promise<void>
  readonly path: string
}

export function createStore(opts: { filePath: string }): Store {
  const { filePath } = opts

  const load: Store['load'] = async () => {
    if (!existsSync(filePath)) return defaultBudgetConfig()
    try {
      const raw = await fs.readFile(filePath, 'utf8')
      const checked = BudgetConfigSchema.safeParse(JSON.parse(raw))
      if (!checked.success) {
        log.warn({ msg: 'budgets.json failed schema; using defaults', err: checked.error.message })
        return defaultBudgetConfig()
      }
      return checked.data
    } catch (err) {
      log.warn({ msg: 'budgets.json unreadable/invalid JSON; using defaults', err: String(err) })
      return defaultBudgetConfig()
    }
  }

  let saveQueue: Promise<void> = Promise.resolve()
  const save: Store['save'] = (config) => {
    const next = saveQueue.then(async () => {
      const tmp = `${filePath}.tmp`
      await fs.writeFile(tmp, `${JSON.stringify(config, null, 2)}\n`)
      await fs.rename(tmp, filePath)
    })
    saveQueue = next.catch(() => {})
    return next
  }

  return { load, save, path: filePath }
}
