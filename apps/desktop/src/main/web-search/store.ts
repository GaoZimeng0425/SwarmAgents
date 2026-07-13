// src/main/web-search/store.ts
//
// Plaintext on-disk web-search config store. Reads/writes a single JSON file.
// Saves are atomic (write tmp → rename) and validated against the Zod schema
// before writing so we never persist garbage. Pure module: no logging, no
// globals — callers inject filePath.
import { existsSync, promises as fs } from 'node:fs'
import { defaultWebSearchConfigOnDisk, WebSearchConfigOnDisk } from '@swarm/protocol'

export type Store = {
  load(): Promise<WebSearchConfigOnDisk> // forgiving — returns defaults on missing/failure
  save(state: WebSearchConfigOnDisk): Promise<void>
}

export function createStore(opts: { filePath: string }): Store {
  const { filePath } = opts

  const load: Store['load'] = async () => {
    if (!existsSync(filePath)) return defaultWebSearchConfigOnDisk()
    try {
      const parsed = JSON.parse(await fs.readFile(filePath, 'utf8'))
      const checked = WebSearchConfigOnDisk.safeParse(parsed)
      return checked.success ? checked.data : defaultWebSearchConfigOnDisk()
    } catch {
      return defaultWebSearchConfigOnDisk()
    }
  }

  // Serialize saves so concurrent calls don't race on the shared .tmp path.
  let saveQueue: Promise<void> = Promise.resolve()

  const save: Store['save'] = (state) => {
    const next = saveQueue.then(async () => {
      // Validate before writing so we never persist garbage.
      WebSearchConfigOnDisk.parse(state)
      const tmp = `${filePath}.tmp`
      await fs.writeFile(tmp, `${JSON.stringify(state, null, 2)}\n`)
      await fs.rename(tmp, filePath)
    })
    // Keep the queue alive even if one save rejects.
    saveQueue = next.catch(() => undefined)
    return next
  }

  return { load, save }
}
