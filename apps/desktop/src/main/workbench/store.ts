// Plaintext on-disk store for the workbench (工作面板) task board. No secrets,
// so it is a plain `workbench.json` under userData. `load()` is forgiving
// (missing or corrupt file → empty data); `save()` is atomic (tmp → rename).
import { existsSync, promises as fs } from 'node:fs'
import { createLogger } from '@shared/logger'
import { emptyWorkbenchData, type WorkbenchData, WorkbenchDataSchema } from '@swarm/protocol'

const log = createLogger({ process: 'main' }).child({ component: 'workbench-store' })

export type Store = {
  /** Read + validate; never throws (bad/missing file → empty data). */
  load(): Promise<WorkbenchData>
  save(data: WorkbenchData): Promise<void>
  readonly path: string
}

export function createStore(opts: { filePath: string }): Store {
  const { filePath } = opts

  const load: Store['load'] = async () => {
    if (!existsSync(filePath)) return emptyWorkbenchData()
    try {
      const raw = await fs.readFile(filePath, 'utf8')
      const checked = WorkbenchDataSchema.safeParse(JSON.parse(raw))
      if (!checked.success) {
        log.warn({ msg: 'workbench.json failed schema; using empty data', err: checked.error.message })
        return emptyWorkbenchData()
      }
      return checked.data
    } catch (err) {
      log.warn({ msg: 'workbench.json unreadable/invalid JSON; using empty data', err: String(err) })
      return emptyWorkbenchData()
    }
  }

  let saveQueue: Promise<void> = Promise.resolve()
  const save: Store['save'] = (data) => {
    const next = saveQueue.then(async () => {
      const tmp = `${filePath}.tmp`
      await fs.writeFile(tmp, `${JSON.stringify(data, null, 2)}\n`)
      await fs.rename(tmp, filePath)
    })
    saveQueue = next.catch(() => {})
    return next
  }

  return { load, save, path: filePath }
}
