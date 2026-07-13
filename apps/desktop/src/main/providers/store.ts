// src/main/providers/store.ts
//
// Plaintext on-disk providers store. Reads/writes a single JSON file. Saves are
// atomic (write tmp → rename) and validated against the Zod schema before
// writing so we never persist garbage. Pure module: no logging, no globals —
// callers inject the filePath.
import { randomUUID } from 'node:crypto'
import { existsSync, promises as fs } from 'node:fs'
import { defaultProvidersStateOnDisk, ProvidersStateOnDisk, parsePersistedState } from '@swarm/protocol'

export type Store = {
  load(): Promise<ProvidersStateOnDisk> // forgiving — returns defaults on missing/failure
  save(state: ProvidersStateOnDisk): Promise<void>
}

export function createStore(opts: { filePath: string }): Store {
  const { filePath } = opts

  const load: Store['load'] = async () => {
    if (!existsSync(filePath)) return defaultProvidersStateOnDisk()
    let parsed: unknown
    try {
      parsed = JSON.parse(await fs.readFile(filePath, 'utf8'))
    } catch {
      return defaultProvidersStateOnDisk()
    }
    // Accepts current v2 or migrates a legacy v1 file forward.
    const state = parsePersistedState(parsed, randomUUID)
    return state ?? defaultProvidersStateOnDisk()
  }

  // Serialize saves so concurrent calls don't race on the shared .tmp path.
  let saveQueue: Promise<void> = Promise.resolve()

  const save: Store['save'] = (state) => {
    const next = saveQueue.then(async () => {
      // Validate before writing so we never persist garbage.
      ProvidersStateOnDisk.parse(state)
      const tmp = `${filePath}.tmp`
      await fs.writeFile(tmp, `${JSON.stringify(state, null, 2)}\n`)
      await fs.rename(tmp, filePath)
    })
    // Swallow rejections from the queue itself, but let the caller see their own error.
    saveQueue = next.catch(() => {})
    return next
  }

  return { load, save }
}
