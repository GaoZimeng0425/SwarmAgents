//
// Encrypted on-disk Bilibili config store. Same shape as web-search/store.ts:
// single file via Electron safeStorage, atomic writes (tmp -> rename), validated
// against the Zod schema before encryption. Pure module: no logging, no globals.
import { existsSync, promises as fs } from 'node:fs'
import { BilibiliConfigOnDisk, defaultBilibiliConfigOnDisk } from '@swarm/protocol'
import { safeStorage } from 'electron'

export type Store = {
  load(): Promise<BilibiliConfigOnDisk>
  save(state: BilibiliConfigOnDisk): Promise<void>
}

export function createStore(opts: { filePath: string }): Store {
  const { filePath } = opts

  const load: Store['load'] = async () => {
    if (!existsSync(filePath)) return defaultBilibiliConfigOnDisk()
    try {
      const buf = await fs.readFile(filePath)
      const json = safeStorage.decryptString(buf)
      const parsed = JSON.parse(json)
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
      const cipherText = safeStorage.encryptString(JSON.stringify(state))
      const tmp = `${filePath}.tmp`
      await fs.writeFile(tmp, cipherText)
      await fs.rename(tmp, filePath)
    })
    saveQueue = next.catch(() => undefined)
    return next
  }

  return { load, save }
}
