//
// Plaintext on-disk Bilibili config store. Same shape as web-search/store.ts:
// single JSON file, atomic writes (tmp -> rename), validated against the Zod
// schema before writing. Pure module: no logging, no globals.
import { existsSync, promises as fs } from 'node:fs'
import { BilibiliConfigOnDisk, defaultBilibiliConfigOnDisk } from '@swarm/protocol'

export type Store = {
  load(): Promise<BilibiliConfigOnDisk>
  save(state: BilibiliConfigOnDisk): Promise<void>
}

export function createStore(opts: { filePath: string }): Store {
  const { filePath } = opts

  const load: Store['load'] = async () => {
    if (!existsSync(filePath)) return defaultBilibiliConfigOnDisk()
    try {
      const parsed = JSON.parse(await fs.readFile(filePath, 'utf8'))
      const checked = BilibiliConfigOnDisk.safeParse(parsed)
      return checked.success ? checked.data : defaultBilibiliConfigOnDisk()
    } catch {
      return defaultBilibiliConfigOnDisk()
    }
  }

  let saveQueue: Promise<void> = Promise.resolve()
  const save: Store['save'] = (state) => {
    const next = saveQueue.then(async () => {
      BilibiliConfigOnDisk.parse(state)
      const tmp = `${filePath}.tmp`
      await fs.writeFile(tmp, `${JSON.stringify(state, null, 2)}\n`)
      await fs.rename(tmp, filePath)
    })
    saveQueue = next.catch(() => undefined)
    return next
  }

  return { load, save }
}
